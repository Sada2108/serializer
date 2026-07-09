// Open_Forge — JS bridge for Python orchestrator.
//   node render.js to-spice   < circuit.json   -> stdout: SPICE netlist string
//   node render.js to-svg     < circuit.json   -> stdout: SVG string
//
// Uses:
//   circuit-to-svg           (@tscircuit org)
//   circuit-json-to-spice    (@tscircuit org)
//
// NOTE: never uses `tsci simulate` / any tscircuit wasm / ngspice wrapper.
// Python feeds the returned SPICE string to a REAL ngspice binary itself.

let stdinBuffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { stdinBuffer += chunk })
process.stdin.on("end", async () => {
  const cmd = process.argv[2]
  let circuitJson
  try {
    circuitJson = JSON.parse(stdinBuffer)
  } catch (e) {
    process.stderr.write("invalid circuit json on stdin: " + e.message + "\n")
    process.exit(1)
  }
  try {
    if (cmd === "to-spice") {
      const { circuitJsonToSpice } = await import("circuit-json-to-spice")
      const netlist = circuitJsonToSpice(circuitJson)
      process.stdout.write(typeof netlist === "string" ? netlist : JSON.stringify(netlist))
    } else if (cmd === "to-svg") {
      const { circuitJsonToSvg } = await import("circuit-to-svg")
      const svg = circuitJsonToSvg(circuitJson)
      process.stdout.write(typeof svg === "string" ? svg : String(svg))
    } else {
      process.stderr.write("unknown cmd: " + cmd + "\n")
      process.exit(2)
    }
  } catch (e) {
    process.stderr.write("bridge error: " + (e && e.stack ? e.stack : String(e)) + "\n")
    process.exit(3)
  }
})
