import type { AnyCircuitElement } from "circuit-json"
import type { SimpleRouteJson, Obstacle, SimpleRouteConnection } from "@tscircuit/capacity-autorouter"
import { routeCircuit, type RoutedTrace } from "./router"

const DEFAULT_MIN_TRACE_WIDTH = 0.15
const DEFAULT_NOMINAL_TRACE_WIDTH = 0.2

export function circuitJsonToSimpleRouteJson(circuitJson: AnyCircuitElement[]): SimpleRouteJson {
  const board = circuitJson.find((e: any) => e.type === "pcb_board") as any
  const pcbComponents = circuitJson.filter((e: any) => e.type === "pcb_component") as any[]
  const pcbPorts = circuitJson.filter((e: any) => e.type === "pcb_port") as any[]
  const sourcePorts = circuitJson.filter((e: any) => e.type === "source_port") as any[]
  const sourceNets = circuitJson.filter((e: any) => e.type === "source_net") as any[]
  const sourceTraces = circuitJson.filter((e: any) => e.type === "source_trace") as any[]

  const boardWidth = board?.width ?? 80
  const boardHeight = board?.height ?? 60
  const layerCount = board?.num_layers ?? 2
  const minTraceWidth = board?.min_trace_width ?? DEFAULT_MIN_TRACE_WIDTH
  const bounds = {
    minX: -(boardWidth / 2),
    maxX: boardWidth / 2,
    minY: -(boardHeight / 2),
    maxY: boardHeight / 2,
  }

  // Build obstacles from pcb_components
  const obstacles: Obstacle[] = pcbComponents
    .filter((c) => c.obstructs_within_bounds !== false)
    .filter(Boolean)
    .map((c) => {
      const opId = c.pcb_component_id
      const opType = "rect" as const
      const opLayers = c.layer === "top" ? ["top"] : c.layer === "bottom" ? ["bottom"] : [c.layer]
      const opCenter = { x: c.center.x, y: c.center.y }
      const opWidth = c.width
      const opHeight = c.height
      const opConnectedTo: string[] = []
      return {
        obstacleId: opId,
        type: opType,
        layers: opLayers,
        center: opCenter,
        width: opWidth,
        height: opHeight,
        connectedTo: opConnectedTo,
      } as Obstacle
    })

  // Build pad-level obstacles so the autorouter maintains clearance from
  // pads belonging to other nets. Each pad obstacle's connectedTo contains
  // the net name, allowing only that net to route through the pad area.
  const smtpads = circuitJson.filter((e: any) => e.type === "pcb_smtpad") as any[]
  const pcbCompById = new Map(pcbComponents.map((c: any) => [c.pcb_component_id, c]))
  const portByPcbPortId = new Map(pcbPorts.map((p: any) => [p.pcb_port_id, p]))
  const traceBySrcPortId = new Map<string, any>()
  for (const st of sourceTraces) {
    for (const spId of (st.connected_source_port_ids || [])) {
      traceBySrcPortId.set(spId, st)
    }
  }
  const netIdToName = new Map(sourceNets.map((n: any) => [n.source_net_id, n.name]))

  for (const pad of smtpads) {
    const port = portByPcbPortId.get(pad.pcb_port_id)
    if (!port?.source_port_id) continue
    const trace = traceBySrcPortId.get(port.source_port_id)
    const netName = trace?.connected_source_net_ids?.length
      ? (netIdToName.get(trace.connected_source_net_ids[0]) ?? "")
      : ""
    if (!netName) continue

    const comp = pcbCompById.get(pad.pcb_component_id)
    const layer = comp?.layer === "top" ? ["top"] : comp?.layer === "bottom" ? ["bottom"] : ["top"]

    obstacles.push({
      obstacleId: `pad_${pad.pcb_smtpad_id}`,
      type: "rect",
      layers: layer,
      center: { x: pad.x, y: pad.y },
      width: (pad.width ?? 0.6) + 0.4,  // Add clearance margin (KiCad requires 0.2mm clearance + 0.2mm track half-width)
      height: (pad.height ?? 0.6) + 0.4,
      connectedTo: [netName],
    } as Obstacle)
  }

  // Build source_port lookup: source_port_id -> source_port
  const sourcePortMap = new Map<string, any>()
  for (const sp of sourcePorts) {
    sourcePortMap.set(sp.source_port_id, sp)
  }

  // Build pcb_port lookup: pcb_port_id -> pcb_port
  const pcbPortMap = new Map<string, any>()
  for (const pp of pcbPorts) {
    pcbPortMap.set(pp.pcb_port_id, pp)
  }

  // Map source_port_id -> pcb_port (via source_port_id field on pcb_port)
  const sourceToPcbPort = new Map<string, any>()
  for (const pp of pcbPorts) {
    if (pp.source_port_id) {
      sourceToPcbPort.set(pp.source_port_id, pp)
    }
  }

  // For each source_net, collect all connected pcb_ports
  const connections: SimpleRouteConnection[] = []
  for (const net of sourceNets) {
    const connectedPortIds = new Set<string>()
    for (const trace of sourceTraces) {
      if (trace.connected_source_net_ids?.includes(net.source_net_id)) {
        for (const portId of trace.connected_source_port_ids || []) {
          connectedPortIds.add(portId)
        }
      }
    }

    const pointsToConnect: SimpleRouteConnection["pointsToConnect"] = []
    for (const portId of connectedPortIds) {
      const pcbPort = sourceToPcbPort.get(portId)
      if (pcbPort) {
        const layer = (pcbPort.layers?.[0] as string) ?? "top"
        pointsToConnect.push({
          x: pcbPort.x,
          y: pcbPort.y,
          layer,
          pointId: pcbPort.pcb_port_id,
        })
      }
    }

    if (pointsToConnect.length >= 2) {
      connections.push({
        name: net.name ?? net.source_net_id,
        pointsToConnect,
      })
    }
  }

  const simpleRouteJson: SimpleRouteJson = {
    layerCount,
    minTraceWidth,
    nominalTraceWidth: DEFAULT_NOMINAL_TRACE_WIDTH,
    minViaPadDiameter: board?.min_via_pad_diameter ?? 0.3,
    min_via_pad_diameter: board?.min_via_pad_diameter ?? 0.3,
    minViaHoleDiameter: board?.min_via_hole_diameter ?? 0.2,
    min_via_hole_diameter: board?.min_via_hole_diameter ?? 0.2,
    defaultObstacleMargin: 0.35,
    minTraceToPadEdgeClearance: board?.min_trace_to_pad_edge_clearance ?? 0.25,
    obstacles,
    connections,
    bounds,
    allowJumpers: false,
  }

  return simpleRouteJson
}

export function mergeRoutedTraces(
  circuitJson: AnyCircuitElement[],
  routedTraces: RoutedTrace[],
): AnyCircuitElement[] {
  const result = [...circuitJson]

  // Remove old pcb_trace entries (the placeholder/ratsnest traces)
  const filtered = result.filter((e: any) => e.type !== "pcb_trace")

  // Add new routed traces as pcb_trace elements
  for (let i = 0; i < routedTraces.length; i++) {
    const routed = routedTraces[i]
    filtered.push({
      type: "pcb_trace",
      pcb_trace_id: `routed_trace_${i}`,
      connection_name: `routed_net_${i}`,
      route: routed.route.map((seg) => {
        if (seg.route_type === "wire") {
          return {
            route_type: "wire",
            x: seg.x,
            y: seg.y,
            width: seg.width,
            layer: seg.layer,
          }
        }
        return {
          route_type: "via",
          x: seg.x,
          y: seg.y,
          to_layer: seg.to_layer,
          from_layer: seg.from_layer,
        }
      }),
    } as AnyCircuitElement)
  }

  return filtered
}

/**
 * Minimum courtyard clearance between any two PCB components (mm).
 * Components closer than this will be pushed apart along the axis of overlap.
 */
const MIN_PLACEMENT_CLEARANCE_MM = 0.5

/**
 * Enforce minimum clearance between PCB component footprints by nudging
 * overlapping components apart along the axis of maximum overlap.
 * Returns a new array (does not mutate the input).
 */
export function enforcePlacementClearance(circuitJson: AnyCircuitElement[]): AnyCircuitElement[] {
  const result = circuitJson.map((e) => ({ ...e }))
  const components = result.filter((e: any) => e.type === "pcb_component") as any[]

  // Sort by x then y for deterministic ordering
  components.sort((a: any, b: any) =>
    a.center.x !== b.center.x ? a.center.x - b.center.x : a.center.y - b.center.y,
  )

  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const a = components[i]
      const b = components[j]
      if (!a?.center || !b?.center) continue

      const hwA = (a.width ?? 1) / 2 + MIN_PLACEMENT_CLEARANCE_MM / 2
      const hhA = (a.height ?? 1) / 2 + MIN_PLACEMENT_CLEARANCE_MM / 2
      const hwB = (b.width ?? 1) / 2 + MIN_PLACEMENT_CLEARANCE_MM / 2
      const hhB = (b.height ?? 1) / 2 + MIN_PLACEMENT_CLEARANCE_MM / 2

      const dx = b.center.x - a.center.x
      const dy = b.center.y - a.center.y
      const overlapX = (hwA + hwB) - Math.abs(dx)
      const overlapY = (hhA + hhB) - Math.abs(dy)

      if (overlapX > 0 && overlapY > 0) {
        // Push apart along the axis of minimum overlap (smallest push distance).
        // hwA/hwB already include clearance/2, so desired center-to-center = hwA + hwB.
        if (overlapX < overlapY) {
          const push = (hwA + hwB) - Math.abs(dx)
          const dir = dx >= 0 ? 1 : -1
          b.center = { ...b.center, x: b.center.x + push * dir }
        } else {
          const push = (hhA + hhB) - Math.abs(dy)
          const dir = dy >= 0 ? 1 : -1
          b.center = { ...b.center, y: b.center.y + push * dir }
        }
      }
    }
  }

  return result
}

export async function routeCircuitJson(
  circuitJson: AnyCircuitElement[],
): Promise<{ circuitJson: AnyCircuitElement[]; success: boolean; error?: string }> {
  // Enforce minimum clearance before routing
  const clearedCircuitJson = enforcePlacementClearance(circuitJson)
  const simpleRouteJson = circuitJsonToSimpleRouteJson(clearedCircuitJson)
  const result = await routeCircuit(simpleRouteJson)

  if (!result.success) {
    return { circuitJson, success: false, error: result.error }
  }

  const merged = mergeRoutedTraces(clearedCircuitJson, result.traces)
  return { circuitJson: merged, success: true }
}

/**
 * Snap all pcb_trace routes in CircuitJSON to Manhattan (horizontal/vertical)
 * routing. Diagonal wire segments are split into L-shaped orthogonal pairs.
 * Vias and layer transitions are preserved.
 */
export function snapCircuitJsonTracesToManhattan(
  circuitJson: AnyCircuitElement[],
): AnyCircuitElement[] {
  return circuitJson.map((el: any) => {
    if (el.type !== "pcb_trace" || !Array.isArray(el.route)) return el

    const snapped = snapTraceRouteToManhattan(el.route)
    return { ...el, route: snapped }
  })
}

function snapTraceRouteToManhattan(route: any[]): any[] {
  const out: any[] = []

  for (let i = 0; i < route.length; i++) {
    const seg = route[i]

    if (seg.route_type === "via") {
      out.push(seg)
      continue
    }

    if (seg.route_type !== "wire") {
      out.push(seg)
      continue
    }

    // Find the next wire on the same layer (stopping at vias)
    let nextWire: any = null
    for (let j = i + 1; j < route.length; j++) {
      const s = route[j]
      if (s.route_type === "via") break
      if (s.route_type === "wire" && s.layer === seg.layer) {
        nextWire = s
        break
      }
    }

    if (!nextWire) {
      out.push(seg)
      continue
    }

    const dx = Math.abs(nextWire.x - seg.x)
    const dy = Math.abs(nextWire.y - seg.y)

    // Already Manhattan
    if (dx < 1e-6 || dy < 1e-6) {
      out.push(seg)
      continue
    }

    // Diagonal — split into L-shape (horizontal first, then vertical)
    out.push({ ...seg })
    out.push({
      ...seg,
      x: nextWire.x,
      y: seg.y,
    })
    out.push({
      ...seg,
      x: nextWire.x,
      y: nextWire.y,
    })
  }

  return out
}

const KICAD_CLEARANCE_MM = 0.25 // 0.2 clearance + 0.05 solder mask expansion

function closestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): { x: number; y: number; t: number } {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 0.000001) return { x: ax, y: ay, t: 0 }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return { x: ax + t * dx, y: ay + t * dy, t }
}

function distToRect(
  rx: number, ry: number, rw: number, rh: number,
  px: number, py: number,
): number {
  const cx = Math.max(rx - rw, Math.min(px, rx + rw))
  const cy = Math.max(ry - rh, Math.min(py, ry + rh))
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2)
}

export function enforceTracePadClearance(
  circuitJson: AnyCircuitElement[],
): AnyCircuitElement[] {
  const smtpads = circuitJson.filter((e: any) => e.type === "pcb_smtpad") as any[]
  const pcbPorts = circuitJson.filter((e: any) => e.type === "pcb_port") as any[]
  const sourceTraces = circuitJson.filter((e: any) => e.type === "source_trace") as any[]
  const sourceNets = circuitJson.filter((e: any) => e.type === "source_net") as any[]

  const portByPcbPortId = new Map(pcbPorts.map((p: any) => [p.pcb_port_id, p]))
  const traceBySrcPortId = new Map<string, any>()
  for (const st of sourceTraces) {
    for (const spId of (st.connected_source_port_ids || [])) {
      traceBySrcPortId.set(spId, st)
    }
  }
  const netIdToName = new Map(sourceNets.map((n: any) => [n.source_net_id, n.name]))

  const padData = smtpads.map((pad: any) => {
    const port = portByPcbPortId.get(pad.pcb_port_id)
    const trace = port?.source_port_id ? traceBySrcPortId.get(port.source_port_id) : null
    const netId = trace?.connected_source_net_ids?.[0] ?? ""
    const netName = netIdToName.get(netId) ?? ""
    return {
      x: pad.x,
      y: pad.y,
      w: (pad.width ?? 0.6) / 2,
      h: (pad.height ?? 0.6) / 2,
      net: netName,
      clearance: KICAD_CLEARANCE_MM,
    }
  })

  return circuitJson.map((el: any) => {
    if (el.type !== "pcb_trace" || !Array.isArray(el.route)) return el
    const traceNetId = el.connection_name ?? ""
    const trackNet = netIdToName.get(traceNetId) ?? traceNetId

    const wires = el.route.filter((s: any) => s.route_type === "wire" && s.layer === "top")
    if (wires.length <= 1) return el

    let totalPushX = 0, totalPushY = 0
    let found = false

    for (let idx = 0; idx < el.route.length; idx++) {
      const seg = el.route[idx]
      if (seg.route_type !== "wire" || seg.layer !== "top") continue

      let nextWire: any = null
      for (let j = idx + 1; j < el.route.length; j++) {
        if (el.route[j].route_type === "via") break
        if (el.route[j].route_type === "wire" && el.route[j].layer === seg.layer) {
          nextWire = el.route[j]
          break
        }
      }

      const sx = seg.x, sy = seg.y
      const ex = nextWire ? nextWire.x : sx
      const ey = nextWire ? nextWire.y : sy
      const halfWidth = (seg.width ?? 0.2) / 2

      const isVert = Math.abs(ex - sx) < 0.001
      const isHoriz = Math.abs(ey - sy) < 0.001
      if (!isVert && !isHoriz) continue

      for (const pad of padData) {
        if (pad.net === trackNet) continue

        const cp = closestPointOnSegment(pad.x, pad.y, sx, sy, ex, ey)
        const cpDist = distToRect(pad.x, pad.y, pad.w, pad.h, cp.x, cp.y)
        const dStart = distToRect(pad.x, pad.y, pad.w, pad.h, sx, sy)
        const minDist = Math.min(cpDist, dStart)
        const requiredDist = halfWidth + pad.clearance

        if (minDist < requiredDist && minDist > 0.0001) {
          const push = requiredDist - minDist
          if (isVert) {
            const pushDir = sx > pad.x ? 1 : -1
            if (!found || Math.abs(push) > Math.abs(totalPushX)) {
              totalPushX = push * pushDir
            } else if (Math.sign(pushDir) === Math.sign(totalPushX)) {
              totalPushX = Math.sign(totalPushX) * Math.max(Math.abs(totalPushX), push)
            }
            found = true
          } else {
            const pushDir = sy > pad.y ? 1 : -1
            if (!found || Math.abs(push) > Math.abs(totalPushY)) {
              totalPushY = push * pushDir
            } else if (Math.sign(pushDir) === Math.sign(totalPushY)) {
              totalPushY = Math.sign(totalPushY) * Math.max(Math.abs(totalPushY), push)
            }
            found = true
          }
        }
      }
    }

    if (!found) return el

    const route = el.route.map((seg: any) => {
      if (seg.route_type !== "wire" || seg.layer !== "top") return seg
      return { ...seg, x: seg.x + totalPushX, y: seg.y + totalPushY }
    })

    return { ...el, route }
  })
}
