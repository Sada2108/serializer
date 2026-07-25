// Open_Forge — Live simulation server for interactive sliders.
//
// Usage: bun run layer_three/dev-tools/sim_server.ts
// Endpoints:
//   GET  /fixture/:name  — returns component list for slider generation
//   POST /simulate       — accepts { fixture, components: { ref: value } }
//                           reruns ngspice, returns parsed TRAN result as JSON
//   GET  /               — serves static HTML files from this directory
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
  opamp_noninv_001: opampNoninvNir,
  voltage_divider_001: voltageDividerNir,
  rc_lowpass_001: rcLowpassNir,
  rc_lowpass_ac_001: rcLowpassAcNir,
  rc_lowpass_fft_001: rcLowpassFftNir,
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
// Bun server
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3777

console.log(`Open Forge sim server starting on http://localhost:${PORT}`)
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
        }

        const nir = FIXTURES[body.fixture]
        if (!nir) {
          return Response.json({ error: "Unknown fixture: " + body.fixture }, { status: 404, headers: corsHeaders })
        }

        const analysisType = (body.analysisType as "tran" | "op" | "dc" | "ac" | "fft") ?? "tran"
        const overridden = overrideComponentValues(nir, body.components ?? {})

        console.log(`[simulate] fixture=${body.fixture} type=${analysisType} overrides=${JSON.stringify(body.components)}`)

        // Step 1: serialize
        const so = await serializeNirAsync(overridden)

        // Step 2: generate netlist
        const nl = netlistFromCircuitJson(so.circuitJson, overridden, { analysisType })
        console.log(`[simulate] netlist warnings: ${nl.warnings.length}`)
        for (const w of nl.warnings) console.log(`  - ${w}`)

        // Step 3: run ngspice
        const { raw, log } = await runNgspice(nl.netlist)

        // Step 4: parse output
        if (analysisType === "fft") {
          const fourierResults = parseFourierOutput(log)
          return Response.json({
            ok: true,
            analysisType,
            netlist: nl.netlist,
            fourier: fourierResults,
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

        const probes = probeNames.map((name) => ({
          name,
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

    // Fallback: serve static files from this directory
    const filePath = join(import.meta.dir, url.pathname === "/" ? "rc_lowpass_001_tran_interactive.html" : url.pathname)
    if (existsSync(filePath)) {
      const content = readFileSync(filePath)
      const ext = filePath.split(".").pop() ?? ""
      const mime = ext === "html" ? "text/html" : ext === "js" ? "text/javascript" : ext === "css" ? "text/css" : "text/plain"
      return new Response(content, { headers: { "Content-Type": mime, ...corsHeaders } })
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders })
  },
})

console.log(`Ready. Try: curl http://localhost:${PORT}/fixture/rc_lowpass_001`)
