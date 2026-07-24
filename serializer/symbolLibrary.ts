// Symbol library mapping — maps NIR component types to schematic-symbols entries.
// circuit-to-svg already supports symbol_name on schematic_component elements,
// which triggers library symbol rendering instead of custom ad-hoc shapes.

import { symbols } from "schematic-symbols"

export type SymbolName = keyof typeof symbols

interface SymbolEntry {
  symbolName: SymbolName
  /** Width of the bounding box for the schematic_component size field. */
  width: number
  /** Height of the bounding box for the schematic_component size field. */
  height: number
}

/**
 * Maps NIR component_type strings to schematic-symbols library entries.
 * When a type is found here, the schematic_component gets `symbol_name` set
 * and circuit-to-svg renders the real library symbol instead of custom shapes.
 */
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

/**
 * Returns the schematic-symbols entry for a component type, or undefined
 * if no standard symbol exists (caller should fall back to custom geometry).
 */
export function lookupSymbol(componentType: string): SymbolEntry | undefined {
  return SYMBOL_MAP[componentType]
}

/**
 * Returns the standard ground symbol name.
 */
export function getGroundSymbolName(): SymbolName {
  return "ground_down"
}

/**
 * Logs a warning when no standard symbol is available for a component type.
 */
export function logMissingSymbol(componentType: string): void {
  console.warn(`no standard symbol for ${componentType}, using fallback`)
}
