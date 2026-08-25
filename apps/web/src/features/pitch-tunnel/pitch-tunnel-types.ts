import type { PitchObservation, PitchObservationKind } from "@/audio/note-input";
import { MICROPHONE_ANALYSIS_HOP_SECONDS } from "@/audio/microphone";
import type { ObservationSampleAuthority } from "@/realtime/observation-continuity";

export type PitchTunnelStatus = "idle" | "tracking" | "complete";

export const PITCH_TUNNEL_CHECKPOINT_OFFSETS = Object.freeze([
  0, 25, 50, 75, 100, 75, 50, 25, 0,
]) as readonly number[];

export const PITCH_TUNNEL_DEFAULTS = Object.freeze({
  laneHalfWidthCents: 10,
  requiredInLaneSeconds: 1,
  overshootDeadbandCents: 3,
  maximumCreditedIntervalSeconds: MICROPHONE_ANALYSIS_HOP_SECONDS * 1.5,
});

export interface PitchTunnelOptions {
  readonly checkpointOffsetsCents?: readonly number[];
  readonly laneHalfWidthCents?: number;
  readonly requiredInLaneSeconds?: number;
  readonly overshootDeadbandCents?: number;
  readonly maximumCreditedIntervalSeconds?: number;
}

export interface ResolvedPitchTunnelOptions {
  readonly checkpointOffsetsCents: readonly number[];
  readonly laneHalfWidthCents: number;
  readonly requiredInLaneSeconds: number;
  readonly overshootDeadbandCents: number;
  readonly maximumCreditedIntervalSeconds: number;
}

export type PitchTunnelAuthority = ObservationSampleAuthority;

export interface PitchTunnelAnchorCandidate {
  readonly midiFloat: number;
  readonly frequencyHz: number;
  readonly confidence: number;
  readonly supportsTrajectory: boolean;
  readonly authority: Readonly<PitchTunnelAuthority>;
}

export interface PitchTunnelErrorAccumulation {
  readonly trackedSeconds: number;
  readonly inLaneSeconds: number;
  readonly signedErrorCentsSeconds: number;
  readonly absoluteErrorCentsSeconds: number;
  readonly squaredErrorCentsSeconds: number;
}

export interface PitchTunnelCheckpointProgress extends PitchTunnelErrorAccumulation {
  readonly index: number;
  readonly targetOffsetCents: number;
  readonly targetMidiFloat: number;
  readonly enteredAtElapsedSeconds: number;
  readonly heldSeconds: number;
  readonly correctionLatencySeconds: number | null;
  readonly overshootCount: number;
  readonly lastErrorSide: -1 | 0 | 1;
}

export interface PitchTunnelCheckpointResult {
  readonly index: number;
  readonly targetOffsetCents: number;
  readonly targetMidiFloat: number;
  readonly enteredAtElapsedSeconds: number;
  readonly completedAtElapsedSeconds: number;
  readonly correctionLatencySeconds: number | null;
  readonly overshootCount: number;
  readonly trackedSeconds: number;
  readonly timeInLaneSeconds: number;
  readonly inLaneRatio: number;
  readonly meanAbsoluteErrorCents: number | null;
  readonly stabilityCents: number | null;
}

export interface PitchTunnelState {
  readonly status: PitchTunnelStatus;
  /**
   * The authored round trip has been reached, but the user still owns the
   * live session. Only an explicit `finish` action may change `status` to
   * `complete`.
   */
  readonly achievementReached: boolean;
  readonly options: Readonly<ResolvedPitchTunnelOptions>;
  readonly anchorMidiFloat: number | null;
  readonly elapsedSeconds: number;
  readonly checkpoint: Readonly<PitchTunnelCheckpointProgress> | null;
  readonly completedCheckpoints: readonly Readonly<PitchTunnelCheckpointResult>[];
  readonly latestCandidate: Readonly<PitchTunnelAnchorCandidate> | null;
  readonly currentObservationKind: PitchObservationKind | null;
  readonly currentMidiFloat: number | null;
  readonly currentPitchOffsetCents: number | null;
  readonly currentErrorCents: number | null;
  readonly currentAbsoluteErrorCents: number | null;
  readonly currentInLane: boolean | null;
  readonly currentConfidence: number;
  readonly observedFrameCount: number;
  readonly credibleFrameCount: number;
  readonly trackingLossEvents: number;
  readonly trackingLossSeconds: number;
  readonly authorityBreakCount: number;
  readonly discontinuityCount: number;
  readonly overshootCount: number;
  readonly correctedCheckpointCount: number;
  readonly correctionLatencyTotalSeconds: number;
  readonly totals: Readonly<PitchTunnelErrorAccumulation>;
  readonly lastAuthority: Readonly<PitchTunnelAuthority> | null;
  readonly previousReliable: boolean;
  readonly previousInLane: boolean;
  readonly previousErrorCents: number | null;
}

export interface PitchTunnelMetrics {
  readonly elapsedSeconds: number;
  readonly currentDistanceCents: number | null;
  readonly currentAbsoluteErrorCents: number | null;
  readonly timeInLaneSeconds: number;
  readonly inLaneRatio: number;
  readonly trackedSeconds: number;
  readonly trackingCoverage: number;
  readonly trackingLossSeconds: number;
  readonly trackingLossEvents: number;
  readonly meanSignedErrorCents: number | null;
  readonly meanAbsoluteErrorCents: number | null;
  readonly rmsErrorCents: number | null;
  readonly stabilityCents: number | null;
  readonly overshootCount: number;
  readonly currentCorrectionLatencySeconds: number | null;
  readonly meanCorrectionLatencySeconds: number | null;
}

export type PitchTunnelAction =
  | { readonly type: "observation"; readonly observation: Readonly<PitchObservation> }
  | { readonly type: "reconfigure-tolerance"; readonly toleranceCents: number }
  | { readonly type: "start" }
  | { readonly type: "finish" }
  | { readonly type: "reset" };

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function requirePositive(value: number, label: string): void {
  requireFinite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero.`);
}

export function resolvePitchTunnelOptions(
  options: Readonly<PitchTunnelOptions>,
): ResolvedPitchTunnelOptions {
  const checkpointOffsetsCents = [...(
    options.checkpointOffsetsCents ?? PITCH_TUNNEL_CHECKPOINT_OFFSETS
  )];
  if (checkpointOffsetsCents.length === 0) {
    throw new RangeError("Pitch Tunnel requires at least one checkpoint.");
  }
  for (const offset of checkpointOffsetsCents) requireFinite(offset, "Checkpoint offset");
  const laneHalfWidthCents = options.laneHalfWidthCents
    ?? PITCH_TUNNEL_DEFAULTS.laneHalfWidthCents;
  const requiredInLaneSeconds = options.requiredInLaneSeconds
    ?? PITCH_TUNNEL_DEFAULTS.requiredInLaneSeconds;
  const overshootDeadbandCents = options.overshootDeadbandCents
    ?? PITCH_TUNNEL_DEFAULTS.overshootDeadbandCents;
  const maximumCreditedIntervalSeconds = options.maximumCreditedIntervalSeconds
    ?? PITCH_TUNNEL_DEFAULTS.maximumCreditedIntervalSeconds;
  requirePositive(laneHalfWidthCents, "Lane half-width");
  requirePositive(requiredInLaneSeconds, "Required in-lane duration");
  requireFinite(overshootDeadbandCents, "Overshoot deadband");
  if (overshootDeadbandCents < 0 || overshootDeadbandCents >= laneHalfWidthCents) {
    throw new RangeError("Overshoot deadband must be non-negative and narrower than the lane.");
  }
  requirePositive(maximumCreditedIntervalSeconds, "Maximum credited interval");
  return Object.freeze({
    checkpointOffsetsCents: Object.freeze(checkpointOffsetsCents),
    laneHalfWidthCents,
    requiredInLaneSeconds,
    overshootDeadbandCents,
    maximumCreditedIntervalSeconds,
  });
}
