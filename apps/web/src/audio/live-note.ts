import type { PitchObservationKind } from "./note-input";
import {
  observationAuthority,
  observationContinuity,
} from "@/realtime/observation-continuity";

export type { PitchObservationKind } from "./note-input";

/**
 * The structural subset of a capture observation needed for musical note
 * tracking. Capture owns these coordinates; the tracker never controls it.
 */
export interface TrackablePitchObservation {
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly processedSampleCount: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly workletProcessCount: number;
  readonly discontinuity: boolean;
  readonly observationKind: PitchObservationKind;
  readonly frequencyHz: number | null;
  readonly midiFloat: number | null;
  readonly nearestMidi: number | null;
  readonly centsFromNearest: number | null;
  readonly confidence: number;
}

/** The current voiced observation plus its continuous same-note occupancy. */
export interface LiveNote {
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly processedSampleCount: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly workletProcessCount: number;
  readonly frequencyHz: number;
  readonly midiFloat: number;
  readonly nearestMidi: number;
  readonly centsFromNearest: number;
  readonly confidence: number;
  readonly enteredAtSample: number;
  readonly heldSamples: number;
  readonly heldSeconds: number;
  readonly stable: boolean;
}

export interface LiveNoteTrackerOptions {
  readonly stableAfterSeconds: number;
}

export const DEFAULT_LIVE_NOTE_TRACKER_OPTIONS = Object.freeze({
  stableAfterSeconds: 0.1,
}) satisfies Readonly<LiveNoteTrackerOptions>;

const MAXIMUM_SAMPLE_RATE = 1_000_000;
const MAXIMUM_ABSOLUTE_CENTS = 50.001;
const COORDINATE_TOLERANCE_CENTS = 0.001;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidSampleRate(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0 && value <= MAXIMUM_SAMPLE_RATE;
}

function isValidEpoch(value: unknown): value is number {
  return isSafeNonNegativeInteger(value);
}

function hasValidWindowCoordinates(
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & {
  readonly startSample: number;
  readonly endSample: number;
} {
  return isSafeNonNegativeInteger(value.startSample)
    && isSafeNonNegativeInteger(value.endSample)
    && value.endSample > value.startSample;
}

function isValidConfidence(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function hasValidVoicedCoordinates(
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & {
  readonly frequencyHz: number;
  readonly midiFloat: number;
  readonly nearestMidi: number;
  readonly centsFromNearest: number;
} {
  if (
    !isFiniteNumber(value.frequencyHz)
    || value.frequencyHz <= 0
    || !isFiniteNumber(value.midiFloat)
    || !Number.isSafeInteger(value.nearestMidi)
    || (value.nearestMidi as number) < 0
    || (value.nearestMidi as number) > 127
    || !isFiniteNumber(value.centsFromNearest)
    || Math.abs(value.centsFromNearest) > MAXIMUM_ABSOLUTE_CENTS
  ) {
    return false;
  }

  const coordinateCents = (value.midiFloat - (value.nearestMidi as number)) * 100;
  return Math.abs(coordinateCents - value.centsFromNearest)
    <= COORDINATE_TOLERANCE_CENTS;
}

function isValidVoicedObservation(
  value: unknown,
): value is Readonly<TrackablePitchObservation> & {
  readonly observationKind: "voiced";
  readonly frequencyHz: number;
  readonly midiFloat: number;
  readonly nearestMidi: number;
  readonly centsFromNearest: number;
} {
  if (!isRecord(value)) return false;
  return value.observationKind === "voiced"
    && typeof value.discontinuity === "boolean"
    && isValidSampleRate(value.sampleRate)
    && hasValidWindowCoordinates(value)
    && isValidEpoch(value.captureEpoch)
    && isValidEpoch(value.continuityEpoch)
    && isValidEpoch(value.graphGeneration)
    && isSafeNonNegativeInteger(value.processedSampleCount)
    && value.processedSampleCount === value.endSample
    && isSafeNonNegativeInteger(value.workletProcessCount)
    && isValidConfidence(value.confidence)
    && hasValidVoicedCoordinates(value)
    && value.frequencyHz <= value.sampleRate / 2;
}

function isValidTrackableObservation(
  value: unknown,
): value is Readonly<TrackablePitchObservation> {
  if (!isRecord(value)) return false;
  if (
    value.observationKind !== "voiced"
    && value.observationKind !== "unvoiced"
    && value.observationKind !== "uncertain"
  ) return false;
  if (!isValidConfidence(value.confidence)) return false;
  return observationAuthority(value as unknown as TrackablePitchObservation) !== null;
}

function isValidPreviousLiveNote(value: unknown): value is Readonly<LiveNote> {
  if (!isRecord(value)) return false;
  if (
    !isValidSampleRate(value.sampleRate)
    || !hasValidWindowCoordinates(value)
    || !isValidEpoch(value.captureEpoch)
    || !isValidEpoch(value.continuityEpoch)
    || !isValidEpoch(value.graphGeneration)
    || !isSafeNonNegativeInteger(value.processedSampleCount)
    || value.processedSampleCount !== value.endSample
    || !isSafeNonNegativeInteger(value.workletProcessCount)
    || !isValidConfidence(value.confidence)
    || !hasValidVoicedCoordinates(value)
    || !isSafeNonNegativeInteger(value.enteredAtSample)
    || !isSafeNonNegativeInteger(value.heldSamples)
    || !isFiniteNumber(value.heldSeconds)
    || value.heldSeconds < 0
    || typeof value.stable !== "boolean"
  ) {
    return false;
  }

  const expectedHeldSamples = value.endSample - value.enteredAtSample;
  return expectedHeldSamples >= 0
    && value.heldSamples === expectedHeldSamples
    && Math.abs(value.heldSeconds - value.heldSamples / value.sampleRate)
      <= Number.EPSILON * Math.max(1, value.heldSeconds);
}

function resolveOptions(
  options: Readonly<LiveNoteTrackerOptions>,
): Readonly<LiveNoteTrackerOptions> {
  if (!isRecord(options)) {
    throw new TypeError("live-note tracker options must be an object");
  }
  if (
    !isFiniteNumber(options.stableAfterSeconds)
    || options.stableAfterSeconds < 0
  ) {
    throw new RangeError("stableAfterSeconds must be finite and non-negative");
  }
  return options;
}

/**
 * Pure downstream reducer for the current note. Silence and uncertainty clear
 * note occupancy but never imply anything about capture health.
 *
 * The first credible observation enters at its end sample. Later overlapping
 * windows advance by their sample-coordinate hop, so window overlap is never
 * double-counted as hold time.
 */
export function reduceLiveNote(
  previous: Readonly<LiveNote> | null,
  observation: Readonly<TrackablePitchObservation>,
  options: Readonly<LiveNoteTrackerOptions> = DEFAULT_LIVE_NOTE_TRACKER_OPTIONS,
): Readonly<LiveNote> | null {
  const resolvedOptions = resolveOptions(options);
  if (!isValidTrackableObservation(observation)) return null;
  const voicedObservation = isValidVoicedObservation(observation);
  if (observation.observationKind === "voiced" && !voicedObservation) return null;
  const validPrevious = isValidPreviousLiveNote(previous) ? previous : null;
  const continuity = observationContinuity(validPrevious, observation);
  if (validPrevious !== null && !continuity.accepted && continuity.reason !== "invalid") {
    return validPrevious;
  }
  if (!voicedObservation) return null;

  const mayContinue = validPrevious !== null
    && observation.nearestMidi === validPrevious.nearestMidi
    && continuity.contiguous;
  const enteredAtSample = mayContinue
    ? validPrevious.enteredAtSample
    : observation.endSample;
  const heldSamples = observation.endSample - enteredAtSample;
  const heldSeconds = heldSamples / observation.sampleRate;

  return Object.freeze({
    sampleRate: observation.sampleRate,
    startSample: observation.startSample,
    endSample: observation.endSample,
    processedSampleCount: observation.processedSampleCount,
    captureEpoch: observation.captureEpoch,
    continuityEpoch: observation.continuityEpoch,
    graphGeneration: observation.graphGeneration,
    workletProcessCount: observation.workletProcessCount,
    frequencyHz: observation.frequencyHz,
    midiFloat: observation.midiFloat,
    nearestMidi: observation.nearestMidi,
    centsFromNearest: observation.centsFromNearest,
    confidence: observation.confidence,
    enteredAtSample,
    heldSamples,
    heldSeconds,
    stable: heldSeconds >= resolvedOptions.stableAfterSeconds,
  });
}
