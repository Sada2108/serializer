// Open_Forge — ngspice circuit simulator bridge (Layer 4).
//
// Subprocess-based driver for the external ngspice CLI.  Takes a SPICE
// netlist, writes it to a temp .cir file with a standard
// `.control ... .endc` block that requests ASCII .raw output, runs
// `ngspice -b` against it, parses the resulting .raw file, and returns the
// named vectors.  Temp files are always cleaned up.
//
// HARD CONSTRAINT:
//   This is the ONLY module in the project that invokes the ngspice
//   binary.  Other modules (e.g. netlistFromCircuitJson) MUST go through
//   simulateNetlist() to drive ngspice — never spawn the binary directly.
//   `simulator.py` mirrors this rule on the Python side.
//
// LOUD-FAILURE:
//   - non-zero ngspice exit
//   - "Error:" in ngspice's stderr (typical ngspice error marker)
//   - missing .raw output
//   - malformed .raw output
//   All of these raise an Error with the captured stderr/stdout so the
//   caller can debug.  We never silently return empty vectors.

import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseRawFile, type ParseRawResult } from "./parseRawFile"

export interface SimulationResult {
  /** Named numeric vectors from the .raw output (e.g. "v(out)", "time"). */
  vectors: Record<string, number[]>
  /** Variable list as parsed from the .raw header. */
  variables: ParseRawResult["variables"]
  /** Number of simulation sample points. */
  numPoints: number
  /** Plotname from the .raw header (e.g. "Transient Analysis", "DC transfer characteristic"). */
  plotname: string | null
  /** ngspice version banner, when -v was probed successfully. */
  viewerUsed?: string
}

/**
 * Locate the ngspice binary.
 *
 * Precedence:
 *   1. `NGSPICE_BIN` env var (explicit override — e.g. set to the
 *      `ngspice_con.exe` console variant when `ngspice.exe` is the GUI
 *      wrapper that won't run unattended).
 *   2. `ngspice` on PATH (the common case).
 *
 * On Windows the bundled ngspice install sometimes ships only a GUI
 * wrapper as `ngspice.exe`, with the console binary at `ngspice_con.exe`
 * — callers can point NGSPICE_BIN at the console variant to make batch
 * mode work.
 */
export function resolveNgspiceBin(): string {
  const fromEnv = process.env["NGSPICE_BIN"]
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return "ngspice"
}

/**
 * Probe ngspice's version banner.  Returns the banner text (or throws).
 * Useful to record the pinned ngspice version alongside a simulation
 * result and to fail fast with a clear error when ngspice isn't installed.
 */
export async function getNgspiceVersion(bin: string = resolveNgspiceBin()): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(bin, ["-v"], { timeout: 10_000 }, (err, stdout, stderr) => {
      // ngspice writes the banner to stdout (and only exits cleanly when
      // given a real circuit).  With -v alone, the binary may not exit
      // cleanly on some platforms — accept any non-empty combined output.
      const combined = (stdout + "\n" + stderr).trim()
      if (combined.length > 0) {
        resolve(combined.split(/\r?\n/).slice(0, 8).join("\n"))
        return
      }
      reject(new Error(
        "ngspice -v produced no output — is `" + bin + "` installed and on PATH? " +
        "(set NGSPICE_BIN to override the binary path)",
      ))
    })
  })
}

/**
 * Run a SPICE netlist through ngspice in batch mode and return the
 * parsed simulation vectors.
 *
 * Steps:
 *   1. Write the netlist to a temp .cir file.
 *   2. Append a `.control ... .endc` block that runs the simulation and
 *      writes an ASCII .raw file (`set filetype=ascii; write <output>`).
 *   3. Spawn `ngspice -b <input>.cir` via execFile.  We don't use a shell
 *      and don't embed any user-supplied flags from the netlist, so this
 *      is injection-safe.
 *   4. On non-zero exit OR an "Error:" line in stderr, throw with the
 *      captured diagnostic.
 *   5. Parse the resulting .raw file via `parseRawFile` and return the
 *      vectors.
 *   6. Clean up the temp directory (best-effort, even on failure).
 */
export async function simulateNetlist(
  netlist: string,
  opts: { ngspiceBin?: string; timeoutMs?: number } = {},
): Promise<SimulationResult> {
  if (typeof netlist !== "string" || netlist.trim().length === 0) {
    throw new Error("simulateNetlist: netlist is empty")
  }
  const bin = opts.ngspiceBin ?? resolveNgspiceBin()
  const timeoutMs = opts.timeoutMs ?? 60_000

  // Temp directory: one per call so concurrent calls don't collide.
  const workDir = await mkdtemp(join(tmpdir(), "openforge-sim-"))
  const cirPath = join(workDir, "input.cir")
  const rawPath = join(workDir, "output.raw")
  const logPath = join(workDir, "ngspice.log")

  const cleaned = await Promise.resolve()
  void cleaned

  try {
    // ---- 1. Compose the .cir file ---------------------------------------
    // Make sure the netlist has a title line (SPICE requires it as the
    // very first non-comment line) and a trailing .END.  If the caller
    // already provided these, leave them alone.
    const withTitle = ensureTitleLine(netlist)
    const withEnd = ensureEndLine(withTitle)

    // The control block always writes an ASCII .raw.  We do NOT silently
    // skip the control block — every call goes through the same path so
    // results are comparable.
    const cirBody = [
      withEnd,
      "",
      "* ---- ngspice control block (added by simulator.ts) ----",
      ".control",
      "run",
      "set filetype=ascii",
      `write ${rawPath}`,
      ".endc",
      ".END",
      "",
    ].join("\n")
    await writeFile(cirPath, cirBody, "utf8")

    // ---- 2. Spawn ngspice ----------------------------------------------
    // We pass the .log file via -o so the simulator's stdout/stderr don't
    // disappear (Windows would otherwise close the parent's pipe and we'd
    // hang on a console-attach edge case).  We do NOT use a shell.
    const ngArgs = ["-b", "-o", logPath, cirPath]
    const { code, stdout, stderr } = await runNgspice(bin, ngArgs, timeoutMs)

    // ---- 3. Loud-failure checks ----------------------------------------
    // Read the log file in case stdout/stderr came back empty (Windows).
    let logText = ""
    try {
      logText = await readFile(logPath, "utf8")
    } catch {
      logText = ""
    }
    const combined = (stdout + "\n" + stderr + "\n" + logText).trim()

    if (code !== 0) {
      throw new Error(
        "ngspice exited with non-zero status (code=" + code + "). " +
        "Output:\n" + combined,
      )
    }
    if (/\bError:\s/.test(combined) || /^Error\b/m.test(combined)) {
      throw new Error(
        "ngspice reported an error during simulation. Output:\n" + combined,
      )
    }

    // ---- 4. Parse .raw -------------------------------------------------
    let rawText: string
    try {
      rawText = await readFile(rawPath, "utf8")
    } catch (e) {
      throw new Error(
        "ngspice completed but no .raw file was produced at " + rawPath +
        " (this is a loud failure — refusing to return an empty result). " +
        "ngspice log:\n" + combined,
      )
    }
    const parsed = parseRawFile(rawText)

    // Best-effort version probe; never blocks the main result.
    let viewerUsed: string | undefined
    try {
      viewerUsed = await getNgspiceVersion(bin)
    } catch {
      viewerUsed = bin
    }

    return {
      vectors: parsed.vectors,
      variables: parsed.variables,
      numPoints: parsed.numPoints,
      plotname: parsed.plotname,
      viewerUsed,
    }
  } finally {
    // Best-effort cleanup.  We don't `await` the rm in a try/catch to keep
    // the original error visible; the tempdir is OS-managed anyway.
    rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ })
  }
}

// --------------------------------------------------------------------------- //
// Internals
// --------------------------------------------------------------------------- //

function runNgspice(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        // `err` is set on non-zero exit.  We still want the captured
        // stdout/stderr even on failure, so resolve with code=-1 in that
        // case and let the caller decide.
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(
            "ngspice binary '" + bin + "' not found. Install ngspice " +
            "(https://ngspice.sourceforge.io/) and ensure it's on PATH, " +
            "or set NGSPICE_BIN to the absolute path of the console-mode " +
            "binary (e.g. ngspice_con.exe on Windows).",
          ))
          return
        }
        const code = (err && typeof (err as NodeJS.ErrnoException).code === "number")
          ? (err as NodeJS.ErrnoException).code as number
          : 0
        resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() })
      },
    )
  })
}

function ensureTitleLine(netlist: string): string {
  // SPICE: the first non-comment, non-blank line is the TITLE.  If the
  // caller's netlist already has one, leave it alone — we look for the
  // first line that's neither blank nor starts with '*' or ';'.
  const lines = netlist.split(/\r?\n/)
  for (const ln of lines) {
    const t = ln.trim()
    if (t.length === 0) continue
    if (t.startsWith("*") || t.startsWith(";")) continue
    return netlist   // first non-blank/comment line is the title
  }
  // No title line — prepend one.
  return "* Open_Forge simulation (autogenerated title)\n" + netlist
}

function ensureEndLine(netlist: string): string {
  const lines = netlist.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim().toUpperCase()
    if (t.length === 0) continue
    if (t.startsWith("*") || t.startsWith(";")) continue
    if (t === ".END" || t === "END") return netlist
    break
  }
  return netlist + "\n.END\n"
}
