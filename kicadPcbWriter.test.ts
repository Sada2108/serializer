import { circuitJsonToKicadPcb } from "./serializer/kicadPcbWriter"
import { serializeNirAsync } from "./serializer/serializer"
import { opampNoninvNir } from "./serializer/fixtures"
import type { AnyCircuitElement } from "circuit-json"

describe("circuitJsonToKicadPcb", () => {
  let circuitJson: AnyCircuitElement[]
  let kicadPcb: string

  beforeAll(async () => {
    const out = await serializeNirAsync(opampNoninvNir)
    circuitJson = out.circuitJson
    kicadPcb = circuitJsonToKicadPcb(circuitJson)
  })

  it("produces a non-empty string starting with (kicad_pcb", () => {
    expect(typeof kicadPcb).toBe("string")
    expect(kicadPcb.length).toBeGreaterThan(100)
    expect(kicadPcb.startsWith("(kicad_pcb")).toBe(true)
  })

  it("has a (generator ...) field with the project name from package.json", () => {
    expect(kicadPcb).toContain("(generator ")
    expect(kicadPcb).toContain("my-project")
  })

  it("has (version ...) field", () => {
    expect(kicadPcb).toContain("(version ")
  })

  it("has a (general ...) section", () => {
    expect(kicadPcb).toContain("(general")
    expect(kicadPcb).toContain("(thickness")
  })

  it("has a (layers ...) section with top and bottom copper", () => {
    expect(kicadPcb).toContain("(layers")
    expect(kicadPcb).toContain("F.Cu")
    expect(kicadPcb).toContain("B.Cu")
  })

  it("has a (setup ...) section", () => {
    expect(kicadPcb).toContain("(setup")
    expect(kicadPcb).toContain("(pad_to_mask_clearance")
  })

  it("has (net ...) declarations for each source_net", () => {
    const sourceNets = circuitJson.filter((e: any) => e.type === "source_net")
    expect(sourceNets.length).toBeGreaterThan(0)

    for (const net of sourceNets) {
      const netName = net.name ?? net.source_net_id
      expect(kicadPcb).toContain(`"${netName}"`)
    }
  })

  it("emits one (footprint ...) block per pcb_component", () => {
    const pcbComponents = circuitJson.filter((e: any) => e.type === "pcb_component")
    expect(pcbComponents.length).toBeGreaterThan(0)

    const footprintMatches = kicadPcb.match(/\(footprint "/g) || []
    expect(footprintMatches.length).toBeGreaterThanOrEqual(pcbComponents.length)

    for (const comp of pcbComponents) {
      const sc = circuitJson.find(
        (e: any) => e.type === "source_component" && e.source_component_id === comp.source_component_id
      ) as any
      const refDes = sc?.name ?? ""
      if (refDes) {
        expect(kicadPcb).toContain(`(property "Reference" "${refDes}"`)
      }
    }
  })

  it("footprint blocks have (at X Y R) from pcb_component center and rotation", () => {
    const pcbComponents = circuitJson.filter((e: any) => e.type === "pcb_component") as any[]
    for (const comp of pcbComponents.slice(0, 3)) {
      const x = comp.center.x.toFixed(4)
      const y = comp.center.y.toFixed(4)
      expect(kicadPcb).toContain(`(at ${x} ${y}`)
    }
  })

  it("footprint blocks reference F.Cu or B.Cu layer", () => {
    expect(kicadPcb).toContain('(layer "F.Cu")')
  })

  it("emits (segment ...) entries for wire pcb_trace routes", () => {
    const pcbTraces = circuitJson.filter((e: any) => e.type === "pcb_trace") as any[]
    const hasWires = pcbTraces.some((t) => t.route?.some((s: any) => s.route_type === "wire"))
    if (hasWires) {
      expect(kicadPcb).toContain("(segment")
      expect(kicadPcb).toContain("(start ")
      expect(kicadPcb).toContain("(end ")
    }
  })

  it("emits (via ...) entries for via pcb_trace routes", () => {
    const pcbTraces = circuitJson.filter((e: any) => e.type === "pcb_trace") as any[]
    const hasVias = pcbTraces.some((t) => t.route?.some((s: any) => s.route_type === "via"))
    if (hasVias) {
      expect(kicadPcb).toContain("(via")
      expect(kicadPcb).toContain("(at ")
      expect(kicadPcb).toContain("(layers ")
    }
  })

  it("segments and vias reference valid net names", () => {
    const viaMatches = kicadPcb.matchAll(/\(via[\s\S]*?\(net "([^"]+)"\)/g) || []
    for (const m of viaMatches) {
      const netName = m[1]
      expect(netName.length).toBeGreaterThan(0)
    }
  })

  it("uses footprint paths from FOOTPRINT_MAP for recognized footprints", () => {
    expect(kicadPcb).toContain("Package_SO/SOIC-8_3.9x4.9mm_P1.27mm")
    expect(kicadPcb).toContain("Resistor_SMD/R_0603_1608Metric")
  })

  it("closes with a single matching closing paren", () => {
    expect(kicadPcb.trimEnd().endsWith(")")).toBe(true)
    const openCount = (kicadPcb.match(/\(/g) || []).length
    const closeCount = (kicadPcb.match(/\)/g) || []).length
    expect(openCount).toBe(closeCount)
  })
})

describe("pad rotation regression: net-to-net short detection", () => {
  let kicadPcb: string

  beforeAll(async () => {
    const out = await serializeNirAsync(opampNoninvNir)
    kicadPcb = circuitJsonToKicadPcb(out.circuitJson)
  })

  it("parses pad positions from KiCad output and checks no different-net pads overlap", () => {
    const lines = kicadPcb.split("\n")
    const pads: Array<{ num: string; x: number; y: number; w: number; h: number; net: string }> = []
    let curFpX = 0, curFpY = 0, curFpRot = 0
    let inFp = false

    for (const line of lines) {
      if (line.match(/^\s{2}\(footprint /)) {
        inFp = true
        curFpX = 0; curFpY = 0; curFpRot = 0
      }
      if (inFp) {
        const fpAt = line.match(/^\s{4}\(at ([\d.\-]+) ([\d.\-]+)(?: ([\d.\-]+))?\)/)
        if (fpAt) {
          curFpX = parseFloat(fpAt[1])
          curFpY = parseFloat(fpAt[2])
          curFpRot = fpAt[3] ? parseFloat(fpAt[3]) * Math.PI / 180 : 0
        }
      }

      const padM = line.match(/\(pad (\d+) smd roundrect \(at ([\d.\-]+) ([\d.\-]+)\) \(size ([\d.\-]+) ([\d.\-]+)\)[\s\S]*?\(net "([^"]*)"\)/)
      if (padM) {
        const relX = parseFloat(padM[2]), relY = parseFloat(padM[3])
        const cosR = Math.cos(curFpRot), sinR = Math.sin(curFpRot)
        pads.push({
          num: padM[1],
          x: curFpX + cosR * relX - sinR * relY,
          y: curFpY + sinR * relX + cosR * relY,
          w: parseFloat(padM[4]),
          h: parseFloat(padM[5]),
          net: padM[6],
        })
      }
    }

    expect(pads.length).toBeGreaterThan(0)

    const MIN_CLEARANCE = 0.01
    for (let i = 0; i < pads.length; i++) {
      for (let j = i + 1; j < pads.length; j++) {
        const a = pads[i]
        const b = pads[j]
        if (a.net === b.net || a.net === "" || b.net === "") continue

        const overlapX = (a.w / 2 + b.w / 2 + MIN_CLEARANCE) - Math.abs(a.x - b.x)
        const overlapY = (a.h / 2 + b.h / 2 + MIN_CLEARANCE) - Math.abs(a.y - b.y)

        if (overlapX > 0 && overlapY > 0) {
          expect(
            false,
            `Net-to-net short: pad ${a.num} [${a.net}] at (${a.x.toFixed(4)}, ${a.y.toFixed(4)}) overlaps pad ${b.num} [${b.net}] at (${b.x.toFixed(4)}, ${b.y.toFixed(4)}). ` +
            `This means the rotation transform is wrong — pads are at incorrect absolute positions.`,
          ).toBe(true)
        }
      }
    }
  })

  it("rotated components have pads at correct absolute positions (rotation transform check)", async () => {
    const out = await serializeNirAsync(opampNoninvNir)
    const ci = out.circuitJson
    const components = ci.filter((e: any) => e.type === "pcb_component") as any[]
    const smtpads = ci.filter((e: any) => e.type === "pcb_smtpad") as any[]
    const compMap = new Map(components.map((c: any) => [c.pcb_component_id, c]))

    const lines = kicadPcb.split("\n")
    const kicadPads: Array<{ x: number; y: number; w: number; h: number; net: string }> = []
    let curFpX = 0, curFpY = 0, curFpRot = 0
    let inFp = false

    for (const line of lines) {
      if (line.match(/^\s{2}\(footprint /)) {
        inFp = true
        curFpX = 0; curFpY = 0; curFpRot = 0
      }
      if (inFp) {
        const fpAt = line.match(/^\s{4}\(at ([\d.\-]+) ([\d.\-]+)(?: ([\d.\-]+))?\)/)
        if (fpAt) {
          curFpX = parseFloat(fpAt[1])
          curFpY = parseFloat(fpAt[2])
          curFpRot = fpAt[3] ? parseFloat(fpAt[3]) * Math.PI / 180 : 0
        }
      }
      const padM = line.match(/\(pad (\d+) smd roundrect \(at ([\d.\-]+) ([\d.\-]+)\) \(size ([\d.\-]+) ([\d.\-]+)\)[\s\S]*?\(net "([^"]*)"\)/)
      if (padM) {
        const relX = parseFloat(padM[2]), relY = parseFloat(padM[3])
        const cosR = Math.cos(curFpRot), sinR = Math.sin(curFpRot)
        kicadPads.push({
          x: curFpX + cosR * relX - sinR * relY,
          y: curFpY + sinR * relX + cosR * relY,
          w: parseFloat(padM[4]),
          h: parseFloat(padM[5]),
          net: padM[6],
        })
      }
    }

    for (const pad of smtpads) {
      const comp = compMap.get(pad.pcb_component_id)
      if (!comp) continue

      const matched = kicadPads.find((kp) =>
        Math.abs(kp.x - pad.x) < 0.01 &&
        Math.abs(kp.y - pad.y) < 0.01,
      )

      expect(matched).toBeDefined()
    }
  })
})
