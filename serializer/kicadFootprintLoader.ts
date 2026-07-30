// Load real .kicad_mod footprint pad geometry from the KiCad install.
// Wire behind useParsedFootprints flag; replaces FOOTPRINT_SIZE_MM entries.

import { parseSExpr } from "./sexprParser"
import { readFileSync, existsSync } from "fs"
import { join } from "path"

const KICAD_FP_DIR = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"

// Map short footprint names (used in FOOTPRINT_SIZE_MM) → KiCad library:path
const FP_MAP: Record<string, string> = {
  "0603":     "Resistor_SMD:R_0603_1608Metric",
  "0402":     "Resistor_SMD:R_0402_1005Metric",
  "0805":     "Resistor_SMD:R_0805_2012Metric",
  "1206":     "Capacitor_SMD:C_1206_3216Metric",
  "SOT-23":   "Package_TO_SOT_SMD:SOT-23",
  "SOT-23-5": "Package_TO_SOT_SMD:SOT-23-5",
  "TSOT-23-5":"Package_TO_SOT_SMD:TSOT-23-5",
  "MSOP-8":   "Package_SO:MSOP-8_3x3mm_P0.65mm",
  "MSOP-10":  "Package_SO:MSOP-10-1EP_3x3mm_P0.5mm_EP1.68x1.88mm",
  "SOIC-8":   "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
}

// ---------------------------------------------------------------------------
// Global flag
// ---------------------------------------------------------------------------

let _useParsedFootprints = false

export function setUseParsedFootprints(v: boolean): void {
  _useParsedFootprints = v
}

export function getUseParsedFootprints(): boolean {
  return _useParsedFootprints
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedPad {
  padNumber: string
  padType: "smd" | "thru_hole"
  shape: string
  at: { x: number; y: number }
  size: { w: number; h: number }
  layers: string[]
  drill?: number
}

// ---------------------------------------------------------------------------
// S-expression parser (reuse from parent)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Load and parse a .kicad_mod file
// ---------------------------------------------------------------------------

function findVal(node: any[], key: string): any {
  for (let i = 1; i < node.length; i++) {
    if (Array.isArray(node[i]) && node[i][0] === key) return node[i]
  }
  return null
}

function parseKicadMod(content: string): ParsedPad[] {
  const tree = parseSExpr(content)
  const root = Array.isArray(tree[0]) ? tree[0] : tree
  const pads: ParsedPad[] = []

  for (let i = 1; i < root.length; i++) {
    const el = root[i]
    if (!Array.isArray(el)) continue
    if (el[0] === "pad") {
      const atNode = findVal(el, "at")
      const sizeNode = findVal(el, "size")
      const layersNode = findVal(el, "layers")
      const drillNode = findVal(el, "drill")
      pads.push({
        padNumber: String(el[1]),
        padType: el[2] === "thru_hole" ? "thru_hole" : "smd",
        shape: String(el[3]),
        at: { x: atNode ? Number(atNode[1]) : 0, y: atNode ? Number(atNode[2]) : 0 },
        size: { w: sizeNode ? Number(sizeNode[1]) : 1, h: sizeNode ? Number(sizeNode[2]) : 1 },
        layers: layersNode ? layersNode.slice(1).map(String) : ["F.Cu"],
        drill: drillNode ? Number(drillNode[1]) : undefined,
      })
    }
  }
  return pads
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const fpCache = new Map<string, ParsedPad[] | null>()

function loadFootprint(shortName: string): ParsedPad[] | null {
  const cached = fpCache.get(shortName)
  if (cached !== undefined) return cached

  const kicadFpName = FP_MAP[shortName]
  if (!kicadFpName) {
    fpCache.set(shortName, null)
    return null
  }

  const parts = kicadFpName.split(":")
  const libDir = parts[0] + ".pretty"
  const fileName = parts[1] + ".kicad_mod"
  const filePath = join(KICAD_FP_DIR, libDir, fileName)

  if (!existsSync(filePath)) {
    console.warn(`[kicad-footprints] not found: ${filePath}`)
    fpCache.set(shortName, null)
    return null
  }

  try {
    const content = readFileSync(filePath, "utf8")
    const pads = parseKicadMod(content)
    fpCache.set(shortName, pads)
    return pads
  } catch (e) {
    console.warn(`[kicad-footprints] parse error for ${shortName}: ${e}`)
    fpCache.set(shortName, null)
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API: get footprint body size (replaces FOOTPRINT_SIZE_MM)
// ---------------------------------------------------------------------------

const KNOWN_FP_KEYS = Object.keys(FP_MAP)

function shortFootprintName(footprint: string): string {
  if (FP_MAP[footprint]) return footprint
  const ci = footprint.indexOf(":")
  if (ci > 0) {
    const part = footprint.slice(ci + 1)
    for (const key of KNOWN_FP_KEYS) {
      if (part.includes(`_${key}_`) || part.includes(key) && key.length >= 3) {
        const re = new RegExp(`_?${key}_?`)
        if (re.test(part)) return key
      }
    }
  }
  return footprint
}

export function getParsedFootprintSize(shortName: string): { width: number; height: number } | null {
  if (!_useParsedFootprints) return null

  const pads = loadFootprint(shortFootprintName(shortName))
  if (!pads || pads.length === 0) return null

  // Compute bounding box of all pads
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of pads) {
    const hw = p.size.w / 2
    const hh = p.size.h / 2
    minX = Math.min(minX, p.at.x - hw)
    maxX = Math.max(maxX, p.at.x + hw)
    minY = Math.min(minY, p.at.y - hh)
    maxY = Math.max(maxY, p.at.y + hh)
  }

  if (!Number.isFinite(minX)) return null

  const margin = 1.0 // 1mm around pads for body outline
  return {
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2,
  }
}
