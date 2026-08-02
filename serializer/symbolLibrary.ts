import { symbols } from "schematic-symbols"
import { getKicadSymbol, KICAD_SYMBOL_MAP, getBodySize, type KicadSymbolData } from "./kicadSymbolParser"

export type SymbolName = keyof typeof symbols

interface SymbolEntry {
  symbolName: SymbolName
  width: number
  height: number
}

const SYMBOL_MAP: Record<string, SymbolEntry> = {
  resistor:             { symbolName: "resistor_left",          width: 6, height: 2 },
  capacitor:            { symbolName: "capacitor_up",           width: 2, height: 4 },
  diode:                { symbolName: "diode_right",            width: 6, height: 2 },
  tvs_diode_array:      { symbolName: "diode_right",            width: 6, height: 2 },
  ferrite_bead:         { symbolName: "ferrite_bead_left",      width: 6, height: 2 },
  voltage_source:       { symbolName: "battery_horz",           width: 3, height: 2 },
  opamp:                { symbolName: "opamp_no_power_left",     width: 8, height: 6 },
  instrumentation_amp:  { symbolName: "opamp_no_power_left",     width: 8, height: 6 },
  voltage_reference:    { symbolName: "opamp_no_power_left",     width: 8, height: 6 },
  ldo_regulator:        { symbolName: "opamp_no_power_left",     width: 8, height: 6 },
  digital_potentiometer:{ symbolName: "resistor_left",           width: 6, height: 2 },
}

/** Global flag: use KiCad native symbols instead of tscircuit schematic-symbols */
let _useKicadSymbols = false

export function setUseKicadSymbols(v: boolean): void {
  _useKicadSymbols = v
}

export function getUseKicadSymbols(): boolean {
  return _useKicadSymbols
}

export function lookupSymbol(componentType: string): SymbolEntry | undefined {
  return SYMBOL_MAP[componentType]
}

export function getGroundSymbolName(): SymbolName {
  return "ground_down"
}

export function logMissingSymbol(componentType: string): void {
  console.warn(`no standard symbol for ${componentType}, using fallback`)
}

// ---------------------------------------------------------------------------
// KiCad symbol lookup (behind useKicadSymbols flag)
// ---------------------------------------------------------------------------

const kicadSymbolCache = new Map<string, KicadSymbolData>()

export function getKicadSymbolForType(componentType: string): KicadSymbolData | null {
  const mapping = KICAD_SYMBOL_MAP[componentType]
  if (!mapping) return null
  const key = `${mapping.library}:${mapping.symbol}`
  const cached = kicadSymbolCache.get(key)
  if (cached) return cached
  try {
    const sym = getKicadSymbol(mapping.library, mapping.symbol)
    kicadSymbolCache.set(key, sym)
    return sym
  } catch (e) {
    console.warn(`[kicad-symbols] failed to load ${key}: ${e}`)
    return null
  }
}

export function getKicadBodySize(componentType: string): { width: number; height: number } | null {
  const sym = getKicadSymbolForType(componentType)
  if (!sym) return null
  return getBodySize(sym)
}
