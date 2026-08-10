import { readFileSync } from "fs"

const { CircuitRunner } = await import("@tscircuit/eval")

async function render(name: string, src: string) {
  const runner = new CircuitRunner()
  try {
    await runner.executeWithFsMap({
      fsMap: { "circuit.tsx": src },
      mainComponentPath: "circuit.tsx",
    })
    await runner.renderUntilSettled()
    const cj = (await runner.getCircuitJson()) as any[]
    const comps = cj.filter((e) => e.type === "schematic_component")
    const traces = cj.filter((e) => e.type === "schematic_trace")
    const labels = cj.filter((e) => e.type === "schematic_net_label")
    const ports = cj.filter((e) => e.type === "schematic_port")
    const compPos = comps.map((c) => ({
      id: c.schematic_component_id,
      center: c.center,
      size: c.size,
    }))
    console.log(JSON.stringify({
      name,
      schematic_components: comps.length,
      schematic_traces: traces.length,
      schematic_net_labels: labels.length,
      compPos,
      traces: traces.map((t) => ({
        id: t.schematic_trace_id,
        edges: (t.edges ?? []).map((e: any) => ({ from: e.from, to: e.to })),
      })),
      labels: labels.map((l) => ({ text: l.text, anchor: l.anchor_position, side: l.anchor_side })),
    }, null, 2))
  } finally {
    await runner.kill()
  }
}

const board = (opts: string) => `
import { board, resistor, capacitor } from "tscircuit"

export default () => (
  <board width="20mm" height="20mm" ${opts}>
    <resistor name="R1" resistance="1k" />
    <resistor name="R2" resistance="1k" />
    <trace from="R1.pin1" to="net.SIG" />
    <trace from="R2.pin1" to="net.SIG" />
  </board>
)`

await render("port-to-net default (no schMaxTraceDistance)", board(""))
await render("port-to-net schMaxTraceDistance=20", board('schMaxTraceDistance="20"'))
await render("port-to-net schMaxTraceDistance=1", board('schMaxTraceDistance="1"'))

const pp = `
import { board, resistor } from "tscircuit"

export default () => (
  <board width="20mm" height="20mm" schMaxTraceDistance="20">
    <resistor name="R1" resistance="1k" />
    <resistor name="R2" resistance="1k" />
    <trace from="R1.pin1" to="R2.pin1" />
  </board>
)`
await render("port-to-port schMaxTraceDistance=20", pp)
