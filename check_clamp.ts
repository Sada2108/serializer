import { formatValue } from "./simulator/formatNumbers"

console.log(formatValue(-4.440892098500626e-18, "i(v1)"))  // expect "0A"
console.log(formatValue(4.000000000000001e-6, "time"))     // expect "4µs"
console.log(formatValue(1e-9, "i(v1)"))                     // expect real 1nA preserved, not clamped
console.log(formatValue(1e-12, "i(v1)"))                    // boundary case — check this lands where you expect
