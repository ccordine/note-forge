import type { PitchObservationKind } from "./note-input";

export type { PitchObservationKind } from "./note-input";

/**
 * The structural subset of a capture observation needed for musical note
 * tracking. Capture owns these coordinates; the tracker never controls it.
 */
export interface TrackablePitchObservation {
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
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
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
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

const MAXIMUM_STABLE_AFTER_SECONDS = 60;
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
    && isValidConfidence(value.confidence)
    && hasValidVoicedCoordinates(value)
    && value.frequencyHz <= value.sampleRate / 2;
}

function isValidPreviousLiveNote(value: unknown): value is Readonly<LiveNote> {
  if (!isRecord(value)) return false;
  if (
    !isValidSampleRate(value.sampleRate)
    || !hasValidWindowCoordinates(value)
    || !isValidEpoch(value.captureEpoch)
    || !isValidEpoch(value.continuityEpoch)
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
    || options.stableAfterSeconds > MAXIMUM_STABLE_AFTER_SECONDS
  ) {
    throw new RangeError(
      `stableAfterSeconds must be between 0 and ${MAXIMUM_STABLE_AFTER_SECONDS}`,
    );
  }
  return options;
}

function continuesPreviousNote(
  previous: Readonly<LiveNote>,
  observation: Readonly<TrackablePitchObservation> & {
    readonly observationKind: "voiced";
    readonly nearestMidi: number;
  },
): boolean {
  return !observation.discontinuity
    && observation.captureEpoch === previous.captureEpoch
    && observation.continuityEpoch === previous.continuityEpoch
    && observation.sampleRate === previous.sampleRate
    && observation.nearestMidi === previous.nearestMidi
    && observation.startSample > previous.startSample
    && observation.endSample > previous.endSample
    && observation.startSample <= previous.endSample;
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
  if (!isValidVoicedObservation(observation)) return null;

  const mayContinue = isValidPreviousLiveNote(previous)
    && continuesPreviousNote(previous, observation);
  const enteredAtSample = mayContinue
    ? previous.enteredAtSample
    : observation.endSample;
  const heldSamples = observation.endSample - enteredAtSample;
  const heldSeconds = heldSamples / observation.sampleRate;

  return Object.freeze({
    sampleRate: observation.sampleRate,
    startSample: observation.startSample,
    endSample: observation.endSample,
    captureEpoch: observation.captureEpoch,
    continuityEpoch: observation.continuityEpoch,
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
