import { ensureAudioReady } from "@/audio/audio-context";
import { playTone, type Timbre, type ToneSpec } from "@/audio/synth";
import { continuousMidiToHz } from "@/lib/music-display";
import { intervalTrialNotes, type IntervalTrial } from "./model";

const TONE_DURATION_SECONDS = 0.82;
const SEQUENTIAL_GAP_SECONDS = 0.12;
const COMPARISON_GAP_SECONDS = 2.1;

export function intervalToneSchedule(
  trial: IntervalTrial,
  timbre: Timbre,
  startAt: number,
): readonly ToneSpec[] {
  const [first, second] = intervalTrialNotes(trial);
  const secondStart = trial.presentation === "harmonic"
    ? startAt
    : startAt + TONE_DURATION_SECONDS + SEQUENTIAL_GAP_SECONDS;
  return [
    {
      frequencyHz: continuousMidiToHz(first),
      timbre,
      duration: TONE_DURATION_SECONDS,
      amplitude: 0.22,
      when: startAt,
    },
    {
      frequencyHz: continuousMidiToHz(second),
      timbre,
      duration: TONE_DURATION_SECONDS,
      amplitude: 0.22,
      when: secondStart,
    },
  ];
}

async function playSchedule(schedule: readonly ToneSpec[]): Promise<void> {
  await Promise.all(schedule.map((tone) => playTone(tone)));
}

export async function playIntervalTrial(trial: IntervalTrial, timbre: Timbre): Promise<void> {
  const context = await ensureAudioReady();
  await playSchedule(intervalToneSchedule(trial, timbre, context.currentTime + 0.025));
}

export async function playIntervalComparison(
  first: IntervalTrial,
  second: IntervalTrial,
  timbre: Timbre,
): Promise<void> {
  const context = await ensureAudioReady();
  const startAt = context.currentTime + 0.025;
  await playSchedule([
    ...intervalToneSchedule(first, timbre, startAt),
    ...intervalToneSchedule(second, timbre, startAt + COMPARISON_GAP_SECONDS),
  ]);
}
