// Interactive SPICE simulator viewer driver using Plotly.js.
// Usage: bun run render_interactive_simulator.ts [fixture_name]
//   fixture_name: voltage_divider_001 (default) | opamp_noninv_001 | rc_lowpass_001
// Output: layer_three/dev-tools/current_sim.html (always overwritten)

import { spawn } from "child_process"
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { serializeNirAsync } from "../../layer_three/serializer/serializer.ts"
import { netlistFromCircuitJson } from "../../layer_three/simulator/netlistFromCircuitJson.ts"
import { parseRawFile } from "../../layer_three/simulator/parseRawFile.ts"
import { parseFourierOutput } from "../../layer_three/simulator/parseFourierOutput.ts"
import { opampNoninvNir, voltageDividerNir, rcLowpassNir, rcLowpassAcNir, rcLowpassFftNir, type NirV11 } from "../../layer_three/serializer/fixtures/index.ts"

const FIXTURES = {
  opamp_noninv_001: opampNoninvNir,
  voltage_divider_001: voltageDividerNir,
  rc_lowpass_001: rcLowpassNir,
  rc_lowpass_ac_001: rcLowpassAcNir,
  rc_lowpass_fft_001: rcLowpassFftNir,
} as const

// ---------------------------------------------------------------------------
// Parse SPICE value to number (for slider hints)
// ---------------------------------------------------------------------------
function parseSpiceVal(s: string): number {
  const t = s.trim().toLowerCase()
  const suffixes: Record<string, number> = {
    t: 1e12, g: 1e9, meg: 1e6, k: 1e3,
    m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
  }
  for (const [suffix, mult] of Object.entries(suffixes).sort((a, b) => b[0].length - a[0].length)) {
    if (t.endsWith(suffix)) {
      const num = parseFloat(t.slice(0, -suffix.length))
      return Number.isFinite(num) ? num * mult : NaN
    }
  }
  return parseFloat(t)
}

interface SliderHint {
  ref: string
  componentType: string
  value: string
  numericValue: number
  unit: string
  logScale: boolean
  min: number
  max: number
  step: number
}

function extractSliderHints(nir: NirV11): SliderHint[] {
  const hints: SliderHint[] = []
  for (const comp of nir.components) {
    const val = comp.value
    if (!val) continue
    const num = parseSpiceVal(val)
    if (!Number.isFinite(num) || num <= 0) continue

    const type = comp.component_type
    if (type === "resistor") {
      hints.push({
        ref: comp.ref, componentType: type, value: val,
        numericValue: num, unit: "\u03A9", logScale: true,
        min: 1, max: num * 100, step: num * 0.1,
      })
    } else if (type === "capacitor") {
      hints.push({
        ref: comp.ref, componentType: type, value: val,
        numericValue: num, unit: "F", logScale: true,
        min: num * 0.01, max: num * 100, step: num * 0.1,
      })
    } else if (type === "inductor") {
      hints.push({
        ref: comp.ref, componentType: type, value: val,
        numericValue: num, unit: "H", logScale: true,
        min: num * 0.01, max: num * 100, step: num * 0.1,
      })
    } else if (type === "voltage_source") {
      hints.push({
        ref: comp.ref, componentType: type, value: val,
        numericValue: num, unit: "V", logScale: false,
        min: 0, max: num * 5 || 10, step: num * 0.1 || 0.5,
      })
    } else if (type === "current_source") {
      hints.push({
        ref: comp.ref, componentType: type, value: val,
        numericValue: num, unit: "A", logScale: false,
        min: 0, max: num * 5 || 1, step: num * 0.1 || 0.1,
      })
    } else {
      // Generic numeric component — still show slider
      hints.push({
        ref: comp.ref, componentType: type, value: val,
        numericValue: num, unit: "", logScale: false,
        min: num * 0.1, max: num * 10, step: num * 0.1,
      })
    }
  }
  return hints
}

// ---------------------------------------------------------------------------
// Build explicit analysis-type → filename map for a given fixture.
//
// Different analysis types for the same logical circuit may live in different
// fixture files (e.g. rc_lowpass_001's AC analysis uses the rc_lowpass_ac_001
// fixture, its FFT analysis uses rc_lowpass_fft_001). This map encodes that
// relationship so switchAnalysis() navigates to the correct file rather than
// guessing by string concatenation.
// ---------------------------------------------------------------------------
function buildAnalysisFileMap(fixtureName: string): Record<string, string> {
  const map: Record<string, string> = {}
  const add = (type: string, file: string) => { map[type] = file }

  const devDir = join(import.meta.dir)
  const exists = (file: string) => existsSync(join(devDir, file))

  // Resolve the base fixture that owns tran/op/dc, independent of which
  // page (ac/fft/base) is currently being rendered.
  const RC_LOWPASS_FAMILY = ["rc_lowpass_001", "rc_lowpass_ac_001", "rc_lowpass_fft_001"]
  const baseFixtureName = RC_LOWPASS_FAMILY.includes(fixtureName)
    ? "rc_lowpass_001"
    : fixtureName

  for (const type of ["tran", "op", "dc"] as const) {
    const file = `${baseFixtureName}_${type}_interactive.html`
    if (exists(file)) add(type, file)
  }

  if (RC_LOWPASS_FAMILY.includes(fixtureName)) {
    if (exists("rc_lowpass_ac_001_ac_interactive.html")) add("ac", "rc_lowpass_ac_001_ac_interactive.html")
    if (exists("rc_lowpass_fft_001_fft_interactive.html")) add("fft", "rc_lowpass_fft_001_fft_interactive.html")
  }

  return map
}

// ---------------------------------------------------------------------------
// ngspice — runs ngspice -b on the generated netlist, accepts the .raw
// regardless of exit code (unmodeled opamp warns).
// ---------------------------------------------------------------------------
async function runNgspiceLax(netlist: string): Promise<{ raw: string; log: string }> {
  const workDir = mkdtempSync(join(tmpdir(), "opsim-"))
  const cirPath = join(workDir, "input.cir")
  const rawPath = join(workDir, "output.raw")
  const logPath = join(workDir, "ngspice.log")

  const cir = [
    netlist,
    "",
    "* ---- ngspice control block ----",
    ".control",
    "run",
    "set filetype=ascii",
    "write " + rawPath,
    ".endc",
    ".END",
    "",
  ].join("\n")
  writeFileSync(cirPath, cir, "utf8")

  return new Promise((resolve, reject) => {
    const p = spawn("ngspice", ["-b", "-o", logPath, cirPath], { stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    p.stdout.on("data", () => {})
    p.stderr.on("data", (d) => { stderr += d.toString() })
    p.on("close", (code) => {
      console.log("   ngspice exit code = " + code + " (lax)")
      try {
        const raw = existsSync(rawPath) ? readFileSync(rawPath, "utf8") : ""
        const log = readFileSync(logPath, "utf8")
        resolve({ raw, log })
      } catch {
        reject(new Error("ngspice did not write output files"))
      }
    })
    p.on("error", (e) => reject(e))
  })
}

// ---------------------------------------------------------------------------
// HTML template helper — read and replace {{PLACEHOLDER}} tokens
// ---------------------------------------------------------------------------
function readTemplate(): string {
  const tplPath = join(import.meta.dir, "interactive_simulator.html")
  return readFileSync(tplPath, "utf8")
}

function replaceAll(tpl: string, token: string, value: string): string {
  return tpl.split(token).join(value)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const fixtureName = (process.argv[2] as keyof typeof FIXTURES) ?? "voltage_divider_001"
  const analysisType = (process.argv[3] as "tran" | "op" | "dc" | "ac" | "fft") ?? "tran"
  const nir = FIXTURES[fixtureName]
  if (!nir) {
    console.error("Unknown fixture: " + fixtureName + ". Available: " + Object.keys(FIXTURES).join(", "))
    process.exit(1)
  }
  if (!["tran", "op", "dc", "ac", "fft"].includes(analysisType)) {
    console.error("Unknown analysis type: " + analysisType + ". Available: tran, op, dc, ac, fft")
    process.exit(1)
  }

  const outHtml = join(import.meta.dir, "current_sim.html")

  console.log("== Step 1 — serialize " + fixtureName + " NIR ==")
  const so = await serializeNirAsync(nir)
  console.log("   circuit-json elements:", so.circuitJson.length)

  console.log("== Step 2 — circuit-json -> SPICE netlist ==")
  const nl = netlistFromCircuitJson(so.circuitJson, nir, { analysisType })
  console.log("   warnings:", nl.warnings.length)
  nl.warnings.forEach((w) => console.log("   -", w))
  console.log("\n---FULL NETLIST---")
  console.log(nl.netlist)
  console.log("---END NETLIST---\n")

  console.log("== Step 3 — run ngspice ==")
  const { raw, log } = await runNgspiceLax(nl.netlist)
  console.log("   raw file bytes:", raw.length)

  const PALETTE = [
    "#1f77b4", "#d62728", "#2ca02c", "#ff7f0e", "#9467bd",
    "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
    "#393b79", "#637939", "#8c6d31", "#843c39", "#7b4178",
    "#3182bd", "#31a354", "#756bb1", "#636363", "#d6616b",
  ]

  // Handle FFT analysis (uses log output, not .raw)
  if (analysisType === "fft") {
    console.log("== Step 4 — parse Fourier output from log ==")
    const fourierResults = parseFourierOutput(log)
    if (fourierResults.length === 0) {
      console.log("   WARNING: No Fourier output found in log")
      console.log("   Log excerpt:", log.slice(-500))
    } else {
      for (const fr of fourierResults) {
        console.log("   Variable:", fr.variable, " THD:", fr.thd.toFixed(3) + "%")
        for (const h of fr.harmonics.slice(0, 5)) {
          console.log("     H" + h.harmonic + ": " + h.frequency + "Hz, mag=" + h.magnitude.toFixed(4) + "V, phase=" + h.phase.toFixed(2) + "deg")
        }
      }
    }

    // Build FFT probes: one trace (magnitude vs. frequency) across all harmonics
    const fftProbes = fourierResults.length > 0 ? [{
      name: "Harmonic Magnitude",
      color: PALETTE[0],
      values: fourierResults[0].harmonics.map((h) => h.magnitude),
      type: "magnitude" as const,
    }] : []

    const designId = nir.design_id || fixtureName
    const probeJson = JSON.stringify(fftProbes)
    const xValuesJson = JSON.stringify(
      fourierResults.length > 0 ? fourierResults[0].harmonics.map((h) => h.frequency) : [],
    )

    let html = readTemplate()
    html = replaceAll(html, "{{DESIGN_ID}}", designId)
    html = replaceAll(html, "{{WARN_BANNER}}", "")
    html = replaceAll(html, "{{PROBES_JSON}}", probeJson)
    html = replaceAll(html, "{{TIME_JSON}}", xValuesJson)
    html = replaceAll(html, "{{X_AXIS_LABEL}}", "Frequency (Hz)")
    html = replaceAll(html, "{{NETLIST}}", nl.netlist)
    html = replaceAll(html, "{{T_START_MS}}", "0")
    html = replaceAll(html, "{{T_END_MS}}", String(fftProbes.length > 0 ? fftProbes[0].values.length : 0))
    html = replaceAll(html, "{{ANALYSIS_TYPE}}", "fft")
    html = replaceAll(html, "{{TRAN_SELECTED}}", "")
    html = replaceAll(html, "{{OP_SELECTED}}", "")
    html = replaceAll(html, "{{DC_SELECTED}}", "")
    html = replaceAll(html, "{{AC_SELECTED}}", "")
    html = replaceAll(html, "{{FFT_SELECTED}}", "selected")
    html = replaceAll(html, "{{COMPONENTS_JSON}}", "[]")
    html = replaceAll(html, "{{ANALYSIS_FILE_MAP}}", JSON.stringify(buildAnalysisFileMap(fixtureName)))

    writeFileSync(outHtml, html, "utf8")
    console.log("   wrote " + outHtml)
    return
  }

  console.log("== Step 4 — parse .raw ==")
  const parsed = parseRawFile(raw)
  const probeNames = Object.keys(parsed.vectors).filter((k) => k !== "time")
  console.log("   plot:", parsed.plotname, " points:", parsed.numPoints)
  console.log("   probes:", probeNames)

  // Determine x-axis: "time" for TRAN, swept source for DC, frequency for AC
  let time: number[] | null = null
  let xAxisLabel = "Index"
  if (parsed.vectors["time"]) {
    time = parsed.vectors["time"]
    xAxisLabel = "Time (ms)"
  } else if (analysisType === "dc") {
    const sweepVar = probeNames.find((k) => k.includes("sweep"))
      ?? probeNames.find((k) => k.startsWith("v(v-"))
    if (sweepVar && parsed.vectors[sweepVar]) {
      time = parsed.vectors[sweepVar]
      xAxisLabel = sweepVar + " (V)"
    }
  } else if (analysisType === "ac") {
    // AC sweep: frequency variable is named "frequency" in ngspice output
    if (parsed.vectors["frequency"]) {
      time = parsed.vectors["frequency"]
      xAxisLabel = "Frequency (Hz)"
    }
  }

  const probes = probeNames.map((name, i) => ({
    name,
    color: PALETTE[i % PALETTE.length],
    values: parsed.vectors[name],
    type: name.startsWith("i(") || /#branch/.test(name) ? "current" : "voltage",
  }))

  // For AC analysis: compute magnitude (dB) and phase (degrees) from complex vectors
  const acProbes: typeof probes = []
  if (analysisType === "ac" && parsed.complexVectors) {
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i]
      const imag = parsed.complexVectors[p.name]
      if (!imag) continue
      // Magnitude in dB: 20 * log10(|H(f)|)
      const magDb = p.values.map((re, j) => {
        const im = imag[j] ?? 0
        const mag = Math.sqrt(re * re + im * im)
        return mag > 0 ? 20 * Math.log10(mag) : -200
      })
      // Phase in degrees: atan2(imag, real)
      const phaseDeg = p.values.map((re, j) => {
        const im = imag[j] ?? 0
        return Math.atan2(im, re) * (180 / Math.PI)
      })
      acProbes.push({
        name: p.name + " |H(f)| (dB)",
        color: p.color,
        values: magDb,
        type: "magnitude",
      })
      acProbes.push({
        name: p.name + " phase (deg)",
        color: p.color,
        values: phaseDeg,
        type: "phase",
      })
    }
  }

  // x-axis data: time in ms for TRAN, raw values for DC, frequency for AC, index for OP
  const xValues = time ? time.map((t: number) => t * 1000) : probes[0]?.values.map((_: number, i: number) => i) ?? []
  const xLabel = xAxisLabel
  const tStartMs = xValues[0] ?? 0
  const tEndMs = xValues[xValues.length - 1] ?? 1

  // Use acProbes for AC analysis (magnitude/phase), regular probes otherwise
  const displayProbes = analysisType === "ac" && acProbes.length > 0 ? acProbes : probes

  const allFlatZero = probes.length > 0 && probes.every((p) =>
    p.values.every((x: number) => Math.abs(x) < 1e-9)
  )

  const warnBannerHtml = allFlatZero
    ? '<div class="warn-banner">\u26a0 <strong>All probes flat at 0V</strong> \u2014 VIN / VCC are not set in this fixture, so implicit V-sources default to DC 0. See <code>netlistFromCircuitJson.ts</code> (voltage-source injection) \u2014 this is the chart of what NGSPICE actually solved.</div>'
    : ""

  const designId = nir.design_id || fixtureName

  console.log("== Step 5 — build interactive HTML (Plotly.js) ==")

  const probeJson = JSON.stringify(displayProbes)
  const xValuesJson = JSON.stringify(xValues)
  const netlistForHtml = nl.netlist

  // Read the HTML template and replace placeholders
  let html = readTemplate()
  html = replaceAll(html, "{{DESIGN_ID}}", designId)
  html = replaceAll(html, "{{SCHEMATIC_FILE}}", "current_schematic.html")
  html = replaceAll(html, "{{WARN_BANNER}}", warnBannerHtml)
  html = replaceAll(html, "{{PROBES_JSON}}", probeJson)
  html = replaceAll(html, "{{TIME_JSON}}", xValuesJson)
  html = replaceAll(html, "{{X_AXIS_LABEL}}", xLabel)
  html = replaceAll(html, "{{NETLIST}}", netlistForHtml)
  html = replaceAll(html, "{{T_START_MS}}", tStartMs.toFixed(3))
  html = replaceAll(html, "{{T_END_MS}}", tEndMs.toFixed(3))
  html = replaceAll(html, "{{ANALYSIS_TYPE}}", analysisType)

  // Inject component slider hints from NIR fixture
  const sliderHints = extractSliderHints(nir as unknown as NirV11)
  html = replaceAll(html, "{{COMPONENTS_JSON}}", JSON.stringify(sliderHints))

  // Inject analysis file map — all analysis types use the same current_sim.html file
  const analysisFileMap: Record<string, string> = {
    tran: "current_sim.html",
    op: "current_sim.html",
    dc: "current_sim.html",
    ac: "current_sim.html",
    fft: "current_sim.html",
  }
  html = replaceAll(html, "{{ANALYSIS_FILE_MAP}}", JSON.stringify(analysisFileMap))

  // Set the correct selected option in the dropdown
  html = replaceAll(html, "{{TRAN_SELECTED}}", analysisType === "tran" ? "selected" : "")
  html = replaceAll(html, "{{OP_SELECTED}}", analysisType === "op" ? "selected" : "")
  html = replaceAll(html, "{{DC_SELECTED}}", analysisType === "dc" ? "selected" : "")
  html = replaceAll(html, "{{AC_SELECTED}}", analysisType === "ac" ? "selected" : "")
  html = replaceAll(html, "{{FFT_SELECTED}}", (analysisType as string) === "fft" ? "selected" : "")

  writeFileSync(outHtml, html, "utf8")
  console.log("   wrote " + outHtml)
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exit(1)
})
