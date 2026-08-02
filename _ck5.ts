import { serializeNirAsync } from "./serializer/serializer.ts"
import { rcLowpassNir } from "./serializer/fixtures/index.ts"

const r = await serializeNirAsync(rcLowpassNir)
const ph = r.circuitJson.filter((e: any) => e.type === "pcb_plated_hole")
console.log(JSON.stringify(ph, null, 2))
