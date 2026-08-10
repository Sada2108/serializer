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
    const ports = cj.filter((e) => e.type === "schematic_port")
    const wired = ports.filter((p) => p.connectedTo?.some?.((c) => c.schematic_trace_id))
    console.log(JSON.stringify({ name, traces: traces.length, labels: labels.map(l => l.text), ports: ports.length, wiredPorts: wired.length }))
  } finally {
    await runner.kill()
  }
}

// Nets formed IMPLICITLY via pinAssignments -> named nets. No explicit <trace>.
// hasExplicitPortNetTrace should be false -> label-skip rule can fire.
const implicitNets = `
import { board, chip } from "tscircuit"

export default () => (
  <board width="30mm" height="30mm" schMaxTraceDistance="50">
    <chip name="U1" footprint="soic8" pinAssignments={{ pin1: "SIG", pin2: "OUT" }} />
    <chip name="U2" footprint="soic8" pinAssignments={{ pin1: "SIG", pin2: "OUT" }} />
  </board>
)`

// Same but via subcircuit with a net interface
const subcircuitNets = `
import { subcircuit, chip } from "tscircuit"

export const Amp = () => (
  <subcircuit name="Amp" schStyle="box" ports={[
    { name: "SIG", dir: "input" },
    { name: "OUT", dir: "output" },
  ]}>
    <chip name="U1" footprint="soic8" pinAssignments={{ pin1: "SIG", pin2: "OUT" }} />
    <chip name="U2" footprint="soic8" pinAssignments={{ pin1: "SIG", pin2: "OUT" }} />
  </subcircuit>
)

export default () => <Amp />`

await render("implicit nets via pinAssignments", implicitNets)
await render("subcircuit net interface", subcircuitNets)
