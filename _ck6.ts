import { serializeNirAsync } from "./serializer/serializer.ts"
import { rcLowpassNir } from "./serializer/fixtures/index.ts"

const r = await serializeNirAsync(rcLowpassNir)

// Show source_trace connections (the netlist)
for (const el of r.circuitJson) {
  if (el.type === "source_net") {
    console.log("source_net:", (el as any).source_net_id, "name:", (el as any).name)
  }
}
console.log("---")
for (const el of r.circuitJson) {
  if (el.type === "source_trace") {
    console.log("source_trace:", (el as any).source_trace_id, "ports:", (el as any).connected_source_port_ids, "nets:", (el as any).connected_source_net_ids)
  }
}
console.log("---")
for (const el of r.circuitJson) {
  if (el.type === "pcb_port") {
    console.log("pcb_port:", (el as any).pcb_port_id, "source_port:", (el as any).source_port_id, "x:", (el as any).x, "y:", (el as any).y)
  }
}
console.log("---")
for (const el of r.circuitJson) {
  if (el.type === "source_port") {
    const e = el as any
    console.log("source_port:", e.source_port_id, "name:", e.name, "component:", e.source_component_id, "pin_number:", e.pin_number)
  }
}
console.log("---")
for (const el of r.circuitJson) {
  if (el.type === "pcb_trace") {
    const e = el as any
    console.log("pcb_trace:", e.pcb_trace_id, "net:", e.connection_name, "route:")
    for (const pt of e.route) {
      console.log("  ", pt.route_type, "x:", pt.x, "y:", pt.y, "layer:", pt.layer)
    }
  }
}
