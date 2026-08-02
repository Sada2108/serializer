import { serializeNirAsync } from "./serializer/serializer"
import { circuitJsonToSimpleRouteJson, mergeRoutedTraces, removeZeroLengthSegments } from "./serializer/pcbRouting"
import { routeCircuit } from "./serializer/router"
import { circuitJsonToKicadPcb } from "./serializer/kicadPcbWriter"
import { rcLowpassNir, opampNoninvNir } from "./serializer/fixtures"
import { writeFileSync } from "fs"

const fixture = process.argv[2] === "rc_lowpass" ? rcLowpassNir : opampNoninvNir
const name = process.argv[2] === "rc_lowpass" ? "rc_lowpass" : "opamp_test"

const result = await serializeNirAsync(fixture)
let ci: any[] = JSON.parse(JSON.stringify(result.circuitJson))

// Center components
const allPos = ci.filter((e: any) =>
  e.type === "pcb_component" || e.type === "pcb_smtpad" ||
  e.type === "pcb_plated_hole" || e.type === "pcb_port"
)
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
for (const p of allPos) {
  const x = p.center?.x ?? p.x ?? 0
  const y = p.center?.y ?? p.y ?? 0
  if (x < minX) minX = x; if (x > maxX) maxX = x
  if (y < minY) minY = y; if (y > maxY) maxY = y
}
const shiftX = -(minX + maxX) / 2, shiftY = -(minY + maxY) / 2
for (const el of ci) {
  if (el.type === "pcb_component" && el.center) { el.center.x += shiftX; el.center.y += shiftY }
  if ((el.type === "pcb_smtpad" || el.type === "pcb_plated_hole" || el.type === "pcb_port") && "x" in el && "y" in el) { el.x += shiftX; el.y += shiftY }
  if (el.type === "pcb_silkscreen_text" && el.anchor_position) { el.anchor_position.x += shiftX; el.anchor_position.y += shiftY }
}

// Remove old traces, re-route with CapacityMeshSolver
ci = ci.filter((e: any) => e.type !== "pcb_trace")
const srj = circuitJsonToSimpleRouteJson(ci)
const connectionNames = srj.connections.map((c: any) => c.name)
const routeResult = await routeCircuit(srj)
if (!routeResult.success) { console.error("Routing failed:", routeResult.error); process.exit(1) }

ci = mergeRoutedTraces(ci, routeResult.traces, connectionNames, srj)
ci = removeZeroLengthSegments(ci)

const newTraces = ci.filter((e: any) => e.type === "pcb_trace")
console.log(`${newTraces.length} traces from CapacityMeshSolver`)

const kicadPcb = circuitJsonToKicadPcb(ci)
writeFileSync(`_${name}.kicad_pcb`, kicadPcb)
console.log(`saved _${name}.kicad_pcb (${kicadPcb.length}b)`)
