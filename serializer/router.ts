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
      // Skip jumpers and through_obstacle for now
    }

    if (route.length > 0) {
      result.push({ route: snapRouteToManhattan(route) });
    }
  }

  return result;
}

/**
 * Snap a route to Manhattan (horizontal/vertical only) routing.
 * Diagonal wire segments are split into an L-shaped pair of orthogonal segments.
 * Via segments are preserved and used as layer-change boundaries.
 */
function snapRouteToManhattan(route: RoutedTrace["route"]): RoutedTrace["route"] {
  const out: RoutedTrace["route"] = [];

  for (let i = 0; i < route.length; i++) {
    const seg = route[i];

    if (seg.route_type === "via") {
      out.push(seg);
      continue;
    }

    // Wire segment — check if the NEXT wire segment on the same layer is diagonal
    const nextWire = findNextWireOnLayer(route, i + 1, seg.layer);
    if (!nextWire) {
      out.push(seg);
      continue;
    }

    const dx = Math.abs(nextWire.x - seg.x);
    const dy = Math.abs(nextWire.y - seg.y);

    // Already Manhattan (only one axis changes)
    if (dx < 1e-6 || dy < 1e-6) {
      out.push(seg);
      continue;
    }

    // Diagonal — split into L-shape: go horizontal first, then vertical
    out.push({
      route_type: "wire",
      x: seg.x,
      y: seg.y,
      width: seg.width,
      layer: seg.layer,
    });
    // Corner point (horizontal first)
    out.push({
      route_type: "wire",
      x: nextWire.x,
      y: seg.y,
      width: seg.width,
      layer: seg.layer,
    });
    // Vertical leg to next point
    out.push({
      route_type: "wire",
      x: nextWire.x,
      y: nextWire.y,
      width: seg.width,
      layer: seg.layer,
    });
  }

  return out;
}

/** Find the next wire segment on the same layer after index `start`. */
function findNextWireOnLayer(
  route: RoutedTrace["route"],
  start: number,
  layer: string,
): RoutedTrace["route"][number] | null {
  for (let i = start; i < route.length; i++) {
    const seg = route[i];
    if (seg.route_type === "via") {
      // Via ends the current layer's wire run
      return null;
    }
    if (seg.route_type === "wire" && seg.layer === layer) {
      return seg;
    }
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