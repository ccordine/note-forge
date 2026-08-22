import { midiToFrequency } from "@noteforge/music-core";

export const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"] as const;

export function midiToHz(midi: number): number {
  return midiToFrequency(midi);
}

export function continuousMidiToHz(midi: number, cents = 0): number {
  return midiToFrequency(midi + cents / 100);
}

export function noteLabel(midi: number): string {
  const rounded = Math.round(midi);
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

export function pitchClassLabel(pitchClass: number): string {
  return NOTE_NAMES[((pitchClass % 12) + 12) % 12];
}

export function signed(value: number, digits = 0): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
}

export function circularDistance(from: number, to: number): number {
  return ((to - from) % 12 + 12) % 12;
}

export const INTERVAL_SHORT = ["P1", "m2", "M2", "m3", "M3", "P4", "TT", "P5", "m6", "M6", "m7", "M7", "P8"];
export const INTERVAL_LONG = [
  "unison", "minor second", "major second", "minor third", "major third", "perfect fourth", "tritone",
  "perfect fifth", "minor sixth", "major sixth", "minor seventh", "major seventh", "octave"
];

export const SCALE_PRESETS: Record<string, { label: string; intervals: number[] }> = {
  major: { label: "Major", intervals: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: "Natural minor", intervals: [0, 2, 3, 5, 7, 8, 10] },
  majorPentatonic: { label: "Major pentatonic", intervals: [0, 2, 4, 7, 9] },
  minorPentatonic: { label: "Minor pentatonic", intervals: [0, 3, 5, 7, 10] },
  blues: { label: "Blues", intervals: [0, 3, 5, 6, 7, 10] }
};

export const CHORD_PRESETS: Record<string, { label: string; intervals: number[] }> = {
  major: { label: "Major", intervals: [0, 4, 7] },
  minor: { label: "Minor", intervals: [0, 3, 7] },
  diminished: { label: "Diminished", intervals: [0, 3, 6] },
  augmented: { label: "Augmented", intervals: [0, 4, 8] },
  sus2: { label: "Suspended 2", intervals: [0, 2, 7] },
  sus4: { label: "Suspended 4", intervals: [0, 5, 7] },
  major7: { label: "Major 7", intervals: [0, 4, 7, 11] },
  dominant7: { label: "Dominant 7", intervals: [0, 4, 7, 10] },
  minor7: { label: "Minor 7", intervals: [0, 3, 7, 10] }
};

export function nearestResolutionPitchClasses(notePc: number, chordPcs: number[]): number[] {
  let best = Number.POSITIVE_INFINITY;
  const choices: number[] = [];
  for (const candidate of chordPcs) {
    const raw = Math.abs(candidate - notePc);
    const distance = Math.min(raw, 12 - raw);
    if (distance < best) {
      best = distance;
      choices.length = 0;
      choices.push(candidate);
    } else if (distance === best) choices.push(candidate);
  }
  return [...new Set(choices)];
}
