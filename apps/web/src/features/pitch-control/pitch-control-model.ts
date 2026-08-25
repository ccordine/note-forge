import type { PitchFrame } from "@noteforge/pitch-engine";
import type { AttemptMetrics } from "@noteforge/trainer-core";
import {
  attemptScoringFrames,
  type CompletedAttempt,
} from "@/features/training-session/attempt-runner";
import { scoreWeightedSustainedNote } from "@/features/training-session/attempt-scoring";
import { aggregateEnvelopeScore } from "@/features/training-session/attempt-scoring-aggregate";
import { rmsDisplayUnit } from "@/lib/audio-level-display";
import { clampUnit } from "@/lib/numeric";
import type { Timbre } from "@/audio/synth";
import type { ControlMode } from "@/navigation";

export interface ControlTakeConfiguration {
  readonly envelopeType: ControlMode;
  readonly vowel: string;
  readonly midi: number;
  readonly centsOffset: number;
  readonly timbre: Timbre;
  readonly cyclePeriodSeconds: number;
}

export interface ControlResult {
  readonly metrics: AttemptMetrics;
  readonly volumeScore: number | undefined;
}

export const envelopes: Record<ControlMode, {
  readonly label: string;
  readonly points: readonly number[];
  readonly cue: string;
}> = {
  free: { label: "Free volume", points: [0.5, 0.5], cue: "Hold pitch; shape volume however you choose." },
  steady: { label: "Steady", points: [0.48, 0.48], cue: "One pitch. One volume. No drift." },
  crescendo: { label: "Crescendo", points: [0.12, 0.2, 0.38, 0.62, 0.92], cue: "Grow without lifting the fundamental." },
  decrescendo: { label: "Decrescendo", points: [0.92, 0.68, 0.42, 0.22, 0.12], cue: "Release energy without letting pitch sag." },
  diamond: { label: "Quiet → loud → quiet", points: [0.12, 0.32, 0.78, 0.96, 0.78, 0.32, 0.12], cue: "Open and close the dynamic arc around one center." },
  pulses: { label: "Pulses", points: [0.18, 0.82, 0.18, 0.82, 0.18, 0.82, 0.18], cue: "Change energy in clean steps while pitch stays put." },
};

const NUMERICAL_SILENCE_RMS = 1e-6;
export const TRACE_WINDOW_SECONDS = 8;
/** Repeating target phase; it never owns or ends the user's trace. */
export const ENVELOPE_CYCLE_SECONDS = 8;

export function interpolateEnvelope(points: readonly number[], progress: number): number {
  const position = clampUnit(progress) * (points.length - 1);
  const index = Math.floor(position);
  const fraction = position - index;
  const next = points[Math.min(index + 1, points.length - 1)] ?? points[index]!;
  return points[index]! * (1 - fraction) + next * fraction;
}

export function scoreEnvelope(
  frames: readonly (Pick<PitchFrame, "rms"> & { readonly scoringWeight?: number })[],
  frameElapsedSeconds: readonly number[],
  points: readonly number[],
  cyclePeriodSeconds: number,
  rmsThreshold = NUMERICAL_SILENCE_RMS,
): number | undefined {
  if (!Number.isFinite(cyclePeriodSeconds) || cyclePeriodSeconds <= 0) {
    throw new RangeError("cyclePeriodSeconds must be finite and positive.");
  }
  const samples = frames.flatMap((frame, index) => {
    const elapsed = frameElapsedSeconds[index];
    return elapsed != null && Number.isFinite(frame.rms) && frame.rms >= rmsThreshold
      ? [{ level: frame.rms, elapsed, weight: frame.scoringWeight ?? 1 }]
      : [];
  });
  if (samples.length < 4) return undefined;
  const data = samples.map(({ level, elapsed, weight }) => ({
    level,
    weight,
    progress: ((elapsed % cyclePeriodSeconds) + cyclePeriodSeconds) % cyclePeriodSeconds
      / cyclePeriodSeconds,
  }));
  const levels = samples.map(({ level }) => level);
  const minimum = Math.min(...levels);
  const maximum = Math.max(...levels);
  if (maximum - minimum < 1e-5) {
    return points.every((point) => Math.abs(point - points[0]!) < 0.05) ? 100 : 0;
  }
  const totalWeight = data.reduce((sum, item) => sum + item.weight, 0);
  const error = data.reduce((sum, item) => {
    const actual = (item.level - minimum) / (maximum - minimum);
    return sum + item.weight * Math.abs(actual - interpolateEnvelope(points, item.progress));
  }, 0) / totalWeight;
  return Math.max(0, (1 - error) * 100);
}

/** Fixed dBFS coordinates keep retained evidence stable as later frames arrive. */
export function pitchControlEnvelopeDisplayLevels(
  frames: readonly Pick<PitchFrame, "rms">[],
): readonly number[] {
  return frames.map((frame) => rmsDisplayUnit(frame.rms));
}

export function scoreControlTake(
  take: Readonly<CompletedAttempt<ControlTakeConfiguration>>,
  toleranceCents: number,
): ControlResult {
  const configuration = take.configuration;
  const frames = attemptScoringFrames(take);
  const metrics = scoreWeightedSustainedNote(
    take,
    frames,
    {
      midi: configuration.midi,
      centsOffset: configuration.centsOffset,
      timbre: configuration.timbre,
      amplitude: 0.25,
    },
    {
      toleranceCents,
      promptTimeSeconds: frames[0]?.timeSeconds,
    },
  );
  return {
    metrics,
    volumeScore: aggregateEnvelopeScore(
      take.scoringAggregate,
      envelopes[configuration.envelopeType].points,
      interpolateEnvelope,
    ),
  };
}
