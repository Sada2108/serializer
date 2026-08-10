import { netlistFromCircuitJson } from "./simulator/netlistFromCircuitJson.ts";

const circuitJson = [
  { type: "source_component_base", name: "V1", component_type: "simulation_source", component_id: "VPULSE", footprint: "" },
  { type: "source_net", name: "POWER", is_power: true, is_ground: false },
  { type: "source_net", name: "GND", is_power: false, is_ground: true },
  { type: "source_trace", connected_source_port_ids: ["V1_source_port_1"], connected_source_net_ids: ["net_POWER"] },
  { type: "source_trace", connected_source_port_ids: ["V1_source_port_2"], connected_source_net_ids: ["net_GND"] },
];
const nir = {
  schema_version: "1.1",
  components: [{ ref: "V1", component_type: "simulation_source", footprint: "", value: "VPULSE" }],
  netlist: [{ net_name: "POWER", net_type: "power", connections: [{ ref: "U1", pin_name: "VDD", pin_number: "8" }] }],
};

console.log("=== no params, explicit timeStep/duration (tran) ===");
let r = netlistFromCircuitJson(circuitJson, nir, { analysisType: "tran", timeStep: "100u", duration: "20m" });
console.log(r.netlist.split("\n").filter(l => l.startsWith("V1")).join("\n"));
console.log("WARN:", r.warnings);

console.log("\n=== no params, no opts at all (tran defaults 1m/10m) ===");
r = netlistFromCircuitJson(circuitJson, nir);
console.log(r.netlist.split("\n").filter(l => l.startsWith("V1")).join("\n"));
console.log("WARN:", r.warnings);

console.log("\n=== no params, fft (defaults 10u/10m) ===");
r = netlistFromCircuitJson(circuitJson, nir, { analysisType: "fft" });
console.log(r.netlist.split("\n").filter(l => l.startsWith("V1")).join("\n"));
console.log("WARN:", r.warnings);
