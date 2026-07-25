// Interactive schematic editor viewer driver.
// Usage: bun run render_interactive_schematic.ts [fixture_name]
//   fixture_name: rc_lowpass_001 (default) | voltage_divider_001 | opamp_noninv_001 | ...
// Output: layer_three/dev-tools/<fixture>_schematic.html

import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { serializeNirAsync, renderCircuitJson } from "../../layer_three/serializer/serializer.ts"
import { lookupSymbol } from "../../layer_three/serializer/symbolLibrary.ts"
import { lookupKicadSymbol } from "../../layer_three/serializer/kicadSymbolLibrary.ts"
import {
  opampNoninvNir, voltageDividerNir, rcLowpassNir, rcLowpassAcNir, rcLowpassFftNir,
  lm358NoninvNir,
  type NirV11,
} from "../../layer_three/serializer/fixtures/index.ts"

const FIXTURES = {
  opamp_noninv_001: opampNoninvNir,
  voltage_divider_001: voltageDividerNir,
  rc_lowpass_001: rcLowpassNir,
  rc_lowpass_ac_001: rcLowpassAcNir,
  rc_lowpass_fft_001: rcLowpassFftNir,
  lm358_noninv_001: lm358NoninvNir,
} as const

type FixtureName = keyof typeof FIXTURES

// Map fixture -> simulator HTML filename
const SIMULATOR_MAP: Record<string, string> = {
  opamp_noninv_001: "opamp_noninv_interactive.html",
  voltage_divider_001: "voltage_divider_001_tran_interactive.html",
  rc_lowpass_001: "rc_lowpass_001_tran_interactive.html",
  rc_lowpass_ac_001: "rc_lowpass_ac_001_ac_interactive.html",
  rc_lowpass_fft_001: "rc_lowpass_fft_001_fft_interactive.html",
  lm358_noninv_001: "",
}

function injectPowerSymbols(circuitJson: any[], nir: any): any[] {
  const nets = (nir as any).netlist || []
  const out = [...circuitJson]

  // Check which net names already have schematic_net_label entries
  // (CircuitRunner generates these with rail_up/rail_down symbols at correct positions)
  const existingLabels = new Set(
    circuitJson
      .filter((el: any) => el.type === "schematic_net_label")
      .map((el: any) => el.text)
  )

  for (const net of nets) {
    if (net.net_type !== "ground" && net.net_type !== "power") continue

    // Skip nets that CircuitRunner already handled — no duplicate labels
    if (existingLabels.has(net.net_name)) continue

    const schId = `net_${net.net_name}_sch`
    const sourceId = `net_${net.net_name}_source`

    let sx = 10, sy = 10
    if (net.connections && net.connections.length > 0) {
      const firstRef = net.connections[0].ref
      const comp = (nir as any).components?.find((c: any) => c.ref === firstRef)
      if (comp?.position && typeof comp.position.x_mm === "number" && typeof comp.position.y_mm === "number") {
        sx = comp.position.x_mm + (net.net_type === "ground" ? 0 : 3)
        sy = comp.position.y_mm + (net.net_type === "ground" ? 4 : -3)
      }
    }

    out.push({
      type: "source_net",
      source_net_id: `net_${net.net_name}`,
      name: net.net_name,
      member_source_group_ids: [],
      is_power: net.net_type === "power",
      is_ground: net.net_type === "ground",
      is_analog_signal: net.net_type === "analog",
    })

    if (net.net_type === "ground") {
      const gndSym = lookupKicadSymbol("ground")
      if (gndSym) {
        const bb = gndSym.bodyBox
        out.push({
          type: "schematic_component",
          schematic_component_id: schId,
          source_component_id: sourceId,
          center: { x: sx, y: sy },
          size: { width: Math.max(bb.width, 2), height: Math.max(bb.height, 2) },
          is_box_with_pins: false,
        })
        for (const prim of gndSym.primitives) {
          if (prim.type === "polyline" && prim.points && prim.points.length > 1) {
            const absPoints = prim.points.map(p => ({ x: sx + p.x, y: sy + p.y }))
            out.push({
              type: "schematic_path",
              schematic_path_id: `kgnd_${schId}`,
              schematic_component_id: schId,
              points: absPoints,
              is_filled: !!prim.filled,
              fill_color: prim.filled ? "#0c1e2e" : undefined,
            })
          } else if (prim.type === "pin" && prim.pin) {
            const px = sx + prim.pin.x, py = sy + prim.pin.y
            const angleRad = (prim.pin.angle * Math.PI) / 180
            const ex = px + Math.cos(angleRad) * prim.pin.length
            const ey = py - Math.sin(angleRad) * prim.pin.length
            out.push({
              type: "schematic_line",
              schematic_line_id: `kgnd_line_${schId}`,
              schematic_component_id: schId,
              x1: ex, y1: ey, x2: px, y2: py,
              color: "#0c1e2e",
              is_dashed: false,
            })
          }
        }
      } else {
        out.push({
          type: "schematic_component",
          schematic_component_id: schId,
          source_component_id: sourceId,
          center: { x: sx, y: sy },
          size: { width: 2, height: 2 },
          is_box_with_pins: true,
          symbol_name: "ground_down",
        })
      }
    } else {
      out.push({
        type: "schematic_text",
        schematic_text_id: `${schId}_label`,
        text: net.net_name,
        font_size: 1.0,
        position: { x: sx, y: sy },
        rotation: 0,
        anchor: "center",
        color: "#c00",
      })
    }
  }

  return out
}

/**
 * Post-process async CircuitRunner output to assign proper symbol_name
 * to components that the async path leaves without a symbol (e.g. op-amps).
 * Only acts on components that have NO symbol_name — does not override
 * tscircuit's own symbols (boxresistor_*, capacitor_*, etc.) which already
 * render correctly.
 */
function fixComponentSymbols(circuitJson: any[], nir: any): any[] {
  const out = circuitJson.map(el => ({ ...el }))

  // Build a map of source_component_id -> NIR component ref for lookup
  const nirCompBySourceId = new Map<string, any>()
  for (const el of out) {
    if (el.type === "source_component" && el.source_component_id) {
      const nirComp = (nir as any).components?.find((c: any) => c.ref === el.name)
      if (nirComp) nirCompBySourceId.set(el.source_component_id, nirComp)
    }
  }

  for (const el of out) {
    if (el.type !== "schematic_component") continue
    if (el.symbol_name) continue // already has a symbol — don't override

    const srcId = el.source_component_id
    if (!srcId) continue

    const nirComp = nirCompBySourceId.get(srcId)
    if (!nirComp) continue

    const kicadSym = lookupKicadSymbol(nirComp.component_type)
    if (kicadSym) {
      const bb = kicadSym.bodyBox
      el.is_box_with_pins = false
      el.size = { width: Math.max(bb.width, 2), height: Math.max(bb.height, 2) }

      for (const prim of kicadSym.primitives) {
        if (prim.type === "rectangle" && prim.start && prim.end) {
          out.push({
            type: "schematic_box",
            schematic_component_id: el.schematic_component_id,
            x: el.center.x + prim.start.x,
            y: el.center.y + prim.start.y,
            width: prim.end.x - prim.start.x,
            height: prim.end.y - prim.start.y,
            is_dashed: false,
          })
        } else if (prim.type === "polyline" && prim.points && prim.points.length > 1) {
          const absPoints = prim.points.map(p => ({ x: el.center.x + p.x, y: el.center.y + p.y }))
          out.push({
            type: "schematic_path",
            schematic_path_id: `kfix_${el.schematic_component_id}_${out.length}`,
            schematic_component_id: el.schematic_component_id,
            points: absPoints,
            is_filled: !!prim.filled,
            fill_color: prim.filled ? "#0c1e2e" : undefined,
          })
        } else if (prim.type === "pin" && prim.pin) {
          const px = el.center.x + prim.pin.x, py = el.center.y + prim.pin.y
          const angleRad = (prim.pin.angle * Math.PI) / 180
          const ex = px + Math.cos(angleRad) * prim.pin.length
          const ey = py - Math.sin(angleRad) * prim.pin.length
          out.push({
            type: "schematic_line",
            schematic_line_id: `kfix_line_${el.schematic_component_id}_${prim.pin.number}`,
            schematic_component_id: el.schematic_component_id,
            x1: ex, y1: ey, x2: px, y2: py,
            color: "#0c1e2e",
            is_dashed: false,
          })
        }
      }
    } else {
      const sym = lookupSymbol(nirComp.component_type)
      if (sym) {
        el.symbol_name = sym.symbolName
        el.is_box_with_pins = true
        el.size = { width: sym.width, height: sym.height }
      }
    }
  }

  return out
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

  const outHtml = join(import.meta.dir, fixtureName + "_schematic.html")

  console.log("== Step 1 — serialize " + fixtureName + " NIR ==")
  const so = await serializeNirAsync(nir)
  console.log("   circuit-json elements:", so.circuitJson.length)

  const enrichedCircuitJson = injectPowerSymbols(so.circuitJson, nir)
  const fixedCircuitJson = fixComponentSymbols(enrichedCircuitJson, nir)
  console.log("   after power symbols + symbol fix:", fixedCircuitJson.length)

  console.log("== Step 2 — re-render SVG with power symbols ==")
  const { svg: enrichedSvg } = renderCircuitJson(fixedCircuitJson)

  const designId = (nir as NirV11).design_id || fixtureName
  const simulatorFile = SIMULATOR_MAP[fixtureName] || ""

  console.log("== Step 3 — build interactive schematic HTML ==")
  let html = readTemplate()
  html = replaceAll(html, "{{DESIGN_ID}}", designId)
  html = replaceAll(html, "{{SVG_CONTENT}}", enrichedSvg)
  html = replaceAll(html, "{{CIRCUIT_JSON}}", JSON.stringify(fixedCircuitJson))
  html = replaceAll(html, "{{NIR_JSON}}", JSON.stringify(nir))
  html = replaceAll(html, "{{SIMULATOR_FILE}}", simulatorFile)

  writeFileSync(outHtml, html, "utf8")
  console.log("   wrote " + outHtml)
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exit(1)
})
