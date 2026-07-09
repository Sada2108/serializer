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
} from "./open_forge/serializer"
import { libbrechtHallNir, instrumentationAmpNir } from "./open_forge/fixtures"

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
    const prev = process.env.OPEN_FORGE_VIEWER
    process.env.OPEN_FORGE_VIEWER = "schematic-viewer"
    try {
      const cj = nirToCircuitJson(libbrechtHallNir)
      const { viewerUsed } = renderCircuitJson(cj)
      // If the viewer is installed, we get that; otherwise circuit-to-svg.
      expect(viewerUsed === "circuit-to-svg" ||
             viewerUsed === "@tscircuit/schematic-viewer").toBe(true)
    } finally {
      if (prev === undefined) delete process.env.OPEN_FORGE_VIEWER
      else process.env.OPEN_FORGE_VIEWER = prev
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
    const n = instrumentationAmpNir.components.length
    expect(n).toBe(15)
    expect(pbcs.length).toBe(n)
    expect(schs.length).toBe(n)
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
