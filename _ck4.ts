import { serializeNirAsync } from "./serializer/serializer.ts"
import { rcLowpassNir } from "./serializer/fixtures/index.ts"

const r = await serializeNirAsync(rcLowpassNir)
for (const el of r.circuitJson) {
  if (el.type === "pcb_plated_hole" || el.type === "pcb_smtpad" || el.type === "pcb_component") {
    const e = el as any
    if (e.type === "pcb_component") {
      console.log("pcb_component:", e.source_component_id, "center:", e.center?.x?.toFixed(3), e.center?.y?.toFixed(3), "layer:", e.layer, "rot:", e.rotation)
    } else if (e.type === "pcb_smtpad") {
      console.log("  smtpad:", e.pcb_port_id, "pos:", e.x.toFixed(3), e.y.toFixed(3), "net:", (e as any).net ?? "?", "port:", e.pcb_port_id)
    } else if (e.type === "pcb_plated_hole") {
      console.log("  plated_hole:", e.pcb_port_id, "pos:", e.x.toFixed(3), e.y.toFixed(3))
    }
  }
}
