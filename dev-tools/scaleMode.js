// Scale-mode lookup, defaulting, and non-positive-value gating for the
// interactive simulator viewer.
//
// This file is plain JavaScript (no TS syntax) so it can be inlined verbatim
// into the generated HTML page as a classic <script> block (via the
// SCALE_MODE_JS template token) AND imported by bun tests as a CommonJS
// module. The UMD wrapper exposes a single global `scaleMode` object in the
// browser.
//
// uPlot scale "distr" values (uPlot 1.6.31): 1 = linear, 2 = ordinal,
// 3 = logarithmic, 4 = arcsinh. Logarithmic axes require strictly positive
// data; uPlot clamps <= 0 values to scaleMin/10 internally, so we additionally
// gate the UI so users cannot pick a log axis for data that is not positive.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.scaleMode = factory();
  }
})(globalThis, function () {
  var SCALE_MODES = {
    linear: { xDistr: 1, yDistr: 1 },
    logY:   { xDistr: 1, yDistr: 3 },
    logX:   { xDistr: 3, yDistr: 1 },
    loglog: { xDistr: 3, yDistr: 3 },
  };

  var SCALE_OPTIONS = [
    { value: "linear", label: "Linear" },
    { value: "logY",   label: "Log Y" },
    { value: "logX",   label: "Log X" },
    { value: "loglog", label: "Log-Log" },
  ];

  // Default scale mode per analysis type. TRAN/OP/DC plot against a linear
  // time/voltage axis, AC is a Bode sweep (log frequency on X), FFT is a bar
  // chart of harmonic magnitudes (linear).
  function defaultScaleFor(analysisType) {
    return analysisType === "ac" ? "logX" : "linear";
  }

  function scaleConfigFor(mode) {
    return SCALE_MODES[mode] || SCALE_MODES.linear;
  }

  // True when any value is NaN, zero, or negative. NaN > 0 is false, so NaN
  // values are treated as non-positive (safest for log).
  function hasNonPositive(values) {
    for (var i = 0; i < values.length; i++) {
      if (!(values[i] > 0)) return true;
    }
    return false;
  }

  // Smallest strictly-positive value in the array (ignores NaN/0/negative).
  // Returns null if no positive value exists (the case where log is unusable).
  // Used to choose the log-axis floor for the t=0 origin case (see below).
  function smallestPositive(values) {
    var min = null;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v > 0 && (min === null || v < min)) min = v;
    }
    return min;
  }

  // Compute which scale options are usable for the given x/y data, and a short
  // human-readable reason when any option is disabled.
  //   AC magnitude traces are already 20*log10(V) in dB, so Log Y / Log-Log
  //   would double-log the data and are always disabled for AC.
  //   Log Y / Log-Log require all Y values > 0 (a waveform that crosses zero
  //   legitimately cannot be log-plotted and that option stays disabled).
  //   Log X / Log-Log: historically disabled whenever x contained any
  //   non-positive value. THAT BROKE TRAN, where the time axis legitimately
  //   starts at t=0. The original spec anticipated this and asked for a real
  //   fix, not a blanket disable. Decision documented here:
  //     - Approach: ORIGIN-INCLUSION + EPSILON FLOOR. The t=0 sample is kept
  //       in the plotted data (transient waveforms must show the origin), and
  //       the log-scale's BOTTOM is floored to the smallest strictly-positive
  //       x (the first non-zero ngspice timestep) by applyScaleMode below.
  //       uPlot 1.6.31 then clamps the t=0 point to scaleMin/10 internally,
  //       rendering it at the chart's left edge rather than discarding it.
  //       This was chosen over pure origin-exclusion because excluding the
  //       origin sample would drop legitimate data; pure epsilon-substitution
  //       would distort the curve. It also keeps the data array untouched
  //       (the epsilon-clamp requirement from formatNumbers.ts is respected).
  //     - Log X is still disabled if there is NO positive x at all (the floor
  //       is undefined), and is disabled for AC whenever x is non-positive.
  function restrictedScaleOptions(analysisType, xValues, yValues) {
    var xOk = !hasNonPositive(xValues);
    var yOk = !hasNonPositive(yValues);
    var reasons = [];

    var options = SCALE_OPTIONS.map(function (o) {
      var disabled = false;
      // For AC the data is already in dB, so Log Y / Log-Log are never usable.
      if (analysisType === "ac") {
        if (o.value === "logY" || o.value === "loglog") {
          disabled = true;
        } else if (o.value === "logX" && !xOk) {
          disabled = true;
        }
      } else {
        // Log Y / Log-Log require the waveform to stay strictly > 0 (zero/negative
        // crossings genuinely can't be log-plotted; that gating is intentional).
        if ((o.value === "logY" || o.value === "loglog") && !yOk) disabled = true;
        // Log X / Log-Log: allow even when x has a non-positive origin, PROVIDED
        // there is at least one positive x to floor the log range to (see the
        // t=0 origin-inclusion decision above). Disable only when NO positive x.
        var xHasFloor = smallestPositive(xValues) !== null;
        if ((o.value === "logX" || o.value === "loglog") && !xHasFloor) disabled = true;
      }
      return { value: o.value, label: o.label, disabled: disabled };
    });

    if (analysisType === "ac") {
      reasons.push("Log Y / Log-Log disabled for AC magnitude traces (already in dB)");
    }
    var xHasFloor = smallestPositive(xValues) !== null;
    if (!xHasFloor) {
      reasons.push("Log X / Log-Log disabled: no positive x value to floor the log range");
    } else if (!xOk) {
      // Origin-only non-positive case (e.g. TRAN t=0): Log X is enabled with a
      // floor, so explain rather than disable.
      reasons.push("Log X / Log-Log floored: origin sample(s) clamped to the smallest positive x");
    }
    if (!yOk && analysisType !== "ac") {
      reasons.push("Log Y / Log-Log disabled: waveform crosses zero (log needs positive values)");
    }

    return {
      options: options,
      message: reasons.length > 0 ? reasons.join(" \u2014 ") : null,
    };
  }

  // Apply a scale mode to a uPlot instance.
  // uPlot 1.6.31 has no config-mutating setScale (its setScale(key, {min,max})
  // is zoom-only), so the live scale config is mutated directly and the chart
  // is re-auto-ranged under the new distr by re-feeding the current data.
  //
  // T=0 ORIGIN FLOOR: when entering logX/loglog on data whose x-axis has a
  // non-positive origin (typical TRAN t=0), set scales.x.min to the smallest
  // strictly-positive x (the first non-zero ngspice timestep) BEFORE setData,
  // so the log axis spans that->max rather than auto-deriving min=0. uPlot
  // then clamps the t=0 sample to scaleMin/10, keeping it on the left edge.
  // xValues is optional for backward compatibility; without it no floor is
  // applied (the caller is responsible for the scale range).
  function applyScaleMode(uplotInstance, mode, xValues) {
    var cfg = scaleConfigFor(mode);
    if (uplotInstance && uplotInstance.scales) {
      if (uplotInstance.scales.x) {
        uplotInstance.scales.x.distr = cfg.xDistr;
        // Floor the log-x range when the data has a non-positive origin.
        if (cfg.xDistr === 3 && xValues && uplotInstance.scales.x) {
          var floor = smallestPositive(xValues);
          if (floor !== null && hasNonPositive(xValues)) {
            uplotInstance.scales.x.min = floor;
          } else {
            // Re-entering auto-range (or no origin case): clear any prior floor.
            uplotInstance.scales.x.min = undefined;
          }
        } else if (cfg.xDistr === 1) {
          // Leaving log -> linear: restore auto-range by clearing the floor.
          uplotInstance.scales.x.min = undefined;
        }
      }
      if (uplotInstance.scales.y) uplotInstance.scales.y.distr = cfg.yDistr;
    }
    if (uplotInstance && typeof uplotInstance.setData === "function") {
      uplotInstance.setData(uplotInstance.data);
    }
  }

  return {
    SCALE_MODES: SCALE_MODES,
    SCALE_OPTIONS: SCALE_OPTIONS,
    defaultScaleFor: defaultScaleFor,
    scaleConfigFor: scaleConfigFor,
    hasNonPositive: hasNonPositive,
    smallestPositive: smallestPositive,
    restrictedScaleOptions: restrictedScaleOptions,
    applyScaleMode: applyScaleMode,
  };
});
