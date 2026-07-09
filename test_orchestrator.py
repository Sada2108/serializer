"""Tests for open_forge.orchestrator — retry cap + dev/production render branching.

These tests mock `verify`, `run_simulation`, and `get_alternative_components`
in isolation; they do NOT require ngspice or node to be installed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from open_forge import orchestrator as orch


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #

@pytest.fixture
def sample_nir() -> dict:
    return {
        "placement_notes": ["Q1 and U3 must be at least 5 mm apart"],
        "datasheet_context": {"Q1": {"thermal": "10 W"}},
        "circuit_json": {
            "components": [
                {"name": "Q1", "type": "transistor"},
                {"name": "U3", "type": "ic"},
                {"name": "R1", "type": "resistor"},
            ],
        },
    }


@pytest.fixture
def placement_fault() -> orch.Fault:
    return orch.Fault(
        fault_type="placement_violation",
        origin_layer="verifier",
        affected_component="Q1",
        message="Q1 and U3 only 1 mm apart, need >= 5 mm",
    )


@pytest.fixture
def structural_fault() -> orch.Fault:
    return orch.Fault(
        fault_type="structural",
        origin_layer="verifier",
        affected_component="U3",
        message="net N1 has no driver",
    )


@pytest.fixture
def ok_sim() -> orch.SimResult:
    return orch.SimResult(passed=True, raw_stdout="", raw_stderr="", return_code=0)


@pytest.fixture
def bad_sim() -> orch.SimResult:
    return orch.SimResult(
        passed=False,
        raw_stdout="Error: unknown subckt X1",
        raw_stderr="abort",
        return_code=1,
    )


# --------------------------------------------------------------------------- #
# 1. Retry cap
# --------------------------------------------------------------------------- #

def test_retry_cap_returns_last_fault(
    monkeypatch, sample_nir, placement_fault, tmp_path
):
    """verify keeps returning placement_violation → must stop at MAX_RETRIES."""
    monkeypatch.setattr(orch, "LOG_PATH", str(tmp_path / "log.jsonl"))

    calls = {"nir_fix": 0}

    def always_fault(cj, notes, ctx):
        return placement_fault

    def fix_cb(nir, fault):
        calls["nir_fix"] += 1
        # mutate NIR slightly so the hash changes, proving retry happened
        new = json.loads(json.dumps(nir))
        new["placement_notes"] = list(new["placement_notes"]) + [f"retry-{calls['nir_fix']}"]
        return new

    monkeypatch.setattr(orch, "verify", always_fault)

    result = orch.orchestrate(sample_nir, "production", request_nir_fix_cb=fix_cb)

    assert isinstance(result, orch.Fault)
    assert result.fault_type == "placement_violation"
    # request_nir_fix called once per retry, and retries capped at MAX_RETRIES.
    assert calls["nir_fix"] == orch.MAX_RETRIES
    assert result.retry_count == orch.MAX_RETRIES


def test_retry_succeeds_within_cap(monkeypatch, sample_nir, ok_sim, tmp_path):
    """First verify faults, the corrected NIR passes — no overrun."""
    monkeypatch.setattr(orch, "LOG_PATH", str(tmp_path / "log.jsonl"))
    monkeypatch.setattr(orch, "run_simulation", lambda cj: ok_sim)
    monkeypatch.setattr(orch, "_render_svg", lambda cj: "<svg/>")

    state = {"n": 0}

    def fault_then_pass(cj, notes, ctx):
        state["n"] += 1
        if state["n"] == 1:
            return orch.Fault(
                fault_type="placement_violation",
                origin_layer="verifier",
                affected_component="Q1",
                message="too close",
            )
        return None

    monkeypatch.setattr(orch, "verify", fault_then_pass)

    fix_calls = {"c": 0}
    def fix_cb(nir, fault):
        fix_calls["c"] += 1
        new = json.loads(json.dumps(nir))
        new["placement_notes"] = list(new["placement_notes"]) + ["fixed"]
        return new

    result = orch.orchestrate(sample_nir, "production", request_nir_fix_cb=fix_cb)

    assert isinstance(result, orch.FinalOutput)
    assert state["n"] == 2
    assert fix_calls["c"] == 1


def test_structural_fault_short_circuits(
    monkeypatch, sample_nir, structural_fault, tmp_path
):
    """A structural fault is NOT retried via request_nir_fix — returned as-is."""
    monkeypatch.setattr(orch, "LOG_PATH", str(tmp_path / "log.jsonl"))
    monkeypatch.setattr(orch, "verify", lambda cj, n, c: structural_fault)

    fix_calls = {"c": 0}
    def fix_cb(nir, fault):
        fix_calls["c"] += 1
        return nir

    result = orch.orchestrate(sample_nir, "production", request_nir_fix_cb=fix_cb)
    assert isinstance(result, orch.Fault)
    assert result.fault_type == "structural"
    assert fix_calls["c"] == 0


# --------------------------------------------------------------------------- #
# 2. Simulation failure after verify pass → component_inadequate
# --------------------------------------------------------------------------- #

def test_sim_fail_raises_component_inadequate(
    monkeypatch, sample_nir, bad_sim, tmp_path
):
    monkeypatch.setattr(orch, "LOG_PATH", str(tmp_path / "log.jsonl"))
    monkeypatch.setattr(orch, "verify", lambda cj, n, c: None)
    monkeypatch.setattr(orch, "run_simulation", lambda cj: bad_sim)
    monkeypatch.setattr(orch, "_render_svg", lambda cj: "<svg/>")
    monkeypatch.setattr(
        orch,
        "get_alternative_components",
        lambda comp, cj: [{"name": "alt-1"}, {"name": "alt-2"}],
    )

    result = orch.orchestrate(sample_nir, "production")
    assert isinstance(result, orch.Fault)
    assert result.fault_type == "component_inadequate"
    assert result.origin_layer == "simulation"
    assert result.candidates == [{"name": "alt-1"}, {"name": "alt-2"}]


# --------------------------------------------------------------------------- #
# 3. Render branching: development excludes, production flags
# --------------------------------------------------------------------------- #

def test_render_development_excludes_faulted_component(
    monkeypatch, sample_nir, ok_sim, tmp_path
):
    """Dev mode: faulted component removed from render input (renders in isolation)."""
    monkeypatch.setattr(orch, "LOG_PATH", str(tmp_path / "log.jsonl"))

    fault = orch.Fault(
        fault_type="placement_violation",
        origin_layer="verifier",
        affected_component="Q1",
        message="x",
    )

    rendered_inputs: list[dict] = []
    def fake_svg(cj):
        rendered_inputs.append(cj)
        return "<svg/>"
    monkeypatch.setattr(orch, "_render_svg", fake_svg)

    # Exercise render() directly to isolate the dev-mode exclusion policy
    # from the verify() pass-through logic of orchestrate().
    svg, cj_used, needs_review = orch.render(
        sample_nir["circuit_json"], "development", [fault]
    )

    # Faulted component excluded from the render input.
    names = {c["name"] for c in rendered_inputs[0]["components"]}
    assert "Q1" not in names
    assert "U3" in names
    assert "R1" in names
    # Returned circuit_json is the same filtered object (for downstream sim).
    assert cj_used is not sample_nir["circuit_json"]
    assert {c["name"] for c in cj_used["components"]} == {"U3", "R1"}
    assert needs_review is False
    # Original NIR untouched (deep copy, not mutated).
    assert any(c["name"] == "Q1" for c in sample_nir["circuit_json"]["components"])





def test_render_production_needs_review_badge(
    monkeypatch, sample_nir, tmp_path
):
    """Prod mode: full circuit renders, needs_review True, badge injected."""
    fault = orch.Fault(
        fault_type="placement_violation",
        origin_layer="verifier",
        affected_component="Q1",
        message="x",
    )
    monkeypatch.setattr(orch, "_render_svg", lambda cj: "<svg></svg>")

    svg, cj_used, needs_review = orch.render(
        sample_nir["circuit_json"], "production", [fault]
    )
    assert needs_review is True
    assert "NEEDS REVIEW" in svg
    # Full circuit preserved (no exclusion in production).
    names = {c["name"] for c in cj_used["components"]}
    assert "Q1" in names


def test_render_no_faults_clean(monkeypatch, sample_nir):
    monkeypatch.setattr(orch, "_render_svg", lambda cj: "<svg></svg>")
    svg, cj_used, needs_review = orch.render(
        sample_nir["circuit_json"], "production", []
    )
    assert needs_review is False
    assert "NEEDS REVIEW" not in svg


# --------------------------------------------------------------------------- #
# 4. Logging
# --------------------------------------------------------------------------- #

def test_log_written_each_iteration(monkeypatch, sample_nir, ok_sim, tmp_path):
    log_file = tmp_path / "audit.jsonl"
    monkeypatch.setattr(orch, "LOG_PATH", str(log_file))
    monkeypatch.setattr(orch, "verify", lambda cj, n, c: None)
    monkeypatch.setattr(orch, "run_simulation", lambda cj: ok_sim)
    monkeypatch.setattr(orch, "_render_svg", lambda cj: "<svg/>")

    orch.orchestrate(sample_nir, "production")
    assert log_file.exists()
    lines = log_file.read_text().strip().splitlines()
    records = [json.loads(l) for l in lines]
    # at least verify + sim log entries
    stages = [r["stage"] for r in records]
    assert "verify" in stages
    assert "sim" in stages
    assert all("nir_hash" in r for r in records)
