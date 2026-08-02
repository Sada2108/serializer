// Serializer — CircuitJS circuit translator.
//
// Converts our NIR fixture data into Falstad CircuitJS's plaintext circuit
// format. The format is documented in the CircuitJS1 source:
//   CircuitLoader.java  → readCircuit()    (plaintext parser, ~line 130)
//   ResistorElm.java    → dump type 'r'    (r x1 y1 x2 y2 flags resistance)
//   CapacitorElm.java   → dump type 'c'    (c x1 y1 x2 y2 flags cap voltdiff initV seriesR)
//   VoltageElm.java     → dump type 'v'    (v x1 y1 x2 y2 flags waveform freq maxV bias phase duty)
//   GroundElm.java      → dump type 'g'    (g x1 y1 x2 y2 flags symbolType)
//   WireElm.java        → dump type 'w'    (w x1 y1 x2 y2 flags)
//
// Source: https://github.com/pfalstad/circuitjs1
// License: GPL-2.0+ (iframe embedding explicitly supported per README)

export interface CircuitJsComponent {
  type: string
  ref: string
  component_type?: string
  value?: string | null
}

export interface CircuitJsNet {
  net_name: string
  connections: { ref: string; pin_name: string }[]
}

/**
 * Parse a SPICE-style value string to a number.
 * "1k" → 1000, "1u" → 1e-6, "5" → 5, "100n" → 100e-9, etc.
 */
function parseSpiceValue(s: string): number {
  const trimmed = s.trim().toLowerCase()
  const suffixes: Record<string, number> = {
    t: 1e12, g: 1e9, meg: 1e6, k: 1e3,
    m: 1e-3, mil: 25.4e-6,
    u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
  }
  // Try suffix matching (longest first)
  for (const [suffix, mult] of Object.entries(suffixes).sort((a, b) => b[0].length - a[0].length)) {
    if (trimmed.endsWith(suffix)) {
      const num = parseFloat(trimmed.slice(0, -suffix.length))
      return Number.isFinite(num) ? num * mult : NaN
    }
  }
  return parseFloat(trimmed)
}

/**
 * Format a number in CircuitJS's scientific notation (lowercase e, no trailing zeros).
 */
function fmt(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toString()
  // Use scientific notation for very small/large numbers
  const s = n.toExponential(6)
  // Trim trailing zeros but keep at least one decimal
  return s.replace(/\.?0+(e)/, "$1")
}

interface CircuitLayout {
  lines: string[]
  groundNode: { x: number; y: number }
}

/**
 * Layout an RC low-pass circuit in CircuitJS coordinates.
 *
 * Circuit topology:
 *                    R1
 *   V1+ ──────────┤1k├───────── C1+ ──────┐
 *   │                                          │
 *   │                                          │
 *   V1 (5V DC)                               C1 (1uF)
 *   │                                          │
 *   │                                          │
 *   V1- ─────────────────────────────── GND ───┘
 *
 * Coordinates (grid = 16px, CircuitJS default):
 *   V1: (128, 96) → (128, 256)   [vertical, positive at top]
 *   R1: (128, 96) → (352, 96)    [horizontal, top rail]
 *   C1: (352, 96) → (352, 256)   [vertical, right side]
 *   Wire: (128, 256) → (352, 256) [bottom rail]
 *   Ground: (352, 256) → (352, 304)
 */
function layoutRcLowpass(voltageValue: string, rValue: string, cValue: string): CircuitLayout {
  const vdc = parseSpiceValue(voltageValue)
  const resistance = parseSpiceValue(rValue)
  const capacitance = parseSpiceValue(cValue)

  const lines: string[] = []

  // Options line: $ flags maxTimeStep iterations currentBar voltageRange powerBar minTimeStep
  lines.push("$ 17 5e-6 117 50 5 50 5e-11")

  // V1: DC voltage source, vertical, positive at top
  // v x1 y1 x2 y2 flags waveform freq maxV bias phaseShift dutyCycle
  // waveform 0 = DC
  lines.push(`v 128 96 128 256 0 0 60 ${fmt(vdc)} 0 0 0.5`)

  // R1: resistor, horizontal, top rail
  // r x1 y1 x2 y2 flags resistance
  lines.push(`r 128 96 352 96 0 ${fmt(resistance)}`)

  // C1: capacitor, vertical, right side
  // c x1 y1 x2 y2 flags capacitance voltdiff initialVoltage seriesResistance
  lines.push(`c 352 96 352 256 0 ${fmt(capacitance)} 0 0 0`)

  // Wire: bottom rail connecting V1- to C1 bottom
  // w x1 y1 x2 y2 flags
  lines.push("w 128 256 352 256 0")

  // Ground: at bottom right
  // g x1 y1 x2 y2 flags symbolType
  lines.push("g 352 256 352 304 0 0")

  return { lines, groundNode: { x: 352, y: 256 } }
}

/**
 * Layout a voltage divider circuit in CircuitJS coordinates.
 *
 * Circuit topology:
 *                  R1 (10k)
 *   V1+ ──────────┤10k├───────── VOUT ──────┐
 *   │                                     │
 *   │                                     │
 *   V1 (5V DC)                          R2 (10k)
 *   │                                     │
 *   │                                     │
 *   V1- ─────────────────────────── GND ───┘
 */
function layoutVoltageDivider(voltageValue: string, r1Value: string, r2Value: string): CircuitLayout {
  const vdc = parseSpiceValue(voltageValue)
  const r1 = parseSpiceValue(r1Value)
  const r2 = parseSpiceValue(r2Value)

  const lines: string[] = []

  lines.push("$ 17 5e-6 117 50 5 50 5e-11")

  // V1: DC voltage source
  lines.push(`v 128 96 128 256 0 0 60 ${fmt(vdc)} 0 0 0.5`)

  // R1: top resistor
  lines.push(`r 128 96 352 96 0 ${fmt(r1)}`)

  // R2: right side (VOUT to ground)
  lines.push(`r 352 96 352 256 0 ${fmt(r2)}`)

  // Wire: bottom rail
  lines.push("w 128 256 352 256 0")

  // Ground
  lines.push("g 352 256 352 304 0 0")

  return { lines, groundNode: { x: 352, y: 256 } }
}

/**
 * Generate a CircuitJS plaintext circuit from NIR fixture data.
 * Returns the plaintext string (suitable for ?cct= URL parameter).
 */
export function nirToCircuitJsPlaintext(
  designId: string,
  components: CircuitJsComponent[],
): string | null {
  const byRef = new Map(components.map((c) => [c.ref, c]))

  // Detect circuit topology from component refs/types
  const hasR1 = byRef.get("R1")
  const hasC1 = byRef.get("C1")
  const hasR2 = byRef.get("R2")

  // Find voltage source by type or ref
  const vSource = components.find((c) =>
    c.component_type === "voltage_source" || c.ref === "V1" || c.ref === "VIN",
  )
  if (!vSource) return null
  const vVal = vSource.value ?? "5"

  if (hasR1 && hasC1 && !hasR2) {
    // RC low-pass topology
    const layout = layoutRcLowpass(vVal, hasR1.value ?? "1k", hasC1.value ?? "1u")
    return layout.lines.join("\n")
  }

  if (hasR1 && hasR2 && !hasC1) {
    // Voltage divider topology
    const layout = layoutVoltageDivider(vVal, hasR1.value ?? "10k", hasR2.value ?? "10k")
    return layout.lines.join("\n")
  }

  return null
}

/**
 * Encode a plaintext circuit for use in CircuitJS's ?cct= URL parameter.
 * Per CirSim.java: the ?cct= value undergoes replace("%24", "$"),
 * so we URL-encode normally (browser handles that) but ensure $ → %24.
 */
export function encodeCircuitForUrl(plaintext: string): string {
  return encodeURIComponent(plaintext)
}

/**
 * Build a full CircuitJS iframe URL with our circuit pre-loaded.
 */
export function buildCircuitJsUrl(plaintext: string): string {
  const encoded = encodeCircuitForUrl(plaintext)
  return `https://www.falstad.com/circuit/circuitjs.html?cct=${encoded}&hideMenu=true&whiteBackground=true`
}
