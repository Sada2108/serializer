import { readFileSync } from "fs"

const { serializeNirAsync } = await import("../serializer/serializer.ts")
const nir = JSON.parse(readFileSync(import.meta.dir + "/../serializer/fixtures/audioamplifier_lm386.nir.json", "utf8"))

const so = await serializeNirAsync(nir)
const cj = so.circuitJson as any[]

const sourcePorts = cj.filter((e) => e.type === "source_port")
const sourceNets = cj.filter((e) => e.type === "source_net")
const sourceTraces = cj.filter((e) => e.type === "source_trace")

console.log("=== sample source_trace ===")
console.log(JSON.stringify(sourceTraces[0], null, 2))
console.log("=== sample source_port ===")
console.log(JSON.stringify(sourcePorts.find(p => p.source_port_id === sourceTraces[0]?.connected_source_port_ids?.[0]), null, 2))
console.log("=== sample source_net ===")
console.log(JSON.stringify(sourceNets[0], null, 2))
