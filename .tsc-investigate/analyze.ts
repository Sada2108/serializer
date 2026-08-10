import { readFileSync } from "fs"

const { serializeNirAsync } = await import("../serializer/serializer.ts")
const nir = JSON.parse(readFileSync(import.meta.dir + "/../serializer/fixtures/audioamplifier_lm386.nir.json", "utf8"))

const so = await serializeNirAsync(nir)
const cj = so.circuitJson as any[]

const ports = cj.filter((e) => e.type === "schematic_port")
const traces = cj.filter((e) => e.type === "schematic_trace")
const labels = cj.filter((e) => e.type === "schematic_net_label")
const sourcePorts = cj.filter((e) => e.type === "source_port")
const sourceNets = cj.filter((e) => e.type === "source_net")
const sourceTraces = cj.filter((e) => e.type === "source_trace")

const schPortBySrcPortId = new Map(ports.filter(p => p.source_port_id).map(p => [p.source_port_id, p.schematic_port_id]))
const netBySrcNetId = new Map(sourceNets.map(n => [n.source_net_id, n]))

const netToSchPorts = new Map<string, Set<string>>()
for (const st of sourceTraces) {
  for (const nid of st.connected_source_net_ids ?? []) {
    if (!netToSchPorts.has(nid)) netToSchPorts.set(nid, new Set())
    for (const pid of st.connected_source_port_ids ?? []) {
      const schId = schPortBySrcPortId.get(pid)
      if (schId) netToSchPorts.get(nid)!.add(schId)
    }
  }
}

const traceEndpointIds = new Set<string>()
for (const t of traces) {
  for (const edge of t.edges ?? []) {
    for (const p of [edge.from, edge.to]) {
      for (const sp of ports) {
        if (Math.hypot(sp.center.x - p.x, sp.center.y - p.y) < 0.01) traceEndpointIds.add(sp.schematic_port_id)
      }
    }
  }
}

const labelPortIds = new Set<string>()
for (const l of labels) {
  if (l.source_port_id) labelPortIds.add(schPortBySrcPortId.get(l.source_port_id))
  else if (l.source_net_id) {
    for (const schId of netToSchPorts.get(l.source_net_id) ?? []) labelPortIds.add(schId)
  }
}

for (const [netId, schPortIds] of netToSchPorts) {
  const net = netBySrcNetId.get(netId)
  const names = [...schPortIds].map((sid) => {
    const sp = ports.find((p) => p.schematic_port_id === sid)
    const labelText = labels.find(l => l.anchor_position && Math.hypot(l.anchor_position.x - sp.center.x, l.anchor_position.y - sp.center.y) < 0.01)?.text ?? ""
    return `${sid}(wire:${traceEndpointIds.has(sid) ? "Y" : "N"},label:${labelPortIds.has(sid) ? "Y" : "N"})`
  })
  console.log(`${net?.name ?? netId}: ${names.join(" ")}`)
}

console.log("\ntotal schematic_traces:", traces.length, "| total schematic_net_labels:", labels.length)
console.log("trace ports covered:", traceEndpointIds.size, "/", ports.length)
