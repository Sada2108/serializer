import { simulateNetlist } from "./simulator/simulator"
import { printSimulationResult } from "./simulator/printSimulationResult"

const netlist = `RC Charging Curve
V1 in 0 PULSE(0 5 0 1n 1n 5m 10m)
R1 in out 1k
C1 out 0 1u
.tran 0.05m 5m
.end`

simulateNetlist(netlist)
  .then(printSimulationResult)
  .catch((err) => console.error("ERROR:", err.message))
