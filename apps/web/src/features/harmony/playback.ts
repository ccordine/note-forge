import { ensureAudioReady } from "@/audio/audio-context";
import { playFrequencies, playTone, type Timbre, type ToneSpec } from "@/audio/synth";
import { continuousMidiToHz } from "@/lib/music-display";
import {
  chordMidiFor,
  FOLLOW_LINES,
  FOLLOW_MELODY,
  midiNearMiddleC,
  type ProgressionChord,
} from "./model";

async function playScheduledTones(tones: readonly ToneSpec[]): Promise<void> {
  await Promise.all(tones.map((tone) => playTone(tone)));
}

export async function playHarmonyChord(
  chord: ProgressionChord,
  tonicPitchClass: number,
  timbre: Timbre,
): Promise<void> {
  const frequencies = chordMidiFor(tonicPitchClass, chord).map(continuousMidiToHz);
  await playFrequencies(frequencies, "simultaneous", {
    timbre,
    duration: 1.35,
    amplitude: 0.26,
  });
}

export async function playHarmonyProgression(
  chords: readonly ProgressionChord[],
  tonicPitchClass: number,
  timbre: Timbre,
): Promise<void> {
  const context = await ensureAudioReady();
  const startAt = context.currentTime + 0.025;
  const tones = chords.flatMap((chord, chordIndex) => {
    const notes = chordMidiFor(tonicPitchClass, chord);
    const amplitude = 0.26 / Math.max(1, Math.sqrt(notes.length));
    return notes.map((midi) => ({
      frequencyHz: continuousMidiToHz(midi),
      timbre,
      duration: 1.35,
      amplitude,
      when: startAt + chordIndex * 1.65,
    } satisfies ToneSpec));
  });
  await playScheduledTones(tones);
}

export async function playHarmonyFollowLine(
  lineIndex: number,
  tonicPitchClass: number,
  timbre: Timbre,
): Promise<void> {
  const line = FOLLOW_LINES[lineIndex] ?? FOLLOW_LINES[0];
  const context = await ensureAudioReady();
  const startAt = context.currentTime + 0.025;
  const tonicMidi = midiNearMiddleC(tonicPitchClass);
  const tones = FOLLOW_MELODY.flatMap((melodyOffset, step) => {
    const harmonyOffset = line.offsets[step] ?? melodyOffset;
    const when = startAt + step * 0.56;
    return [melodyOffset, harmonyOffset].map((offset) => ({
      frequencyHz: continuousMidiToHz(tonicMidi + offset),
      timbre,
      duration: 0.42,
      amplitude: 0.155,
      when,
    } satisfies ToneSpec));
  });
  await playScheduledTones(tones);
}
