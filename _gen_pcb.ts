import { serializeNirAsync } from "./serializer/serializer"
import { routeCircuitJson, snapCircuitJsonTracesToManhattan, enforceTracePadClearance, mergeCollinearSegments } from "./serializer/pcbRouting"
import { circuitJsonToKicadPcb } from "./serializer/kicadPcbWriter"
import { opampNoninvNir, rcLowpassNir } from "./serializer/fixtures"
import { writeFileSync } from "fs"

const fixture = process.argv[2] === "rc_lowpass" ? rcLowpassNir : opampNoninvNir
const name = process.argv[2] === "rc_lowpass" ? "rc_lowpass" : "opamp_test"

const result = await serializeNirAsync(fixture)
let ci = result.circuitJson

console.log(`Before routing: ${ci.filter((e: any) => e.type === "pcb_trace").length} pcb_trace elements`)

const routed = await routeCircuitJson(ci, fixture)
if (!routed.success) {
  console.error("Routing failed:", routed.error)
  process.exit(1)
}
ci = routed.circuitJson
console.log(`After routing: ${ci.filter((e: any) => e.type === "pcb_trace").length} pcb_trace elements`)

const merged = mergeCollinearSegments(ci)
const countWires = (c: any[]) => c.filter((e: any) => e.type === "pcb_trace").reduce((n: number, t: any) => n + (t.route?.filter((s: any) => s.route_type === "wire").length ?? 0), 0)
console.log(`After collinear merge: ${countWires(merged)} wire segments`)
const snapped = snapCircuitJsonTracesToManhattan(merged)
console.log(`After manhattan snap: ${countWires(snapped)} wire segments`)
const remerged = mergeCollinearSegments(snapped)
console.log(`After post-snap merge: ${countWires(remerged)} wire segments`)
let cleared = remerged
for (let pass = 0; pass < 5; pass++) {
  const prev = JSON.stringify(cleared)
  cleared = enforceTracePadClearance(cleared)
  if (JSON.stringify(cleared) === prev) break
  console.log(`enforceTracePadClearance pass ${pass + 1}: ${countWires(cleared)} wire segments`)
}
const kicadPcb = circuitJsonToKicadPcb(cleared, fixture as any)
writeFileSync(`_${name}.kicad_pcb`, kicadPcb)
console.log(`saved _${name}.kicad_pcb`)
