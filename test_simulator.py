"""Open_Forge — Python wrapper end-to-end test for simulator (Layer 4).

Loads the RC circuit netlist fixture, calls `simulator.simulate_netlist`
(Python wrapper around `simulator.ts`), and asserts the returned payload
is well-formed and contains expected vectors.

Skips automatically if no JS TypeScript runner (`bun` or `tsx`) is on PATH,
or if ngspice is not available.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from simulator import simulate_netlist, netlist_from_circuit_json, SimulationResult
from simulator import simulator as sim_module

FIXTURE_DIR = Path(__file__).parent / "simulator" / "fixtures"
RC_CIR = FIXTURE_DIR / "rc_circuit.cir"
RC_EXPECTED = FIXTURE_DIR / "rc_circuit.expected.json"

NGSPICE_BIN = shutil.which("ngspice") or shutil.which("ngspice_con.exe")


def _runner_available() -> bool:
    return any(shutil.which(r) for r in ("bun", "tsx"))


def _ngspice_available() -> bool:
    return NGSPICE_BIN is not None


@pytest.fixture
def rc_netlist() -> str:
    with open(RC_CIR, encoding="utf-8") as fh:
        return fh.read()


@pytest.fixture
def rc_expected() -> dict:
    with open(RC_EXPECTED, encoding="utf-8") as fh:
        return json.load(fh)


@pytest.mark.skipif(
    not _runner_available(),
    reason="neither bun nor tsx on PATH — TS simulator bridge cannot run",
)
@pytest.mark.skipif(
    not _ngspice_available(),
    reason="ngspice not on PATH — cannot run simulation",
)
def test_simulate_netlist_rc_circuit(rc_netlist: str, rc_expected: dict):
    """End-to-end: netlist -> ngspice -> parsed vectors."""
    result: SimulationResult = simulate_netlist(rc_netlist, ngspice_bin=NGSPICE_BIN)

    # Basic structure
    assert isinstance(result.vectors, dict)
    assert len(result.vectors) > 0
    assert isinstance(result.variables, list)
    assert len(result.variables) > 0
    assert isinstance(result.num_points, int)
    assert result.num_points > 0
    assert isinstance(result.plotname, str)
    assert len(result.plotname) > 0

    # Required vectors present
    assert "time" in result.vectors
    assert "v(out)" in result.vectors
    assert "v(in)" in result.vectors
    assert "i(v1)" in result.vectors

    # Waveform sanity: RC charging curve
    time = result.vectors["time"]
    vout = result.vectors["v(out)"]
    vin = result.vectors["v(in)"]

    # At t=0, output ~0V (cap uncharged)
    assert vout[0] < 0.01, f"v(out)[0]={vout[0]} should be ~0V"

    # The fixture uses PULSE(0 1 0 1n 1n 1m 2m): 1V from t=0..1ms, 0V from
    # 1ms..2ms, repeating with period 2ms.  So at t=5ms we're mid-cycle
    # (in the second 1ms pulse) and v(out) is charging back up — not 1V.
    assert vout[-1] > 0.5, f"v(out)[-1]={vout[-1]} should be >0.5 (charging)"

    # Input is a pulse: 0->1V at start, back to 0 at 1ms, repeats every 2ms.
    # At t=0..1ms vin should be ~1V (first half of first 2ms period).
    idx_1ms = next((i for i, t in enumerate(time) if t >= 0.001), len(time) - 1)
    assert vin[0] < 0.01, "vin[0] should be ~0V (pulse not yet risen at t=0)"
    assert vin[idx_1ms] > 0.5, f"vin at 1ms={vin[idx_1ms]} should be ~1V (end of first pulse)"

    # Monotonic rise during charging phase (first ~1ms, while pulse is HIGH)
    for i in range(1, idx_1ms):
        assert vout[i] >= vout[i - 1] - 1e-6, f"vout not monotonic at index {i}"


@pytest.mark.skipif(
    not _runner_available(),
    reason="neither bun nor tsx on PATH — TS simulator bridge cannot run",
)
def test_simulate_netlist_invalid_raises(rc_netlist: str):
    """A netlist with a real ngspice error (undefined model) should raise RuntimeError."""
    # A diode line referencing model DMOD without a `.model` card forces
    # ngspice to emit an "Error:" line — bare strings would just be treated
    # as a title line and silently pass, which the wrapper must NOT mask.
    bad_netlist = (
        "* bad netlist\n"
        "V1 in 0 1\n"
        "D1 in 0 DMOD\n"
        ".tran 1u 10u\n"
    )
    with pytest.raises(RuntimeError) as exc_info:
        simulate_netlist(bad_netlist, ngspice_bin=NGSPICE_BIN)
    assert "ngspice" in str(exc_info.value).lower() or "error" in str(exc_info.value).lower()


@pytest.mark.skipif(
    not _runner_available(),
    reason="neither bun nor tsx on PATH — TS simulator bridge cannot run",
)
def test_netlist_from_circuit_json_v01():
    """netlist_from_circuit_json works with v0.1-style NIR + Circuit JSON."""
    circuit_json = [
        {"type": "source_component_base", "name": "R1", "component_type": "resistor", "resistance": "1k"},
        {"type": "source_component_base", "name": "C1", "component_type": "capacitor", "capacitance": "1u"},
        {"type": "source_net", "name": "IN", "is_power": False, "is_ground": False},
        {"type": "source_net", "name": "OUT", "is_power": False, "is_ground": False},
        {"type": "source_net", "name": "GND", "is_power": False, "is_ground": True},
        {"type": "source_trace", "connected_source_port_ids": ["R1_source_port_1"], "connected_source_net_ids": ["net_IN"]},
        {"type": "source_trace", "connected_source_port_ids": ["R1_source_port_2"], "connected_source_net_ids": ["net_OUT"]},
        {"type": "source_trace", "connected_source_port_ids": ["C1_source_port_1"], "connected_source_net_ids": ["net_OUT"]},
        {"type": "source_trace", "connected_source_port_ids": ["C1_source_port_2"], "connected_source_net_ids": ["net_GND"]},
    ]
    nir = {
        "nir_schema_version": "0.1",
        "circuit_json": {
            "components": [
                {"name": "R1", "component_type": "resistor", "resistance": "1k"},
                {"name": "C1", "component_type": "capacitor", "capacitance": "1u"},
            ],
            "nets": [
                {"name": "IN"},
                {"name": "OUT"},
                {"name": "GND", "isGroundNet": True},
            ],
        },
    }
    result = netlist_from_circuit_json(circuit_json, nir)
    assert hasattr(result, "netlist")
    assert isinstance(result.netlist, str)
    assert len(result.netlist) > 0
    assert "R1" in result.netlist
    assert "C1" in result.netlist
    assert "1k" in result.netlist
    assert "1u" in result.netlist
    assert result.node_map["GND"] == 0


@pytest.mark.skipif(
    not _runner_available(),
    reason="neither bun nor tsx on PATH — TS simulator bridge cannot run",
)
def test_netlist_from_circuit_json_v11():
    """netlist_from_circuit_json looks up values from v1.1 NIR."""
    circuit_json = [
        {"type": "source_component_base", "name": "R1", "component_type": "resistor", "component_id": "generic", "footprint": "0603"},
        {"type": "source_net", "name": "NET1", "is_power": False, "is_ground": False},
        {"type": "source_net", "name": "GND", "is_power": False, "is_ground": True},
        {"type": "source_trace", "connected_source_port_ids": ["R1_source_port_1"], "connected_source_net_ids": ["net_NET1"]},
        {"type": "source_trace", "connected_source_port_ids": ["R1_source_port_2"], "connected_source_net_ids": ["net_GND"]},
    ]
    nir = {
        "schema_version": "1.1",
        "components": [
            {"ref": "R1", "component_type": "resistor", "footprint": "0603", "value": "4.7k"},
        ],
        "netlist": [],
    }
    result = netlist_from_circuit_json(circuit_json, nir)
    assert "4.7k" in result.netlist


def test_simulate_netlist_missing_bridge_raises(rc_netlist: str, tmp_path, monkeypatch):
    """If simulator.ts is missing, wrapper raises FileNotFoundError."""
    from simulator import simulator as sim_module
    bad = tmp_path / "nope.ts"
    monkeypatch.setattr(sim_module, "_SIM_TS", bad)
    with pytest.raises(FileNotFoundError):
        simulate_netlist(rc_netlist)