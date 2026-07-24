import { circuitJsonToSimpleRouteJson, mergeRoutedTraces, routeCircuitJson, enforcePlacementClearance } from "./serializer/pcbRouting"
import { serializeNirAsync } from "./serializer/serializer"
import { opampNoninvNir } from "./serializer/fixtures"
import type { AnyCircuitElement } from "circuit-json"

describe("pcbRouting", () => {
  let circuitJson: AnyCircuitElement[]

  beforeAll(async () => {
    const out = await serializeNirAsync(opampNoninvNir)
    circuitJson = out.circuitJson
  })

  describe("circuitJsonToSimpleRouteJson", () => {
    it("produces a valid SimpleRouteJson with correct shape", () => {
      const srj = circuitJsonToSimpleRouteJson(circuitJson)

      expect(srj).toBeDefined()
      expect(typeof srj.layerCount).toBe("number")
      expect(srj.layerCount).toBeGreaterThan(0)
      expect(typeof srj.minTraceWidth).toBe("number")
      expect(srj.minTraceWidth).toBeGreaterThan(0)
      expect(srj.bounds).toBeDefined()
      expect(srj.bounds.minX).toBeLessThan(srj.bounds.maxX)
      expect(srj.bounds.minY).toBeLessThan(srj.bounds.maxY)
      expect(Array.isArray(srj.obstacles)).toBe(true)
      expect(srj.obstacles.length).toBeGreaterThan(0)
      expect(Array.isArray(srj.connections)).toBe(true)
      expect(srj.connections.length).toBeGreaterThan(0)
    })

    it("maps pcb_components to obstacles with correct fields", () => {
      const srj = circuitJsonToSimpleRouteJson(circuitJson)

      for (const obs of srj.obstacles) {
        expect(obs.type).toBe("rect")
        expect(obs.center).toBeDefined()
        expect(typeof obs.center.x).toBe("number")
        expect(typeof obs.center.y).toBe("number")
        expect(typeof obs.width).toBe("number")
        expect(typeof obs.height).toBe("number")
        expect(Array.isArray(obs.layers)).toBe(true)
        expect(obs.layers.length).toBeGreaterThan(0)
      }
    })

    it("maps source nets to connections with 2+ pointsToConnect", () => {
      const srj = circuitJsonToSimpleRouteJson(circuitJson)

      for (const conn of srj.connections) {
        expect(typeof conn.name).toBe("string")
        expect(conn.name.length).toBeGreaterThan(0)
        expect(Array.isArray(conn.pointsToConnect)).toBe(true)
        expect(conn.pointsToConnect.length).toBeGreaterThanOrEqual(2)

        for (const pt of conn.pointsToConnect) {
          expect(typeof pt.x).toBe("number")
          expect(typeof pt.y).toBe("number")
          // layer must be present (either as `layer` on SingleLayerConnectionPoint)
          const layer = (pt as any).layer
          expect(typeof layer).toBe("string")
          expect(layer.length).toBeGreaterThan(0)
        }
      }
    })
  })

  describe("routeCircuitJson end-to-end", () => {
    it("routes the opamp_noninv fixture successfully", async () => {
      const result = await routeCircuitJson(circuitJson)

      expect(result.success).toBe(true)
      expect(result.circuitJson).toBeDefined()
      expect(Array.isArray(result.circuitJson)).toBe(true)
    }, 30000)

    it("merged circuitJson has real pcb_trace entries with wire/via route segments", async () => {
      const result = await routeCircuitJson(circuitJson)

      expect(result.success).toBe(true)

      const pcbTraces = result.circuitJson.filter((e: any) => e.type === "pcb_trace")
      expect(pcbTraces.length).toBeGreaterThan(0)

      for (const trace of pcbTraces) {
        expect(trace.pcb_trace_id).toBeDefined()
        expect(Array.isArray(trace.route)).toBe(true)
        expect(trace.route.length).toBeGreaterThan(0)

        for (const seg of trace.route) {
          expect(["wire", "via"]).toContain(seg.route_type)

          if (seg.route_type === "wire") {
            expect(typeof seg.x).toBe("number")
            expect(typeof seg.y).toBe("number")
            expect(typeof seg.width).toBe("number")
            expect(typeof seg.layer).toBe("string")
          }

          if (seg.route_type === "via") {
            expect(typeof seg.x).toBe("number")
            expect(typeof seg.y).toBe("number")
            expect(typeof seg.to_layer).toBe("string")
            expect(typeof seg.from_layer).toBe("string")
          }
        }
      }
    }, 30000)
  })

  describe("mergeRoutedTraces", () => {
    it("removes old placeholder pcb_traces and inserts new routed ones", () => {
      const oldTraces = circuitJson.filter((e: any) => e.type === "pcb_trace")

      const fakeRouted: import("./serializer/router").RoutedTrace[] = [
        {
          route: [
            { route_type: "wire", x: 1, y: 2, width: 0.15, layer: "top" },
            { route_type: "wire", x: 5, y: 6, width: 0.15, layer: "top" },
          ],
        },
      ]

      const merged = mergeRoutedTraces(circuitJson, fakeRouted)

      const newTraces = merged.filter((e: any) => e.type === "pcb_trace")
      expect(newTraces.length).toBe(1)
      expect(newTraces[0].pcb_trace_id).toBe("routed_trace_0")
      expect(newTraces[0].route.length).toBe(2)
      expect(newTraces[0].route[0].route_type).toBe("wire")

      // Old traces should be gone
      const oldIds = new Set(oldTraces.map((t: any) => t.pcb_trace_id))
      const remainingIds = newTraces.map((t: any) => t.pcb_trace_id)
      for (const id of remainingIds) {
        expect(oldIds.has(id)).toBe(false)
      }
    })
  })

  describe("enforcePlacementClearance", () => {
    it("nudges overlapping components apart", () => {
      const overlapping: AnyCircuitElement[] = [
        { type: "pcb_board", pcb_board_id: "b1", width: 80, height: 60, num_layers: 2 } as any,
        { type: "pcb_component", pcb_component_id: "c1", source_component_id: "s1", center: { x: 10, y: 10 }, layer: "top", width: 2, height: 1, rotation: 0 } as any,
        { type: "pcb_component", pcb_component_id: "c2", source_component_id: "s2", center: { x: 10.2, y: 10 }, layer: "top", width: 2, height: 1, rotation: 0 } as any,
      ]

      const result = enforcePlacementClearance(overlapping)
      const comps = result.filter((e: any) => e.type === "pcb_component") as any[]

      const c1 = comps.find((c) => c.pcb_component_id === "c1")!
      const c2 = comps.find((c) => c.pcb_component_id === "c2")!

      // After clearance enforcement, edges must have at least MIN_PLACEMENT_CLEARANCE_MM gap
      const edgeGapX = Math.abs(c2.center.x - c1.center.x) - (c1.width + c2.width) / 2
      const edgeGapY = Math.abs(c2.center.y - c1.center.y) - (c1.height + c2.height) / 2
      const hasClearance = edgeGapX >= 0.5 || edgeGapY >= 0.5
      expect(hasClearance).toBe(true)
    })

    it("does not move components that already have sufficient clearance", () => {
      const spaced: AnyCircuitElement[] = [
        { type: "pcb_board", pcb_board_id: "b1", width: 80, height: 60, num_layers: 2 } as any,
        { type: "pcb_component", pcb_component_id: "c1", source_component_id: "s1", center: { x: 0, y: 0 }, layer: "top", width: 2, height: 1, rotation: 0 } as any,
        { type: "pcb_component", pcb_component_id: "c2", source_component_id: "s2", center: { x: 10, y: 10 }, layer: "top", width: 2, height: 1, rotation: 0 } as any,
      ]

      const result = enforcePlacementClearance(spaced)
      const comps = result.filter((e: any) => e.type === "pcb_component") as any[]
      const c1 = comps.find((c) => c.pcb_component_id === "c1")!
      const c2 = comps.find((c) => c.pcb_component_id === "c2")!

      expect(c1.center.x).toBe(0)
      expect(c1.center.y).toBe(0)
      expect(c2.center.x).toBe(10)
      expect(c2.center.y).toBe(10)
    })
  })
})
