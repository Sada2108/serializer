import {
  CapacityMeshSolver,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter";

export interface RoutedTrace {
  route: Array<
    | { route_type: "wire"; x: number; y: number; width: number; layer: string }
    | {
        route_type: "via";
        x: number;
        y: number;
        to_layer: string;
        from_layer: string;
      }
  >;
}

export interface RouteCircuitResult {
  success: boolean;
  traces: RoutedTrace[];
  error?: string;
}

function convertSimplifiedPcbTraces(traces: SimplifiedPcbTrace[]): RoutedTrace[] {
  const result: RoutedTrace[] = [];

  for (const trace of traces) {
    const route: RoutedTrace["route"] = [];

    for (const segment of trace.route) {
      if (segment.route_type === "wire") {
        route.push({
          route_type: "wire",
          x: segment.x,
          y: segment.y,
          width: segment.width,
          layer: segment.layer,
        });
      } else if (segment.route_type === "via") {
        route.push({
          route_type: "via",
          x: segment.x,
          y: segment.y,
          to_layer: segment.to_layer,
          from_layer: segment.from_layer,
        });
      }
    }

    if (route.length > 0) {
      const manhattan = snapRouteToManhattan(route);
      result.push({ route: chamferRouteTo45Degree(manhattan) });
    }
  }

  return result;
}

function snapRouteToManhattan(route: RoutedTrace["route"]): RoutedTrace["route"] {
  const out: RoutedTrace["route"] = [];

  for (let i = 0; i < route.length; i++) {
    const seg = route[i];

    if (seg.route_type === "via") {
      out.push(seg);
      continue;
    }

    const nextWire = findNextWireOnLayer(route, i + 1, seg.layer);
    if (!nextWire) {
      out.push(seg);
      continue;
    }

    const dx = Math.abs(nextWire.x - seg.x);
    const dy = Math.abs(nextWire.y - seg.y);

    if (dx < 1e-6 || dy < 1e-6) {
      out.push(seg);
      continue;
    }

    // Diagonal — split into L-shape (horizontal first, then vertical)
    out.push({ ...seg });
    out.push({
      ...seg,
      x: nextWire.x,
      y: seg.y,
    });
    out.push({
      ...seg,
      x: nextWire.x,
      y: nextWire.y,
    });
  }

  return out;
}

const CHAMFER_FACTOR = 1 / 3;

function chamferRouteTo45Degree(route: RoutedTrace["route"]): RoutedTrace["route"] {
  if (route.length < 3) return route;

  const out: RoutedTrace["route"] = [];
  let i = 0;

  while (i < route.length) {
    const seg = route[i];

    if (seg.route_type === "via") {
      out.push(seg);
      i++;
      continue;
    }

    // Find the end of the current same-layer wire run
    const runStart = i;
    const runLayer = seg.layer;
    let runEnd = i + 1;
    while (runEnd < route.length) {
      const s = route[runEnd];
      if (s.route_type === "via") break;
      if (s.route_type === "wire" && s.layer === runLayer) {
        runEnd++;
      } else {
        break;
      }
    }

    // Extract points in this run (wire positions only)
    const points: Array<{ x: number; y: number; width: number; layer: string }> = [];
    for (let j = runStart; j < runEnd; j++) {
      const w = route[j] as any;
      points.push({ x: w.x, y: w.y, width: w.width, layer: w.layer });
    }

    const chamfered = chamferPointRun(points);

    for (const p of chamfered) {
      out.push({
        route_type: "wire",
        x: p.x,
        y: p.y,
        width: p.width,
        layer: p.layer,
      });
    }

    i = runEnd;
  }

  return out;
}

function chamferPointRun(
  points: Array<{ x: number; y: number; width: number; layer: string }>,
): Array<{ x: number; y: number; width: number; layer: string }> {
  if (points.length < 3) return points;

  const result: Array<{ x: number; y: number; width: number; layer: string }> = [];
  result.push({ ...points[0] });

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    const dx0 = curr.x - prev.x;
    const dy0 = curr.y - prev.y;
    const dx1 = next.x - curr.x;
    const dy1 = next.y - curr.y;

    const len0 = Math.abs(dx0) + Math.abs(dy0);
    const len1 = Math.abs(dx1) + Math.abs(dy1);

    // Both segments must be axis-aligned (Manhattan)
    const horiz0 = Math.abs(dy0) < 1e-6;
    const vert0 = Math.abs(dx0) < 1e-6;
    const horiz1 = Math.abs(dy1) < 1e-6;
    const vert1 = Math.abs(dx1) < 1e-6;

    const isCorner = (horiz0 && vert1) || (vert0 && horiz1);

    if (!isCorner || len0 < 1e-6 || len1 < 1e-6) {
      result.push({ ...curr });
      continue;
    }

    // Chamfer size: fraction of the shorter segment
    const chamfer = Math.min(len0, len1) * CHAMFER_FACTOR;
    if (chamfer < 0.01) {
      result.push({ ...curr });
      continue;
    }

    // Direction of first segment (toward curr)
    const sx0 = dx0 > 0 ? 1 : dx0 < 0 ? -1 : 0;
    const sy0 = dy0 > 0 ? 1 : dy0 < 0 ? -1 : 0;

    // Direction of second segment (away from curr)
    const sx1 = dx1 > 0 ? 1 : dx1 < 0 ? -1 : 0;
    const sy1 = dy1 > 0 ? 1 : dy1 < 0 ? -1 : 0;

    // Insert chamfer point: move back along first segment from curr
    const d = { x: curr.x - sx0 * chamfer, y: curr.y - sy0 * chamfer, width: curr.width, layer: curr.layer };
    // Insert chamfer point: move forward along second segment from curr
    const e = { x: curr.x + sx1 * chamfer, y: curr.y + sy1 * chamfer, width: curr.width, layer: curr.layer };

    result.push(d);
    result.push(e);
  }

  result.push({ ...points[points.length - 1] });

  return result;
}

function findNextWireOnLayer(
  route: RoutedTrace["route"],
  start: number,
  layer: string,
): RoutedTrace["route"][number] | null {
  for (let i = start; i < route.length; i++) {
    const seg = route[i];
    if (seg.route_type === "via") return null;
    if (seg.route_type === "wire" && seg.layer === layer) return seg;
  }
  return null;
}

export async function routeCircuit(
  simpleRouteJson: SimpleRouteJson,
): Promise<RouteCircuitResult> {
  try {
    const solver = new CapacityMeshSolver(simpleRouteJson, {
      effort: 1,
    });

    solver.solve();

    const output = solver.getOutputSimplifiedPcbTraces();

    if (!output || output.length === 0) {
      return {
        success: false,
        traces: [],
        error: "No routes found - circuit may be unroutable",
      };
    }

    const traces = convertSimplifiedPcbTraces(output);

    return {
      success: true,
      traces,
    };
  } catch (err) {
    return {
      success: false,
      traces: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
