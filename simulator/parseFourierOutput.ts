// Open_Forge — ngspice Fourier analysis output parser.
//
// Parses the Fourier analysis output from ngspice log files.
// The output format is:
//
//   Fourier analysis for v(2):
//     No. Harmonics: 10, THD: 0.267908 %, Gridsize: 200, ...
//
//   Harmonic Frequency   Magnitude   Phase       Norm. Mag   Norm. Phase
//   -------- ---------   ---------   -----       ---------   -----------
//    0       0           0.00900349  0           0           0
//    1       1000        0.785305    -80.753     1           0
//    ...

export interface FourierHarmonic {
  harmonic: number
  frequency: number
  magnitude: number
  phase: number
  normMag: number
  normPhase: number
}

export interface FourierResult {
  variable: string
  numHarmonics: number
  thd: number
  harmonics: FourierHarmonic[]
}

/**
 * Parse Fourier analysis output from ngspice log text.
 */
export function parseFourierOutput(logText: string): FourierResult[] {
  const results: FourierResult[] = []

  // Find all "Fourier analysis for <variable>:" sections
  const fourierRegex = /Fourier analysis for ([^:]+):\s*\n\s*No\. Harmonics:\s*(\d+),\s*THD:\s*([\d.]+)\s*%/g
  let match: RegExpExecArray | null

  while ((match = fourierRegex.exec(logText)) !== null) {
    const variable = match[1].trim()
    const numHarmonics = parseInt(match[2], 10)
    const thd = parseFloat(match[3])

    // Find the harmonics table after this header
    const tableStart = logText.indexOf("Harmonic Frequency", match.index)
    if (tableStart < 0) continue

    // Find the separator line (--------)
    const sepLine = logText.indexOf("--------", tableStart)
    if (sepLine < 0) continue

    // Parse harmonics after the separator
    const harmonics: FourierHarmonic[] = []
    const lines = logText.slice(sepLine).split("\n")

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.length === 0) continue

      // Try to parse harmonic line: "  N       FREQ      MAG       PHASE     NORM_MAG  NORM_PHASE"
      const parts = line.split(/\s+/)
      if (parts.length < 6) break

      const harmonic = parseInt(parts[0], 10)
      if (!Number.isFinite(harmonic)) break

      harmonics.push({
        harmonic,
        frequency: parseFloat(parts[1]),
        magnitude: parseFloat(parts[2]),
        phase: parseFloat(parts[3]),
        normMag: parseFloat(parts[4]),
        normPhase: parseFloat(parts[5]),
      })
    }

    results.push({ variable, numHarmonics, thd, harmonics })
  }

  return results
}
