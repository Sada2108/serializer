// KiCad symbol library — loads .kicad_sym files from the KiCad install
// using the proper S-expression parser, behind useKicadSymbols flag.
//
// NOTE: Multi-unit symbols (e.g. LM358 which has 2 opamps) are rendered
// as a single unit. This is a known limitation of the current implementation.

import { getKicadSymbol, getBodySize, type KicadSymbolData, type KicadPin, type KicadGraphic } from "./kicadSymbolParser"
import { KICAD_SYMBOL_MAP } from "./kicadSymbolParser"

export interface KicadSymbolPort {
  x: number
  y: number
  name: string
  number: string
}

export interface KicadSymbolPrimitive {
  type: "polyline" | "rectangle" | "pin"
  points?: { x: number; y: number }[]
  start?: { x: number; y: number }
  end?: { x: number; y: number }
  filled?: boolean
  strokeWidth?: number
  pin?: {
    x: number
    y: number
    angle: number
    length: number
    name: string
    number: string
    direction: "input" | "output" | "passive" | "power_in"
  }
}

export interface KicadSymbolDef {
  name: string
  library: string
  description: string
  primitives: KicadSymbolPrimitive[]
  ports: KicadSymbolPort[]
  bodyBox: { x: number; y: number; width: number; height: number }
}

// ---------------------------------------------------------------------------
// Global flag
// ---------------------------------------------------------------------------

let _useKicadSymbols = false

export function setUseKicadSymbols(v: boolean): void {
  _useKicadSymbols = v
}

export function getUseKicadSymbols(): boolean {
  return _useKicadSymbols
}

// ---------------------------------------------------------------------------
// Cache & lookup
// ---------------------------------------------------------------------------

const cache = new Map<string, KicadSymbolDef>()

function kicadSymbolDataToDef(
  name: string,
  library: string,
  data: KicadSymbolData,
): KicadSymbolDef {
  const primitives: KicadSymbolPrimitive[] = []
  const ports: KicadSymbolPort[] = []

  // Use the first unit that has pins (the main symbol unit)
  const unit = data.units.find((u) => u.pins.length > 0) || data.units[0]
  if (!unit) {
    return { name, library, description: "", primitives, ports, bodyBox: { x: 0, y: 0, width: 6, height: 4 } }
  }

  for (const g of unit.graphics) {
    if (g.type === "rectangle") {
      primitives.push({
        type: "rectangle",
        start: { x: g.startX, y: g.startY },
        end: { x: g.endX, y: g.endY },
        filled: g.fillType === "background" || g.fillType === "solid",
      })
    } else if (g.type === "polyline") {
      primitives.push({
        type: "polyline",
        points: g.points,
        filled: g.fillType === "background" || g.fillType === "solid",
        strokeWidth: g.strokeWidth,
      })
    } else if (g.type === "circle") {
      // Approximate circle as polyline
      const segs = 12
      const pts: { x: number; y: number }[] = []
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * 2 * Math.PI
        pts.push({ x: g.cx + Math.cos(a) * g.r, y: g.cy + Math.sin(a) * g.r })
      }
      primitives.push({ type: "polyline", points: pts, filled: g.fillType === "background" })
    } else if (g.type === "arc") {
      // Approximate arc as polyline
      const cx = g.mid.x, cy = g.mid.y
      const r = Math.sqrt((g.start.x - cx) ** 2 + (g.start.y - cy) ** 2)
      if (r > 0) {
        const aStart = Math.atan2(g.start.y - cy, g.start.x - cx)
        const aEnd = Math.atan2(g.end.y - cy, g.end.x - cx)
        const segs = 8
        const pts: { x: number; y: number }[] = []
        for (let i = 0; i <= segs; i++) {
          const t = aStart + (i / segs) * (aEnd - aStart)
          pts.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r })
        }
        primitives.push({ type: "polyline", points: pts })
      }
    }
  }

  for (const pin of unit.pins) {
    ports.push({ x: pin.x, y: pin.y, name: pin.name, number: pin.number })
    const dirMap: Record<string, string> = {
      input: "input", output: "output", bidirectional: "passive",
      passive: "passive", power_in: "power_in", power_out: "power_out",
      open_collector: "output", open_emitter: "output", tri_state: "output",
    }
    primitives.push({
      type: "pin",
      pin: {
        x: pin.x,
        y: pin.y,
        angle: pin.orientation,
        length: pin.length,
        name: pin.name,
        number: pin.number,
        direction: (dirMap[pin.electricalType] || "passive") as any,
      },
    })
  }

  const bb = getBodySize(data)
  const bodyBox = { x: -bb.width / 2, y: -bb.height / 2, width: bb.width, height: bb.height }

  return { name, library, description: "", primitives, ports, bodyBox }
}

export function lookupKicadSymbol(
  componentType: string,
  partNumber?: string,
): KicadSymbolDef | null {
  if (!_useKicadSymbols) return null

  const mapping = KICAD_SYMBOL_MAP[componentType]
  if (!mapping) return null

  const key = `${mapping.library}:${mapping.symbol}`
  const cached = cache.get(key)
  if (cached) return cached

  try {
    const data = getKicadSymbol(mapping.library, mapping.symbol)
    const def = kicadSymbolDataToDef(mapping.symbol, mapping.library, data)
    cache.set(key, def)
    return def
  } catch (e) {
    console.warn(`[kicad-symbols] ${key}: ${e}`)
    return null
  }
}

export function hasKicadSymbol(componentType: string, partNumber?: string): boolean {
  if (!_useKicadSymbols) return false
  return componentType in KICAD_SYMBOL_MAP
}

export function getKicadSymbolName(componentType: string, partNumber?: string): string | null {
  const mapping = KICAD_SYMBOL_MAP[componentType]
  return mapping?.symbol ?? null
}
