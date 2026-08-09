// KiCanvas PCB viewer driver.
// Usage: bun run render_pcb_viewer.ts [fixture_name]
//   fixture_name: rc_lowpass_001 (default) | opamp_noninv_001 | voltage_divider_001
//                 | rc_lowpass_ac_001 | rc_lowpass_fft_001 | instrumentation_amp_001
//                 | lm358_noninv_001 | 555_timer | audio_amplifier_1386 | audioamplifier_lm386
// Output: dev-tools/current_pcb.html (always overwritten)
//
// Pipeline: NIR fixture -> serializeNirAsync() -> SerializerOutput.kicadPcb
//   -> baked into <kicanvas-source type="board"> inside pcb_viewer.html
//   -> vendored kicanvas.js renders the board in the browser.

import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { serializeNirAsync } from "../serializer/serializer.ts"
import {
  opampNoninvNir,
  voltageDividerNir,
  rcLowpassNir,
  rcLowpassAcNir,
  rcLowpassFftNir,
  instrumentationAmpNir,
  lm358NoninvNir,
  timer555Nir,
  audioAmplifier1386Nir,
  audioAmplifierLm386Nir,
  type NirV11,
} from "../serializer/fixtures/index.ts"

const FIXTURES: Record<string, NirV11> = {
  rc_lowpass_001: rcLowpassNir as unknown as NirV11,
  rc_lowpass_ac_001: rcLowpassAcNir as unknown as NirV11,
  rc_lowpass_fft_001: rcLowpassFftNir as unknown as NirV11,
  voltage_divider_001: voltageDividerNir as unknown as NirV11,
  opamp_noninv_001: opampNoninvNir as unknown as NirV11,
  instrumentation_amp_001: instrumentationAmpNir,
  lm358_noninv_001: lm358NoninvNir as unknown as NirV11,
  "555_timer": timer555Nir as unknown as NirV11,
  audio_amplifier_1386: audioAmplifier1386Nir as unknown as NirV11,
  audioamplifier_lm386: audioAmplifierLm386Nir as unknown as NirV11,
}

// ---------------------------------------------------------------------------
// HTML template helper — read and replace {{PLACEHOLDER}} tokens
// ---------------------------------------------------------------------------
function readTemplate(): string {
  const tplPath = join(import.meta.dir, "pcb_viewer.html")
  return readFileSync(tplPath, "utf8")
}

function replaceAll(tpl: string, token: string, value: string): string {
  return tpl.split(token).join(value)
}

// Escape the raw .kicad_pcb S-expression for safe embedding as HTML text
// content. Only & < > need escaping; parens and quotes pass through verbatim.
function escapeHtml(s: string): string {
  return s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const fixtureName = process.argv[2] ?? "rc_lowpass_001"
  const nir = FIXTURES[fixtureName]
  if (!nir) {
    console.error(
      "Unknown fixture: " + fixtureName + ". Available: " + Object.keys(FIXTURES).join(", "),
    )
    process.exit(1)
  }

  const outHtml = join(import.meta.dir, "current_pcb.html")

  console.log("== Step 1 — serialize " + fixtureName + " NIR ==")
  const so = await serializeNirAsync(nir)
  console.log("   circuit-json elements:", so.circuitJson.length)

  console.log("== Step 2 — KiCad PCB output ==")
  if (!so.kicadPcb) {
    console.error(
      "   FATAL: fixture " + fixtureName + " produced no kicadPcb (no pcb_board element). " +
        "Only v1.1/v1.2 fixtures with a board_spec produce KiCad PCB output.",
    )
    process.exit(1)
  }
  console.log("   kicadPcb bytes:", so.kicadPcb.length)
  console.log("   starts with:", so.kicadPcb.slice(0, 40).replace(/\n/g, " "))

  const designId = nir.design_id || fixtureName

  console.log("== Step 3 — build KiCanvas HTML ==")
  let html = readTemplate()
  html = replaceAll(html, "{{KICAD_PCB}}", escapeHtml(so.kicadPcb))
  html = replaceAll(html, "{{FIXTURE_NAME}}", fixtureName)
  html = replaceAll(html, "{{DESIGN_ID}}", designId)

  writeFileSync(outHtml, html, "utf8")
  console.log("   wrote " + outHtml + " (" + html.length + " bytes)")
  console.log("   open in a browser to view the PCB via KiCanvas")
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exit(1)
})
