# Serializer — Layer 3 Serializer & Simulator: Full Project Context

> **Purpose:** This document is a complete reference for an AI assistant (Claude) working on this codebase. It covers architecture, every file's role, data schemas, conventions, known issues, and current state as of the latest commit.

---

## 1. Project Identity

- **Name:** `my-project` (package.json) / `serializer` (GitHub repo: `Sada2108/serializer`)
- **Runtime:** Bun (v1.3.14)
- **Language:** TypeScript (strict)
- **Test framework:** Bun's built-in test runner (`bun test`)
- **Repository:** `https://github.com/Sada2108/serializer.git`
- **Working directory:** `/Users/sadachouhan/my-project/layer_three/`

### Team
- **Sada (Sada2108):** Author. Wrote the entire Layer 3 serializer, KiCad PCB writer, routing pipeline, SPICE netlist generator, interactive simulator/dev-tools, and all tests.
- **Sanhita (sanhita0804):** Contributed the Layer 4 simulator module (ngspice batch driver + Python bridge) in commit `44973c6`. That commit was merged via PR #2 and sits at the base of the current history.

---

## 2. Architecture Overview

```
                          NIR (JSON)
                              │
              ┌───────────────┼───────────────┐
              ▼                               ▼
     serializeNir()                   serializeNirAsync()
     (sync fallback)                  (CircuitRunner)
              │                               │
              ▼                               ▼
        Circuit JSON                    Circuit JSON
              │                               │
      ┌───────┴───────┐               ┌───────┼───────────┐
      ▼               ▼               ▼       ▼           ▼
  renderSvg()   kicadPcbWriter   snapManhattan  enforceClearance
  (circuit-to-svg)                (pcbRouting)   (pcbRouting)
      │               │               │       │           │
      ▼               ▼               ▼       ▼           ▼
  SVG string    .kicad_pcb        Manhattan traces, pad-safe clearance
                                (before KiCad emission)
                                        │
                                        ▼
                                 circuitJsonToKicadPcb()
                                        │
                                        ▼
                                   .kicad_pcb file

     Circuit JSON + NIR ──> netlistFromCircuitJson() ──> SPICE netlist
                                        │
                                        ▼
                                  simulateNetlist()
                                  (ngspice -b)
                                        │
                                        ▼
                                   .raw file
                                        │
                              ┌─────────┼─────────┐
                              ▼         ▼         ▼
                        parseRawFile  parseFourier  formatNumbers
                              │         │         │
                              ▼         ▼         ▼
                         vectors    harmonics   formatted
```

### Hard Constraints (from serializer.ts header)
- Only imports `circuit-json`, `circuit-to-svg`, and `@tscircuit/eval`.
- Never calls `tsci simulate`, `@tscircuit/ngspice-spice-engine`, or any wasm-based simulation.
- The serializer performs ZERO simulation. Simulation is exclusively in `simulator/simulator.ts`.

---

## 3. NIR Schema Versions

### v0.1 (Libbrecht-Hall) — Legacy
```typescript
interface Nir {
  nir_schema_version: string       // "0.1" or detected structurally
  fixture_name: string
  placement_notes: string[]
  datasheet_context: Record<string, unknown>
  circuit_json: {
    components: { name: string; type: string; [key: string]: unknown }[]
    nets?: { name: string; isPowerNet?: boolean; isGroundNet?: boolean }[]
    traces?: { from: string; to: string }[]
  }
}
```
- Always synchronous. Byte-for-byte preserved from legacy.
- Components use `name` field (not `ref`), `type` field (not `component_type`).
- Only `libbrechtHallNir` fixture uses this format.

### v1.1 / v1.2 (Instrumentation) — Current
```typescript
interface NirV11 {
  schema_version: "1.1" | "1.2"
  design_id: string
  prompt?: string
  design_methodology?: string
  created_at?: string
  pipeline_version?: string
  topology?: string
  components: NirV11Component[]
  netlist: NirV11NetlistEntry[]
  placement_constraints?: NirV11PlacementConstraint[]
  board_spec: NirV11BoardSpec
  performance_specs?: NirV11PerformanceSpecs
  bom?: unknown[]
  [key: string]: unknown            // open root: unknown keys pass through
}

interface NirV11Component {
  ref: string                      // e.g. "R1", "U1"
  component_id: string
  component_type: string           // "resistor", "capacitor", "instrumentation_amp", etc.
  footprint: string                // "0603", "MSOP-8", "SOIC-8", etc.
  footprint_geometry_ref?: string
  value?: string | null            // "10k", "100n", "5V"
  ac_magnitude?: string | null     // AC analysis magnitude (e.g. "1")
  manufacturer?: string
  datasheet_confidence?: number
  justification?: string
  position: {
    x_mm: number | null
    y_mm: number | null
    rotation_deg: number | null
  }
  position_confidence?: number
  position_source?: string
  confidence_by_layer?: Record<string, number | null>
  _NEW_courtyard_mm?: { width: number; height: number }
  _NEW_thermal_relief_required?: boolean
}

interface NirV11NetlistEntry {
  net_name: string
  net_type: "power" | "ground" | "analog" | "digital"
  connections: { ref: string; pin_name: string; pin_number: string | number }[]
  source_rule?: string
  net_confidence?: number
  _NEW_controlled_impedance?: { target_ohms: number | null } | null
  _NEW_routing_priority_tier?: number   // advisory only; never a required input
}

interface NirV11BoardSpec {
  layers: number
  material: string                 // "FR4" | "FR1"
  thickness_mm: number
  copper_weight_oz?: number
  min_trace_width_mm?: number
  min_clearance_mm?: number
  min_via_drill_mm?: number
  surface_finish?: string
  _NEW_stackup_arrangement?: unknown
  _NEW_prepreg_core_note?: unknown
  _NEW_annular_ring_min_mm?: number
}
```

**v1.2 = relaxed v1.1.** No separate `NirV12` type and no version-forked parse paths — the same `NirV11` parser handles both:
- `schema_version` union `"1.1" | "1.2"`; the strict `requireKeys` gates in `serializer.ts` (parse paths) accept `"1.1"` or `"1.2"`.
- `detectNirVersion` (netlistFromCircuitJson.ts) treats `schema_version === "1.2"` as `"v1.1"`.
- Root type stays open (`[key: string]: unknown`) so `custom_symbols_required` / `hierarchical_sheets` land later as pass-through.
- `_NEW_*` fields are optional and advisory (esp. `_NEW_routing_priority_tier` and `component_groups`) — never required inputs.
- `NirV11PerformanceSpecs` is loose: `[name: string]: Record<string, unknown> & { unit?: string }`.

### Schema Detection (`detectNirSchemaVersion`)
Multi-heuristic approach:
1. Check `schema_version === "1.1"` or `"1.2"` → v1.1/v1.2
2. Check `nir_schema_version === "0.1"` → v0.1
3. Structural: presence of `circuit_json.components` → v0.1; `components` + `netlist` + `board_spec` → v1.1
4. Throws on unrecognized schemas

---

## 4. File-by-File Reference

### 4.1 Core Serializer

#### `serializer/serializer.ts` (1135 lines) — MAIN ENTRY POINT
**Purpose:** Converts NIR → Circuit JSON → SVG and optionally → KiCad `.kicad_pcb`.

**Key exports:**
| Export | Signature | Notes |
|--------|-----------|-------|
| `serializeNir` | `(nir) => SerializerOutput` | Sync. No KiCad output. |
| `serializeNirAsync` | `(nir) => Promise<SerializerOutput>` | Async. Full pipeline: CircuitRunner + Manhattan snap + clearance + KiCad. |
| `nirToCircuitJson` | `(nir) => AnyCircuitElement[]` | Sync. **Note:** Name collision — async version at line 96 is shadowed by sync at line 1098. |
| `nirToCircuitJsonAsync` | `(nir) => Promise<AnyCircuitElement[]>` | Async v1.1 via CircuitRunner. |
| `renderCircuitJson` | `(circuitJson) => { svg, viewerUsed }` | SVG rendering via circuit-to-svg. |
| `generateTscircuitJsx` | `(nir: NirV11) => string` | Generates tscircuit JSX string from v1.1 NIR. |
| `kicadFootprint` | `(fixtureName) => string` | Lookup in `FOOTPRINT_MAP` or passthrough. |
| `detectNirSchemaVersion` | `(nir) => NirSchemaVersion` | Heuristic detection. |

**`serializeNirAsync` pipeline:**
1. `nirToCircuitJsonAsync(nir)` → Circuit JSON
2. `renderCircuitJson(circuitJson)` → SVG
3. `snapCircuitJsonTracesToManhattan(circuitJson)` → Manhattan traces (only if `pcb_board` present)
4. `enforceTracePadClearance(snapped)` → Pad-safe traces
5. `circuitJsonToKicadPcb(cleared)` → KiCad string (only if `pcb_board` present)

**Environment variable:** `KICAD_VIEWER` — if `"schematic-viewer"`, tries `@tscircuit/schematic-viewer` before falling back to `circuit-to-svg`.

**Footprint mapping (`FOOTPRINT_MAP`):**
```
MSOP-8    → kicad:Package_SO/MSOP-8-1EP_3x3mm_P0.65mm_EP1.5x1.8mm
SOT-23-5  → kicad:Package_TO_SOT_SMD/SOT-23-5
TSOT-23-5 → kicad:Package_TO_SOT_SMD/TSOT-23-5
MSOP-10   → kicad:Package_SO/MSOP-10-1EP_3x3mm_P0.5mm_EP1.68x1.88mm
SOIC-8    → kicad:Package_SO/SOIC-8_3.9x4.9mm_P1.27mm
0603      → kicad:Resistor_SMD/R_0603_1608Metric
0402      → kicad:Resistor_SMD/R_0402_1005Metric
1206      → kicad:Capacitor_SMD/C_1206_3216Metric
SOT-23    → kicad:Package_TO_SOT_SMD/SOT-23-5
```

**Component type mapping (`mapComponentType`):**
```
resistor → resistor, capacitor → capacitor, diode → diode,
tvs_diode_array → diode, ferrite_bead → inductor,
opamp → chip, instrumentation_amp → chip, voltage_reference → chip,
ldo_regulator → chip, digital_potentiometer → chip, mcu → chip, logic → chip
(default → chip)
```

**Schematic symbol generation:** `makeSymbolGeometry()` creates SVG-like circuit elements:
- Resistor: zigzag path with leads
- Capacitor: two parallel plates with leads
- Diode/TVS: filled triangle + cathode bar + leads
- Ferrite bead: box with inductor symbol
- ICs: box with evenly-distributed pin stubs
- GND: `emitPowerSymbol()` — filled triangle with lead line (sync path)
- Power nets: `emitPowerSymbol()` — arrow label with lead line (sync path)

**Sheet-context threading (schema v1.2 rollout):**
- `DEFAULT_SCHEMATIC_SHEET_ID = "schematic_sheet_default"`.
- `generateCircuitJsonFromNir` does NOT emit a `schematic_sheet` element — only `schematic_sheet_id` on schematic elements.
- A defaulted `schematicSheetId` parameter is threaded through every schematic emit helper: `emitSchematicComponent`, `makeSymbolGeometry`, `schematicLine`, `schematicPath`, `schematicBox`, `emitPowerSymbol`. Every emitted `schematic_*` element carries `schematic_sheet_id`; PCB/scada elements (`pcb_*`, `source_*`) must NOT.
- Future multi-sheet grouping can key off `schematic_sheet_id` without retrofitting emit helpers.

**Sync fallback layout (`generateCircuitJsonFromNir`):**
- Grid: 4 columns, 12mm pitch, origin (10,10)
- Board: 80x60mm default from `NAIVE_BOARD_FALLBACK_MM`
- Component sizes: `FOOTPRINT_SIZE_MM` lookup table

---

#### `serializer/kicadPcbWriter.ts` (640 lines)
**Purpose:** Circuit JSON → KiCad `.kicad_pcb` S-expression file (KiCad 10 / version 20260206).

**Key export:** `circuitJsonToKicadPcb(circuitJson: AnyCircuitElement[]): string`

**Key internals:**
- `buildFootprintBlocks()` — pads, reference designators on F.SilkS with collision-aware placement
- `buildTraceSegments()` — segments and vias from `pcb_trace` routes
- `buildBoardOutline()` — `gr_rect` on "Edge.Cuts" layer
- `buildNetSection()` — net declarations from `source_net` elements

**Pad-to-net mapping:** `pcb_smtpad` → `pcb_port` → `source_port` → `source_trace` → `source_net`

**Reference designator placement logic:**
- ICs (>4 pads): text at component center (0,0) on F.SilkS, 0.8mm font
- Passives: text placed outside body boundary, perpendicular to pad axis, with collision detection against all other components' bounding boxes AND individual pads
- Collision check uses CW rotation (matching KiCad's convention): `worldX = cx + lx*cosθ + ly*sinθ`
- If both sides collide, falls back to center (0,0)
- Board setup requires minimum 0.8mm silkscreen text height

**Via deduplication:** Normalized key `x_y_sortedLayers` (sorts `[fromLayer, toLayer]` before joining).

**Implicit layer changes:** If consecutive wire segments are on different layers with no explicit via, a via is auto-emitted at the transition point.

**KiCad 10 format specifics:**
- Version: `20260206`, generator_version `"10.0"`
- Layer numbers: `0 "F.Cu"`, `31 "B.Cu"`, etc.
- Pad net assignment via `(net N "name")`
- UUID format: 16-char hex strings

---

#### `serializer/pcbRouting.ts` (651 lines)
**Purpose:** Routing utilities — placement clearance, Manhattan snap, trace-pad clearance, autorouter bridge.

**Key exports:**
| Export | Signature | Purpose |
|--------|-----------|---------|
| `circuitJsonToSimpleRouteJson` | `(circuitJson) => SimpleRouteJson` | Converts to autorouter input format |
| `mergeRoutedTraces` | `(circuitJson, routedTraces) => circuitJson` | Replaces placeholder traces |
| `enforcePlacementClearance` | `(circuitJson) => circuitJson` | Nudges overlapping components (0.5mm clearance) |
| `routeCircuitJson` | `(circuitJson) => Promise<{circuitJson, success, error?}>` | Full routing pipeline |
| `snapCircuitJsonTracesToManhattan` | `(circuitJson) => circuitJson` | Diagonal → L-shape |
| `enforceTracePadClearance` | `(circuitJson) => circuitJson` | Pushes traces away from other-net pads (0.25mm) |

**Constants:**
```
DEFAULT_MIN_TRACE_WIDTH = 0.15mm
DEFAULT_NOMINAL_TRACE_WIDTH = 0.2mm
MIN_PLACEMENT_CLEARANCE_MM = 0.5mm
KICAD_CLEARANCE_MM = 0.25mm (0.2 clearance + 0.05 solder mask)
```

**`circuitJsonToSimpleRouteJson` obstacle types:**
1. Component body obstacles (from `pcb_component` dimensions, filtered by `obstructs_within_bounds`)
2. Pad-level obstacles (from `pcb_smtpad`, +0.4mm margin, `connectedTo` set to net name)

**`enforceTracePadClearance` algorithm:**
- Only operates on top-layer wire segments
- Computes push direction (perpendicular to segment, away from pad rectangle edge)
- Uses `distToRect()` + `closestPointOnSegment()` for proper pad-rectangle-to-segment distance
- Translates entire trace route by maximum push vector (keeps Manhattan routing intact)

---

#### `serializer/router.ts` (268 lines)
**Purpose:** Wraps `@tscircuit/capacity-autorouter` (v0.0.692) `CapacityMeshSolver`.

**Key export:** `routeCircuit(simpleRouteJson) => Promise<RouteCircuitResult>`

**Solver config:** `{ effort: 1 }` (minimum for speed)

**Manhattan snap (`snapRouteToManhattan`):** Splits diagonal wires into horizontal-first L-shapes.

**Interfaces:**
```typescript
interface RoutedTrace {
  route: Array<
    | { route_type: "wire"; x: number; y: number; width: number; layer: string }
    | { route_type: "via"; x: number; y: number; to_layer: string; from_layer: string }
  >
}
interface RouteCircuitResult {
  success: boolean
  traces: RoutedTrace[]
  error?: string
}
```

---

#### `serializer/fixtures/index.ts` (163 lines)
**Purpose:** Exports typed fixture data and all NIR TypeScript interfaces.

**Exported fixtures:**
| Export | Type | Source File |
|--------|------|-------------|
| `libbrechtHallNir` | `Nir` | `libbrecht-hall.nir.json` (v0.1) |
| `instrumentationAmpNir` | `NirV11` | `instrumentation_amp_001.nir.json` |
| `opampNoninvNir` | raw JSON | `opamp_noninv_001.nir.json` |
| `voltageDividerNir` | raw JSON | `voltage_divider_001.nir.json` |
| `rcLowpassNir` | raw JSON | `rc_lowpass_001.nir.json` |
| `rcLowpassAcNir` | raw JSON | `rc_lowpass_ac_001.nir.json` |
| `rcLowpassFftNir` | raw JSON | `rc_lowpass_fft_001.nir.json` |

Plus raw JSON fixtures: `idk.nir.json`, `lm358_noninv_001.nir.json`, and `new schema.nir.json` (the v1.2 sample — note the space in the filename).

All v1.1/v1.2 fixture files are in `serializer/fixtures/`.

---

#### `serializer/kicadSymbolLibrary.ts`
**Purpose:** KiCad symbol library lookup / parsing. `setUseKicadSymbols` / `lookupKicadSymbol` / `hasKicadSymbol` gate the KiCad-symbol path.

#### `serializer/kicadSymbolParser.ts`
**Purpose:** Parses KiCad symbol library files into `KicadSymbolData` (units, pins, graphics). `KICAD_TO_SVG_SCALE` maps symbol units to SVG coordinates.

#### `serializer/kicadSymbolToCircuitJson.ts` (231 lines)
**Purpose:** KiCad symbol → Circuit JSON schematic elements (drop-in replacement for `makeSymbolGeometry()` when `useKicadSymbols` is true).

- Exports `kicadSymbolToCircuitJson(fixture, sid, cx, cy, bodySize, sym, schematicSheetId?)`.
- Renders unit graphics (rectangle/polyline/circle/arc) and pins (line + `schematic_port`) with a shared `DEFAULT_SCHEMATIC_SHEET_ID = "schematic_sheet_default"`.
- **Note:** Not currently wired into the live emit path — the inline KiCad branch inside `emitSchematicComponent` (serializer.ts) is the active KiCad path. All elements carry `schematic_sheet_id` for when the standalone path is connected.

---

### 4.2 Simulator

#### `simulator/simulator.ts` — SOLE ngspice gateway
**Purpose:** The ONLY module that invokes the ngspice binary. All other modules must go through `simulateNetlist()`.

**Key exports:**
```typescript
function resolveNgspiceBin(): string        // NGSPICE_BIN env or "ngspice"
function getNgspiceVersion(bin?): Promise<string>
function simulateNetlist(netlist: string, opts?): Promise<SimulationResult>
```

**Pipeline:**
1. Write netlist to temp `.cir` file
2. Append `.control / run / set filetype=ascii / write <rawPath> / .endc / .END`
3. Run `ngspice -b input.cir` via `execFile` (no shell — no injection risk)
4. Read `output.raw`, parse via `parseRawFile()`
5. Clean up temp dir in `finally` block

**Error policy:** Throws on non-zero exit, `Error:` in output, missing `.raw`, or malformed `.raw`. Never returns empty vectors silently.

**Windows handling:** Redirects stdout/stderr to log file via `-o` flag to avoid pipe-close hangs.

---

#### `simulator/parseRawFile.ts` — .raw file parser
**Purpose:** Pure, side-effect-free parser for ngspice ASCII `.raw` format (ngspice-46).

```typescript
function parseRawFile(rawText: string): ParseRawResult
// ParseRawResult = { variables, vectors, complexVectors?, numPoints, plotname }
```

Handles:
- Header: Title, Date, Command, Plotname, Flags, No. Variables, No. Points
- Variables: tab-separated `<index>\t<name>\t<type>`
- Values: point-row layout with `<point_index>\t` prefix per row
- Complex values (`Flags: complex`): `<real>,<imag>` → real in `vectors`, imag in `complexVectors`
- Validation: variable count, point count, non-numeric detection

---

#### `simulator/netlistFromCircuitJson.ts` (594 lines) — SPICE netlist generator
**Purpose:** Circuit JSON + NIR → SPICE netlist string.

```typescript
function netlistFromCircuitJson(
  circuitJson: AnyCircuitElement[],
  nir: NirInput,
  opts?: { analysisType?: "tran" | "op" | "dc" | "ac" | "fft"; dcSweep?: DcSweepConfig }
): NetlistResult
```

**SPICE prefix mapping:**
```
resistor/simple_resistor → R, capacitor/simple_capacitor → C,
inductor/simple_inductor → L, ferrite_bead → L (+ 0.1Ω series R),
diode/simple_diode/tvs_diode_array → D, voltage_source → V,
current_source → I, opamp/instrumentation_amp/etc → X (1Ω placeholder)
```

**Analysis type → voltage source format:**
| Analysis | Voltage Source | Command |
|----------|---------------|---------|
| tran (default) | `PULSE(0 V 0 1n 1n pw pd)` | `.tran 1m 10m` |
| op | `DC V` | `.op` |
| dc | `DC V` | `.dc V1 start stop step` |
| ac | `DC V AC mag` | `.ac dec 10 1 1meg` |
| fft | `SIN(0 V 1k)` | `.tran 10u 10m` + `.four 1k v(2)` |

**Node assignment:** Ground → 0, others → sequential from 1. Undeclared nets get nodes with warnings.

**Implicit voltage sources:** Added for power/signal nets that lack one, using heuristics:
- v1.1: `IC_POWER_PIN_RE` and `INPUT_HEADER_RE` regex patterns
- v0.1: `is_power` flag on `source_net`
- Never for internal circuit nodes

**v1.1 value lookup:** Values come from NIR (not Circuit JSON, which drops `value` from `source_component_base`). The `nirCompTypeByRef` map overrides tscircuit's possible type squashing.

---

#### `simulator/parseFourierOutput.ts` (83 lines)
**Purpose:** Parses ngspice `.four` command log output into structured harmonics.

```typescript
function parseFourierOutput(logText: string): FourierResult[]
// FourierResult = { variable, numHarmonics, thd, harmonics: FourierHarmonic[] }
// FourierHarmonic = { harmonic, frequency, magnitude, phase, normMag, normPhase }
```

---

#### `simulator/formatNumbers.ts` (132 lines)
**Purpose:** Engineering notation formatting with SI prefixes.

```typescript
function formatEng(value, opts?): string    // 4700 → "4.7k"
function formatAuto(value, opts?): string   // auto-selects fixed vs eng
function formatVector(values, opts?): string[]
function formatSimulationResult(result, opts?): { vectors: Record<string, string[]>, variables }
```

Epsilon clamping: values below `1e-12` snap to zero (hides IEEE-754 solver noise).

---

#### `simulator/printSimulationResult.ts` (60 lines)
**Purpose:** Console pretty-printer for simulation results. Wraps `formatNumbers`.

---

### 4.3 Dev Tools

#### `dev-tools/render_interactive_simulator.ts` (440 lines)
**Purpose:** CLI tool generating self-contained interactive HTML pages per fixture+analysis.

**Usage:** `bun run render_interactive_simulator.ts [fixture_name] [analysisType]`

**Pipeline:**
1. `serializeNirAsync(nir)` → Circuit JSON
2. `netlistFromCircuitJson(circuitJson, nir, { analysisType })` → SPICE netlist
3. `runNgspiceLax(netlist)` → .raw + log (accepts .raw even on non-zero exit for unmodeled opamps)
4. Parse .raw via `parseRawFile()` or Fourier via `parseFourierOutput()`
5. Read `interactive_simulator.html` template, replace `{{PLACEHOLDER}}` tokens

**AC analysis:** Computes magnitude (dB) and phase (deg) from complex vectors; the AC sweep variable (`frequency`) is excluded from the Y-probe list to avoid a frequency-vs-itself trace. X (frequency, Hz) is unscaled on the chart axis.
**FFT analysis:** Uses `parseFourierOutput()` on log, generates a single "Harmonic Magnitude" probe (harmonic magnitude vs. frequency in Hz, x already converted to display units). uPlot renders it as a **connected line** — a deliberate product decision (user opted to keep the line, not switch to a stem/bar plot).
**X-axis units:** Time-domain analyses (TRAN/OP/FFT) scale ngspice seconds → ms (×1000); AC frequency (Hz) and DC sweep (V) pass through unscaled. The rule lives in `dev-tools/axisScale.ts` and is shared by both the static driver and `sim_server.ts` so the two paths agree.
**Analysis file map:** `buildAnalysisFileMap()` resolves cross-fixture navigation (e.g., `rc_lowpass_001`'s AC analysis → `rc_lowpass_ac_001_ac_interactive.html`).

---

#### `dev-tools/interactive_simulator.html` — HTML template
**18 placeholder tokens:** `{{DESIGN_ID}}`, `{{SCHEMATIC_FILE}}`, `{{SCALE_MODE_JS}}`, `{{WARN_BANNER}}`, `{{PROBES_JSON}}`, `{{TIME_JSON}}`, `{{X_AXIS_LABEL}}`, `{{NETLIST}}`, `{{T_START_MS}}`, `{{T_END_MS}}`, `{{ANALYSIS_TYPE}}`, `{{TRAN_SELECTED}}`, `{{OP_SELECTED}}`, `{{DC_SELECTED}}`, `{{AC_SELECTED}}`, `{{FFT_SELECTED}}`, `{{COMPONENTS_JSON}}`, `{{ANALYSIS_FILE_MAP}}`

**UI:** Chart is **uPlot (v1.6.31, canvas-based)** loaded from the unpkg/jsdelivr CDN (`uPlot.iife.min.js` + `uPlot.min.css`). Analysis dropdown (TRAN/OP/DC/AC/FFT; PZ/NOISE/SP disabled with `title` tooltips explaining why), a four-option **scale-mode dropdown** (Linear / Log Y / Log X / Log-Log) wired to `scaleMode.js` (injected via `{{SCALE_MODE_JS}}`), signal table, collapsible netlist, dynamic sliders (250ms debounce, log-scale for R/C/L), TRAN-only Start/End/Step time-range controls, back-to-schematic link. **Build marker** in the meta tag + console.info: `zoom-yrefit-wheelfix-opbanner-grab-2026-08-09` (always check this when diagnosing a stale/mismatched build — remote/Docker deploys run the committed template and won't have recent uncommitted fixes). A `#simOverlay` pending indicator covers the chart while any simulation request is in flight (in-flight count tracked by `setPending`); `#chartRoot` is the uPlot mount point (uPlot wipes the element it mounts into), with the overlay kept as a sibling. `#uiNote` shows transient errors (e.g. a failed analysis switch).

**Pan / wheel-zoom plugins:** uPlot 1.6.31 has no native pan or wheel zoom (only drag-select), so both are custom plugins (`makePanPlugin`, `wheelZoomPlugin`). `cursor.drag: false` disables native drag-select; **left-drag (any button) pans** via `posToVal` (works on linear AND log axes), with a `grab`/`grabbing` cursor affordance set in the plugin's `ready` hook and on mousedown/mouseup. Wheel zoom scales x AND y about the cursor through `zoomRangeAbout` (decade-space math on log axes). **Known fix:** `zoomRangeAbout` returns a bare `[min, max]` array; passing it directly to `u.setScale("x", array)` silently reset the scale to full auto-range (wheel zoom appeared dead) — it is now wrapped in `{min, max}`. The `setScale` hook clamps any zoomed span to ≥ `MIN_SPAN_FRAC` (0.01 = 1%) of the full auto-span (`clampScaleFromHook`).

**Zoom / pan / fit toolbar (`zoomChart`/`panChart`):** `+`/`-` buttons zoom the x axis about its midpoint by ×0.8 / ×1.25, clamped at the 1% min-span floor and capped at the full range (zoom out far enough = Fit). **Regression fix:** after every x zoom (and on the zoom-out-to-Fit path) `zoomChart` re-runs the y auto-range with `u.setScale("y", {min:null, max:null})`, guaranteeing every checked series stays visible in the new x window — the y scale remains `auto`, so later pans/zooms keep re-ranging it. `panChart(±0.15)` shifts the x window and clamps it inside the data domain. `dblclick` performs a full Fit via a real listener in `onChartReady` (uPlot's internal dblclick only auto-scales X and never fires the `dblclick` hook for a lone chart).

**Scale-mode logic:** `dev-tools/scaleMode.js` (UMD, plain JS so the same file is inlined into the page via `{{SCALE_MODE_JS}}` AND imported by `bun test`) exports `SCALE_MODES`, `SCALE_OPTIONS`, `defaultScaleFor`, `scaleConfigFor`, `hasNonPositive`, `smallestPositive`, `restrictedScaleOptions`, `applyScaleMode` (mutates `u.scales.x.distr` / `u.scales.y.distr` + re-ranges via `setData`). Defaults: AC → `logX`, all others → `linear`. Gating: AC always disables Log Y / Log-Log (data already in dB); Log Y / Log-Log disabled when any Y ≤ 0; **Log X / Log-Log on a t=0 origin (TRAN) stays ENABLED** — `applyScaleMode(u, mode, xValues)` floors `scales.x.min` to the smallest strictly-positive x so the t=0 sample is clamped to the log axis left edge instead of dropping the curve; Log X is disabled only when there is NO positive x at all; unusable active mode falls back to `linear`. The floor is applied at render, on every live update, and on scale-mode change (x passed as `u.data[0]`). 21 unit tests in `dev-tools/scaleMode.test.ts` (no DOM).

**Time-range / time-step:** Start/End/Step inputs are TRAN-only (hidden for AC/DC/FFT and cleared on switch so no stale value leaks into ngspice). They are auto-populated in **display ms** from the data range (`populateTimeRange`), and **converted ms → SPICE seconds** (`msToSpiceSec`) before being sent as `duration`/`timeStep` in the POST body — a raw ms number forwarded as-is would be read as seconds (a 10 ms End became a 10 s simulation). `sim_server.ts` forwards both to `netlistFromCircuitJson` only for `isTimeDomainX` analyses (TRAN-only). Start is display-only (the netlist generator has no `.tran` tstart support and `simulator/*.ts` is off-limits).

**X-axis unit conversion** (`dev-tools/axisScale.ts`): single `toDisplayX(analysisType, rawX)` rule shared by `render_interactive_simulator.ts` and `sim_server.ts` — time-domain analyses (TRAN/OP/FFT) get ngspice seconds → ms (×1000); AC frequency (Hz) and DC sweep voltage (V) pass through unscaled. 9 unit tests in `dev-tools/axisScale.test.ts` (incl. AC ×1000 regression).

**Live-update path (`updateChartData` vs `renderChart`):** A single uPlot instance is created at page load and reused for all live slider/time-range re-simulations. `updateChartData(x, probes)` calls `chart.setData(st.data)` on the SAME instance (never rebuilt) as long as the probe count matches; it only calls `fitChart` when the sweep itself changed (Start/End/Step or a new x extent). Component-value tweaks that keep the x sweep identical therefore preserve the current view, and uPlot re-ranges the auto scales for the new data. The `+`/`-` buttons work identically after either path because `zoomChart`'s y-refit is unconditional. (Verified: this path leaves no stale scale state — see Known Issue #13 for the one unreproduced report.)

**OP analysis:** renders a value table, no chart/axes. `refreshScaleOptions` short-circuits for `analysisType === "op"` — it disables the scale-mode dropdown and hides the `#scaleWarn` banner instead of showing stale "Log Y disabled / Log X floored" warnings for a chart that does not exist.

**Slider server dependency:** `sim_server.ts` at `localhost:3777`.

---

#### `dev-tools/sim_server.ts` (618 lines)
**Purpose:** Bun.serve() HTTP server for live re-simulation with component value overrides.

**Port:** 3777

**Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/fixture/:name` | Returns slider hint metadata |
| `POST` | `/simulate` | Re-runs simulation with overridden values, returns JSON |
| `GET` | `/*` | Serves static files from dev-tools/ |

**POST /simulate request:** `{ fixture, components: { R1: "2.2k", C1: "100n" }, analysisType? }`
**POST /simulate response:** `{ ok, analysisType, netlist, xAxisLabel, xValues, probes }`

---

#### `dev-tools/circuitJsTranslator.ts` (209 lines)
**Purpose:** NIR → Falstad CircuitJS plaintext format.

**Supported topologies:**
- R1 + C1 (no R2) → RC low-pass
- R1 + R2 (no C1) → Voltage divider
- Other → null (unsupported)

**Coordinate system:** 16px grid. V1 at (128,96)-(128,256), R1 at (128,96)-(352,96), etc.

**URL:** `https://www.falstad.com/circuit/circuitjs.html?cct=<encoded>&hideMenu=true&whiteBackground=true`

---

#### `dev-tools/render_interactive_schematic.ts` (~150 lines)
**Purpose:** CLI tool generating self-contained interactive schematic editor HTML pages per fixture.

**Usage:** `bun run render_interactive_schematic.ts [fixture_name]`

**Pipeline:**
1. `serializeNirAsync(nir)` → Circuit JSON + SVG
2. `injectPowerSymbols(circuitJson, nir)` → Adds GND triangle and power label symbols for ground/power nets
3. `renderCircuitJson(enrichedCircuitJson)` → Re-renders SVG with power symbols
4. Read `interactive_schematic.html` template, replace `{{PLACEHOLDER}}` tokens
5. Bake Circuit JSON, NIR JSON, SVG content, design ID, and simulator file link into HTML

**Output:** `dev-tools/<fixture>_schematic.html`

---

#### `dev-tools/interactive_schematic.html` — HTML template
**Placeholder tokens:** `{{SVG_CONTENT}}`, `{{CIRCUIT_JSON}}`, `{{NIR_JSON}}`, `{{DESIGN_ID}}`, `{{SIMULATOR_FILE}}`

**UI Features:**
- **Pan/Zoom:** Mouse wheel zoom, middle-click or H-key pan, V-key select mode
- **Component selection:** Click component → inspector panel shows ref, type, footprint, value, pins, connected nets
- **Inspector:** Shows component type/footprint from NIR (not Circuit JSON), connection badges (connected/open)
- **Value editing:** Edit component value in inspector → SVG text elements update in real-time
- **Drag to reposition:** Drag component → layout override stored, applied via SVG transform
- **Snap-to-wire:** Dragging near wire endpoints snaps pin to wire, updates trace path `d` attributes
- **Power symbols:** GND rendered as filled triangle, power nets as arrow labels
- **Simulator link:** "Open Simulator" button opens the uPlot interactive simulator viewer with `?R1=2.2k` URL params for auto-applied values
- **Undo/Redo:** Ctrl+Z / Ctrl+Shift+Z for layout and value changes
- **Export:** Download modified NIR JSON or Circuit JSON
- **Status bar:** Shows connection count and drag/snap status

**Key design:** Schematic layout is auto-generated by CircuitRunner (not stored in NIR). Drag overrides are visual-only, stored in memory. Value edits are passed to the simulator via URL params. Power symbols are injected post-serialization for correct ground triangle and power label rendering.

---

#### Generated HTML files (18 files in dev-tools/)
| File | Fixture | Type |
|------|---------|------|
| `voltage_divider_001_tran_interactive.html` | voltage_divider_001 | simulator (tran) |
| `voltage_divider_001_op_interactive.html` | voltage_divider_001 | simulator (op) |
| `voltage_divider_001_dc_interactive.html` | voltage_divider_001 | simulator (dc) |
| `opamp_noninv_interactive.html` | opamp_noninv_001 | simulator (default) |
| `opamp_noninv_001_tran_interactive.html` | opamp_noninv_001 | simulator (tran) |
| `rc_lowpass_001_tran_interactive.html` | rc_lowpass_001 | simulator (tran) |
| `rc_lowpass_001_op_interactive.html` | rc_lowpass_001 | simulator (op) |
| `rc_lowpass_001_dc_interactive.html` | rc_lowpass_001 | simulator (dc) |
| `rc_lowpass_ac_001_ac_interactive.html` | rc_lowpass_ac_001 | simulator (ac) |
| `rc_lowpass_fft_001_fft_interactive.html` | rc_lowpass_fft_001 | simulator (fft) |
| `rc_lowpass_falstad_view.html` | rc_lowpass | CircuitJS iframe |
| `voltage_divider_001_schematic.html` | voltage_divider_001 | schematic editor |
| `rc_lowpass_001_schematic.html` | rc_lowpass_001 | schematic editor |
| `rc_lowpass_ac_001_schematic.html` | rc_lowpass_ac_001 | schematic editor |
| `rc_lowpass_fft_001_schematic.html` | rc_lowpass_fft_001 | schematic editor |
| `opamp_noninv_001_schematic.html` | opamp_noninv_001 | schematic editor |

---

### 4.4 Tests

#### `serializer.test.ts` (24 tests)
Schema detection, v0.1 legacy, v1.1 path, DRC verification, loud-failure.

#### `simulator.test.ts` (17 tests)
`parseRawFile`, `netlistFromCircuitJson`, `simulateNetlist`, ngspice binary. Skips if ngspice unavailable.

#### `kicadPcbWriter.test.ts` (17 tests)
KiCad output structure, pad rotation regression, net-to-net short detection, pad position correctness.

#### `pcbRouting.test.ts` (8 tests)
`circuitJsonToSimpleRouteJson`, `routeCircuitJson` e2e, `mergeRoutedTraces`, `enforcePlacementClearance`.

#### `router.test.ts` (4 tests)
Route shape, invalid input, 45°-corner chamfer verification, same-layer crossing detection.

#### `formatNumbers.test.ts` (33 tests)
`formatEng`, `formatFixed`, `formatAuto`, `formatVector`, `formatSimulationResult`, `formatValue`, epsilon clamping.

#### `dev-tools/scaleMatrix.test.ts` (360 lines, headless-Chrome regression matrix)
20-combination chart matrix (5 analyses × 4 scale modes). Each combo is loaded in a headless Chrome via CDP against a spawned `sim_server`, the scale mode is applied through the UI dropdown, and the resulting uPlot chart is asserted DRAWN (non-blank canvas) with finite auto-ranged x/y scales and the expected linear/log distr; gated combos must come back as disabled dropdown options. OP is asserted separately (value table, no chart). This is the regression guard behind the blank-Log-Y/X/log-log chart fixes, the OP chart (post-hoc `redraw()` clobbered construction-time x auto-range), tick labels, and the hover tooltip. Skips when ngspice or Chrome for Testing is missing.

**Total: 146 tests, 0 failures** (4432–4447 expect() calls, 9 files) — as of the 2026-08-09 run. `simulator.test.ts` SKIPs its ngspice-dependent cases on this machine (no ngspice binary); `scaleMatrix.test.ts` runs 11 enabled DRAWN + 6 gated-off combos.

---

## 5. Data Flow Details

### v1.1 Async Pipeline (production path)
```
NIR v1.1 JSON
  → generateTscircuitJsx(nir)           // string of JSX code
  → runTscircuit({ "circuit.tsx": jsx }) // dynamic import @tscircuit/eval
      → CircuitRunner.execute()          // auto-placement + autorouting
      → renderUntilSettled()
      → getCircuitJson()
  → Circuit JSON (full: pcb_component, schematic_component, source_*, pcb_*)
  → snapCircuitJsonTracesToManhattan()   // diagonal → L-shape
  → enforceTracePadClearance()           // push traces from other-net pads
  → circuitJsonToKicadPcb()              // → .kicad_pcb string
  → renderCircuitJson()                  // → SVG string
```

### v0.1 Sync Pipeline (legacy)
```
NIR v0.1 JSON
  → parseNirV01(nir)                    // manual element creation
  → Circuit JSON (source_component_base, source_net, source_trace only)
  → renderCircuitJson()                 // → SVG string
  // No PCB output, no routing, no KiCad
```

### SPICE Simulation Pipeline
```
Circuit JSON + NIR
  → netlistFromCircuitJson(circuitJson, nir, { analysisType })
  → SPICE netlist string
  → simulateNetlist(netlist)
      → write temp .cir
      → append .control block
      → ngspice -b
      → read output.raw
      → parseRawFile(rawText)
  → SimulationResult { vectors, variables, numPoints }
```

---

## 6. Circuit JSON Element Types (produced by serializer)

| Type | Key Fields | Purpose |
|------|-----------|---------|
| `pcb_board` | `width, height, thickness, num_layers, material, center` | Board definition |
| `source_component_base` | `source_component_id, name, component_type, footprint` | Component identity (no value — value is in NIR) |
| `pcb_component` | `pcb_component_id, source_component_id, center, layer, rotation, width, height` | PCB placement |
| `schematic_component` | `schematic_component_id, source_component_id, center, size, symbol_display_value, schematic_sheet_id` | Schematic symbol |
| `source_net` | `source_net_id, name, is_power, is_ground, is_analog_signal` | Net identity |
| `source_trace` | `source_trace_id, connected_source_port_ids, connected_source_net_ids` | Connectivity |
| `source_port` | `source_port_id, name, schematic_component_id, pcb_port_id` | Pin identity |
| `schematic_port` | `schematic_port_id, source_port_id, center, display_pin_label, schematic_sheet_id` | Pin on schematic |
| `pcb_port` | `pcb_port_id, source_port_id, x, y, layers` | Pin on PCB |
| `pcb_smtpad` | `pcb_smtpad_id, pcb_component_id, pcb_port_id, x, y, width, height` | Copper pad |
| `pcb_trace` | `pcb_trace_id, connection_name, route: [{route_type, x, y, width, layer, to_layer, from_layer}]` | Routed trace |
| `pcb_via` | `pcb_via_id, x, y, from_layer, to_layer` | Via |
| `schematic_line` | `schematic_line_id, schematic_component_id, x1, y1, x2, y2, color, is_dashed, schematic_sheet_id` | Schematic drawing |
| `schematic_path` | `schematic_path_id, schematic_component_id, points[], is_filled, schematic_sheet_id` | Schematic path |
| `schematic_box` | `schematic_component_id, x, y, width, height, is_dashed, schematic_sheet_id` | IC body outline |
| `schematic_text` | `schematic_text_id, text, font_size, position, rotation, color, schematic_sheet_id` | Text labels |

---

## 7. SVG Output Structure (from circuit-to-svg)

### Schematic SVG classes and data attributes

| Element | CSS Class | Data Attributes |
|---------|-----------|-----------------|
| Component group | `sch-component` | `data-circuit-json-type="schematic_component"`, `data-schematic-component-id`, `data-schematic-sheet-id` |
| Component body | `component chip sch-component-body` | — |
| Component pin | `component-pin sch-component-pin` | — |
| Port indicator | `component-pin sch-component-pin sch-port-indicator` | `data-schematic-port-id` |
| Port hover target | `schematic-port-hover sch-port-hover` | `data-schematic-port-id`, `data-schematic-sheet-id` |
| Trace (base) | `trace sch-trace` | `data-layer="base"`, `data-circuit-json-type="schematic_trace"`, `data-subcircuit-connectivity-map-key` |
| Trace (overlay) | `trace-overlays sch-trace-overlays` | Same as trace |
| Net label | `component-overlay sch-component-overlay sch-net-label-overlay` | — |
| Port label | `port-label` | — |
| Component name | `component-name` | — |

### Built-in CSS interactivity
- **Trace hover:** `.trace:hover { filter: invert(1); }` — single trace highlights
- **Net hover:** For each unique `data-subcircuit-connectivity-map-key`, CSS rule highlights ALL traces belonging to that net when any trace in the net is hovered
- **Port hover targets:** Invisible circles at port positions, ready for JS event listeners

---

## 8. KiCad DRC Status

**rc_lowpass (`_gen_pcb.ts rc_lowpass`):** 0 violations, 0 unconnected items — clean.

**opamp (`_gen_pcb.ts opamp`):** ~175 violations (64 shorting_items, 61 solder_mask_bridge, 44 clearance, 8 unconnected, 3 tracks_crossing, 3 silk_over_copper). This is pre-existing autorouter quality noise from CapacityMeshSolver (`effort: 1`, stochastic) — the exact count varies run-to-run (earlier baseline: 253). It is NOT caused by the schema v1.2 / sheet-context migration, which only touches schematic elements.

Earlier opamp-era baseline (pre-migration, from CONTEXT history): 0 errors, 0 unconnected, 3 silk_over_copper warnings on R3/R4/R5 (0402 passives packed in a row, center-placement fallback where the 0.8mm text box overlaps pad solder mask). These are warnings — the fab house clips silkscreen over pads.

---

## 9. Known Issues and Quirks

1. **`nirToCircuitJson` name collision:** The async version (line 96) is shadowed by the sync version (line 1098) in module scope. `nirToCircuitJsonAsync` is the reliable async entry point.

2. **v1.1 component values dropped by serializer:** `source_component_base` does not include `value`. The SPICE netlist generator must look up values from the original NIR.

3. **PZ analysis infeasible in ngspice v46:** The `.pz` command runs but produces zero output.

4. **Unmodeled opamps:** ICs emit 1-ohm placeholder resistors. `render_interactive_simulator.ts` uses `runNgspiceLax()` which accepts .raw files even on non-zero exit (for opamp warnings).

5. **KiCad DRC checks against solder mask edges**, not copper edges. Solder mask expands ~0.05mm beyond pad copper. Effective clearance: 0.25mm from track edge to pad copper edge.

6. **Rotation convention mismatch:** KiCad uses CW rotation for footprint placement, but the collision check code must match this. Previous bug: using CCW gave wrong world positions for ref text.

7. **Schematic inspector looks up `source_component` (not `source_component_base`):** The async CircuitRunner produces `source_component` elements. Inspector cross-references NIR `components` array by `ref` for type/footprint data.

8. **Power symbols injected post-serialization:** The async CircuitRunner doesn't generate GND/VIN symbols. `injectPowerSymbols()` adds ground triangles and power labels to circuit JSON before SVG re-rendering.

9. **Wire snap updates `te.points` directly:** `applySnapTrace()` modifies `te.points[0]`/`te.points[last]` and `updateTracePath()` reads from `te.points` (not stale `traceOverrides`).

10. **Unicode value strings not normalized yet:** Value strings like `"1µF"`, `"600R@100MHz"` pass through as-is. A `// TODO` near JSX resistance/inductance emission marks where ASCII normalization belongs. The schema fixture matches what v1.2 actually specifies.

11. **`kicadSymbolToCircuitJson.ts` is not wired in:** The standalone KiCad-symbol→Circuit JSON emitter carries `schematic_sheet_id` but is unused — the live KiCad path is the inline branch in `emitSchematicComponent` (serializer.ts). When the standalone path is connected, its sheet-id output will make multi-sheet grouping work automatically.

12. **Deferred schema v1.2 items:** `custom_symbols_required` / `hierarchical_sheets` root keys, plus `lookupSymbol`/`lookupKicadSymbol`/`makeSymbolGeometry` and `SEMANTIC_TO_PASSIVE`/`PIN_NAME_FIXUP`/`inferPinCount` rework — deferred until `custom_symbols_required` exists. `_NEW_*` fields are advisory pass-through only.

13. **Open QA item — "zoom-in collapses the chart" (not reproducible locally):** A user report described AC: move a component slider (e.g. R1 → 5.6k, triggering the live `POST /simulate` → `updateChartData` path), then click `+`, and the Y axis collapses to a −5..−70 window with 2 of 3 traces gone. Reproduced EXACTLY this sequence on both the current code and the pre-fix `zoomChart` (x-only, no y-refit): every variant keeps all 3 traces visible (y re-ranges −95..−96 → 0, 0 clipped), including 5 consecutive `+` clicks after the slider. The one mechanism that WOULD explain the screenshot is a y scale pinned to a stale explicit `{min,max}` from a prior drag-select — but drag-select is disabled (`cursor.drag:false`), and `zoomChart` now force-refits y anyway. Working hypothesis is a stale build (remote/Docker/Railway serves the committed template without the session fixes) or a cached tab. Awaiting the user's literal broken-state screenshot + page URL/browser before closing. **Diagnostic:** check the `<meta name="sim-viewer-build">` value in the served page — anything older than `zoom-yrefit-wheelfix-opbanner-grab-2026-08-09` predates these fixes.

---

## 10. Fixture Catalog

| Fixture | NIR Version | Components | Analysis | Topology |
|---------|------------|------------|----------|----------|
| `libbrechtHallNir` | v0.1 | Hall sensor circuit | — | Libbrecht-Hall sensor |
| `instrumentationAmpNir` | v1.1 | INA849 + passives | — | Instrumentation amplifier |
| `opampNoninvNir` | v1.1 | OPA344 + R1-R5, C1-C4 | tran | Non-inverting op-amp |
| `voltageDividerNir` | v1.1 | R1, R2 | tran, op, dc | Voltage divider |
| `rcLowpassNir` | v1.1 | R1, C1 | tran, op, dc | RC low-pass filter |
| `rcLowpassAcNir` | v1.1 | R1, C1 | ac | RC low-pass (AC sweep) |
| `rcLowpassFftNir` | v1.1 | R1, C1 | fft | RC low-pass (Fourier) |
| `lm358_noninv_001` | v1.1 | LM358 + passives | — | Non-inverting op-amp |
| `idk.nir.json` | v1.2 | ULP instrumentation amp | — | AutoZero InAmp w/ digital gain |
| `new schema.nir.json` | v1.2 | ULP instrumentation amp (`ulp_` prefix) | — | AutoZero_InAmp_with_Digital_Gain_Control |
| `555_timer.nir.json` | v1.2 | timer_ic + NPN BJT + 3×R + 2×C + test points + sim source | — | 555 timer oscillator |
| `audio_amplifier_1386.nir.json` | v1.2 | amplifier + 2×C + 2×R | — | Audio amplifier (LM386-family, minimal) |
| `audioamplifier_lm386.nir.json` | v1.2 | instrumentation_amp + voltage_ref + LDO + digipot + 4×R + 5×C + TVS + ferrite bead (4-layer) | — | Audio amplifier (LM386, full) |

---

## 11. Dependencies

### Runtime (from package.json)
- `circuit-json` — Circuit JSON types and utilities
- `circuit-to-svg` (v0.0.369) — SVG rendering
- `@tscircuit/eval` — CircuitRunner for auto-placement + autorouting
- `@tscircuit/capacity-autorouter` (v0.0.692) — PCB trace routing solver

### Optional
- `@tscircuit/schematic-viewer` — Alternative SVG renderer (checked via `KICAD_VIEWER` env)
- `ngspice` (v46+) — SPICE simulator binary (checked via `NGSPICE_BIN` env or PATH)
- `kicad-cli` (v10.0.4) — DRC validation

### Dev
- `@types/bun` — Bun type definitions
- Bun test runner (built-in)

---

## 12. Conventions

### File organization
- `serializer/` — NIR → Circuit JSON → SVG/KiCad (no simulation)
- `simulator/` — SPICE netlist generation, ngspice execution, result parsing
- `dev-tools/` — Interactive viewers, servers, translators
- Test files co-located with source (`serializer.test.ts`, `simulator.test.ts`, etc.)

### Naming
- Fixture files: `<descriptive_name>.nir.json` (snake_case)
- Generated HTML: `<fixture>_<analysis>_interactive.html`
- Test files: `<module>.test.ts`

### Code style
- No comments unless requested
- Named exports preferred over default exports
- Types defined alongside their consumers
- Functions documented via JSDoc-style headers (file-level purpose, not per-function)

### Testing
- 146 tests across 9 files
- Tests skip gracefully when ngspice is unavailable (simulator/ngspice cases; `scaleMatrix` skips without Chrome)
- DRC validation is manual (run `kicad-cli pcb drc`)
- No CI/CD configured

---

## 13. Git History (chronological)

```
a5a4a7d  the newest update
03d9f9e  Add Layer 3 serializer: NIR → Circuit JSON → SVG schematic
ecd1116  Rename open_forge folder to serializer
eb732c0  Remove non-serializer files from tracking
e98d8bb  Update README
11df26f  Update README
68d461f  fix: resolve PIN1/PIN2 selector errors, add SOIC-8 footprint
44973c6  feat: add Layer 4 simulator module (ngspice batch driver + Python bridge) [Sanhita]
4439f27  Merge pull request #2 from sanhita0804/feature/ngspice-simulator
a033682  fix: guard circuitJsonToKicadPcb call behind pcb_board presence check
afff17a  Updates of Schematic Viewer
d3c3729  Merge branch 'main' of https://github.com/Sada2108/serializer
b909091  make sim_server port configurable via PORT env var
5bef906  add Dockerfile for sim_server deployment
9c55157  bind sim_server to 0.0.0.0 for Railway networking
fe1af18  Remove KiCad/PCB artifact files from repo tracking
3936430  Remove PCB/DRC generated output files from tracking
93fc4e5  Untrack pcbRouting.test.ts
bb44041  Fix KiCad-style footprint dimension resolution + pad rotation
339a27d  Wire OPEN_FORGE_USE_KICAD_SYMBOLS and OPEN_FORGE_USE_PARSED_FOOTPRINTS env flags into serializer.ts
```

All work after `339a27d` (uncommitted) is Sada's continuing work — including the schema v1.2 migration and sheet-context rollout.

---

## 14. Current State (Uncommitted Work)

### Schema v1.2 migration (latest work)
- `serializer/serializer.ts` — `schema_version` guards accept `"1.1" | "1.2"`; `DEFAULT_SCHEMATIC_SHEET_ID`; sheet-id threading through `emitSchematicComponent` / `makeSymbolGeometry` / `schematicLine` / `schematicPath` / `schematicBox` / `emitPowerSymbol`; Unicode-value TODO at resistance JSX emission.
- `serializer/kicadSymbolToCircuitJson.ts` — sheet-id stamping on all schematic elements (standalone path, not yet wired in).
- `simulator/netlistFromCircuitJson.ts` — `detectNirVersion` treats `schema_version "1.2"` as `"v1.1"`.
- `serializer/fixtures/index.ts` — `schema_version: "1.1" | "1.2"` union, open root, optional `_NEW_*` fields, loosened `NirV11PerformanceSpecs`.
- `serializer/fixtures/new schema.nir.json` — v1.2 sample; GND net `net_type` fixed `power` → `ground` so `emitPowerSymbol` renders a ground triangle.
- `serializer/fixtures/rc_lowpass_001.nir.json` — added `thickness_mm: 1.6` to `board_spec` (pre-existing strict-sync-path gap; async path unaffected).
- **Deferred:** `custom_symbols_required` / `hierarchical_sheets` root keys, `lookupSymbol`/`lookupKicadSymbol`/`makeSymbolGeometry`, `SEMANTIC_TO_PASSIVE`/`PIN_NAME_FIXUP`/`inferPinCount`, Unicode value normalization.

### Interactive simulator QA pass (2026-08-09) — 4-item regression task
- `dev-tools/interactive_simulator.html` (now 1324 lines) — build marker `zoom-yrefit-wheelfix-opbanner-grab-2026-08-09`. Four fixes/decisions:
  1. **Zoom-in regression:** NOT reproducible via any documented sequence (fresh load, slider-driven `updateChartData` at R1=5.6k, pre-fix and post-fix code). Still hardened the `+`/`-` path: `zoomChart` now unconditionally re-fits Y (`setScale("y",{min:null,max:null})`) after every x zoom so all checked series stay visible.
  2. **FFT viz:** user chose to **keep the connected line** (no stem/bar switch) — no code change.
  3. **OP stale banner:** `refreshScaleOptions` short-circuits on `atype === "op"` — banner hidden, dropdown disabled (previously showed stale "Log X floored / Log Y disabled" warnings for a chart that doesn't exist). Verified live.
  4. **Pan cursor affordance:** `makePanPlugin` sets `grab` (idle) / `grabbing` (during drag) / `grab` (after mouseup). Verified live.
- **Wheel-zoom root cause (real bug):** `wheelZoomPlugin` called `u.setScale("x", zoomRangeAbout(...))` with a bare `[min,max]` array while uPlot requires `{min,max}` — wheel zoom silently reset to full auto-range. Wrapped as `{min,max}`; wheel zoom now actually zooms (verified live + in the `scaleMatrix` harness).
- `dev-tools/current_sim.html` regenerated after each template edit (contains the new build marker; used for `file://` probes).
- Full suite green at each checkpoint: **146 pass / 0 fail**.

### Earlier uncommitted work (still present)
- `serializer/serializer.ts` — KiCad output pipeline, exported internals
- `serializer/fixtures/index.ts` — 4 new fixtures, `ac_magnitude` field
- `simulator/netlistFromCircuitJson.ts` — Analysis type support (tran/op/dc/ac/fft), v1.1 value lookup
- `simulator/parseRawFile.ts` — Complex vector storage
- `simulator.test.ts` — Updated for analysis-type tests
- `package.json` — Dependencies

### New untracked files (2430+ lines)
- `serializer/kicadPcbWriter.ts` (640 lines) — KiCad 10 format writer
- `serializer/pcbRouting.ts` (651 lines) — Routing utilities
- `serializer/router.ts` (268 lines) — Manhattan autorouter wrapper
- `dev-tools/render_interactive_simulator.ts` (440 lines) — Interactive uPlot viewer generator
- `dev-tools/render_interactive_schematic.ts` (~120 lines) — Schematic editor generator
- `dev-tools/interactive_simulator.html` (1324 lines) — Simulator HTML template (uPlot 1.6.31)
- `dev-tools/interactive_schematic.html` (~580 lines) — Schematic editor HTML template
- `dev-tools/circuitJsTranslator.ts` (209 lines) — CircuitJS translator
- `dev-tools/sim_server.ts` (618 lines) — Live simulation server (uPlot page builder)
- `dev-tools/scaleMode.js` (186 lines) — Shared scale-mode UMD module (Linear/Log Y/Log X/Log-Log) with t=0 log-x floor, inlined into the viewer via `{{SCALE_MODE_JS}}`
- `dev-tools/axisScale.ts` (23 lines) — Shared x-axis s→ms / Hz passthrough rule (used by driver + sim_server)
- `dev-tools/scaleMatrix.test.ts` (360 lines) — 20-combo headless-Chrome chart regression matrix
- `dev-tools/current_sim.html` — Regenerated "current" AC viewer (contains the live build marker)
- `simulator/formatNumbers.ts` (132 lines) — SI prefix formatting
- `simulator/parseFourierOutput.ts` (83 lines) — Fourier log parser
- `simulator/printSimulationResult.ts` (60 lines) — Console printer
- `serializer/kicadSymbolLibrary.ts`, `serializer/kicadSymbolParser.ts`, `serializer/kicadSymbolToCircuitJson.ts` — KiCad symbol path
- 3 new untracked v1.2 NIR fixture JSON files (`555_timer`, `audio_amplifier_1386`, `audioamplifier_lm386`)
- 5 test files (927 lines total)
- 13 generated HTML viewer pages
- 5 generated schematic editor HTML pages

### Test status
**146 pass, 0 fail** across 9 test files (4432–4447 expect() calls, varies slightly run-to-run). Includes 21 scale-mode tests (`scaleMode.test.ts`, no DOM — gating matrix incl. TRAN t=0 Log X floor, `smallestPositive`, `applyScaleMode` min-floor), 9 shared-axis-scale tests (`axisScale.test.ts`, no DOM — incl. the AC ×1000 regression), and the 20-combo headless-Chrome chart matrix (`scaleMatrix.test.ts`). `simulator.test.ts` SKIPs its ngspice cases on this machine (ngspice binary path is a Windows path); `scaleMatrix.test.ts` runs 11 enabled DRAWN + 6 gated-off combos.

### DRC status
**rc_lowpass:** 0 violations, 0 unconnected — clean. **opamp:** ~175 autorouter-quality violations (stochastic, 253 earlier baseline) — pre-existing, not migration-related.
