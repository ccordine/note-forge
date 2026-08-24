import type {
  PitchTunnelErrorAccumulation,
  PitchTunnelMetrics,
  PitchTunnelState,
} from "./pitch-tunnel-types";

function stabilityCents(accumulation: Readonly<PitchTunnelErrorAccumulation>): number | null {
  if (accumulation.trackedSeconds <= 0) return null;
  const mean = accumulation.signedErrorCentsSeconds / accumulation.trackedSeconds;
  const meanSquare = accumulation.squaredErrorCentsSeconds / accumulation.trackedSeconds;
  return Math.sqrt(Math.max(0, meanSquare - mean ** 2));
}

/** Derive presentation metrics without changing the authoritative reducer state. */
export function pitchTunnelMetrics(
  state: Readonly<PitchTunnelState>,
): Readonly<PitchTunnelMetrics> {
  const trackedSeconds = state.totals.trackedSeconds;
  const elapsedSeconds = state.elapsedSeconds;
  const meanSignedErrorCents = trackedSeconds > 0
    ? state.totals.signedErrorCentsSeconds / trackedSeconds
    : null;
  return Object.freeze({
    elapsedSeconds,
    currentDistanceCents: state.currentErrorCents,
    currentAbsoluteErrorCents: state.currentAbsoluteErrorCents,
    timeInLaneSeconds: state.totals.inLaneSeconds,
    inLaneRatio: trackedSeconds > 0 ? state.totals.inLaneSeconds / trackedSeconds : 0,
    trackedSeconds,
    trackingCoverage: elapsedSeconds > 0 ? trackedSeconds / elapsedSeconds : 0,
    trackingLossSeconds: state.trackingLossSeconds,
    trackingLossEvents: state.trackingLossEvents,
    meanSignedErrorCents,
    meanAbsoluteErrorCents: trackedSeconds > 0
      ? state.totals.absoluteErrorCentsSeconds / trackedSeconds
      : null,
    rmsErrorCents: trackedSeconds > 0
      ? Math.sqrt(state.totals.squaredErrorCentsSeconds / trackedSeconds)
      : null,
    stabilityCents: stabilityCents(state.totals),
    overshootCount: state.overshootCount,
    currentCorrectionLatencySeconds: state.checkpoint?.correctionLatencySeconds ?? null,
    meanCorrectionLatencySeconds: state.correctedCheckpointCount > 0
      ? state.correctionLatencyTotalSeconds / state.correctedCheckpointCount
      : null,
  });
}
