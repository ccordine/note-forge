/** A single continuous-pitch observation suitable for storage or rendering. */
export interface PitchFrame {
  timeSeconds: number;
  frequencyHz: number | null;
  midiFloat: number | null;
  nearestMidi: number | null;
  centsFromNearest: number | null;
  rms: number;
  confidence: number;
  voiced: boolean;
}

/** Inclusive detector edges retain at most one cent of interpolation drift. */
export const YIN_FREQUENCY_BOUNDARY_TOLERANCE_CENTS = 1;

export type PitchDetectionReason =
  | "detected"
  | "below-rms-threshold"
  | "insufficient-samples"
  | "invalid-samples"
  | "no-periodic-candidate"
  | "below-confidence-threshold"
  | "temporally-ambiguous"
  | "frequency-out-of-range";

/** The local or global minimum selected directly by YIN. */
export interface YinRawCandidate {
  readonly frequencyHz: number;
  readonly periodSamples: number;
  readonly yinValue: number;
  readonly confidence: number;
}

/** PitchFrame plus deterministic YIN diagnostics useful in NoteForge's debug view. */
export interface YinPitchFrame extends PitchFrame {
  detector: "yin";
  periodSamples: number | null;
  yinValue: number | null;
  reason: PitchDetectionReason;
  /**
   * Present on real detector output whenever YIN found a local/global minimum.
   * Optional only so callers' synthetic diagnostic fixtures remain source-compatible.
   */
  readonly rawCandidate?: Readonly<YinRawCandidate> | null;
}

export interface YinDetectorOptions {
  /** Sampling rate of every Float32Array passed to the detector. */
  sampleRate: number;
  /** Lowest fundamental to consider. Defaults to NoteForge's canonical 45 Hz. */
  minFrequency?: number;
  /** Highest fundamental to consider. Defaults to 1,200 Hz. */
  maxFrequency?: number;
  /**
   * Samples compared at every YIN lag. The input also needs enough trailing
   * samples for the largest requested lag. When omitted, a safe size is
   * selected from the supplied input buffer.
   */
  analysisWindowSize?: number;
  /** YIN local-minimum search guide. Defaults to 0.08; minConfidence owns admission. */
  yinThreshold?: number;
  /** Minimum accepted 1 - YIN value. Defaults to 0.55. */
  minConfidence?: number;
  /** Optional caller-specified RMS floor. Defaults to zero (only literal silence is skipped). */
  rmsThreshold?: number;
  /**
   * Transport-owned recent evidence span. Zero keeps strict edge comparison;
   * live overlapping capture supplies its normalized publication hop.
   */
  currentEdgeSpanSamples?: number;
  /** Concert-A reference used for MIDI/cents conversion. Defaults to 440 Hz. */
  a4Frequency?: number;
}

export interface YinOptions extends YinDetectorOptions {
  /** Timestamp copied into the returned frame. Defaults to zero. */
  timeSeconds?: number;
}

export interface MedianSmoothingOptions {
  /** Number of frames sampled on either side. Defaults to one (a 3-frame filter). */
  radius?: number;
  /**
   * Minimum voiced values needed before replacing a frame. Defaults to the
   * complete centered window, so edge frames are not averaged into new pitches.
   */
  minSamples?: number;
  a4Frequency?: number;
}
