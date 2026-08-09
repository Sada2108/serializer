# Simulator Viewer QA & Zoom-Regression Investigation — Progress Report

**Project:** Serializer — Layer 3 Serializer & Simulator
**Report date:** 2026-08-09
**Scope:** Everything done since the last report (interactive uPlot simulator migration, scale-mode/axis QA, and the follow-up zoom-regression reproduction work)
**Build marker (current template):** `zoom-yrefit-wheelfix-opbanner-grab-2026-08-09`
**Test suite:** 146 pass / 0 fail (4432–4447 `expect()` calls, 9 files)

---

## 1. Executive Summary

A 4-item regression task against the interactive simulator viewer was processed. Two real defects were found and fixed (wheel zoom was silently dead due to an API-shape bug; the OP page showed stale scale-mode warnings for a chart that does not exist), two UX items were implemented (pan `grab`/`grabbing` cursor; guaranteed Y visibility after every zoom-button click), and one product decision was confirmed (FFT stays a connected line).

The headline item — a user-reported "zoom-in collapses the Y axis to −5..−70 with 2 of 3 traces vanishing" — **could not be reproduced** through any documented or inferred sequence, including the exact slider-driven live-re-simulation path identified in the follow-up. Evidence is presented in §4. The working hypothesis is a stale build (remote/Railway/Docker serve the committed template, which predates all session fixes) or a cached browser tab. A literal screenshot of the broken state and the user's page URL are required to close the item.

---

## 2. Background

The interactive simulator (`dev-tools/interactive_simulator.html`, uPlot v1.6.31 canvas renderer) provides:
- A 5-analysis dropdown (TRAN / OP / DC / AC / FFT; PZ/NOISE/SP disabled with tooltips)
- A 4-mode scale dropdown (Linear / Log Y / Log X / Log-Log) backed by the shared `scaleMode.js` UMD module
- Dynamic component sliders with a 250 ms debounce that live-POST to `sim_server.ts` (`/simulate`) and reuse the chart via `setData()` (the `updateChartData` path)
- Custom pan and wheel-zoom uPlot plugins (uPlot 1.6.31 has none natively)

The prior report closed the blank-chart / scale-mode QA pass (blank Log Y / Log X / Log-Log, OP chart null-x, tick labels, hover tooltip) and introduced the 20-combo headless-Chrome chart matrix (`scaleMatrix.test.ts`). This report covers the work since then.

---

## 3. Work Items

### 3.1 Zoom-in regression (#1) — hardened; exact broken state NOT reproduced

**Reported behavior:** load AC, click `+` (sometimes after interacting), and the chart's Y axis collapses to a −5..−70 window with 2 of 3 traces gone.

**Investigation outcome:** the exact broken state could not be reproduced on any code path — see §4 for the exhaustive matrix, including the user-identified slider sequence.

**Fix applied (defensive, still valuable):** `zoomChart(factor)` in `interactive_simulator.html` now re-fits the Y axis after *every* `+`/`-` click (and on the zoom-out-to-Fit path) via `u.setScale("y", {min: null, max: null})`. This guarantees all currently-checked series stay visible in the newly-zoomed x window, and keeps the y scale `auto` so later pans/zooms continue re-ranging it. The 1%-of-full-span minimum-span clamp (`clampScaleFromHook`) continues to guard against sub-pixel collapse.

**Verification:** AC, slider→R1=5.6k then 5×`+`; drag-pan then `+`; wheel-zoom then `+` — all keep 3/3 traces visible, 0 clipped.

### 3.2 FFT visualization decision (#2) — confirmed, no change

The user chose to **keep the connected line** rendering for the FFT harmonic-magnitude probe (vs. switching to a stem/bar plot). No code change; the decision is recorded in CONTEXT.md. FFT remains a single "Harmonic Magnitude" trace (magnitude vs. frequency), rendered by uPlot as a connected line.

### 3.3 OP stale warning banner (#3) — fixed and verified

**Root cause:** OP analysis renders a value table with **no chart/axes**, but `refreshScaleOptions` ran the normal gating path and displayed stale warnings ("⚠ Log X / Log-Log floored: origin sample(s) clamped… / Log Y / Log-Log disabled: waveform crosses zero…") for a chart that does not exist.

**Fix:** `refreshScaleOptions(atype, x, probes)` early-returns for `analysisType === "op"` — it disables the scale-mode dropdown (`sel.disabled = true`) and hides the `#scaleWarn` banner (`display: none`).

**Verification (live, `http://localhost:3777/?fixture=rc_lowpass_001&analysis=op`):** `bannerDisplay: none`, `selectDisabled: true`, `.op-table` present, no canvas.

### 3.4 Pan cursor affordance (#4) — implemented and verified

**Root cause:** `makePanPlugin` had no cursor feedback, so the chart looked static despite being draggable.

**Fix:** the plugin sets `cursor: grab` on the chart on ready, `grabbing` while a drag is active (mousedown), and back to `grab` on mouseup (window-level, so it recovers even if the mouse is released off-chart).

**Verification (live AC):** idle `grab` → during drag `grabbing` → after release `grab`.

### 3.5 Wheel-zoom API-shape bug (real defect found during #1) — fixed

**Root cause:** `wheelZoomPlugin` called `u.setScale("x", zoomRangeAbout(...))` passing a bare array `[min, max]`, while uPlot requires an object `{min, max}`. uPlot silently reset the scale to full auto-range, so **wheel zoom never actually zoomed**.

**Fix:** wrap the result as `{min: nx[0], max: nx[1]}` (and likewise for y) before calling `setScale`.

**Verification (live AC):** one wheel-in event now produces x=[4434.8, 870719418.1] with y auto-ranged to [−135.07, −51.89] about the cursor, instead of snapping back to full range. Covered thereafter by the `scaleMatrix` harness.

---

## 4. Follow-up: slider-driven reproduction gap (this session)

### 4.1 Why this mattered

All earlier reproduction attempts used a **fresh page load** (the `renderChart` construction path). The user's broken screenshot showed **R1 = 5.6k**, which implied the sequence was: *move a component slider (live `POST /simulate` → `updateChartData` via `setData`, not `renderChart`) → then click `+`*. The follow-up reproduced exactly that sequence.

### 4.2 Methodology

Probe harness: headless Chromium (Playwright) against the live `sim_server` (`localhost:3777`), with the uPlot constructor intercepted to keep a stable instance reference. The AC sweep was loaded fresh (R1=1k, x=[1, 10⁷]), then `slider_R1` was set to `log10(5600)` and an `input` event dispatched (250 ms debounce → POST). Completion was gated on the value label reading `5.6k`, the overlay hidden, **and** the netlist element containing `R1 1 2 5.6k` (proves the round-trip happened, not just the UI). Y-data mutation was confirmed (v(2) rolloff moved from −75.96 dB to −90.93 dB). Then `+` was clicked.

Both the **current** code and the **pre-fix** `zoomChart` (x-zoom only, no y-refit — reconstructed in-page) were exercised, including 5 consecutive `+` clicks.

### 4.3 Results

| Step | Pre-fix `zoomChart` | Current code |
|---|---|---|
| Fresh AC (R1=1k) | y=[−110, 0], 3 traces, 0 clipped | y=[−110, 0], 3 traces, 0 clipped |
| After slider R1→5.6k (live POST → `updateChartData`) | y=[−110, 0], 0 clipped | y=[−110, 0], 0 clipped |
| After `+` ×1 | **y=[−96, 0], 0 clipped** | **y=[−96, 0], 0 clipped** |
| After `+` ×2 | y=[−90, 0], 0 clipped | y=[−90, 0], 0 clipped |
| After `+` ×3 | y=[−80, 0], 0 clipped | y=[−80, 0], 0 clipped |
| After `+` ×4–5 | y=[−79, 0], 0 clipped | — |

No sequence produced the reported −5..−70 window or vanished traces. `updateChartData` does **not** leave stale scale state: uPlot re-ranges its auto scales on `setData`, and the `+` button's y-refit is unconditional, so both paths behave identically.

### 4.4 Analysis — what *could* produce the screenshot, and why it's ruled out

- A y scale pinned to an explicit stale `{min, max}` from a prior drag-select zoom **would** produce exactly this (Y fixed to a narrow window while the data changes). Ruled out: native drag-select is disabled (`cursor.drag: false`; the custom plugin pans instead), and `zoomChart` force-refits Y regardless.
- The wheel-zoom array bug reset scales silently — it produced *no change*, not a −5..−70 window, and is fixed.
- **Most likely: a stale build or cached tab.** Remote deployments (Railway/Docker) and any `file://` copy older than the current marker run the committed template *without* any of the session fixes. The served page prints its build marker in `<meta name="sim-viewer-build">` and `console.info`.

### 4.5 Outstanding questions (blocking closure)

1. **Literal screenshot** of the broken state exported to a file path the agent can read directly (previous Desktop-heuristic analysis was the source of the reproduction gap and is not acceptable).
2. **Exact URL/browser:** live `localhost:3777`, `file://`, or a deployed URL? Was the tab hard-refreshed (`Cmd/Ctrl+Shift+R`)?

---

## 5. Verification

### 5.1 Full test suite (every checkpoint)

```
bun test
146 pass
0 fail
4432–4447 expect() calls  (slight run-to-run variance from the headless matrix)
Ran 146 tests across 9 files
```

- `simulator.test.ts` SKIPs its ngspice cases on this machine (the configured ngspice path is a Windows path, `C:\Tools\Spice64\bin\ngspice_con.exe`; no binary on this macOS host) — environmental, pre-existing.
- `dev-tools/scaleMatrix.test.ts` (20-combo headless-Chrome matrix) runs **11 enabled DRAWN + 6 gated-off combos OK**.
- Test files: `serializer`, `simulator`, `kicadPcbWriter`, `pcbRouting`, `router`, `formatNumbers`, `dev-tools/scaleMode`, `dev-tools/axisScale`, `dev-tools/scaleMatrix`.

### 5.2 Live-server confirmation

- Served build marker matches the template: `zoom-yrefit-wheelfix-opbanner-grab-2026-08-09`.
- AC: fresh y=[−110, 0]; after 3×`+` x=[51.05, 195884.5], y=[−73, 0], all 3 series `clipped=false`.
- OP: banner hidden, dropdown disabled, table rendered.
- TRAN: `+` keeps all traces unclipped; wheel zoom functional.
- FFT: connected line unchanged (canvas scan: median 1px column height across 800 columns).

---

## 6. Files Changed (this work)

| File | Change |
|---|---|
| `dev-tools/interactive_simulator.html` | `zoomChart` y-refit (both paths); wheel plugin `{min,max}` wrap; `makePanPlugin` grab/grabbing cursor; `refreshScaleOptions` OP guard + disabled dropdown; build marker `zoom-yrefit-wheelfix-opbanner-grab-2026-08-09` |
| `dev-tools/current_sim.html` | Regenerated after each template edit (contains new marker; used for `file://` probes) |
| `CONTEXT.md` | Updated template/plugin/zoom/OP/live-update documentation, test suite (9 files, 146/0), fixture catalog (+3 v1.2), git history, current state, Known Issue #13 |

*Pre-existing uncommitted work still in the tree (not authored this report cycle):* schema v1.2 migration + sheet-context rollout; 3 new untracked v1.2 fixtures (`555_timer`, `audio_amplifier_1386`, `audioamplifier_lm386`); `scaleMatrix.test.ts` QA matrix; generated viewer/schematic pages.

---

## 7. Open Items / Next Steps

1. **Close the zoom-regression item:** obtain the literal broken-state screenshot + user's exact URL/browser. If a stale build is confirmed (marker ≠ `zoom-yrefit-wheelfix-opbanner-grab-2026-08-09`), redeploy the current template (server binds `0.0.0.0` and is PORT-configurable per prior commits) and re-test.
2. Commit the simulator fixes (currently uncommitted) so deployed builds stop diverging from the working template.
3. Optional: extend `scaleMatrix.test.ts` with a slider→`+` scenario to permanently guard the `updateChartData` zoom path.

---

## 8. Appendix — Evidence & Environment

- **Evidence directory:** `/var/folders/ys/539fjms51810y131tq8g05gw0000gn/T/opencode/` (note: macOS cleaned this directory mid-session once; screenshots from that run were regenerated where needed — probe scripts were recreated).
- **Probe scripts:** `probe_slider_zoom.py` (current-code sequence), `probe_slider_oldpath.py` (pre-fix A/B), `probe_old_multiclick.py` (5×`+` stress). Key screenshots: `oldpath_fresh_plus.png`, `oldpath_slider56k_plus.png`, `oldpath_slider56k_plusx5.png`.
- **Runtime:** Bun v1.3.14, macOS (darwin), Playwright Chromium headless for probes, uPlot 1.6.31 (jsDelivr iife), `sim_server` on `localhost:3777`.
- **Repro recipe (for independent confirmation):** `bun run dev-tools/sim_server.ts` → open `http://localhost:3777/?fixture=rc_lowpass_ac_001&analysis=ac` → drag R1 to 5.6k → wait for `5.6k` + netlist `R1 1 2 5.6k` → click `+` → observe y re-range with 0 clipped.
