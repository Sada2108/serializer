import { readFileSync } from "fs"

const { CircuitRunner } = await import("@tscircuit/eval")

async function render(file: string) {
  const runner = new CircuitRunner()
  try {
    const src = readFileSync(file, "utf8")
    await runner.executeWithFsMap({
      fsMap: { "circuit.tsx": src },
      mainComponentPath: "circuit.tsx",
    })
    await runner.renderUntilSettled()
    const cj = (await runner.getCircuitJson()) as any[]
    const comps = cj.filter((e) => e.type === "schematic_component")
    const traces = cj.filter((e) => e.type === "schematic_trace")
    const labels = cj.filter((e) => e.type === "schematic_net_label")
    console.log(JSON.stringify({
      file,
      schematic_components: comps.length,
      schematic_traces: traces.length,
      schematic_net_labels: labels.length,
      traces: traces.map((t) => ({
        id: t.schematic_trace_id,
        edges: t.edges?.length ?? null,
        net: t.subcircuit_connectivity_map_key ?? null,
      })),
      labels: labels.map((l) => ({ text: l.text, port: l.source_port_id ?? l.source_net_id ?? null })),
    }, null, 2))
  } finally {
    await runner.kill()
  }
}

await render(import.meta.dir + "/test1.tsx")
await render(import.meta.dir + "/test2.tsx")
