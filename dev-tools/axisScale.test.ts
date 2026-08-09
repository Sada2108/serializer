import { test, describe, expect } from "bun:test"
import { isTimeDomainX, toDisplayX } from "./axisScale.ts"

describe("axisScale — isTimeDomainX (s -> ms conversion trigger)", () => {
  test("TRAN is time-domain (axis is seconds -> ms)", () => {
    expect(isTimeDomainX("tran")).toBe(true)
  })

  test("OP/AC/DC/FFT are NOT time-domain (OP=single point; AC=Hz; DC=V; FFT=harmonic Hz)", () => {
    expect(isTimeDomainX("op")).toBe(false)
    expect(isTimeDomainX("ac")).toBe(false)
    expect(isTimeDomainX("dc")).toBe(false)
    expect(isTimeDomainX("fft")).toBe(false)
  })

  test("unknown analysis types are treated as non-scaled", () => {
    expect(isTimeDomainX("noise")).toBe(false)
    expect(isTimeDomainX("")).toBe(false)
  })
})

describe("axisScale — toDisplayX (ngspice x-vector -> display units)", () => {
  test("TRAN seconds are scaled x1000 to milliseconds", () => {
    // 0.01 s -> 10 ms, 0.005 s -> 5 ms
    expect(toDisplayX("tran", [0, 0.005, 0.01])).toEqual([0, 5, 10])
  })

  test("OP (single point, no time sweep) passes through unscaled", () => {
    expect(toDisplayX("op", [0])).toEqual([0])
  })

  test("FFT harmonic frequency (Hz) is NOT scaled", () => {
    // FFT x-axis is harmonic frequency (Hz), not time. Scaling it x1000 (an
    // earlier bug's class) would mislabel kHz harmonics as MHz.
    expect(toDisplayX("fft", [1000, 2000, 3000, 9000])).toEqual([1000, 2000, 3000, 9000])
  })

  test("AC frequency (Hz) is NOT scaled - regression for AC x1000 bug", () => {
    // ngspice AC sweep: 1 Hz, 10 Hz, 100 Hz, 1 kHz, 10 kHz, 100 kHz, 1 MHz.
    // The pre-fix bug multiplied these by 1000 (showing "mHz" labeled as Hz).
    const freqSweep = [1, 10, 100, 1000, 10000, 100000, 1000000]
    expect(toDisplayX("ac", freqSweep)).toEqual(freqSweep)
  })

  test("DC sweep (V) is NOT scaled", () => {
    expect(toDisplayX("dc", [0, 2.5, 5])).toEqual([0, 2.5, 5])
  })

  test("returned array is a copy, not a reference (AC passthrough)", () => {
    const src = [1, 10, 100]
    const out = toDisplayX("ac", src)
    expect(out).toEqual(src)
    out.push(1000)
    expect(src).toEqual([1, 10, 100])
  })
})
