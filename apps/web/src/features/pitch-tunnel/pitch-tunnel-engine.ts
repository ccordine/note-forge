import type { PitchObservation } from "@/audio/note-input";
import {
  type PitchTunnelAction,
  type PitchTunnelAnchorCandidate,
  type PitchTunnelAuthority,
  type PitchTunnelCheckpointProgress,
  type PitchTunnelCheckpointResult,
  type PitchTunnelErrorAccumulation,
  type PitchTunnelOptions,
  type PitchTunnelState,
  type ResolvedPitchTunnelOptions,
  resolvePitchTunnelOptions,
} from "./pitch-tunnel-types";

export * from "./pitch-tunnel-types";
export { pitchTunnelMetrics } from "./pitch-tunnel-metrics";

const MINIMUM_FREQUENCY_HZ = 45;
const MAXIMUM_FREQUENCY_HZ = 1_200;
const EPSILON = 1e-9;
const EMPTY_ACCUMULATION = Object.freeze({
  trackedSeconds: 0,
  inLaneSeconds: 0,
  signedErrorCentsSeconds: 0,
  absoluteErrorCentsSeconds: 0,
  squaredErrorCentsSeconds: 0,
}) satisfies PitchTunnelErrorAccumulation;

function freezeState(state: PitchTunnelState): PitchTunnelState {
  return Object.freeze(state);
}

function midiToFrequency(midiFloat: number): number {
  return 440 * 2 ** ((midiFloat - 69) / 12);
}

function validAuthority(observation: Readonly<PitchObservation>): boolean {
  return Number.isFinite(observation.sampleRate)
    && observation.sampleRate > 0
    && Number.isSafeInteger(observation.startSample)
    && observation.startSample >= 0
    && Number.isSafeInteger(observation.endSample)
    && observation.endSample > observation.startSample
    && Number.isSafeInteger(observation.processedSampleCount)
    && observation.processedSampleCount === observation.endSample
    && Number.isSafeInteger(observation.captureEpoch)
    && observation.captureEpoch >= 0
    && Number.isSafeInteger(observation.continuityEpoch)
    && observation.continuityEpoch >= 0
    && Number.isSafeInteger(observation.graphGeneration)
    && observation.graphGeneration >= 0
    && Number.isSafeInteger(observation.workletProcessCount)
    && observation.workletProcessCount >= 0;
}

function authorityFor(observation: Readonly<PitchObservation>): PitchTunnelAuthority {
  return Object.freeze({
    sampleRate: observation.sampleRate,
    startSample: observation.startSample,
    endSample: observation.endSample,
    processedSampleCount: observation.processedSampleCount,
    captureEpoch: observation.captureEpoch,
    continuityEpoch: observation.continuityEpoch,
    graphGeneration: observation.graphGeneration,
    workletProcessCount: observation.workletProcessCount,
  });
}

function sameStream(
  previous: Readonly<PitchTunnelAuthority>,
  observation: Readonly<PitchObservation>,
): boolean {
  return previous.sampleRate === observation.sampleRate
    && previous.captureEpoch === observation.captureEpoch
    && previous.continuityEpoch === observation.continuityEpoch
    && previous.graphGeneration === observation.graphGeneration;
}

function reliable(
  observation: Readonly<PitchObservation>,
): observation is Readonly<PitchObservation> & { midiFloat: number; frequencyHz: number } {
  return observation.observationKind === "voiced"
    && observation.voiced
    && observation.midiFloat !== null
    && Number.isFinite(observation.midiFloat)
    && observation.frequencyHz !== null
    && Number.isFinite(observation.frequencyHz);
}

function supportsTrajectory(
  midiFloat: number,
  offsets: readonly number[],
): boolean {
  return offsets.every((offset) => {
    const frequency = midiToFrequency(midiFloat + offset / 100);
    return frequency >= MINIMUM_FREQUENCY_HZ && frequency <= MAXIMUM_FREQUENCY_HZ;
  });
}

function candidateFor(
  observation: Readonly<PitchObservation>,
  options: Readonly<ResolvedPitchTunnelOptions>,
): PitchTunnelAnchorCandidate | null {
  if (!reliable(observation)) return null;
  return Object.freeze({
    midiFloat: observation.midiFloat,
    frequencyHz: observation.frequencyHz,
    confidence: Number.isFinite(observation.confidence)
      ? Math.max(0, Math.min(1, observation.confidence))
      : 0,
    supportsTrajectory: supportsTrajectory(
      observation.midiFloat,
      options.checkpointOffsetsCents,
    ),
    authority: authorityFor(observation),
  });
}

function errorSide(errorCents: number, deadbandCents: number): -1 | 0 | 1 {
  if (errorCents < -deadbandCents) return -1;
  if (errorCents > deadbandCents) return 1;
  return 0;
}

function createCheckpoint(
  options: Readonly<ResolvedPitchTunnelOptions>,
  anchorMidiFloat: number,
  index: number,
  elapsedSeconds: number,
  currentMidiFloat: number | null,
): PitchTunnelCheckpointProgress {
  const targetOffsetCents = options.checkpointOffsetsCents[index]!;
  const errorCents = currentMidiFloat === null
    ? null
    : (currentMidiFloat - anchorMidiFloat) * 100 - targetOffsetCents;
  const inLane = errorCents !== null
    && Math.abs(errorCents) <= options.laneHalfWidthCents + EPSILON;
  return Object.freeze({
    ...EMPTY_ACCUMULATION,
    index,
    targetOffsetCents,
    targetMidiFloat: anchorMidiFloat + targetOffsetCents / 100,
    enteredAtElapsedSeconds: elapsedSeconds,
    heldSeconds: 0,
    correctionLatencySeconds: inLane ? 0 : null,
    overshootCount: 0,
    lastErrorSide: errorCents === null
      ? 0
      : errorSide(errorCents, options.overshootDeadbandCents),
  });
}

export function createPitchTunnel(
  options: Readonly<PitchTunnelOptions> = {},
): PitchTunnelState {
  return freezeState({
    status: "idle",
    options: resolvePitchTunnelOptions(options),
    anchorMidiFloat: null,
    elapsedSeconds: 0,
    checkpoint: null,
    completedCheckpoints: Object.freeze([]),
    latestCandidate: null,
    currentObservationKind: null,
    currentMidiFloat: null,
    currentPitchOffsetCents: null,
    currentErrorCents: null,
    currentAbsoluteErrorCents: null,
    currentInLane: null,
    currentConfidence: 0,
    observedFrameCount: 0,
    credibleFrameCount: 0,
    trackingLossEvents: 0,
    trackingLossSeconds: 0,
    authorityBreakCount: 0,
    discontinuityCount: 0,
    overshootCount: 0,
    correctedCheckpointCount: 0,
    correctionLatencyTotalSeconds: 0,
    totals: EMPTY_ACCUMULATION,
    lastAuthority: null,
    previousReliable: false,
    previousInLane: false,
    previousErrorCents: null,
  });
}

function currentFields(
  state: Readonly<PitchTunnelState>,
  observation: Readonly<PitchObservation>,
): Pick<
  PitchTunnelState,
  | "currentObservationKind"
  | "currentMidiFloat"
  | "currentPitchOffsetCents"
  | "currentErrorCents"
  | "currentAbsoluteErrorCents"
  | "currentInLane"
  | "currentConfidence"
> & { readonly reliable: boolean } {
  const isReliable = reliable(observation);
  const midiFloat = isReliable ? observation.midiFloat : null;
  const pitchOffsetCents = midiFloat === null || state.anchorMidiFloat === null
    ? null
    : (midiFloat - state.anchorMidiFloat) * 100;
  const errorCents = pitchOffsetCents === null || state.checkpoint === null
    ? null
    : pitchOffsetCents - state.checkpoint.targetOffsetCents;
  return {
    currentObservationKind: observation.observationKind,
    currentMidiFloat: midiFloat,
    currentPitchOffsetCents: pitchOffsetCents,
    currentErrorCents: errorCents,
    currentAbsoluteErrorCents: errorCents === null ? null : Math.abs(errorCents),
    currentInLane: errorCents === null
      ? null
      : Math.abs(errorCents) <= state.options.laneHalfWidthCents + EPSILON,
    currentConfidence: Number.isFinite(observation.confidence)
      ? Math.max(0, Math.min(1, observation.confidence))
      : 0,
    reliable: isReliable,
  };
}

function observeWhileIdle(
  state: Readonly<PitchTunnelState>,
  observation: Readonly<PitchObservation>,
): PitchTunnelState {
  if (!validAuthority(observation)) return state as PitchTunnelState;
  if (
    state.lastAuthority
    && sameStream(state.lastAuthority, observation)
    && (
      observation.endSample <= state.lastAuthority.endSample
      || observation.workletProcessCount <= state.lastAuthority.workletProcessCount
    )
  ) return state as PitchTunnelState;
  const fields = currentFields(state, observation);
  const candidate = candidateFor(observation, state.options);
  const authority = candidate?.authority ?? authorityFor(observation);
  return freezeState({
    ...state,
    ...fields,
    latestCandidate: candidate ?? state.latestCandidate,
    observedFrameCount: state.observedFrameCount + 1,
    credibleFrameCount: state.credibleFrameCount + (fields.reliable ? 1 : 0),
    discontinuityCount: state.discontinuityCount + (observation.discontinuity ? 1 : 0),
    lastAuthority: authority,
    previousReliable: fields.reliable,
  });
}

export function startPitchTunnel(
  state: Readonly<PitchTunnelState>,
): PitchTunnelState {
  const candidate = state.latestCandidate;
  if (
    state.status !== "idle"
    || !candidate?.supportsTrajectory
    || state.currentObservationKind !== "voiced"
    || state.currentMidiFloat === null
    || candidate.authority !== state.lastAuthority
  ) return state as PitchTunnelState;
  const checkpoint = createCheckpoint(
    state.options,
    candidate.midiFloat,
    0,
    0,
    candidate.midiFloat,
  );
  return freezeState({
    ...createPitchTunnel(state.options),
    status: "tracking",
    anchorMidiFloat: candidate.midiFloat,
    checkpoint,
    latestCandidate: candidate,
    currentObservationKind: "voiced",
    currentMidiFloat: candidate.midiFloat,
    currentPitchOffsetCents: 0,
    currentErrorCents: 0,
    currentAbsoluteErrorCents: 0,
    currentInLane: true,
    currentConfidence: candidate.confidence,
    observedFrameCount: 1,
    credibleFrameCount: 1,
    lastAuthority: candidate.authority,
    previousReliable: true,
    previousInLane: true,
    previousErrorCents: 0,
  });
}

function accumulateErrors(
  accumulation: Readonly<PitchTunnelErrorAccumulation>,
  previousErrorCents: number,
  currentErrorCents: number,
  deltaSeconds: number,
  inLane: boolean,
): PitchTunnelErrorAccumulation {
  const signedMean = (previousErrorCents + currentErrorCents) / 2;
  const squaredMean = (
    previousErrorCents ** 2
    + previousErrorCents * currentErrorCents
    + currentErrorCents ** 2
  ) / 3;
  const oppositeSigns = previousErrorCents * currentErrorCents < 0;
  const absoluteMean = oppositeSigns
    ? (
      previousErrorCents ** 2 + currentErrorCents ** 2
    ) / (2 * (Math.abs(previousErrorCents) + Math.abs(currentErrorCents)))
    : (Math.abs(previousErrorCents) + Math.abs(currentErrorCents)) / 2;
  return Object.freeze({
    trackedSeconds: accumulation.trackedSeconds + deltaSeconds,
    inLaneSeconds: accumulation.inLaneSeconds + (inLane ? deltaSeconds : 0),
    signedErrorCentsSeconds:
      accumulation.signedErrorCentsSeconds + signedMean * deltaSeconds,
    absoluteErrorCentsSeconds:
      accumulation.absoluteErrorCentsSeconds + absoluteMean * deltaSeconds,
    squaredErrorCentsSeconds:
      accumulation.squaredErrorCentsSeconds + squaredMean * deltaSeconds,
  });
}

function standardDeviation(
  accumulation: Readonly<PitchTunnelErrorAccumulation>,
): number | null {
  if (accumulation.trackedSeconds <= 0) return null;
  const mean = accumulation.signedErrorCentsSeconds / accumulation.trackedSeconds;
  const meanSquare = accumulation.squaredErrorCentsSeconds / accumulation.trackedSeconds;
  return Math.sqrt(Math.max(0, meanSquare - mean ** 2));
}

function checkpointResult(
  checkpoint: Readonly<PitchTunnelCheckpointProgress>,
  elapsedSeconds: number,
): PitchTunnelCheckpointResult {
  const trackedSeconds = checkpoint.trackedSeconds;
  return Object.freeze({
    index: checkpoint.index,
    targetOffsetCents: checkpoint.targetOffsetCents,
    targetMidiFloat: checkpoint.targetMidiFloat,
    enteredAtElapsedSeconds: checkpoint.enteredAtElapsedSeconds,
    completedAtElapsedSeconds: elapsedSeconds,
    correctionLatencySeconds: checkpoint.correctionLatencySeconds,
    overshootCount: checkpoint.overshootCount,
    trackedSeconds,
    timeInLaneSeconds: checkpoint.inLaneSeconds,
    inLaneRatio: trackedSeconds > 0 ? checkpoint.inLaneSeconds / trackedSeconds : 0,
    meanAbsoluteErrorCents: trackedSeconds > 0
      ? checkpoint.absoluteErrorCentsSeconds / trackedSeconds
      : null,
    stabilityCents: standardDeviation(checkpoint),
  });
}

function advanceTracking(
  state: Readonly<PitchTunnelState>,
  observation: Readonly<PitchObservation>,
): PitchTunnelState {
  if (!validAuthority(observation) || !state.lastAuthority || !state.checkpoint) {
    return state as PitchTunnelState;
  }
  const previousAuthority = state.lastAuthority;
  if (
    sameStream(previousAuthority, observation)
    && (
      observation.endSample <= previousAuthority.endSample
      || observation.workletProcessCount <= previousAuthority.workletProcessCount
    )
  ) return state as PitchTunnelState;

  const fields = currentFields(state, observation);
  const candidate = candidateFor(observation, state.options);
  const authority = candidate?.authority ?? authorityFor(observation);
  const sameAuthority = sameStream(previousAuthority, observation);
  const rawDeltaSeconds = sameAuthority
    ? (observation.endSample - previousAuthority.endSample) / observation.sampleRate
    : 0;
  const continuous = sameAuthority
    && !observation.discontinuity
    && rawDeltaSeconds > 0
    && rawDeltaSeconds <= state.options.maximumCreditedIntervalSeconds + EPSILON;
  const deltaSeconds = continuous ? rawDeltaSeconds : 0;
  const trackable = continuous
    && state.previousReliable
    && fields.reliable
    && state.previousErrorCents !== null
    && fields.currentErrorCents !== null;
  const qualified = trackable
    && state.previousInLane
    && fields.currentInLane === true;
  const crossed = trackable
    && state.checkpoint.lastErrorSide !== 0
    && errorSide(fields.currentErrorCents!, state.options.overshootDeadbandCents) !== 0
    && errorSide(fields.currentErrorCents!, state.options.overshootDeadbandCents)
      !== state.checkpoint.lastErrorSide;
  const nextSide = !fields.reliable || fields.currentErrorCents === null
    ? 0
    : errorSide(fields.currentErrorCents, state.options.overshootDeadbandCents);
  const retainedSide = nextSide === 0 ? state.checkpoint.lastErrorSide : nextSide;
  const correctedNow = continuous
    && state.checkpoint.correctionLatencySeconds === null
    && fields.currentInLane === true;
  const correctionLatencySeconds = correctedNow
    ? state.elapsedSeconds + deltaSeconds - state.checkpoint.enteredAtElapsedSeconds
    : state.checkpoint.correctionLatencySeconds;
  const checkpointErrors = trackable
    ? accumulateErrors(
      state.checkpoint,
      state.previousErrorCents!,
      fields.currentErrorCents!,
      deltaSeconds,
      qualified,
    )
    : state.checkpoint;
  const totals = trackable
    ? accumulateErrors(
      state.totals,
      state.previousErrorCents!,
      fields.currentErrorCents!,
      deltaSeconds,
      qualified,
    )
    : state.totals;
  const credibleOutsideLane = fields.reliable && fields.currentInLane === false;
  const heldSeconds = credibleOutsideLane
    ? 0
    : Math.min(
      state.options.requiredInLaneSeconds,
      state.checkpoint.heldSeconds + (qualified ? deltaSeconds : 0),
    );
  const checkpoint: PitchTunnelCheckpointProgress = Object.freeze({
    ...state.checkpoint,
    ...checkpointErrors,
    heldSeconds,
    correctionLatencySeconds,
    overshootCount: state.checkpoint.overshootCount + (crossed ? 1 : 0),
    lastErrorSide: trackable ? retainedSide : 0,
  });
  const elapsedSeconds = state.elapsedSeconds + deltaSeconds;
  const correctedCheckpointCount = state.correctedCheckpointCount + (correctedNow ? 1 : 0);
  const correctionLatencyTotalSeconds = state.correctionLatencyTotalSeconds
    + (correctedNow ? correctionLatencySeconds! : 0);
  const common = {
    ...state,
    ...fields,
    latestCandidate: candidate ?? state.latestCandidate,
    elapsedSeconds,
    checkpoint,
    observedFrameCount: state.observedFrameCount + 1,
    credibleFrameCount: state.credibleFrameCount + (fields.reliable ? 1 : 0),
    trackingLossEvents: state.trackingLossEvents
      + (!fields.reliable && state.previousReliable ? 1 : 0),
    trackingLossSeconds: state.trackingLossSeconds + (continuous && !trackable ? deltaSeconds : 0),
    authorityBreakCount: state.authorityBreakCount + (!continuous ? 1 : 0),
    discontinuityCount: state.discontinuityCount + (observation.discontinuity ? 1 : 0),
    overshootCount: state.overshootCount + (crossed ? 1 : 0),
    correctedCheckpointCount,
    correctionLatencyTotalSeconds,
    totals,
    lastAuthority: authority,
    previousReliable: fields.reliable,
    previousInLane: fields.currentInLane === true,
    previousErrorCents: fields.currentErrorCents,
  } satisfies PitchTunnelState;
  if (heldSeconds + EPSILON < state.options.requiredInLaneSeconds) {
    return freezeState(common);
  }

  const completedCheckpoints = Object.freeze([
    ...state.completedCheckpoints,
    checkpointResult(checkpoint, elapsedSeconds),
  ]);
  const nextIndex = checkpoint.index + 1;
  if (nextIndex >= state.options.checkpointOffsetsCents.length) {
    return freezeState({ ...common, status: "complete", completedCheckpoints });
  }
  const nextCheckpoint = createCheckpoint(
    state.options,
    state.anchorMidiFloat!,
    nextIndex,
    elapsedSeconds,
    fields.currentMidiFloat,
  );
  const nextErrorCents = fields.currentPitchOffsetCents! - nextCheckpoint.targetOffsetCents;
  const nextInLane = Math.abs(nextErrorCents) <= state.options.laneHalfWidthCents + EPSILON;
  const nextCorrected = nextCheckpoint.correctionLatencySeconds === 0;
  return freezeState({
    ...common,
    completedCheckpoints,
    checkpoint: nextCheckpoint,
    currentErrorCents: nextErrorCents,
    currentAbsoluteErrorCents: Math.abs(nextErrorCents),
    currentInLane: nextInLane,
    previousInLane: nextInLane,
    previousErrorCents: nextErrorCents,
    correctedCheckpointCount: correctedCheckpointCount + (nextCorrected ? 1 : 0),
  });
}

export function observePitchTunnel(
  state: Readonly<PitchTunnelState>,
  observation: Readonly<PitchObservation>,
): PitchTunnelState {
  if (state.status === "complete") return observeAfterCompletion(state, observation);
  return state.status === "idle"
    ? observeWhileIdle(state, observation)
    : advanceTracking(state, observation);
}

function observeAfterCompletion(
  state: Readonly<PitchTunnelState>,
  observation: Readonly<PitchObservation>,
): PitchTunnelState {
  if (!validAuthority(observation) || !state.lastAuthority) return state as PitchTunnelState;
  if (
    sameStream(state.lastAuthority, observation)
    && (
      observation.endSample <= state.lastAuthority.endSample
      || observation.workletProcessCount <= state.lastAuthority.workletProcessCount
    )
  ) return state as PitchTunnelState;
  const fields = currentFields(state, observation);
  const candidate = candidateFor(observation, state.options);
  const authority = candidate?.authority ?? authorityFor(observation);
  const continuous = sameStream(state.lastAuthority, observation)
    && !observation.discontinuity
    && (observation.endSample - state.lastAuthority.endSample) / observation.sampleRate
      <= state.options.maximumCreditedIntervalSeconds + EPSILON;
  return freezeState({
    ...state,
    ...fields,
    latestCandidate: candidate ?? state.latestCandidate,
    observedFrameCount: state.observedFrameCount + 1,
    credibleFrameCount: state.credibleFrameCount + (fields.reliable ? 1 : 0),
    authorityBreakCount: state.authorityBreakCount + (continuous ? 0 : 1),
    discontinuityCount: state.discontinuityCount + (observation.discontinuity ? 1 : 0),
    lastAuthority: authority,
    previousReliable: fields.reliable,
    previousInLane: fields.currentInLane === true,
    previousErrorCents: fields.currentErrorCents,
  });
}

export function resetPitchTunnel(state: Readonly<PitchTunnelState>): PitchTunnelState {
  const reset = createPitchTunnel(state.options);
  return freezeState({
    ...reset,
    latestCandidate: state.latestCandidate,
    currentObservationKind: state.currentObservationKind,
    currentMidiFloat: state.currentMidiFloat,
    currentConfidence: state.currentConfidence,
    lastAuthority: state.lastAuthority,
  });
}

export function reducePitchTunnel(
  state: Readonly<PitchTunnelState>,
  action: Readonly<PitchTunnelAction>,
): PitchTunnelState {
  switch (action.type) {
    case "observation":
      return observePitchTunnel(state, action.observation);
    case "start":
      return startPitchTunnel(state);
    case "reset":
      return resetPitchTunnel(state);
  }
}
