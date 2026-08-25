import { MICROPHONE_ANALYSIS_HOP_SECONDS } from "@/audio/microphone";

/**
 * The capture coordinates that identify one immutable detector observation.
 * Derived consumers may add fields, but they may not redefine this identity.
 */
export interface ObservationSampleCoordinates {
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly discontinuity: boolean;
  readonly processedSampleCount: number;
  readonly workletProcessCount: number;
}

/** A validated observation identity retained between reducer calls. */
export interface ObservationSampleAuthority {
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly processedSampleCount: number;
  readonly workletProcessCount: number;
}

export type ObservationContinuityReason =
  | "initial"
  | "contiguous"
  | "discontinuity"
  | "authority-change"
  | "missing-window"
  | "duplicate-or-reordered"
  | "authority-regression"
  | "invalid";

export interface ObservationContinuity {
  /** False observations have no authority to replace a newer retained frame. */
  readonly accepted: boolean;
  /** True only for the exact next overlapping detector window. */
  readonly contiguous: boolean;
  /** Every accepted noncontiguous observation establishes fresh authority. */
  readonly boundary: boolean;
  readonly reason: ObservationContinuityReason;
  readonly deltaSamples: number;
  readonly deltaSeconds: number;
  readonly authority: Readonly<ObservationSampleAuthority> | null;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validAuthorityFields(value: Readonly<Partial<ObservationSampleAuthority>>): boolean {
  return Number.isFinite(value.sampleRate)
    && (value.sampleRate ?? 0) > 0
    && nonNegativeSafeInteger(value.startSample)
    && nonNegativeSafeInteger(value.endSample)
    && value.endSample! > value.startSample!
    && nonNegativeSafeInteger(value.captureEpoch)
    && nonNegativeSafeInteger(value.continuityEpoch)
    && nonNegativeSafeInteger(value.graphGeneration)
    && nonNegativeSafeInteger(value.processedSampleCount)
    && value.processedSampleCount === value.endSample
    && nonNegativeSafeInteger(value.workletProcessCount);
}

/** Validate and retain the exact capture identity without rewriting it. */
export function observationAuthority(
  observation: Readonly<ObservationSampleCoordinates> | null | undefined,
): Readonly<ObservationSampleAuthority> | null {
  if (
    typeof observation !== "object"
    || observation === null
    || typeof observation.discontinuity !== "boolean"
    || !validAuthorityFields(observation)
  ) {
    return null;
  }
  return Object.freeze({
    sampleRate: observation.sampleRate,
    startSample: observation.startSample,
    endSample: observation.endSample,
    captureEpoch: observation.captureEpoch,
    continuityEpoch: observation.continuityEpoch,
    graphGeneration: observation.graphGeneration,
    processedSampleCount: observation.processedSampleCount,
    workletProcessCount: observation.workletProcessCount,
  });
}

export function sameObservationStream(
  previous: Readonly<ObservationSampleAuthority>,
  current: Readonly<ObservationSampleAuthority>,
): boolean {
  return previous.sampleRate === current.sampleRate
    && previous.captureEpoch === current.captureEpoch
    && previous.continuityEpoch === current.continuityEpoch
    && previous.graphGeneration === current.graphGeneration;
}

function result(
  accepted: boolean,
  contiguous: boolean,
  reason: ObservationContinuityReason,
  authority: Readonly<ObservationSampleAuthority> | null,
  deltaSamples = 0,
): ObservationContinuity {
  return Object.freeze({
    accepted,
    contiguous,
    boundary: accepted && !contiguous,
    reason,
    deltaSamples,
    deltaSeconds: contiguous && authority !== null
      ? deltaSamples / authority.sampleRate
      : 0,
    authority,
  });
}

/**
 * Compare one observation with the retained sample authority. Only the exact
 * next overlapping 20 ms detector hop is continuous. Gaps and changed
 * authority are accepted as fresh evidence but receive zero catch-up time;
 * invalid, duplicate, reordered, or regressed authority cannot replace the
 * newer retained observation.
 */
export function observationContinuity(
  previous: Readonly<ObservationSampleAuthority> | null,
  observation: Readonly<ObservationSampleCoordinates> | null | undefined,
): ObservationContinuity {
  const current = observationAuthority(observation);
  if (current === null) return result(false, false, "invalid", previous);
  if (previous === null || !validAuthorityFields(previous)) {
    return result(true, false, "initial", current);
  }
  if (current.captureEpoch < previous.captureEpoch) {
    return result(false, false, "authority-regression", previous);
  }
  if (current.captureEpoch > previous.captureEpoch) {
    return result(true, false, "authority-change", current);
  }
  if (current.continuityEpoch < previous.continuityEpoch) {
    return result(false, false, "authority-regression", previous);
  }
  if (current.graphGeneration < previous.graphGeneration) {
    return result(false, false, "authority-regression", previous);
  }
  const continuityAdvanced = current.continuityEpoch > previous.continuityEpoch;
  const graphAdvanced = current.graphGeneration > previous.graphGeneration;
  if (graphAdvanced && !continuityAdvanced) {
    return result(false, false, "invalid", previous);
  }
  if (
    current.sampleRate !== previous.sampleRate
    && (!continuityAdvanced || !graphAdvanced)
  ) {
    return result(false, false, "invalid", previous);
  }

  const identityChanged = !sameObservationStream(previous, current);
  const samplesAdvanced = current.startSample > previous.startSample
    && current.endSample > previous.endSample
    && current.processedSampleCount > previous.processedSampleCount
    && current.workletProcessCount > previous.workletProcessCount;
  if (!samplesAdvanced) {
    return result(
      false,
      false,
      identityChanged ? "authority-regression" : "duplicate-or-reordered",
      previous,
    );
  }
  if (!sameObservationStream(previous, current)) {
    return result(true, false, "authority-change", current);
  }

  const startHop = current.startSample - previous.startSample;
  const endHop = current.endSample - previous.endSample;
  const previousWindow = previous.endSample - previous.startSample;
  const currentWindow = current.endSample - current.startSample;
  if (startHop !== endHop || previousWindow !== currentWindow) {
    return result(false, false, "invalid", previous);
  }
  if (observation?.discontinuity === true) {
    return result(true, false, "discontinuity", current);
  }

  const expectedHop = Math.max(
    1,
    Math.round(current.sampleRate * MICROPHONE_ANALYSIS_HOP_SECONDS),
  );
  const exactNextWindow = startHop === expectedHop
    && endHop === expectedHop
    && previousWindow === currentWindow
    && endHop < currentWindow;
  return exactNextWindow
    ? result(true, true, "contiguous", current, endHop)
    : result(true, false, "missing-window", current);
}
