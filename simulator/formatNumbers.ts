// Open_Forge — Number formatting utilities for simulation output (Layer 4).
//
// Provides human-readable engineering notation with SI unit prefixes for
// displaying simulation vectors. Does NOT modify the raw numeric data.

export type FormatStyle = "eng" | "fixed" | "auto"

export interface FormatOptions {
  /** Number of significant digits (default: 4) */
  precision?: number
  /** Style: "eng" = engineering notation with SI prefixes, "fixed" = fixed decimal, "auto" = choose based on magnitude */
  style?: FormatStyle
  /** Unit suffix to append (e.g., "V", "A", "Hz") */
  unit?: string
  /** Values with |value| < epsilon are clamped to exactly 0 (default: 1e-12).
   *  Typical SPICE magnitudes range ~1e-9 to 1e3; 1e-12 catches IEEE-754
   *  solver noise (e.g. -4.44e-18) without clamping real pico-scale signals. */
  epsilon?: number
}

/**
 * SI prefix table for engineering notation.
 * Maps exponent (multiple of 3) to prefix symbol.
 */
const SI_PREFIXES: Record<number, string> = {
  "-24": "y", "-21": "z", "-18": "a", "-15": "f", "-12": "p", "-9": "n",
  "-6": "µ", "-3": "m", "0": "", "3": "k", "6": "M", "9": "G", "12": "T", "15": "P", "18": "E",
}

/**
 * Format a single number in engineering notation with SI prefix.
 * e.g. 0.000001 -> "1µ", 4700 -> "4.7k", 100000 -> "100k"
 */
export function formatEng(value: number, opts: FormatOptions = {}): string {
  const { precision = 4, unit = "", epsilon = 1e-12 } = opts
  if (Math.abs(value) < epsilon) return "0" + unit
  if (!Number.isFinite(value)) return String(value) + unit

  const abs = Math.abs(value)
  const sign = value < 0 ? "-" : ""

  // Find the exponent multiple of 3
  const exp3 = Math.floor(Math.log10(abs) / 3) * 3
  const clampedExp3 = Math.max(-24, Math.min(24, exp3))
  const prefix = SI_PREFIXES[String(clampedExp3)] ?? ""

  // Scale the value
  const scaled = abs / Math.pow(10, clampedExp3)

  // Format with requested precision (significant digits)
  const formatted = scaled.toPrecision(precision).replace(/\.?0+$/, "")

  return `${sign}${formatted}${prefix}${unit}`
}

/**
 * Format a number in fixed decimal notation.
 * e.g. 0.000001 -> "0.000001", 4700 -> "4700"
 */
export function formatFixed(value: number, opts: FormatOptions = {}): string {
  const { precision = 6, unit = "", epsilon = 1e-12 } = opts
  if (Math.abs(value) < epsilon) return "0" + unit
  if (!Number.isFinite(value)) return String(value) + unit
  return value.toFixed(precision).replace(/\.?0+$/, "") + unit
}

/**
 * Auto-format: use engineering notation for values < 1 or >= 1000,
 * otherwise fixed decimal (for values in [1, 1000)).
 */
export function formatAuto(value: number, opts: FormatOptions = {}): string {
  const { epsilon = 1e-12, ...rest } = opts
  if (Math.abs(value) < epsilon) return "0" + (opts.unit ?? "")
  const abs = Math.abs(value)
  if (abs >= 1 && abs < 1000) {
    return formatFixed(value, { ...rest, precision: opts.precision ?? 6, epsilon })
  }
  return formatEng(value, { ...rest, precision: opts.precision ?? 4, epsilon })
}

/**
 * Format an array of numbers (e.g., a simulation vector).
 */
export function formatVector(
  values: number[],
  opts: FormatOptions = {}
): string[] {
  return values.map(v => formatAuto(v, opts))
}

/**
 * Format all vectors in a SimulationResult for display.
 * Returns a new object with formatted string arrays.
 */
export function formatSimulationResult(
  result: { vectors: Record<string, number[]>; variables: any[] },
  opts: FormatOptions = {}
): { vectors: Record<string, string[]>; variables: any[] } {
  const formatted: Record<string, string[]> = {}
  for (const [name, values] of Object.entries(result.vectors)) {
    // Try to infer unit from variable name
    let unit = ""
    const varInfo = result.variables.find(v => v.name === name)
    if (varInfo?.type) {
      const type = varInfo.type.toLowerCase()
      if (type.includes("voltage")) unit = "V"
      else if (type.includes("current")) unit = "A"
      else if (type.includes("time")) unit = "s"
      else if (type.includes("frequency")) unit = "Hz"
    }
    formatted[name] = formatVector(values, { ...opts, unit })
  }
  return { vectors: formatted, variables: result.variables }
}

/**
 * Format a single value with automatic unit detection from variable name.
 */
export function formatValue(
  value: number,
  variableName: string,
  opts: FormatOptions = {}
): string {
  let unit = opts.unit ?? ""
  if (!unit) {
    const lower = variableName.toLowerCase()
    if (lower.startsWith("v(") || lower.includes("voltage")) unit = "V"
    else if (lower.startsWith("i(") || lower.includes("current")) unit = "A"
    else if (lower.includes("time") || lower === "time") unit = "s"
    else if (lower.includes("freq") || lower.includes("frequency")) unit = "Hz"
  }
  return formatAuto(value, { ...opts, unit })
}