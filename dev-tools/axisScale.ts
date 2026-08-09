// Shared x-axis unit conversion between render_interactive_simulator.ts and
// sim_server.ts. Centralizes the "does this analysis type's x-data need a
// seconds -> milliseconds x1000 conversion?" rule so the static driver and
// the live slider server agree.
//
// Time-domain analyses (TRAN, OP, DC-point-time-step, and the FFT time axis
// before the Fourier transform) report x in seconds and must be shown in ms.
// AC sweep x-data is frequency in Hz and must NOT be scaled. DC sweep x-data
// is voltage and must NOT be scaled (it already has its own unit label).

export type AnalysisType = "tran" | "op" | "dc" | "ac" | "fft"

// True when the x-axis for this analysis carries seconds (ngspice native unit)
// and should be displayed as milliseconds on the chart. Only TRAN (transient
// sweep) reports a true time axis in seconds; OP is a single DC operating
// point (no time sweep), AC sweeps frequency (Hz), DC sweeps a voltage (V),
// and FFT plots harmonic magnitudes against harmonic frequency (Hz). The
// ngspice timeStep/duration opts are likewise only meaningful for TRAN.
export function isTimeDomainX(analysisType: string): boolean {
  return analysisType === "tran"
}

// Convert a raw ngspice x vector to display units. Time-domain x (seconds)
// is scaled x1000 to ms; frequency / voltage / index pass through unchanged.
export function toDisplayX(analysisType: string, rawX: number[]): number[] {
  return isTimeDomainX(analysisType) ? rawX.map((t) => t * 1000) : rawX.slice()
}
