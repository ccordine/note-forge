import { detectPitch, type YinPitchFrame } from "@noteforge/pitch-engine";

export type PitchObservationKind = "voiced" | "unvoiced" | "uncertain";

export interface NoteInputWindow {
  readonly samples: Float32Array;
  readonly capturedAt: number;
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly processCount: number;
  readonly processedSampleCount: number;
  readonly discontinuity: boolean;
}

export interface PitchObservation extends YinPitchFrame {
  readonly observationKind: PitchObservationKind;
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly processedSampleCount: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly workletProcessCount: number;
  readonly discontinuity: boolean;
  readonly periodicity: number;
}

export interface ResolvedNoteInputConfiguration {
  readonly analysisSampleRate: number;
  readonly analysisSampleCount: number;
  readonly minFrequency: number;
  readonly maxFrequency: number;
  readonly yinThreshold: number;
  readonly minConfidence: number;
  readonly a4Frequency: number;
  readonly rmsThreshold: number;
}

export interface NoteInputResult {
  /** One authoritative observation for this exact captured PCM window. */
  readonly observation: Readonly<PitchObservation>;
  readonly configuration: Readonly<ResolvedNoteInputConfiguration>;
}

export const NOTE_INPUT_DEFAULTS = Object.freeze({
  minFrequency: 45,
  maxFrequency: 1_200,
  yinThreshold: 0.18,
  minConfidence: 0.55,
  a4Frequency: 440,
  /** -120 dBFS: reject numerical silence, not a quiet real microphone note. */
  rmsThreshold: 10 ** (-120 / 20),
}) satisfies Readonly<Omit<
  ResolvedNoteInputConfiguration,
  "analysisSampleRate" | "analysisSampleCount"
>>;

const MAXIMUM_ANALYSIS_SAMPLE_RATE = 48_000;
const MAXIMUM_CAPTURE_SAMPLE_RATE = 768_000;

function requireNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function validateWindow(window: Readonly<NoteInputWindow>): void {
  if (!(window.samples instanceof Float32Array)) {
    throw new TypeError("samples must be a Float32Array.");
  }
  if (
    !Number.isFinite(window.sampleRate)
    || window.sampleRate <= 0
    || window.sampleRate > MAXIMUM_CAPTURE_SAMPLE_RATE
  ) {
    throw new RangeError(
      `sampleRate must be finite, positive, and no greater than ${MAXIMUM_CAPTURE_SAMPLE_RATE}.`,
    );
  }
  requireNonNegativeSafeInteger(window.startSample, "startSample");
  requireNonNegativeSafeInteger(window.endSample, "endSample");
  requireNonNegativeSafeInteger(window.processedSampleCount, "processedSampleCount");
  requireNonNegativeSafeInteger(window.processCount, "processCount");
  requireNonNegativeSafeInteger(window.captureEpoch, "captureEpoch");
  requireNonNegativeSafeInteger(window.continuityEpoch, "continuityEpoch");
  requireNonNegativeSafeInteger(window.graphGeneration, "graphGeneration");
  if (window.endSample < window.startSample) {
    throw new RangeError("endSample must be no less than startSample.");
  }
  if (window.endSample - window.startSample !== window.samples.length) {
    throw new RangeError("Sample coordinates must exactly identify the PCM window.");
  }
  if (window.processedSampleCount !== window.endSample) {
    throw new RangeError("processedSampleCount must equal the exclusive endSample.");
  }
  if (!Number.isFinite(window.capturedAt) || window.capturedAt < 0) {
    throw new RangeError("capturedAt must be a finite non-negative number.");
  }
  const expectedTime = (window.startSample + window.endSample) / (2 * window.sampleRate);
  const timeTolerance = Number.EPSILON * Math.max(1, expectedTime) * 8;
  if (Math.abs(window.capturedAt - expectedTime) > timeTolerance) {
    throw new RangeError("capturedAt must be the PCM window midpoint in capture time.");
  }
  if (typeof window.discontinuity !== "boolean") {
    throw new TypeError("discontinuity must be boolean.");
  }
}

/** Bound detector work at high hardware sample rates without changing capture coordinates. */
function normalizedAnalysisWindow(
  window: Pick<NoteInputWindow, "samples" | "sampleRate">,
): Pick<NoteInputWindow, "samples" | "sampleRate"> {
  if (window.sampleRate <= MAXIMUM_ANALYSIS_SAMPLE_RATE) return window;

  const outputLength = Math.max(
    2,
    Math.floor(window.samples.length * MAXIMUM_ANALYSIS_SAMPLE_RATE / window.sampleRate),
  );
  const sourceSamplesPerOutput = window.samples.length / outputLength;
  const output = new Float32Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = outputIndex * sourceSamplesPerOutput;
    const end = start + sourceSamplesPerOutput;
    let sourceIndex = Math.floor(start);
    let position = start;
    let sum = 0;
    while (position < end) {
      const segmentEnd = Math.min(end, sourceIndex + 1);
      sum += window.samples[sourceIndex]! * (segmentEnd - position);
      position = segmentEnd;
      sourceIndex += 1;
    }
    output[outputIndex] = sum / sourceSamplesPerOutput;
  }
  return {
    samples: output,
    sampleRate: outputLength / (window.samples.length / window.sampleRate),
  };
}

function observationKind(frame: Readonly<YinPitchFrame>): PitchObservationKind {
  if (frame.reason === "detected" && frame.voiced) return "voiced";
  if (
    frame.reason === "below-rms-threshold"
    || frame.reason === "no-periodic-candidate"
  ) {
    return "unvoiced";
  }
  return "uncertain";
}

function periodicity(frame: Readonly<YinPitchFrame>): number {
  if (frame.yinValue === null || !Number.isFinite(frame.yinValue)) return 0;
  return Math.min(1, Math.max(0, 1 - frame.yinValue));
}

/** Stateless detector: every complete PCM window becomes exactly one observation. */
export class NoteInputEngine {
  process(window: Readonly<NoteInputWindow>): NoteInputResult {
    validateWindow(window);
    const analysisWindow = normalizedAnalysisWindow(window);
    const configuration = Object.freeze({
      analysisSampleRate: analysisWindow.sampleRate,
      analysisSampleCount: analysisWindow.samples.length,
      ...NOTE_INPUT_DEFAULTS,
    });
    const detected = detectPitch(analysisWindow.samples, {
      sampleRate: analysisWindow.sampleRate,
      minFrequency: configuration.minFrequency,
      maxFrequency: configuration.maxFrequency,
      yinThreshold: configuration.yinThreshold,
      minConfidence: configuration.minConfidence,
      a4Frequency: configuration.a4Frequency,
      rmsThreshold: configuration.rmsThreshold,
      timeSeconds: window.capturedAt,
    });
    const observation = Object.freeze({
      ...detected,
      observationKind: observationKind(detected),
      sampleRate: window.sampleRate,
      startSample: window.startSample,
      endSample: window.endSample,
      processedSampleCount: window.processedSampleCount,
      captureEpoch: window.captureEpoch,
      continuityEpoch: window.continuityEpoch,
      graphGeneration: window.graphGeneration,
      workletProcessCount: window.processCount,
      discontinuity: window.discontinuity,
      periodicity: periodicity(detected),
    }) satisfies Readonly<PitchObservation>;
    return Object.freeze({ observation, configuration });
  }
}
