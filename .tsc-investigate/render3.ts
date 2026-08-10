import { readFileSync } from "fs"

const { CircuitRunner } = await import("@tscircuit/eval")

async function render(name: string, src: string) {
  const runner = new CircuitRunner()
  try {
    await runner.executeWithFsMap({ fsMap: { "circuit.tsx": src }, mainComponentPath: "circuit.tsx" })
    await runner.renderUntilSettled()
    const cj = (await runner.getCircuitJson()) as any[]
    const traces = cj.filter((e) => e.type === "schematic_trace")
    const labels = cj.filter((e) => e.type === "schematic_net_label")
    console.log(JSON.stringify({ name, traces: traces.length, labels: labels.map(l => l.text) }))
  } finally {
    await runner.kill()
  }
}

// net.<name> prop matching on the pin — NO explicit trace JSX at all
const netProp = `
import { board, resistor } from "tscircuit"

export default () => (
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="1k" schPortArrangement={{ leftSize: 1, rightSize: 1 }} />
    <resistor name="R2" resistance="1k" schPortArrangement={{ leftSize: 1, rightSize: 1 }} />
    <trace from="R1.pin1" to="net.SIG" />
    <trace from="R2.pin1" to="net.SIG" />
  </board>
)`

// Two chips (schematic boxes) connected via one net, explicit port->net traces
const chipNet = `
import { board, chip } from "tscircuit"

export default () => (
  <board width="30mm" height="30mm" schMaxTraceDistance="50">
    <chip name="U1" footprint="soic8" pinLabels={{ pin1: "A", pin2: "B" }} />
    <chip name="U2" footprint="soic8" pinLabels={{ pin1: "A", pin2: "B" }} />
    <trace from="U1.pin1" to="net.SIG" />
    <trace from="U2.pin1" to="net.SIG" />
  </board>
)`

// Two chips connected directly port->port (no net)
const chipDirect = `
import { board, chip } from "tscircuit"

export default () => (
  <board width="30mm" height="30mm" schMaxTraceDistance="50">
    <chip name="U1" footprint="soic8" pinLabels={{ pin1: "A", pin2: "B" }} />
    <chip name="U2" footprint="soic8" pinLabels={{ pin1: "A", pin2: "B" }} />
    <trace from="U1.pin1" to="U2.pin1" />
  </board>
)`

await render("chip->net->chip", chipNet)
await render("chip->port->chip (direct)", chipDirect)
await render("passive via net (default dist)", netProp)
