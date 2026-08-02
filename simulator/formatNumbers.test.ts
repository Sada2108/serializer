import { describe, it, expect } from "bun:test"
import { formatEng, formatFixed, formatAuto, formatVector, formatSimulationResult, formatValue } from "./formatNumbers"

describe("formatNumbers", () => {
  describe("formatEng", () => {
    it("formats small values with micro prefix", () => {
      expect(formatEng(0.000001)).toBe("1µ")
      expect(formatEng(1e-6)).toBe("1µ")
      expect(formatEng(4.7e-6)).toBe("4.7µ")
    })

    it("formats milli values", () => {
      expect(formatEng(0.001)).toBe("1m")
      expect(formatEng(0.0047)).toBe("4.7m")
    })

    it("formats base values (no prefix)", () => {
      expect(formatEng(1)).toBe("1")
      expect(formatEng(47)).toBe("47")
      expect(formatEng(100)).toBe("100")
    })

    it("formats kilo values", () => {
      expect(formatEng(1000)).toBe("1k")
      expect(formatEng(4700)).toBe("4.7k")
      expect(formatEng(10000)).toBe("10k")
    })

    it("formats mega values", () => {
      expect(formatEng(1e6)).toBe("1M")
      expect(formatEng(4.7e6)).toBe("4.7M")
    })

    it("formats giga values", () => {
      expect(formatEng(1e9)).toBe("1G")
      expect(formatEng(4.7e9)).toBe("4.7G")
    })

    it("formats negative values", () => {
      expect(formatEng(-0.001)).toBe("-1m")
      expect(formatEng(-4700)).toBe("-4.7k")
    })

    it("handles zero", () => {
      expect(formatEng(0)).toBe("0")
    })

    it("handles unit suffix", () => {
      expect(formatEng(0.001, { unit: "V" })).toBe("1mV")
      expect(formatEng(4700, { unit: "Ω" })).toBe("4.7kΩ")
      expect(formatEng(1e-6, { unit: "A" })).toBe("1µA")
    })

    it("respects precision option", () => {
      expect(formatEng(4700, { precision: 2 })).toBe("4.7k")
      // trailing zeros after decimal are stripped by toPrecision
      expect(formatEng(4700, { precision: 5 })).toBe("4.7k")
    })
  })

  describe("formatFixed", () => {
    it("formats as fixed decimal", () => {
      expect(formatFixed(0.000001)).toBe("0.000001")
      expect(formatFixed(0.001)).toBe("0.001")
      expect(formatFixed(47)).toBe("47")
      expect(formatFixed(4700)).toBe("4700")
    })

    it("handles zero", () => {
      expect(formatFixed(0)).toBe("0")
    })

    it("handles unit suffix", () => {
      expect(formatFixed(1.5, { unit: "V" })).toBe("1.5V")
    })

    it("respects precision", () => {
      expect(formatFixed(1.23456789, { precision: 3 })).toBe("1.235")
      expect(formatFixed(1.23456789, { precision: 6 })).toBe("1.234568")
    })
  })

  describe("formatAuto", () => {
    it("uses fixed for values in [1, 1000)", () => {
      expect(formatAuto(1)).toBe("1")
      expect(formatAuto(47)).toBe("47")
      expect(formatAuto(999)).toBe("999")
    })

    it("uses eng for values < 1", () => {
      expect(formatAuto(0.5)).toBe("500m")
      expect(formatAuto(0.001)).toBe("1m")
      expect(formatAuto(1e-6)).toBe("1µ")
    })

    it("uses eng for values >= 1000", () => {
      expect(formatAuto(1000)).toBe("1k")
      expect(formatAuto(47000)).toBe("47k")
      expect(formatAuto(1e6)).toBe("1M")
    })
  })

  describe("formatVector", () => {
    it("formats array of values", () => {
      const result = formatVector([0, 0.001, 1e-6, 4700, 1e6])
      expect(result).toEqual(["0", "1m", "1µ", "4.7k", "1M"])
    })

    it("applies unit to all values", () => {
      const result = formatVector([0.001, 0.002], { unit: "V" })
      expect(result).toEqual(["1mV", "2mV"])
    })
  })

  describe("formatSimulationResult", () => {
    it("formats all vectors with unit inference", () => {
      const result = {
        vectors: {
          "time": [0, 0.001, 0.002],
          "v(out)": [0, 0.632, 0.865],
          "v(in)": [0, 1, 0],
          "i(R1)": [0, 0.000632, 0.000865]
        },
        variables: [
          { name: "time", type: "time" },
          { name: "v(out)", type: "voltage" },
          { name: "v(in)", type: "voltage" },
          { name: "i(R1)", type: "current" }
        ]
      }
      const formatted = formatSimulationResult(result)
      expect(formatted.vectors["time"]).toEqual(["0s", "1ms", "2ms"])
      expect(formatted.vectors["v(out)"]).toEqual(["0V", "632mV", "865mV"])
      expect(formatted.vectors["v(in)"]).toEqual(["0V", "1V", "0V"])
      expect(formatted.vectors["i(R1)"]).toEqual(["0A", "632µA", "865µA"])
    })

    it("handles missing variable metadata gracefully", () => {
      const result = {
        vectors: { "unknown": [0.001, 1000] },
        variables: []
      }
      const formatted = formatSimulationResult(result)
      expect(formatted.vectors["unknown"]).toEqual(["1m", "1k"])
    })
  })

  describe("formatValue", () => {
    it("infers unit from variable name", () => {
      expect(formatValue(0.001, "v(out)")).toBe("1mV")
      expect(formatValue(4700, "i(R1)")).toBe("4.7kA")
      expect(formatValue(0.001, "time")).toBe("1ms")
      expect(formatValue(1e6, "frequency")).toBe("1MHz")
    })

    it("uses explicit unit over inferred", () => {
      // Explicit unit without prefix takes precedence
      expect(formatValue(0.001, "v(out)", { unit: "V" })).toBe("1mV")
      // Unit with prefix is used as-is (m + mV = mmV)
      expect(formatValue(0.001, "v(out)", { unit: "mV" })).toBe("1mmV")
    })

    it("handles unknown variable names", () => {
      expect(formatValue(4700, "custom")).toBe("4.7k")
    })
  })

  describe("real-world opamp_noninv values", () => {
    it("formats 10k resistor value correctly", () => {
      expect(formatEng(10000)).toBe("10k")
      expect(formatAuto(10000)).toBe("10k")
    })

    it("formats 1uF capacitor value correctly", () => {
      expect(formatEng(1e-6)).toBe("1µ")
      expect(formatAuto(1e-6)).toBe("1µ")
    })

    it("formats 100k resistor value correctly", () => {
      expect(formatEng(100000)).toBe("100k")
      expect(formatAuto(100000)).toBe("100k")
    })

    it("formats 10uF capacitor value correctly", () => {
      expect(formatEng(10e-6)).toBe("10µ")
      expect(formatAuto(10e-6)).toBe("10µ")
    })

    it("formats 100nF capacitor value correctly", () => {
      expect(formatEng(100e-9)).toBe("100n")
      expect(formatAuto(100e-9)).toBe("100n")
    })
  })

  describe("epsilon clamping", () => {
    it("clamps values below default epsilon (1e-12) to 0", () => {
      expect(formatEng(-4.44e-18)).toBe("0")
      expect(formatAuto(1e-15)).toBe("0")
      expect(formatFixed(1e-13)).toBe("0")
    })

    it("preserves values above epsilon", () => {
      expect(formatEng(1e-11)).toBe("10p")
      expect(formatAuto(1e-11)).toBe("10p")
    })

    it("allows custom epsilon", () => {
      expect(formatEng(1e-15, { epsilon: 1e-9 })).toBe("0")
      expect(formatEng(1e-15, { epsilon: 1e-18 })).toBe("1f")
    })

    it("clamps solver noise examples from SPICE", () => {
      // Typical solver noise: -4.44e-18 A (should be 0)
      expect(formatValue(-4.440892098500626e-18, "i(v1)")).toBe("0A")
      // Time step noise: 4.000000000000001e-6 s (should be 4µs)
      expect(formatValue(4.000000000000001e-6, "time")).toBe("4µs")
      // Boundary: values strictly less than epsilon are clamped
      expect(formatEng(1e-12 - 1e-15, { epsilon: 1e-12 })).toBe("0")
      expect(formatEng(1e-12, { epsilon: 1e-12 })).toBe("1p")
    })
  })
})