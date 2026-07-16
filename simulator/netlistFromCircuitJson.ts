// Open_Forge — Circuit JSON to SPICE netlist converter (Layer 4 simulator).
//
// Converts the Circuit JSON shape produced by serializer/serializer.ts's
// serializeNir() into a SPICE netlist string suitable for ngspice.
// Requires the original NIR as a second argument to look up component values
// for the v1.1 schema path (the serializer drops `value` from v1.1's
// source_component_base).
//
// Supported component types (maps NIR component_type -> SPICE prefix):
//   resistor          -> R
//   capacitor         -> C
//   inductor          -> L
//   diode             -> D
//   tvs_diode_array   -> D
//   voltage_reference -> V (behavioral, not modeled)
//   ldo_regulator     -> X (subckt, not modeled)
//   instrumentation_amp -> X (subckt, not modeled)
//   digital_potentiometer -> X (subckt, not modeled)
//   ferrite_bead      -> L (modeled as inductor with R)
//   opamp             -> X (subckt, not modeled)
//   voltage_source    -> V
//   current_source    -> I
//
// For unsupported types (ICs, etc.), we emit a comment and a placeholder
// 1-ohm resistor so the netlist parses but simulation will not be accurate.

export interface NetlistResult {
  netlist: string
  nodeMap: Record<string, number>  // net name -> SPICE node number
  warnings: string[]
}

type AnyCircuitElement = {
  type: string
  [key: string]: unknown
}

type NirV01 = {
  nir_schema_version: string
  circuit_json: {
    components: Array<{
      name: string
      type: string
      [key: string]: unknown
    }>
    nets?: Array<{ name: string; isPowerNet?: boolean; isGroundNet?: boolean }>
    traces?: Array<{ from: string; to: string }>
  }
}

type NirV11 = {
  schema_version: "1.1"
  components: Array<{
    ref: string
    component_type: string
    footprint: string
    value?: string | null
    [key: string]: unknown
  }>
  netlist: Array<{
    net_name: string
    net_type: "power" | "ground" | "analog" | "digital"
    connections: Array<{
      ref: string
      pin_name: string
      pin_number: string | number
    }>
  }>
  [key: string]: unknown
}

type NirInput = NirV01 | NirV11 | Record<string, unknown>

const COMPONENT_TYPE_TO_SPICE_PREFIX: Record<string, string> = {
  resistor: "R",
  capacitor: "C",
  inductor: "L",
  diode: "D",
  tvs_diode_array: "D",
  ferrite_bead: "L",
  voltage_source: "V",
  current_source: "I",
  // ICs - not modeled as primitives
  opamp: "X",
  instrumentation_amp: "X",
  voltage_reference: "X",
  ldo_regulator: "X",
  digital_potentiometer: "X",
  mcu: "X",
  logic: "X",
}

/** Extract component value from v0.1 component (spread onto source_component_base) */
function getValueFromV01Component(comp: AnyCircuitElement): string | null {
  // v0.1 spreads the whole component: resistance, capacitance, voltage, etc.
  if (typeof comp.resistance === "string") return comp.resistance
  if (typeof comp.capacitance === "string") return comp.capacitance
  if (typeof comp.voltage === "string") return comp.voltage
  if (typeof comp.value === "string") return comp.value
  return null
}

/** Extract component value from v1.1 NIR by ref lookup */
function getValueFromV11Nir(nir: NirV11, ref: string): string | null {
  const comp = nir.components.find((c) => c.ref === ref)
  if (comp && typeof comp.value === "string" && comp.value.length > 0) {
    return comp.value
  }
  return null
}

/** Detect NIR schema version */
function detectNirVersion(nir: NirInput): "v0.1" | "v1.1" | "unknown" {
  if (nir && typeof nir === "object") {
    const o = nir as Record<string, unknown>
    if (o["nir_schema_version"] === "0.1" || o["circuit_json"]) return "v0.1"
    if (o["schema_version"] === "1.1" && Array.isArray(o["components"])) return "v1.1"
  }
  return "unknown"
}

/**
 * Convert Circuit JSON + NIR to a SPICE netlist.
 *
 * @param circuitJson - Output from serializeNir() (AnyCircuitElement[])
 * @param nir - Original NIR input to serializeNir() (needed for v1.1 values)
 * @returns NetlistResult with netlist string, node map, and any warnings
 */
export function netlistFromCircuitJson(
  circuitJson: AnyCircuitElement[],
  nir: NirInput,
): NetlistResult {
  const warnings: string[] = []

  // ----------------------------------------------------------------------- //
  // 1. Collect source_component_base elements (the components)
  // ----------------------------------------------------------------------- //
  const components = circuitJson.filter(
    (el) => el.type === "source_component_base",
  ) as AnyCircuitElement[]

  // ----------------------------------------------------------------------- //
  // 2. Collect source_net elements (the nets/nodes)
  // ----------------------------------------------------------------------- //
  const nets = circuitJson.filter(
    (el) => el.type === "source_net",
  ) as AnyCircuitElement[]

  // ----------------------------------------------------------------------- //
  // 3. Collect source_trace elements (connectivity: component pin -> net)
  // ----------------------------------------------------------------------- //
  const traces = circuitJson.filter(
    (el) => el.type === "source_trace",
  ) as AnyCircuitElement[]

  // ----------------------------------------------------------------------- //
  // 4. Assign SPICE node numbers to nets
  //    - Ground nets (is_ground) -> node 0
  //    - Other nets -> sequential integers starting at 1
  // ----------------------------------------------------------------------- //
  const nodeMap: Record<string, number> = {}
  let nextNode = 1

  // First pass: find ground net(s)
  for (const net of nets) {
    const netName = String(net.name ?? net.source_net_id ?? "").replace(/^net_/, "")
    if (net.is_ground === true) {
      nodeMap[netName] = 0
    }
  }

  // Second pass: assign numbers to non-ground nets
  for (const net of nets) {
    const netName = String(net.name ?? net.source_net_id ?? "").replace(/^net_/, "")
    if (!(netName in nodeMap)) {
      nodeMap[netName] = nextNode++
    }
  }

  // Also check for nets referenced in traces but not in source_net list
  for (const trace of traces) {
    for (const netId of (trace.connected_source_net_ids as string[]) ?? []) {
      const netName = netId.replace(/^net_/, "")
      if (!(netName in nodeMap)) {
        // Not a declared power/ground net - assign a node number
        nodeMap[netName] = nextNode++
        warnings.push(`Net '${netName}' referenced in traces but not declared in source_net; assigned node ${nodeMap[netName]}`)
      }
    }
  }

  // ----------------------------------------------------------------------- //
  // 5. Build pin-to-net mapping from traces
  //    trace: connected_source_port_ids like ["R1_source_port_1"]
  //           connected_source_net_ids like ["net_VBAT"]
  // ----------------------------------------------------------------------- //
  // Map: "R1#1" -> netName
  const pinToNet = new Map<string, string>()

  for (const trace of traces) {
    const portIds = (trace.connected_source_port_ids as string[]) ?? []
    const netIds = (trace.connected_source_net_ids as string[]) ?? []
    if (portIds.length === 0 || netIds.length === 0) continue
    const netName = netIds[0].replace(/^net_/, "")
    for (const portId of portIds) {
      // portId format: "R1_source_port_1" -> ref="R1", pin="1"
      const match = portId.match(/^(.+)_source_port_(\d+)$/)
      if (match) {
        const ref = match[1]
        const pin = match[2]
        pinToNet.set(`${ref}#${pin}`, netName)
      }
    }
  }

  // ----------------------------------------------------------------------- //
  // 6. Determine NIR version and value lookup strategy
  // ----------------------------------------------------------------------- //
  const nirVersion = detectNirVersion(nir)
  const isV11 = nirVersion === "v1.1"
  const v11Nir = isV11 ? (nir as NirV11) : null

  // ----------------------------------------------------------------------- //
  // 7. Emit SPICE element lines
  // ----------------------------------------------------------------------- //
  const spiceLines: string[] = []
  const refCounts: Record<string, number> = {}

  // Title line
  spiceLines.push("* Open_Forge generated netlist (from Circuit JSON + NIR)")
  spiceLines.push("")

  for (const comp of components) {
    const ref = String(comp.name ?? "").trim()
    const compType = String(comp.component_type ?? comp.type ?? "").toLowerCase()
    const footprint = String(comp.footprint ?? "").trim()

    if (!ref) {
      warnings.push("Component missing name/ref, skipping")
      continue
    }

    const prefix = COMPONENT_TYPE_TO_SPICE_PREFIX[compType] ?? "X"
    const count = (refCounts[prefix] ?? 0) + 1
    refCounts[prefix] = count
    const spiceRef = `${prefix}${count}`

    // Get value
    let value: string | null = null
    if (isV11 && v11Nir) {
      value = getValueFromV11Nir(v11Nir, ref)
    } else {
      value = getValueFromV01Component(comp)
    }

    // Get connected nets for this component's pins
    // We need to know how many pins and which net each pin connects to
    // For discretes (2-pin), pins are 1 and 2
    // For ICs, we'd need pin mapping - but we don't model ICs as primitives

    const pin1Net = pinToNet.get(`${ref}#1`) ?? pinToNet.get(`${ref}#${ref}#1`) ?? "0"
    const pin2Net = pinToNet.get(`${ref}#2`) ?? pinToNet.get(`${ref}#${ref}#2`) ?? "0"

    const node1 = nodeMap[pin1Net] ?? 0
    const node2 = nodeMap[pin2Net] ?? 0

    // Emit based on component type
    switch (compType) {
      case "resistor": {
        const rval = value ?? "1k"
        spiceLines.push(`${spiceRef} ${node1} ${node2} ${rval}`)
        break
      }
      case "capacitor": {
        const cval = value ?? "1u"
        spiceLines.push(`${spiceRef} ${node1} ${node2} ${cval}`)
        break
      }
      case "inductor":
      case "ferrite_bead": {
        const lval = value ?? "1u"
        // Ferrite bead: model as inductor with series resistance
        if (compType === "ferrite_bead") {
          spiceLines.push(`${spiceRef} ${node1} ${node2} ${lval}`)
          spiceLines.push(`R${spiceRef}_esr ${node2} ${node2}_int 0.1`)
          spiceLines.push(`* Ferrite bead ${ref} modeled as L + series R`)
        } else {
          spiceLines.push(`${spiceRef} ${node1} ${node2} ${lval}`)
        }
        break
      }
      case "diode":
      case "tvs_diode_array": {
        // Simple diode model - would need .model card for real simulation
        spiceLines.push(`${spiceRef} ${node1} ${node2} DMOD`)
        spiceLines.push(`* Diode ${ref} - add .model DMOD D(Is=1e-14 N=1) for simulation`)
        break
      }
      case "voltage_source": {
        const vval = value ?? "1"
        spiceLines.push(`${spiceRef} ${node1} ${node2} DC ${vval}`)
        break
      }
      case "current_source": {
        const ival = value ?? "1m"
        spiceLines.push(`${spiceRef} ${node1} ${node2} DC ${ival}`)
        break
      }
      default: {
        // IC or unsupported - emit placeholder + warning
        warnings.push(`Component ${ref} (${compType}) not modeled as SPICE primitive; emitting 1-ohm placeholder`)
        spiceLines.push(`* ${ref} (${compType}) - NOT MODELED, placeholder only`)
        spiceLines.push(`R${spiceRef}_placeholder ${node1} ${node2} 1`)
        break
      }
    }
  }

  // ----------------------------------------------------------------------- //
  // 8. Add common simulation commands
  // ----------------------------------------------------------------------- //
  spiceLines.push("")
  spiceLines.push("* --- Simulation commands (user should customize) ---")
  spiceLines.push(".op")
  spiceLines.push(".tran 1m 10m")
  spiceLines.push(".end")

  return {
    netlist: spiceLines.join("\n"),
    nodeMap,
    warnings,
  }
}