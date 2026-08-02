// Serializer — Live simulation server for interactive sliders.
//
// Usage: bun run layer_three/dev-tools/sim_server.ts
// Endpoints:
//   GET  /              — generates full simulator HTML page in-process (no file write)
//   GET  /fixture/:name — returns component list for slider generation
//   POST /simulate      — accepts { fixture, components: { ref: value } }
//                          reruns ngspice, returns parsed TRAN result as JSON
//   GET  /*             — serves static files from this directory
//
// Requires: bun, ngspice installed and on PATH.

import { serializeNirAsync } from "../serializer/serializer.ts"
import { netlistFromCircuitJson } from "../simulator/netlistFromCircuitJson.ts"
import { parseRawFile } from "../simulator/parseRawFile.ts"
import { parseFourierOutput } from "../simulator/parseFourierOutput.ts"
import {
  opampNoninvNir,
  voltageDividerNir,
  rcLowpassNir,
  rcLowpassAcNir,
  rcLowpassFftNir,
  type NirV11,
} from "../serializer/fixtures/index.ts"
import { spawn } from "child_process"
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// ---------------------------------------------------------------------------
// Fixture registry
// ---------------------------------------------------------------------------
const FIXTURES: Record<string, NirV11> = {
  opamp_noninv_001: opampNoninvNir as unknown as NirV11,
  voltage_divider_001: voltageDividerNir as unknown as NirV11,
  rc_lowpass_001: rcLowpassNir as unknown as NirV11,
  rc_lowpass_ac_001: rcLowpassAcNir as unknown as NirV11,
  rc_lowpass_fft_001: rcLowpassFftNir as unknown as NirV11,
}

// ---------------------------------------------------------------------------
// ngspice runner (same as render_interactive_simulator.ts)
// ---------------------------------------------------------------------------
async function runNgspice(netlist: string): Promise<{ raw: string; log: string }> {
  const workDir = mkdtempSync(join(tmpdir(), "sim-"))
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
      try {
        const raw = existsSync(rawPath) ? readFileSync(rawPath, "utf8") : ""
        const log = readFileSync(logPath, "utf8")
        resolve({ raw, log })
      } catch {
        reject(new Error("ngspice did not write output files (exit " + code + ")"))
      }
    })
    p.on("error", (e) => reject(e))
  })
}

// ---------------------------------------------------------------------------
// Deep-clone a NIR and override component values
// ---------------------------------------------------------------------------
function overrideComponentValues(nir: NirV11, overrides: Record<string, string>): NirV11 {
  const clone = JSON.parse(JSON.stringify(nir)) as NirV11
  for (const comp of clone.components) {
    if (overrides[comp.ref] !== undefined) {
      comp.value = overrides[comp.ref]
    }
  }
  return clone
}

// ---------------------------------------------------------------------------
// Parse SPICE value string to number (for range hints)
// ---------------------------------------------------------------------------
function parseSpiceValue(s: string): number {
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

// ---------------------------------------------------------------------------
// Classify component for slider hints
// ---------------------------------------------------------------------------
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

function getSliderHint(comp: { ref: string; component_type: string; value?: string | null }): SliderHint | null {
  const val = comp.value
  if (!val) return null
  const num = parseSpiceValue(val)
  if (!Number.isFinite(num) || num <= 0) return null

  const type = comp.component_type
  if (type === "resistor") {
    return {
      ref: comp.ref, componentType: type, value: val,
      numericValue: num, unit: "\u03A9", logScale: true,
      min: 1, max: num * 100, step: num * 0.1,
    }
  }
  if (type === "capacitor") {
    return {
      ref: comp.ref, componentType: type, value: val,
      numericValue: num, unit: "F", logScale: true,
      min: num * 0.01, max: num * 100, step: num * 0.1,
    }
  }
  if (type === "inductor") {
    return {
      ref: comp.ref, componentType: type, value: val,
      numericValue: num, unit: "H", logScale: true,
      min: num * 0.01, max: num * 100, step: num * 0.1,
    }
  }
  if (type === "voltage_source") {
    return {
      ref: comp.ref, componentType: type, value: val,
      numericValue: num, unit: "V", logScale: false,
      min: 0, max: num * 5 || 10, step: num * 0.1 || 0.5,
    }
  }
  if (type === "current_source") {
    return {
      ref: comp.ref, componentType: type, value: val,
      numericValue: num, unit: "A", logScale: false,
      min: 0, max: num * 5 || 1, step: num * 0.1 || 0.1,
    }
  }
  // Unknown type — still allow slider if numeric
  return {
    ref: comp.ref, componentType: type, value: val,
    numericValue: num, unit: "", logScale: false,
    min: num * 0.1, max: num * 10, step: num * 0.1,
  }
}

// ---------------------------------------------------------------------------
// Format number as SPICE value
// ---------------------------------------------------------------------------
function formatSpiceValue(n: number, unit: string): string {
  if (unit === "\u03A9" || unit === "ohm") {
    if (n >= 1e6) return (n / 1e6) + "Meg"
    if (n >= 1e3) return (n / 1e3) + "k"
    return n.toString()
  }
  if (unit === "F") {
    if (n >= 1) return n + ""
    if (n >= 1e-3) return (n * 1e3) + "m"
    if (n >= 1e-6) return (n * 1e6) + "u"
    if (n >= 1e-9) return (n * 1e9) + "n"
    if (n >= 1e-12) return (n * 1e12) + "p"
    return n.toExponential(2)
  }
  if (unit === "H") {
    if (n >= 1) return n + ""
    if (n >= 1e-3) return (n * 1e3) + "m"
    if (n >= 1e-6) return (n * 1e6) + "u"
    return n.toExponential(2)
  }
  // V, A, or generic
  return n.toString()
}

// ---------------------------------------------------------------------------
// In-process HTML page generation for GET /
// ---------------------------------------------------------------------------

const PALETTE = [
  "#1f77b4", "#d62728", "#2ca02c", "#ff7f0e", "#9467bd",
  "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
  "#393b79", "#637939", "#8c6d31", "#843c39", "#7b4178",
  "#3182bd", "#31a354", "#756bb1", "#636363", "#d6616b",
]

function readSimTemplate(): string {
  return readFileSync(join(import.meta.dir, "interactive_simulator.html"), "utf8")
}

function replaceAll(tpl: string, token: string, value: string): string {
  return tpl.split(token).join(value)
}

function extractSliderHints(nir: NirV11): SliderHint[] {
  const hints: SliderHint[] = []
  for (const comp of nir.components) {
    const val = comp.value
    if (!val) continue
    const num = parseSpiceValue(val)
    if (!Number.isFinite(num) || num <= 0) continue
    const type = comp.component_type
    if (type === "resistor") {
      hints.push({ ref: comp.ref, componentType: type, value: val, numericValue: num, unit: "\u03A9", logScale: true, min: 1, max: num * 100, step: num * 0.1 })
    } else if (type === "capacitor") {
      hints.push({ ref: comp.ref, componentType: type, value: val, numericValue: num, unit: "F", logScale: true, min: num * 0.01, max: num * 100, step: num * 0.1 })
    } else if (type === "inductor") {
      hints.push({ ref: comp.ref, componentType: type, value: val, numericValue: num, unit: "H", logScale: true, min: num * 0.01, max: num * 100, step: num * 0.1 })
    } else if (type === "voltage_source") {
      hints.push({ ref: comp.ref, componentType: type, value: val, numericValue: num, unit: "V", logScale: false, min: 0, max: num * 5 || 10, step: num * 0.1 || 0.5 })
    } else if (type === "current_source") {
      hints.push({ ref: comp.ref, componentType: type, value: val, numericValue: num, unit: "A", logScale: false, min: 0, max: num * 5 || 1, step: num * 0.1 || 0.1 })
    } else {
      hints.push({ ref: comp.ref, componentType: type, value: val, numericValue: num, unit: "", logScale: false, min: num * 0.1, max: num * 10, step: num * 0.1 })
    }
  }
  return hints
}

async function generateSimPageHtml(fixtureName: string, analysisType: string): Promise<string> {
  const nir = FIXTURES[fixtureName]
  if (!nir) throw new Error("Unknown fixture: " + fixtureName)

  const so = await serializeNirAsync(nir)
  const nl = netlistFromCircuitJson(so.circuitJson, nir as any, { analysisType: analysisType as any })
  const { raw, log } = await runNgspice(nl.netlist)

  // Handle FFT
  if (analysisType === "fft") {
    const fourierResults = parseFourierOutput(log)
    const fftProbes = fourierResults.length > 0 ? [{
      name: "Harmonic Magnitude",
      color: PALETTE[0],
      values: fourierResults[0].harmonics.map((h) => h.magnitude),
      type: "magnitude" as const,
    }] : []
    const probeJson = JSON.stringify(fftProbes)
    const xValuesJson = JSON.stringify(
      fourierResults.length > 0 ? fourierResults[0].harmonics.map((h) => h.frequency) : [],
    )
    let html = readSimTemplate()
    html = replaceAll(html, "{{DESIGN_ID}}", nir.design_id || fixtureName)
    html = replaceAll(html, "{{SCHEMATIC_FILE}}", "current_schematic.html")
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
    html = replaceAll(html, "{{ANALYSIS_FILE_MAP}}", JSON.stringify({ tran: "current_sim.html", op: "current_sim.html", dc: "current_sim.html", ac: "current_sim.html", fft: "current_sim.html" }))
    return html
  }

  const parsed = parseRawFile(raw)
  const probeNames = Object.keys(parsed.vectors).filter((k) => k !== "time")

  let time: number[] | null = null
  let xAxisLabel = "Index"
  if (parsed.vectors["time"]) {
    time = parsed.vectors["time"]
    xAxisLabel = "Time (ms)"
  } else if (analysisType === "dc") {
    const sweepVar = probeNames.find((k) => k.includes("sweep"))
      ?? probeNames.find((k) => k.startsWith("v(v-"))
    if (sweepVar && parsed.vectors[sweepVar]) { time = parsed.vectors[sweepVar]; xAxisLabel = sweepVar + " (V)" }
  } else if (analysisType === "ac") {
    if (parsed.vectors["frequency"]) { time = parsed.vectors["frequency"]; xAxisLabel = "Frequency (Hz)" }
  }

  const probes = probeNames.map((name, i) => ({
    name, color: PALETTE[i % PALETTE.length],
    values: parsed.vectors[name],
    type: name.startsWith("i(") || /#branch/.test(name) ? "current" : "voltage",
  }))

  // AC: magnitude + phase
  const acProbes: typeof probes = []
  if (analysisType === "ac" && parsed.complexVectors) {
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i]
      const imag = parsed.complexVectors[p.name]
      if (!imag) continue
      const magDb = p.values.map((re, j) => { const im = imag[j] ?? 0; const mag = Math.sqrt(re * re + im * im); return mag > 0 ? 20 * Math.log10(mag) : -200 })
      const phaseDeg = p.values.map((re, j) => { const im = imag[j] ?? 0; return Math.atan2(im, re) * (180 / Math.PI) })
      acProbes.push({ name: p.name + " |H(f)| (dB)", color: p.color, values: magDb, type: "magnitude" })
      acProbes.push({ name: p.name + " phase (deg)", color: p.color, values: phaseDeg, type: "phase" })
    }
  }

  const xValues = time ? time.map((t: number) => t * 1000) : probes[0]?.values.map((_: number, i: number) => i) ?? []
  const tStartMs = xValues[0] ?? 0
  const tEndMs = xValues[xValues.length - 1] ?? 1
  const displayProbes = analysisType === "ac" && acProbes.length > 0 ? acProbes : probes

  const allFlatZero = probes.length > 0 && probes.every((p) => p.values.every((x: number) => Math.abs(x) < 1e-9))
  const warnBannerHtml = allFlatZero
    ? '<div class="warn-banner">&#9888; <strong>All probes flat at 0V</strong> &#8212; VIN / VCC are not set in this fixture, so implicit V-sources default to DC 0. See <code>netlistFromCircuitJson.ts</code> (voltage-source injection) &#8212; this is the chart of what NGSPICE actually solved.</div>'
    : ""

  let html = readSimTemplate()
  html = replaceAll(html, "{{DESIGN_ID}}", nir.design_id || fixtureName)
  html = replaceAll(html, "{{SCHEMATIC_FILE}}", "current_schematic.html")
  html = replaceAll(html, "{{WARN_BANNER}}", warnBannerHtml)
  html = replaceAll(html, "{{PROBES_JSON}}", JSON.stringify(displayProbes))
  html = replaceAll(html, "{{TIME_JSON}}", JSON.stringify(xValues))
  html = replaceAll(html, "{{X_AXIS_LABEL}}", xAxisLabel)
  html = replaceAll(html, "{{NETLIST}}", nl.netlist)
  html = replaceAll(html, "{{T_START_MS}}", tStartMs.toFixed(3))
  html = replaceAll(html, "{{T_END_MS}}", tEndMs.toFixed(3))
  html = replaceAll(html, "{{ANALYSIS_TYPE}}", analysisType)
  html = replaceAll(html, "{{TRAN_SELECTED}}", analysisType === "tran" ? "selected" : "")
  html = replaceAll(html, "{{OP_SELECTED}}", analysisType === "op" ? "selected" : "")
  html = replaceAll(html, "{{DC_SELECTED}}", analysisType === "dc" ? "selected" : "")
  html = replaceAll(html, "{{AC_SELECTED}}", analysisType === "ac" ? "selected" : "")
  html = replaceAll(html, "{{FFT_SELECTED}}", analysisType === "fft" ? "selected" : "")
  html = replaceAll(html, "{{COMPONENTS_JSON}}", JSON.stringify(extractSliderHints(nir)))
  html = replaceAll(html, "{{ANALYSIS_FILE_MAP}}", JSON.stringify({ tran: "current_sim.html", op: "current_sim.html", dc: "current_sim.html", ac: "current_sim.html", fft: "current_sim.html" }))
  return html
}

// ---------------------------------------------------------------------------
// Bun server
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3777

console.log(`Serializer sim server starting on http://localhost:${PORT}`)
console.log(`Fixtures: ${Object.keys(FIXTURES).join(", ")}`)

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",

  async fetch(req) {
    const url = new URL(req.url)

    // CORS for local dev
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders })

    // GET /fixture/:name — return component list for slider generation
    if (req.method === "GET" && url.pathname.startsWith("/fixture/")) {
      const name = url.pathname.slice("/fixture/".length)
      const nir = FIXTURES[name]
      if (!nir) {
        return Response.json({ error: "Unknown fixture: " + name }, { status: 404, headers: corsHeaders })
      }
      const hints = nir.components
        .map(getSliderHint)
        .filter((h): h is SliderHint => h !== null)
      return Response.json({ fixture: name, components: hints }, { headers: corsHeaders })
    }

    // POST /simulate — rerun ngspice with overridden values
    if (req.method === "POST" && url.pathname === "/simulate") {
      try {
        const body = await req.json() as {
          fixture: string
          components: Record<string, string>
          analysisType?: string
          timeStep?: string
        }

        const nir = FIXTURES[body.fixture]
        if (!nir) {
          return Response.json({ error: "Unknown fixture: " + body.fixture }, { status: 404, headers: corsHeaders })
        }

        const analysisType = (body.analysisType as "tran" | "op" | "dc" | "ac" | "fft") ?? "tran"
        const timeStep = typeof body.timeStep === "string" ? body.timeStep : undefined
        const duration = typeof body.duration === "string" ? body.duration : undefined
        const overridden = overrideComponentValues(nir, body.components ?? {})

        console.log(`[simulate] fixture=${body.fixture} type=${analysisType} overrides=${JSON.stringify(body.components)}`)

        // Step 1: serialize
        const so = await serializeNirAsync(overridden)

        // Step 2: generate netlist
        const nl = netlistFromCircuitJson(so.circuitJson, overridden as any, { analysisType, timeStep, duration })
        console.log(`[simulate] netlist warnings: ${nl.warnings.length}`)
        for (const w of nl.warnings) console.log(`  - ${w}`)

        // Step 3: run ngspice
        const { raw, log } = await runNgspice(nl.netlist)

        // Step 4: parse output
        if (analysisType === "fft") {
          const fourierResults = parseFourierOutput(log)
          const fftProbes = fourierResults.length > 0 ? [{
            name: "Harmonic Magnitude",
            color: PALETTE[0],
            values: fourierResults[0].harmonics.map((h) => h.magnitude),
            type: "magnitude" as const,
          }] : []
          const fftXValues = fourierResults.length > 0
            ? fourierResults[0].harmonics.map((h) => h.frequency)
            : []
          return Response.json({
            ok: true,
            analysisType,
            netlist: nl.netlist,
            probes: fftProbes,
            xValues: fftXValues,
            xAxisLabel: "Frequency (Hz)",
          }, { headers: corsHeaders })
        }

        const parsed = parseRawFile(raw)
        const probeNames = Object.keys(parsed.vectors).filter((k) => k !== "time")

        // Determine x-axis
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
          if (parsed.vectors["frequency"]) {
            time = parsed.vectors["frequency"]
            xAxisLabel = "Frequency (Hz)"
          }
        }

        const xValues = time
          ? time.map((t) => analysisType === "tran" ? t * 1000 : t)
          : probeNames.length > 0
            ? parsed.vectors[probeNames[0]].map((_: number, i: number) => i)
            : []

        const probes = probeNames.map((name, i) => ({
          name,
          color: PALETTE[i % PALETTE.length],
          values: parsed.vectors[name],
          type: name.startsWith("i(") || /#branch/.test(name) ? "current" : "voltage",
        }))

        console.log(`[simulate] ok — ${probes.length} probes, ${xValues.length} points`)

        return Response.json({
          ok: true,
          analysisType,
          netlist: nl.netlist,
          xAxisLabel,
          xValues,
          probes,
        }, { headers: corsHeaders })

      } catch (e: any) {
        console.error("[simulate] ERROR:", e.message)
        return Response.json({ ok: false, error: e.message }, { status: 500, headers: corsHeaders })
      }
    }

    // GET / — generate full simulator HTML page in-process
    if (req.method === "GET" && url.pathname === "/") {
      const fixtureName = url.searchParams.get("fixture") ?? "rc_lowpass_001"
      const analysisType = url.searchParams.get("analysis") ?? "tran"
      try {
        if (!FIXTURES[fixtureName]) {
          return Response.json({ error: "Unknown fixture: " + fixtureName + ". Available: " + Object.keys(FIXTURES).join(", ") }, { status: 404, headers: corsHeaders })
        }
        const html = await generateSimPageHtml(fixtureName, analysisType)
        return new Response(html, { headers: { "Content-Type": "text/html", ...corsHeaders } })
      } catch (e: any) {
        console.error("[GET /] ERROR:", e.message)
        return new Response("Simulation error: " + e.message, { status: 500, headers: { "Content-Type": "text/plain", ...corsHeaders } })
      }
    }

    // Fallback: serve static files from this directory (assets, current_*.html)
    const filePath = join(import.meta.dir, url.pathname === "/" ? "current_sim.html" : url.pathname)
    if (existsSync(filePath)) {
      const content = readFileSync(filePath)
      const ext = filePath.split(".").pop() ?? ""
      const mime = ext === "html" ? "text/html" : ext === "js" ? "text/javascript" : ext === "css" ? "text/css" : "text/plain"
      return new Response(content, { headers: { "Content-Type": mime, ...corsHeaders } })
    }

    // If exact file not found and path looks like an HTML file, serve generated page
    if (url.pathname.endsWith(".html")) {
      const fixtureName = url.searchParams.get("fixture") ?? "rc_lowpass_001"
      const analysisType = url.searchParams.get("analysis") ?? "tran"
      try {
        if (FIXTURES[fixtureName]) {
          const html = await generateSimPageHtml(fixtureName, analysisType)
          return new Response(html, { headers: { "Content-Type": "text/html", ...corsHeaders } })
        }
      } catch { /* fall through to 404 */ }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders })
  },
})

console.log(`Ready. Try: curl http://localhost:${PORT}/fixture/rc_lowpass_001`)
