import type {
  SampleAuthority,
  VocalControlCalibration,
  VocalControlVector,
  VocalTelemetrySample,
} from "./types";

const DEFAULT_HOP_SECONDS = 0.02;
const EPSILON = 1e-9;

export interface VocalControlOptions {
  readonly pitchConfidenceThreshold?: number;
  readonly brightnessConfidenceThreshold?: number;
  readonly responsePerSecond?: number;
  readonly responseCurve?: number;
  readonly hysteresisRatio?: number;
  readonly expectedHopSeconds?: number;
}

export interface ResolvedVocalControlOptions {
  readonly pitchConfidenceThreshold: number;
  readonly brightnessConfidenceThreshold: number;
  readonly responsePerSecond: number;
  readonly responseCurve: number;
  readonly hysteresisRatio: number;
  readonly expectedHopSeconds: number;
}

export interface VocalControlState {
  readonly calibration: VocalControlCalibration;
  readonly options: ResolvedVocalControlOptions;
  readonly vector: VocalControlVector;
  readonly targetPitchAxis: number;
  readonly targetBrightnessAxis: number;
  readonly pitchEngaged: boolean;
  readonly brightnessEngaged: boolean;
  readonly needsVoicedAuthority: boolean;
  readonly lastAuthority: SampleAuthority | null;
  readonly acceptedSamples: number;
  readonly observedSamples: number;
  readonly lastPitchDeltaCents: number | null;
  readonly lastBrightnessDelta: number | null;
}

export interface VocalControlUpdate {
  readonly state: VocalControlState;
  readonly vector: VocalControlVector;
  /** Exact contiguous detector sample time; zero at every authority boundary. */
  readonly deltaSeconds: number;
  readonly pitchDeltaCents: number | null;
  readonly brightnessDelta: number | null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function requireUnit(value: number, label: string): void {
  requireFinite(value, label);
  if (value < 0 || value > 1) throw new RangeError(`${label} must be from zero through one.`);
}

function resolveOptions(options: Readonly<VocalControlOptions>): ResolvedVocalControlOptions {
  const resolved = {
    pitchConfidenceThreshold: options.pitchConfidenceThreshold ?? 0.55,
    brightnessConfidenceThreshold: options.brightnessConfidenceThreshold ?? 0.55,
    responsePerSecond: options.responsePerSecond ?? 18,
    responseCurve: options.responseCurve ?? 1.12,
    hysteresisRatio: options.hysteresisRatio ?? 0.68,
    expectedHopSeconds: options.expectedHopSeconds ?? DEFAULT_HOP_SECONDS,
  };
  requireUnit(resolved.pitchConfidenceThreshold, "Pitch confidence threshold");
  requireUnit(resolved.brightnessConfidenceThreshold, "Brightness confidence threshold");
  requireUnit(resolved.hysteresisRatio, "Control hysteresis ratio");
  requireFinite(resolved.responsePerSecond, "Control response");
  requireFinite(resolved.responseCurve, "Control response curve");
  requireFinite(resolved.expectedHopSeconds, "Expected observation hop");
  if (resolved.responsePerSecond <= 0 || resolved.responseCurve <= 0
    || resolved.expectedHopSeconds <= 0) {
    throw new RangeError("Control response, curve, and observation hop must be positive.");
  }
  return Object.freeze(resolved);
}

function validateCalibration(calibration: Readonly<VocalControlCalibration>): void {
  for (const [label, value] of [
    ["Center frequency", calibration.centerFrequencyHz],
    ["Center MIDI", calibration.centerMidi],
    ["Center brightness", calibration.centerBrightness],
    ["Center RMS", calibration.centerRms],
    ["Lower pitch extent", calibration.pitchLowerCents],
    ["Upper pitch extent", calibration.pitchUpperCents],
    ["Darker brightness extent", calibration.brightnessDarkerDelta],
    ["Brighter brightness extent", calibration.brightnessBrighterDelta],
    ["Pitch dead zone", calibration.pitchDeadZoneCents],
    ["Brightness dead zone", calibration.brightnessDeadZone],
  ] as const) requireFinite(value, label);
  if (calibration.centerFrequencyHz <= 0
    || calibration.pitchLowerCents <= calibration.pitchDeadZoneCents
    || calibration.pitchUpperCents <= calibration.pitchDeadZoneCents
    || (calibration.brightnessAvailable
      && (calibration.brightnessDarkerDelta <= calibration.brightnessDeadZone
        || calibration.brightnessBrighterDelta <= calibration.brightnessDeadZone))) {
    throw new RangeError("Calibration extents must exceed their dead zones.");
  }
  requireUnit(calibration.centerBrightness, "Center brightness");
  if (calibration.centerRms < 0) throw new RangeError("Center RMS cannot be negative.");
}

export function authorityOf(sample: Readonly<VocalTelemetrySample>): SampleAuthority {
  return Object.freeze({
    sampleRate: sample.sampleRate,
    startSample: sample.startSample,
    endSample: sample.endSample,
    captureEpoch: sample.captureEpoch,
    continuityEpoch: sample.continuityEpoch,
    graphGeneration: sample.graphGeneration,
  });
}

/** Reject gaps, duplicates, reordered windows, and changed capture authority without catch-up. */
export function continuousSampleDelta(
  previous: Readonly<SampleAuthority> | null,
  sample: Readonly<VocalTelemetrySample>,
  expectedHopSeconds = DEFAULT_HOP_SECONDS,
): number {
  if (previous === null || sample.discontinuity) return 0;
  if (!Number.isFinite(sample.sampleRate) || sample.sampleRate <= 0) return 0;
  const sameAuthority = previous.sampleRate === sample.sampleRate
    && previous.captureEpoch === sample.captureEpoch
    && previous.continuityEpoch === sample.continuityEpoch
    && previous.graphGeneration === sample.graphGeneration;
  const hop = sample.endSample - previous.endSample;
  const startHop = sample.startSample - previous.startSample;
  const previousWindow = previous.endSample - previous.startSample;
  const currentWindow = sample.endSample - sample.startSample;
  const expectedHop = Math.round(sample.sampleRate * expectedHopSeconds);
  return sameAuthority
    && hop === expectedHop
    && startHop === hop
    && currentWindow === previousWindow
    && hop > 0
    && hop < currentWindow
    ? hop / sample.sampleRate
    : 0;
}

function emptyVector(): VocalControlVector {
  return Object.freeze({
    pitchAxis: 0,
    brightnessAxis: 0,
    pitchConfidence: 0,
    brightnessConfidence: 0,
    voiced: false,
    active: false,
  });
}

export function createVocalControlState(
  calibration: Readonly<VocalControlCalibration>,
  options: Readonly<VocalControlOptions> = {},
): VocalControlState {
  validateCalibration(calibration);
  return Object.freeze({
    calibration: Object.freeze({ ...calibration }),
    options: resolveOptions(options),
    vector: emptyVector(),
    targetPitchAxis: 0,
    targetBrightnessAxis: 0,
    pitchEngaged: false,
    brightnessEngaged: false,
    needsVoicedAuthority: true,
    lastAuthority: null,
    acceptedSamples: 0,
    observedSamples: 0,
    lastPitchDeltaCents: null,
    lastBrightnessDelta: null,
  });
}

function asymmetricAxis(delta: number, negativeExtent: number, positiveExtent: number): number {
  return clamp(delta / (delta < 0 ? negativeExtent : positiveExtent), -1, 1);
}

interface DeadZoneResult {
  readonly axis: number;
  readonly engaged: boolean;
}

function shapeAxis(
  rawAxis: number,
  engaged: boolean,
  enterThreshold: number,
  hysteresisRatio: number,
  responseCurve: number,
): DeadZoneResult {
  const magnitude = Math.abs(rawAxis);
  const exitThreshold = enterThreshold * hysteresisRatio;
  const nextEngaged = engaged ? magnitude > exitThreshold : magnitude >= enterThreshold;
  if (!nextEngaged) return { axis: 0, engaged: false };
  const normalized = clamp((magnitude - exitThreshold) / (1 - exitThreshold), 0, 1);
  return {
    axis: Math.sign(rawAxis) * normalized ** responseCurve,
    engaged: true,
  };
}

function immediatelyInactive(
  state: Readonly<VocalControlState>,
  sample: Readonly<VocalTelemetrySample>,
  deltaSeconds: number,
): VocalControlUpdate {
  const vector = Object.freeze({
    ...emptyVector(),
    pitchConfidence: clamp(Number.isFinite(sample.confidence) ? sample.confidence : 0, 0, 1),
    brightnessConfidence: clamp(
      Number.isFinite(sample.brightnessConfidence) ? sample.brightnessConfidence : 0,
      0,
      1,
    ),
  });
  const next = Object.freeze({
    ...state,
    vector,
    targetPitchAxis: 0,
    targetBrightnessAxis: 0,
    pitchEngaged: false,
    brightnessEngaged: false,
    needsVoicedAuthority: true,
    lastAuthority: authorityOf(sample),
    observedSamples: state.observedSamples + 1,
    lastPitchDeltaCents: null,
    lastBrightnessDelta: null,
  });
  return { state: next, vector, deltaSeconds, pitchDeltaCents: null, brightnessDelta: null };
}

/** Normalize one exact shared observation into the player's asymmetric control surface. */
export function updateVocalControl(
  state: Readonly<VocalControlState>,
  sample: Readonly<VocalTelemetrySample>,
): VocalControlUpdate {
  const deltaSeconds = continuousSampleDelta(
    state.lastAuthority,
    sample,
    state.options.expectedHopSeconds,
  );
  const voiced = sample.observationKind === "voiced"
    && sample.frequencyHz !== null
    && Number.isFinite(sample.frequencyHz)
    && sample.frequencyHz > 0;
  if (!voiced) return immediatelyInactive(state, sample, deltaSeconds);
  const pitchConfidence = clamp(Number.isFinite(sample.confidence) ? sample.confidence : 0, 0, 1);
  const brightnessConfidence = clamp(
    Number.isFinite(sample.brightnessConfidence) ? sample.brightnessConfidence : 0,
    0,
    1,
  );
  const pitchReliable = pitchConfidence >= state.options.pitchConfidenceThreshold;
  const brightnessReliable = state.calibration.brightnessAvailable
    && sample.brightness !== null
    && Number.isFinite(sample.brightness)
    && brightnessConfidence >= state.options.brightnessConfidenceThreshold;
  if (!pitchReliable) return immediatelyInactive(state, sample, deltaSeconds);

  if (state.needsVoicedAuthority || deltaSeconds <= 0) {
    const vector = Object.freeze({
      pitchAxis: 0,
      brightnessAxis: 0,
      pitchConfidence,
      brightnessConfidence,
      voiced: true,
      active: false,
    });
    const next = Object.freeze({
      ...state,
      vector,
      targetPitchAxis: 0,
      targetBrightnessAxis: 0,
      pitchEngaged: false,
      brightnessEngaged: false,
      needsVoicedAuthority: false,
      lastAuthority: authorityOf(sample),
      acceptedSamples: state.acceptedSamples + 1,
      observedSamples: state.observedSamples + 1,
      lastPitchDeltaCents: null,
      lastBrightnessDelta: null,
    });
    return {
      state: next,
      vector,
      deltaSeconds: 0,
      pitchDeltaCents: null,
      brightnessDelta: null,
    };
  }

  const pitchDeltaCents = 1_200 * Math.log2(sample.frequencyHz! / state.calibration.centerFrequencyHz);
  const brightnessDelta = brightnessReliable
    ? sample.brightness! - state.calibration.centerBrightness
    : null;
  const rawPitch = asymmetricAxis(
    pitchDeltaCents,
    state.calibration.pitchLowerCents,
    state.calibration.pitchUpperCents,
  );
  const pitchDeadZone = pitchDeltaCents < 0
    ? state.calibration.pitchDeadZoneCents / state.calibration.pitchLowerCents
    : state.calibration.pitchDeadZoneCents / state.calibration.pitchUpperCents;
  const pitch = shapeAxis(
    rawPitch,
    state.pitchEngaged,
    pitchDeadZone,
    state.options.hysteresisRatio,
    state.options.responseCurve,
  );
  const rawBrightness = brightnessDelta === null ? 0 : asymmetricAxis(
    brightnessDelta,
    state.calibration.brightnessDarkerDelta,
    state.calibration.brightnessBrighterDelta,
  );
  const brightnessDeadZone = brightnessDelta !== null && brightnessDelta < 0
    ? state.calibration.brightnessDeadZone / state.calibration.brightnessDarkerDelta
    : state.calibration.brightnessDeadZone / state.calibration.brightnessBrighterDelta;
  const brightness = brightnessReliable
    ? shapeAxis(
      rawBrightness,
      state.brightnessEngaged,
      brightnessDeadZone,
      state.options.hysteresisRatio,
      state.options.responseCurve,
    )
    : { axis: 0, engaged: false };
  const response = 1 - Math.exp(-state.options.responsePerSecond * deltaSeconds);
  const pitchAxis = state.vector.pitchAxis
    + (pitch.axis - state.vector.pitchAxis) * response;
  const brightnessAxis = brightnessReliable
    ? state.vector.brightnessAxis
      + (brightness.axis - state.vector.brightnessAxis) * response
    : 0;
  const vector = Object.freeze({
    pitchAxis: clamp(Math.abs(pitchAxis) < EPSILON ? 0 : pitchAxis, -1, 1),
    brightnessAxis: clamp(Math.abs(brightnessAxis) < EPSILON ? 0 : brightnessAxis, -1, 1),
    pitchConfidence,
    brightnessConfidence,
    voiced: true,
    active: true,
  });
  const next = Object.freeze({
    ...state,
    vector,
    targetPitchAxis: pitch.axis,
    targetBrightnessAxis: brightness.axis,
    pitchEngaged: pitch.engaged,
    brightnessEngaged: brightness.engaged,
    needsVoicedAuthority: false,
    lastAuthority: authorityOf(sample),
    acceptedSamples: state.acceptedSamples + 1,
    observedSamples: state.observedSamples + 1,
    lastPitchDeltaCents: pitchDeltaCents,
    lastBrightnessDelta: brightnessDelta,
  });
  return { state: next, vector, deltaSeconds, pitchDeltaCents, brightnessDelta };
}
