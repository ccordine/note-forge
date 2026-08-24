import { smoothPitchFrames, type PitchFrame } from "@noteforge/pitch-engine";
import { scoreSustainedNote, type AttemptMetrics } from "@noteforge/trainer-core";
import type { Timbre } from "@/audio/synth";
import type { CompletedAttempt } from "@/features/training-session/attempt-runner";
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
  readonly duration: number;
}

export interface HumResult {
  readonly frames: PitchFrame[];
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
  const frames = smoothPitchFrames(take.frames, { correctOctaveJumps: true });
  const voiced = frames.filter((frame) => frame.voiced && frame.confidence >= 0.5 && frame.midiFloat !== null);
  const continuityRatio = frames.length ? voiced.length / frames.length : 0;
  if (voiced.length < 3) return { frames, metrics: null, anchor: null, continuityRatio };

  let targetMidi = configuration.midi;
  let targetCents = configuration.centsOffset;
  let anchor: HumResult["anchor"] = null;
  let scoreFrames = frames;
  if (configuration.mode === "anchor") {
    const center = median(voiced.map((frame) => frame.midiFloat!))!;
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
  if (configuration.mode === "glide") {
    scoreFrames = frames.filter((_, index) => (
      (take.frameElapsedSeconds[index] ?? 0) >= configuration.duration * 0.55
    ));
  }
  const metrics = scoreSustainedNote(
    scoreFrames,
    { midi: targetMidi, centsOffset: targetCents, durationMs: configuration.duration * 1_000, timbre: configuration.timbre, amplitude: 0.22 },
    { toleranceCents: configuration.toleranceCents, minimumConfidence: 0.5, promptTimeSeconds: scoreFrames[0]?.timeSeconds, maximumVoicedGapSeconds: 0.24 },
  );
  return { frames, metrics, anchor, continuityRatio };
}
