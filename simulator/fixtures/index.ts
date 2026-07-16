// Open_Forge — Simulator fixture loader (Layer 4).
//
// Typed loaders for simulator test fixtures.

export const rcCircuitNetlist = `* RC low-pass filter — golden fixture for simulator regression tests
* 1k resistor, 1uF capacitor, 1V step input, 5ms transient
V1 in 0 PULSE(0 1 0 1n 1n 1m 2m)
R1 in out 1k
C1 out 0 1u
.tran 10u 5m
.control
run
set filetype=ascii
write output.raw
.endc
.END
`

export const rcCircuitExpected = {
  vectors: {
    time: [0, 1e-11, 2e-11, 4e-11, 0.005],
    "v(in)": [0, 0.01, 0.02, 0.04, 0],
    "v(out)": [0, 9.999999900000004e-11, 2.999999960000001e-10, 8.999999840000004e-10, 0.7292481804585587],
    "i(v1)": [0, -9.999999900000003e-6, -1.999999970000001e-5, -3.999999910000002e-5, -0.0002707518195414414],
  },
  variables: [
    { index: 0, name: "time", type: "time" },
    { index: 1, name: "v(in)", type: "voltage" },
    { index: 2, name: "v(out)", type: "voltage" },
    { index: 3, name: "i(v1)", type: "current" },
  ],
  numPoints: 610,
  plotname: "Transient Analysis",
}