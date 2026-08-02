# PCB Layout Module — Progress Report

**Module:** Layer 3 PCB Layout Generation
**Scope:** `~/my-project/layer_three/serializer/` — NIR → Circuit JSON → Autorouted KiCad `.kicad_pcb`
**Project:** Serializer (serializer)
**Author:** Sada Chouhan (Sada2108)
**Date:** 2026-07-27

---

## 1. Overview

The PCB layout module converts NIR (Neutral Intermediate Representation) circuit descriptions into production-ready KiCad `.kicad_pcb` files with fully routed copper traces. It sits within the Layer 3 serialization pipeline, downstream of the tscircuit CircuitRunner auto-placement stage and upstream of optional DRC validation via `kicad-cli`.

**Pipeline position:**

```
NIR v1.1 JSON
  → generateTscircuitJsx() → CircuitRunner → Circuit JSON
  → synthesizePcbPortsAndPads()     ← pcbRouting.ts (NEW)
  → routeCircuitJson()              ← pcbRouting.ts → router.ts → capacity-autorouter
  → snapCircuitJsonTracesToManhattan()
  → enforceTracePadClearance()
  → circuitJsonToKicadPcb()         ← kicadPcbWriter.ts
  → .kicad_pcb file
```

**Key decision: full routing, not ratsnest.** The module targets complete copper trace routing (all nets connected with physical trace segments), not KiCad ratsnest (airwires requiring manual routing). This was a deliberate architectural choice to produce fabrication-ready output.

**Autorouter selection:** `@tscircuit/capacity-autorouter` v0.0.692 (CapacityMeshSolver), wrapped in `router.ts` at `effort: 1` for speed. The solver operates on a mesh-based spatial representation of obstacles and connection points, producing SimplifiedPcbTrace wire/via segments that are snapped to Manhattan geometry before KiCad emission.

---

## 2. Timeline

All PCB layout work was committed in a single checkpoint commit, with subsequent bug fixes applied as uncommitted local changes.

| Date | Commit/Event | Description |
|------|-------------|-------------|
| 2026-07-09 | `03d9f9e` | Initial Layer 3 serializer: NIR → Circuit JSON → SVG. No PCB output. |
| 2026-07-16 | `68d461f` | SOIC-8 footprint added, pin name fixes. |
| 2026-07-17 | `a033682` | Guard `circuitJsonToKicadPcb` behind `pcb_board` presence check (prevents crash on v0.1 NIRs). |
| 2026-07-25 | `b0da82b` | **Major checkpoint.** kicadPcbWriter.ts (535 lines), pcbRouting.ts (475 lines), router.ts (173 lines) added. Full autorouting pipeline, KiCad 10 format writer, placement clearance, Manhattan snap, trace-pad clearance. Schematic-symbols migration also included. |
| 2026-07-26 | `3936430`, `fe1af18` | Remove generated PCB/DRC artifact files from git tracking. |
| 2026-07-27 | *uncommitted* | 4 critical bug fixes: autorouter bounds computation, NIR position override for footprints/board outline, trace net mapping. DRC achieves 0 violations on rc_lowpass fixture. |

### Architecture Decisions

1. **Full routing vs ratsnest:** Full routing chosen to produce fab-ready output. Ratsnest would require manual KiCad interaction.
2. **Autorouter: CapacityMeshSolver** selected over alternatives for its deterministic mesh-based approach and compatibility with the tscircuit ecosystem.
3. **KiCad 10 format:** `(version 20260206)` with `(generator_version "10.0")` targeting `kicad-cli` v10.0.4 installed on the development machine.
4. **DRC gate:** `kicad-cli pcb drc` invoked as a subprocess. No automated CI integration — DRC runs are manual via CLI.
5. **Footprint resolution:** Two-tier approach — real `.kicad_mod` files from the KiCad library (parsed via custom S-expression parser), with `PAD_TEMPLATES` as fallback when the library is unavailable.
6. **NIR positions override CircuitRunner placement:** CircuitRunner auto-places components at arbitrary positions; the KiCad writer always prefers NIR-specified `position.x_mm`/`position.y_mm` for deterministic, reproducible layouts.

---

## 3. Current Implementation

### 3.1 router.ts (174 lines)

Thin wrapper around `@tscircuit/capacity-autorouter` `CapacityMeshSolver`.

- **Input:** `SimpleRouteJson` (obstacles, connections, bounds, layer count, trace width constraints)
- **Solver config:** `{ effort: 1 }` — minimum effort for fastest solve
- **Output:** `RouteCircuitResult` with `RoutedTrace[]` — arrays of wire/via route segments
- **Manhattan snap:** `snapRouteToManhattan()` splits diagonal wire segments into horizontal-first L-shaped orthogonal pairs before returning results
- **Error handling:** Catches solver exceptions and returns `success: false` with error message

**Solver dependency:** `@tscircuit/capacity-autorouter@0.0.692` — pinned version. The solver's `getOutputSimplifiedPcbTraces()` throws `"Cannot get output before solving is complete"` if called prematurely or with malformed input (bounds containing NaN, obstacles at origin, etc.).

### 3.2 kicadPcbWriter.ts (1,171 lines)

Converts Circuit JSON to KiCad 10 `.kicad_pcb` S-expression format.

**Key subsystems:**

- **S-expression parser** (`parseSExpr`): Parses `.kicad_mod` footprint files from the KiCad library. Handles nested lists, quoted atoms, and multi-line expressions.
- **Footprint library resolver** (`resolveFootprintData`): Searches platform-specific KiCad footprint paths (`/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/` on macOS, standard Linux paths). Returns `FootprintData` with parsed pads, graphics, and property texts.
- **Net assignment** (`applyPadsNetAssignments`): Maps pads to nets via `pcb_smtpad → pcb_port → source_port → source_trace → source_net` chain. Falls back to `source_port` → `source_trace` mapping when `pcb_smtpad` is absent.
- **Fallback templates** (`PAD_TEMPLATES`): Hardcoded pad geometry for 10 footprint types (0603, 0402, 1206, SOIC-8, MSOP-8, SOT-23-5, TSOT-23-5, 1x02 pin header) used when the KiCad library is unavailable.
- **Board outline** (`buildBoardOutline`): Computes bounding box from NIR-specified component positions + NIR `board_spec` dimensions, with 3mm margin. Centers the board around the component centroid.
- **Reference designator placement:** ICs (>4 pads): centered text at (0,0). Passives: perpendicular to pad axis with collision-aware fallback to center.
- **Trace segment emission** (`buildTraceSegments`): Converts `pcb_trace` route arrays into KiCad `(segment ...)` and `(via ...)` entries. Detects implicit layer changes and emits vias at transition points. Deduplicates vias by normalized position+layer key.
- **Net declarations** (`buildNetSection`): Emits `(net N "name")` and `(net_class "Default" "" (add_net "name") ...)` blocks — the latter is required or KiCad silently discards net declarations.

**Output format:**
```
(kicad_pcb (version 20260206) (generator "my-project")
  (generator_version "10.0")
  (general ...)
  (layers ...)
  (setup ...)
  (net 0 "")
  (net 1 "VIN")
  ...
  (net_class "Default" "" (add_net "VIN") ...)
  (gr_line ...) ← board outline on Edge.Cuts
  (footprint "..." (at X Y R) ...) ← with pads, graphics, properties
  (segment (start X Y) (end X Y) (width 0.2) (layer "F.Cu") (net N))
  (via (at X Y) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net N))
)
```

### 3.3 pcbRouting.ts (630 lines)

Routing utilities — the bridge between Circuit JSON and the autorouter.

- **`synthesizePcbPortsAndPads`**: Generates `pcb_port` and `pcb_smtpad` elements from NIR component positions + footprint pad data. Applies CW rotation transform for footprint-local → world coordinates. Required because CircuitRunner auto-placement does not produce these elements.
- **`circuitJsonToSimpleRouteJson`**: Converts Circuit JSON to `SimpleRouteJson` — maps `pcb_component` to obstacles, `source_net` to connections (grouping ports by net), and computes bounds from obstacle/connection extents + 5mm margin. Pad-level obstacles include 0.4mm clearance margin.
- **`mergeRoutedTraces`**: Replaces placeholder `pcb_trace` entries with real routed traces. Resolves net names by matching the first wire segment's coordinates against connection point positions.
- **`enforcePlacementClearance`**: Nudges overlapping `pcb_component` elements apart along the axis of minimum overlap, enforcing 0.5mm courtyard clearance.
- **`routeCircuitJson`**: End-to-end pipeline — placement clearance → SimpleRouteJson → solver → merge.
- **`snapCircuitJsonTracesToManhattan`**: Post-route Manhattan snap — splits diagonal wires into orthogonal L-shapes.
- **`enforceTracePadClearance`**: Pushes traces away from other-net pads by 0.25mm (0.2mm clearance + 0.05mm solder mask expansion).

### 3.4 _gen_pcb.ts (30 lines)

CLI entry point: `bun run _gen_pcb.ts [fixture_name]`

Full pipeline: serialize → synthesize ports/pads → route → Manhattan snap → pad clearance → KiCad emit → write file.

---

## 4. Status

### PCB Layout Steps

The PCB layout pipeline can be decomposed into the following functional steps. Each maps to a concrete implementation in the codebase.

| Step | Description | Status | Implementation |
|------|-------------|--------|----------------|
| **1. Circuit JSON → SimpleRouteJson** | Convert Circuit JSON (obstacles, connection points, bounds) to autorouter input format | **Complete** | `pcbRouting.ts:circuitJsonToSimpleRouteJson` |
| **2. Placement clearance enforcement** | Detect and nudge overlapping components apart before routing | **Complete** | `pcbRouting.ts:enforcePlacementClearance` |
| **3. Autorouter execution** | Run CapacityMeshSolver to produce routed trace segments | **Complete** | `router.ts:routeCircuit` |
| **4. Manhattan snap + trace-pad clearance** | Orthogonalize traces, push away from other-net pads | **Complete** | `pcbRouting.ts:snapCircuitJsonTracesToManhattan`, `enforceTracePadClearance` |
| **5. KiCad PCB emission** | Generate `.kicad_pcb` S-expression with footprints, pads, traces, vias, nets, board outline | **Complete** | `kicadPcbWriter.ts:circuitJsonToKicadPcb` |
| **6. Real footprint library integration** | Parse `.kicad_mod` files from KiCad library; fallback to PAD_TEMPLATES | **Complete** | `kicadPcbWriter.ts:resolveFootprintData`, `parseKicadMod` |
| **7. DRC validation gate** | Run `kicad-cli pcb drc` and verify 0 violations, 0 unconnected items | **Complete** (manual) | `kicad-cli pcb drc <file> --format json` |

### DRC Run Status

**Fixture:** `rc_lowpass` (R1 + C1, 3 nets: VIN, VOUT, GND)

```
$ kicad-cli pcb drc _rc_lowpass.kicad_pcb -o /tmp/drc_out.json --format json
Found 0 violations
Found 0 unconnected items
```

All 3 nets fully routed. 0 errors, 0 warnings, 0 unconnected items. Board outline encloses all traces with sufficient edge clearance.

**Fixture:** `opamp_noninv` (OPA344 + R1-R5, C1-C4, 11 components) — routed but not yet validated against latest DRC fixes.

### Test Status

```
102 pass, 0 fail across 6 test files (3164 expect() calls)
```

**PCB-specific test coverage:**

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `kicadPcbWriter.test.ts` | 13 | Output structure, net declarations, footprint blocks, pad rotation regression, net-to-net short detection |
| `pcbRouting.test.ts` | 8 | SimpleRouteJson shape, obstacle mapping, connection mapping, routeCircuitJson e2e, mergeRoutedTraces, enforcePlacementClearance |
| `router.test.ts` | 4 | Successful routing, graceful failure, Manhattan orthogonality, same-layer crossing detection |

---

## 5. Open Issues / Blockers

### 5.1 kicad-cli Version String Compatibility

The writer emits `(version 20260206)` and `(generator_version "10.0")`, which matches the installed `kicad-cli` v10.0.4. No parsing or DRC failures have been observed with this version combination.

**Status:** No active issue. The version string was aligned during development. If KiCad upgrades the expected version number, the writer's hardcoded strings at `kicadPcbWriter.ts:1141-1142` would need updating.

### 5.2 Untracked Files — No Git History for PCB Module

All PCB layout files were added in commit `b0da82b` (2026-07-25) as part of a large checkpoint commit, then subsequently untracked in `3936430` and `fe1af18`. The critical bug fixes from 2026-07-27 (bounds computation, NIR position override, trace net mapping) are **not yet committed**. This makes it impossible to reconstruct the development timeline of individual bug fixes via `git log`.

**Action required:** Commit the current state of `serializer/kicadPcbWriter.ts`, `serializer/pcbRouting.ts`, `serializer/router.ts`, `kicadPcbWriter.test.ts`, `pcbRouting.test.ts`, `router.test.ts`, and `_gen_pcb.ts`.

### 5.3 DRC Is Manual — No Automated Gate

DRC validation requires running `kicad-cli pcb drc` as a separate manual step. There is no integration into the test suite or CI pipeline. The `kicad-cli` binary must be installed on the development machine.

### 5.4 Only Two Fixtures Validated for Full Routing

The `rc_lowpass` fixture (2 passives, 3 nets) has been fully validated through the routing pipeline with clean DRC. The `opamp_noninv` fixture (11 components, 13 nets) routes successfully but has not been re-validated against the latest DRC fixes (NIR position override, trace net mapping).

### 5.5 Single-Layer Routing

The current implementation routes exclusively on the top copper layer (`F.Cu`). The solver supports multi-layer routing with via insertion, but no fixture currently exercises bottom-layer or inner-layer traces. The infrastructure is in place (via detection, layer-change emission) but untested in production.

---

## 6. Next Steps

1. **Commit current state.** Stage the 4 bug fixes and all PCB layout files to establish a clean git history baseline.

2. **Validate opamp_noninv through full DRC.** Run `kicad-cli pcb drc _opamp_test.kicad_pcb` after regenerating with the latest fixes.

3. **Add DRC assertion to test suite.** Wrap `kicad-cli pcb drc` in a Bun test that asserts 0 violations and 0 unconnected items. Requires `kicad-cli` availability check (similar to ngspice skip pattern).

4. **Multi-layer routing validation.** Create a fixture that requires bottom-layer routing (e.g., crossing traces on a dense board) to exercise the via insertion path end-to-end.

5. **Expand fixture coverage.** Route all 6 v1.1 fixtures through the PCB pipeline. The `voltageDividerNir` and `rcLowpassAcNir` fixtures should be straightforward; `instrumentationAmpNir` (17 components) will test scalability.

6. **Gerber export.** Add `kicad-cli pcb export gerbers` invocation to produce fabrication-ready output files from the routed `.kicad_pcb`.

---

## Appendix: Key Metrics

| Metric | Value |
|--------|-------|
| Total PCB module code | 1,974 lines (3 files) |
| Test count (PCB-specific) | 25 tests across 3 files |
| Autorouter dependency | `@tscircuit/capacity-autorouter@0.0.692` |
| KiCad target version | 10.0.4 (`version 20260206`, `generator_version "10.0"`) |
| DRC result (rc_lowpass) | 0 violations, 0 unconnected items |
| Supported footprints (library) | 10 types (0603, 0402, 1206, SOIC-8, MSOP-8, SOT-23-5, TSOT-23-5, 1x02 header) |
| Max fixture routed | opamp_noninv (11 components, 13 nets) |
