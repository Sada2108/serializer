"""Open_Forge — Team E verification producer (Layer 3).

Fault objects returned by this module are consumed by orchestrator.py once
its logic is implemented — this file only produces Faults, it does not call
or trigger the orchestrator directly.

Module scope:
    This file deliberately imports nothing from orchestrator except the
    `Fault` dataclass.  It is intentionally one-way: code here raises /
    returns `Fault`s, never hands them to `orchestrate`, never calls
    `render`/`run_simulation`, and never writes the JSONL audit log.
    The orchestrator (when its logic is implemented) will be the *only*
    downstream consumer.

    For now, the verification logic is a thin placeholder check on a
    per-component `flagged` field surfaced from Layer 2's upstream
    output.  Real LLM-based reasoning is a stubbed TODO below and is NOT
    wired up.
"""

from __future__ import annotations

from typing import Any

from open_forge.orchestrator import Fault


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

LLM_API_KEY = None  # TODO: set via env var, do not hardcode


# --------------------------------------------------------------------------- #
# Verification
# --------------------------------------------------------------------------- #

def verify_component(
    circuit_json: dict | list[Any],
    component_id: str,
) -> Fault | None:
    """Verify a single component against Layer 2's output.

    Today this checks exactly one thing: whether the component identified by
    `component_id` is flagged as invalid / wrong in Layer 2's upstream
    output (read from the component's optional `flagged` field).

    Returns:
        None  — if the component passes this check.
        Fault — if it fails, with:
            fault_type        = "component_inadequate"
            origin_layer      = "layer_2"
            affected_component = <component_id>
            message           = "Component '<id>' flagged as a wrong-component
                                / invalid by Layer 2 origin classification"
            candidates        = None
            retry_count       = 0

    NOTE — TODO (LLM reasoning, not yet wired):
        The real component-adequacy reasoning will be performed by an LLM
        invoked through this function once the verifier architecture is
        finalized.  Until then the check is the simple placeholder condition
        below: any component whose Layer-2-supplied `flagged` field is
        truthy is reported as `component_inadequate`.  This is NOT real
        LLM logic and must not be relied on as a true verdict.
    """
    components = _extract_components(circuit_json)
    target = _find_component(components, component_id)
    if target is None:
        return None

    # --- placeholder check ---
    # TODO: replace with the real LLM-based reasoning call.  The condition
    # below is a stand-in: Layer 2 is expected to set a truthy `flagged`
    # field on any component it classifies as the wrong / invalid part for
    # this slot.  Until that upstream contract stabilizes, this is the only
    # signal we consume.
    if not target.get("flagged"):
        return None

    return Fault(
        fault_type="component_inadequate",
        origin_layer="layer_2",
        affected_component=component_id,
        message=(
            f"Component '{component_id}' flagged as a wrong-component / "
            "invalid by Layer 2 origin classification"
        ),
    )


# --------------------------------------------------------------------------- #
# Internal helpers (no external contract; do not import from outside)
# --------------------------------------------------------------------------- #

def _extract_components(circuit_json: dict | list[Any]) -> list[dict]:
    """Pull the list of components out of either a dict-shaped or raw Circuit
    JSON input.  Accepts both `{'components': [...]}` and a bare list.
    """
    if isinstance(circuit_json, dict):
        comps = circuit_json.get("components") or circuit_json.get("elements") or []
        if isinstance(comps, list):
            return [c for c in comps if isinstance(c, dict)]
    if isinstance(circuit_json, list):
        return [c for c in circuit_json if isinstance(c, dict)]
    return []


def _find_component(components: list[dict], component_id: str) -> dict | None:
    """Match by `name` first, then by `id` (Circuit JSON uses `id`/`name`)."""
    for c in components:
        if str(c.get("name") or "") == component_id:
            return c
    for c in components:
        if str(c.get("id") or "") == component_id:
            return c
    return None
