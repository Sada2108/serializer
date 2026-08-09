// Interactive schematic editor viewer driver.
// Usage: bun run render_interactive_schematic.ts [fixture_name]
//   fixture_name: rc_lowpass_001 (default) | voltage_divider_001 | opamp_noninv_001 | ...
// Output: layer_three/dev-tools/current_schematic.html (always overwritten)
//
// The interactive HTML embeds the exact SVG string that serializeNirAsync()
// produces (same bytes as schematic_output.svg) — interactivity is layered on
// via the data attributes already present in that SVG, not a separate render.

import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { serializeNirAsync } from "../../layer_three/serializer/serializer.ts"
import {
  opampNoninvNir, voltageDividerNir, rcLowpassNir, rcLowpassAcNir, rcLowpassFftNir,
  lm358NoninvNir, layer2mockschemaNir, audioAmplifier1386Nir, audioAmplifierLm386Nir,
  type NirV11,
} from "../../layer_three/serializer/fixtures/index.ts"

const FIXTURES = {
  opamp_noninv_001: opampNoninvNir,
  voltage_divider_001: voltageDividerNir,
  rc_lowpass_001: rcLowpassNir,
  rc_lowpass_ac_001: rcLowpassAcNir,
  rc_lowpass_fft_001: rcLowpassFftNir,
  lm358_noninv_001: lm358NoninvNir,
  layer2mockschema: layer2mockschemaNir,
  audio_amplifier_1386: audioAmplifier1386Nir,
  audio_amplifier_lm386: audioAmplifierLm386Nir,
} as const

type FixtureName = keyof typeof FIXTURES

// Map fixture -> simulator HTML filename (always current_sim.html)
const SIMULATOR_MAP: Record<string, string> = {
  opamp_noninv_001: "current_sim.html",
  voltage_divider_001: "current_sim.html",
  rc_lowpass_001: "current_sim.html",
  rc_lowpass_ac_001: "current_sim.html",
  rc_lowpass_fft_001: "current_sim.html",
  lm358_noninv_001: "current_sim.html",
}

function readTemplate(): string {
  const tplPath = join(import.meta.dir, "interactive_schematic.html")
  return readFileSync(tplPath, "utf8")
}

function replaceAll(tpl: string, token: string, value: string): string {
  return tpl.split(token).join(value)
}

async function main() {
  const fixtureName = (process.argv[2] as FixtureName) ?? "rc_lowpass_001"
  const nir = FIXTURES[fixtureName]
  if (!nir) {
    console.error("Unknown fixture: " + fixtureName + ". Available: " + Object.keys(FIXTURES).join(", "))
    process.exit(1)
  }

  const outHtml = join(import.meta.dir, "current_schematic.html")

  console.log("== Step 1 — serialize " + fixtureName + " NIR ==")
  const so = await serializeNirAsync(nir)
  console.log("   circuit-json elements:", so.circuitJson.length)
  console.log("   SVG bytes:", so.svg.length, "(viewer:", so.viewerUsed + ")")

  const designId = (nir as NirV11).design_id || fixtureName
  const simulatorFile = SIMULATOR_MAP[fixtureName] || ""

  console.log("== Step 2 — build interactive schematic HTML (embed serializeNirAsync SVG verbatim) ==")
  let html = readTemplate()
  html = replaceAll(html, "{{DESIGN_ID}}", designId)
  html = replaceAll(html, "{{SVG_CONTENT}}", so.svg)
  html = replaceAll(html, "{{CIRCUIT_JSON}}", JSON.stringify(so.circuitJson))
  html = replaceAll(html, "{{NIR_JSON}}", JSON.stringify(nir))
  html = replaceAll(html, "{{SIMULATOR_FILE}}", simulatorFile)

  writeFileSync(outHtml, html, "utf8")
  console.log("   wrote " + outHtml)
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exit(1)
})
