import { board, resistor } from "tscircuit"

export default () => (
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="1k" />
    <resistor name="R2" resistance="1k" />
    <trace from="R1.pin1" to="net.SIG" />
    <trace from="R2.pin1" to="net.SIG" />
  </board>
)
