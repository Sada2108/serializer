//   serializer end-to-end test (Layer 3).
//
// Drives the NIR -> Circuit JSON -> SVG export path against BOTH supported
// NIR schemas:
//   - Libbrecht-Hall fixture (legacy v0.1)  -> backward-compat regression
//   - instrumentation_amp_001 fixture (v1.1) -> new schema path
// Plus loud-failure tests for malformed NIR.
//
// Does NOT touch the tsci CLI, does NOT run any simulation, does NOT
// exercise orchestrator.py.

import { describe, expect, it } from "bun:test"
import {
  serializeNir,
  nirToCircuitJson,
  renderCircuitJson,
  detectNirSchemaVersion,
} from "./serializer/serializer"
import { libbrechtHallNir, instrumentationAmpNir } from "./serializer/fixtures"
import { setUseKicadSymbols } from "./serializer/kicadSymbolLibrary"

// --------------------------------------------------------------------------- //
// Schema detection
// --------------------------------------------------------------------------- //

describe("detectNirSchemaVersion", () => {
  it("recognizes the v0.1 Libbrecht-Hall fixture by nir_schema_version marker", () => {
    expect(detectNirSchemaVersion(libbrechtHallNir)).toBe("v0.1-libbrecht")
  })

  it("recognizes the v1.1 instrumentation_amp fixture by schema_version marker", () => {
    expect(detectNirSchemaVersion(instrumentationAmpNir)).toBe("v1.1-instrumentation")
  })

  it("throws on a completely unrecognized NIR", () => {
    expect(() => detectNirSchemaVersion({})).toThrow(/not recognized/)
  })

  it("throws on a non-object NIR", () => {
    expect(() => detectNirSchemaVersion(null)).toThrow(/root must be an object/)
    expect(() => detectNirSchemaVersion([])).toThrow(/root must be an object/)
  })

  it("falls back to structural fingerprint when explicit marker is missing (v0.1)", () => {
    const fingerprint = {
      circuit_json: { components: [{ name: "X", type: "resistor" }], nets: [] },
    }
    expect(detectNirSchemaVersion(fingerprint)).toBe("v0.1-libbrecht")
  })

  it("falls back to structural fingerprint when explicit marker is missing (v1.1)", () => {
    const fingerprint = {
      components: [],
      netlist: [],
      board_spec: { layers: 2, material: "FR4", thickness_mm: 1.6 },
    }
    expect(detectNirSchemaVersion(fingerprint)).toBe("v1.1-instrumentation")
  })
})

// --------------------------------------------------------------------------- //
// Legacy v0.1 path — backward compat (Libbrecht-Hall)
// --------------------------------------------------------------------------- //

describe("nirToCircuitJson", () => {
  it("produces a typed AnyCircuitElement[] from the Libbrecht-Hall NIR", () => {
    const cj = nirToCircuitJson(libbrechtHallNir)
    expect(Array.isArray(cj)).toBe(true)
    expect(cj.length).toBeGreaterThan(0)
    // Each element carries the Circuit-JSON `type` discriminator.
    for (const el of cj) {
      expect(typeof el).toBe("object")
      expect(el).not.toBeNull()
      expect(typeof (el as any).type).toBe("string")
    }
  })
})

describe("renderCircuitJson", () => {
  it("renders the Libbrecht-Hall circuit to a non-empty SVG string", () => {
    const cj = nirToCircuitJson(libbrechtHallNir)
    const { svg, viewerUsed } = renderCircuitJson(cj)
    expect(typeof svg).toBe("string")
    expect(svg.length).toBeGreaterThan(0)
    expect(viewerUsed === "circuit-to-svg" ||
           viewerUsed === "@tscircuit/schematic-viewer").toBe(true)
  })

  it("falls back (not crashes) when schematic-viewer is requested but absent", () => {
    const prev = process.env.KICAD_VIEWER
    process.env.KICAD_VIEWER = "schematic-viewer"
    try {
      const cj = nirToCircuitJson(libbrechtHallNir)
      const { viewerUsed } = renderCircuitJson(cj)
      // If the viewer is installed, we get that; otherwise circuit-to-svg.
      expect(viewerUsed === "circuit-to-svg" ||
             viewerUsed === "@tscircuit/schematic-viewer").toBe(true)
    } finally {
      if (prev === undefined) delete process.env.KICAD_VIEWER
      else process.env.KICAD_VIEWER = prev
    }
  })
})

describe("serializeNir (end-to-end)", () => {
  it("returns {circuitJson, svg, viewerUsed} for Libbrecht-Hall", () => {
    const out = serializeNir(libbrechtHallNir)
    expect(Array.isArray(out.circuitJson)).toBe(true)
    expect(out.circuitJson.length).toBeGreaterThan(0)
    expect(typeof out.svg).toBe("string")
    expect(out.svg.length).toBeGreaterThan(0)
    expect(out.viewerUsed).not.toBeNull()
  })
})

// --------------------------------------------------------------------------- //
// New v1.1 path — instrumentation_amp_001
// --------------------------------------------------------------------------- //

describe("serializeNir v1.1 (instrumentation_amp_001)", () => {
  it("parses to a NON-EMPTY AnyCircuitElement[] —_regression for the silent-empty bug", () => {
    const cj = nirToCircuitJson(instrumentationAmpNir)
    expect(Array.isArray(cj)).toBe(true)
    expect(cj.length).toBeGreaterThan(0)
  })

  it("emits exactly one pcb_board element derived from board_spec", () => {
    const cj = nirToCircuitJson(instrumentationAmpNir)
    const boards = cj.filter((el: any) => el.type === "pcb_board")
    expect(boards.length).toBe(1)
    const b = boards[0] as any
    expect(b.thickness).toBe(instrumentationAmpNir.board_spec.thickness_mm)
    expect(b.num_layers).toBe(instrumentationAmpNir.board_spec.layers)
    expect(b.material).toBe("fr4") // FR4 -> fr4 mapping
    expect(typeof b.width).toBe("number")
    expect(typeof b.height).toBe("number")
    expect(b.width).toBeGreaterThan(0)
    expect(b.height).toBeGreaterThan(0)
  })

  it("emits one pcb_component + one schematic_component + one source_component_base per NIR component", () => {
    const cj = nirToCircuitJson(instrumentationAmpNir)
    const pbcs = cj.filter((el: any) => el.type === "pcb_component")
    const schs = cj.filter((el: any) => el.type === "schematic_component")
    const srcs = cj.filter((el: any) => el.type === "source_component_base")
    const groundNets = (instrumentationAmpNir.netlist || []).filter(
      (n: any) => n.net_type === "ground"
    )
    const n = instrumentationAmpNir.components.length
    expect(n).toBe(15)
    expect(pbcs.length).toBe(n)
    // schematic_components = NIR components + ground nets (power nets are text labels only)
    expect(schs.length).toBe(n + groundNets.length)
    expect(srcs.length).toBe(n)
  })

  it("each pcb_component has a non-null numeric center (naive layout step ran for null NIR positions)", () => {
    const cj = nirToCircuitJson(instrumentationAmpNir)
    const pbcs = cj.filter((el: any) => el.type === "pcb_component") as any[]
    // The fixture has all-null positions, so naive layout MUST have assigned
    // every component a real numeric (x, y).
    for (const p of pbcs) {
      expect(typeof p.center?.x).toBe("number")
      expect(typeof p.center?.y).toBe("number")
      expect(Number.isFinite(p.center.x)).toBe(true)
      expect(Number.isFinite(p.center.y)).toBe(true)
    }
    // Distinct components should have at least two distinct centers (not all
    // stacked on the same point — naive grid spread).
    const distinct = new Set(pbcs.map((p) => `${p.center.x},${p.center.y}`))
    expect(distinct.size).toBeGreaterThan(1)
  })

  it("every emitted pcb_component has non-zero width/height (placeholder footprint table)", () => {
    const cj = nirToCircuitJson(instrumentationAmpNir)
    for (const el of cj) {
      if ((el as any).type === "pcb_component") {
        expect((el as any).width).toBeGreaterThan(0)
        expect((el as any).height).toBeGreaterThan(0)
      }
    }
  })

  it("emits source_net + source_trace elements for every netlist entry / connection", () => {
    const cj = nirToCircuitJson(instrumentationAmpNir)
    const nets = cj.filter((el: any) => el.type === "source_net") as any[]
    const traces = cj.filter((el: any) => el.type === "source_trace") as any[]
    expect(nets.length).toBe(instrumentationAmpNir.netlist.length)
    const expectedTraces = instrumentationAmpNir.netlist
      .reduce((acc, n) => acc + n.connections.length, 0)
    expect(traces.length).toBe(expectedTraces)
    // Power/GND flags propagate correctly.
    const vbat = nets.find((n) => n.name === "VBAT")
    expect(vbat.is_power).toBe(true)
    const gnd = nets.find((n) => n.name === "GND")
    expect(gnd.is_power).toBe(true)
  })

  it("renders end-to-end to an SVG via circuit-to-svg (no throw on raw v1.1 content)", () => {
    const out = serializeNir(instrumentationAmpNir)
    expect(out.circuitJson.length).toBeGreaterThan(0)
    expect(typeof out.svg).toBe("string")
    // The renderer may produce an empty-body svg for a board-only Circuit
    // JSON, but the wrapper must still be a valid SVG root.
    expect(out.svg.length).toBeGreaterThan(0)
    expect(out.viewerUsed).not.toBeNull()
  })
})

// --------------------------------------------------------------------------- //
// Loud-failure invariants
// --------------------------------------------------------------------------- //

describe("loud failure on malformed NIR", () => {
  it("raises when v1.1 root is missing `components`", () => {
    const malformed = {
      schema_version: "1.1",
      design_id: "x",
      netlist: [],
      board_spec: { layers: 2, material: "FR4", thickness_mm: 1.6 },
    }
    expect(() => nirToCircuitJson(malformed)).toThrow(/components/)
  })

  it("raises when a v1.1 component is missing `ref`", () => {
    const malformed = {
      schema_version: "1.1",
      design_id: "x",
      components: [
        { component_id: "Y", component_type: "resistor", footprint: "0603", position: { x_mm: null, y_mm: null, rotation_deg: null } },
      ],
      netlist: [],
      board_spec: { layers: 2, material: "FR4", thickness_mm: 1.6 },
    }
    expect(() => nirToCircuitJson(malformed)).toThrow(/missing required field 'ref'/)
  })

  it("raises when board_spec.material is unmapped", () => {
    const malformed = {
      schema_version: "1.1",
      design_id: "x",
      components: [{
        ref: "R1", component_id: "Y", component_type: "resistor",
        footprint: "0603",
        position: { x_mm: null, y_mm: null, rotation_deg: null },
      }],
      netlist: [],
      board_spec: { layers: 2, material: "ROGERS_4003C", thickness_mm: 1.6 },
    }
    expect(() => nirToCircuitJson(malformed)).toThrow(/not mapped/)
  })

  it("raises when footprint is unknown (refuses to silently emit 0x0)", () => {
    const malformed = {
      schema_version: "1.1",
      design_id: "x",
      components: [{
        ref: "R1", component_id: "Y", component_type: "resistor",
        footprint: "WHAT-FOOTPRINT-IS-THIS",
        position: { x_mm: null, y_mm: null, rotation_deg: null },
      }],
      netlist: [],
      board_spec: { layers: 2, material: "FR4", thickness_mm: 1.6 },
    }
    expect(() => nirToCircuitJson(malformed)).toThrow(/Unknown footprint/)
  })

  it("does NOT raise when netlist references an off-schema ref like Battery", () => {
    const valid = {
      schema_version: "1.1",
      design_id: "x",
      components: [{
        ref: "U1", component_id: "Y", component_type: "opamp",
        footprint: "MSOP-8",
        position: { x_mm: null, y_mm: null, rotation_deg: null },
      }],
      netlist: [
        {
          net_name: "VBAT",
          net_type: "power" as const,
          connections: [
            { ref: "Battery", pin_name: "POSITIVE", pin_number: "1" }, // external
            { ref: "U1", pin_name: "VCC", pin_number: "8" },
          ],
        },
      ],
      board_spec: { layers: 2, material: "FR4", thickness_mm: 1.6 },
    }
    expect(() => nirToCircuitJson(valid)).not.toThrow()
    const cj = nirToCircuitJson(valid)
    expect(cj.length).toBeGreaterThan(0)
    const traces = cj.filter((el: any) => el.type === "source_trace")
    expect(traces.length).toBe(2)
  })
})

// --------------------------------------------------------------------------- //
// LM358 KiCad symbol integration test
// --------------------------------------------------------------------------- //

describe("LM358 KiCad symbol integration", () => {
  it("serializes LM358 fixture with KiCad symbol primitives", () => {
    setUseKicadSymbols(true)
    const { lm358NoninvNir } = require("./serializer/fixtures")
    const result = serializeNir(lm358NoninvNir)
    expect(result.circuitJson.length).toBeGreaterThan(0)

    const schComps = result.circuitJson.filter(
      (el: any) => el.type === "schematic_component"
    )
    expect(schComps.length).toBeGreaterThan(0)

    const u1 = schComps.find(
      (el: any) => el.source_component_id === "U1_source"
    ) as any
    expect(u1).toBeDefined()
    expect(u1.is_box_with_pins).toBe(false)

    const kicadPaths = result.circuitJson.filter(
      (el: any) => el.type === "schematic_path" && el.schematic_component_id === "U1_sch"
    )
    expect(kicadPaths.length).toBeGreaterThan(0)

    const kicadLines = result.circuitJson.filter(
      (el: any) => el.type === "schematic_line" && el.schematic_component_id === "U1_sch"
    )
    expect(kicadLines.length).toBeGreaterThan(0)

    expect(result.svg).toContain("<svg")
  })

  it("renders SVG with KiCad triangle symbol for LM358", () => {
    setUseKicadSymbols(true)
    const { lm358NoninvNir } = require("./serializer/fixtures")
    const result = serializeNir(lm358NoninvNir)
    expect(result.svg).toContain("<svg")
    expect(result.svg.length).toBeGreaterThan(500)
  })
})

// --------------------------------------------------------------------------- //
// Net name sanitization for tscircuit JSX prop compatibility
// --------------------------------------------------------------------------- //

describe("net name sanitization for tscircuit JSX props", () => {
  it("sanitizes disallowed characters but keeps parens-safe names stable", () => {
    const { sanitizeNetNameForJsx } = require("./serializer/serializer")
    expect(sanitizeNetNameForJsx("Net-(C324-Pad1)")).toBe("Net__C324_Pad1_")
    expect(sanitizeNetNameForJsx("VIN")).toBe("VIN")
    expect(sanitizeNetNameForJsx("VCC-3.3")).toBe("VCC_3_3")
    expect(sanitizeNetNameForJsx("1A")).toBe("_1A")
    expect(sanitizeNetNameForJsx("A B")).toBe("A_B")
  })

  it("serializes a v1.2 NIR whose net name contains - and parens without throwing", async () => {
    setUseKicadSymbols(false)
    const { serializeNirAsync } = require("./serializer/serializer")
    const raw = require("./serializer/fixtures/layer2mockschema.nir.json")
    const result = await serializeNirAsync(raw)
    expect(result.circuitJson.length).toBeGreaterThan(0)

    // source_net keeps the ORIGINAL NIR net name (sanitization is prop-only)
    const nets = result.circuitJson.filter(
      (el: any) => el.type === "source_net"
    )
    const names = nets.map((n: any) => n.name)
    expect(names).toContain("Net-(C324-Pad1)")
    expect(names).not.toContain("Net__C324_Pad1_")

    // Traces reference nets by id, so connectivity is intact
    const traces = result.circuitJson.filter(
      (el: any) => el.type === "source_trace"
    )
    expect(traces.length).toBeGreaterThan(0)
    for (const t of traces) {
      expect(Array.isArray(t.connected_source_net_ids)).toBe(true)
    }

    // U301 footprint IC-PowerSSO-36-EPU is a 36-lead package; the netlist only
    // references pin 24. The drawn box must carry the FULL 36 pins (not 24,
    // the max netlist pin). Regression for the AmpOne 24-pin-box bug.
    const u301 = portsForComponent(result.circuitJson, "U301")
    expect(u301).toBe(36)
    const c324 = portsForComponent(result.circuitJson, "C324")
    expect(c324).toBe(2)
    const r308 = portsForComponent(result.circuitJson, "R308")
    expect(r308).toBe(2)
  })
})

// Number of schematic_ports drawn for a component, looked up by NIR ref name.
function portsForComponent(circuitJson: any[], name: string): number {
  const src = circuitJson.find(
    (e: any) =>
      (e.type === "source_component" || e.type === "source_component_base") &&
      e.name === name,
  )
  if (!src) return -1
  const sch = circuitJson.find(
    (e: any) =>
      e.type === "schematic_component" &&
      e.source_component_id === src.source_component_id,
  )
  if (!sch) return -1
  return circuitJson.filter(
    (e: any) =>
      e.type === "schematic_port" &&
      e.schematic_component_id === sch.schematic_component_id,
  ).length
}

// --------------------------------------------------------------------------- //
// Footprint-authoritative IC pin count
// --------------------------------------------------------------------------- //

function makeIcNir(footprint: string, pins: number[], componentType = "mcu"): any {
  return {
    schema_version: "1.1",
    design_id: "test_ic_pin_count",
    components: [
      {
        ref: "U1",
        component_id: "c1",
        component_type: componentType,
        footprint,
        value: "T",
        position: { x_mm: 0, y_mm: 0, rotation_deg: 0 },
      },
    ],
    netlist: pins.map((p, i) => ({
      net_name: `net${i}`,
      net_type: "analog",
      connections: [{ ref: "U1", pin_name: `pin${p}`, pin_number: String(p) }],
    })),
    board_spec: { layers: 2, material: "FR4", thickness_mm: 1.6 },
  }
}

describe("footprint-authoritative IC pin count", () => {
  it("sync: draws the full footprint pin count even when the netlist only references one pin", () => {
    setUseKicadSymbols(false)
    // require() gives the sync nirToCircuitJson (the module export shadowed
    // by the async variant in .d.ts — see known-issue #1).
    const { nirToCircuitJson: sync } = require("./serializer/serializer")
    // mcu has no standard symbol -> makeSymbolGeometry draws pinCount stubs.
    // SOIC-8 implies 8 pins; netlist references only pin 2. The box must have
    // 8 stubs (previously inferPinCount("SOIC-8") returned 2 -> only 2 stubs).
    const cj = sync(makeIcNir("SOIC-8", [2]))
    const stubs = cj.filter(
      (e: any) => e.type === "schematic_line" && e.schematic_component_id === "U1_sch",
    ).length
    expect(stubs).toBe(8)
  })

  it("sync: hard-errors when the netlist references a pin above the footprint's pin count", () => {
    setUseKicadSymbols(false)
    const { nirToCircuitJson: sync } = require("./serializer/serializer")
    expect(() => sync(makeIcNir("SOIC-8", [12]))).toThrow(
      /references pin 12/,
    )
  })

  it("async: unknown IC footprint renders a 2-pin box and warns loudly", async () => {
    setUseKicadSymbols(false)
    const { serializeNirAsync } = require("./serializer/serializer")
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...args: any[]) => {
      warns.push(args.join(" "))
    }
    let result: any
    try {
      result = await serializeNirAsync(makeIcNir("WEIRD-PKG-ZZ", [1, 2]))
    } finally {
      console.warn = origWarn
    }
    expect(result.circuitJson.length).toBeGreaterThan(0)
    expect(portsForComponent(result.circuitJson, "U1")).toBe(2)
    expect(warns.some((w) => w.includes("Cannot determine pin count"))).toBe(true)
  })

  it("parsePinCountFromFootprint handles connector row×pins names without false-positives", () => {
    const { parsePinCountFromFootprint } = require("./serializer/serializer")
    // PinHeader-style footprints encode rows×pins and must parse (the previous
    // "unknown footprint" warning for these was a parser gap, not a genuine
    // unknown — resolving it instead of suppressing the warning).
    expect(parsePinCountFromFootprint("Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical")).toBe(2)
    expect(parsePinCountFromFootprint("PinHeader_1x08")).toBe(8)
    expect(parsePinCountFromFootprint("PinHeader_2x03")).toBe(6)
    // KiCad body dimensions like 3x3mm must NOT be read as 3×3=9 pins when no
    // connector keyword is present.
    expect(parsePinCountFromFootprint("kicad:Package_SO/SomePkg_3x3mm_P0.5mm")).toBeNull()
    expect(parsePinCountFromFootprint("WEIRD-PKG-ZZ")).toBeNull()
  })

  it("parsePinCountFromFootprint treats THT package designators (TO-92) as package names, not pin counts", () => {
    const { parsePinCountFromFootprint } = require("./serializer/serializer")
    // TO-92 embeds "92" in the package designator; it is a 3-pin BJT, not 92 pins.
    expect(parsePinCountFromFootprint("Package_TO_SOT_THT:TO-92_Inline")).toBe(3)
    expect(parsePinCountFromFootprint("TO-92-3")).toBe(3)
    // Sibling THT/SMD packages with embedded non-pin numbers.
    expect(parsePinCountFromFootprint("TO-220")).toBe(3)
    expect(parsePinCountFromFootprint("TO-220-5")).toBe(5)
    expect(parsePinCountFromFootprint("TO-247-4")).toBe(4)
    expect(parsePinCountFromFootprint("TO-263-5")).toBe(5)
    expect(parsePinCountFromFootprint("SOT-223")).toBe(4)
    expect(parsePinCountFromFootprint("SOT-89")).toBe(3)
    expect(parsePinCountFromFootprint("SOT-23-6")).toBe(6)
    // Pin-count package names must keep parsing as before.
    expect(parsePinCountFromFootprint("SOIC-8")).toBe(8)
    expect(parsePinCountFromFootprint("soic8")).toBe(8)
    expect(parsePinCountFromFootprint("DIP-8_W7.62mm_LongPads")).toBe(8)
  })
})
