import type { AnyCircuitElement } from "circuit-json"
import type { KicadSymbolData, KicadPin, KicadGraphic } from "./kicadSymbolParser"
import { KICAD_TO_SVG_SCALE } from "./kicadSymbolParser"

// ---------------------------------------------------------------------------
// Convert parsed KiCad symbol geometry to Circuit JSON schematic elements
// used by circuit-to-svg for rendering.
//
// This is meant as a drop-in replacement for makeSymbolGeometry() in
// serializer.ts when useKicadSymbols is true.
// ---------------------------------------------------------------------------

const WIRE_COLOR = "#0c1e2e"

const DEFAULT_SCHEMATIC_SHEET_ID = "schematic_sheet_default"

export function kicadSymbolToCircuitJson(
  fixture: string,
  sid: string,
  cx: number,
  cy: number,
  bodySize: { width: number; height: number },
  sym: KicadSymbolData,
  schematicSheetId: string = DEFAULT_SCHEMATIC_SHEET_ID,
): AnyCircuitElement[] {
  const elements: AnyCircuitElement[] = []

  // Use unit 1 (the first non-graphics unit with pins)
  const unit = sym.units.find((u) => u.pins.length > 0) || sym.units[0]
  if (!unit) return elements

  const s = KICAD_TO_SVG_SCALE

  // Compute bounding box of symbol graphics to center it
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const g of unit.graphics) {
    const bbox = graphicBbox(g)
    minX = Math.min(minX, bbox.minX)
    maxX = Math.max(maxX, bbox.maxX)
    minY = Math.min(minY, bbox.minY)
    maxY = Math.max(maxY, bbox.maxY)
  }
  for (const p of unit.pins) {
    const tipX = p.x
    const tipY = p.y
    const rad = p.orientation * Math.PI / 180
    const endX = tipX - Math.cos(rad) * p.length
    const endY = tipY - Math.sin(rad) * p.length
    minX = Math.min(minX, tipX, endX)
    maxX = Math.max(maxX, tipX, endX)
    minY = Math.min(minY, tipY, endY)
    maxY = Math.max(maxY, tipY, endY)
  }

  if (!Number.isFinite(minX)) return elements

  const symbolCx = (minX + maxX) / 2
  const symbolCy = (minY + maxY) / 2

  // Offset to center the symbol at (cx, cy) in our coordinate system
  const ox = cx - symbolCx * s
  const oy = cy - symbolCy * s

  // Render graphics
  for (const g of unit.graphics) {
    elements.push(...graphicToElements(sid, g, ox, oy, s, schematicSheetId))
  }

  // Render pins
  for (const pin of unit.pins) {
    elements.push(...pinToElements(fixture, sid, pin, ox, oy, s, schematicSheetId))
  }

  return elements
}

function graphicBbox(g: KicadGraphic): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  if (g.type === "rectangle") {
    minX = Math.min(g.startX, g.endX)
    maxX = Math.max(g.startX, g.endX)
    minY = Math.min(g.startY, g.endY)
    maxY = Math.max(g.startY, g.endY)
  } else if (g.type === "circle") {
    minX = g.cx - g.r
    maxX = g.cx + g.r
    minY = g.cy - g.r
    maxY = g.cy + g.r
  } else if (g.type === "polyline") {
    for (const p of g.points) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
  } else if (g.type === "arc") {
    minX = Math.min(g.start.x, g.mid.x, g.end.x)
    maxX = Math.max(g.start.x, g.mid.x, g.end.x)
    minY = Math.min(g.start.y, g.mid.y, g.end.y)
    maxY = Math.max(g.start.y, g.mid.y, g.end.y)
  }
  return { minX, maxX, minY, maxY }
}

function graphicToElements(sid: string, g: KicadGraphic, ox: number, oy: number, s: number, schematicSheetId: string = DEFAULT_SCHEMATIC_SHEET_ID): AnyCircuitElement[] {
  const els: AnyCircuitElement[] = []

  if (g.type === "rectangle") {
    const x1 = g.startX * s + ox
    const y1 = g.startY * s + oy
    const x2 = g.endX * s + ox
    const y2 = g.endY * s + oy
    els.push({
      type: "schematic_box",
      schematic_component_id: sid,
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
      schematic_sheet_id: schematicSheetId,
    } as AnyCircuitElement)
    // Outline
    els.push({
      type: "schematic_line",
      schematic_line_id: `${sid}_rect_${x1}_${y1}`,
      schematic_component_id: sid,
      x1, y1, x2: x2, y2: y1, color: WIRE_COLOR,
      schematic_sheet_id: schematicSheetId,
    } as AnyCircuitElement)
    els.push({
      type: "schematic_line",
      schematic_line_id: `${sid}_rect_${x2}_${y1}`,
      schematic_component_id: sid,
      x1: x2, y1, x2, y2, color: WIRE_COLOR,
      schematic_sheet_id: schematicSheetId,
    } as AnyCircuitElement)
    els.push({
      type: "schematic_line",
      schematic_line_id: `${sid}_rect_${x2}_${y2}`,
      schematic_component_id: sid,
      x1: x2, y1: y2, x2: x1, y2, color: WIRE_COLOR,
      schematic_sheet_id: schematicSheetId,
    } as AnyCircuitElement)
    els.push({
      type: "schematic_line",
      schematic_line_id: `${sid}_rect_${x1}_${y2}`,
      schematic_component_id: sid,
      x1, y1: y2, x2: x1, y2: y1, color: WIRE_COLOR,
      schematic_sheet_id: schematicSheetId,
    } as AnyCircuitElement)
  } else if (g.type === "polyline") {
    const pts = g.points.map((p) => ({ x: p.x * s + ox, y: p.y * s + oy }))
    if (pts.length >= 2) {
      for (let i = 0; i < pts.length - 1; i++) {
        els.push({
          type: "schematic_line",
          schematic_line_id: `${sid}_poly_${i}`,
          schematic_component_id: sid,
          x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y, color: WIRE_COLOR,
          schematic_sheet_id: schematicSheetId,
        } as AnyCircuitElement)
      }
    }
  } else if (g.type === "circle") {
    // Approximate circle as octagon for schematic_line
    const cx = g.cx * s + ox
    const cy = g.cy * s + oy
    const r = g.r * s
    const segs = 12
    for (let i = 0; i < segs; i++) {
      const a1 = (i / segs) * 2 * Math.PI
      const a2 = ((i + 1) / segs) * 2 * Math.PI
      els.push({
        type: "schematic_line",
        schematic_line_id: `${sid}_circ_${i}`,
        schematic_component_id: sid,
        x1: cx + Math.cos(a1) * r, y1: cy + Math.sin(a1) * r,
        x2: cx + Math.cos(a2) * r, y2: cy + Math.sin(a2) * r,
        color: WIRE_COLOR,
        schematic_sheet_id: schematicSheetId,
      } as AnyCircuitElement)
    }
  } else if (g.type === "arc") {
    // Approximate arc as segments
    const cx_ = g.mid.x
    const cy_ = g.mid.y
    const r_ = Math.sqrt((g.start.x - cx_) ** 2 + (g.start.y - cy_) ** 2)
    if (r_ > 0) {
      const aStart = Math.atan2(g.start.y - cy_, g.start.x - cx_)
      const aEnd = Math.atan2(g.end.y - cy_, g.end.x - cx_)
      const segs = 8
      for (let i = 0; i < segs; i++) {
        const t1 = aStart + (i / segs) * (aEnd - aStart)
        const t2 = aStart + ((i + 1) / segs) * (aEnd - aStart)
        els.push({
          type: "schematic_line",
          schematic_line_id: `${sid}_arc_${i}`,
          schematic_component_id: sid,
          x1: (g.start.x + Math.cos(t1) * r_) * s + ox,
          y1: (g.start.y + Math.sin(t1) * r_) * s + oy,
          x2: (g.start.x + Math.cos(t2) * r_) * s + ox,
          y2: (g.start.y + Math.sin(t2) * r_) * s + oy,
          color: WIRE_COLOR,
          schematic_sheet_id: schematicSheetId,
        } as AnyCircuitElement)
      }
    }
  }

  return els
}

function pinToElements(fixture: string, sid: string, pin: KicadPin, ox: number, oy: number, s: number, schematicSheetId: string = DEFAULT_SCHEMATIC_SHEET_ID): AnyCircuitElement[] {
  const els: AnyCircuitElement[] = []

  const rad = pin.orientation * Math.PI / 180
  const tipX = pin.x * s + ox
  const tipY = pin.y * s + oy
  const endX = tipX - Math.cos(rad) * pin.length * s
  const endY = tipY - Math.sin(rad) * pin.length * s

  // Pin line from tip inward
  els.push({
    type: "schematic_line",
    schematic_line_id: `${sid}_pin_${pin.number}`,
    schematic_component_id: sid,
    x1: tipX, y1: tipY, x2: endX, y2: endY, color: WIRE_COLOR,
    schematic_sheet_id: schematicSheetId,
  } as AnyCircuitElement)

  // Port for connectivity
  els.push({
    type: "schematic_port",
    schematic_port_id: `${sid}_${pin.number}`,
    source_port_id: `${fixture}_${sid}_${pin.number}`,
    schematic_component_id: sid,
    center: { x: tipX, y: tipY },
    pin_number: parseInt(pin.number, 10) || 0,
    display_pin_label: pin.name || pin.number,
    schematic_sheet_id: schematicSheetId,
  } as AnyCircuitElement)

  return els
}
