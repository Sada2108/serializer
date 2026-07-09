"""Open_Forge — Team E: output / serialization layer.

Orchestrates the path from an upstream NIR (structured JSON design object with
free-text placement notes) to a rendered schematic + SPICE simulation result.

Status:
    All orchestrator logic is intentionally unimplemented pending finalization
    of the verifier architecture (see project context open questions).  Only
    data structures and function signatures are defined here.  Each function
    body raises `NotImplementedError`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


FaultType = Literal["placement_violation", "component_inadequate", "structural"]
Mode = Literal["production", "development"]


# --------------------------------------------------------------------------- #
# Dataclasses
# --------------------------------------------------------------------------- #

@dataclass
class Fault:
    """A verification / simulation failure surfaced to the orchestrator."""

    fault_type: FaultType
    origin_layer: str
    affected_component: str
    message: str
    candidates: list[dict] | None = None
    retry_count: int = 0


@dataclass
class SimResult:
    """Parsed output of a real ngspice run."""

    passed: bool
    raw_stdout: str
    raw_stderr: str
    return_code: int


@dataclass
class FinalOutput:
    """Successful end-state of `orchestrate`."""

    circuit_json: dict
    svg: str
    sim: SimResult | None
    mode: Mode
    needs_review: bool = False


# --------------------------------------------------------------------------- #
# 2. Verifier — pluggable LLM interface
# --------------------------------------------------------------------------- #

def verify(
    circuit_json: dict,
    placement_notes: list[str],
    datasheet_context: dict,
) -> Fault | None:
    """Verify a Circuit JSON object against placement notes & datasheet info.

    PLUGGABLE LLM INTERFACE:
        This function is the single seam where an LLM is invoked.  The final
        implementation will call out to whichever provider is configured
        (OpenAI / Anthropic / local).  Returns `None` if the design is
        compliant, a `Fault` if not.

    Prompting guidance — IMPORTANT:
        Prompts sent through this interface MUST use explicit structural
        rules, e.g.:

            "Q1 and U3 must be at least 5 mm apart."
            "Decoupling cap C5 must lie within 2 mm of U1 pin VCC."
            "No copper pour under L1 keepout region."

        NOT vague phrasing like "place things sensibly" / "avoid thermal
        issues".  The Masala-CHAI paper found that structural / explicit
        prompt cues significantly outperform vague instructions for
        circuit-reading LLM tasks.  Vague prompts produce inconsistent
        verdicts across runs — exactly the failure mode the JSONL audit log
        (planned for this layer) exists to catch.
    """
    raise NotImplementedError(
        "Orchestrator logic pending verifier architecture design — "
        "see project context open questions"
    )


# --------------------------------------------------------------------------- #
# 3. Simulation — real ngspice via subprocess
# --------------------------------------------------------------------------- #

def run_simulation(circuit_json: dict) -> SimResult:
    """Convert Circuit JSON → SPICE netlist → run REAL ngspice → SimResult.

    Intentionally does NOT use `tsci simulate` or any tscircuit wasm/ngspice
    wrapper.  The netlist string from `circuit-json-to-spice` is written to a
    temp file and fed to the locally-installed `ngspice` binary via
    `subprocess`.  Kept as a separate, independently swappable function with
    no shared state with `verify`.
    """
    raise NotImplementedError(
        "Orchestrator logic pending verifier architecture design — "
        "see project context open questions"
    )


# --------------------------------------------------------------------------- #
# 4. Render — circuit-to-svg / @tscircuit/schematic-viewer
# --------------------------------------------------------------------------- #

def render(
    circuit_json: dict,
    mode: Mode,
    faults: list[Fault],
) -> tuple[str, dict, bool]:
    """Render Circuit JSON to SVG, honoring mode-specific fault policy.

    Returns
        (svg, circuit_json_used, needs_review)

    - "development": faulted components are EXCLUDED from the render and from
      the returned circuit_json (callers feed that to `run_simulation`), then
      the rest of the circuit renders + simulates normally.
    - "production": any active Fault attaches a visible `needs_review` flag;
      the full circuit renders but downstream simulation must NOT run until
      faults are cleared.
    """
    raise NotImplementedError(
        "Orchestrator logic pending verifier architecture design — "
        "see project context open questions"
    )


# --------------------------------------------------------------------------- #
# 5. Orchestrator
# --------------------------------------------------------------------------- #

def orchestrate(
    nir: dict,
    mode: Mode,
) -> FinalOutput | Fault:
    """End-to-end: NIR → verify → (render + simulate) → FinalOutput | Fault.

    - placement_violation Faults trigger a corrected-NIR retry via a callback,
      capped at MAX_RETRIES.  Past the cap the last Fault is returned.
    - If verify passes and simulation then fails, a `component_inadequate`
      Fault is raised and `get_alternative_components` populates candidates.
    - In "production" mode, any active Fault yields a `needs_review` render
      and simulation is skipped until faults clear.
    - In "development" mode, faulted components are isolated and the rest of
      the circuit still renders + simulates.
    """
    raise NotImplementedError(
        "Orchestrator logic pending verifier architecture design — "
        "see project context open questions"
    )
