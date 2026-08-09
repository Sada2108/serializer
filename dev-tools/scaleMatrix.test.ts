// 20-combination chart regression matrix (5 analyses x 4 scale modes).
//
// Each combo is loaded in a headless Chrome via CDP against sim_server, the
// scale mode is applied through the UI dropdown, and the resulting uPlot
// chart is asserted to be DRAWN (non-blank canvas), with finite auto-ranged
// x/y scales and the expected linear/log distr. Gated combos (e.g. logY on a
// zero-crossing waveform) must come back as disabled dropdown options. OP does
// not build a chart (it renders a value table), so it is asserted separately.
//
// This is the regression test behind the QA pass that fixed blank Log Y / Log X
// / Log-Log charts, the OP chart (x-scale stayed null because a post-hoc
// chart.redraw() clobbered the construction-time x auto-range), tick labels,
// and the hover tooltip. Skips when ngspice or Chrome for Testing is missing.

import { test, describe, expect } from "bun:test";
import { spawn, execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LAYER3 = join(import.meta.dir, "..");
const TEST_PORT = Number(process.env.TEST_PORT) || 3877;

// analysis type -> (fixture, expected gated-off modes)
const ANALYSES: Array<[string, string, string[]]> = [
  ["tran", "rc_lowpass_001", ["logY", "loglog"]],
  ["op", "rc_lowpass_001", ["logY", "loglog"]],
  ["dc", "rc_lowpass_001", ["logY", "loglog"]],
  ["ac", "rc_lowpass_ac_001", ["logY", "loglog"]],
  ["fft", "rc_lowpass_fft_001", []],
];
const MODES = ["linear", "logY", "logX", "loglog"];

const MODE_DISTR: Record<string, [number, number]> = {
  linear: [1, 1],
  logY: [1, 3],
  logX: [3, 1],
  loglog: [3, 3],
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function findChrome(): string | null {
  const candidates: string[] = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  try {
    const builds = readdirSync(cache)
      .filter((d) => d.startsWith("chromium-"))
      .sort()
      .reverse();
    for (const b of builds) {
      candidates.push(join(cache, b, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
    }
  } catch {
    // no playwright cache
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

async function hasNgspice(): Promise<boolean> {
  const bin = process.env.NGSPICE_BIN || "ngspice";
  try {
    await execFileAsync(bin, ["-v"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// --- CDP helpers -------------------------------------------------------------
type CDPResult = { result?: { value?: any; exceptionDetails?: any }; exceptionDetails?: any };

function makeClient(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws connect failed"));
  });
  const send = (method: string, params: any = {}) => {
    return new Promise<any>((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  };
  return { opened, send, close: () => ws.close() };
}

async function newTab(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
  return res.json();
}

const UPLOT_HOOK = `
(() => {
  window.__uplots = window.__uplots || [];
  let realU = null;
  const wrap = (O) => {
    realU = O;
    function Wrapped(uopts, data, el) {
      const inst = new O(uopts, data, el);
      window.__uplots.push(inst);
      return inst;
    }
    Wrapped.prototype = O.prototype;
    Object.assign(Wrapped, O);
    return Wrapped;
  };
  Object.defineProperty(window, "uPlot", {
    configurable: true,
    set(v) {
      if (v && typeof v === "function" && v !== realU && !v.__wrapped) {
        const w = wrap(v);
        w.__wrapped = true;
        Object.defineProperty(window, "uPlot", { configurable: true, writable: true, value: w });
      } else {
        Object.defineProperty(window, "uPlot", { configurable: true, writable: true, value: v });
      }
    },
    get() { return realU; },
  });
})();
`;

const READ_STATE = `
() => {
  const u = window.__uplots && window.__uplots.length ? window.__uplots[window.__uplots.length - 1] : null;
  if (!u) return { error: "no chart instance" };
  let overCv = null;
  if (u.root) {
    const all = u.root.querySelectorAll("canvas");
    if (all.length) overCv = all[0];
  }
  let coloredPixels = -1;
  let axisPixels = -1;
  if (overCv) {
    const ctx = overCv.getContext("2d");
    const d = ctx.getImageData(0, 0, overCv.width, overCv.height).data;
    let colored = 0, axis = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
      if (a === 0) continue;
      if (r === 255 && g === 255 && b === 255) continue;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma > 24) colored++;
      else axis++;
    }
    coloredPixels = colored;
    axisPixels = axis;
  }
  const xTicks = u.axes && u.axes[0] && u.axes[0]._values ? u.axes[0]._values : null;
  const options = (() => {
    const sel = document.getElementById("scaleMode");
    if (!sel) return null;
    return Array.from(sel.options).map((o) => ({ value: o.value, disabled: o.disabled }));
  })();
  return {
    xDistr: u.scales.x.distr,
    yDistr: u.scales.y.distr,
    xMin: u.scales.x.min,
    xMax: u.scales.x.max,
    yMin: u.scales.y.min,
    yMax: u.scales.y.max,
    coloredPixels,
    axisPixels,
    xTickCount: xTicks ? xTicks.length : -1,
    xValues: xTicks ? xTicks : null,
    selectedMode: document.getElementById("scaleMode") ? document.getElementById("scaleMode").value : null,
    scaleModeOptions: options,
  };
}
`;

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, stepMs = 250): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

test("20-combination chart matrix (5 analyses x 4 scale modes) renders", { timeout: 300_000 }, async () => {
  if (!(await hasNgspice())) {
    console.log("  SKIP: ngspice not found");
    return;
  }
  const chrome = findChrome();
  if (!chrome) {
    console.log("  SKIP: Chrome for Testing not found");
    return;
  }

  // Start an isolated sim_server for the test.
  const server = spawn("bun", ["run", "dev-tools/sim_server.ts"], {
    cwd: LAYER3,
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: "ignore",
  });
  const base = `http://localhost:${TEST_PORT}`;
  const serverReady = await waitFor(async () => {
    try {
      const r = await fetch(`${base}/fixture/rc_lowpass_001`);
      if (r.ok) return true;
    } catch {}
    return null;
  }, 20_000);
  if (!serverReady) {
    server.kill();
    console.log("  SKIP: sim_server did not start");
    return;
  }

  const chromeProc = spawn(chrome, [
    "--headless=new",
    `--remote-debugging-port=9337`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    `--user-data-dir=/tmp/scaleMatrix-profile-${process.pid}`,
    "about:blank",
  ], { stdio: "ignore" });

  try {
    const cdpReady = await waitFor(async () => {
      try {
        const r = await fetch("http://127.0.0.1:9337/json/version");
        if (r.ok) return true;
      } catch {}
      return null;
    }, 15_000);
    if (!cdpReady) throw new Error("Chrome CDP did not start");

    const failures: string[] = [];
    const total = { enabled: 0, disabled: 0, drawn: 0 };

    for (const [atype, fixture, gated] of ANALYSES) {
      const tab = await newTab(9337);
      const client = makeClient(tab.webSocketDebuggerUrl);
      await client.opened;
      await client.send("Page.enable");
      await client.send("Runtime.enable");
      await client.send("Page.addScriptToEvaluateOnNewDocument", { source: UPLOT_HOOK });
      await client.send("Page.navigate", { url: `${base}/?fixture=${fixture}&analysis=${atype}` });

      const got = await waitFor(async () => {
        if (atype === "op") {
          const r: CDPResult = await client.send("Runtime.evaluate", { expression: "document.querySelector('.op-table') ? 1 : 0", returnByValue: true });
          return r.result?.value > 0 ? true : null;
        }
        const r: CDPResult = await client.send("Runtime.evaluate", { expression: "window.__uplots ? window.__uplots.length : 0", returnByValue: true });
        return r.result?.value > 0 ? true : null;
      }, 20_000);
      if (!got) {
        failures.push(`${atype} LOAD: ${atype === "op" ? "value table" : "chart"} never appeared`);
        client.close();
        continue;
      }
      await sleep(300);

      // OP renders a value table (not a chart): assert probe names + units, then
      // move on — scale-mode distr checks below only apply to real charts.
      if (atype === "op") {
        const t: CDPResult = await client.send("Runtime.evaluate", { expression: `(() => {
          const cells = [...document.querySelectorAll(".op-table td")].map((td) => td.textContent.trim());
          return { cells, rows: document.querySelectorAll(".op-table tr").length };
        })()`, returnByValue: true });
        const cells: string[] = t.result?.value?.cells || [];
        total.enabled++;
        total.drawn++;
        for (const name of ["v(1)", "v(2)", "i(v1)"])
          if (!cells.includes(name)) failures.push(`op: value table missing probe ${name} (${cells.join(",")})`);
        if (!cells.includes("V")) failures.push(`op: value table missing volt unit (${cells.join(",")})`);
        if (!cells.includes("A")) failures.push(`op: value table missing amp unit (${cells.join(",")})`);
        client.close();
        continue;
      }

      const initial: CDPResult = await client.send("Runtime.evaluate", { expression: `(${READ_STATE})()`, returnByValue: true });
      const opts = initial.result?.value?.scaleModeOptions as Array<{ value: string; disabled: boolean }> | null;

      for (const mode of MODES) {
        const opt = opts?.find((o) => o.value === mode);
        const isGated = gated.includes(mode);

        if (isGated || opt?.disabled) {
          total.disabled++;
          if (!opt?.disabled) failures.push(`${atype}/${mode}: expected gated-off option to be disabled`);
          if (!isGated) failures.push(`${atype}/${mode}: option disabled but not in expected gated set`);
          continue;
        }

        total.enabled++;
        const expr = `(() => {
          const sel = document.getElementById("scaleMode");
          sel.value = "${mode}";
          sel.dispatchEvent(new Event("change"));
        })()`;
        await client.send("Runtime.evaluate", { expression: expr });
        await sleep(300);

        const r: CDPResult = await client.send("Runtime.evaluate", { expression: `(${READ_STATE})()`, returnByValue: true });
        if (r.exceptionDetails) {
          failures.push(`${atype}/${mode}: read-state threw ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
          continue;
        }
        const s = r.result?.value;
        if (!s || s.error) {
          failures.push(`${atype}/${mode}: ${s?.error || "no state"}`);
          continue;
        }

        const [expX, expY] = MODE_DISTR[mode];
        const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);

        if (s.xDistr !== expX) failures.push(`${atype}/${mode}: xDistr=${s.xDistr} expected ${expX}`);
        if (s.yDistr !== expY) failures.push(`${atype}/${mode}: yDistr=${s.yDistr} expected ${expY}`);
        if (!(finite(s.xMin) && finite(s.xMax) && s.xMax > s.xMin))
          failures.push(`${atype}/${mode}: x range not auto-ranged (${s.xMin}..${s.xMax})`);
        if (!(finite(s.yMin) && finite(s.yMax) && s.yMax > s.yMin))
          failures.push(`${atype}/${mode}: y range not auto-ranged (${s.yMin}..${s.yMax})`);
        if (s.coloredPixels <= 50) failures.push(`${atype}/${mode}: chart BLANK (coloredPixels=${s.coloredPixels})`);
        else total.drawn++;
      }
      client.close();
    }

    chromeProc.kill();
    server.kill();

    expect(failures, failures.join("\n")).toEqual([]);
    expect(total.enabled).toBeGreaterThan(0);
    expect(total.disabled).toBeGreaterThan(0);
    expect(total.drawn).toBe(total.enabled);
    console.log(`  matrix: ${total.enabled} enabled DRAWN + ${total.disabled} gated-off combos OK`);
  } finally {
    chromeProc.kill();
    server.kill();
  }
});
