// Serializer — Simulation result pretty-printer (Layer 4).
//
// Wires formatSimulationResult into a human-readable console output.
// Does NOT modify simulateNetlist() return type — keeps raw numbers intact
// for downstream math; this is purely a display boundary.

import type { SimulationResult } from "./simulator"
import { formatSimulationResult, formatVector } from "./formatNumbers"

/**
 * Print a simulation result to console in human-readable form.
 * 
 * @param result - Raw SimulationResult from simulateNetlist()
 * @param opts - Formatting options passed to formatSimulationResult
 */
export function printSimulationResult(
  result: SimulationResult,
  opts?: Parameters<typeof formatSimulationResult>[1]
): void {
  const formatted = formatSimulationResult(result, opts)

  console.log("═══ Simulation Result ═══")
  console.log(`Plot: ${result.plotname ?? "unknown"} | Points: ${result.numPoints}`)
  console.log("")

  for (const [name, values] of Object.entries(formatted.vectors)) {
    const varInfo = result.variables.find(v => v.name === name)
    const type = varInfo?.type ?? "unknown"
    const first = values[0]
    const last = values[values.length - 1]
    const sample = values.length > 10 
      ? `${values.slice(0, 3).join(", ")} ... ${values.slice(-3).join(", ")}`
      : values.join(", ")
    console.log(`  ${name} (${type}): [${sample}]`)
    console.log(`    Range: ${first} → ${last}`)
  }
  console.log("")
}

/**
 * Print a single vector nicely.
 */
export function printVector(
  name: string,
  values: number[],
  unit?: string
): void {
  const formatted = formatVector(values, { unit: unit ?? "" })
  console.log(`  ${name}: [${formatted.join(", ")}]`)
}

/**
 * Get formatted strings for all vectors without printing.
 * Useful for programmatic access or custom output formats.
 */
export function getFormattedVectors(
  result: SimulationResult,
  opts?: Parameters<typeof formatSimulationResult>[1]
): Record<string, string[]> {
  return formatSimulationResult(result, opts).vectors
}