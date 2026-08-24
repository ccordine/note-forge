import {
  DEFAULT_REFERENCE_FREQUENCY_HZ,
  frequencyToMidi as canonicalFrequencyToMidi,
  midiToFrequency as canonicalMidiToFrequency,
  splitMidiPitch,
} from "@noteforge/music-core";
import type { PitchFrame } from "./types";

/** music-core is the sole equal-tempered pitch-math authority. */
export const DEFAULT_A4_FREQUENCY = DEFAULT_REFERENCE_FREQUENCY_HZ;
export const frequencyToMidi = canonicalFrequencyToMidi;
export const midiToFrequency = canonicalMidiToFrequency;

export interface PitchValues {
  frequencyHz: number;
  midiFloat: number;
  nearestMidi: number;
  centsFromNearest: number;
}

export function pitchValuesFromFrequency(
  frequencyHz: number,
  a4Frequency = DEFAULT_A4_FREQUENCY,
): PitchValues {
  const midiFloat = frequencyToMidi(frequencyHz, a4Frequency);
  const { nearestMidi, centsFromNearest } = splitMidiPitch(midiFloat);

  return {
    frequencyHz,
    midiFloat,
    nearestMidi,
    centsFromNearest,
  };
}

export function pitchFrameAtMidi<T extends PitchFrame>(
  frame: T,
  midiFloat: number,
  a4Frequency = DEFAULT_A4_FREQUENCY,
): T {
  const { nearestMidi, centsFromNearest } = splitMidiPitch(midiFloat);

  return {
    ...frame,
    frequencyHz: midiToFrequency(midiFloat, a4Frequency),
    midiFloat,
    nearestMidi,
    centsFromNearest,
    voiced: true,
  };
}
