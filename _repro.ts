import { serializeNirAsync } from "./serializer/serializer"
import raw from "./serializer/fixtures/layer2mockschema.nir.json"

const out = await serializeNirAsync(raw as any)
console.log("OK, elements:", out.circuitJson.length)
