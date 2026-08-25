import type { YinPitchFrame } from "@noteforge/pitch-engine";

export const PITCH_STATE_TRACKER_DEFAULTS = Object.freeze({
  /** Fine steering and ordinary vibrato remain immediate. */
  maximumImmediateJumpCents: 45,
  /** Two coherent remote candidates establish a real step in one 20 ms hop. */
  transitionConfirmationFrames: 2,
  /** A competing candidate may move this far and still describe one contour. */
  candidateContinuationCents: 180,
  /** Silence longer than this establishes a new cold-attack authority. */
  retainedPitchGapSeconds: 0.12,
  /** A sample gap this large cannot participate in temporal interpretation. */
  maximumFrameGapSeconds: 0.1,
});

export type PitchTrackingDecision =
  | "accepted-cold-attack"
  | "accepted-continuation"
  | "accepted-confirmed-transition"
  | "no-pitch"
  | "pending-transition";

export interface PitchCandidateTelemetry {
  readonly frequencyHz: number | null;
  readonly midiFloat: number | null;
  readonly nearestMidi: number | null;
  readonly centsFromNearest: number | null;
  readonly confidence: number;
  readonly yinValue: number | null;
  readonly periodSamples: number | null;
  readonly voiced: boolean;
  readonly reason: YinPitchFrame["reason"];
  /** YIN's original local minimum before acoustic harmonic-family selection. */
  readonly rawCandidate: YinPitchFrame["rawCandidate"];
  /** Acoustic ambiguity between the selected and runner-up harmonic families. */
  readonly harmonicAmbiguity: number;
}

export interface TrackedPitchFrame {
  readonly frame: Readonly<YinPitchFrame>;
  readonly candidate: Readonly<PitchCandidateTelemetry>;
  readonly decision: PitchTrackingDecision;
}

interface PendingTransition {
  readonly midiFloat: number;
  readonly previousMidiFloat: number;
  readonly count: number;
  readonly timeSeconds: number;
}

interface AcceptedPitch {
  readonly midiFloat: number;
  readonly timeSeconds: number;
}

function finiteVoicedPitch(
  frame: Readonly<YinPitchFrame>,
): frame is Readonly<YinPitchFrame> & { readonly midiFloat: number } {
  return frame.voiced
    && frame.reason === "detected"
    && frame.frequencyHz !== null
    && Number.isFinite(frame.frequencyHz)
    && frame.midiFloat !== null
    && Number.isFinite(frame.midiFloat);
}

function candidateTelemetry(
  frame: Readonly<YinPitchFrame>,
): Readonly<PitchCandidateTelemetry> {
  return Object.freeze({
    frequencyHz: frame.frequencyHz,
    midiFloat: frame.midiFloat,
    nearestMidi: frame.nearestMidi,
    centsFromNearest: frame.centsFromNearest,
    confidence: frame.confidence,
    yinValue: frame.yinValue,
    periodSamples: frame.periodSamples,
    voiced: frame.voiced,
    reason: frame.reason,
    rawCandidate: frame.rawCandidate ?? null,
    harmonicAmbiguity: frame.harmonicAmbiguity ?? 0,
  });
}

function ambiguousFrame(frame: Readonly<YinPitchFrame>): Readonly<YinPitchFrame> {
  return Object.freeze({
    ...frame,
    frequencyHz: null,
    midiFloat: null,
    nearestMidi: null,
    centsFromNearest: null,
    voiced: false,
    periodSamples: null,
    reason: "temporally-ambiguous",
  });
}

function centsBetween(leftMidi: number, rightMidi: number): number {
  return (rightMidi - leftMidi) * 100;
}

function sameDirection(left: number, right: number): boolean {
  return left === 0 || right === 0 || Math.sign(left) === Math.sign(right);
}

/**
 * Target-independent causal interpretation of independently estimated windows.
 *
 * YIN candidates remain inspectable in `candidate`. Fine motion is immediate.
 * A single remote candidate cannot become musical state; a coherent second
 * candidate confirms a genuine step or fast contour one hop later. Silence is
 * published immediately and never replaced by a stale pitch.
 */
export class PitchStateTracker {
  private accepted: AcceptedPitch | null = null;
  private pending: PendingTransition | null = null;
  private lastFrameTimeSeconds: number | null = null;
  private noPitchStartedAtSeconds: number | null = null;

  reset(): void {
    this.accepted = null;
    this.pending = null;
    this.lastFrameTimeSeconds = null;
    this.noPitchStartedAtSeconds = null;
  }

  track(frame: Readonly<YinPitchFrame>): Readonly<TrackedPitchFrame> {
    const candidate = candidateTelemetry(frame);
    const previousFrameTime = this.lastFrameTimeSeconds;
    const frameGap = previousFrameTime === null
      ? 0
      : frame.timeSeconds - previousFrameTime;
    this.lastFrameTimeSeconds = frame.timeSeconds;
    if (
      !Number.isFinite(frame.timeSeconds)
      || frameGap < 0
      || frameGap > PITCH_STATE_TRACKER_DEFAULTS.maximumFrameGapSeconds
    ) {
      this.accepted = null;
      this.pending = null;
      this.noPitchStartedAtSeconds = null;
    }

    if (!finiteVoicedPitch(frame)) {
      this.pending = null;
      this.noPitchStartedAtSeconds ??= frame.timeSeconds;
      if (
        this.accepted !== null
        && frame.timeSeconds - this.noPitchStartedAtSeconds
          > PITCH_STATE_TRACKER_DEFAULTS.retainedPitchGapSeconds
      ) {
        this.accepted = null;
      }
      return Object.freeze({ frame, candidate, decision: "no-pitch" });
    }

    const gapSeconds = this.noPitchStartedAtSeconds === null
      ? 0
      : frame.timeSeconds - this.noPitchStartedAtSeconds;
    this.noPitchStartedAtSeconds = null;
    if (
      this.accepted === null
      || gapSeconds > PITCH_STATE_TRACKER_DEFAULTS.retainedPitchGapSeconds
    ) {
      this.accepted = Object.freeze({
        midiFloat: frame.midiFloat,
        timeSeconds: frame.timeSeconds,
      });
      this.pending = null;
      return Object.freeze({
        frame,
        candidate,
        decision: "accepted-cold-attack",
      });
    }

    const jumpCents = centsBetween(this.accepted.midiFloat, frame.midiFloat);
    if (
      Math.abs(jumpCents)
        <= PITCH_STATE_TRACKER_DEFAULTS.maximumImmediateJumpCents
    ) {
      this.accepted = Object.freeze({
        midiFloat: frame.midiFloat,
        timeSeconds: frame.timeSeconds,
      });
      this.pending = null;
      return Object.freeze({
        frame,
        candidate,
        decision: "accepted-continuation",
      });
    }

    const previousPending = this.pending;
    const pendingStepCents = previousPending === null
      ? Number.POSITIVE_INFINITY
      : centsBetween(previousPending.midiFloat, frame.midiFloat);
    const pendingDirection = previousPending === null
      ? 0
      : centsBetween(previousPending.previousMidiFloat, previousPending.midiFloat);
    const sameCandidateRegion = Math.abs(pendingStepCents)
      <= PITCH_STATE_TRACKER_DEFAULTS.maximumImmediateJumpCents;
    const coherentCandidate = previousPending !== null
      && Math.abs(pendingStepCents)
        <= PITCH_STATE_TRACKER_DEFAULTS.candidateContinuationCents
      && (sameCandidateRegion || sameDirection(pendingDirection, pendingStepCents));
    const count = coherentCandidate ? previousPending.count + 1 : 1;
    this.pending = Object.freeze({
      midiFloat: frame.midiFloat,
      previousMidiFloat: coherentCandidate
        ? previousPending.midiFloat
        : this.accepted.midiFloat,
      count,
      timeSeconds: frame.timeSeconds,
    });
    if (count >= PITCH_STATE_TRACKER_DEFAULTS.transitionConfirmationFrames) {
      this.accepted = Object.freeze({
        midiFloat: frame.midiFloat,
        timeSeconds: frame.timeSeconds,
      });
      this.pending = null;
      return Object.freeze({
        frame,
        candidate,
        decision: "accepted-confirmed-transition",
      });
    }

    return Object.freeze({
      frame: ambiguousFrame(frame),
      candidate,
      decision: "pending-transition",
    });
  }
}
