import { type PitchFrame } from "@noteforge/pitch-engine";
import { type AttemptMetrics } from "@noteforge/trainer-core";
import type { Timbre } from "@/audio/synth";
import {
  attemptScoringFrames,
  type CompletedAttempt,
} from "@/features/training-session/attempt-runner";
import {
  scoreWeightedSustainedNote,
} from "@/features/training-session/attempt-scoring";
import { aggregateMedianMidi } from "@/features/training-session/attempt-scoring-aggregate";
import { continuousMidiToHz } from "@/lib/music-display";
import type { HumMode } from "@/navigation";

export type HumShape = "m" | "n" | "ng";

export interface HumTakeConfiguration {
  readonly mode: HumMode;
  readonly shape: HumShape;
  readonly midi: number;
  readonly centsOffset: number;
  readonly timbre: Timbre;
  readonly toleranceCents: number;
}

export interface HumResult {
  readonly frames: readonly PitchFrame[];
  readonly metrics: AttemptMetrics | null;
  readonly anchor: {
    readonly midiFloat: number;
    readonly nearestMidi: number;
    readonly cents: number;
    readonly frequencyHz: number;
    readonly continuityRatio: number;
  } | null;
  readonly continuityRatio: number;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function scoreHumTake(
  take: Readonly<CompletedAttempt<HumTakeConfiguration>>,
): HumResult {
  const configuration = take.configuration;
  const frames = attemptScoringFrames(take);
  const continuityRatio = take.scoringAggregate.totalFrameCount > 0
    ? take.scoringAggregate.analyzedFrameCount / take.scoringAggregate.totalFrameCount
    : 0;
  const voicedWeight = take.scoringAggregate.analyzedFrameCount;
  if (voicedWeight < 3) return { frames, metrics: null, anchor: null, continuityRatio };

  let targetMidi = configuration.midi;
  let targetCents = configuration.centsOffset;
  let anchor: HumResult["anchor"] = null;
  const scoreFrames = frames;
  if (configuration.mode === "anchor") {
    const center = aggregateMedianMidi(take.scoringAggregate)!;
    targetMidi = Math.round(center);
    targetCents = (center - targetMidi) * 100;
    anchor = {
      midiFloat: center,
      nearestMidi: targetMidi,
      cents: targetCents,
      frequencyHz: continuousMidiToHz(targetMidi, targetCents),
      continuityRatio,
    };
  }
  const metrics = scoreWeightedSustainedNote(
    take,
    scoreFrames,
    { midi: targetMidi, centsOffset: targetCents, timbre: configuration.timbre, amplitude: 0.22 },
    { toleranceCents: configuration.toleranceCents, minimumConfidence: 0.5, promptTimeSeconds: scoreFrames[0]?.timeSeconds, maximumVoicedGapSeconds: 0.24 },
  );
  return { frames, metrics, anchor, continuityRatio };
}
