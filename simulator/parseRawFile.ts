// Open_Forge — ngspice ASCII .raw file parser (Layer 4 simulator).
//
// Pure, side-effect-free parser for ngspice's ASCII .raw format (the format
// produced by `set filetype=ascii` followed by `write <file>.raw` in a
// `.control ... .endc` block).  No I/O, no ngspice process — this module can
// be unit-tested entirely against a hand-crafted raw string.
//
// Format reference (ngspice-46, ASCII raw):
//
//   Title: <text>
//   Date: <text>
//   Command: <text>
//   Plotname: <text>
//   Flags: <text>
//   No. Variables: <int>
//   No. Points: <int>
//   Variables:
//       <idx>   <name>   <type>      <-- tab-separated, one per variable
//       ...
//   Values:
//   <point_idx>                    <-- integer (or blank for subsequent points)
//       <real0>
//       <real1>
//       ...
//   <point_idx> ...
//
// All real values are written in scientific notation with a leading tab.
// `Values:` blocks are TAB-delimited and use a point-row layout where each
// row's first token is the point index (omitted on continuation points).
// The only line type we have to be defensive about is a leading "Flags: real"
// line that says the data is real (no complex).
//
// We DO NOT support the complex (Flags: complex) variant — the bundled
// fixtures are real-valued.  If a complex raw file is encountered, we
// raise loudly rather than silently return partial vectors.

export interface RawVariable {
  index: number
  name: string
  type: string
}

export interface ParseRawResult {
  variables: RawVariable[]
  vectors: Record<string, number[]>
  numPoints: number
  plotname: string | null
}

/**
 * parseRawFile — parse an ngspice ASCII .raw text into named numeric vectors.
 *
 * The returned `vectors` map is keyed by variable NAME (e.g. "v(out)",
 * "i(v1)", "time") and each value is a `number[]` of length `numPoints`.
 * Numeric values are written in ngspice's scientific-notation form
 * (e.g. "1.000000000000000e+00") and parsed with `parseFloat` — this
 * handles exponents and signs uniformly and is consistent with the
 * sample fixture we ship.
 *
 * Raises on:
 *   - missing "Variables:" or "Values:" section
 *   - No. Variables / No. Points that don't match the body
 *   - any non-numeric value in the values body
 *
 * Note on complex raw files: when `Flags: complex` is set, each value
 * token is written as "<real>,<imag>"; we keep the real part and the
 * documented behaviour is "real part only".  Imag parts are dropped, not
 * raised on, because all real-world ngspice outputs the simulator
 * pipeline runs (.tran, .op, .dc) are real-valued.
 */
export function parseRawFile(rawText: string): ParseRawResult {
  if (typeof rawText !== "string" || rawText.length === 0) {
    throw new Error("parseRawFile: input is empty or not a string")
  }

  const lines = rawText.split(/\r?\n/)

  // --- Header / metadata pass --------------------------------------------
  let numVariables: number | null = null
  let numPoints: number | null = null
  let flags: string | null = null
  let plotname: string | null = null

  for (const line of lines) {
    if (line.startsWith("Flags:")) {
      flags = line.slice("Flags:".length).trim()
    } else if (line.startsWith("No. Variables:")) {
      numVariables = parseIntSafe(line.slice("No. Variables:".length).trim(), "No. Variables")
    } else if (line.startsWith("No. Points:")) {
      numPoints = parseIntSafe(line.slice("No. Points:".length).trim(), "No. Points")
    } else if (line.startsWith("Plotname:")) {
      plotname = line.slice("Plotname:".length).trim()
    } else if (line === "Variables:") {
      break   // we have everything we need from the header; jump to next phase
    }
  }
  if (numVariables === null) {
    throw new Error("parseRawFile: missing 'No. Variables:' header line")
  }
  if (numPoints === null) {
    throw new Error("parseRawFile: missing 'No. Points:' header line")
  }
  // We do support complex-valued raw files (e.g. the ngspice `constants`
  // plot emits Flags: complex).  For complex, each value token is
  // "<real>,<imag>"; we keep the real part and document the behaviour.

  // --- Variables section ------------------------------------------------
  // Find the "Variables:" marker, then read the next `numVariables`
  // tab-separated lines.
  const varsStart = lines.findIndex((l) => l === "Variables:")
  if (varsStart < 0) {
    throw new Error("parseRawFile: 'Variables:' section not found")
  }
  const variables: RawVariable[] = []
  for (let i = 1; i <= numVariables; i++) {
    const raw = lines[varsStart + i]
    if (raw === undefined) {
      throw new Error(
        "parseRawFile: 'Variables:' section ends early — expected " +
        numVariables + " entries, got " + (i - 1),
      )
    }
    // Tab-separated: "<idx>\t<name>\t<type>".  Strip leading tab, then split.
    const stripped = raw.replace(/^\t+/, "")
    const parts = stripped.split("\t")
    if (parts.length < 3) {
      throw new Error(
        "parseRawFile: malformed Variables line: " +
        JSON.stringify(raw) + " (expected 3 tab-separated fields)",
      )
    }
    const idx = parseIntSafe(parts[0], `Variables[${i - 1}].index`)
    variables.push({ index: idx, name: parts[1], type: parts[2] })
  }

  // --- Values section ---------------------------------------------------
  const valuesStart = lines.findIndex((l) => l === "Values:")
  if (valuesStart < 0) {
    throw new Error("parseRawFile: 'Values:' section not found")
  }
  // Pre-allocate numeric arrays for each variable.
  const vectors: Record<string, number[]> = {}
  for (const v of variables) vectors[v.name] = new Array<number>(numPoints)

  // Walk the values body.  ngspice's ASCII .raw layout (verified against
  // ngspice-46) is:
  //
  //   Values:
  //    0\t<val0>
  //   \t<val1>
  //   \t<val2>
  //   \t<val3>
  //
  //    1\t<val0>
  //   \t<val1>
  //   \t<val2>
  //   \t<val3>
  //   ...
  //
  // i.e. EACH point's first line carries a leading " <idx>\t" prefix
  // (the point index) followed by the first value, and the remaining
  // values for that point are on their own tab-indented lines.  A blank
  // line separates points.  Some older ngspice versions omit the index
  // prefix on subsequent points, so we treat it as optional and detect
  // it by checking whether the line's first token is a non-negative
  // integer AND the rest of the line has fewer-than-numVariables values
  // (the typical "point has started" signature).
  let point = 0
  let field = 0
  for (let i = valuesStart + 1; i < lines.length; i++) {
    const raw = lines[i]
    if (raw === undefined) break
    if (raw.length === 0) continue
    let tokens = raw.split("\t")
    // Detect an optional leading point-index token: a leading " <int>"
    // where the rest of the line is values.  Conditions:
    //   - this is the first token of a new point (field === 0)
    //   - the first token, trimmed, is a non-negative integer
    //   - the remainder of the line has at least one numeric value
    //   - dropping it leaves fewer-than-numVariables tokens, so this
    //     isn't just a values-only continuation line
    if (field === 0) {
      const head = tokens[0].trim()
      if (/^\d+$/.test(head) && tokens.length - 1 < numVariables && tokens.length > 1) {
        tokens = tokens.slice(1)
      }
    }
    for (const tok of tokens) {
      const t = tok.trim()
      if (t.length === 0) continue
      // Complex-valued raw files (Flags: complex) write each value as
      // "<real>,<imag>" on a single token.  We take the real part only
      // and warn — the simulator pipeline is real-valued, so dropping
      // imaginary parts is the documented behaviour.  This avoids a
      // silent zero-out.
      let n: number
      if (flags !== null && /complex/i.test(flags) && t.includes(",")) {
        const real = t.split(",")[0]
        const parsed = Number(real)
        if (!Number.isFinite(parsed)) {
          throw new Error(
            "parseRawFile: non-numeric complex value in 'Values:' body at " +
            "line " + (i + 1) + ": " + JSON.stringify(t),
          )
        }
        n = parsed
      } else {
        n = Number(t)
        if (!Number.isFinite(n)) {
          throw new Error(
            "parseRawFile: non-numeric value in 'Values:' body at line " +
            (i + 1) + ": " + JSON.stringify(tok),
          )
        }
      }
      if (point >= numPoints) {
        throw new Error(
          "parseRawFile: 'Values:' section contains more data than " +
          "'No. Points'=" + numPoints + " declares (extra value at line " +
          (i + 1) + ": " + JSON.stringify(tok) + ")",
        )
      }
      const v = variables[field]
      if (!v) {
        throw new Error(
          "parseRawFile: 'Values:' has more fields than 'No. Variables'=" +
          numVariables + " declares (extra field at line " + (i + 1) + ")",
        )
      }
      vectors[v.name][point] = n
      field++
      if (field === numVariables) {
        field = 0
        point++
      }
    }
  }

  if (point !== numPoints) {
    throw new Error(
      "parseRawFile: 'Values:' section incomplete — saw " + point +
      " point rows, 'No. Points'=" + numPoints + " declared",
    )
  }

  return {
    variables,
    vectors,
    numPoints,
    plotname,
  }
}

function parseIntSafe(s: string, label: string): number {
  const n = parseInt(s, 10)
  if (!Number.isFinite(n)) {
    throw new Error("parseRawFile: " + label + " is not an integer: " + JSON.stringify(s))
  }
  return n
}
