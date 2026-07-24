import { simulateNetlist } from "./simulator/simulator"
import { printSimulationResult } from "./simulator/printSimulationResult"

const netlist = `RC Charging Test
V1 in 0 DC 5
R1 in out 1k
C1 out 0 1u
.tran 0.1m 5m
.end`

simulateNetlist(netlist)
  .then((result) => {
    printSimulationResult(result)
  })
  .catch((err) => {
    console.error("ERROR:", err.message)
  })
