// Serializer — Circuit JSON to SPICE netlist converter (Layer 4 simulator).
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
//   simulation_source -> V (SPICE PULSE source; pulse_* params from NIR)
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
  schema_version: string
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
  simulation_source: "V",
  // ICs - not modeled as primitives
  opamp: "X",
  instrumentation_amp: "X",
  voltage_reference: "X",
  ldo_regulator: "X",
  digital_potentiometer: "X",
  mcu: "X",
  logic: "X",
  // v1.1 ftype variants
  simple_resistor: "R",
  simple_capacitor: "C",
  simple_inductor: "L",
  simple_diode: "D",
  simple_chip: "X",
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

function getAcMagnitudeFromV11Nir(nir: NirV11, ref: string): string | null {
  const comp = nir.components.find((c) => c.ref === ref)
  if (comp && typeof comp.ac_magnitude === "string" && comp.ac_magnitude.length > 0) {
    return comp.ac_magnitude
  }
  return null
}

type PulseParamKey =
  | "pulse_v1"
  | "pulse_v2"
  | "pulse_td"
  | "pulse_tr"
  | "pulse_tf"
  | "pulse_pw"
  | "pulse_per"

type PulseParams = Record<PulseParamKey, string | null>

const PULSE_PARAM_KEYS: PulseParamKey[] = [
  "pulse_v1",
  "pulse_v2",
  "pulse_td",
  "pulse_tr",
  "pulse_tf",
  "pulse_pw",
  "pulse_per",
]

/** Extract PULSE(V1 V2 TD TR TF PW PER) params from v1.1 NIR simulation_source */
function getPulseParamsFromV11Nir(nir: NirV11, ref: string): PulseParams | null {
  const comp = nir.components.find((c) => c.ref === ref)
  if (!comp) return null
  const out = {} as PulseParams
  let found = false
  for (const key of PULSE_PARAM_KEYS) {
    const v = comp[key]
    out[key] = typeof v === "string" && v.length > 0 ? v : null
    if (out[key] !== null) found = true
  }
  return found ? out : null
}

/** Detect NIR schema version */
function detectNirVersion(nir: NirInput): "v0.1" | "v1.1" | "unknown" {
  if (nir && typeof nir === "object") {
    const o = nir as Record<string, unknown>
    if (o["nir_schema_version"] === "0.1" || o["circuit_json"]) return "v0.1"
    if ((o["schema_version"] === "1.1" || o["schema_version"] === "1.2") && Array.isArray(o["components"])) return "v1.1"
  }
  return "unknown"
}

export interface NetlistResult {
  netlist: string
  nodeMap: Record<string, number>
  warnings: string[]
}

export interface DcSweepConfig {
  sourceName: string
  start: number
  stop: number
  step: number
}

/**
 * Convert Circuit JSON + NIR to a SPICE netlist.
 *
 * @param circuitJson - Output from serializeNir() (AnyCircuitElement[])
 * @param nir - Original NIR input to serializeNir() (needed for v1.1 values)
 * @param opts - Optional: analysisType ("tran"|"op"|"dc"|"ac"|"fft"), dcSweep config
 * @returns NetlistResult with netlist string, node map, and any warnings
 */
export function netlistFromCircuitJson(
  circuitJson: AnyCircuitElement[],
  nir: NirInput,
  opts?: { analysisType?: "tran" | "op" | "dc" | "ac" | "fft"; dcSweep?: DcSweepConfig; timeStep?: string; duration?: string },
): NetlistResult {
  const warnings: string[] = []

  // ----------------------------------------------------------------------- //
  // 1. Collect components (source_component_base for v0.1, source_component
  //    for v1.1)
  // ----------------------------------------------------------------------- //
  const components = circuitJson.filter(
    (el) => el.type === "source_component_base" || el.type === "source_component",
  ) as AnyCircuitElement[]

  // ----------------------------------------------------------------------- //
  // 2. Collect source_net elements (the nets/nodes)
  // ----------------------------------------------------------------------- //
  const nets = circuitJson.filter(
    (el) => el.type === "source_net",
  ) as AnyCircuitElement[]

  // Build source_net_id -> name lookup (v1.1 uses source_net_id, name is
  // the human-readable label)
  const netIdToName = new Map<string, string>()
  for (const net of nets) {
    const id = String(net.source_net_id ?? "")
    const name = String(net.name ?? net.source_net_id ?? "").replace(/^net_/, "")
    if (id) netIdToName.set(id, name)
  }

  // ----------------------------------------------------------------------- //
  // 3. Collect source_trace elements (connectivity: component pin -> net)
  // ----------------------------------------------------------------------- //
  const traces = circuitJson.filter(
    (el) => el.type === "source_trace",
  ) as AnyCircuitElement[]

  // ----------------------------------------------------------------------- //
  // 4. Collect source_port elements (port metadata: which component + pin)
  // ----------------------------------------------------------------------- //
  const portElements = circuitJson.filter(
    (el) => el.type === "source_port",
  ) as AnyCircuitElement[]

  // Build source_port_id -> { ref, pin_number } lookup
  const portToRefPin = new Map<string, { ref: string; pin: string }>()
  const compIdToRef = new Map<string, string>()
  for (const comp of components) {
    const id = String(comp.source_component_id ?? "")
    const ref = String(comp.name ?? "").trim()
    if (id && ref) compIdToRef.set(id, ref)
  }
  for (const port of portElements) {
    const portId = String(port.source_port_id ?? "")
    const compId = String(port.source_component_id ?? "")
    const ref = compIdToRef.get(compId) ?? ""
    const pin = String(port.pin_number ?? "")
    if (portId && ref && pin) {
      portToRefPin.set(portId, { ref, pin })
    }
  }

  // ----------------------------------------------------------------------- //
  // 5. Assign SPICE node numbers to nets
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
      const netName = netIdToName.get(netId) ?? netId.replace(/^net_/, "")
      if (!(netName in nodeMap)) {
        // Not a declared power/ground net - assign a node number
        nodeMap[netName] = nextNode++
        warnings.push(`Net '${netName}' referenced in traces but not declared in source_net; assigned node ${nodeMap[netName]}`)
      }
    }
  }

  // ----------------------------------------------------------------------- //
  // 6. Build pin-to-net mapping from traces
  //    v0.1 portId format: "R1_source_port_1" -> ref="R1", pin="1"
  //    v1.1 portId format: "source_port_14"   -> lookup via source_port element
  // ----------------------------------------------------------------------- //
  // Map: "R1#1" -> netName
  const pinToNet = new Map<string, string>()

  for (const trace of traces) {
    const portIds = (trace.connected_source_port_ids as string[]) ?? []
    const netIds = (trace.connected_source_net_ids as string[]) ?? []
    if (portIds.length === 0 || netIds.length === 0) continue
    const netName = netIdToName.get(netIds[0]) ?? netIds[0].replace(/^net_/, "")
    for (const portId of portIds) {
      // Try v0.1 format first: "R1_source_port_1"
      const v01Match = portId.match(/^(.+)_source_port_(\d+)$/)
      if (v01Match) {
        const ref = v01Match[1]
        const pin = v01Match[2]
        pinToNet.set(`${ref}#${pin}`, netName)
        continue
      }
      // Try v1.1 format: lookup via source_port element
      const resolved = portToRefPin.get(portId)
      if (resolved) {
        pinToNet.set(`${resolved.ref}#${resolved.pin}`, netName)
      }
    }
  }

  // ----------------------------------------------------------------------- //
  // 6. Determine NIR version and value lookup strategy
  // ----------------------------------------------------------------------- //
  const nirVersion = detectNirVersion(nir)
  const isV11 = nirVersion === "v1.1"
  const v11Nir = isV11 ? (nir as NirV11) : null

  // v1.1 NIR ref -> component_type lookup (tscircuit may squash to "simple_chip")
  const nirCompTypeByRef = new Map<string, string>()
  if (v11Nir) {
    for (const c of v11Nir.components) {
      if (c.ref && c.component_type) {
        nirCompTypeByRef.set(c.ref, c.component_type.toLowerCase())
      }
    }
  }

  // ----------------------------------------------------------------------- //
  // 7. Emit SPICE element lines
  // ----------------------------------------------------------------------- //
  const spiceLines: string[] = []
  const refCounts: Record<string, number> = {}
  const analysisType = opts?.analysisType ?? "tran"

  // Title line
  spiceLines.push("* Serializer generated netlist (from Circuit JSON + NIR)")
  spiceLines.push("")

  for (const comp of components) {
    const ref = String(comp.name ?? "").trim()
    let compType = String(
      comp.component_type ?? comp.ftype ?? "",
    ).toLowerCase()

    // Infer type from properties for v0.1 source_component_base elements
    if (!compType) {
      if (comp.resistance != null) compType = "resistor"
      else if (comp.capacitance != null) compType = "capacitor"
      else if (comp.inductance != null) compType = "inductor"
      else if (comp.voltage != null && String(comp.name ?? "").startsWith("V")) compType = "voltage_source"
      else compType = String(comp.type ?? "").toLowerCase()
    }

    // v1.1 override: tscircuit may squash everything to "simple_chip", but the
    // NIR's component_type carries the real role (voltage_source, resistor, etc.)
    if (isV11 && ref) {
      const nirType = nirCompTypeByRef.get(ref)
      if (nirType) compType = nirType
    }

    const footprint = String(comp.footprint ?? "").trim()

    if (!ref) {
      warnings.push("Component missing name/ref, skipping")
      continue
    }

    const prefix = COMPONENT_TYPE_TO_SPICE_PREFIX[compType] ?? "X"
    const count = (refCounts[prefix] ?? 0) + 1
    refCounts[prefix] = count
    const spiceRef = `${prefix}${count}`

    // Get value: try source_component properties first (v1.1 ftype components
    // carry resistance/capacitance directly), then v1.1 NIR lookup, then v0.1
    let value: string | null = getValueFromV01Component(comp)
    if (!value && isV11 && v11Nir) {
      value = getValueFromV11Nir(v11Nir, ref)
    }

    // Get AC magnitude from NIR (only meaningful for AC analysis)
    let acMag: string | null = null
    if (isV11 && v11Nir) {
      acMag = getAcMagnitudeFromV11Nir(v11Nir, ref)
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
      case "resistor":
      case "simple_resistor": {
        const rval = value ?? "1k"
        spiceLines.push(`${spiceRef} ${node1} ${node2} ${rval}`)
        break
      }
      case "capacitor":
      case "simple_capacitor": {
        const cval = value ?? "1u"
        spiceLines.push(`${spiceRef} ${node1} ${node2} ${cval}`)
        break
      }
      case "inductor":
      case "simple_inductor":
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
      case "simple_diode":
      case "tvs_diode_array": {
        // Simple diode model - would need .model card for real simulation
        spiceLines.push(`${spiceRef} ${node1} ${node2} DMOD`)
        spiceLines.push(`* Diode ${ref} - add .model DMOD D(Is=1e-14 N=1) for simulation`)
        break
      }
      case "voltage_source": {
        const vval = value ?? "1"
        if (analysisType === "ac") {
          const acVal = acMag ?? "1"
          spiceLines.push(`${spiceRef} ${node1} ${node2} DC ${vval} AC ${acVal}`)
        } else if (analysisType === "fft") {
          // SIN source for FFT: SIN(0 <amplitude> <freq>)
          spiceLines.push(`${spiceRef} ${node1} ${node2} SIN(0 ${vval} 1k)`)
        } else if (analysisType === "tran") {
          spiceLines.push(`${spiceRef} ${node1} ${node2} PULSE(0 ${vval} 0 1n 1n 10m 20m)`)
        } else {
          spiceLines.push(`${spiceRef} ${node1} ${node2} DC ${vval}`)
        }
        break
      }
      case "current_source": {
        const ival = value ?? "1m"
        spiceLines.push(`${spiceRef} ${node1} ${node2} DC ${ival}`)
        break
      }
      case "simulation_source": {
        // SPICE PULSE source: V<ref> <node+> <node-> PULSE(V1 V2 TD TR TF PW PER)
        // Params come from the NIR (pulse_* fields). Omitted ones fall back to
        // the analysis window actually emitted by the .tran command below:
        //   TR/TF -> timeStep, PW/PER -> duration
        // (ngspice PULSE defaults are the transient TSTEP/TSTOP). Never emit a
        // silent 0 for these — empirically on ngspice-46, PER=0 yields a
        // 2*TSTEP period and PW=0 with an explicit period leaves the source
        // flat at V1. V1/TD keep their safe SPICE defaults of 0.
        const pulse = isV11 && v11Nir ? getPulseParamsFromV11Nir(v11Nir, ref) : null
        const effectiveTimeStep = opts?.timeStep ?? (analysisType === "fft" ? "10u" : "1m")
        const effectiveDuration = opts?.duration ?? "10m"
        if (!pulse) {
          warnings.push(
            `Component ${ref} (simulation_source) has no PULSE parameters in NIR; ` +
            `using V1/TD=0, TR/TF=${effectiveTimeStep}, PW/PER=${effectiveDuration}`,
          )
        } else {
          for (const key of ["pulse_v2", "pulse_tr", "pulse_tf", "pulse_pw", "pulse_per"] as const) {
            if (!pulse[key]) {
              const fallback =
                key === "pulse_v2"
                  ? "0"
                  : key === "pulse_tr" || key === "pulse_tf"
                    ? effectiveTimeStep
                    : effectiveDuration
              warnings.push(
                `Component ${ref} (simulation_source) missing ${key} — using fallback ${fallback}`,
              )
            }
          }
          if ((!pulse.pulse_tr || !pulse.pulse_tf) && opts?.timeStep === undefined) {
            warnings.push(
              `Component ${ref} (simulation_source) has no analysis timeStep in opts; ` +
                `TR/TF use hard fallback ${effectiveTimeStep}`,
            )
          }
          if ((!pulse.pulse_pw || !pulse.pulse_per) && opts?.duration === undefined) {
            warnings.push(
              `Component ${ref} (simulation_source) has no analysis duration in opts; ` +
                `PW/PER use hard fallback ${effectiveDuration}`,
            )
          }
        }
        const pv1 = pulse?.pulse_v1 ?? "0"
        const pv2 = pulse?.pulse_v2 ?? "0"
        const ptd = pulse?.pulse_td ?? "0"
        const ptr = pulse?.pulse_tr ?? effectiveTimeStep
        const ptf = pulse?.pulse_tf ?? effectiveTimeStep
        const ppw = pulse?.pulse_pw ?? effectiveDuration
        const pper = pulse?.pulse_per ?? effectiveDuration
        if (analysisType === "ac") {
          const acVal = acMag ?? "1"
          spiceLines.push(`${spiceRef} ${node1} ${node2} DC ${pv1} AC ${acVal}`)
        } else if (analysisType === "op" || analysisType === "dc") {
          spiceLines.push(`${spiceRef} ${node1} ${node2} DC ${pv1}`)
        } else {
          // tran and fft both drive a transient, so the source stays PULSE
          spiceLines.push(
            `${spiceRef} ${node1} ${node2} PULSE(${pv1} ${pv2} ${ptd} ${ptr} ${ptf} ${ppw} ${pper})`,
          )
        }
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
  // 8. Emit implicit voltage sources for power/signal nets that lack one
  //    Many NIRs (especially v1.1) represent VCC/GND/VIN as nets rather
  //    than explicit voltage_source components.  For simulation to work we
  //    need V-elements driving those nets.  Emit a warning when the actual
  //    voltage value is unknown — never fabricate a silent placeholder.
  // ----------------------------------------------------------------------- //
  const groundNets = new Set<string>()
  for (const net of nets) {
    if (net.is_ground === true) {
      groundNets.add(String(net.name ?? net.source_net_id ?? "").replace(/^net_/, ""))
    }
  }
  // The canonical ground name (GND or the first ground net found)
  const gndName = groundNets.size > 0 ? [...groundNets][0] : "GND"
  if (!(gndName in nodeMap)) {
    nodeMap[gndName] = 0
  }

  // Reverse map: SPICE node number -> net name (for matching emitted V-lines
  // back to the nets they drive; nodeMap maps net name -> node number).
  const nodeToNet: Record<string, string> = {}
  for (const [netName, node] of Object.entries(nodeMap)) {
    nodeToNet[String(node)] = netName
  }

  // Track which nets already have a V-element driving them
  const netsWithVoltageSource = new Set<string>()
  for (const line of spiceLines) {
    // Match V<n> <node+> <node-> DC <val>  or  V<n> <node+> <node-> <val>
    // The captured node is a number; resolve it back to its net name so the
    // implicit-source heuristic below can skip nets already driven by a
    // real V-element (e.g. simulation_source PULSE sources).
    const vMatch = line.match(/^V\d+\s+(\S+)\s+(\S+)/)
    if (vMatch) {
      netsWithVoltageSource.add(nodeToNet[vMatch[1]] ?? vMatch[1])
    }
  }

  let implicitVCount = (refCounts["V"] ?? 0)

  // Only add implicit voltage sources for genuine external inputs and supply
  // rails.  Internal circuit nodes (feedback, coupling caps, reference
  // dividers, op-amp outputs) must NEVER get voltage sources — doing so
  // would short the output and break simulation.
  //
  // Heuristic for v1.1 NIR:
  //   1. Net connects to an *input* header/connector → external stimulus
  //   2. Net connects to an IC power pin (VCC/VDD/V+/VEE) → supply rail
  //   3. Everything else → do NOT add a source; emit a warning if ambiguous
  //
  // For v0.1: fall back to is_power flag on source_net elements.
  const IC_POWER_PIN_RE = /^(VCC|VDD|V\+|VEE|V-|VS\+|VS-|AVCC|DVCC|PVCC)/i
  const INPUT_HEADER_RE = /input_header|signal_gen|function_gen|pulse_source|voltage_source/i
  const OUTPUT_HEADER_RE = /output_header|probe|measure/i

  if (v11Nir) {
    for (const entry of v11Nir.netlist) {
      const netName = entry.net_name
      if (groundNets.has(netName)) continue
      if (netsWithVoltageSource.has(netName)) continue
      const nodePos = nodeMap[netName] ?? 0
      if (nodePos === 0) continue

      const connectsToInputHeader = entry.connections.some(
        (c) => INPUT_HEADER_RE.test(c.ref),
      )
      const connectsToOutputHeader = entry.connections.some(
        (c) => OUTPUT_HEADER_RE.test(c.ref),
      )
      const connectsToIcPowerPin = entry.connections.some(
        (c) => IC_POWER_PIN_RE.test(c.pin_name),
      )

      if (connectsToInputHeader) {
        // External input signal — needs a driving voltage source
        implicitVCount++
        const spiceRef = `V${implicitVCount}`
        warnings.push(
          `Input net '${netName}' (connected to external source) has no explicit voltage source; ` +
          `emitting ${spiceRef} with UNKNOWN voltage — set the correct value before simulating`,
        )
        spiceLines.push(`* WARNING: ${spiceRef} voltage is unknown — set before simulating`)
        spiceLines.push(`${spiceRef} ${nodePos} 0 DC 0`)
      } else if (connectsToIcPowerPin && !connectsToOutputHeader) {
        // Supply rail driving IC power pins — needs a voltage source
        implicitVCount++
        const spiceRef = `V${implicitVCount}`
        warnings.push(
          `Supply net '${netName}' (feeding IC power pin) has no explicit voltage source; ` +
          `emitting ${spiceRef} with UNKNOWN voltage — set the correct value before simulating`,
        )
        spiceLines.push(`* WARNING: ${spiceRef} voltage is unknown — set before simulating`)
        spiceLines.push(`${spiceRef} ${nodePos} 0 DC 0`)
      } else if (connectsToOutputHeader) {
        // Output net — driven by the circuit, never add a source
        warnings.push(
          `Output net '${netName}' is driven by the circuit — no voltage source added`,
        )
      }
      // All other nets (internal nodes) — silently skipped, no source needed
    }
  } else {
    // v0.1 fallback: emit sources for power nets (is_power && !is_ground)
    // that also connect to an IC power pin or header
    for (const net of nets) {
      const netName = String(net.name ?? net.source_net_id ?? "").replace(/^net_/, "")
      if (net.is_ground === true) continue
      if (net.is_power !== true) continue
      if (netsWithVoltageSource.has(netName)) continue
      const nodePos = nodeMap[netName] ?? 0
      if (nodePos === 0) continue
      implicitVCount++
      const spiceRef = `V${implicitVCount}`
      warnings.push(
        `Power net '${netName}' has no explicit voltage source; ` +
        `emitting ${spiceRef} with UNKNOWN voltage — set the correct value before simulating`,
      )
      spiceLines.push(`* WARNING: ${spiceRef} voltage is unknown — set before simulating`)
      spiceLines.push(`${spiceRef} ${nodePos} 0 DC 0`)
    }
  }

  // ----------------------------------------------------------------------- //
  // 9. Add simulation commands based on analysis type
  // ----------------------------------------------------------------------- //
  spiceLines.push("")
  spiceLines.push("* --- Simulation commands ---")

  switch (analysisType) {
    case "op":
      spiceLines.push(".op")
      break
    case "dc": {
      const dc = opts?.dcSweep
      if (dc) {
        spiceLines.push(`.dc ${dc.sourceName} ${dc.start} ${dc.stop} ${dc.step}`)
      } else {
        const firstVSource = spiceLines.find(l => l.startsWith("V"))
        const vName = firstVSource ? firstVSource.split(/\s/)[0] : "V1"
        spiceLines.push(`.dc ${vName} 0 10 0.1`)
      }
      break
    }
    case "ac":
      spiceLines.push(".ac dec 10 1 1meg")
      break
    case "fft": {
      // FFT needs a transient simulation first, then .four analysis
      // Use SIN source for periodic signal (set in voltage_source case)
      spiceLines.push(`.tran ${opts?.timeStep ?? "10u"} ${opts?.duration ?? "10m"}`)
      // .four <freq> <var> — fundamental freq = 1kHz, analyze v(2)
      spiceLines.push(".four 1k v(2)")
      break
    }
    case "tran":
    default:
      spiceLines.push(`.tran ${opts?.timeStep ?? "1m"} ${opts?.duration ?? "10m"}`)
      break
  }
  spiceLines.push(".end")

  return {
    netlist: spiceLines.join("\n"),
    nodeMap,
    warnings,
  }
}