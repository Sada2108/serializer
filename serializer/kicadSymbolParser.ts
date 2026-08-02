import { parseSExpr } from "./sexprParser"
import { readFileSync, existsSync } from "fs"
import { join } from "path"

// ---------------------------------------------------------------------------
// Parsed types for a KiCad schematic symbol
// ---------------------------------------------------------------------------

export interface KicadPin {
  number: string
  name: string
  electricalType: string
  /** Pin tip position (mm), in the symbol's local coordinate system */
  x: number
  y: number
  /** Pin orientation in degrees: 0=right, 90=up, 180=left, 270=down */
  orientation: number
  /** Pin length (mm) — the pin extends inward from (x,y) opposite to orientation */
  length: number
}

export interface KicadGraphicRect {
  type: "rectangle"
  startX: number
  startY: number
  endX: number
  endY: number
  strokeWidth: number
  fillType: string
}

export interface KicadGraphicCircle {
  type: "circle"
  cx: number
  cy: number
  r: number
  strokeWidth: number
  fillType: string
}

export interface KicadGraphicArc {
  type: "arc"
  start: { x: number; y: number }
  mid: { x: number; y: number }
  end: { x: number; y: number }
  strokeWidth: number
}

export interface KicadGraphicPolyline {
  type: "polyline"
  points: { x: number; y: number }[]
  strokeWidth: number
  fillType: string
}

export type KicadGraphic = KicadGraphicRect | KicadGraphicCircle | KicadGraphicArc | KicadGraphicPolyline

export interface KicadSymbolData {
  name: string
  units: KicadSymbolUnit[]
}

export interface KicadSymbolUnit {
  unitNumber: number
  pins: KicadPin[]
  graphics: KicadGraphic[]
}

// ---------------------------------------------------------------------------
// Cache for loaded libraries
// ---------------------------------------------------------------------------

const KICAD_SYMBOLS_DIR = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols"

const libraryCache = new Map<string, any[]>()

function loadLibrary(libName: string): any[] {
  const cached = libraryCache.get(libName)
  if (cached) return cached
  const filePath = join(KICAD_SYMBOLS_DIR, libName + ".kicad_sym")
  if (!existsSync(filePath)) throw new Error(`KiCad symbol library not found: ${filePath}`)
  const content = readFileSync(filePath, "utf8")
  const tree = parseSExpr(content)
  const list = Array.isArray(tree[0]) ? tree : tree
  libraryCache.set(libName, list)
  return list
}

function findVal(node: any[], key: string): any | undefined {
  for (let i = 1; i < node.length; i++) {
    if (Array.isArray(node[i]) && node[i][0] === key) return node[i]
  }
  return undefined
}

function findNum(node: any[], key: string): number | undefined {
  const sub = findVal(node, key)
  return sub ? Number(sub[1]) : undefined
}

// ---------------------------------------------------------------------------
// Parse a single symbol definition from the parsed tree
// ---------------------------------------------------------------------------

function parseSymbolNode(symNode: any[]): KicadSymbolData {
  const name = symNode[1]
  const units: KicadSymbolUnit[] = []

  // Collect sub-symbols (graphics units and pin units)
  const subSymbols: { unitNum: number; node: any[] }[] = []
  for (let i = 2; i < symNode.length; i++) {
    const child = symNode[i]
    if (!Array.isArray(child)) continue
    if (child[0] === "symbol" && typeof child[1] === "string") {
      const unitName = child[1]
      const m = unitName.match(new RegExp(`^${escapeRegex(name)}_(\\d+)_(\\d+)$`))
      if (m) {
        subSymbols.push({ unitNum: parseInt(m[2]), node: child })
      }
    }
  }

  // Group sub-symbols by unit number
  const unitMap = new Map<number, { pins: KicadPin[]; graphics: KicadGraphic[] }>()
  for (const { unitNum, node } of subSymbols) {
    if (!unitMap.has(unitNum)) unitMap.set(unitNum, { pins: [], graphics: [] })
    const entry = unitMap.get(unitNum)!
    for (let j = 2; j < node.length; j++) {
      const el = node[j]
      if (!Array.isArray(el)) continue
      if (el[0] === "pin") {
        entry.pins.push(parsePin(el))
      } else if (el[0] === "rectangle") {
        entry.graphics.push(parseRect(el))
      } else if (el[0] === "circle") {
        entry.graphics.push(parseCircle(el))
      } else if (el[0] === "arc") {
        entry.graphics.push(parseArc(el))
      } else if (el[0] === "polyline") {
        entry.graphics.push(parsePolyline(el))
      }
    }
  }

  for (const [unitNum, data] of unitMap) {
    units.push({ unitNumber: unitNum, pins: data.pins, graphics: data.graphics })
  }

  return { name, units }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function parsePin(node: any[]): KicadPin {
  const electricalType = node[1]
  const shape = node[2]
  const atNode = findVal(node, "at")
  const length = findNum(node, "length") ?? 1.27
  const nameNode = findVal(node, "name")
  const numNode = findVal(node, "number")

  const name = nameNode ? nameNode[1] : ""
  const number = numNode ? numNode[1] : ""
  const x = atNode ? Number(atNode[1]) : 0
  const y = atNode ? Number(atNode[2]) : 0
  const orientation = atNode && atNode[3] ? Number(atNode[3]) : 0

  return { number, name, electricalType: String(electricalType), x, y, orientation, length }
}

function parseRect(node: any[]): KicadGraphicRect {
  const startNode = findVal(node, "start")
  const endNode = findVal(node, "end")
  const strokeNode = findVal(node, "stroke")
  const fillNode = findVal(node, "fill")
  return {
    type: "rectangle",
    startX: startNode ? Number(startNode[1]) : 0,
    startY: startNode ? Number(startNode[2]) : 0,
    endX: endNode ? Number(endNode[1]) : 0,
    endY: endNode ? Number(endNode[2]) : 0,
    strokeWidth: strokeNode ? Number(findVal(strokeNode, "width")?.[1] ?? 0.254) : 0.254,
    fillType: fillNode ? String(findVal(fillNode, "type")?.[1] ?? "none") : "none",
  }
}

function parseCircle(node: any[]): KicadGraphicCircle {
  const centerNode = findVal(node, "center")
  const radius = findNum(node, "radius") ?? 1
  const strokeNode = findVal(node, "stroke")
  const fillNode = findVal(node, "fill")
  return {
    type: "circle",
    cx: centerNode ? Number(centerNode[1]) : 0,
    cy: centerNode ? Number(centerNode[2]) : 0,
    r: radius,
    strokeWidth: strokeNode ? Number(findVal(strokeNode, "width")?.[1] ?? 0.254) : 0.254,
    fillType: fillNode ? String(findVal(fillNode, "type")?.[1] ?? "none") : "none",
  }
}

function parseArc(node: any[]): KicadGraphicArc {
  const startNode = findVal(node, "start")
  const midNode = findVal(node, "mid")
  const endNode = findVal(node, "end")
  const strokeNode = findVal(node, "stroke")
  return {
    type: "arc",
    start: { x: startNode ? Number(startNode[1]) : 0, y: startNode ? Number(startNode[2]) : 0 },
    mid: { x: midNode ? Number(midNode[1]) : 0, y: midNode ? Number(midNode[2]) : 0 },
    end: { x: endNode ? Number(endNode[1]) : 0, y: endNode ? Number(endNode[2]) : 0 },
    strokeWidth: strokeNode ? Number(findVal(strokeNode, "width")?.[1] ?? 0.254) : 0.254,
  }
}

function parsePolyline(node: any[]): KicadGraphicPolyline {
  const pts: { x: number; y: number }[] = []
  // Look for (pts (xy...) (xy...)) sub-list
  const ptsNode = findVal(node, "pts")
  const xyNodes = ptsNode ? ptsNode.slice(1) : node.slice(1)
  for (let i = 0; i < xyNodes.length; i++) {
    const pt = xyNodes[i]
    if (Array.isArray(pt) && pt[0] === "xy") {
      pts.push({ x: Number(pt[1]), y: Number(pt[2]) })
    }
  }
  const strokeNode = findVal(node, "stroke")
  const fillNode = findVal(node, "fill")
  return {
    type: "polyline",
    points: pts,
    strokeWidth: strokeNode ? Number(findVal(strokeNode, "width")?.[1] ?? 0.254) : 0.254,
    fillType: fillNode ? String(findVal(fillNode, "type")?.[1] ?? "none") : "none",
  }
}

// ---------------------------------------------------------------------------
// Main entry: get a symbol by library + name, handling `extends`
// ---------------------------------------------------------------------------

export function getKicadSymbol(
  libName: string,
  symbolName: string,
  visited: Set<string> = new Set(),
): KicadSymbolData {
  const key = `${libName}:${symbolName}`
  if (visited.has(key)) throw new Error(`Circular extends in KiCad symbol: ${key}`)
  visited.add(key)

  const tree = loadLibrary(libName)
  const root = Array.isArray(tree[0]) ? tree[0] : tree

  // Find the symbol node
  let symNode: any[] | undefined
  for (let i = 1; i < root.length; i++) {
    const node = root[i]
    if (Array.isArray(node) && node[0] === "symbol" && node[1] === symbolName) {
      symNode = node
      break
    }
  }
  if (!symNode) throw new Error(`Symbol '${symbolName}' not found in library '${libName}'`)

  // Check for extends
  const extendsNode = findVal(symNode, "extends")
  if (extendsNode) {
    const parentName = extendsNode[1]
    const parentLib = parentName.includes(":") ? parentName.split(":")[0] : libName
    const parentSymbol = parentName.includes(":") ? parentName.split(":")[1] : parentName
    const parent = getKicadSymbol(parentLib, parentSymbol, visited)
    // Clone parent and merge child properties on top
    return mergeSymbols(parent, parseSymbolNode(symNode))
  }

  return parseSymbolNode(symNode)
}

function mergeSymbols(parent: KicadSymbolData, child: KicadSymbolData): KicadSymbolData {
  const unitMap = new Map<number, { pins: KicadPin[]; graphics: KicadGraphic[] }>()
  for (const u of parent.units) {
    unitMap.set(u.unitNumber, { pins: [...u.pins], graphics: [...u.graphics] })
  }
  for (const u of child.units) {
    if (!unitMap.has(u.unitNumber)) {
      unitMap.set(u.unitNumber, { pins: [], graphics: [] })
    }
    const entry = unitMap.get(u.unitNumber)!
    entry.pins.push(...u.pins)
    entry.graphics.push(...u.graphics)
  }
  return {
    name: child.name || parent.name,
    units: Array.from(unitMap.entries()).map(([unitNumber, data]) => ({
      unitNumber, pins: data.pins, graphics: data.graphics,
    })),
  }
}

// ---------------------------------------------------------------------------
// Convenience: KiCad symbol name by NIR component type
// (maps NIR component_type → { library, symbol })
// ---------------------------------------------------------------------------

export const KICAD_SYMBOL_MAP: Record<string, { library: string; symbol: string }> = {
  resistor:             { library: "Device", symbol: "R" },
  capacitor:            { library: "Device", symbol: "C" },
  inductor:             { library: "Device", symbol: "L" },
  diode:                { library: "Device", symbol: "D" },
  tvs_diode_array:      { library: "Device", symbol: "D" },
  ferrite_bead:         { library: "Device", symbol: "FB" },
  voltage_source:       { library: "Device", symbol: "Battery" },
  opamp:                { library: "Amplifier_Operational", symbol: "LM358" },
  instrumentation_amp:  { library: "Amplifier_Operational", symbol: "INA849" },
  voltage_reference:    { library: "Amplifier_Operational", symbol: "LM358" },
  ldo_regulator:        { library: "Regulator_Linear", symbol: "LM1117" },
}

// Scale factor: KiCad schematic symbols use 50mil (1.27mm) grid.
// Our SVG viewBox uses mm units. 1 KiCad unit = 1mm output.
export const KICAD_TO_SVG_SCALE = 1.0

export function getBodySize(sym: KicadSymbolData): { width: number; height: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const u of sym.units) {
    for (const g of u.graphics) {
      if (g.type === "rectangle") {
        minX = Math.min(minX, g.startX, g.endX)
        maxX = Math.max(maxX, g.startX, g.endX)
        minY = Math.min(minY, g.startY, g.endY)
        maxY = Math.max(maxY, g.startY, g.endY)
      }
      if (g.type === "circle") {
        minX = Math.min(minX, g.cx - g.r)
        maxX = Math.max(maxX, g.cx + g.r)
        minY = Math.min(minY, g.cy - g.r)
        maxY = Math.max(maxY, g.cy + g.r)
      }
      if (g.type === "polyline") {
        for (const p of g.points) {
          minX = Math.min(minX, p.x)
          maxX = Math.max(maxX, p.x)
          minY = Math.min(minY, p.y)
          maxY = Math.max(maxY, p.y)
        }
      }
    }
    for (const p of u.pins) {
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
  }
  if (!Number.isFinite(minX)) return { width: 6, height: 4 }
  const margin = 1
  return { width: maxX - minX + margin * 2, height: maxY - minY + margin * 2 }
}
