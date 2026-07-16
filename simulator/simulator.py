"""Open_Forge — Team E simulator, Python wrapper (Layer 4).

Thin Python wrapper around `simulator/simulator.ts` and
`simulator/netlistFromCircuitJson.ts`.  Drives ngspice via the TypeScript
bridge by writing a small driver script to a temp file and running it
through a JS runtime (`bun` or `tsx`) that can import TypeScript directly.

HARD CONSTRAINT — same as the TS side:
    This module performs NO simulation itself.  It does NOT call the `tsci`
    CLI, the `@tscircuit/ngspice-spice-engine` wasm wrapper, or any
    tscircuit simulate function.  It only:
      1. writes a tiny driver script to a temp .ts file that imports
         `simulator.ts` / `netlistFromCircuitJson.ts`,
      2. pipes the netlist (or [circuit_json, nir] pair) to that script's
         stdin,
      3. the runner dynamically imports the TS module, calls
         `simulateNetlist` / `netlistFromCircuitJson`, and writes the
         resulting JSON to stdout,
      4. parses the JSON it gets back.

Why a temp file and not `runner -e <script>`?
    `bun -e <script>` on Windows interprets the colon in absolute paths
    like `C:\\...` as a regex / ternary syntax and refuses to parse the
    resulting string.  Writing the driver to a temp file and running it
    with `bun run <file>` sidesteps that entirely, and the same approach
    works on Linux/macOS too.

Environment:
    NODE_BIN              path to `node` binary (default: `node`).
    NGSPICE_BIN           forwarded to the TS simulator (override ngspice
                          binary, e.g. `ngspice_con.exe` on Windows).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

NODE_BIN = os.environ.get("NODE_BIN", "node")

_SIM_TS = Path(__file__).with_name("simulator.ts")
_NCJ_TS = Path(__file__).with_name("netlistFromCircuitJson.ts")
# `*.ts` siblings; `node` can't directly import a .ts file without a loader.
# We support two runners that work out of the box in a tscircuit project:
# `bun` (preferred) or `tsx`.  Probe in that order.
_RUNNERS = ("bun", "tsx")


def _resolve_runner() -> tuple[str, list[str]]:
    """Return (runner_binary, prepend_args) for the bridge, or raise."""
    for r in _RUNNERS:
        try:
            subprocess.run(
                [r, "--version"],
                capture_output=True,
                timeout=5,
                check=True,
            )
            return r, []
        except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            continue
    raise RuntimeError(
        "open_forge.simulator needs `bun` or `tsx` to evaluate simulator.ts. "
        "Install one of them or set NODE_BIN to a JS runtime that can import "
        "TypeScript directly."
    )


def _bridge_path() -> str:
    """Absolute path to the TS simulator the runner will load."""
    return str(_SIM_TS)


def _ncj_bridge_path() -> str:
    """Absolute path to the TS netlistFromCircuitJson the runner will load."""
    return str(_NCJ_TS)


# --------------------------------------------------------------------------- #
# Driver-script writer
# --------------------------------------------------------------------------- #

def _write_driver(body: str) -> str:
    """Write `body` to a temp .ts file and return its absolute path.

    The file lives in the system temp dir and is closed immediately; the
    runner keeps the inode alive via its open file handle until the
    subprocess exits.  The caller does NOT need to clean it up — Windows
    and POSIX both release the file when the process exits, and the OS
    scrubs the temp dir on reboot.
    """
    fd, path = tempfile.mkstemp(suffix=".ts", prefix="openforge-sim-bridge-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(body)
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    return path


def _run_driver(driver_path: str, stdin_payload: str, timeout_s: int) -> str:
    """Run the driver script with `bun run` (or `tsx`) and capture stdout."""
    runner, extra_args = _resolve_runner()
    proc = subprocess.run(
        [runner, *extra_args, "run", driver_path],
        input=stdin_payload,
        capture_output=True,
        text=True,
        timeout=timeout_s,
        env={**os.environ},
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"simulator.ts runner failed (rc={proc.returncode}): {proc.stderr}"
        )
    return proc.stdout


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

class SimulationResult:
    """Typed-ish result returned by `simulate_netlist`."""

    __slots__ = ("vectors", "variables", "num_points", "plotname", "viewer_used")

    def __init__(
        self,
        vectors: dict[str, list[float]],
        variables: list[dict],
        num_points: int,
        plotname: str | None,
        viewer_used: str | None,
    ):
        self.vectors = vectors
        self.variables = variables
        self.num_points = num_points
        self.plotname = plotname
        self.viewer_used = viewer_used

    def __repr__(self) -> str:  # pragma: no cover - debug only
        return (
            f"SimulationResult(vars={len(self.variables)}, "
            f"points={self.num_points}, plotname={self.plotname!r})"
        )


class NetlistResult:
    """Typed-ish result returned by `netlist_from_circuit_json`."""

    __slots__ = ("netlist", "node_map", "warnings")

    def __init__(
        self,
        netlist: str,
        node_map: dict[str, int],
        warnings: list[str],
    ):
        self.netlist = netlist
        self.node_map = node_map
        self.warnings = warnings

    def __repr__(self) -> str:  # pragma: no cover - debug only
        return (
            f"NetlistResult(nets={len(self.node_map)}, warnings={len(self.warnings)})"
        )


def simulate_netlist(
    netlist: str,
    *,
    ngspice_bin: str | None = None,
    timeout_ms: int | None = None,
) -> SimulationResult:
    """Run a SPICE netlist through ngspice and return parsed vectors.

    Args:
        netlist: Complete SPICE netlist text (including .control block if desired).
        ngspice_bin: Optional override for ngspice binary path
                     (e.g. "C:\\Tools\\Spice64\\bin\\ngspice_con.exe").
                     Also respects NGSPICE_BIN env var.
        timeout_ms: Optional timeout in milliseconds (default 60s).

    Returns:
        SimulationResult with vectors (name -> float[]), variable metadata,
        number of points, plot name, and ngspice version banner.

    Raises:
        FileNotFoundError  — if simulator.ts is missing on disk.
        RuntimeError       — if the runner fails or returns malformed JSON.
    """
    bridge = _bridge_path()
    if not Path(bridge).is_file():
        raise FileNotFoundError(f"simulator.ts not found at {bridge}")

    # Forward NGSPICE_BIN to the TS bridge via env.
    if ngspice_bin:
        os.environ["NGSPICE_BIN"] = ngspice_bin
    # (If not set on the Python side, the env var is already inherited from
    # the parent's environment; nothing to do.)

    bridge_literal = json.dumps(bridge)
    ngspice_literal = json.dumps(ngspice_bin) if ngspice_bin else "null"
    timeout_literal = json.dumps(timeout_ms) if timeout_ms is not None else "null"

    driver = (
        "import { simulateNetlist } from " + bridge_literal + ";\n"
        "let stdin = \"\";\n"
        "process.stdin.setEncoding(\"utf8\");\n"
        "process.stdin.on(\"data\", (c) => { stdin += c; });\n"
        "process.stdin.on(\"end\", async () => {\n"
        "  try {\n"
        "    const opts = {};\n"
        "    if (" + ngspice_literal + " !== null) opts.ngspiceBin = " + ngspice_literal + ";\n"
        "    if (" + timeout_literal + " !== null) opts.timeoutMs = " + timeout_literal + ";\n"
        "    const out = await simulateNetlist(stdin, opts);\n"
        "    process.stdout.write(JSON.stringify(out));\n"
        "  } catch (e) {\n"
        "    process.stderr.write(\"simulator bridge error: \" + (e && e.stack ? e.stack : String(e)) + \"\\n\");\n"
        "    process.exit(1);\n"
        "  }\n"
        "});\n"
    )

    driver_path = _write_driver(driver)
    try:
        stdout = _run_driver(
            driver_path,
            netlist,
            timeout_s=(timeout_ms or 60_000) // 1000 + 30,
        )
    finally:
        try:
            os.unlink(driver_path)
        except OSError:
            pass

    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"simulator.ts returned non-JSON output: {e}; head={stdout[:200]!r}"
        )
    return SimulationResult(
        vectors=payload.get("vectors", {}),
        variables=payload.get("variables", []),
        num_points=payload.get("numPoints", 0),
        plotname=payload.get("plotname"),
        viewer_used=payload.get("viewerUsed"),
    )


class NetlistResult:
    """Typed-ish result returned by `netlist_from_circuit_json`."""

    __slots__ = ("netlist", "node_map", "warnings")

    def __init__(
        self,
        netlist: str,
        node_map: dict[str, int],
        warnings: list[str],
    ):
        self.netlist = netlist
        self.node_map = node_map
        self.warnings = warnings

    def __repr__(self) -> str:  # pragma: no cover - debug only
        return f"NetlistResult(netlist_len={len(self.netlist)}, nodes={len(self.node_map)}, warnings={len(self.warnings)})"


def netlist_from_circuit_json(circuit_json: list, nir: dict) -> NetlistResult:
    """Convert Circuit JSON + NIR to a SPICE netlist via the TS bridge.

    Mirrors the same runner pattern as `simulate_netlist` but calls
    `netlistFromCircuitJson` instead.

    Returns:
        NetlistResult with keys: netlist (str), node_map (dict), warnings (list[str])
    """
    bridge = _ncj_bridge_path()
    if not Path(bridge).is_file():
        raise FileNotFoundError(f"netlistFromCircuitJson.ts not found at {bridge}")

    bridge_literal = json.dumps(bridge)
    driver = (
        "import { netlistFromCircuitJson } from " + bridge_literal + ";\n"
        "let stdin = \"\";\n"
        "process.stdin.setEncoding(\"utf8\");\n"
        "process.stdin.on(\"data\", (c) => { stdin += c; });\n"
        "process.stdin.on(\"end\", () => {\n"
        "  try {\n"
        "    const parsed = JSON.parse(stdin);\n"
        "    const out = netlistFromCircuitJson(parsed[0], parsed[1]);\n"
        "    process.stdout.write(JSON.stringify(out));\n"
        "  } catch (e) {\n"
        "    process.stderr.write(\"netlistFromCircuitJson bridge error: \" + (e && e.stack ? e.stack : String(e)) + \"\\n\");\n"
        "    process.exit(1);\n"
        "  }\n"
        "});\n"
    )

    driver_path = _write_driver(driver)
    try:
        stdout = _run_driver(
            driver_path,
            json.dumps([circuit_json, nir]),
            timeout_s=60,
        )
    finally:
        try:
            os.unlink(driver_path)
        except OSError:
            pass

    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"netlistFromCircuitJson returned non-JSON output: {e}; head={stdout[:200]!r}"
        )
    return NetlistResult(
        netlist=payload.get("netlist", ""),
        node_map=payload.get("nodeMap", {}),
        warnings=payload.get("warnings", []),
    )
