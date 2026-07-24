import { serializeNirAsync } from "./serializer/serializer"
import { opampNoninvNir } from "./serializer/fixtures"
import { writeFileSync } from "fs"

const result = await serializeNirAsync(opampNoninvNir)
writeFileSync("_opamp_test.kicad_pcb", result.kicadPcb)
console.log("saved")
