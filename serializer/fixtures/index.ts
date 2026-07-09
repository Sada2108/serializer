// Open_Forge — NIR fixture loader (Layer 3).
//
// Typed loaders for the two NIR schema versions consumed by tests:
//   - Libbrecht-Hall fixture (legacy v0.1 schema)
//   - instrumentation_amp_001 fixture (v1.1 schema)
// Plus the shared types the serializer imports for dispatch.

import libbrechtHallNirRaw from "./libbrecht-hall.nir.json"
import instrumentationAmpRaw from "./instrumentation_amp_001.nir.json"

// --------------------------------------------------------------------------- //
// v0.1 (Libbrecht-Hall) — legacy schema
// --------------------------------------------------------------------------- //

export interface NirPlacementNote {
  // free-text placement rule tied to a component/net (Masala-CHAI style)
  text: string
}

export interface NirComponent {
  name: string
  type: string
  [key: string]: unknown
}

export interface NirCircuitJson {
  components: NirComponent[]
  nets?: { name: string; isPowerNet?: boolean; isGroundNet?: boolean }[]
  traces?: { from: string; to: string }[]
}

export interface Nir {
  nir_schema_version: string
  fixture_name: string
  placement_notes: string[]
  datasheet_context: Record<string, unknown>
  circuit_json: NirCircuitJson
}

export const libbrechtHallNir: Nir = libbrechtHallNirRaw as unknown as Nir

// --------------------------------------------------------------------------- //
// v1.1 (instrumentation-amp) — new top-level schema
// --------------------------------------------------------------------------- //

export interface NirV11Component {
  ref: string
  component_id: string
  component_type: string
  footprint: string
  footprint_geometry_ref?: string
  value?: string | null
  manufacturer?: string
  datasheet_confidence?: number
  justification?: string
  position: {
    x_mm: number | null
    y_mm: number | null
    rotation_deg: number | null
  }
  position_confidence?: number
  position_source?: string
  confidence_by_layer?: Record<string, number | null>
}

export interface NirV11Connection {
  ref: string
  pin_name: string
  pin_number: string | number
}

export interface NirV11NetlistEntry {
  net_name: string
  net_type: "power" | "ground" | "analog" | "digital"
  connections: NirV11Connection[]
  source_rule?: string
  net_confidence?: number
}

export interface NirV11PlacementConstraint {
  ref: string
  constraint_type: string
  relative_to: string
  relative_to_type?: string
  max_distance_mm?: number
  hard?: boolean
  source?: string
  confidence?: number
}

export interface NirV11BoardSpec {
  layers: number
  material: string
  thickness_mm: number
  copper_weight_oz?: number
  min_trace_width_mm?: number
  min_clearance_mm?: number
  min_via_drill_mm?: number
  surface_finish?: string
}

export interface NirV11PerformanceSpecs {
  [name: string]: {
    unit: string
    value: number
  }
}

export interface NirV11 {
  schema_version: "1.1"
  design_id: string
  prompt?: string
  design_methodology?: string
  created_at?: string
  pipeline_version?: string
  topology?: string
  components: NirV11Component[]
  netlist: NirV11NetlistEntry[]
  placement_constraints?: NirV11PlacementConstraint[]
  board_spec: NirV11BoardSpec
  performance_specs?: NirV11PerformanceSpecs
  bom?: unknown[]
}

export const instrumentationAmpNir: NirV11 =
  instrumentationAmpRaw as unknown as NirV11
