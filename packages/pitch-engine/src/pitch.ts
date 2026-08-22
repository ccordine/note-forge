import type { PitchFrame } from "./types";

export const DEFAULT_A4_FREQUENCY = 440;

export function frequencyToMidi(
  frequencyHz: number,
  a4Frequency = DEFAULT_A4_FREQUENCY,
): number {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    throw new RangeError("frequencyHz must be a finite positive number");
  }
  if (!Number.isFinite(a4Frequency) || a4Frequency <= 0) {
    throw new RangeError("a4Frequency must be a finite positive number");
  }

  return 69 + 12 * Math.log2(frequencyHz / a4Frequency);
}

export function midiToFrequency(
  midi: number,
  a4Frequency = DEFAULT_A4_FREQUENCY,
): number {
  if (!Number.isFinite(midi)) {
    throw new RangeError("midi must be finite");
  }
  if (!Number.isFinite(a4Frequency) || a4Frequency <= 0) {
    throw new RangeError("a4Frequency must be a finite positive number");
  }

  return a4Frequency * 2 ** ((midi - 69) / 12);
}

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
  const nearestMidi = Math.round(midiFloat);

  return {
    frequencyHz,
    midiFloat,
    nearestMidi,
    centsFromNearest: 100 * (midiFloat - nearestMidi),
  };
}

export function pitchFrameAtMidi<T extends PitchFrame>(
  frame: T,
  midiFloat: number,
  a4Frequency = DEFAULT_A4_FREQUENCY,
): T {
  const nearestMidi = Math.round(midiFloat);

  return {
    ...frame,
    frequencyHz: midiToFrequency(midiFloat, a4Frequency),
    midiFloat,
    nearestMidi,
    centsFromNearest: 100 * (midiFloat - nearestMidi),
    voiced: true,
  };
}

export function clonePitchFrame<T extends PitchFrame>(frame: T): T {
  return { ...frame };
}
