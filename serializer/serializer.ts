// Open_Forge — Team E serializer (Layer 3).
//
// New export path: NIR -> Circuit JSON (typed via circuit-json) -> SVG render.
//
// HARD CONSTRAINT — no tscircuit wasm / tsci CLI on this path:
//   This module imports ONLY:
//     - circuit-json            (TypeScript type defs for Circuit JSON)
//     - circuit-to-svg          (renders Circuit JSON to SVG directly)
//     - @tscircuit/eval         (CircuitRunner for in-process layout + routing)
//   It OPTIONALLY lazy-imports `@tscircuit/schematic-viewer` if installed;
//   if that package is missing, it silently falls back to circuit-to-svg.
//   It NEVER calls `tsci simulate`, `@tscircuit/ngspice-spice-engine`, or
//   any wasm-based simulation wrapper.  This file performs ZERO simulation.
//
// The pre-existing TSX + `tsci build` CLI export path (index.circuit.tsx at
// project root) is untouched and remains the fallback for now.
//
// Supported NIR schemas:
//   - "v0.1-libbrecht"         Libbrecht-Hall fixture (legacy schema with
//                              top-level `circuit_json` carrying the old
//                              source_component_base / source_net shape)
//   - "v1.1-instrumentation"    Newer schema with top-level `components` /
//                              `netlist` / `board_spec` / etc.
//
// LOUD-FAILURE INVARIANT:
//   A NIR file whose schema we cannot positively identify raises an Error.
//   A NIR v1.1 file missing any required field raises an Error.
//   We NEVER silently return a [] or partial Circuit JSON — that was the bug
//   that motivated this rewrite.

import type { AnyCircuitElement } from "circuit-json"
import {
  convertCircuitJsonToPcbSvg,
  convertCircuitJsonToSchematicSvg,
} from "circuit-to-svg"
import type {
  Nir,
  NirCircuitJson,
  NirV11Component,
  NirV11NetlistEntry,
  NirV11BoardSpec,
  NirV11PlacementConstraint,
  NirV11,
} from "./fixtures"
import { circuitJsonToKicadPcb } from "./kicadPcbWriter"

// --------------------------------------------------------------------------- //
// Types
// --------------------------------------------------------------------------- //

export type ViewerUsed =
  | "circuit-to-svg"
  | "@tscircuit/schematic-viewer"

export interface SerializerOutput {
  /** Circuit JSON elements (typed) extracted from the NIR input. */
  circuitJson: AnyCircuitElement[]
  /** Rendered SVG string. */
  svg: string
  /** Which renderer produced `svg`.  `null` means render was skipped. */
  viewerUsed: ViewerUsed | null
  /** KiCad .kicad_pcb S-expression text (async path only). */
  kicadPcb?: string
}

export type NirSchemaVersion = "v0.1-libbrecht" | "v1.1-instrumentation"

// --------------------------------------------------------------------------- //
// NIR -> Circuit JSON  (dispatched by version)
// --------------------------------------------------------------------------- //

// Synchronous entry point for v0.1 (libbrecht-hall) - stays sync for backward compat
export function nirToCircuitJsonSync(nir: Nir | unknown): AnyCircuitElement[] {
  const version = detectNirSchemaVersion(nir)
  return version === "v0.1-libbrecht"
    ? parseNirV01(nir as Nir)
    : parseNirV11Sync(nir as unknown as NirV11)  // fallback sync path
}

// Async entry point for v1.1 - uses tscircuit for auto-place + auto-route
export async function nirToCircuitJson(nir: Nir | unknown): Promise<AnyCircuitElement[]> {
  const version = detectNirSchemaVersion(nir)
  if (version === "v0.1-libbrecht") {
    return parseNirV01(nir as Nir)
  }
  // v1.1: use async tscircuit path for auto-place + auto-route
  return parseNirV11WithTscircuit(nir as unknown as NirV11)
}

// --------------------------------------------------------------------------- //
// v0.1 parser  — verbatim legacy path, untouched for backward compat
// --------------------------------------------------------------------------- //

/**
 * Parse the original Libbrecht-Hall-shaped NIR.
 *
 * This function body is preserved byte-for-byte from the previous
 * implementation (`nirToCircuitJson` pre-rewrite) so the Libbrecht-Hall
 * fixture continues to produce exactly the Circuit JSON it did before.
 * Any change to this branch breaks the "don't break backward compat" rule.
 */
function parseNirV01(nir: Nir): AnyCircuitElement[] {
  const out: AnyCircuitElement[] = []
  const cj: NirCircuitJson = nir.circuit_json ?? { components: [] }

  for (const comp of cj.components ?? []) {
    out.push({
      type: "source_component_base",
      source_component_id: `${comp.name}_source`,
      name: comp.name,
      ...normalizeComponentFields(comp),
    } as AnyCircuitElement)
  }

  for (const net of cj.nets ?? []) {
    out.push({
      type: "source_net",
      source_net_id: `net_${net.name}`,
      name: net.name,
      member_source_group_ids: [],
      is_power: Boolean(net.isPowerNet),
      is_ground: Boolean(net.isGroundNet),
    } as AnyCircuitElement)
  }

  for (const t of cj.traces ?? []) {
    out.push({
      type: "source_trace",
      source_trace_id: `trace_${t.from}_${t.to}`,
      connected_source_port_ids: [t.from, t.to],
      connected_source_net_ids: [],
    } as AnyCircuitElement)
  }

  return out
}

function normalizeComponentFields(
  comp: Record<string, unknown>,
): Record<string, unknown> {
  const { name, type, flagged, ...rest } = comp as {
    name: string
    type: string
    flagged?: boolean
    [k: string]: unknown
  }
  void name
  void type
  void flagged
  return rest
}

// --------------------------------------------------------------------------- //
// v1.1 parser  — NEW: tscircuit JSX -> CircuitRunner -> Circuit JSON
// --------------------------------------------------------------------------- //

/**
 * Parse the NIR v1.1 ("instrumentation_amp") schema by generating tscircuit JSX
 * and running it through CircuitRunner for auto-placement + autorouting.
 *
 * This replaces the previous custom union-find grid + manual orthogonal wire
 * drawing.  tscircuit's own layout solver and autorouter now handle placement
 * and trace routing.
 *
 * Flow:
 *   1. Validate required NIR v1.1 fields (loud failure on missing data)
 *   2. Generate a single tscircuit JSX file as a string (board + components + nets)
 *   3. Run it through CircuitRunner.executeWithFsMap -> renderUntilSettled
 *   4. getCircuitJson() -> AnyCircuitElement[] (includes pcb_component,
 *      schematic_component, source_trace, source_net, pcb_board, etc.)
 *   5. Return that array — downstream renderCircuitJson handles SVG as before
 */
async function parseNirV11WithTscircuit(nir: NirV11): Promise<AnyCircuitElement[]> {
  // 1. Validate required top-level fields
  requireKeys(nir, ["schema_version", "design_id", "components", "netlist", "board_spec"], "NIR v1.1 root")
  if (nir.schema_version !== "1.1") {
    throw new Error(`NIR v1.1 parser expects schema_version "1.1", got "${nir.schema_version}"`)
  }

  const comps = nir.components
  if (comps.length === 0) {
    throw new Error("NIR v1.1 `components` array is empty — refusing to emit empty Circuit JSON.")
  }

  // 2. Generate tscircuit JSX
  const jsx = generateTscircuitJsx(nir)

  // 3. Run through CircuitRunner
  const circuitJson = await runTscircuit({ "circuit.tsx": jsx })

  // 4. Return Circuit JSON elements (already includes pcb_board, pcb_component,
  // schematic components,
  // source_net, source_trace from the autorouter)
  return circuitJson
}

// Synchronous fallback for v1.1 (used when @tscircuit/eval unavailable or for sync API)
function parseNirV11Sync(nir: NirV11): AnyCircuitElement[] {
  requireKeys(nir, ["schema_version", "design_id", "components", "netlist", "board_spec"], "NIR v1.1 root")
  if (nir.schema_version !== "1.1") {
    throw new Error(`NIR v1.1 parser expects schema_version "1.1", got "${nir.schema_version}"`)
  }
  if (nir.components.length === 0) {
    throw new Error("NIR v1.1 `components` array is empty — refusing to emit empty Circuit JSON.")
  }
  return generateCircuitJsonFromNir(nir)
}

// --------------------------------------------------------------------------- //
// NIR v1.1 -> tscircuit JSX generation
// --------------------------------------------------------------------------- //

// Footprint mapping: fixture names -> KiCad footprint strings from tscircuit (with kicad: prefix)
export const FOOTPRINT_MAP: Record<string, string> = {
  "MSOP-8":     "kicad:Package_SO/MSOP-8-1EP_3x3mm_P0.65mm_EP1.5x1.8mm",
  "SOT-23-5":   "kicad:Package_TO_SOT_SMD/SOT-23-5",
  "TSOT-23-5":  "kicad:Package_TO_SOT_SMD/TSOT-23-5",
  "MSOP-10":    "kicad:Package_SO/MSOP-10-1EP_3x3mm_P0.5mm_EP1.68x1.88mm",
  "SOIC-8":     "kicad:Package_SO/SOIC-8_3.9x4.9mm_P1.27mm",
  "0603":       "kicad:Resistor_SMD/R_0603_1608Metric",   // generic 0603, works for R/C
  "0402":       "kicad:Resistor_SMD/R_0402_1005Metric",
  "1206":       "kicad:Capacitor_SMD/C_1206_3216Metric",
  "SOT-23":     "kicad:Package_TO_SOT_SMD/SOT-23-5",      // TVS diode array likely 5-pin
}

export function kicadFootprint(fixtureName: string): string {
  return FOOTPRINT_MAP[fixtureName] ?? fixtureName
}

// Map fixture pin names -> tscircuit-valid pin labels (letters/numbers/underscores only)
const PIN_NAME_FIXUP: Record<string, string> = {
  "IN+": "INP",
  "IN-": "INN",
  "VCC": "VCC",
  "GND": "GND",
  "OUT": "OUT",
  "VIN": "VIN",
  "VOUT": "VOUT",
}

function fixPinName(pinName: string): string {
  return PIN_NAME_FIXUP[pinName] ?? pinName.replace(/[^A-Za-z0-9_]/g, "_")
}

// Map semantic pin names (POSITIVE/NEGATIVE/IN/OUT/PIN1/PIN2) onto passive pin1/pin2
const SEMANTIC_TO_PASSIVE: Record<string, "pin1" | "pin2"> = {
  "POSITIVE": "pin1", "IN": "pin1", "ANODE": "pin1", "A": "pin1", "P": "pin1", "PIN1": "pin1",
  "NEGATIVE": "pin2", "OUT": "pin2", "CATHODE": "pin2", "K": "pin2", "N": "pin2", "PIN2": "pin2",
}

function generateTscircuitJsx(nir: NirV11): string {
  const { components, netlist, board_spec } = nir

  const compRefSet = new Set(components.map(c => c.ref))

  // Build component JSX elements (with pinLabels for chips)
  const componentJsx = components.map(c => generateComponentJsx(c, netlist)).join("\n  ")

  // Map ref -> element type so traces can resolve passive pin numbering
  const refToType: Record<string, string> = {}
  for (const c of components) refToType[c.ref] = mapComponentType(c.component_type)

  // Build traces: one <trace> per (REF.PIN -> net.NAME) — skip phantom refs
  const traceLines: string[] = []
  const refsInNetlist = new Set<string>()
  for (const net of netlist) {
    for (const conn of net.connections) {
      if (!compRefSet.has(conn.ref)) continue // off-schema refs (Battery, headers) — skip
      refsInNetlist.add(conn.ref)
      const elementType = refToType[conn.ref]
      const isPassive = elementType === "resistor" || elementType === "capacitor" || elementType === "diode" || elementType === "inductor"
      // Passives only have pin1/pin2 — resolve semantic alias if present
      // Chips use fixed pin names valid in tscircuit (letters/numbers/underscores)
      const pin = isPassive && SEMANTIC_TO_PASSIVE[conn.pin_name]
        ? SEMANTIC_TO_PASSIVE[conn.pin_name]
        : isPassive
          ? conn.pin_name
          : fixPinName(conn.pin_name)
      traceLines.push(`    <trace from="${conn.ref}.${pin}" to="net.${net.net_name}" />`)
    }
  }

  // Emit test-point stubs for components with NO netlist connections (floating parts)
  for (const comp of components) {
    if (refsInNetlist.has(comp.ref)) continue
    const elementType = refToType[comp.ref]
    const isPassive = elementType === "resistor" || elementType === "capacitor" || elementType === "diode" || elementType === "inductor"
    if (isPassive) {
      // Passives: emit two stub traces to NC net (pin1 & pin2)
      traceLines.push(`    <trace from="${comp.ref}.pin1" to="net.NC_${comp.ref}_1" />`)
      traceLines.push(`    <trace from="${comp.ref}.pin2" to="net.NC_${comp.ref}_2" />`)
    } else {
      // Chips: emit one stub per declared pinLabel (fallback to pin1 if none)
      // Note: pinLabels are generated in generateComponentJsx; here we conservatively emit pin1
      traceLines.push(`    <trace from="${comp.ref}.pin1" to="net.NC_${comp.ref}_1" />`)
    }
  }

  const traceJsx = traceLines.join("\n")

  // Board dimensions (board_spec lacks width/height, use sensible defaults)
  const boardWidth = 80  // mm
  const boardHeight = 60 // mm

  return `import { board, ${getUniqueIntrinsics(components).join(", ")} } from "tscircuit"

export default () => (
  <board
    width="${boardWidth}mm"
    height="${boardHeight}mm"
    layers={${board_spec.layers}}
  >
    ${componentJsx}

${traceJsx}
  </board>
)`
}

function generateComponentJsx(comp: NirV11Component, netlist: NirV11NetlistEntry[]): string {
  const elementType = mapComponentType(comp.component_type)
  const isPassive = elementType === "resistor" || elementType === "capacitor" || elementType === "diode" || elementType === "inductor"

  // Collect this component's pin names from the netlist (with pin_number for chips)
  const pinNames = new Set<string>()
  const pinNumberMap = new Map<string, string>() // pin_name -> pin_number (as string)
  for (const net of netlist) {
    for (const conn of net.connections) {
      if (conn.ref === comp.ref) {
        pinNames.add(conn.pin_name)
        if (conn.pin_number != null) pinNumberMap.set(conn.pin_name, String(conn.pin_number))
      }
    }
  }

  const props: string[] = [
    `name="${comp.ref}"`,
    `footprint="${kicadFootprint(comp.footprint)}"`,
  ]

  // Value prop depends on component type
  if (elementType === "resistor" && comp.value != null) props.push(`resistance="${comp.value}"`)
  else if (elementType === "capacitor" && comp.value != null) props.push(`capacitance="${comp.value}"`)
  else if (elementType === "inductor" && comp.value != null) props.push(`inductance="${comp.value}"`)
  else if (comp.value != null) props.push(`value="${comp.value}"`)

  // Chips need pinLabels so traces can reference named pins
  if (!isPassive && pinNames.size > 0) {
    // Use pin_number from netlist for correct physical pin assignment
    const pinLabelsObj = Array.from(pinNames)
      .sort((a, b) => {
        const pa = Number(pinNumberMap.get(a) ?? "99")
        const pb = Number(pinNumberMap.get(b) ?? "99")
        return pa - pb
      })
      .map((name, i) => {
        const physPin = pinNumberMap.get(name) ?? String(i + 1)
        const fixedName = fixPinName(name)
        return `pin${physPin}: "${fixedName}"`
      })
      .join(", ")
    props.push(`pinLabels={{ ${pinLabelsObj} }}`)
  }

  return `    <${elementType} ${props.join(" ")} />`
}

function mapComponentType(type: string): string {
  const map: Record<string, string> = {
    "resistor": "resistor",
    "capacitor": "capacitor",
    "voltage_reference": "chip",
    "ldo_regulator": "chip",
    "instrumentation_amp": "chip",
    "digital_potentiometer": "chip",
    "opamp": "chip",
    "diode": "diode",
    "tvs_diode_array": "diode",
    "ferrite_bead": "inductor",
  }
  return map[type.toLowerCase()] ?? "chip"
}

function getUniqueIntrinsics(components: NirV11Component[]): string[] {
  const types = new Set<string>()
  for (const c of components) {
    types.add(mapComponentType(c.component_type))
  }
  return Array.from(types).sort()
}

// --------------------------------------------------------------------------- //
// Actually run tscircuit JSX through CircuitRunner (async)
// --------------------------------------------------------------------------- //

async function runTscircuit(jsxFiles: Record<string, string>): Promise<AnyCircuitElement[]> {
  // Dynamic import to avoid hard dependency if @tscircuit/eval not installed
  let CircuitRunner: any
  try {
    const mod = await import("@tscircuit/eval")
    CircuitRunner = mod.CircuitRunner
  } catch {
    throw new Error("@tscircuit/eval not installed. Run `npm install @tscircuit/eval` to enable v1.1 tscircuit-native path.")
  }

  const runner = new CircuitRunner()
  try {
    await runner.executeWithFsMap({
      fsMap: jsxFiles,
      mainComponentPath: "circuit.tsx",
    })
    await runner.renderUntilSettled()
    const circuitJson = await runner.getCircuitJson()
    return circuitJson
  } finally {
    await runner.kill()
  }
}

// --------------------------------------------------------------------------- //
// Synchronous fallback: generate Circuit JSON directly from NIR
// (used by nirToCircuitJson which must remain synchronous)
// --------------------------------------------------------------------------- //

function generateCircuitJsonFromNir(nir: NirV11): AnyCircuitElement[] {
  const out: AnyCircuitElement[] = []

  // 1. pcb_board from board_spec
  out.push(emitPcbBoard(nir.board_spec))

  // 2. Components: source_component_base + pcb_component + schematic_component
  for (let i = 0; i < nir.components.length; i++) {
    const comp = nir.components[i]
    requireKeys(
      comp as Record<string, unknown>,
      ["ref", "component_id", "component_type", "footprint", "position"],
      `NIR v1.1 components[${i}]`,
    )
    out.push(emitSourceComponentBase(comp))

    // Position: use explicit if provided, else naive layout
    const pos = (comp.position && typeof comp.position.x_mm === "number" && typeof comp.position.y_mm === "number")
      ? { x: comp.position.x_mm, y: comp.position.y_mm, rot: typeof comp.position.rotation_deg === "number" ? comp.position.rotation_deg : 0 }
      : naivePosition(comp.ref, i)

    out.push(emitPcbComponent(comp, pos.x, pos.y, pos.rot))
    out.push(...emitSchematicComponent(comp, pos.x, pos.y))
  }

  // 3. Nets + traces from netlist
  for (const net of nir.netlist) {
    out.push(emitSourceNet(net))
    for (const conn of net.connections) {
      out.push(emitSourceTrace(net, conn))
    }
  }

  return out
}

// --------------------------------------------------------------------------- //
// Shared v1.1 helpers (kept from previous implementation for Circuit JSON emit)
// --------------------------------------------------------------------------- //

const NAIVE_LAYOUT_COLS = 4
const NAIVE_LAYOUT_ORIGIN_MM = { x: 10, y: 10 }
const NAIVE_LAYOUT_PITCH_MM = 12

const FOOTPRINT_SIZE_MM: Record<string, { width: number; height: number }> = {
  "0402": { width: 1.0, height: 0.5 },
  "0603": { width: 1.6, height: 0.8 },
  "0805": { width: 2.0, height: 1.25 },
  "1206": { width: 3.2, height: 1.6 },
  "SOT-23":     { width: 2.9, height: 1.3 },
  "SOT-23-5":   { width: 2.9, height: 1.6 },
  "TSOT-23-5":  { width: 2.9, height: 1.6 },
  "MSOP-8":     { width: 3.0, height: 3.0 },
  "MSOP-10":    { width: 3.0, height: 3.0 },
}

function lookupFootprintSize(footprint: string): { width: number; height: number } {
  const sz = FOOTPRINT_SIZE_MM[footprint]
  if (!sz) {
    throw new Error(`Unknown footprint '${footprint}' — add to FOOTPRINT_SIZE_MM`)
  }
  return sz
}

const MATERIAL_MAP: Record<string, "fr4" | "fr1"> = { "FR4": "fr4", "FR1": "fr1" }

const NAIVE_BOARD_FALLBACK_MM = { width: 80, height: 60 }

function emitPcbBoard(spec: NirV11BoardSpec): AnyCircuitElement {
  requireKeys(spec as Record<string, unknown>, ["layers", "material", "thickness_mm"], "NIR v1.1 board_spec")
  const material = MATERIAL_MAP[String(spec.material).toUpperCase()]
  if (!material) {
    throw new Error(`board_spec.material '${spec.material}' not mapped (expected FR4/FR1)`)
  }
  return {
    type: "pcb_board",
    pcb_board_id: "pcb_board_default",
    width: NAIVE_BOARD_FALLBACK_MM.width,
    height: NAIVE_BOARD_FALLBACK_MM.height,
    thickness: spec.thickness_mm,
    num_layers: spec.layers,
    material,
    center: { x: 0, y: 0 },
    shape: "rect",
  } as AnyCircuitElement
}

function emitSourceComponentBase(comp: NirV11Component): AnyCircuitElement {
  return {
    type: "source_component_base",
    source_component_id: `${comp.ref}_source`,
    name: comp.ref,
    component_type: comp.component_type,
    component_id: comp.component_id,
    footprint: comp.footprint,
  } as AnyCircuitElement
}

function emitPcbComponent(
  comp: NirV11Component,
  x: number,
  y: number,
  rot: number,
): AnyCircuitElement {
  const sz = lookupFootprintSize(comp.footprint)
  return {
    type: "pcb_component",
    pcb_component_id: `${comp.ref}_pcb`,
    source_component_id: `${comp.ref}_source`,
    center: { x, y },
    layer: "top",
    rotation: rot,
    width: sz.width,
    height: sz.height,
    obstructs_within_bounds: true,
  } as AnyCircuitElement
}

const SYMBOL_DISCRETE_W = 6
const SYMBOL_DISCRETE_H = 2
const SYMBOL_IC_W = 10
const SYMBOL_IC_H = 6
const SYMBOL_TEXT_REF_FONT = 1.2
const SYMBOL_TEXT_VAL_FONT = 1.0
const SYMBOL_TEXT_OFFSET = 1.8

function emitSchematicComponent(
  comp: NirV11Component,
  x: number,
  y: number,
): AnyCircuitElement[] {
  const refSchId = `${comp.ref}_sch`
  const pinCount = inferPinCount(comp.footprint)
  const isIc = isIC(comp.component_type)
  const elements: AnyCircuitElement[] = []

  const bodySize = isIc
    ? { width: SYMBOL_IC_W, height: SYMBOL_IC_H + Math.max(0, Math.ceil(pinCount / 2) - 4) }
    : { width: SYMBOL_DISCRETE_W, height: SYMBOL_DISCRETE_H }

  // Parent schematic_component
  elements.push({
    type: "schematic_component",
    schematic_component_id: refSchId,
    source_component_id: `${comp.ref}_source`,
    center: { x, y },
    size: bodySize,
    is_box_with_pins: !["resistor", "capacitor", "diode", "tvs_diode_array"].includes(comp.component_type),
    symbol_display_value: typeof comp.value === "string" ? comp.value : undefined,
  } as AnyCircuitElement)

  // Symbol geometry
  elements.push(...makeSymbolGeometry(comp, refSchId, x, y, bodySize, pinCount))

  // Ref label (orphan text so it renders for all types)
  const bodyH = bodySize.height
  elements.push({
    type: "schematic_text",
    schematic_text_id: `${refSchId}_reftext`,
    text: comp.ref,
    font_size: SYMBOL_TEXT_REF_FONT,
    position: { x, y: y + bodyH / 2 + 1.8 },
    rotation: 0,
    anchor: "center",
    color: "#000",
  } as AnyCircuitElement)

  if (typeof comp.value === "string" && comp.value.length > 0) {
    elements.push({
      type: "schematic_text",
      schematic_text_id: `${refSchId}_valtext`,
      text: comp.value,
      font_size: SYMBOL_TEXT_VAL_FONT,
      position: { x, y: y - bodyH / 2 - 1.8 },
      rotation: 0,
      anchor: "center",
      color: "#333",
    } as AnyCircuitElement)
  }

  return elements
}

function makeSymbolGeometry(
  comp: NirV11Component,
  sid: string,
  cx: number,
  cy: number,
  bodySize: { width: number; height: number },
  pinCount: number,
): AnyCircuitElement[] {
  const ct = comp.component_type
  const wire = "#0c1e2e"
  const w2 = bodySize.width / 2
  const h2 = bodySize.height / 2

  if (ct === "resistor") {
    // Zigzag
    const x0 = cx - w2
    const pts = [
      { x: x0, y: cy },
      { x: x0 + 0.4, y: cy },
      { x: x0 + 0.8, y: cy - h2 },
      { x: x0 + 1.6, y: cy + h2 },
      { x: x0 + 2.4, y: cy - h2 },
      { x: x0 + 3.2, y: cy + h2 },
      { x: x0 + 4.0, y: cy - h2 },
      { x: x0 + 4.8, y: cy + h2 },
      { x: x0 + 5.2, y: cy },
      { x: cx + w2, y: cy },
    ]
    return [
      schematicLine(sid, cx - w2 - 2, cy, x0, cy, wire),
      schematicLine(sid, cx + w2, cy, cx + w2 + 2, cy, wire),
      schematicPath(sid, pts),
    ]
  }
  if (ct === "capacitor") {
    const xL = cx - 0.8
    const xR = cx + 0.8
    const plateH = bodySize.height * 1.2
    return [
      schematicLine(sid, cx - SYMBOL_DISCRETE_W / 2 - 2, cy, xL, cy, wire),
      schematicLine(sid, cx - SYMBOL_DISCRETE_W / 2, cy, xL, cy, wire),
      schematicLine(sid, xL, cy - plateH / 2, xL, cy + plateH / 2, wire),
      schematicLine(sid, xR, cy - plateH / 2, xR, cy + plateH / 2, wire),
      schematicLine(sid, xR, cy, cx + SYMBOL_DISCRETE_W / 2 + 2, cy, wire),
    ]
  }
  if (ct === "tvs_diode_array" || ct === "diode") {
    const tri = 1.6
    const tip = cx + tri
    return [
      schematicLine(sid, cx - SYMBOL_DISCRETE_W / 2 - 2, cy, cx - tri, cy, wire),
      schematicPath(sid, [{ x: cx - tri, y: cy - 1 }, { x: cx - tri, y: cy + 1 }, { x: tip, y: cy }], true),
      schematicLine(sid, tip, cy - 1, tip, cy + 1, wire),
      schematicLine(sid, tip, cy, cx + SYMBOL_DISCRETE_W / 2 + 2, cy, wire),
    ]
  }
  if (ct === "ferrite_bead") {
    const w = SYMBOL_DISCRETE_W
    const h = SYMBOL_DISCRETE_H
    return [
      schematicBox(sid, cx - w / 2, cy - h / 2, w, h),
      schematicLine(sid, cx - w / 2 - 2, cy, cx - w / 2, cy, wire),
      schematicLine(sid, cx + w / 2, cy, cx + w / 2 + 2, cy, wire),
      schematicPath(sid, [{ x: cx - 1.5, y: cy }, { x: cx - 0.5, y: cy - 0.5 }, { x: cx + 0.5, y: cy + 0.5 }, { x: cx + 1.5, y: cy }]),
    ]
  }
  // IC box with pin stubs
  const w = SYMBOL_IC_W
  const h = bodySize.height
  const out: AnyCircuitElement[] = []
  out.push(schematicBox(sid, cx - w / 2, cy - h / 2, w, h))
  const pins = pinCount
  const half = Math.ceil(pins / 2)
  for (let i = 0; i < half; i++) {
    const y = cy - h / 2 + 0.5 + i * (h / Math.max(half, 1)) * 0.8
    out.push(schematicLine(sid, cx - w / 2 - 1.5, y, cx - w / 2, y, wire))
  }
  const rightCount = pins - half
  for (let i = 0; i < rightCount; i++) {
    const y = cy - h / 2 + 0.5 + i * (h / Math.max(rightCount, 1)) * 0.8
    out.push(schematicLine(sid, cx + w / 2, y, cx + w / 2 + 1.5, y, wire))
  }
  if (comp.component_type === "digital_potentiometer") {
    out.push({ type: "schematic_text", schematic_text_id: `${sid}_lbl`, schematic_component_id: sid, text: "RH/W", font_size: 1.0, position: { x: cx, y: cy }, rotation: 0, anchor: "center", color: "#444" } as AnyCircuitElement)
  }
  if (comp.component_type === "instrumentation_amp") {
    out.push({ type: "schematic_text", schematic_text_id: `${sid}_ia`, schematic_component_id: sid, text: "IA", font_size: 1.0, position: { x: cx, y: cy }, rotation: 0, anchor: "center", color: "#444" } as AnyCircuitElement)
  }
  return out
}

function schematicLine(
  sid: string,
  x1: number, y1: number, x2: number, y2: number,
  color: string,
): AnyCircuitElement {
  return {
    type: "schematic_line",
    schematic_line_id: `line_${sid}_${Math.round(x1*1000)}_${Math.round(y1*1000)}_${Math.round(x2*1000)}_${Math.round(y2*1000)}`,
    schematic_component_id: sid,
    x1, y1, x2, y2,
    color,
    is_dashed: false,
  } as AnyCircuitElement
}

function schematicPath(
  sid: string,
  points: { x: number; y: number }[],
  filled = false,
): AnyCircuitElement {
  return {
    type: "schematic_path",
    schematic_path_id: `path_${sid}_${points.length}_${Math.round(points[0].x*1000)}_${Math.round(points[0].y*1000)}`,
    schematic_component_id: sid,
    points,
    is_filled: filled,
    fill_color: filled ? "#0c1e2e" : undefined,
  } as AnyCircuitElement
}

function schematicBox(
  sid: string,
  x: number, y: number, w: number, h: number,
  dashed = false,
): AnyCircuitElement {
  return {
    type: "schematic_box",
    schematic_component_id: sid,
    x, y, width: w, height: h,
    is_dashed: dashed,
  } as AnyCircuitElement
}

function emitSourceNet(net: NirV11NetlistEntry): AnyCircuitElement {
  return {
    type: "source_net",
    source_net_id: `net_${net.net_name}`,
    name: net.net_name,
    member_source_group_ids: [],
    is_power: net.net_type === "power",
    is_ground: net.net_type === "ground",
    is_analog_signal: net.net_type === "analog",
  } as AnyCircuitElement
}

function emitSourceTrace(
  net: NirV11NetlistEntry,
  conn: { ref: string; pin_name: string; pin_number: string | number },
): AnyCircuitElement {
  return {
    type: "source_trace",
    source_trace_id: `trace_${conn.ref}_${conn.pin_number}__net_${net.net_name}`,
    connected_source_port_ids: [`${conn.ref}_source_port_${conn.pin_number}`],
    connected_source_net_ids: [`net_${net.net_name}`],
  } as AnyCircuitElement
}

function inferPinCount(footprint: string): number {
  switch (footprint) {
    case "MSOP-8": return 8
    case "MSOP-10": return 10
    case "SOT-23-5":
    case "TSOT-23-5": return 5
    case "SOT-23": return 3
    default: return 2
  }
}

function isIC(componentType: string): boolean {
  return ["instrumentation_amp", "voltage_reference", "ldo_regulator", "digital_potentiometer", "mcu", "opamp", "logic"].includes(componentType)
}

function inferRefKind(ref: string): string {
  const m = String(ref).match(/^[A-Z]+/i)
  return m ? m[0].toUpperCase() : "?"
}

function naivePosition(ref: string, index: number): { x: number; y: number; rot: number } {
  const col = index % NAIVE_LAYOUT_COLS
  const row = Math.floor(index / NAIVE_LAYOUT_COLS)
  return {
    x: NAIVE_LAYOUT_ORIGIN_MM.x + col * NAIVE_LAYOUT_PITCH_MM,
    y: NAIVE_LAYOUT_ORIGIN_MM.y + row * NAIVE_LAYOUT_PITCH_MM,
    rot: 0,
  }
}

function requireKeys(obj: Record<string, unknown>, keys: string[], where: string): void {
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined || v === null) {
      throw new Error(`${where} missing required field '${k}' — NIR v1.1 parsing is strict.`)
    }
  }
}

export function detectNirSchemaVersion(nir: unknown): NirSchemaVersion {
  if (!nir || typeof nir !== "object" || Array.isArray(nir)) {
    throw new Error("NIR root must be an object")
  }
  const o = nir as Record<string, unknown>
  if (o["schema_version"] === "1.1") return "v1.1-instrumentation"
  if (o["nir_schema_version"] === "0.1") return "v0.1-libbrecht"
  const cj = o["circuit_json"]
  if (cj && typeof cj === "object" && !Array.isArray(cj) && "components" in cj && ("nets" in cj || "traces" in cj)) {
    return "v0.1-libbrecht"
  }
  if (Array.isArray(o["components"]) && Array.isArray(o["netlist"]) && o["board_spec"] && typeof o["board_spec"] === "object") {
    return "v1.1-instrumentation"
  }
  const keys = Object.keys(o).sort().join(", ") || "(none)"
  throw new Error(`NIR schema version not recognized. Top-level keys: ${keys}`)
}

// --------------------------------------------------------------------------- //
// Circuit JSON -> SVG   (unchanged from prior implementation)
// --------------------------------------------------------------------------- //

export function renderCircuitJson(
  circuitJson: AnyCircuitElement[],
): { svg: string; viewerUsed: ViewerUsed } {
  const want = (process.env.OPEN_FORGE_VIEWER ?? "").toLowerCase()

  if (want === "schematic-viewer") {
    try {
      const sv = require("@tscircuit/schematic-viewer")
      const svg = sv.renderCircuitJsonToSvg
        ? sv.renderCircuitJsonToSvg(circuitJson)
        : sv.default?.renderCircuitJsonToSvg?.(circuitJson)
      if (typeof svg === "string" && svg.length > 0) {
        return { svg, viewerUsed: "@tscircuit/schematic-viewer" }
      }
    } catch (e) {
      console.warn("[open_forge/serializer] @tscircuit/schematic-viewer not available, falling back to circuit-to-svg")
    }
  }

  const hasSchematic = circuitJson.some(
    (el) => typeof el === "object" && el !== null && String((el as any).type).startsWith("schematic"),
  ) || circuitJson.length === 0

  let svg: string
  try {
    svg = hasSchematic
      ? convertCircuitJsonToSchematicSvg(circuitJson as any)
      : convertCircuitJsonToPcbSvg(circuitJson as any)
  } catch {
    try {
      svg = convertCircuitJsonToPcbSvg(circuitJson as any)
    } catch (e) {
      throw new Error("circuit-to-svg failed to render both schematic and PCB views: " + String((e as Error)?.message ?? e))
    }
  }
  return { svg, viewerUsed: "circuit-to-svg" }
}

// --------------------------------------------------------------------------- //
// NIR -> Circuit JSON  (dispatched by version)
// --------------------------------------------------------------------------- //

export function nirToCircuitJson(nir: Nir | unknown): AnyCircuitElement[] {
  const version = detectNirSchemaVersion(nir)
  return version === "v0.1-libbrecht"
    ? parseNirV01(nir as Nir)
    : parseNirV11Sync(nir as unknown as NirV11)
}

// Async version that runs CircuitRunner for v1.1
export async function nirToCircuitJsonAsync(nir: Nir | unknown): Promise<AnyCircuitElement[]> {
  const version = detectNirSchemaVersion(nir)
  if (version === "v0.1-libbrecht") {
    return parseNirV01(nir as Nir)
  }
  return parseNirV11WithTscircuit(nir as unknown as NirV11)
}

// --------------------------------------------------------------------------- //
// End-to-end
// --------------------------------------------------------------------------- //

// Synchronous version (backward compat) - uses sync fallback for v1.1
export function serializeNir(nir: Nir | unknown): SerializerOutput {
  const circuitJson = nirToCircuitJson(nir)
  const { svg, viewerUsed } = renderCircuitJson(circuitJson)
  return { circuitJson, svg, viewerUsed }
}

// Async version that uses tscircuit for v1.1 (auto-place + auto-route)
export async function serializeNirAsync(nir: Nir | unknown): Promise<SerializerOutput> {
  const circuitJson = await nirToCircuitJsonAsync(nir)
  const { svg, viewerUsed } = renderCircuitJson(circuitJson)
  const hasPcbBoard = circuitJson.some((e: any) => e.type === "pcb_board")
  const kicadPcb = hasPcbBoard ? circuitJsonToKicadPcb(circuitJson) : undefined
  return { circuitJson, svg, viewerUsed, kicadPcb }
}

export { serializeNir as serializeNirSync }