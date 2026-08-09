//   scaleMode.js unit tests (dev-tools interactive simulator viewer).
//
// Covers the scale-mode lookup table, per-analysis defaults, and the
// non-positive-value gating that restricts which log scale options are usable.
// The apply function is tested against a minimal fake uPlot instance (no
// browser / canvas required).

import { describe, expect, it } from "bun:test"
import scaleMode from "./scaleMode.js"

describe("SCALE_MODES lookup", () => {
  it("defines all four modes with linear (1) / log (3) distr", () => {
    expect(scaleMode.SCALE_MODES.linear).toEqual({ xDistr: 1, yDistr: 1 })
    expect(scaleMode.SCALE_MODES.logY).toEqual({ xDistr: 1, yDistr: 3 })
    expect(scaleMode.SCALE_MODES.logX).toEqual({ xDistr: 3, yDistr: 1 })
    expect(scaleMode.SCALE_MODES.loglog).toEqual({ xDistr: 3, yDistr: 3 })
  })

  it("scaleConfigFor returns the config for a known mode", () => {
    expect(scaleMode.scaleConfigFor("logY")).toEqual({ xDistr: 1, yDistr: 3 })
    expect(scaleMode.scaleConfigFor("logX")).toEqual({ xDistr: 3, yDistr: 1 })
  })

  it("scaleConfigFor falls back to linear for unknown modes", () => {
    expect(scaleMode.scaleConfigFor("bogus")).toEqual({ xDistr: 1, yDistr: 1 })
    expect(scaleMode.scaleConfigFor(undefined)).toEqual({ xDistr: 1, yDistr: 1 })
  })
})

describe("defaultScaleFor", () => {
  it("defaults AC to logX (Bode) and everything else to linear", () => {
    expect(scaleMode.defaultScaleFor("ac")).toBe("logX")
    for (const t of ["tran", "op", "dc", "fft"]) {
      expect(scaleMode.defaultScaleFor(t)).toBe("linear")
    }
  })
})

describe("hasNonPositive", () => {
  it("returns false for all-positive data", () => {
    expect(scaleMode.hasNonPositive([1, 2, 3])).toBe(false)
    expect(scaleMode.hasNonPositive([])).toBe(false)
  })

  it("returns true for zero, negative, and NaN values", () => {
    expect(scaleMode.hasNonPositive([1, 0, 2])).toBe(true) // t = 0 edge case
    expect(scaleMode.hasNonPositive([1, -1, 2])).toBe(true)
    expect(scaleMode.hasNonPositive([NaN, 2])).toBe(true)
  })
})

describe("smallestPositive", () => {
  it("returns the smallest strictly-positive value", () => {
    expect(scaleMode.smallestPositive([0, 0.001, 0.01, 0.1])).toBe(0.001)
    expect(scaleMode.smallestPositive([5, 1, 3])).toBe(1)
  })

  it("ignores zero, negative, and NaN values", () => {
    expect(scaleMode.smallestPositive([0, -2, NaN, 7])).toBe(7)
  })

  it("returns null when no positive value exists", () => {
    expect(scaleMode.smallestPositive([0, 0, -1])).toBeNull()
    expect(scaleMode.smallestPositive([])).toBeNull()
  })
})

describe("restrictedScaleOptions gating", () => {
  const allPosX = [0.001, 0.01, 0.1, 1]
  const allPosY = [1, 2, 3, 4]

  it("enables all options and no message when data is strictly positive", () => {
    const r = scaleMode.restrictedScaleOptions("tran", allPosX, allPosY)
    expect(r.message).toBeNull()
    expect(r.options.map((o) => o.disabled)).toEqual([false, false, false, false])
  })

  it("disables Log Y / Log-Log when Y crosses zero", () => {
    const r = scaleMode.restrictedScaleOptions("tran", allPosX, [1, 0, -1, 2])
    expect(r.options).toEqual([
      { value: "linear", label: "Linear", disabled: false },
      { value: "logY", label: "Log Y", disabled: true },
      { value: "logX", label: "Log X", disabled: false },
      { value: "loglog", label: "Log-Log", disabled: true },
    ])
    expect(r.message).toContain("crosses zero")
  })

  it("TRAN with a t=0 origin keeps Log X / Log-Log enabled via the epsilon floor", () => {
    const r = scaleMode.restrictedScaleOptions("tran", [0, 0.001, 0.01, 0.1], allPosY)
    expect(r.options).toEqual([
      { value: "linear", label: "Linear", disabled: false },
      { value: "logY", label: "Log Y", disabled: false },
      { value: "logX", label: "Log X", disabled: false },
      { value: "loglog", label: "Log-Log", disabled: false },
    ])
    expect(r.message).toContain("floored")
  })

  it("disables Log X / Log-Log when there is NO positive x at all", () => {
    const r = scaleMode.restrictedScaleOptions("tran", [0, 0, -1], allPosY)
    expect(r.options[2].disabled).toBe(true)
    expect(r.options[3].disabled).toBe(true)
    expect(r.options[0].disabled).toBe(false)
    expect(r.message).toContain("no positive x")
  })

  it("AC keeps only Linear / Log X (no double-log of dB), Log X allowed when X positive", () => {
    const r = scaleMode.restrictedScaleOptions("ac", allPosX, [30, 20, 10, 0])
    expect(r.options).toEqual([
      { value: "linear", label: "Linear", disabled: false },
      { value: "logY", label: "Log Y", disabled: true },
      { value: "logX", label: "Log X", disabled: false },
      { value: "loglog", label: "Log-Log", disabled: true },
    ])
    expect(r.message).toContain("already in dB")
  })

  it("AC with non-positive X additionally disables Log X", () => {
    const r = scaleMode.restrictedScaleOptions("ac", [0, 10, 100], allPosY)
    expect(r.options[2].disabled).toBe(true)
    expect(r.options[0].disabled).toBe(false)
  })
})

describe("applyScaleMode", () => {
  function fakeUPlot() {
    return {
      scales: { x: {}, y: {} },
      data: [[1, 2], [1, 2]],
      setDataCalls: 0,
      setData(data) {
        this.data = data
        this.setDataCalls++
      },
    }
  }

  it("sets the live scale distr and re-auto-ranges via setData", () => {
    const u = fakeUPlot()
    scaleMode.applyScaleMode(u, "loglog")
    expect(u.scales.x.distr).toBe(3)
    expect(u.scales.y.distr).toBe(3)
    expect(u.setDataCalls).toBe(1)
    expect(u.data).toEqual([[1, 2], [1, 2]])
  })

  it("restores linear distr when switching back", () => {
    const u = fakeUPlot()
    scaleMode.applyScaleMode(u, "logY")
    scaleMode.applyScaleMode(u, "linear")
    expect(u.scales.x.distr).toBe(1)
    expect(u.scales.y.distr).toBe(1)
  })

  it("floors the log-x range to the smallest positive x for a t=0 origin", () => {
    const u = fakeUPlot()
    scaleMode.applyScaleMode(u, "logX", [0, 0.001, 0.01, 0.1])
    expect(u.scales.x.distr).toBe(3)
    expect(u.scales.x.min).toBe(0.001)
    expect(u.scales.y.distr).toBe(1)
  })

  it("does not floor the log-x range when x is fully positive", () => {
    const u = fakeUPlot()
    scaleMode.applyScaleMode(u, "logX", [1, 2, 3])
    expect(u.scales.x.distr).toBe(3)
    expect(u.scales.x.min).toBeUndefined()
  })

  it("clears a prior floor when leaving log-x or when no positive x exists", () => {
    const u = fakeUPlot()
    scaleMode.applyScaleMode(u, "logX", [0, 0.001, 0.01])
    expect(u.scales.x.min).toBe(0.001)
    scaleMode.applyScaleMode(u, "linear", [0, 0.001, 0.01])
    expect(u.scales.x.min).toBeUndefined()
    scaleMode.applyScaleMode(u, "logX", [0, 0, -1])
    expect(u.scales.x.min).toBeUndefined()
  })

  it("is safe on a null instance", () => {
    expect(() => scaleMode.applyScaleMode(null, "logX")).not.toThrow()
  })
})
