import { readFileSync } from "fs"
const { CircuitRunner } = await import("@tscircuit/eval")

async function probe(name: string, src: string) {
  const runner = new CircuitRunner()
  try {
    await runner.executeWithFsMap({ fsMap: { "circuit.tsx": src }, mainComponentPath: "circuit.tsx" })
    await runner.renderUntilSettled()
    const cj = (await runner.getCircuitJson()) as any[]
    const comps = cj.filter((e) => e.type === "source_component" || e.type === "source_component_base")
    const pcb = cj.filter((e) => e.type === "pcb_component")
    const ports = cj.filter((e) => e.type === "source_port")
    const traces = cj.filter((e) => e.type === "source_trace")
    console.log(JSON.stringify({
      name,
      components: comps.map(c => ({ name: c.name, type: c.component_type, ftype: c.ftype })),
      pcbComponents: pcb.map(p => ({ name: p.name, center: p.center })),
      ports: ports.map(p => ({ ref: p.source_component_id, pin: p.pin_number, name: p.name })),
      traces: traces.map(t => ({ conn: t.connected_source_port_ids, nets: t.connected_source_net_ids })),
    }, null, 1))
  } catch (e: any) {
    console.log(JSON.stringify({ name, ERROR: String(e?.message ?? e).slice(0, 300) }))
  } finally {
    await runner.kill()
  }
}

await probe("chip no footprint", `
import { board, chip } from "tscircuit"
export default () => (
  <board width="30mm" height="30mm">
    <chip name="V1" pinLabels={{ pin1: "1", pin2: "2" }} />
    <resistor name="R1" resistance="1k" />
    <trace from="V1.1" to="net.POWER" />
    <trace from="V1.2" to="net.GND" />
    <trace from="R1.pin1" to="net.POWER" />
    <trace from="R1.pin2" to="net.GND" />
  </board>
)`)

await probe("voltageSource", `
import { board, voltageSource, resistor } from "tscircuit"
export default () => (
  <board width="30mm" height="30mm">
    <voltageSource name="V1" />
    <resistor name="R1" resistance="1k" />
    <trace from="V1.positive" to="net.POWER" />
    <trace from="V1.negative" to="net.GND" />
    <trace from="R1.pin1" to="net.POWER" />
    <trace from="R1.pin2" to="net.GND" />
  </board>
)`)

await probe("voltageSource trace to pin1/pin2", `
import { board, voltageSource, resistor } from "tscircuit"
export default () => (
  <board width="30mm" height="30mm">
    <voltageSource name="V1" />
    <resistor name="R1" resistance="1k" />
    <trace from="V1.1" to="net.POWER" />
    <trace from="V1.2" to="net.GND" />
    <trace from="R1.pin1" to="net.POWER" />
    <trace from="R1.pin2" to="net.GND" />
  </board>
)`)
