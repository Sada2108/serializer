// Serializer — NIR fixture loader (Layer 3).
//
// Typed loaders for the two NIR schema versions consumed by tests:
//   - Libbrecht-Hall fixture (legacy v0.1 schema)
//   - instrumentation_amp_001 fixture (v1.1 schema)
// Plus the shared types the serializer imports for dispatch.

import libbrechtHallNirRaw from "./libbrecht-hall.nir.json"
import instrumentationAmpRaw from "./instrumentation_amp_001.nir.json"
import opampNoninvNirJson from "./opamp_noninv_001.nir.json"
import voltageDividerNirJson from "./voltage_divider_001.nir.json"
import rcLowpassNirJson from "./rc_lowpass_001.nir.json"
import rcLowpassAcNirJson from "./rc_lowpass_ac_001.nir.json"
import rcLowpassFftNirJson from "./rc_lowpass_fft_001.nir.json"
import lm358NoninvNirJson from "./lm358_noninv_001.nir.json"
import layer2mockschemaNirJson from "./layer2mockschema.nir.json"
import audioAmplifier1386NirJson from "./audio_amplifier_1386.nir.json"
import audioAmplifierLm386NirJson from "./audioamplifier_lm386.nir.json"
import timer555NirJson from "./555_timer.nir.json"
import astraComputerNirJson from "./astracomputer.nir.json"
export const opampNoninvNir = opampNoninvNirJson
export const voltageDividerNir = voltageDividerNirJson
export const rcLowpassNir = rcLowpassNirJson
export const rcLowpassAcNir = rcLowpassAcNirJson
export const rcLowpassFftNir = rcLowpassFftNirJson
export const lm358NoninvNir = lm358NoninvNirJson
export const timer555Nir = timer555NirJson
export const astraComputerNir = astraComputerNirJson as unknown as NirV11
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
// v1.1/v1.2 (instrumentation) — new top-level schema
// --------------------------------------------------------------------------- //

// Shared component/net/board shapes. v1.2 (schema_version "1.2") is additive
// over v1.1: new `_NEW_*` sections and per-entity fields are all optional so
// both versions dispatch through the same parse path. Unknown top-level keys
// are tolerated so future pass-through fields (e.g. `custom_symbols_required`,
// `hierarchical_sheets`) can land without type churn.

// A single real pad lifted from a source .kicad_pcb footprint definition
// (position/rotation are in KiCad's native pad-local frame — see the usage
// site in serializer.ts's generateInlineFootprintJsx for the sign/axis
// convention notes). Used to build an inline tscircuit <footprint> for
// components whose footprint string is a project-custom KiCad library
// ("Library:...", or a custom "Sensors:..." path) that will never resolve
// against kicad-mod-cache.tscircuit.com.
export interface NirV11FootprintPad {
  pin: string
  type: "smd" | "thru_hole"
  shape: string
  x_mm: number
  y_mm: number
  rotation_deg?: number
  width_mm: number
  height_mm: number
  drill_mm?: number
  _note?: string
}

export interface NirV11Component {
  [key: string]: unknown
  ref: string
  component_id: string
  component_type: string
  footprint: string
  footprint_geometry_ref?: string
  // Real pad geometry extracted from a source .kicad_pcb, for footprints
  // that aren't resolvable through kicad-mod-cache.tscircuit.com (see
  // NirV11FootprintPad doc comment). Optional — most components rely on the
  // plain `footprint` string + KNOWN_PACKAGE_PIN_COUNTS instead.
  custom_footprint_pads?: NirV11FootprintPad[]
  value?: string | null
  ac_magnitude?: string | null
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
  _NEW_courtyard_mm?: {
    x: number
    y: number
    note?: string
  }
  _NEW_thermal_relief_required?: boolean
  // simulation_source (VPULSE) PULSE parameters — mirrored 1:1 from the SPICE
  // PULSE(V1 V2 TD TR TF PW PER) argument list. All optional: the netlist
  // emitter falls back to SPICE's documented defaults for omitted fields.
  pulse_v1?: string | null
  pulse_v2?: string | null
  pulse_td?: string | null
  pulse_tr?: string | null
  pulse_tf?: string | null
  pulse_pw?: string | null
  pulse_per?: string | null
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
  _NEW_controlled_impedance?: {
    type: string
    target_ohms: number | null
    note?: string
  } | null
  _NEW_routing_priority_tier?: number
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
  _NEW_stackup_arrangement?: string
  _NEW_prepreg_core_note?: string
  _NEW_annular_ring_min_mm?: number
}

export interface NirV11PerformanceSpecs {
  // v1.2 spec entries have heterogeneous shapes (value / at_1kHz / min+max /
  // at_230uA_total), so each entry is loosely typed rather than pinned to
  // { unit; value }.
  [name: string]: Record<string, unknown> & {
    unit?: string
  }
}

export interface NirV11 {
  schema_version: "1.1" | "1.2"
  design_id: string
  prompt?: string
  design_methodology?: string | Record<string, unknown>
  created_at?: string
  pipeline_version?: string
  topology?: string
  components: NirV11Component[]
  netlist: NirV11NetlistEntry[]
  placement_constraints?: NirV11PlacementConstraint[]
  board_spec: NirV11BoardSpec
  performance_specs?: NirV11PerformanceSpecs
  bom?: unknown[]
  [key: string]: unknown
}

export const instrumentationAmpNir: NirV11 =
  instrumentationAmpRaw as unknown as NirV11

export const layer2mockschemaNir: NirV11 =
  layer2mockschemaNirJson as unknown as NirV11

export const audioAmplifier1386Nir: NirV11 =
  audioAmplifier1386NirJson as unknown as NirV11

export const audioAmplifierLm386Nir: NirV11 =
  audioAmplifierLm386NirJson as unknown as NirV11
