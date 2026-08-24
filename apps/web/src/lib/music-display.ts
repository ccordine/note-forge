import {
  CHORD_QUALITIES,
  SCALES,
  getIntervalMetadata,
  midiToFrequency,
  normalizePitchClass,
  noteName,
  splitMidiPitch,
  transposeMidi,
  type ChordQuality,
  type ScaleType,
} from "@noteforge/music-core";

const FLAT_DISPLAY_PITCH_CLASSES = new Set([3, 8, 10]);

export function continuousMidiToHz(midi: number, cents = 0): number {
  return midiToFrequency(transposeMidi(midi, cents));
}

export function noteLabel(midi: number): string {
  const pitch = splitMidiPitch(midi);
  return `${pitchClassLabel(pitch.pitchClass)}${pitch.octave}`;
}

export function pitchClassLabel(pitchClass: number): string {
  const normalized = splitMidiPitch(normalizePitchClass(pitchClass)).pitchClass;
  return noteName(normalized, FLAT_DISPLAY_PITCH_CLASSES.has(normalized) ? "flat" : "sharp");
}

export function signed(value: number, digits = 0): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
}

export const INTERVAL_SHORT = Object.freeze(Array.from({ length: 13 }, (_, semitones) => getIntervalMetadata(semitones).shortName));
export const INTERVAL_LONG = Object.freeze(Array.from({ length: 13 }, (_, semitones) => getIntervalMetadata(semitones).name));

function freezePresetMap<const T extends Record<string, object>>(presets: T): Readonly<{ [K in keyof T]: Readonly<T[K]> }> {
  Object.values(presets).forEach(Object.freeze);
  return Object.freeze(presets);
}

export const SCALE_PRESETS = freezePresetMap({
  major: { label: "Major", type: "major", intervals: SCALES.major.intervals },
  minor: { label: "Natural minor", type: "natural-minor", intervals: SCALES["natural-minor"].intervals },
  majorPentatonic: { label: "Major pentatonic", type: "major-pentatonic", intervals: SCALES["major-pentatonic"].intervals },
  minorPentatonic: { label: "Minor pentatonic", type: "minor-pentatonic", intervals: SCALES["minor-pentatonic"].intervals },
  blues: { label: "Blues", type: "blues", intervals: SCALES.blues.intervals }
} satisfies Record<string, { label: string; type: ScaleType; intervals: readonly number[] }>);

export const CHORD_PRESETS = freezePresetMap({
  major: { label: "Major", quality: "major", intervals: CHORD_QUALITIES.major.intervals },
  minor: { label: "Minor", quality: "minor", intervals: CHORD_QUALITIES.minor.intervals },
  diminished: { label: "Diminished", quality: "diminished", intervals: CHORD_QUALITIES.diminished.intervals },
  augmented: { label: "Augmented", quality: "augmented", intervals: CHORD_QUALITIES.augmented.intervals },
  sus2: { label: "Suspended 2", quality: "suspended-2", intervals: CHORD_QUALITIES["suspended-2"].intervals },
  sus4: { label: "Suspended 4", quality: "suspended-4", intervals: CHORD_QUALITIES["suspended-4"].intervals },
  major7: { label: "Major 7", quality: "major-7", intervals: CHORD_QUALITIES["major-7"].intervals },
  dominant7: { label: "Dominant 7", quality: "dominant-7", intervals: CHORD_QUALITIES["dominant-7"].intervals },
  minor7: { label: "Minor 7", quality: "minor-7", intervals: CHORD_QUALITIES["minor-7"].intervals }
} satisfies Record<string, { label: string; quality: ChordQuality; intervals: readonly number[] }>);

export type ScalePresetId = keyof typeof SCALE_PRESETS;
export type ChordPresetId = keyof typeof CHORD_PRESETS;

export function isScalePresetId(value: string): value is ScalePresetId {
  return Object.hasOwn(SCALE_PRESETS, value);
}

export function isChordPresetId(value: string): value is ChordPresetId {
  return Object.hasOwn(CHORD_PRESETS, value);
}
