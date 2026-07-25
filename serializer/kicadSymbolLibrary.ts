import { readFileSync } from "fs"
import { join } from "path"

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

const SYMBOL_DIR = join(import.meta.dir, "kicad-symbols")

function parseKicadSym(content: string): KicadSymbolDef | null {
  const symbolMatch = content.match(/\(symbol\s+"([^"]+)"/)
  if (!symbolMatch) return null
  const symName = symbolMatch[1]

  const primitives: KicadSymbolPrimitive[] = []
  const ports: KicadSymbolPort[] = []

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  const rectRegex = /\(rectangle\s+\(start\s+([-\d.]+)\s+([-\d.]+)\)\s+\(end\s+([-\d.]+)\s+([-\d.]+)\)/g
  let m: RegExpExecArray | null
  while ((m = rectRegex.exec(content)) !== null) {
    const x1 = parseFloat(m[1]), y1 = parseFloat(m[2])
    const x2 = parseFloat(m[3]), y2 = parseFloat(m[4])
    primitives.push({
      type: "rectangle",
      start: { x: Math.min(x1, x2), y: Math.min(y1, y2) },
      end: { x: Math.max(x1, x2), y: Math.max(y1, y2) },
      filled: content.substring(m.index, m.index + 200).includes("(type background)"),
    })
    minX = Math.min(minX, x1, x2)
    minY = Math.min(minY, y1, y2)
    maxX = Math.max(maxX, x1, x2)
    maxY = Math.max(maxY, y1, y2)
  }

  const polylineRegex = /\(polyline\s+\(pts\s+((?:\(xy\s+[-\d.]+\s+[-\d.]+\)\s*)+)\)/g
  while ((m = polylineRegex.exec(content)) !== null) {
    const ptsStr = m[1]
    const ptRegex = /\(xy\s+([-\d.]+)\s+([-\d.]+)\)/g
    const points: { x: number; y: number }[] = []
    let pm: RegExpExecArray | null
    while ((pm = ptRegex.exec(ptsStr)) !== null) {
      const px = parseFloat(pm[1]), py = parseFloat(pm[2])
      points.push({ x: px, y: py })
      minX = Math.min(minX, px)
      minY = Math.min(minY, py)
      maxX = Math.max(maxX, px)
      maxY = Math.max(maxY, py)
    }
    if (points.length > 0) {
      const strokeBlock = content.substring(m.index, m.index + 500)
      const widthMatch = strokeBlock.match(/\(width\s+([-\d.]+)\)/)
      const filledMatch = strokeBlock.match(/\(type\s+(background|solid)\)/)
      primitives.push({
        type: "polyline",
        points,
        strokeWidth: widthMatch ? parseFloat(widthMatch[1]) : 0.254,
        filled: !!filledMatch,
      })
    }
  }

  const pinBlockRegex = /\(pin\s+(\w+)\s+(\w+)\s+\(at\s+([-\d.]+)\s+([-\d.]+)\s+(\d+)\)\s+\(length\s+([-\d.]+)\)/g
  while ((m = pinBlockRegex.exec(content)) !== null) {
    const dir = parseInt(m[5])
    const len = parseFloat(m[6])
    const px = parseFloat(m[3]), py = parseFloat(m[4])

    let pinName = ""
    let pinNumber = ""
    const afterAt = content.substring(m.index + m[0].length, m.index + m[0].length + 600)
    const nameMatch = afterAt.match(/\(name\s+"([^"]*)"/)
    if (nameMatch) pinName = nameMatch[1]
    const numMatch = afterAt.match(/\(number\s+"([^"]*)"/)
    if (numMatch) pinNumber = numMatch[1]

    const angleRad = (dir * Math.PI) / 180
    const pinEndX = px + Math.cos(angleRad) * len
    const pinEndY = py - Math.sin(angleRad) * len

    ports.push({
      x: px,
      y: py,
      name: pinName,
      number: pinNumber,
    })

    primitives.push({
      type: "pin",
      pin: {
        x: px,
        y: py,
        angle: dir,
        length: len,
        name: pinName,
        number: pinNumber,
        direction: m[1] as any,
      },
    })

    minX = Math.min(minX, px, pinEndX)
    minY = Math.min(minY, py, pinEndY)
    maxX = Math.max(maxX, px, pinEndX)
    maxY = Math.max(maxY, py, pinEndY)
  }

  const bodyBox = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }

  return { name: symName, library: "", description: "", primitives, ports, bodyBox }
}

function loadSymbol(filename: string): KicadSymbolDef | null {
  try {
    const content = readFileSync(join(SYMBOL_DIR, filename), "utf8")
    return parseKicadSym(content)
  } catch {
    return null
  }
}

function loadSymbolWithExtends(filename: string, extendsName?: string): KicadSymbolDef | null {
  const sym = loadSymbol(filename)
  if (!sym) return null

  if (extendsName) {
    const base = loadSymbol(extendsName + ".kicad_sym")
    if (base) {
      sym.ports = base.ports
      sym.primitives = base.primitives.filter(p => p.type !== "pin")
      sym.bodyBox = base.bodyBox
      for (const pin of base.primitives.filter(p => p.type === "pin")) {
        sym.primitives.push(pin)
      }
    }
  }

  return sym
}

let _cache: Record<string, KicadSymbolDef | null> = {}

function getSymbol(key: string): KicadSymbolDef | null {
  if (_cache[key] !== undefined) return _cache[key]
  _cache[key] = null

  const loader: Record<string, () => KicadSymbolDef | null> = {
    "R": () => loadSymbol("R.kicad_sym"),
    "C": () => loadSymbol("C.kicad_sym"),
    "GND": () => loadSymbol("GND.kicad_sym"),
    "LM358": () => loadSymbolWithExtends("LM358.kicad_sym", "LM2904"),
    "LM2904": () => loadSymbol("LM2904.kicad_sym"),
  }

  if (loader[key]) _cache[key] = loader[key]()
  return _cache[key]
}

interface KicadSymbolEntry {
  kicadName: string
  library: string
  symbolDef: KicadSymbolDef | null
}

const KICAD_MAP: Record<string, KicadSymbolEntry> = {
  resistor:  { kicadName: "R",    library: "Device",               symbolDef: null },
  capacitor: { kicadName: "C",    library: "Device",               symbolDef: null },
  ground:    { kicadName: "GND",  library: "Power",                symbolDef: null },
  opamp:     { kicadName: "LM358", library: "Amplifier_Operational", symbolDef: null },
}

const PART_NUMBER_MAP: Record<string, { kicadName: string; library: string }> = {
  "LM358":  { kicadName: "LM358",  library: "Amplifier_Operational" },
  "LM2904": { kicadName: "LM2904", library: "Amplifier_Operational" },
  "TL072":  { kicadName: "TL072",  library: "Amplifier_Operational" },
  "TL082":  { kicadName: "TL082",  library: "Amplifier_Operational" },
  "OPA344": { kicadName: "LM358",  library: "Amplifier_Operational" },
}

function initSymbol(entry: KicadSymbolEntry): void {
  if (entry.symbolDef !== null) return
  entry.symbolDef = getSymbol(entry.kicadName)
}

export function lookupKicadSymbol(componentType: string, partNumber?: string): KicadSymbolDef | null {
  if (partNumber && PART_NUMBER_MAP[partNumber]) {
    const mapped = PART_NUMBER_MAP[partNumber]
    const key = `part:${partNumber}`
    if (!_cache[key]) {
      const sym = getSymbol(mapped.kicadName)
      _cache[key] = sym
    }
    return _cache[key]
  }

  const entry = KICAD_MAP[componentType]
  if (!entry) return null
  initSymbol(entry)
  return entry.symbolDef
}

export function hasKicadSymbol(componentType: string, partNumber?: string): boolean {
  if (partNumber && PART_NUMBER_MAP[partNumber]) return true
  return componentType in KICAD_MAP
}

export function getKicadSymbolName(componentType: string, partNumber?: string): string | null {
  if (partNumber && PART_NUMBER_MAP[partNumber]) return PART_NUMBER_MAP[partNumber].kicadName
  const entry = KICAD_MAP[componentType]
  return entry?.kicadName ?? null
}
