import diagnosticSchema from "../../../../packages/diagnostic-schema/src/schema.json";

const liveSignalSchema = diagnosticSchema.liveSignal;
const detectorBoundaryRatio = 2 ** (
  liveSignalSchema.frequencyHz.detectorBoundaryToleranceCents / 1_200
);
const frequencyRoundingHalfUnit = 0.5 * 10 ** (
  -liveSignalSchema.frequencyHz.decimalPlaces
);

/**
 * Shared diagnostic boundary authority. The canonical detector range remains
 * 45-1,200 Hz. Detector interpolation may extend one cent beyond a literal
 * edge, and the wire interval adds only half of its declared decimal unit so
 * serializing that exact evidence cannot invalidate it on the server.
 */
export const LIVE_DIAGNOSTIC_SIGNAL_BOUNDS = Object.freeze({
  canonicalFrequencyHz: Object.freeze({
    minimum: liveSignalSchema.frequencyHz.canonicalMinimum,
    maximum: liveSignalSchema.frequencyHz.canonicalMaximum,
  }),
  detectorFrequencyHz: Object.freeze({
    minimum: liveSignalSchema.frequencyHz.canonicalMinimum / detectorBoundaryRatio,
    maximum: liveSignalSchema.frequencyHz.canonicalMaximum * detectorBoundaryRatio,
  }),
  transportFrequencyHz: Object.freeze({
    minimum:
      liveSignalSchema.frequencyHz.canonicalMinimum / detectorBoundaryRatio
      - frequencyRoundingHalfUnit,
    maximum:
      liveSignalSchema.frequencyHz.canonicalMaximum * detectorBoundaryRatio
      + frequencyRoundingHalfUnit,
  }),
  captureSampleRateHz: Object.freeze({
    exclusiveMinimum: liveSignalSchema.captureSampleRateHz.exclusiveMinimum,
    maximum: liveSignalSchema.captureSampleRateHz.maximum,
  }),
  analysisSampleRateHz: Object.freeze({
    exclusiveMinimum: liveSignalSchema.analysisSampleRateHz.exclusiveMinimum,
    maximum: liveSignalSchema.analysisSampleRateHz.maximum,
  }),
  detectorBoundaryToleranceCents:
    liveSignalSchema.frequencyHz.detectorBoundaryToleranceCents,
  frequencyDecimalPlaces: liveSignalSchema.frequencyHz.decimalPlaces,
  midiTolerance: liveSignalSchema.coordinateTolerance.midi,
  centsTolerance: liveSignalSchema.coordinateTolerance.cents,
});

interface LivePitchCoordinateSource {
  readonly observationKind: string;
  readonly sampleRate: number;
  readonly frequencyHz: number | null;
  readonly midiFloat: number | null;
  readonly nearestMidi: number | null;
  readonly centsFromNearest: number | null;
}

interface SerializedLivePitchCoordinates {
  readonly sampleRate: number;
  readonly frequencyHz: number | null;
  readonly midiFloat: number | null;
  readonly nearestMidi: number | null;
  readonly centsFromNearest: number | null;
}

interface MicrophoneSignalDiagnostic {
  readonly state: string;
  readonly sampleRate?: number | null;
  readonly bufferSize?: number | null;
  readonly minFrequencyHz?: number | null;
  readonly maxFrequencyHz?: number | null;
}

function roundedNumber(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function boundedNumber(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
  digits: number,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return roundedNumber(value, digits);
}

function numberAbove(
  value: number,
  label: string,
  exclusiveMinimum: number,
  maximum: number,
  digits: number,
): number {
  if (!Number.isFinite(value) || value <= exclusiveMinimum || value > maximum) {
    throw new RangeError(
      `${label} must be greater than ${exclusiveMinimum} and no greater than ${maximum}.`,
    );
  }
  const rounded = roundedNumber(value, digits);
  if (rounded <= exclusiveMinimum) {
    throw new RangeError(`${label} loses its required Nyquist margin when serialized.`);
  }
  return rounded;
}

function optionalNumber(
  value: number | null,
  label: string,
  minimum: number,
  maximum: number,
  digits: number,
): number | null {
  return value === null ? null : boundedNumber(value, label, minimum, maximum, digits);
}

function validateCoordinateIdentity(
  frequencyHz: number,
  midiFloat: number,
  nearestMidi: number,
  centsFromNearest: number,
): void {
  const expectedMidi = 69 + 12 * Math.log2(frequencyHz / 440);
  if (Math.abs(expectedMidi - midiFloat) > LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.midiTolerance) {
    throw new RangeError("Frame frequencyHz and midiFloat identify different pitches.");
  }
  const midiFromNearestCoordinates = nearestMidi + centsFromNearest / 100;
  if (
    Math.abs(centsFromNearest) > 50 + LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.centsTolerance
    || Math.abs(midiFloat - midiFromNearestCoordinates)
      > LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.centsTolerance / 100
  ) {
    throw new RangeError("Frame MIDI and nearest-note coordinates identify different pitches.");
  }
}

export function serializeLivePitchCoordinates(
  source: Readonly<LivePitchCoordinateSource>,
): SerializedLivePitchCoordinates {
  const sampleRate = numberAbove(
    source.sampleRate,
    "Frame sampleRate",
    LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.captureSampleRateHz.exclusiveMinimum,
    LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.captureSampleRateHz.maximum,
    4,
  );
  const frequencyHz = optionalNumber(
    source.frequencyHz,
    "Frame frequencyHz",
    LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.detectorFrequencyHz.minimum,
    LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.detectorFrequencyHz.maximum,
    LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.frequencyDecimalPlaces,
  );
  const midiFloat = optionalNumber(source.midiFloat, "Frame midiFloat", 0, 127, 4);
  const nearestMidi = source.nearestMidi === null
    ? null
    : boundedNumber(source.nearestMidi, "Frame nearestMidi", 0, 127, 0);
  if (nearestMidi !== null && !Number.isInteger(source.nearestMidi)) {
    throw new RangeError("Frame nearestMidi must be an integer.");
  }
  const centsFromNearest = optionalNumber(
    source.centsFromNearest,
    "Frame centsFromNearest",
    -100,
    100,
    4,
  );

  if (
    source.observationKind === "voiced"
    && frequencyHz !== null
    && midiFloat !== null
    && nearestMidi !== null
    && centsFromNearest !== null
  ) {
    validateCoordinateIdentity(frequencyHz, midiFloat, nearestMidi, centsFromNearest);
  }

  return { sampleRate, frequencyHz, midiFloat, nearestMidi, centsFromNearest };
}

export function validateMicrophoneSignalContract(
  value: Readonly<MicrophoneSignalDiagnostic>,
): void {
  if (value.sampleRate != null) {
    numberAbove(
      value.sampleRate,
      "Microphone sampleRate",
      LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.captureSampleRateHz.exclusiveMinimum,
      LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.captureSampleRateHz.maximum,
      4,
    );
  }
  if (value.bufferSize != null && (
    !Number.isSafeInteger(value.bufferSize)
    || value.bufferSize < 128
    || value.bufferSize > 262_144
  )) {
    throw new RangeError("Microphone bufferSize must be an integer between 128 and 262144.");
  }
  const canonicalFrequency = LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.canonicalFrequencyHz;
  if (value.minFrequencyHz != null && value.minFrequencyHz !== canonicalFrequency.minimum) {
    throw new RangeError(`Microphone minFrequencyHz must equal ${canonicalFrequency.minimum}.`);
  }
  if (value.maxFrequencyHz != null && value.maxFrequencyHz !== canonicalFrequency.maximum) {
    throw new RangeError(`Microphone maxFrequencyHz must equal ${canonicalFrequency.maximum}.`);
  }
  if (value.state === "starting" || value.state === "ready") {
    if (
      value.bufferSize == null
      || value.minFrequencyHz == null
      || value.maxFrequencyHz == null
    ) {
      throw new RangeError(
        "An active microphone diagnostic must declare its buffer and canonical detector range.",
      );
    }
  }
  if (value.state === "ready" && value.sampleRate == null) {
    throw new RangeError("A ready microphone diagnostic must declare its capture sampleRate.");
  }
}

export function validateSerializedFrameSignalContract(
  frame: Readonly<LivePitchCoordinateSource>,
): void {
  numberAbove(
    frame.sampleRate,
    "Frame sampleRate",
    LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.captureSampleRateHz.exclusiveMinimum,
    LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.captureSampleRateHz.maximum,
    4,
  );
  const coordinates = [
    frame.frequencyHz,
    frame.midiFloat,
    frame.nearestMidi,
    frame.centsFromNearest,
  ];
  if (frame.observationKind !== "voiced") {
    if (coordinates.some((coordinate) => coordinate !== null)) {
      throw new RangeError("An unvoiced diagnostic frame cannot transport pitch coordinates.");
    }
    return;
  }
  if (coordinates.some((coordinate) => coordinate === null)) {
    throw new RangeError("A voiced diagnostic frame must transport complete pitch coordinates.");
  }
  const frequencyHz = boundedNumber(
    frame.frequencyHz!,
    "Frame frequencyHz",
    LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.transportFrequencyHz.minimum,
    LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.transportFrequencyHz.maximum,
    LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.frequencyDecimalPlaces,
  );
  const midiFloat = boundedNumber(frame.midiFloat!, "Frame midiFloat", 0, 127, 4);
  const nearestMidi = boundedNumber(frame.nearestMidi!, "Frame nearestMidi", 0, 127, 0);
  const centsFromNearest = boundedNumber(
    frame.centsFromNearest!,
    "Frame centsFromNearest",
    -100,
    100,
    4,
  );
  if (!Number.isInteger(frame.nearestMidi)) {
    throw new RangeError("Frame nearestMidi must be an integer.");
  }
  validateCoordinateIdentity(frequencyHz, midiFloat, nearestMidi, centsFromNearest);
}
