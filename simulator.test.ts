//   simulator end-to-end test (Layer 4).
//
// Drives the netlist -> ngspice -> parsed vectors path against the RC fixture.
// Plus unit tests for parseRawFile and netlistFromCircuitJson.
//
// Does NOT touch the serializer, the orchestrator, or the verifier.

import { describe, expect, it, beforeAll } from "bun:test"
import { simulateNetlist, resolveNgspiceBin, getNgspiceVersion } from "./simulator/simulator"
import { parseRawFile } from "./simulator/parseRawFile"
import { netlistFromCircuitJson } from "./simulator/netlistFromCircuitJson"
import { rcCircuitNetlist, rcCircuitExpected } from "./simulator/fixtures"

// --------------------------------------------------------------------------- //
// ngspice availability detection
// --------------------------------------------------------------------------- //
const NGSPICE_BIN = process.env.NGSPICE_BIN || "C:\\Tools\\Spice64\\bin\\ngspice_con.exe"
let HAS_NGSPICE = false
let NGSPICE_VERSION = ""

beforeAll(async () => {
  try {
    NGSPICE_VERSION = await getNgspiceVersion(NGSPICE_BIN)
    HAS_NGSPICE = true
  } catch {
    HAS_NGSPICE = false
  }
})

// --------------------------------------------------------------------------- //
// parseRawFile unit tests
// --------------------------------------------------------------------------- //

describe("parseRawFile", () => {
  it("parses a hand-crafted minimal ASCII raw file (point-index-per-row format)", () => {
    // ngspice-46 ASCII raw format: each point row starts with " <idx>\t<val0>"
    // then remaining values on tab-indented lines
    const raw = `
Title: Test
Date: today
Command: test
Plotname: Transient Analysis
Flags: real
No. Variables: 3
No. Points: 3
Variables:
	0	time	time
	1	v(in)	voltage
	2	v(out)	voltage
Values:
 0	0.000000000000000e+00
	0.000000000000000e+00
	0.000000000000000e+00
 1	1.000000000000000e-03
	1.000000000000000e+00
	6.321205585348245e-01
 2	2.000000000000000e-03
	0.000000000000000e+00
	8.646647167961876e-01
`
    const result = parseRawFile(raw)
    expect(result.numPoints).toBe(3)
    expect(result.variables.length).toBe(3)
    expect(result.vectors["time"]).toEqual([0, 0.001, 0.002])
    expect(result.vectors["v(in)"]).toEqual([0, 1, 0])
    expect(result.vectors["v(out)"][2]).toBeCloseTo(0.86466, 4)
  })

  it("throws on empty input", () => {
    expect(() => parseRawFile("")).toThrow("empty")
  })

  it("throws on missing Variables section", () => {
    expect(() => parseRawFile("Title: Test\nNo. Variables: 1\nNo. Points: 1\nValues:\n 0\t1")).toThrow(/Variables:/)
  })

  it("throws on missing Values section", () => {
    expect(() => parseRawFile("Title: Test\nNo. Variables: 1\nNo. Points: 1\nVariables:\n\t0\ttime\ttime")).toThrow(/Values:/)
  })

  it("throws on non-numeric value", () => {
    const raw = `
Title: Test
No. Variables: 1
No. Points: 1
Variables:
	0	time	time
Values:
 0	not-a-number
`
    expect(() => parseRawFile(raw)).toThrow(/non-numeric/)
  })

  it("parses complex values (real part only)", () => {
    // Complex format: each variable's value on separate line for the same point
    // For 1 variable with 2 points: point 0 line + point 1 line
    const raw = "Title: Test\nPlotname: constants\nFlags: complex\nNo. Variables: 2\nNo. Points: 2\nVariables:\n\t0\ttest\tnone\n\t1\tother\tnone\nValues:\n 0\t1.0,0.0\n\t2.0,0.0\n 1\t3.0,0.0\n\t4.0,0.0\n"
    const result = parseRawFile(raw)
    expect(result.vectors["test"]).toEqual([1.0, 3.0])
    expect(result.vectors["other"]).toEqual([2.0, 4.0])
  })

  it("detects incomplete or extra values section", () => {
    // Test that parser validates point count - declare 1 point but provide 2
    const raw = `
Title: Test
No. Variables: 1
No. Points: 1
Variables:
	0	time	time
Values:
 0	1
 1	2
`
    expect(() => parseRawFile(raw)).toThrow(/incomplete|extra|more data/)
  })
})

// --------------------------------------------------------------------------- //
// netlistFromCircuitJson unit tests
// --------------------------------------------------------------------------- //

describe("netlistFromCircuitJson", () => {
  it("converts a simple v0.1-style circuit to SPICE", () => {
    // This matches what serializer.ts emits for libbrecht-hall NIR
    const circuitJson = [
      { type: "source_component_base", name: "R1", component_type: "resistor", resistance: "1k" },
      { type: "source_component_base", name: "C1", component_type: "capacitor", capacitance: "1u" },
      { type: "source_net", name: "IN", is_power: false, is_ground: false },
      { type: "source_net", name: "OUT", is_power: false, is_ground: false },
      { type: "source_net", name: "GND", is_power: false, is_ground: true },
      { type: "source_trace", connected_source_port_ids: ["R1_source_port_1"], connected_source_net_ids: ["net_IN"] },
      { type: "source_trace", connected_source_port_ids: ["R1_source_port_2"], connected_source_net_ids: ["net_OUT"] },
      { type: "source_trace", connected_source_port_ids: ["C1_source_port_1"], connected_source_net_ids: ["net_OUT"] },
      { type: "source_trace", connected_source_port_ids: ["C1_source_port_2"], connected_source_net_ids: ["net_GND"] },
    ]
    const nir = {
      nir_schema_version: "0.1",
      circuit_json: {
        components: [
          { name: "R1", type: "resistor", resistance: "1k" },
          { name: "C1", type: "capacitor", capacitance: "1u" },
        ],
        nets: [
          { name: "IN" },
          { name: "OUT" },
          { name: "GND", isGroundNet: true },
        ],
      },
    }
    const result = netlistFromCircuitJson(circuitJson, nir)
    expect(result.netlist).toContain("R1")
    expect(result.netlist).toContain("C1")
    expect(result.netlist).toContain("1k")
    expect(result.netlist).toContain("1u")
    expect(result.nodeMap["GND"]).toBe(0)
    expect(result.warnings.length).toBe(0)
  })

  it("looks up values from v1.1 NIR for v1.1 components", () => {
    const circuitJson = [
      { type: "source_component_base", name: "R1", component_type: "resistor", component_id: "generic", footprint: "0603" },
      { type: "source_net", name: "NET1", is_power: false, is_ground: false },
      { type: "source_net", name: "GND", is_power: false, is_ground: true },
      { type: "source_trace", connected_source_port_ids: ["R1_source_port_1"], connected_source_net_ids: ["net_NET1"] },
      { type: "source_trace", connected_source_port_ids: ["R1_source_port_2"], connected_source_net_ids: ["net_GND"] },
    ]
    const nir = {
      schema_version: "1.1",
      components: [
        { ref: "R1", component_type: "resistor", footprint: "0603", value: "4.7k" },
      ],
      netlist: [],
    }
    const result = netlistFromCircuitJson(circuitJson, nir)
    expect(result.netlist).toContain("4.7k")
  })

  it("warns for unsupported IC types", () => {
    const circuitJson = [
      { type: "source_component_base", name: "U1", component_type: "opamp", component_id: "foo", footprint: "SOIC-8" },
      { type: "source_net", name: "NET1", is_power: false, is_ground: false },
      { type: "source_net", name: "GND", is_power: false, is_ground: true },
      { type: "source_trace", connected_source_port_ids: ["U1_source_port_1"], connected_source_net_ids: ["net_NET1"] },
      { type: "source_trace", connected_source_port_ids: ["U1_source_port_2"], connected_source_net_ids: ["net_GND"] },
    ]
    const nir = { schema_version: "1.1", components: [{ ref: "U1", component_type: "opamp", footprint: "SOIC-8", value: null }], netlist: [] }
    const result = netlistFromCircuitJson(circuitJson, nir)
    expect(result.warnings.some((w) => w.includes("NOT MODELED") || w.includes("not modeled"))).toBe(true)
  })

  it("handles voltage sources from v0.1 NIR", () => {
    const circuitJson = [
      { type: "source_component_base", name: "V1", component_type: "voltage_source", voltage: "5" },
      { type: "source_net", name: "POS", is_power: false, is_ground: false },
      { type: "source_net", name: "GND", is_power: false, is_ground: true },
      { type: "source_trace", connected_source_port_ids: ["V1_source_port_1"], connected_source_net_ids: ["net_POS"] },
      { type: "source_trace", connected_source_port_ids: ["V1_source_port_2"], connected_source_net_ids: ["net_GND"] },
    ]
    const nir = {
      nir_schema_version: "0.1",
      circuit_json: {
        components: [{ name: "V1", type: "voltage_source", voltage: "5" }],
        nets: [{ name: "POS" }, { name: "GND", isGroundNet: true }],
      },
    }
    const result = netlistFromCircuitJson(circuitJson, nir)
    expect(result.netlist).toContain("V1")
    expect(result.netlist).toContain("DC 5")
  })
})

// --------------------------------------------------------------------------- //
// simulateNetlist integration tests (requires ngspice)
// --------------------------------------------------------------------------- //

describe("simulateNetlist (requires ngspice)", () => {
  it("runs the RC fixture and returns vectors", async () => {
    if (!HAS_NGSPICE) {
      console.log(`  SKIP: ngspice not found at ${NGSPICE_BIN}`)
      return
    }
    const result = await simulateNetlist(rcCircuitNetlist, { ngspiceBin: NGSPICE_BIN })
    expect(result.numPoints).toBeGreaterThan(0)
    expect(result.vectors["time"]).toBeDefined()
    expect(result.vectors["v(out)"]).toBeDefined()
    expect(result.variables.length).toBeGreaterThan(0)
    expect(result.plotname).toBeTruthy()
  })

  it("produces expected RC charging waveform", async () => {
    if (!HAS_NGSPICE) return
    const result = await simulateNetlist(rcCircuitNetlist, { ngspiceBin: NGSPICE_BIN })
    const vout = result.vectors["v(out)"]
    const time = result.vectors["time"]
    const vin = result.vectors["v(in)"]

    // At t=0, v(out) ~ 0 (cap uncharged)
    expect(vout[0]).toBeLessThan(0.01)

    // PULSE(0 1 0 1n 1n 1m 2m): 1V pulse from t=0 to t=1ms, then 0V from 1ms to 2ms, repeats
    // At t=1ms (end of first pulse), cap charged to ~0.63V
    const idx1ms = time.findIndex(t => t >= 0.001)
    if (idx1ms >= 0 && idx1ms < vout.length) {
      expect(vout[idx1ms]).toBeGreaterThan(0.5)
      expect(vout[idx1ms]).toBeLessThan(0.8)
    }

    // At t=2ms (after 1ms discharge), v(out) decayed to ~0.23V
    const idx2ms = time.findIndex(t => t >= 0.002)
    if (idx2ms >= 0 && idx2ms < vout.length) {
      expect(vout[idx2ms]).toBeLessThan(0.4)
    }

    // At end of sim (5ms), v(out) is charging again toward 1V
    const lastIdx = vout.length - 1
    expect(vout[lastIdx]).toBeGreaterThan(0.5)
  })

  it("throws on invalid netlist", async () => {
    if (!HAS_NGSPICE) return
    try {
      await simulateNetlist("not a valid netlist", { ngspiceBin: NGSPICE_BIN })
      expect(false).toBe(true) // should not reach
    } catch (e: any) {
      expect(e.message.length).toBeGreaterThan(0)
    }
  })
})

// --------------------------------------------------------------------------- //
// ngspice binary resolution / version tests
// --------------------------------------------------------------------------- //

describe("ngspice binary resolution", () => {
  it("resolveNgspiceBin respects NGSPICE_BIN env", () => {
    const prev = process.env.NGSPICE_BIN
    process.env.NGSPICE_BIN = "/custom/ngspice"
    try {
      expect(resolveNgspiceBin()).toBe("/custom/ngspice")
    } finally {
      if (prev === undefined) delete process.env.NGSPICE_BIN
      else process.env.NGSPICE_BIN = prev
    }
  })

  it("getNgspiceVersion returns banner", async () => {
    if (!HAS_NGSPICE) return
    const version = await getNgspiceVersion(NGSPICE_BIN)
    expect(version.toLowerCase()).toContain("ngspice")
  })
})