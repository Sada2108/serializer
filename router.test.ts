import { routeCircuit, type RoutedTrace, type RouteCircuitResult } from "./serializer/router";

describe("routeCircuit", () => {
  // Test fixture: routable simple circuit
  const routableFixture: Parameters<typeof routeCircuit>[0] = {
    layerCount: 2,
    minTraceWidth: 0.15,
    nominalTraceWidth: 0.2,
    minViaPadDiameter: 0.5,
    min_via_pad_diameter: 0.5,
    minViaHoleDiameter: 0.3,
    min_via_hole_diameter: 0.3,
    defaultObstacleMargin: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: 0, maxX: 50, minY: 0, maxY: 50 },
    obstacles: [
      {
        obstacleId: "obs1",
        componentId: "R1",
        type: "rect",
        layers: ["top"],
        center: { x: 20, y: 20 },
        width: 4,
        height: 2,
        connectedTo: [],
      },
      {
        obstacleId: "obs2",
        componentId: "C1",
        type: "rect",
        layers: ["top"],
        center: { x: 30, y: 30 },
        width: 3,
        height: 3,
        connectedTo: [],
      },
      {
        obstacleId: "obs3",
        componentId: "U1",
        type: "rect",
        layers: ["top", "bottom"],
        center: { x: 10, y: 40 },
        width: 8,
        height: 6,
        connectedTo: ["net1"],
      },
    ],
    connections: [
      {
        name: "net1",
        pointsToConnect: [
          { x: 5, y: 5, layer: "top", pointId: "p1" },
          { x: 45, y: 45, layer: "top", pointId: "p2" },
        ],
      },
      {
        name: "net2",
        pointsToConnect: [
          { x: 5, y: 45, layer: "top", pointId: "p3" },
          { x: 45, y: 5, layer: "bottom", pointId: "p4" },
        ],
      },
    ],
    allowJumpers: false,
  };

  // Test fixture: invalid input that should fail gracefully
  const invalidFixture: Parameters<typeof routeCircuit>[0] = {
    layerCount: 2,
    minTraceWidth: 0.15,
    nominalTraceWidth: 0.2,
    minViaPadDiameter: 0.5,
    min_via_pad_diameter: 0.5,
    minViaHoleDiameter: 0.3,
    min_via_hole_diameter: 0.3,
    defaultObstacleMargin: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: 0, maxX: 20, minY: 0, maxY: 20 },
    obstacles: [],
    // No connections - this should be invalid
    connections: [],
    allowJumpers: false,
  };

  it("routes a simple circuit successfully", async () => {
    const result: RouteCircuitResult = await routeCircuit(routableFixture);

    expect(result.success).toBe(true);
    expect(result.traces).toBeDefined();
    expect(Array.isArray(result.traces)).toBe(true);
    expect(result.traces.length).toBeGreaterThan(0);

    // Validate each trace matches RoutedTrace shape exactly
    for (const trace of result.traces) {
      expect(trace).toHaveProperty("route");
      expect(Array.isArray(trace.route)).toBe(true);
      expect(trace.route.length).toBeGreaterThan(0);

      for (const segment of trace.route) {
        expect(segment).toHaveProperty("route_type");
        expect(["wire", "via"]).toContain(segment.route_type);

        if (segment.route_type === "wire") {
          expect(segment).toHaveProperty("x");
          expect(segment).toHaveProperty("y");
          expect(segment).toHaveProperty("width");
          expect(segment).toHaveProperty("layer");
          expect(typeof segment.x).toBe("number");
          expect(typeof segment.y).toBe("number");
          expect(typeof segment.width).toBe("number");
          expect(typeof segment.layer).toBe("string");
        }

        if (segment.route_type === "via") {
          expect(segment).toHaveProperty("x");
          expect(segment).toHaveProperty("y");
          expect(segment).toHaveProperty("to_layer");
          expect(segment).toHaveProperty("from_layer");
          expect(typeof segment.x).toBe("number");
          expect(typeof segment.y).toBe("number");
          expect(typeof segment.to_layer).toBe("string");
          expect(typeof segment.from_layer).toBe("string");
        }
      }
    }
  });

  it("fails gracefully on invalid input", async () => {
    const result: RouteCircuitResult = await routeCircuit(invalidFixture);

    expect(result.success).toBe(false);
    expect(result.traces).toEqual([]);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("all wire segments are Manhattan (horizontal or vertical only)", async () => {
    const result: RouteCircuitResult = await routeCircuit(routableFixture);
    expect(result.success).toBe(true);

    for (const trace of result.traces) {
      for (let i = 0; i < trace.route.length; i++) {
        const seg = trace.route[i];
        if (seg.route_type !== "wire") continue;

        // Find the next wire segment on the same layer, stopping at vias
        let nextWire: RoutedTrace["route"][number] | null = null;
        for (let j = i + 1; j < trace.route.length; j++) {
          const s = trace.route[j];
          if (s.route_type === "via") break; // via ends this layer's run
          if (s.route_type === "wire" && s.layer === seg.layer) {
            nextWire = s;
            break;
          }
        }
        if (!nextWire) continue;

        const dx = Math.abs(nextWire.x - seg.x);
        const dy = Math.abs(nextWire.y - seg.y);
        const isManhattan = dx < 1e-6 || dy < 1e-6;

        expect(isManhattan).toBe(true);
      }
    }
  });

  it("no two same-layer wire segments cross without a via between them", async () => {
    const result: RouteCircuitResult = await routeCircuit(routableFixture);
    expect(result.success).toBe(true);

    // Collect all same-layer wire segments within each layer run
    // (a layer run ends at a via or at the end of the trace)
    const segsByLayer = new Map<string, Array<{ x1: number; y1: number; x2: number; y2: number; net: string }>>();

    for (const trace of result.traces) {
      // Walk through the route, collecting segments within each layer run
      let currentRunLayer: string | null = null;
      let runStartIdx = -1;

      for (let i = 0; i < trace.route.length; i++) {
        const seg = trace.route[i];
        if (seg.route_type === "via") {
          // End current run
          if (currentRunLayer && runStartIdx >= 0) {
            collectRunSegments(trace.route, runStartIdx, i, currentRunLayer, segsByLayer);
          }
          currentRunLayer = seg.to_layer;
          runStartIdx = i + 1;
        }
      }
      // End of route — collect remaining run
      if (currentRunLayer && runStartIdx >= 0) {
        collectRunSegments(trace.route, runStartIdx, trace.route.length, currentRunLayer, segsByLayer);
      }

      // Also handle traces with no vias at all (entire trace is one run)
      const hasVias = trace.route.some((s) => s.route_type === "via");
      if (!hasVias && trace.route.length > 0) {
        const firstWire = trace.route.find((s) => s.route_type === "wire");
        if (firstWire) {
          collectRunSegments(trace.route, 0, trace.route.length, firstWire.layer, segsByLayer);
        }
      }
    }

    // Check for crossings within each layer
    for (const [layer, segs] of segsByLayer) {
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          const a = segs[i];
          const b = segs[j];
          if (segmentsCross(a, b)) {
            expect(
              false,
              `Same-layer crossing detected on ${layer} between nets "${a.net}" and "${b.net}" at segments (${a.x1},${a.y1})-(${a.x2},${a.y2}) and (${b.x1},${b.y1})-(${b.x2},${b.y2})`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

/** Check if two axis-aligned segments cross (interior intersection). */
function segmentsCross(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): boolean {
  // Both must be axis-aligned (Manhattan)
  const aHoriz = Math.abs(a.y1 - a.y2) < 1e-6;
  const bHoriz = Math.abs(b.y1 - b.y2) < 1e-6;
  if (aHoriz === bHoriz) return false; // parallel — no crossing

  const h = aHoriz ? a : b;
  const v = aHoriz ? b : a;

  const hMinX = Math.min(h.x1, h.x2);
  const hMaxX = Math.max(h.x1, h.x2);
  const vMinY = Math.min(v.y1, v.y2);
  const vMaxY = Math.max(v.y1, v.y2);

  const crossX = v.x1 > hMinX && v.x1 < hMaxX;
  const crossY = h.y1 > vMinY && h.y1 < vMaxY;

  return crossX && crossY;
}

/** Collect consecutive wire segments within a layer run into crossing-check pairs. */
function collectRunSegments(
  route: any[],
  start: number,
  end: number,
  layer: string,
  segsByLayer: Map<string, Array<{ x1: number; y1: number; x2: number; y2: number; net: string }>>,
) {
  if (!segsByLayer.has(layer)) segsByLayer.set(layer, []);
  const segs = segsByLayer.get(layer)!;

  // Collect consecutive same-layer wire pairs within [start, end)
  for (let i = start; i < end; i++) {
    const seg = route[i];
    if (seg.route_type !== "wire" || seg.layer !== layer) continue;

    // Find the next same-layer wire in this run
    for (let j = i + 1; j < end; j++) {
      const next = route[j];
      if (next.route_type === "via") break;
      if (next.route_type === "wire" && next.layer === layer) {
        // Skip zero-length segments
        if (Math.abs(seg.x - next.x) > 1e-6 || Math.abs(seg.y - next.y) > 1e-6) {
          segs.push({
            x1: seg.x, y1: seg.y,
            x2: next.x, y2: next.y,
            net: (seg as any).net ?? "unknown",
          });
        }
        break;
      }
    }
  }
}