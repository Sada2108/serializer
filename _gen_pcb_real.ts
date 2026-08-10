import { writeFileSync } from "node:fs"
import { serializeNirAsync } from "./serializer/serializer.ts"
import { rcLowpassNir, opampNoninvNir } from "./serializer/fixtures/index.ts"

const out = await serializeNirAsync(rcLowpassNir)
writeFileSync("_rc_lowpass_real.kicad_pcb", out.kicadPcb ?? "")
console.log("rc_lowpass via serializeNirAsync ->", out.kicadPcb?.length ?? "NO PCB", "bytes")

const out2 = await serializeNirAsync(opampNoninvNir)
writeFileSync("_opamp_real.kicad_pcb", out2.kicadPcb ?? "")
console.log("opamp via serializeNirAsync ->", out2.kicadPcb?.length ?? "NO PCB", "bytes")
