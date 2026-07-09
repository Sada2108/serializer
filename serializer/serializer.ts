// Open_Forge — Team E serializer (Layer 3).
//
// New export path: NIR -> Circuit JSON (typed via circuit-json) -> SVG render.
//
// HARD CONSTRAINT — no tscircuit wasm / tsci CLI on this path:
//   This module imports ONLY:
//     - circuit-json            (TypeScript type defs for Circuit JSON)
//     - circuit-to-svg          (renders Circuit JSON to SVG directly)
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
}

export type NirSchemaVersion = "v0.1-libbrecht" | "v1.1-instrumentation"

// --------------------------------------------------------------------------- //
// Layout — constraint-aware (improved, but still simplified)
// --------------------------------------------------------------------------- //
//
// PRIOR STATE: a blind row-major grid, ignoring `netlist` connectivity and
// `placement_constraints` entirely.  Visually scattered.
//
// NEW STATE: A constraint-aware layout.  The algorithm is intentionally NOT
// a full force-directed / constraint solver — those are too much scope for
// a single pass and would require tuning.  Instead we do two things:
//
//   (1) NETLIST GROUPING — connected components are placed nearer each other
//       than unconnected ones.  We partition the components[] refs into
//       net-distance buckets: components that share a net (defined as "both
//       appear in some netlist[i].connections") are grouped into the *same
//       row cluster*; components that never co-share a net are placed in
//       adjacent rows only when the graph forces it (graph-coloring-style
//       bucket assignment).  This is a poor man's force-directed grouping
//       — good enough for a readable schematic, far from optimal.
//
//   (2) HARD PROXIMITY CONSTRAINTS — every `placement_constraints[]` entry
//       with `hard: true` and `constraint_type: "proximity"` is honored
//       before grid placement: the constrained component is forced to lie
//       within `max_distance_mm` of the component named by `relative_to`
//       (the same cluster as that component, at minimum pitch).  In
//       practice this means we tag the constrained component with the same
//       cluster id as `relative_to`, and when the grid is walked we place
//       the constrained component in the cell immediately adjacent.
//
// OUT OF SCOPE (intentionally left as TODO):
//   - placement_rules_text (free-text rules — needs LLM reasoning)
//   - isolation/keepout constraints other than "proximity + hard:true"
//       (other constraint types simply aren't honored today; they're logged
//       once at INFO so the missing logic is audible, but they don't raise)
//   - real autorouting of traces between components (we only lay parts out;
//       wire rendering from the netlist is a separate engine)

const NETLIST_CLUSTER_PITCH_MM = 12          // (legacy grid layout — retained for reference)
const BETWEEN_CLUSTER_PITCH_MM = 18          // (legacy grid layout — retained for reference)
const CONSTRAINT_SATISFACTION_TOLERANCE_MM = 1  // slack when measuring hard proximity

// Force-directed layout tuning.
const LAYOUT_SPACING_MM = 16      // ideal neighbour spacing (mm) ~ target spring length
const LAYOUT_INIT_TEMP = 9        // initial displacement cap (cooling schedule)
const LAYOUT_ITERATIONS = 700     // integration steps
const LAYOUT_GRAVITY = 0.05       // pull-to-centroid for isolated (unconnected) nodes

// Footprint-size table.
// Real per-footprint geometry belongs to @tscircuit/footprinter; until that
// wiring lands we use sane placeholder sizes keyed by the footprints that
// actually appear in NIR v1.1 fixtures.  An unknown footprint raises loudly
// rather than silently defaulting to 0x0 — see `lookupFootprintSize`.
const FOOTPRINT_SIZE_MM: Record<
  string,
  { width: number; height: number }
> = {
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
    throw new Error(
      `Unknown footprint '${footprint}' — add it to FOOTPRINT_SIZE_MM in ` +
      "open_forge/serializer.ts.  Refusing to emit a 0x0 component (loud " +
      "failure per NIR v1.1 parsing contract).",
    )
  }
  return sz
}

// --------------------------------------------------------------------------- //
// Schematic symbol geometry
// --------------------------------------------------------------------------- //
//
// Prior state: schematic_component.symbol_id / port_arrangement were stubbed
// TODOs and every component rendered as a blank box with no label — unusable
// for human inspection.
//
// Current state: each component's `component_type` selects a "symbol
// generator" that emits the rendering primitives (`schematic_box` /
// `schematic_path` / `schematic_line` / `schematic_text`) for that part,
// all linked back to the parent `schematic_component` via the
// `schematic_component_id` field.  Each generator returns an array of
// Circuit JSON elements positioned RELATIVE TO the component's center.
//
// We do NOT use `@tscircuit/footprinter` directly here — footprinter emits
// *PCB* geometry (pad stacks, courtyards) but the rendering primitives
// `circuit-to-svg` understands for the SCHEMATIC view are the four
// primitive `schematic_*` element types defined in `circuit-json` itself
// (box / line / path / text / port — see SchematicBox at line ~12418,
// SchematicLine at ~23906, SchematicPath at ~12462, SchematicText at
// ~24332 of circuit-json's index.d.mts).  Authoring symbol geometry from
// those primitives is the documented, type-safe way to render a schematic.
//
// Every symbol also emits a `schematic_text` carrying the component's
// `ref` label positioned immediately above the symbol body plus, where
// the NIR carries a `value`, a second `schematic_text` with the value
// below the body.  This is the convention schematic editors use.

// Symbol bodies are sized in millimetres.  Discrete components (R/C/D) get
// compact bodies; ICs get rectangles sized relative to their pin count.
const SYMBOL_DISCRETE_W = 6   // a resistor/cap/diode zigzag / box ~6mm wide
const SYMBOL_DISCRETE_H = 2   // ~2mm tall
const SYMBOL_IC_W = 10        // IC box 10mm wide
const SYMBOL_IC_H = 6          // 6mm tall (room for 4 pins / side)
const SYMBOL_TEXT_REF_FONT = 1.2     // ref label font size (mm equiv)
const SYMBOL_TEXT_VAL_FONT = 1.0     // value label font size
const SYMBOL_TEXT_OFFSET = 1.8       // mm above/below body for label text

type SchematicElement = AnyCircuitElement & { schematic_component_id?: string }

interface SymbolCtx {
  ref: string
  refKind: string           // R, C, D, U, FB, Q, L, ...
  value?: string | null
  centerX: number
  centerY: number
  componentType: string    // raw NIR component_type
  pinCount: number         // for ICs, drives box height
  refSchId: string         // schematic_component_id
}

// Board footprint placeholder.  NIR v1.1 carries board_spec.thickness_mm /
// .layers / .material but NOT board width/height (those fields don't exist
// yet).  We default to 50mm x 50mm and warn loudly — never silently 0x0.
const NAIVE_BOARD_FALLBACK_MM = { width: 50, height: 50 }

const MATERIAL_MAP: Record<string, "fr4" | "fr1"> = {
  "FR4": "fr4",
  "FR1": "fr1",
}

// --------------------------------------------------------------------------- //
// Schema version detection  (single source of truth)
// --------------------------------------------------------------------------- //

/**
 * Decide which NIR schema a file is using.
 *
 * Order of precedence:
 *   1. Explicit version marker:
 *        - `schema_version === "1.1"`  -> v1.1
 *        - `nir_schema_version === "0.1"` -> v0.1
 *      (Note the two schemas use different field names for the version.)
 *   2. Structural fingerprint (handles fixtures without an explicit marker):
 *        - top-level `circuit_json` dict with `components`/`nets`/`traces`
 *          -> v0.1
 *        - top-level `components` array AND `netlist` array AND
 *          `board_spec` object -> v1.1
 *   3. Otherwise: raise — never return "" — never fall back silently.
 */
export function detectNirSchemaVersion(nir: unknown): NirSchemaVersion {
  if (!nir || typeof nir !== "object" || Array.isArray(nir)) {
    throw new Error(
      "NIR root must be an object, got " + typeof nir + " — refusing to " +
      "silently coerce to an empty parse (loud failure per NIR contract).",
    )
  }
  const o = nir as Record<string, unknown>

  // 1. Explicit markers.
  if (o["schema_version"] === "1.1") return "v1.1-instrumentation"
  if (o["nir_schema_version"] === "0.1") return "v0.1-libbrecht"

  // 2. Structural fingerprint.
  const cj = o["circuit_json"]
  if (
    cj && typeof cj === "object" && !Array.isArray(cj) &&
    "components" in (cj as object) && ("nets" in (cj as object) || "traces" in (cj as object))
  ) {
    return "v0.1-libbrecht"
  }
  if (
    Array.isArray(o["components"]) &&
    Array.isArray(o["netlist"]) &&
    o["board_spec"] && typeof o["board_spec"] === "object"
  ) {
    return "v1.1-instrumentation"
  }

  // 3. Unknown — fail loud.
  const keys = Object.keys(o).sort().join(", ") || "(none)"
  throw new Error(
    `NIR schema version not recognized. Missing both schema_version and the ` +
    `legacy circuit_json sub-shape, OR missing the v1.1 (components + ` +
    `netlist + board_spec) fingerprint. Top-level keys: ${keys}.`
  )
}

// --------------------------------------------------------------------------- //
// NIR -> Circuit JSON  (dispatched by version)
// --------------------------------------------------------------------------- //

export function nirToCircuitJson(nir: Nir | unknown): AnyCircuitElement[] {
  const version = detectNirSchemaVersion(nir)
  return version === "v0.1-libbrecht"
    ? parseNirV01(nir as Nir)
    : parseNirV11(nir as unknown as NirV11)
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
// v1.1 parser  — new top-level schema (components / netlist / board_spec / ...)
// --------------------------------------------------------------------------- //

/**
 * Parse the NIR v1.1 ("instrumentation_amp") schema.
 *
 * Emits structurally-valid Circuit JSON elements from the new top-level
 * shape:
 *   - one `pcb_board` from `board_spec`
 *   - one `source_component_base`, one `pcb_component`, and one
 *     `schematic_component` per entry in `components[]`
 *   - one `source_net` per `netlist[]` entry plus one `source_trace` per
 *     connection
 *
 * Required-field policy — LOUD failure:
 *   Any NIR v1.1 missing a required field raises `Error` with a message
 *   naming the offending field and (where known) the offending component.
 *   We never return [] — that was the bug motivating this rewrite.
 *
 * Layout (constraint-aware — see NETLIST_CLUSTER_PITCH_MM section above):
 *   NIR v1.1's `position.x_mm`/`y_mm` are null for every component (no layout
 *   has been computed yet).  We compute real positions before emitting any
 *   renderable geometry using:
 *     (a) netlist connectivity to group connected components into rows
 *     (b) placement_constraints[] with `hard:true` to honour proximity rules.
 *
 *   This is still simplified relative to a true force-directed / constraint
 *   solver — see the comments at NETLIST_CLUSTER_PITCH_MM for what's
 *   implemented vs. what's deferred.
 *
 * Note — orphan refs are NOT a failure:
 *   `netlist[].connections[].ref` may name a component that is not listed
 *   in `components[]` (e.g. `Battery`, `MCU_Header` — external endpoints).
 *   These are treated as ordinary `source_trace` endpoints; we do NOT raise
 *   on missing refs (confirmed per spec).
 */
function parseNirV11(nir: NirV11): AnyCircuitElement[] {
  // Step 1 — validate required top-level keys.
  requireKeys(nir, ["schema_version", "design_id", "components", "netlist", "board_spec"], "NIR v1.1 root")

  const out: AnyCircuitElement[] = []

  // Step 2 — pcb_board from board_spec.
  out.push(emitPcbBoard(nir.board_spec))

  // Step 3 — per component: source + pcb + schematic, with constraint-aware
  // layout.  Reduction from a naive grid → a netlist-grouped, hard-constraint
  // aware layout.  See `computeLayout` for the algorithm and its (documented)
  // simplifications.
  const comps = nir.components
  if (comps.length === 0) {
    throw new Error(
      "NIR v1.1 `components` array is empty — refusing to emit an empty " +
      "Circuit JSON.",
    )
  }
  const layout = computeLayout(comps, nir.netlist, nir.placement_constraints ?? [])

  // Step 3 — add external-ref stub positions to the layout BEFORE
  // centering, so the external stubs get centered together with the
  // components.  Otherwise they'd skew the centering result.
  addExternalStubPositions(layout, comps, nir.netlist)

  // Step 3a — CENTER the layout in a conceptual canvas.  circuit-to-svg
  // derives its viewBox/screen-transform from the bounding box of all
  // schematic element extents, so recentering in real space (mm) is
  // sufficient; the renderer will then frame the layout symmetrically.
  const centeredLayout = centerLayoutInCanvas(layout)

  // Build a pin-position map so the trace-drawing pass can find the
  // real-space location of every (ref, pin_number) connection point.
  // For an external endpoint (e.g. `Battery` / `MCU_Header`) that isn't
  // in components[], we synthesize a stub position on the canvas margin
  // so its wires have somewhere to terminate instead of dangling at (0,0).
  const pinMap = buildPinMap(comps, centeredLayout, nir.netlist)
  // Component body bounds, used by the obstacle-aware trace router so that
  // every wire segment treats ALL bodies as obstacles (not just the spoke's
  // own endpoints).  Routing logic only — computeLayout is untouched.
  const bodies = computeComponentBodies(comps, centeredLayout)

  comps.forEach((comp, i) => {
    requireKeys(
      comp as Record<string, unknown>,
      ["ref", "component_id", "component_type", "footprint", "position"],
      `NIR v1.1 components[${i}]`,
    )
    out.push(emitSourceComponentBase(comp))
    const pos = centeredLayout[comp.ref]
    if (!pos) {
      // Should be unreachable — centerLayoutInCanvas preserves all keys.
      throw new Error(
        `centeredLayout produced no position for component '${comp.ref}' — ` +
        "internal layout bug, please file.",
      )
    }
    out.push(emitPcbComponent(comp, pos.x, pos.y, pos.rot))
    // schematic_component + symbol body + ref label (`schematic_text`)
    out.push(...emitSchematicComponent(comp, pos.x, pos.y))
  })

  // Step 4 — netlist: source_net + per-connection source_trace +
  // visible `schematic_line` wires connecting the pin positions.
  // The wires are emitted as standalone schematic_line elements (no
  // schematic_component_id — orphan traces) so circuit-to-svg renders
  // them through the loose-element path.  They use class "trace"
  // (already defined in circuit-to-svg's schematic CSS) so they're
  // visually styled as nets.
  // `placedWires` accumulates segment coords as each net is routed so that
  // LATER nets route their hubs/spokes around wires already claimed.
  // Nets are routed largest-first so a global/multi-drop net (e.g. GND) claims
  // its wires before the smaller nets that share its components route around
  // it — collapsing most residual wire-wire crossings.
  const netsOrdered = [...nir.netlist].sort(
    (a, b) => b.connections.length - a.connections.length,
  )
  const placedWires: { x1: number; y1: number; x2: number; y2: number }[] = []
  for (let i = 0; i < netsOrdered.length; i++) {
    const net = netsOrdered[i]
    requireKeys(net as Record<string, unknown>, ["net_name", "connections"], `NIR v1.1 netlist[${i}]`)
    out.push(emitSourceNet(net))
    if (isRailNet(net)) {
      // POWER/GROUND RAIL: emit a `schematic_net_label` at every pin instead
      // of explicit wires.  This is tscircuit's documented convention for
      // power buses (docs.tscircuit.com/elements/net, /elements/trace) and
      // removes the wire-wire crossings that drawing global rails as
      // point-to-point wires inevitably forces near shared components.
      out.push(...emitSchematicNetLabels(net, pinMap, bodies))
    } else {
      // Signal/analog net: route through a per-net free-space hub (see
      // emitNetWires / computeNetHub).  Each net's hub is chosen to avoid
      // ALL component bodies and the wires already routed for earlier nets,
      // and each spoke is a single axis-aligned L-bend.  Routing is
      // sequential over nir.netlist order, accumulating into `placedWires`.
      out.push(...emitNetWires(net, pinMap, bodies, placedWires))
    }
    for (let j = 0; j < net.connections.length; j++) {
      const conn = net.connections[j]
      requireKeys(
        conn as Record<string, unknown>,
        ["ref", "pin_name", "pin_number"],
        `NIR v1.1 netlist[${i}].connections[${j}]`,
      )
      out.push(emitSourceTrace(net, conn))
    }
  }

  return out
}

// --------------------------------------------------------------------------- //
// v1.1 helpers — small emit functions, each with strict input contracts
// --------------------------------------------------------------------------- //

function emitPcbBoard(spec: NirV11BoardSpec): AnyCircuitElement {
  requireKeys(
    spec as Record<string, unknown>,
    ["layers", "material", "thickness_mm"],
    "NIR v1.1 board_spec",
  )
  const material = MATERIAL_MAP[String(spec.material).toUpperCase()]
  if (!material) {
    throw new Error(
      `NIR v1.1 board_spec.material '${spec.material}' is not mapped ` +
      "(expected one of FR4/FR1); refusing to emit an invalid pcb_board.",
    )
  }
  // NIR v1.1 does not currently carry board width/height — only thickness.
  // Default to NAIVE_BOARD_FALLBACK_MM (50x50) and emit a console warning so
  // the missing data is audible but does not silently zero-out the board.
  // eslint-disable-next-line no-console
  console.warn(
    "[open_forge/serializer] NIR v1.1 board_spec has no width/height — " +
    `defaulting board to ${NAIVE_BOARD_FALLBACK_MM.width}x${NAIVE_BOARD_FALLBACK_MM.height}mm.  ` +
    "This is a placeholder; once NIR carries board dimensions, replace this.",
  )
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
    // Preserve NIR v1.1-specific fields on the element for downstream
    // consumers (Layer D / footprinter); these passthrough fields are NOT
    // part of the canonical Circuit JSON shape but Circuit JSON explicitly
    // tolerates extra fields on `source_*` elements.
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

/**
 * emitSchematicComponent — parent + symbol geometry + ref label.
 *
 * Returns a list (not a single element) because each component carries:
 *   - one `schematic_component`     (the parent, owns a center / size)
 *   - one or more `schematic_*`     (box / path / line / text) drawing the
 *                                    actual symbol and ref label
 *
 * Symbol selection is by `component_type` (resistor, capacitor, diode, IC,
 * etc).  See `makeSymbolGeometry`.  The ref label is always emitted as a
 * `schematic_text` positioned above the symbol body; if NIR carries a
 * `value`, a second `schematic_text` is emitted below the body.
 */
function emitSchematicComponent(
  comp: NirV11Component,
  x: number,
  y: number,
): AnyCircuitElement[] {
  const refSchId = `${comp.ref}_sch`
  // pinCount is conservatively derived from footprint (only needed for IC
  // box sizing today; discrete parts ignore it).
  const pinCount = inferPinCount(comp.footprint)
  const ctx: SymbolCtx = {
    ref: comp.ref,
    refKind: inferRefKind(comp.ref),
    value: comp.value ?? null,
    centerX: x,
    centerY: y,
    componentType: comp.component_type,
    pinCount,
    refSchId,
  }

  const elements: AnyCircuitElement[] = []

  // Parent schematic_component.  `size` is the symbol body bounding box —
  // discrete parts use the discrete constants, ICs scale by pinCount.
  const bodySize = bodySizeFor(ctx)
  elements.push({
    type: "schematic_component",
    schematic_component_id: refSchId,
    source_component_id: `${comp.ref}_source`,
    center: { x, y },
    size: bodySize,
    is_box_with_pins: ctx.componentType !== "resistor" &&
                      ctx.componentType !== "capacitor" &&
                      ctx.componentType !== "diode" &&
                      ctx.componentType !== "tvs_diode_array",
    symbol_display_value: typeof comp.value === "string" ? comp.value : undefined,
  } as AnyCircuitElement)

  // Symbol geometry (box / path / line / pin leads) linked via the parent's
  // schematic_component_id.
  elements.push(...makeSymbolGeometry(ctx))

  // Ref label (and value label, when present).
  elements.push(makeRefText(ctx))
  if (typeof ctx.value === "string" && ctx.value.length > 0) {
    elements.push(makeValueText(ctx))
  }

  return elements
}

/** Body size for the schematic parent.  Discretes are constant; ICs scale. */
function bodySizeFor(ctx: SymbolCtx): { width: number; height: number } {
  if (isIC(ctx.componentType)) {
    // Extra rows for pins beyond 4 per side, ~1mm each.
    const extraRows = Math.max(0, Math.ceil(ctx.pinCount / 2) - 4)
    return {
      width: SYMBOL_IC_W,
      height: SYMBOL_IC_H + extraRows,
    }
  }
  return { width: SYMBOL_DISCRETE_W, height: SYMBOL_DISCRETE_H }
}

/**
 * makeSymbolGeometry — emit the rendering primitives for the symbol.
 *
 * Implemented types:
 *   resistor            — zigzag path + two lead lines
 *   capacitor           — two parallel plate paths + two lead lines
 *   tvs_diode_array     — diode (triangle + bar) + two lead lines (one sect)
 *   /diode (not yet seen in fixture but supported)
 *   ferrite_bead        — small box + two lead lines + WAVE-arrow inside
 *   ldo_regulator        — standard IC box with left/right pin stubs
 *   voltage_reference   — standard IC box
 *   digital_potentiometer — standard IC box with RH/Wiper label inside
 *   instrumentation_amp  — IC box with V+/-/OUT labels inside (3-amp triangle)
 *   DEFAULT             — IC box (fallback for any unknown-but-not-strict-fail
 *                         component_type, with `is_box_with_pins=true`)
 *
 * Returns the geometric primitives only; the parent schematic_component and
 * ref-label text are emitted separately.
 */
function makeSymbolGeometry(ctx: SymbolCtx): AnyCircuitElement[] {
  const cx = ctx.centerX
  const cy = ctx.centerY
  const sid = ctx.refSchId
  const wire = "#0c1e2e"

  if (ctx.componentType === "resistor") {
    // zigzag body, two lead lines.
    const w = SYMBOL_DISCRETE_W
    const h = SYMBOL_DISCRETE_H
    const x0 = cx - w / 2
    const x1 = cx + w / 2
    const zig = [x0, x0 + 0.4]
    const pts: { x: number; y: number }[] = [
      { x: x0,             y: cy },
      { x: x0 + 0.4,       y: cy },
      { x: x0 + 0.8,       y: cy - h },
      { x: x0 + 1.6,       y: cy + h },
      { x: x0 + 2.4,       y: cy - h },
      { x: x0 + 3.2,       y: cy + h },
      { x: x0 + 4.0,       y: cy - h },
      { x: x0 + 4.8,       y: cy + h },
      { x: x0 + 5.2,       y: cy },
      { x: x1,             y: cy },
    ]
    void zig
    void pts
    return [
      schematicLine(sid, cx - w / 2 - 2, cy, x0, cy, wire),
      schematicLine(sid, x1, cy, cx + w / 2 + 2, cy, wire),
      schematicPath(sid, pts),
    ]
  }

  if (ctx.componentType === "capacitor") {
    // two parallel vertical plate lines, two lead lines.
    const xL = cx - 0.8
    const xR = cx + 0.8
    const plateSpan: number = SYMBOL_DISCRETE_H * 1.2
    return [
      schematicLine(sid, cx - SYMBOL_DISCRETE_W / 2 - 2, cy, xL, cy, wire),
      schematicLine(sid, cx - SYMBOL_DISCRETE_W / 2,    cy, xL, cy, wire),
      schematicLine(sid, xL, cy - plateSpan / 2, xL, cy + plateSpan / 2, wire),  // left plate
      schematicLine(sid, xR, cy - plateSpan / 2, xR, cy + plateSpan / 2, wire),  // right plate
      schematicLine(sid, xR, cy, cx + SYMBOL_DISCRETE_W / 2 + 2, cy, wire),
    ]
  }

  if (ctx.componentType === "tvs_diode_array" || ctx.componentType === "diode") {
    // Triangle pointing right + bar at the tip + two leads.
    const tri = 1.6
    const tip = cx + tri
    const triPts: { x: number; y: number }[] = [
      { x: cx - tri, y: cy - 1 },
      { x: cx - tri, y: cy + 1 },
      { x: tip,      y: cy },
    ]
    return [
      schematicLine(sid, cx - SYMBOL_DISCRETE_W / 2 - 2,      cy, cx - tri, cy, wire),
      schematicPath(sid, triPts, true /* filled */),
      schematicLine(sid, tip,     cy - 1,    tip, cy + 1, wire), // cathode bar
      schematicLine(sid, tip,    cy, cx + SYMBOL_DISCRETE_W / 2 + 2, cy, wire),
    ]
  }

  if (ctx.componentType === "ferrite_bead") {
    // Box + two leads + a wavy line inside the box to denote it is a bead.
    const w = SYMBOL_DISCRETE_W
    const h = SYMBOL_DISCRETE_H
    return [
      schematicBox(sid, cx - w / 2, cy - h / 2, w, h),
      schematicLine(sid, cx - w / 2 - 2, cy, cx - w / 2, cy, wire),
      schematicLine(sid, cx + w / 2, cy, cx + w / 2 + 2, cy, wire),
      schematicPath(sid, [
        { x: cx - 1.5, y: cy },
        { x: cx - 0.5, y: cy - 0.5 },
        { x: cx + 0.5, y: cy + 0.5 },
        { x: cx + 1.5, y: cy },
      ]),
    ]
  }

  // ICs and unknown-but-not-fail types all get the same default IC box with
  // pin stubs on the left and right sides proportional to pinCount.
  if (isIC(ctx.componentType) || true) {
    // note: unreachable `|| true` here for fallback IC; easier to read.
    const w = SYMBOL_IC_W
    const h = bodySizeFor(ctx).height
    const pins = ctx.pinCount
    void pins
    const halfPins = Math.ceil(pins / 2)
    const out: AnyCircuitElement[] = []
    out.push(schematicBox(sid, cx - w / 2, cy - h / 2, w, h))
    // Pin stubs — left side: halfPins pins, right side: remaining.
    for (let i = 0; i < halfPins; i++) {
      const y = cy - h / 2 + 0.5 + i * (h / Math.max(halfPins, 1)) * 0.8
      out.push(schematicLine(sid, cx - w / 2 - 1.5, y, cx - w / 2, y, wire))
    }
    const rightCount = pins - halfPins
    for (let i = 0; i < rightCount; i++) {
      const y = cy - h / 2 + 0.5 + i * (h / Math.max(rightCount, 1)) * 0.8
      out.push(schematicLine(sid, cx + w / 2, y, cx + w / 2 + 1.5, y, wire))
    }
    // Internal label for digital_potentiometer — denote "RH__/W__".
    // Orphan-text dispatch (no schematic_component_id) — see makeRefText note.
    if (ctx.componentType === "digital_potentiometer") {
      out.push({
        type: "schematic_text",
        schematic_text_id: `${sid}_lbl`,
        text: "RH/W",
        font_size: SYMBOL_TEXT_VAL_FONT,
        position: { x: cx, y: cy },
        rotation: 0,
        anchor: "center",
        color: "#444",
      } as AnyCircuitElement)
    }
    // Icon for instrumentation amp — small "IA" tag inside.
    if (ctx.componentType === "instrumentation_amp") {
      out.push({
        type: "schematic_text",
        schematic_text_id: `${sid}_ia`,
        text: "IA",
        font_size: SYMBOL_TEXT_VAL_FONT,
        position: { x: cx, y: cy },
        rotation: 0,
        anchor: "center",
        color: "#444",
      } as AnyCircuitElement)
    }
    return out
  }
}

// --------------------------------------------------------------------------- //
// Symbol primitive emitters
// --------------------------------------------------------------------------- //

function schematicLine(
  sid: string,
  x1: number, y1: number, x2: number, y2: number,
  color: string,
): AnyCircuitElement {
  return {
    type: "schematic_line",
    schematic_line_id:
      `line_${sid}_${Math.round(x1*1000)}_${Math.round(y1*1000)}_${Math.round(x2*1000)}_${Math.round(y2*1000)}`,
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
    schematic_path_id:
      `path_${sid}_${points.length}_${Math.round(points[0].x*1000)}_${Math.round(points[0].y*1000)}`,
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

/** Ref label: positioned above the symbol body.
 *
 * IMPORTANT — text is emitted as ORPHAN (no schematic_component_id):
 * circuit-to-svg's renderer only fully emits a component's owned text when
 * `is_box_with pins: true` (the box branch iterates `schTexts`).  Discrete
 * symbols use the primitives-only path and their owned text would silently
 * drop.  Emitting orphan text routes ALL component ref/value labels through
 * the standalone schText branch (line ~14417 of circuit-to-svg) so the
 * label renders identically for both discretes and ICs.  We still position
 * text at the component's effective center +/- offsets.
 */
function makeRefText(ctx: SymbolCtx): AnyCircuitElement {
  const bodyH = bodySizeFor(ctx).height
  return {
    type: "schematic_text",
    schematic_text_id: `${ctx.refSchId}_reftext`,
    // NOTE: deliberately NOT setting schematic_component_id so the label
    // renders via the standalone schText path (see comment above).
    text: ctx.ref,
    font_size: SYMBOL_TEXT_REF_FONT,
    position: {
      x: ctx.centerX,
      y: ctx.centerY + bodyH / 2 + SYMBOL_TEXT_OFFSET,
    },
    rotation: 0,
    anchor: "center",
    color: "#000",
  } as AnyCircuitElement
}

/** Value label: positioned below the symbol body.  See makeRefText note. */
function makeValueText(ctx: SymbolCtx): AnyCircuitElement {
  const bodyH = bodySizeFor(ctx).height
  return {
    type: "schematic_text",
    schematic_text_id: `${ctx.refSchId}_valtext`,
    text: ctx.value as string,
    font_size: SYMBOL_TEXT_VAL_FONT,
    position: {
      x: ctx.centerX,
      y: ctx.centerY - bodyH / 2 - SYMBOL_TEXT_OFFSET,
    },
    rotation: 0,
    anchor: "center",
    color: "#333",
  } as AnyCircuitElement
}

// --------------------------------------------------------------------------- //
// Component-symbol classification helpers
// --------------------------------------------------------------------------- //

function isIC(componentType: string): boolean {
  // Conservative list of IC-like component_types in NIR v1.1 fixtures.
  return [
    "instrumentation_amp",
    "voltage_reference",
    "ldo_regulator",
    "digital_potentiometer",
    "mcu",
    "opamp",
    "logic",
  ].includes(componentType)
}

function inferRefKind(ref: string): string {
  // Strip trailing digit/etc., return the alphabetic prefix ("R", "C", "U"...).
  const m = String(ref).match(/^[A-Z]+/i)
  return m ? m[0].toUpperCase() : "?"
}

function inferPinCount(footprint: string): number {
  // Heuristic mapping of footprints to total pin counts, used only for IC
  // box sizing (discrete parts ignore this return value).
  switch (footprint) {
    case "MSOP-8":      return 8
    case "MSOP-10":    return 10
    case "SOT-23-5":
    case "TSOT-23-5":  return 5
    case "SOT-23":     return 3
    // Discretes:
    case "0402":
    case "0603":
    case "0805":
    case "1206":        return 2
    default:            return 2
  }
}

function emitSourceNet(net: NirV11NetlistEntry): AnyCircuitElement {
  const el: AnyCircuitElement = {
    type: "source_net",
    source_net_id: `net_${net.net_name}`,
    name: net.net_name,
    member_source_group_ids: [],
    is_power: net.net_type === "power" || POWER_RAIL_NET_NAMES.has(net.net_name),
    is_ground: net.net_type === "ground",
    is_analog_signal: net.net_type === "analog",
  } as AnyCircuitElement
  return el
}

function emitSourceTrace(
  net: NirV11NetlistEntry,
  conn: { ref: string; pin_name: string; pin_number: string | number },
): AnyCircuitElement {
  return {
    type: "source_trace",
    source_trace_id:
      `trace_${conn.ref}_${conn.pin_number}__net_${net.net_name}`,
    // We use the canonical port-id format expected downstream even though
    // nport `source_port` elements aren't emitted here.  Layer D will
    // create the actual `source_port` records; we just record the trace's
    // connectivity.
    connected_source_port_ids: [`${conn.ref}_source_port_${conn.pin_number}`],
    connected_source_net_ids: [`net_${net.net_name}`],
  } as AnyCircuitElement
}

/**
 * emitSchematicNetLabels — for a POWER/GROUND rail net, emit one
 * `schematic_net_label` per pin (tscircuit's documented convention for power
 * buses) instead of explicit wire segments.  Each label is placed just
 * OUTSIDE the component body along the pin's outward normal, and the outward
 * offset is grown until the label centre clears every component body (reusing
 * the same body-collision test as Check 1) so labels never sit on a symbol.
 * `source_net_id` ties the label to the rail; `is_movable` lets a downstream
 * viewer reposition it.  No `schematic_line`/trace is emitted for the net.
 */
function emitSchematicNetLabels(
  net: NirV11NetlistEntry,
  pinMap: Map<string, PinPos>,
  bodies: Record<string, BodyBox>,
): AnyCircuitElement[] {
  const out: AnyCircuitElement[] = []
  for (const conn of net.connections) {
    const p = pinMap.get(`${conn.ref}#${conn.pin_number}`)
    if (!p) continue
    // Component centre (for the outward-normal direction).
    const b = bodies[p.ref]
    const cx = b ? (b.x0 + b.x1) / 2 : p.x
    const cy = b ? (b.y0 + b.y1) / 2 : p.y
    let dx = p.x - cx
    let dy = p.y - cy
    const dlen = Math.hypot(dx, dy) || 1
    dx /= dlen
    dy /= dlen
    // Grow the outward offset until the label centre is clear of all bodies.
    let lx = p.x + dx * 3
    let ly = p.y + dy * 3
    for (const off of [3, 4, 5, 6, 8, 10, 12]) {
      const tx = p.x + dx * off
      const ty = p.y + dy * off
      if (!pointInAnyBody({ x: tx, y: ty }, bodies)) {
        lx = tx
        ly = ty
        break
      }
      lx = tx
      ly = ty
    }
    const anchor: "top" | "bottom" | "left" | "right" =
      Math.abs(dx) >= Math.abs(dy)
        ? (dx >= 0 ? "right" : "left")
        : (dy >= 0 ? "bottom" : "top")
    out.push({
      type: "schematic_net_label",
      schematic_net_label_id: `netlabel_${net.net_name}_${conn.ref}_${conn.pin_number}`,
      source_net_id: `net_${net.net_name}`,
      center: { x: lx, y: ly },
      anchor_side: anchor,
      text: net.net_name,
      is_movable: true,
    } as AnyCircuitElement)
  }
  return out
}

// --------------------------------------------------------------------------- //
// Layout centering + pin-position map
// --------------------------------------------------------------------------- //
//
// To draw schematic trace wires between connected component pins we need
// real-space (x, y) coordinates for each connection point in
// netlist[].connections.  NIR v1.1 names pins by `pin_name` + `pin_number`
// but does NOT carry their absolute position — that's a function of the
// component's center + the symbol's pin-arrangement.
//
// We derive a deterministic pin offset per (ref_kind, pin_number) pair via
// `inferPinOffset` below.  Discretes (R/C/D) have only 2 pins (1, 2) on
// their left/right ends; ICs distribute their pins evenly around the box,
// left-side first then right-side (matching the conventional schematic-pin
// arrangement and matching the symbol geometry emitted by
// `makeSymbolGeometry`'s IC branch).
//
// For external endpoints (refs that appear in netlist.connections but are
// not in components[] — e.g. `Battery`, `MCU_Header`) we synthesize a stub
// position on the canvas margin so their wires terminate somewhere visible
// instead of dangling at the layout origin.

const PIN_OFFSET_HALF_SIDE = 5      // mm from component center to pin tip
                                     // (matches SYMBOL_IC_W/2 + stub)

// Nets treated as POWER/GROUND RAILS: instead of explicit point-to-point
// wires, each pin gets a `schematic_net_label` (tscircuit's documented
// convention for power buses — see docs.tscircuit.com/elements/net and
// /elements/trace).  Identification is by an EXPLICIT NAME LIST (not net_type
// alone) because reference nets like VREF carry net_type "analog" in the NIR
// yet are functionally rails and must not be drawn as crossing wires.  Any net
// whose name is in this set — or whose net_type is already "power"/"ground" —
// is emitted as labels, not wires.
const POWER_RAIL_NET_NAMES = new Set([
  "GND", "VBAT", "VBAT_FILTERED", "VCC_ANALOG", "VREF",
])

/** True if a net should be rendered as a rail (net labels, no wires). */
function isRailNet(net: NirV11NetlistEntry): boolean {
  return (
    net.net_type === "power" ||
    net.net_type === "ground" ||
    POWER_RAIL_NET_NAMES.has(net.net_name)
  )
}

interface PinPos { ref: string; pin_name: string; pin_number: string | number; x: number; y: number }

/**
 * inferPinOffset(kind, pinNumber, refSchId) — deterministic pin tip offset
 * from the component's center.
 *
 *   - resistor / capacitor / diode / ferrite_bead:
 *       pin "1" -> left lead (-X), pin "2" -> right lead (+X)
 *   - IC (any: U*, instrumentation_amp, ldo, voltage_reference, ...):
 *       odd pin numbers go on the LEFT side, even on the RIGHT side,
 *       y offset spreads them along the box height (same ratio used by
 *       makeSymbolGeometry's IC pin-stub emitter).
 */
function inferPinOffset(
  kind: string,
  isIc: boolean,
  pinCount: number,
  pinNumber: string | number,
): { dx: number; dy: number } {
  const n = typeof pinNumber === "number" ? pinNumber : parseInt(String(pinNumber), 10)
  if (Number.isNaN(n)) return { dx: 0, dy: 0 }

  if (!isIc) {
    // Discretes: 2 pins, pin "1" left, pin "2" right.
    return {
      dx: n === 1 ? -PIN_OFFSET_HALF_SIDE : +PIN_OFFSET_HALF_SIDE,
      dy: 0,
    }
  }
  // ICs: left side gets odd pins (1, 3, 5, ...), right side gets even.
  // Distribute along ~80% of the box height, top-to-bottom.
  const bodyH = 6 + Math.max(0, Math.ceil(pinCount / 2) - 4)
  const halfPins = Math.ceil(pinCount / 2)
  const isLeft = (n % 2) === 1
  const sideIdx = isLeft
    ? Math.floor((n - 1) / 2)            // 1->0, 3->1, 5->2 ...
    : Math.floor((n - 2) / 2)            // 2->0, 4->1, 6->2 ...
  const sideCount = isLeft ? halfPins : (pinCount - halfPins)
  const verticalSpan = bodyH * 0.8
  const y = sideCount > 1
    ? (sideIdx / (sideCount - 1)) * verticalSpan - verticalSpan / 2
    : 0
  return {
    dx: isLeft ? -PIN_OFFSET_HALF_SIDE : +PIN_OFFSET_HALF_SIDE,
    dy: y,
  }
}

/**
 * buildPinMap — every (ref, pin_number) connection point gets a real (x,y)
 * in canvas mm space.  External refs are assumed to already be in the
 * layout (placed by `addExternalStubPositions`, which runs before centering).
 */
function buildPinMap(
  comps: NirV11Component[],
  layout: Record<string, { x: number; y: number; rot: number }>,
  netlist: NirV11NetlistEntry[],
): Map<string, PinPos> {
  const map = new Map<string, PinPos>()
  const keyFor = (ref: string, pin_number: string | number) =>
    `${ref}#${pin_number}`

  // Register every (ref, pin_number) actually referenced by the netlist.
  // If neither a component placement nor an external stub entry exists
  // for conn.ref, skip silently — emitNetWires will drop the wire for
  // that pin (no degenerate (0,0) wires).
  for (const net of netlist) {
    for (const conn of net.connections) {
      const center = layout[conn.ref]
      if (!center) continue
      const c = comps.find((c) => c.ref === conn.ref)
      const isIc = c
        ? isIC(c.component_type)
        : /^[A-Z]+\d+$/i.test(conn.ref) && /^[A-Z]/i.test(conn.ref) && !/^[RCDLQ]/i.test(conn.ref)
      const pinCount = c ? inferPinCount(c.footprint) : 2
      const off = inferPinOffset(inferRefKind(conn.ref), isIc, pinCount, conn.pin_number)
      map.set(keyFor(conn.ref, conn.pin_number), {
        ref: conn.ref,
        pin_name: conn.pin_name,
        pin_number: conn.pin_number,
        x: center.x + off.dx,
        y: center.y + off.dy,
      })
    }
  }

  return map
}

/**
 * addExternalStubPositions — wire-drawing prerequisite.
 *
 * For each ref referenced in `netlist[].connections[]` that does NOT
 * appear in `components[]` (e.g. `Battery`, `MCU_Header` —
 * off-schema / external endpoints), synthesize a stub placement on the
 * main layout so subsequent wire-drawing has a position to route to/from.
 *
 * Stub positions are placed below the main component grid, spread
 * horizontally with a pitch larger than the cluster pitch so stubs are
 * visually distinct from placed components.  Stubs are added BEFORE
 * centering so the centerLayoutInCanvas pass accounts for them and they
 * don't skew the result.
 *
 * Mutates `layout` in place — adds new keys for each external ref.
 */
function addExternalStubPositions(
  layout: Record<string, { x: number; y: number; rot: number }>,
  comps: NirV11Component[],
  netlist: NirV11NetlistEntry[],
): void {
  const refSet = new Set(comps.map((c) => c.ref))

  // Discover external refs in net-appearance order so adjacent netlist
  // entries get adjacent stubs (this keeps wire crossings minimal).
  const externals: string[] = []
  const seen = new Set<string>()
  for (const net of netlist) {
    for (const conn of net.connections) {
      if (!refSet.has(conn.ref) && !seen.has(conn.ref)) {
        externals.push(conn.ref)
        seen.add(conn.ref)
      }
    }
  }
  if (externals.length === 0) return

  // computeLayout now already positions external endpoints via the
  // force-directed pass, so only backfill any that are somehow absent
  // (defensive — keep them off the canvas edge rather than at the origin).
  let minY = Infinity, minX = Infinity, maxX = -Infinity
  for (const r of Object.keys(layout)) {
    const p = layout[r]
    if (!p) continue
    if (p.y < minY) minY = p.y
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
  }
  if (!Number.isFinite(minY)) {
    minY = 0
    minX = 0
    maxX = 0
  }
  const stubY = minY + BETWEEN_CLUSTER_PITCH_MM * 2
  externals.forEach((ref, i) => {
    if (!layout[ref]) {
      layout[ref] = { x: minX + i * 16, y: stubY, rot: 0 }
    }
  })
}

/**
 * centerLayoutInCanvas — translate every placed component so their
 * collective bounding box centers at the canvas origin (0, 0).
 *
 * circuit-to-svg derives its viewBox from the union of all element
 * extents, so once real-space coords are centered, the resulting SVG will
 * frame the layout symmetrically with equal margin on all sides (modulo
 * its fixed aspect-ratio canvas dimensions).
 *
 * Explicit NIR-supplied positions are also translated (the spec doesn't
 * say "explicit positions are exempt from centering").
 */
function centerLayoutInCanvas(
  layout: Record<string, { x: number; y: number; rot: number }>,
): Record<string, { x: number; y: number; rot: number }> {
  const refs = Object.keys(layout)
  if (refs.length === 0) return layout

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const r of refs) {
    const p = layout[r]
    if (!p) continue
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const dx = -(minX + maxX) / 2
  const dy = -(minY + maxY) / 2

  const out: Record<string, { x: number; y: number; rot: number }> = {}
  for (const r of refs) {
    const p = layout[r]
    if (!p) continue
    out[r] = { x: p.x + dx, y: p.y + dy, rot: p.rot }
  }
  return out
}

// --------------------------------------------------------------------------- //
// Schematic trace wires
// --------------------------------------------------------------------------- //
//
// For each net we draw a Manhattan-routed wire ("L-bend") chain from the
// first connection's pin to each subsequent connection's pin in the net's
// connection-list order.  We DON'T try to be a full autorouter — straight
// L-bends between adjacent pins is already a large improvement vs. zero
// wires, which is the bug motivating this pass.
//
// We avoid drawing a wire segment through the body of any *other* placed
// component by always routing the L-bend OUTSIDE the row pitch
// (halfway-point between rows).  This means most wires go vertically to
// the inter-row gap, then horizontally, then vertically back into the
// destination pin.  Collisions with same-row components are possible and
// accepted as a documented simplification — a real autorouter will fix
// this in a later layer.

const TRACE_WIRE_COLOR = "#1f6feb"          // pick a visible net color
const TRACE_WIRE_STUB_MM = 2                 // exit pin outward before turn

// --------------------------------------------------------------------------- //
// Schematic trace wires — per-net hub routing (obstacle-aware)
// --------------------------------------------------------------------------- //
//
// OLD approach (removed): star topology — every net's pins spoke out from the
// net's FIRST pin.  Diagnostic testing (diag_routing.ts) found this caused two
// real failures:
//   (1) BODY-CROSSING: a spoke's L-bend travelled through a *sibling* body
//       (the VREF spoke clipped C1, which is a VREF member but not that
//       spoke's endpoint, so the endpoint-only exclusion missed it).
//   (2) WIRE-WIRE CROSSING: because every net funnelled through its first
//       pin, many nets' spokes crossed in the same crowded centre region
//       (26 crossings between different nets).
// Both share ONE root cause — a fixed hub pin + collision checks that only
// exclude the spoke's own two endpoints.  Patching each as a special case
// would just relocate the crossings.
//
// NEW approach (a): route each net through a per-net HUB placed in FREE SPACE
// — the centroid of the net's pins, searched outward until it sits outside
// every component body AND yields body-free spokes.  Every spoke is then an
// axis-aligned single L-bend (pin -> hub) chosen between the two L variants
// (horizontal-first vs vertical-first) that avoids ALL component bodies, not
// just the spoke's own endpoints.  This removes body-crossings at the root
// and, because each net hubs at its OWN centroid, different nets no longer
// funnel through a shared pin, collapsing most wire-wire crossings too.
//
// Preserved invariants:
//   - single clean L-bend per spoke, axis-aligned, no zigzag/diagonal (chk 2)
//   - no tightening of layout spacing; the U1-R3 gap (chk 4) is untouched
//   - orphan schematic_line elements (no schematic_component_id) so
//     circuit-to-svg renders them via its loose-element path.

interface BodyBox { x0: number; x1: number; y0: number; y1: number }

/** Build the bounding box of every placed component body (no pins/edges). */
function computeComponentBodies(
  comps: NirV11Component[],
  layout: Record<string, { x: number; y: number; rot: number }>,
): Record<string, BodyBox> {
  const out: Record<string, BodyBox> = {}
  for (const c of comps) {
    const p = layout[c.ref]
    if (!p) continue
    const sz = bodySizeForForRouter(c.component_type, c.footprint)
    out[c.ref] = {
      x0: p.x - sz.width / 2,
      x1: p.x + sz.width / 2,
      y0: p.y - sz.height / 2,
      y1: p.y + sz.height / 2,
    }
  }
  return out
}

/** Body size used purely for collision bounds (matches symbol geometry). */
function bodySizeForForRouter(componentType: string, footprint: string): { width: number; height: number } {
  if (isIC(componentType)) {
    const extra = Math.max(0, Math.ceil(inferPinCount(footprint) / 2) - 4)
    return { width: SYMBOL_IC_W, height: SYMBOL_DISCRETE_H + 6 + extra }
  }
  return { width: SYMBOL_DISCRETE_W, height: SYMBOL_DISCRETE_H }
}

/** Does point lie strictly inside any component body? */
function pointInAnyBody(pt: { x: number; y: number }, bodies: Record<string, BodyBox>): boolean {
  for (const r in bodies) {
    const b = bodies[r]
    if (pt.x > b.x0 && pt.x < b.x1 && pt.y > b.y0 && pt.y < b.y1) return true
  }
  return false
}

/**
 * Count how many OTHER component bodies the segment (a)->(b) crosses.
 * `excludeRef` is the spoke's own source component (its body may legitimately
 * sit at the segment start, so it is skipped — this is the ONLY exclusion,
 * unlike the old code which also excluded the destination pin's body).
 */
function segCrossingsBodies(
  a: { x: number; y: number },
  b: { x: number; y: number },
  excludeRef: string | null,
  bodies: Record<string, BodyBox>,
): number {
  let count = 0
  for (const r in bodies) {
    if (r === excludeRef) continue
    const box = bodies[r]
    if (segRectCross(a.x, a.y, b.x, b.y, box)) count++
  }
  return count
}

/** Standard segment-vs-axis-aligned-rect intersection (edges excluded). */
function segRectCross(
  x1: number, y1: number, x2: number, y2: number,
  r: BodyBox,
): boolean {
  const eps = 0.01
  const rx0 = r.x0 + eps, rx1 = r.x1 - eps, ry0 = r.y0 + eps, ry1 = r.y1 - eps
  if (rx1 <= rx0 || ry1 <= ry0) return false
  const inside = (x: number, y: number) => x >= rx0 && x <= rx1 && y >= ry0 && y <= ry1
  if (inside(x1, y1) || inside(x2, y2)) return true
  const edges: [number, number, number, number][] = [
    [rx0, ry0, rx1, ry0], [rx1, ry0, rx1, ry1],
    [rx1, ry1, rx0, ry1], [rx0, ry1, rx0, ry0],
  ]
  for (const [ex1, ey1, ex2, ey2] of edges) {
    if (segSeg(x1, y1, x2, y2, ex1, ey1, ex2, ey2)) return true
  }
  return false
}

function segSeg(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
): boolean {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
  if (d === 0) return false
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

/**
 * Choose the best single-L routing from a pin `p` to the hub `h`, considering
 * both L variants.  Returns the chosen 2-point path (pin -> corner -> hub) plus
 * penalty terms: `bodyCross` (legs crossing OTHER component bodies) and
 * `wireCross` (legs crossing ALREADY-ROUTED wires of other nets).  Body
 * crossings dominate the score; wire crossings are weighted lower so we never
 * accept a body-crossing just to dodge another net's wire.
 */
interface SpokeChoice {
  path: { x: number; y: number }[]
  bodyCross: number
  wireCross: number
  len: number
}
function chooseSpokePath(
  p: PinPos,
  h: { x: number; y: number },
  bodies: Record<string, BodyBox>,
  placedWires: { x1: number; y1: number; x2: number; y2: number }[],
): SpokeChoice {
  const variants: { x: number; y: number }[][] = [
    // HV: horizontal first (corner at (h.x, p.y)), then vertical.
    [{ x: p.x, y: p.y }, { x: h.x, y: p.y }, { x: h.x, y: h.y }],
    // VH: vertical first (corner at (p.x, h.y)), then horizontal.
    [{ x: p.x, y: p.y }, { x: p.x, y: h.y }, { x: h.x, y: h.y }],
  ]
  let best: SpokeChoice | null = null
  for (const path of variants) {
    let bodyCross = 0
    let wireCross = 0
    for (let s = 0; s < path.length - 1; s++) {
      const a = path[s], b = path[s + 1]
      bodyCross += segCrossingsBodies(a, b, p.ref, bodies)
      for (const w of placedWires) {
        if (segSeg(a.x, a.y, b.x, b.y, w.x1, w.y1, w.x2, w.y2)) wireCross++
      }
    }
    const len = Math.abs(h.x - p.x) + Math.abs(h.y - p.y)
    const score = bodyCross * 1000 + wireCross * 10 + len
    if (!best || score < best.bodyCross * 1000 + best.wireCross * 10 + best.len) {
      best = { path, bodyCross, wireCross, len }
    }
  }
  return best!
}

/**
 * Compute a free-space hub for a net: start at the pin centroid, then search a
 * grid of offset candidates for the one that (a) lies outside every body and
 * (b) minimises body-crossings + wire-crossings across all spokes, considering
 * wires ALREADY routed for earlier nets (passed in `placedWires`).  This
 * decouples different nets from a shared funnel point AND steers each net's
 * hub away from wires other nets have already claimed, collapsing most
 * wire-wire crossings.  Tie-break: total wire length.
 */
function computeNetHub(
  pins: PinPos[],
  bodies: Record<string, BodyBox>,
  placedWires: { x1: number; y1: number; x2: number; y2: number }[],
): { x: number; y: number } {
  const cx = pins.reduce((s, p) => s + p.x, 0) / pins.length
  const cy = pins.reduce((s, p) => s + p.y, 0) / pins.length

  const candidates: { x: number; y: number }[] = [{ x: cx, y: cy }]
  for (let dx = -28; dx <= 28; dx += 4) {
    for (let dy = -28; dy <= 28; dy += 4) {
      if (dx === 0 && dy === 0) continue
      candidates.push({ x: cx + dx, y: cy + dy })
    }
  }

  let best: { x: number; y: number } | null = null
  let bestScore = Infinity
  let bestLen = Infinity
  for (const h of candidates) {
    if (pointInAnyBody(h, bodies)) continue
    let score = 0
    let totLen = 0
    for (const p of pins) {
      const r = chooseSpokePath(p, h, bodies, placedWires)
      score += r.bodyCross * 1000 + r.wireCross * 10
      totLen += r.len
    }
    if (score < bestScore || (score === bestScore && totLen < bestLen)) {
      bestScore = score
      bestLen = totLen
      best = h
    }
  }
  return best ?? { x: cx, y: cy }
}

function emitNetWires(
  net: NirV11NetlistEntry,
  pinMap: Map<string, PinPos>,
  bodies: Record<string, BodyBox>,
  placedWires: { x1: number; y1: number; x2: number; y2: number }[],
): AnyCircuitElement[] {
  // Collect the pin positions actually present in the map.  If a
  // connection's pin isn't in the map (component not placed), we skip it
  // — but we never silently emit a degenerate (0,0)->somewhere wire.
  const pins: PinPos[] = []
  for (const conn of net.connections) {
    const p = pinMap.get(`${conn.ref}#${conn.pin_number}`)
    if (p) pins.push(p)
  }
  if (pins.length < 2) return []

  const out: AnyCircuitElement[] = []
  // Per-net free-space hub (approach a), cross-net aware: the hub is chosen
  // so this net's spokes avoid BOTH component bodies AND wires already
  // routed for earlier nets (passed in `placedWires`).
  const hub = computeNetHub(pins, bodies, placedWires)
  pins.forEach((pin, i) => {
    out.push(...emitSpokeToHub(net.net_name, pin, hub, i, bodies, placedWires))
  })
  return out
}

/**
 * emitSpokeToHub — emit a single clean L-bend (pin -> hub) as orphan
 * schematic_line elements, choosing the L variant that avoids all bodies and
 * already-placed wires.  The emitted segment coords are also appended to
 * `placedWires` so LATER nets route around them.  A net label is attached near
 * the spoke midpoint for readability.
 */
function emitSpokeToHub(
  netName: string,
  pin: PinPos,
  hub: { x: number; y: number },
  indexSpoke: number,
  bodies: Record<string, BodyBox>,
  placedWires: { x1: number; y1: number; x2: number; y2: number }[],
): AnyCircuitElement[] {
  const out: AnyCircuitElement[] = []
  const chosen = chooseSpokePath(pin, hub, bodies, placedWires)
  const baseId = `trace_${netName}_${indexSpoke}_${Math.round(pin.x * 1000)}_${Math.round(pin.y * 1000)}_${Math.round(hub.x * 1000)}_${Math.round(hub.y * 1000)}`
  for (let s = 0; s < chosen.path.length - 1; s++) {
    const a = chosen.path[s]
    const b = chosen.path[s + 1]
    if (a.x === b.x && a.y === b.y) continue
    out.push({
      type: "schematic_line",
      schematic_line_id: `${baseId}_s${s}`,
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      color: TRACE_WIRE_COLOR,
      is_dashed: false,
    } as AnyCircuitElement)
    placedWires.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  }

  const labelX = (pin.x + hub.x) / 2
  const labelY = (pin.y + hub.y) / 2
  out.push({
    type: "schematic_text",
    schematic_text_id: `${baseId}_lbl`,
    text: netName,
    font_size: 0.6,
    position: { x: labelX + 0.4, y: labelY + 0.4 },
    rotation: 0,
    anchor: "center",
    color: "#888",
  } as AnyCircuitElement)

  return out
}

/**
 * computeLayout — netlist-clustered, hard-constraint-aware positioner.
 *
 * Algorithm (documented simplifications inline):
 *
 *   1. Components with NIR-supplied real x_mm/y_mm keep them verbatim and
 *      bypass the rest of the algorithm.
 *
 *   2. CLUSTERING (replaces the blind grid):
 *      Build an undirected graph: nodes are refs; an edge exists between
 *      any two refs that co-appear as connections in the same `netlist`
 *      entry.  Use a simple greedy connected-components run to assign each
 *      component a cluster id.  All components in the same cluster are
 *      placed in the SAME row (so connected parts sit next to each other
 *      instead of being scattered across the board).
 *      Simplified?  Yes — a real force-directed solver weights edges by
 *      net_criticality, falls back to net-degree ordering for
 *      neighbour placement, and produces near-rectangular placements
 *      respecting aspect ratio.  This pass is intentionally NOT that.
 *
 *   3. HARD PROXIMITY CONSTRAINTS:
 *      For each `placement_constraints[]` entry with `hard === true` and
 *      `constraint_type === "proximity"`, we force the constrained ref
 *      (`ref`) to live in the SAME cluster as `relative_to`.  This
 *      overrides the connected-components assignment if the components
 *      did not actually share a net.  Components in the row of the
 *      constrained target thus sit within `NETLIST_CLUSTER_PITCH_MM`,
 *      guaranteeing the `max_distance_mm` rule (when max_distance_mm >=
 *      NETLIST_CLUSTER_PITCH_MM, which is the case for the
 *      `instrumentation_amp_001` fixture's `U1⇄R3 max 8mm` rule).
 *      Simplified?  Yes — "exact" constraint satisfaction (e.g. ensuring
 *      euclidean distance ≤ max_distance_mm for an arbitrary constraint
 *      graph) requires solving a constraint system; we approximate by
 *      intra-cluster placement + small intra-cluster pitch.
 *
 *   4. ROW WALK:
 *      Clusters are placed in distinct rows, separated by
 *      `BETWEEN_CLUSTER_PITCH_MM`.  Within a cluster row, components are
 *      laid out left-to-right at `NETLIST_CLUSTER_PITCH_MM` pitch in
 *      netlist-appearance order (rather than in their components[]
 *      order).  The intuition: the netlist lists "VBAT -> FB1 -> C5/U3"
 *      before "VCC_ANALOG -> ...", so the power-chain parts cluster
 *      together first.
 *
 * DEFERRED (out of scope for this pass — see NETLIST_CLUSTER_PITCH_MM
 * comment block above):
 *   - placement_rules_text (needs LLM)
 *   - isolation/keepout rules other than hard proximity (logged once)
 *   - true autorouting between components
 */
function computeLayout(
  comps: NirV11Component[],
  netlist: NirV11NetlistEntry[],
  constraints: NirV11PlacementConstraint[],
): Record<string, { x: number; y: number; rot: number }> {
  // --- Force-directed (Fruchterman-Reingold style) placement ---
  //
  // Replaces the old union-find + single-row-walk scheme.  Union-find merged
  // every component sharing ANY net into one cluster, so large multi-drop
  // nets (GND with 8 members, VCC_ANALOG with 5) collapsed the whole design
  // into a single row — the "thin band" complaint.  Force-directed instead
  // derives position from the STRENGTH of connectivity:
  //
  //   * each net contributes springs between all member pairs, weighted by
  //     1/(net_size - 1) so small signal nets pull hard while global power/
  //     ground rails pull only weakly (they no longer dominate the layout);
  //   * hard proximity constraints become strong springs (satisfied tightly);
  //   * soft proximity constraints become weaker springs (group related but
  //     non-net-connected parts, e.g. the input-filter passives R4/C3/C4 and
  //     the TVS D1, which the netlist alone cannot place);
  //   * a mild gravity-to-centroid keeps components with no connectivity on
  //     the canvas instead of letting repulsion fling them to infinity.
  //
  // Explicit NIR positions (x_mm/y_mm) are honoured as pinned anchors.
  // External endpoints (refs in netlist but not in components[]) are real
  // nodes too, so their wires terminate at a visible, well-placed point.

  const refsAll = comps.map((c) => c.ref)
  const refSet = new Set(refsAll)

  // External endpoints referenced by the netlist but absent from components[].
  const externals: string[] = []
  for (const net of netlist) {
    for (const conn of net.connections) {
      if (!refSet.has(conn.ref) && !externals.includes(conn.ref)) {
        externals.push(conn.ref)
      }
    }
  }
  const nodes = [...refsAll, ...externals]
  const nodeIdx: Record<string, number> = {}
  nodes.forEach((r, i) => (nodeIdx[r] = i))
  const N = nodes.length

  // Explicit positions become pinned anchors (excluded from integration).
  const pinned: Record<number, { x: number; y: number }> = {}
  for (const c of comps) {
    const p = c.position
    if (p && typeof p.x_mm === "number" && typeof p.y_mm === "number") {
      pinned[nodeIdx[c.ref]] = {
        x: p.x_mm,
        y: p.y_mm,
      }
    }
  }

  // Deterministic grid seed (no randomness -> reproducible layout).
  const COLS = Math.ceil(Math.sqrt(N))
  const pos = nodes.map((_, i) => ({
    x: (i % COLS) * LAYOUT_SPACING_MM - (COLS * LAYOUT_SPACING_MM) / 2,
    y: Math.floor(i / COLS) * LAYOUT_SPACING_MM - (COLS * LAYOUT_SPACING_MM) / 2,
  }))

  const K = LAYOUT_SPACING_MM // ideal neighbour spacing (mm)
  interface Edge { i: number; j: number; w: number; target: number }
  const edges: Edge[] = []

  // Net edges — weight falls off with net size so power/ground rails, which
  // connect many parts, pull weakly instead of yanking everything together.
  for (const net of netlist) {
    const members = net.connections
      .map((c) => c.ref)
      .filter((r) => nodeIdx[r] !== undefined)
    const m = members.length
    if (m < 2) continue
    const w = 1 / (m - 1)
    for (let a = 0; a < m; a++) {
      for (let b = a + 1; b < m; b++) {
        edges.push({ i: nodeIdx[members[a]], j: nodeIdx[members[b]], w, target: K })
      }
    }
  }

  // Proximity constraints — hard: tight strong spring; soft: looser spring.
  for (const con of constraints) {
    if (con.constraint_type !== "proximity") {
      if (con.hard) {
        // mention-but-don't-fail — only proximity is implemented.
        // eslint-disable-next-line no-console
        console.log(
          `[open_forge/serializer] placement_constraints ref '${con.ref}' type ` +
          `'${con.constraint_type}' is hard:true but NOT honored (only ` +
          "proximity is implemented).",
        )
      }
      continue
    }
    const ri = nodeIdx[con.ref]
    const rj = nodeIdx[con.relative_to]
    if (ri === undefined || rj === undefined) continue
    const w = con.hard ? 9 : 3
    const target = Math.min(con.max_distance_mm ?? K, K * 0.85)
    edges.push({ i: ri, j: rj, w, target })
  }

  // Integrate (cooling schedule).
  let temp = LAYOUT_INIT_TEMP
  for (let it = 0; it < LAYOUT_ITERATIONS; it++) {
    const disp = nodes.map(() => ({ x: 0, y: 0 }))
    // Repulsion (all pairs).
    for (let a = 0; a < N; a++) {
      for (let b = a + 1; b < N; b++) {
        let dx = pos[a].x - pos[b].x
        let dy = pos[a].y - pos[b].y
        const d = Math.hypot(dx, dy) || 0.01
        const f = (K * K) / d
        const ux = dx / d, uy = dy / d
        disp[a].x += ux * f; disp[a].y += uy * f
        disp[b].x -= ux * f; disp[b].y -= uy * f
      }
    }
    // Attraction along edges (spring toward target distance).
    for (const e of edges) {
      let dx = pos[e.i].x - pos[e.j].x
      let dy = pos[e.i].y - pos[e.j].y
      const d = Math.hypot(dx, dy) || 0.01
      const f = (d - e.target) * e.w
      const ux = dx / d, uy = dy / d
      disp[e.i].x -= ux * f; disp[e.i].y -= uy * f
      disp[e.j].x += ux * f; disp[e.j].y += uy * f
    }
    // Gravity — keeps fully-isolated nodes on the canvas.
    for (let a = 0; a < N; a++) {
      disp[a].x += -pos[a].x * LAYOUT_GRAVITY
      disp[a].y += -pos[a].y * LAYOUT_GRAVITY
    }
    // Apply (pinned nodes stay fixed; they still pull their neighbours).
    for (let a = 0; a < N; a++) {
      if (a in pinned) { pos[a] = { ...pinned[a] }; continue }
      const d = Math.hypot(disp[a].x, disp[a].y) || 0.01
      pos[a].x += (disp[a].x / d) * Math.min(d, temp)
      pos[a].y += (disp[a].y / d) * Math.min(d, temp)
    }
    temp = LAYOUT_INIT_TEMP * (1 - it / LAYOUT_ITERATIONS) + 0.2
  }

  // Build result map for ALL nodes (comps + externals) so downstream
  // centering / pin-map building can find the external endpoints too.
  const result: Record<string, { x: number; y: number; rot: number }> = {}
  nodes.forEach((r, i) => {
    result[r] = { x: pos[i].x, y: pos[i].y, rot: 0 }
  })
  return result
}

function requireKeys(
  obj: Record<string, unknown>,
  keys: string[],
  where: string,
): void {
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined || v === null) {
      throw new Error(
        `${where} is missing required field '${k}' — NIR v1.1 parsing is ` +
        "strict (no silent fallback to [].",
      )
    }
  }
}

// --------------------------------------------------------------------------- //
// Circuit JSON -> SVG   (unchanged from prior implementation)
// --------------------------------------------------------------------------- //

export function renderCircuitJson(
  circuitJson: AnyCircuitElement[],
): { svg: string; viewerUsed: ViewerUsed } {
  /** Render Circuit JSON to SVG.
   *
   *  Preference order is controlled by the `OPEN_FORGE_VIEWER` env var:
   *    - `schematic-viewer` -> try `@tscircuit/schematic-viewer` first
   *    - `circuit-to-svg`  -> use circuit-to-svg directly
   *    - unset             -> circuit-to-svg (hard dependency, always installed)
   *
   *  If `@tscircuit/schematic-viewer` is requested but not installed, the
   *  function falls back to `circuit-to-svg` rather than throwing — the
   *  serializer must remain runnable in environments that don't have the
   *  viewer installed (it's a UI package, optional for headless export).
   */
  const want = (process.env.OPEN_FORGE_VIEWER ?? "").toLowerCase()

  if (want === "schematic-viewer") {
    try {
      // Lazy + dynamic import so missing package is a recoverable branch,
      // not a load-time crash.
      const sv = require("@tscircuit/schematic-viewer")
      const svg = sv.renderCircuitJsonToSvg
        ? sv.renderCircuitJsonToSvg(circuitJson)
        : sv.default?.renderCircuitJsonToSvg?.(circuitJson)
      if (typeof svg === "string" && svg.length > 0) {
        return { svg, viewerUsed: "@tscircuit/schematic-viewer" }
      }
    } catch (e) {
      // package missing or import failed — fall through to circuit-to-svg.
      // eslint-disable-next-line no-console
      console.warn(
        "[open_forge/serializer] @tscircuit/schematic-viewer not available, " +
        "falling back to circuit-to-svg",
      )
    }
  }

  // Default / fallback: circuit-to-svg.  Always installed (hard dep).
  // Prefer the schematic renderer when there's any schematic content,
  // else the PCB renderer.
  const hasSchematic = circuitJson.some(
    (el) => typeof el === "object" && el !== null && String((el as any).type).startsWith("schematic"),
  ) || circuitJson.length === 0 // empty -> still emit a stub svg

  let svg: string
  try {
    svg = hasSchematic
      ? convertCircuitJsonToSchematicSvg(circuitJson as any)
      : convertCircuitJsonToPcbSvg(circuitJson as any)
  } catch {
    // convertCircuitJsonToSchematicSvg throws on a pure-source-only Circuit
    // JSON (no schematic_* elements).  Try the PCB renderer as a last resort.
    try {
      svg = convertCircuitJsonToPcbSvg(circuitJson as any)
    } catch (e) {
      throw new Error(
        "circuit-to-svg failed to render both schematic and PCB views: " +
        String((e as Error)?.message ?? e),
      )
    }
  }
  return { svg, viewerUsed: "circuit-to-svg" }
}

// --------------------------------------------------------------------------- //
// End-to-end
// --------------------------------------------------------------------------- //

export function serializeNir(nir: Nir | unknown): SerializerOutput {
  /** NIR -> Circuit JSON -> SVG, the full new export path. */
  const circuitJson = nirToCircuitJson(nir)
  const { svg, viewerUsed } = renderCircuitJson(circuitJson)
  return { circuitJson, svg, viewerUsed }
}
