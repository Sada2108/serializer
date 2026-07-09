"""Open_Forge — Python wrapper end-to-end test (Layer 3).

Loads the Libbrecht-Hall NIR fixture, calls `open_forge.serializer.serialize_nir`
(Python wrapper around `serializer.ts`), and asserts the returned payload is
well-formed and contains an SVG.

Skips automatically if no JS TypeScript runner (`bun` or `tsx`) is on PATH —
the wrapper needs one of them to evaluate serializer.ts.  Does NOT exercise
the orchestrator, the verifier, or ngspice.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from open_forge import serializer as ser

FIXTURE = (
    Path(__file__).parent / "open_forge" / "fixtures" / "libbrecht-hall.nir.json"
)


def _runner_available() -> bool:
    return any(shutil.which(r) for r in ("bun", "tsx"))


@pytest.fixture
def libbrecht_hall_nir() -> dict:
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


@pytest.mark.skipif(
    not _runner_available(),
    reason="neither bun nor tsx on PATH — TS serializer bridge cannot run",
)
def test_serialize_nir_libbrecht_hall(libbrecht_hall_nir: dict):
    result = ser.serialize_nir(libbrecht_hall_nir)
    # circuit_json is a non-empty list of typed elements.
    assert isinstance(result.circuit_json, list)
    assert len(result.circuit_json) > 0
    # Every element has a string `type` (Circuit JSON discriminator).
    for el in result.circuit_json:
        assert isinstance(el, dict)
        assert "type" in el
        assert isinstance(el["type"], str)
    # SVG is a non-empty string starting with `<svg`.
    assert isinstance(result.svg, str)
    assert result.svg.lstrip().startswith("<svg"), (
        f"expected SVG, got head={result.svg[:32]!r}"
    )
    # viewer_used is one of the two valid values (or null if somehow skipped).
    assert result.viewer_used in (
        "circuit-to-svg",
        "@tscircuit/schematic-viewer",
        None,
    )


def test_serialize_nir_missing_bridge_raises(monkeypatch, libbrecht_hall_nir, tmp_path):
    """If serializer.ts vanished, the wrapper tells us loudly, not silently."""
    bad = tmp_path / "nope.ts"
    monkeypatch.setattr(ser, "_BRIDGE_SRC", bad)
    with pytest.raises(FileNotFoundError):
        ser.serialize_nir(libbrecht_hall_nir)
