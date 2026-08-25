import {
  YinDetector,
  YIN_DETECTOR_DEFAULTS,
  type YinPitchFrame,
} from "@noteforge/pitch-engine";
import { clampUnit } from "@/lib/numeric";
import {
  deriveVocalBrightness,
  type VocalBrightnessTelemetry,
} from "./vocal-brightness";
import {
  PitchStateTracker,
  type PitchCandidateTelemetry,
  type PitchTrackingDecision,
} from "./pitch-state-tracker";
import { AnalysisWindowNormalizer } from "./analysis-window-normalizer";

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
  /** Raw per-window estimator result before causal musical-state admission. */
  readonly pitchCandidate?: Readonly<PitchCandidateTelemetry>;
  /** Target-independent explanation of how this window affected pitch state. */
  readonly pitchTrackingDecision?: PitchTrackingDecision;
}

/** The canonical shared vocal observation consumed by multidimensional tools. */
export interface VocalObservation extends PitchObservation, VocalBrightnessTelemetry {}

export interface ResolvedNoteInputConfiguration {
  readonly analysisSampleRate: number;
  readonly analysisSampleCount: number;
  readonly minFrequency: number;
  readonly maxFrequency: number;
  readonly yinThreshold: number;
  readonly minConfidence: number;
  readonly a4Frequency: number;
  readonly rmsThreshold: number;
  readonly currentEdgeSpanSamples: number;
}

export interface NoteInputResult {
  /** One authoritative observation for this exact captured PCM window. */
  readonly observation: Readonly<VocalObservation>;
  readonly configuration: Readonly<ResolvedNoteInputConfiguration>;
}

export const NOTE_INPUT_DEFAULTS = Object.freeze({
  ...YIN_DETECTOR_DEFAULTS,
}) satisfies Readonly<Omit<
  ResolvedNoteInputConfiguration,
  "analysisSampleRate" | "analysisSampleCount"
>>;

export const NOTE_INPUT_SAMPLE_RATE_BOUNDS = Object.freeze({
  capture: Object.freeze({
    exclusiveMinimum: NOTE_INPUT_DEFAULTS.maxFrequency * 2,
    maximum: 768_000,
  }),
  analysis: Object.freeze({
    exclusiveMinimum: NOTE_INPUT_DEFAULTS.maxFrequency * 2,
    maximum: 48_000,
  }),
});

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
    || window.sampleRate <= NOTE_INPUT_SAMPLE_RATE_BOUNDS.capture.exclusiveMinimum
    || window.sampleRate > NOTE_INPUT_SAMPLE_RATE_BOUNDS.capture.maximum
  ) {
    throw new RangeError(
      `sampleRate must be finite, greater than ${NOTE_INPUT_SAMPLE_RATE_BOUNDS.capture.exclusiveMinimum}, and no greater than ${NOTE_INPUT_SAMPLE_RATE_BOUNDS.capture.maximum}.`,
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
  return clampUnit(1 - frame.yinValue);
}

/** Every complete PCM window becomes exactly one independently owned observation. */
export class NoteInputEngine {
  private readonly detector = new YinDetector();
  private readonly pitchTracker = new PitchStateTracker();
  private readonly analysisNormalizer = new AnalysisWindowNormalizer();
  private trackerAuthority: Readonly<{
    captureEpoch: number;
    continuityEpoch: number;
    graphGeneration: number;
    sampleRate: number;
  }> | null = null;
  private inUse = false;

  process(window: Readonly<NoteInputWindow>): NoteInputResult {
    if (this.inUse) {
      throw new Error("A NoteInputEngine instance cannot be used reentrantly.");
    }
    this.inUse = true;
    try {
      return this.processWindow(window);
    } finally {
      this.inUse = false;
    }
  }

  private processWindow(window: Readonly<NoteInputWindow>): NoteInputResult {
    validateWindow(window);
    const trackerAuthorityChanged = this.trackerAuthority === null
      || this.trackerAuthority.captureEpoch !== window.captureEpoch
      || this.trackerAuthority.continuityEpoch !== window.continuityEpoch
      || this.trackerAuthority.graphGeneration !== window.graphGeneration
      || this.trackerAuthority.sampleRate !== window.sampleRate;
    if (window.discontinuity || trackerAuthorityChanged) this.pitchTracker.reset();
    this.trackerAuthority = Object.freeze({
      captureEpoch: window.captureEpoch,
      continuityEpoch: window.continuityEpoch,
      graphGeneration: window.graphGeneration,
      sampleRate: window.sampleRate,
    });
    const analysisWindow = this.analysisNormalizer.normalize(window);
    const configuration = Object.freeze({
      analysisSampleRate: analysisWindow.sampleRate,
      analysisSampleCount: analysisWindow.samples.length,
      ...NOTE_INPUT_DEFAULTS,
      currentEdgeSpanSamples: Math.max(1, Math.round(analysisWindow.sampleRate * 0.02)),
    });
    const detected = this.detector.detectPitch(analysisWindow.samples, {
      sampleRate: analysisWindow.sampleRate,
      minFrequency: configuration.minFrequency,
      maxFrequency: configuration.maxFrequency,
      yinThreshold: configuration.yinThreshold,
      minConfidence: configuration.minConfidence,
      a4Frequency: configuration.a4Frequency,
      rmsThreshold: configuration.rmsThreshold,
      currentEdgeSpanSamples: configuration.currentEdgeSpanSamples,
      timeSeconds: window.capturedAt,
    });
    const tracked = this.pitchTracker.track(detected);
    const brightness = deriveVocalBrightness(
      analysisWindow.samples,
      analysisWindow.sampleRate,
      tracked.frame,
    );
    const observation = Object.freeze({
      ...tracked.frame,
      ...brightness,
      observationKind: observationKind(tracked.frame),
      sampleRate: window.sampleRate,
      startSample: window.startSample,
      endSample: window.endSample,
      processedSampleCount: window.processedSampleCount,
      captureEpoch: window.captureEpoch,
      continuityEpoch: window.continuityEpoch,
      graphGeneration: window.graphGeneration,
      workletProcessCount: window.processCount,
      discontinuity: window.discontinuity,
      periodicity: periodicity(tracked.frame),
      pitchCandidate: tracked.candidate,
      pitchTrackingDecision: tracked.decision,
    }) satisfies Readonly<VocalObservation>;
    return Object.freeze({ observation, configuration });
  }
}
