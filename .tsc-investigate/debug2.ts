import { readFileSync } from "fs"

const { serializeNirAsync } = await import("../serializer/serializer.ts")
const nir = JSON.parse(readFileSync(import.meta.dir + "/../serializer/fixtures/audioamplifier_lm386.nir.json", "utf8"))

const so = await serializeNirAsync(nir)
const cj = so.circuitJson as any[]

const schPorts = cj.filter((e) => e.type === "schematic_port")
const sourcePorts = cj.filter((e) => e.type === "source_port")
const sourceNets = cj.filter((e) => e.type === "source_net")
const sourceTraces = cj.filter((e) => e.type === "source_trace")

console.log("=== schematic_port sample ===")
console.log(JSON.stringify(schPorts[0], null, 2))
console.log("=== schematic_component sample ===")
const schComps = cj.filter((e) => e.type === "schematic_component")
console.log(JSON.stringify(schComps[0], null, 2))

// Map net name -> connected source ports via subcircuit_connectivity_map_key on source_port
const connKeyToNets = new Map()
for (const n of sourceNets) {
  if (n.subcircuit_connectivity_map_key && n.name) {
    if (!connKeyToNets.has(n.subcircuit_connectivity_map_key)) connKeyToNets.set(n.subcircuit_connectivity_map_key, n)
  }
}
const connKeyToSourcePorts = new Map()
for (const sp of sourcePorts) {
  if (!sp.subcircuit_connectivity_map_key) continue
  if (!connKeyToSourcePorts.has(sp.subcircuit_connectivity_map_key)) connKeyToSourcePorts.set(sp.subcircuit_connectivity_map_key, [])
  connKeyToSourcePorts.get(sp.subcircuit_connectivity_map_key).push(sp)
}

// schematic_port -> source_port via source_port_id
const spBySchId = new Map(schPorts.map(p => [p.schematic_port_id, p]))

for (const [key, net] of connKeyToNets) {
  const srcPorts = connKeyToSourcePorts.get(key) ?? []
  // find schematic ports
  const schIds = srcPorts.map(sp => {
    const sch = schPorts.find(s => s.source_port_id === sp.source_port_id)
    return sch?.schematic_port_id ?? null
  }).filter(Boolean)
  console.log(`${net.name}: ${schIds.join(", ")}`)
}
