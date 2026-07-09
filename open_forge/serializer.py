"""Open_Forge — Team E serializer, Python wrapper (Layer 3).

Thin Python wrapper around `open_forge/serializer.ts`.  Drives the new
export path (NIR -> Circuit JSON -> SVG) by shelling out to the TypeScript
serializer via a small `node`-based bridge that evaluates an inline script.

HARD CONSTRAINT — same as the TS side:
    This module performs NO simulation.  It does NOT call the `tsci` CLI, the
    `@tscircuit/ngspice-spice-engine` wasm wrapper, or any tscircuit simulate
    function.  It only:
      1. pipes NIR JSON to `node`,
      2. `node` dynamically imports `open_forge/serializer.ts` and calls
         `serializeNir`,
      3. parses the `{circuitJson, svg, viewerUsed}` JSON it gets back.

Pre-existing CLI/TSX export path (`tsci build` on `index.circuit.tsx` at
project root) is untouched and remains the fallback.

Environment:
    NODE_BIN              path to `node` binary (default: `node`).
    OPEN_FORGE_VIEWER     forwarded to the TS serializer
                          (`schematic-viewer` | `circuit-to-svg`).
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

NODE_BIN = os.environ.get("NODE_BIN", "node")

_BRIDGE_SRC = Path(__file__).with_name("serializer.ts")
# `serializer.ts` is a sibling, but `node` can't directly import a .ts file
# without a loader.  We support two runners that work out of the box in a
# tscircuit project: `bun` (preferred) or `tsx`.  Probe in that order.
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
        "open_forge.serializer needs `bun` or `tsx` to evaluate serializer.ts. "
        "Install one of them or set NODE_BIN to a JS runtime that can import "
        "TypeScript directly."
    )


def _bridge_path() -> str:
    """Absolute path to the TS serializer the runner will load."""
    return str(_BRIDGE_SRC)


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

class SerializedNir:
    """Typed-ish result returned by `serialize_nir`."""

    __slots__ = ("circuit_json", "svg", "viewer_used")

    def __init__(self, circuit_json, svg: str, viewer_used: str | None):
        self.circuit_json = circuit_json
        self.svg = svg
        self.viewer_used = viewer_used

    def __repr__(self) -> str:  # pragma: no cover - debug only
        return (
            f"SerializedNir(viewer_used={self.viewer_used!r}, "
            f"svg_len={len(self.svg) if self.svg else 0})"
        )


def serialize_nir(nir: dict) -> SerializedNir:
    """NIR -> Circuit JSON -> SVG (new export path).  Pure data, no sim.

    Raises:
        FileNotFoundError  — if the TS serializer is missing on disk.
        RuntimeError       — if the runner fails or returns malformed JSON.
    """
    bridge = _bridge_path()
    if not Path(bridge).is_file():
        raise FileNotFoundError(f"serializer.ts not found at {bridge}")

    runner, extra_args = _resolve_runner()
    inline = (
        "import { serializeNir, type Nir } from "
        f"{json.dumps(bridge)};\n"
        "let stdin='';"
        "process.stdin.setEncoding('utf8');"
        "process.stdin.on('data', c => stdin += c);"
        "process.stdin.on('end', async () => {"
        "  try {"
        "    const nir = JSON.parse(stdin) as Nir;"
        "    const out = serializeNir(nir);"
        "    process.stdout.write(JSON.stringify(out));"
        "  } catch (e) {"
        "    process.stderr.write('serializer bridge error: ' + (e && e.stack ? e.stack : String(e)) + '\\n');"
        "    process.exit(1);"
        "  }"
        "});"
    )
    proc = subprocess.run(
        [runner, *extra_args, "-e", inline],
        input=json.dumps(nir),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"serializer.ts runner failed (rc={proc.returncode}): {proc.stderr}"
        )
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"serializer.ts returned non-JSON output: {e}; head={proc.stdout[:200]!r}"
        )
    return SerializedNir(
        circuit_json=payload.get("circuitJson"),
        svg=payload.get("svg", ""),
        viewer_used=payload.get("viewerUsed"),
    )
