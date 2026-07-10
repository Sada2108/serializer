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
