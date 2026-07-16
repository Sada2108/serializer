# Layer 3 Serializer

Converts NIR (Neutral Intermediate Representation) circuit data into a rendered
SVG schematic, via Circuit JSON as the intermediate format.

## Pipeline

```
NIR (JSON) → parse & validate → Circuit JSON → layout → SVG
```

1. **Schema detection** — automatically detects whether input NIR is the
   legacy format (`source_component_base` / `source_net` / `source_trace`)
   or the newer v1.1 format (`components` / `netlist` / `board_spec`).
2. **Validation** — required fields are checked per component, net, and
   connection. Malformed input raises a clear error rather than silently
   returning an empty result.
3. **Layout** — components are grouped using union-find based on shared
   nets and hard proximity constraints, then placed row-by-row and
   centered in the canvas.
4. **Rendering** — each component type (resistor, capacitor, diode, IC,
   ferrite bead) is drawn with its own real schematic symbol, reference
   label, and value label. Connecting wires are drawn between component
   pins using orthogonal (right-angle) routing.

## Files

| File | Purpose |
|---|---|
| `serializer/serializer.ts` | Core serializer logic (schema parsing, layout, symbol rendering, wire routing) |
| `serializer/serializer.py` | Python wrapper — calls `serializer.ts` via a Node subprocess bridge |
| `serializer/fixtures/index.ts` | Typed NIR fixture loader |
| `serializer/fixtures/libbrecht-hall.nir.json` | Legacy (v0.1) schema test fixture |
| `serializer/fixtures/instrumentation_amp_001.nir.json` | Current (v1.1) schema test fixture |
| `serializer.test.ts` | bun test suite (schema detection, end-to-end rendering, loud-failure cases) |
| `test_serializer.py` | pytest suite for the Python bridge |

## Usage

**From TypeScript:**
```ts
import { serializeNir } from "./serializer/serializer"
import { instrumentationAmpNir } from "./serializer/fixtures"

const result = serializeNir(instrumentationAmpNir)
// result.circuitJson, result.svg, result.viewerUsed
```

**From Python:**
```python
from serializer.serializer import serialize_nir
import json

with open("serializer/fixtures/instrumentation_amp_001.nir.json") as f:
    nir = json.load(f)

result = serialize_nir(nir)
# result.circuit_json, result.svg, result.viewer_used
```

## Running tests

```bash
bun test serializer.test.ts
python3 -m pytest test_serializer.py -v
```

## Known limitations (as of this commit)

- **PCB layout and 3D model rendering are not yet implemented** — this
  module currently only produces a schematic view.
- **Board dimensions default to 50×50mm** when `board_spec` doesn't
  specify `width`/`height` — a placeholder until the schema carries
  real board size data.
- **Layout is a constraint-aware grid, not a true force-directed or
  constraint-solving layout** — components sharing a net or a hard
  proximity constraint are grouped and row-placed, not optimally packed.
- **`placement_rules_text`** (natural-language placement rules) are
  parsed but not yet used to influence layout — that requires LLM-based
  reasoning, planned for the verifier module.
- This module does **not** call `tsci simulate` or any tscircuit
  wasm/ngspice wrapper — simulation is handled separately via a direct
  ngspice subprocess call (see orchestrator, not part of this module).

## Schema versions supported

- **v0.1** (legacy) — flat `source_component_base` / `source_net` /
  `source_trace` records. No positions, no confidence scores.
- **v1.1** (current) — structured `components` / `netlist` / `board_spec`
  with per-component positions, per-layer confidence scores, named test
  points, and natural-language placement rules.

Both schemas are supported simultaneously; the serializer auto-detects
which one it's given.

---

# Layer 4 Simulator

Runs SPICE netlists through ngspice (via subprocess) and returns parsed
simulation vectors.  Mirrors the serializer's architecture: core TS logic
(`simulator/simulator.ts`) + Python wrapper (`simulator/simulator.py`).

## Pipeline

```
SPICE netlist (.cir) → ngspice -b → ASCII .raw → parse → { vectors, metadata }
```

Or from Circuit JSON:
```
Circuit JSON + NIR → netlistFromCircuitJson() → SPICE netlist → ngspice → vectors
```

## Files

| File | Purpose |
|---|---|
| `simulator/simulator.ts` | Core simulator: temp file I/O, ngspice subprocess, .raw parser |
| `simulator/parseRawFile.ts` | Pure ngspice ASCII .raw parser (unit-testable) |
| `simulator/netlistFromCircuitJson.ts` | Circuit JSON + NIR → SPICE netlist (value lookup from NIR) |
| `simulator/simulator.py` | Python wrapper — calls TS via `bun`/`tsx` bridge |
| `simulator/fixtures/rc_circuit.cir` | Known-good RC netlist with `.tran` |
| `simulator/fixtures/rc_circuit.expected.json` | Golden vectors for regression |
| `simulator/fixtures/index.ts` | Typed fixture loader |
| `simulator.test.ts` | bun test suite (parser, netlist gen, end-to-end) |
| `test_simulator.py` | pytest suite for Python wrapper |

## System dependency

**ngspice** must be installed and on PATH, or set `NGSPICE_BIN` to the
binary.

- Linux/macOS: `apt install ngspice` / `brew install ngspice`
- Windows: Download from https://ngspice.sourceforge.io/download.html
  - **Critical**: The default `ngspice.exe` on Windows is a GUI wrapper
    that hangs in batch mode. Use `ngspice_con.exe` (console variant) and
    set `NGSPICE_BIN=C:\Tools\Spice64\bin\ngspice_con.exe` (or wherever
    you installed it).

Check version: `ngspice -v` (or `%NGSPICE_BIN% -v`).  The test suite
records the banner via `getNgspiceVersion()`.

## Usage

**From TypeScript:**
```ts
import { simulateNetlist } from "./simulator/simulator"
import { netlistFromCircuitJson } from "./simulator/netlistFromCircuitJson"
import { serializeNir } from "./serializer/serializer"
import { instrumentationAmpNir } from "./serializer/fixtures"

// Option A: direct netlist
const netlist = `
* RC filter
V1 in 0 PULSE(0 1 0 1n 1n 1m 2m)
R1 in out 1k
C1 out 0 1u
.tran 10u 5m
`
const result = await simulateNetlist(netlist)
console.log(result.vectors["v(out)"])

// Option B: NIR -> Circuit JSON -> netlist -> simulate
const { circuitJson } = serializeNir(instrumentationAmpNir)
const { netlist } = netlistFromCircuitJson(circuitJson, instrumentationAmpNir)
const simResult = await simulateNetlist(netlist)
```

**From Python:**
```python
from simulator.simulator import simulate_netlist, netlist_from_circuit_json
import json

# Direct netlist
with open("simulator/fixtures/rc_circuit.cir") as f:
    netlist = f.read()

result = simulate_netlist(netlist)
print(len(result.vectors["v(out)"]))  # -> 610 points
```

## Running tests

```bash
# TypeScript (bun)
bun test simulator.test.ts

# Python (pytest)
python -m pytest test_simulator.py -v
```

### Windows-specific notes

- Set `NGSPICE_BIN` to the console binary:
  ```powershell
  $env:NGSPICE_BIN = "C:\Tools\Spice64\bin\ngspice_con.exe"
  bun test simulator.test.ts
  ```
- If you see `ngspice -v produced no output` or tests hang, you're likely
  hitting the GUI wrapper. Ensure `NGSPICE_BIN` points to `ngspice_con.exe`.

## Known limitations

- Only passive components (R, C, L, D) and independent sources (V, I) are
  modeled as SPICE primitives.  ICs (opamps, regulators, in-amps, digipots)
  are emitted as 1-ohm placeholder resistors with a warning — accurate
  simulation requires subcircuit models (`.subckt`) which are not bundled.
- No Monte Carlo, no parameter sweeps — single-run transient/DC/AC only.
- The `.control` block in generated netlists uses a fixed `.tran 1m 10m`;
  real use-cases should override or post-process the netlist.
- Complex-valued raw files (AC analysis) are parsed but only the real part
  is kept — imaginary components are dropped with a warning.
