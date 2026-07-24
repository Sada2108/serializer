# Open_Forge Layer 3 — Architecture Flowchart

## Overview

This document traces the data flow from NIR (Neutral Intermediate Representation) through serialization, PCB layout, routing, and simulation.

---

## 1. Input: NIR Files

**Source**: `layer_three/serializer/fixtures/`

```
┌─────────────────────────────────────────────────────────────────┐
│                        NIR INPUT FILES                          │
├─────────────────────────────────────────────────────────────────┤
│  libbrecht-hall.nir.json          (v0.1 schema - legacy)       │
│    └─→ Contains: circuit_json.components, nets, traces         │
│                                                                 │
│  opamp_noninv_001.nir.json        (v1.1 schema - current)      │
│    └─→ Contains: components[], netlist[], board_spec, etc.      │
│                                                                 │
│  instrumentation_amp_001.nir.json (v1.1 schema)                │
│    └─→ Contains: components[], netlist[], board_spec, etc.      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. NIR → Circuit JSON Conversion (Detailed)

This is the core transformation. Two paths based on schema version:

### v0.1 Path (Libbrecht-Hall): Direct Mapping

```
┌─────────────────────────────────────────────────────────────────┐
│              v0.1 NIR → Circuit JSON (Direct Mapping)           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  NIR v0.1 Structure:                                           │
│    {                                                            │
│      "nir_schema_version": "0.1",                              │
│      "circuit_json": {                                          │
│        "components": [{ name, type, resistance, ... }],        │
│        "nets": [{ name, isPowerNet, isGroundNet }],            │
│        "traces": [{ from, to }]                                │
│      }                                                         │
│    }                                                            │
│                                                                 │
│  Conversion (parseNirV01):                                      │
│    For each component:                                          │
│      └─→ { type: "source_component_base",                      │
│            source_component_id: "${name}_source",              │
│            name: comp.name,                                     │
│            ...normalizeComponentFields(comp) }                  │
│                                                                 │
│    For each net:                                                │
│      └─→ { type: "source_net",                                 │
│            source_net_id: "net_${name}",                        │
│            name: net.name,                                      │
│            is_power: Boolean(net.isPowerNet),                   │
│            is_ground: Boolean(net.isGroundNet) }                │
│                                                                 │
│    For each trace:                                              │
│      └─→ { type: "source_trace",                               │
│            source_trace_id: "trace_${from}_${to}",             │
│            connected_source_port_ids: [from, to],              │
│            connected_source_net_ids: [] }                       │
│                                                                 │
│  Result: Array of source_component_base, source_net,           │
│          source_trace elements (legacy format)                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### v1.1 Path (Current): tscircuit JSX Generation + CircuitRunner

```
┌─────────────────────────────────────────────────────────────────┐
│     v1.1 NIR → tscircuit JSX → CircuitRunner → Circuit JSON    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  NIR v1.1 Structure:                                           │
│    {                                                            │
│      "schema_version": "1.1",                                  │
│      "components": [{ ref, component_type, footprint, value }],│
│      "netlist": [{ net_name, net_type, connections: [...] }],  │
│      "board_spec": { layers, material, ... }                   │
│    }                                                            │
│                                                                 │
│  Step 1: generateTscircuitJsx(nir)                             │
│    ├─→ Map component_type → tscircuit element (resistor, chip) │
│    ├─→ Map footprint → KiCad path (FOOTPRINT_MAP)             │
│    ├─→ Generate <resistor>, <capacitor>, <chip> elements       │
│    ├─→ Add pinLabels for chips (from netlist connections)      │
│    ├─→ Generate <trace from="R1.pin1" to="net.VCC" />         │
│    └─→ Return JSX string:                                      │
│        import { board, resistor, chip } from "tscircuit"       │
│        export default () => (                                   │
│          <board width="80mm" height="60mm" layers={2}>         │
│            <resistor name="R1" footprint="kicad:..." />        │
│            <chip name="U1" pinLabels={{...}} />                │
│            <trace from="R1.pin1" to="net.VCC" />              │
│          </board>                                               │
│        )                                                        │
│                                                                 │
│  Step 2: runTscircuit(jsxFiles)                                │
│    ├─→ Dynamic import @tscircuit/eval                          │
│    ├─→ new CircuitRunner(jsxFiles)                             │
│    ├─→ runner.executeWithFsMap()                                │
│    ├─→ runner.renderUntilSettled()                             │
│    └─→ runner.getCircuitJson() → AnyCircuitElement[]           │
│                                                                 │
│  tscircuit Internals:                                           │
│    ┌─────────────────────────────────────────────────────┐     │
│    │  @tscircuit/eval (CircuitRunner)                    │     │
│    │    ├─→ Parses JSX                                   │     │
│    │    ├─→ Resolves components + traces                 │     │
│    │    ├─→ Auto-placement (layout solver)              │     │
│    │    ├─→ Auto-routing (autorouter)                    │     │
│    │    └─→ Outputs Circuit JSON with:                   │     │
│    │         - source_component, source_port             │     │
│    │         - source_net, source_trace                  │     │
│    │         - pcb_board, pcb_component, pcb_smtpad      │     │
│    │         - schematic_component, schematic_port       │     │
│    │         - pcb_trace, pcb_via                        │     │
│    └─────────────────────────────────────────────────────┘     │
│                                                                 │
│  Result: Full Circuit JSON with PCB layout + routing done       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. NIR → Circuit JSON Conversion (Detailed)

This is the core transformation. Two paths based on schema version:

### v0.1 Path (Libbrecht-Hall): Direct Mapping

```
┌─────────────────────────────────────────────────────────────────┐
│              v0.1 NIR → Circuit JSON (Direct Mapping)           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  NIR v0.1 Structure:                                           │
│    {                                                            │
│      "nir_schema_version": "0.1",                              │
│      "circuit_json": {                                          │
│        "components": [{ name, type, resistance, ... }],        │
│        "nets": [{ name, isPowerNet, isGroundNet }],            │
│        "traces": [{ from, to }]                                │
│      }                                                         │
│    }                                                            │
│                                                                 │
│  Conversion (parseNirV01):                                      │
│    For each component:                                          │
│      └─→ { type: "source_component_base",                      │
│            source_component_id: "${name}_source",              │
│            name: comp.name,                                     │
│            ...normalizeComponentFields(comp) }                  │
│                                                                 │
│    For each net:                                                │
│      └─→ { type: "source_net",                                 │
│            source_net_id: "net_${name}",                        │
│            name: net.name,                                      │
│            is_power: Boolean(net.isPowerNet),                   │
│            is_ground: Boolean(net.isGroundNet) }                │
│                                                                 │
│    For each trace:                                              │
│      └─→ { type: "source_trace",                               │
│            source_trace_id: "trace_${from}_${to}",             │
│            connected_source_port_ids: [from, to],              │
│            connected_source_net_ids: [] }                       │
│                                                                 │
│  Result: Array of source_component_base, source_net,           │
│          source_trace elements (legacy format)                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### v1.1 Path (Current): tscircuit JSX Generation + CircuitRunner

```
┌─────────────────────────────────────────────────────────────────┐
│     v1.1 NIR → tscircuit JSX → CircuitRunner → Circuit JSON    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  NIR v1.1 Structure:                                           │
│    {                                                            │
│      "schema_version": "1.1",                                  │
│      "components": [{ ref, component_type, footprint, value }],│
│      "netlist": [{ net_name, net_type, connections: [...] }],  │
│      "board_spec": { layers, material, ... }                   │
│    }                                                            │
│                                                                 │
│  Step 1: generateTscircuitJsx(nir)                             │
│    ├─→ Map component_type → tscircuit element (resistor, chip) │
│    ├─→ Map footprint → KiCad path (FOOTPRINT_MAP)             │
│    ├─→ Generate <resistor>, <capacitor>, <chip> elements       │
│    ├─→ Add pinLabels for chips (from netlist connections)      │
│    ├─→ Generate <trace from="R1.pin1" to="net.VCC" />         │
│    └─→ Return JSX string:                                      │
│        import { board, resistor, chip } from "tscircuit"       │
│        export default () => (                                   │
│          <board width="80mm" height="60mm" layers={2}>         │
│            <resistor name="R1" footprint="kicad:..." />        │
│            <chip name="U1" pinLabels={{...}} />                │
│            <trace from="R1.pin1" to="net.VCC" />              │
│          </board>                                               │
│        )                                                        │
│                                                                 │
│  Step 2: runTscircuit(jsxFiles)                                │
│    ├─→ Dynamic import @tscircuit/eval                          │
│    ├─→ new CircuitRunner(jsxFiles)                             │
│    ├─→ runner.executeWithFsMap()                                │
│    ├─→ runner.renderUntilSettled()                             │
│    └─→ runner.getCircuitJson() → AnyCircuitElement[]           │
│                                                                 │
│  tscircuit Internals:                                           │
│    ┌─────────────────────────────────────────────────────┐     │
│    │  @tscircuit/eval (CircuitRunner)                    │     │
│    │    ├─→ Parses JSX                                   │     │
│    │    ├─→ Resolves components + traces                 │     │
│    │    ├─→ Auto-placement (layout solver)              │     │
│    │    ├─→ Auto-routing (autorouter)                    │     │
│    │    └─→ Outputs Circuit JSON with:                   │     │
│    │         - source_component, source_port             │     │
│    │         - source_net, source_trace                  │     │
│    │         - pcb_board, pcb_component, pcb_smtpad      │     │
│    │         - schematic_component, schematic_port       │     │
│    │         - pcb_trace, pcb_via                        │     │
│    └─────────────────────────────────────────────────────┘     │
│                                                                 │
│  Result: Full Circuit JSON with PCB layout + routing done       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### JSX Generation Details

The `generateTscircuitJsx()` function transforms NIR data:

```
┌─────────────────────────────────────────────────────────────────┐
│                    JSX GENERATION MAPPING                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  NIR Component → JSX Element:                                   │
│  ─────────────────────────────                                  │
│  { ref: "R1", component_type: "resistor",                      │
│    footprint: "0603", value: "10k" }                           │
│    └─→ <resistor name="R1"                                     │
│            footprint="kicad:Resistor_SMD/R_0603_1608Metric"    │
│            resistance="10k" />                                  │
│                                                                 │
│  { ref: "U1", component_type: "opamp",                         │
│    footprint: "SOIC-8" }                                       │
│    └─→ <chip name="U1"                                         │
│            footprint="kicad:Package_SO/SOIC-8_3.9x4.9mm_P1.27mm"
│            pinLabels={{                                        │
│              pin1: "OUT",                                       │
│              pin2: "INN",                                       │
│              pin3: "INP",                                       │
│              pin4: "GND",                                       │
│              pin5: "NC",                                        │
│              pin6: "NC",                                        │
│              pin7: "NC",                                        │
│              pin8: "VCC"                                        │
│            }} />                                                │
│                                                                 │
│  NIR Netlist → JSX Traces:                                      │
│  ─────────────────────────                                      │
│  { net_name: "VCC", net_type: "power",                         │
│    connections: [                                               │
│      { ref: "U1", pin_name: "VCC", pin_number: 8 },           │
│      { ref: "C3", pin_name: "POSITIVE", pin_number: 1 }       │
│    ]}                                                           │
│    └─→ <trace from="U1.VCC" to="net.VCC" />                   │
│        <trace from="C3.pin1" to="net.VCC" />                  │
│                                                                 │
│  Pin Name Mapping (SEMANTIC_TO_PASSIVE):                        │
│  ──────────────────────────────────────                         │
│  POSITIVE → pin1 (for passives: R, C, L, D)                   │
│  NEGATIVE → pin2                                               │
│  IN → pin1                                                     │
│  OUT → pin2                                                    │
│  PIN1 → pin1                                                   │
│  PIN2 → pin2                                                   │
│                                                                 │
│  Pin Name Sanitization (PIN_NAME_FIXUP):                        │
│  ────────────────────────────────────────                       │
│  IN+ → INP  (tscircuit allows letters/numbers/underscores)     │
│  IN- → INN                                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Serializer Pipeline (SVG + KiCad PCB Generation)

```
┌─────────────────────────────────────────────────────────────────┐
│                   PCB LAYOUT & ROUTING                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Circuit JSON (from serializer)              │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  circuitJsonToSimpleRouteJson(cj)                        │   │
│  │  (layer_three/serializer/pcbRouting.ts)                  │   │
│  │                                                          │   │
│  │  Converts:                                               │   │
│  │    pcb_component → obstacles (rectangles)                │   │
│  │    source_net    → connections (points to connect)       │   │
│  │    pcb_port      → pin locations                         │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  routeCircuit(simpleRouteJson)                           │   │
│  │  (layer_three/serializer/router.ts)                      │   │
│  │                                                          │   │
│  │  Wraps: @tscircuit/capacity-autorouter                  │   │
│  │    └─→ CapacityMeshSolver.solve()                        │   │
│  │                                                          │   │
│  │  Returns: RoutedTrace[] (wire/via segments)              │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  mergeRoutedTraces(circuitJson, routedTraces)            │   │
│  │  (layer_three/serializer/pcbRouting.ts)                  │   │
│  │                                                          │   │
│  │  Replaces placeholder pcb_trace entries with real        │   │
│  │  routed traces (wire/via segments from autorouter)       │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                                                       │
│         ├─────────────────────────────────────────────┐        │
│         ▼                                             ▼        │
│  ┌────────────────────┐                  ┌───────────────────┐  │
│  │circuitJsonToKicad  │                  │  circuit-to-svg   │  │
│  │Pcb(circuitJson)    │                  │  (tscircuit pkg)  │  │
│  │(kicadPcbWriter.ts) │                  └───────────────────┘  │
│  └─────────┬──────────┘                                        │
│            │                                                    │
│            ▼                                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  KiCad .kicad_pcb S-expression file                     │   │
│  │                                                          │   │
│  │  Sections:                                               │   │
│  │    (kicad_pcb (version ...) (generator ...))             │   │
│  │    (layers ...)                                          │   │
│  │    (setup ...)                                           │   │
│  │    (net ...)  ← net declarations                        │   │
│  │    (footprint ...) ← component footprints with pads     │   │
│  │    (segment ...) ← trace routing                        │   │
│  │    (via ...)  ← via holes                                │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Simulation Pipeline

**Files**:
- `layer_three/simulator/netlistFromCircuitJson.ts` — Circuit JSON → SPICE netlist
- `layer_three/simulator/simulator.ts` — ngspice subprocess driver
- `layer_three/simulator/parseRawFile.ts` — ngspice .raw output parser

**Input**: Circuit JSON + Original NIR (for component values)

```
┌─────────────────────────────────────────────────────────────────┐
│                     SIMULATION PIPELINE                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │         Circuit JSON + Original NIR                      │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  netlistFromCircuitJson(circuitJson, nir)                │   │
│  │  (layer_three/simulator/netlistFromCircuitJson.ts)       │   │
│  │                                                          │   │
│  │  Processes:                                               │   │
│  │    source_component → R/C/L/D/V/I elements              │   │
│  │    source_net       → SPICE node numbers                 │   │
│  │    source_trace     → pin-to-net mapping                 │   │
│  │                                                          │   │
│  │  Infers:                                                  │   │
│  │    Power nets (VCC) → implicit voltage sources          │   │
│  │    Input nets (VIN) → stimulus sources                  │   │
│  │    (only external inputs/supplies, not outputs)          │   │
│  │                                                          │   │
│  │  Returns: { netlist: string, nodeMap, warnings }         │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  SPICE Netlist (string)                                  │   │
│  │                                                          │   │
│  │  Format:                                                 │   │
│  │    * Open_Forge generated netlist                        │   │
│  │    R1 0 4 1k                                             │   │
│  │    C1 1 2 1uF                                            │   │
│  │    V1 1 0 DC 0  (implicit, warning attached)            │   │
│  │    .op                                                   │   │
│  │    .tran 1m 10m                                          │   │
│  │    .end                                                  │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  simulateNetlist(netlist, options)                       │   │
│  │  (layer_three/simulator/simulator.ts)                    │   │
│  │                                                          │   │
│  │  1. Write netlist to temp .cir file                      │   │
│  │  2. Append .control/.endc block for ASCII raw output     │   │
│  │  3. Spawn: ngspice -b <temp.cir>                         │   │
│  │  4. Parse output: <temp>.raw → parseRawFile()            │   │
│  │  5. Cleanup temp files                                   │   │
│  │                                                          │   │
│  │  Returns: { vectors, variables, numPoints, plotname }    │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Simulation Result                                       │   │
│  │                                                          │   │
│  │  vectors: {                                              │   │
│  │    "time": [0, 0.001, 0.002, ...],                      │   │
│  │    "v(out)": [0, 0.1, 0.3, 0.6, ...],                   │   │
│  │    "v(in)": [0, 0, 0, ...]                              │   │
│  │  }                                                       │   │
│  │                                                          │   │
│  │  variables: ["time", "v(out)", "v(in)"]                  │   │
│  │  numPoints: 100                                          │   │
│  │  plotname: "Transient Analysis"                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. External Dependencies (tscircuit ecosystem)

```
┌─────────────────────────────────────────────────────────────────┐
│                  EXTERNAL PACKAGES USED                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  circuit-json                                                  │
│    └─→ TypeScript types for Circuit JSON schema                │
│        (AnyCircuitElement, source_component, pcb_component,    │
│         source_net, source_trace, etc.)                        │
│        ORIGIN: tscircuit ecosystem                              │
│                                                                 │
│  circuit-to-svg                                                │
│    └─→ Renders Circuit JSON → SVG (schematic or PCB view)      │
│        Functions: convertCircuitJsonToSchematicSvg()            │
│                  convertCircuitJsonToPcbSvg()                   │
│        ORIGIN: tscircuit ecosystem                              │
│                                                                 │
│  @tscircuit/capacity-autorouter (pinned v0.0.692)             │
│    └─→ Mesh-based PCB autorouter                               │
│        Class: CapacityMeshSolver                               │
│        Input: SimpleRouteJson (obstacles + connections)        │
│        Output: SimplifiedPcbTrace[] (routed wire/via segments) │
│        ORIGIN: tscircuit ecosystem (we wrap it in router.ts)   │
│                                                                 │
│  @tscircuit/eval (optional)                                    │
│    └─→ CircuitRunner for in-process layout + routing           │
│        Used by parseNirV11WithTscircuit() for auto-placement   │
│        ORIGIN: tscircuit ecosystem (direct import)             │
│                                                                 │
│  @tscircuit/schematic-viewer (optional, fallback)             │
│    └─→ Alternative SVG renderer for schematics                 │
│        Falls back to circuit-to-svg if not installed           │
│        ORIGIN: tscircuit ecosystem                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Complete Data Flow Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                    END-TO-END DATA FLOW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  NIR File (.nir.json)                                          │
│       │                                                         │
│       ▼                                                         │
│  ┌─────────────┐                                               │
│  │  Serializer │  (serializer.ts)                              │
│  └──────┬──────┘                                               │
│         │                                                       │
│         ├──────────────────────────────────────────┐           │
│         ▼                                          ▼           │
│  Circuit JSON                              SVG Rendering       │
│  (AnyCircuitElement[])                     (circuit-to-svg)    │
│       │                                          │              │
│       ├──────────┬──────────┬──────────┐         │              │
│       ▼          ▼          ▼          ▼         ▼              │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐       │
│  │Autorout│ │KiCad   │ │Netlist │ │PCB     │ │Schematic      │
│  │e       │ │PCB     │ │Gen     │ │Routing │ │SVG    │       │
│  │(router │ │(kicadP │ │(netlis │ │(pcbRout│ │(circuit       │
│  │ .ts)   │ │cbWrite │ │tFromCi │ │ing.ts) │ │-to-svg)      │
│  │        │ │r.ts)   │ │rcuitJs │ │        │ │       │       │
│  └───┬────┘ └───┬────┘ │on.ts)  │ └───┬────┘ └───┬───┘       │
│      │          │       └───┬────┘     │          │             │
│      ▼          ▼           ▼          ▼          ▼             │
│  Routed     .kicad_pcb   SPICE      Merged    SVG File         │
│  Traces     File         Netlist    Circuit                    │
│      │          │           │        JSON                      │
│      │          │           │          │                        │
│      ▼          ▼           ▼          ▼                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    ngspice (optional)                    │   │
│  │  (simulator.ts)                                         │   │
│  │                                                         │   │
│  │  SPICE Netlist → ngspice -b → .raw file → vectors      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 8. File Reference Table

| File | Purpose | Source/Origin |
|------|---------|---------------|
| `serializer/serializer.ts` | Main entry: NIR → Circuit JSON + SVG | Custom (Open_Forge) |
| `serializer/router.ts` | Autorouting wrapper | Wraps @tscircuit/capacity-autorouter |
| `serializer/pcbRouting.ts` | Circuit JSON → route conversion | Custom (Open_Forge) |
| `serializer/kicadPcbWriter.ts` | Circuit JSON → KiCad PCB format | Custom (Open_Forge) |
| `simulator/netlistFromCircuitJson.ts` | Circuit JSON → SPICE netlist | Custom (Open_Forge) |
| `simulator/simulator.ts` | ngspice subprocess driver | Custom (Open_Forge) |
| `simulator/parseRawFile.ts` | ngspice .raw output parser | Custom (Open_Forge) |
| `serializer/fixtures/` | NIR input files | Libbrecht-Hall (v0.1), Custom (v1.1) |

---

## 9. Key Functions by File

### serializer/serializer.ts (NIR → Circuit JSON)
- `detectNirSchemaVersion(nir)` — Identify v0.1 vs v1.1
- `parseNirV01(nir)` — Legacy v0.1 parser (sync, direct mapping)
- `parseNirV11WithTscircuit(nir)` — v1.1 parser with tscircuit (async)
- `generateTscircuitJsx(nir)` — NIR v1.1 → tscircuit JSX string
- `runTscircuit(jsxFiles)` — Execute JSX through CircuitRunner
- `serializeNir(nir)` — Sync entry point (backward compat)
- `serializeNirAsync(nir)` — Async entry point (auto-place/route)
- `renderCircuitJson(cj)` — Circuit JSON → SVG

### serializer/router.ts
- `routeCircuit(simpleRouteJson)` — Wrapper for CapacityMeshSolver

### serializer/pcbRouting.ts
- `circuitJsonToSimpleRouteJson(cj)` — Convert to autorouter format
- `mergeRoutedTraces(cj, traces)` — Merge routed traces back
- `routeCircuitJson(cj)` — End-to-end routing

### serializer/kicadPcbWriter.ts
- `circuitJsonToKicadPcb(cj)` — Generate KiCad PCB file

### simulator/netlistFromCircuitJson.ts
- `netlistFromCircuitJson(cj, nir)` — Generate SPICE netlist

### simulator/simulator.ts
- `simulateNetlist(netlist, options)` — Run ngspice simulation
- `resolveNgspiceBin()` — Find ngspice binary
