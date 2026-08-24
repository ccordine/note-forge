import { normalizePitchClass } from "@noteforge/music-core";
import { CHORD_PRESETS } from "@/lib/music-display";
import type { HarmonyMode } from "@/navigation";

export type HarmonyView = "scaleDegree" | "chordTone" | "voiceLeading" | "harmonyFollow";
export type MissionId = "roots" | "thirds" | "nearest" | "shared" | "tension" | "free";

export interface ProgressionChord {
  readonly degree: number;
  readonly quality: keyof typeof CHORD_PRESETS;
  readonly roman: string;
}

export interface HarmonyMission {
  readonly id: MissionId;
  readonly label: string;
  readonly detail: string;
}

export const PROGRESSION_PRESETS = Object.freeze({
  pop: Object.freeze({
    label: "I · vi · IV · V",
    chords: Object.freeze([
      { degree: 0, quality: "major", roman: "I" },
      { degree: 9, quality: "minor", roman: "vi" },
      { degree: 5, quality: "major", roman: "IV" },
      { degree: 7, quality: "major", roman: "V" },
    ] satisfies readonly ProgressionChord[]),
  }),
  minor: Object.freeze({
    label: "i · ♭VI · ♭III · ♭VII",
    chords: Object.freeze([
      { degree: 0, quality: "minor", roman: "i" },
      { degree: 8, quality: "major", roman: "♭VI" },
      { degree: 3, quality: "major", roman: "♭III" },
      { degree: 10, quality: "major", roman: "♭VII" },
    ] satisfies readonly ProgressionChord[]),
  }),
  jazz: Object.freeze({
    label: "ii⁷ · V⁷ · Imaj⁷",
    chords: Object.freeze([
      { degree: 2, quality: "minor7", roman: "ii⁷" },
      { degree: 7, quality: "dominant7", roman: "V⁷" },
      { degree: 0, quality: "major7", roman: "Imaj⁷" },
    ] satisfies readonly ProgressionChord[]),
  }),
  drone: Object.freeze({
    label: "I · ♭II · I · iv",
    chords: Object.freeze([
      { degree: 0, quality: "major", roman: "I" },
      { degree: 1, quality: "major", roman: "♭II" },
      { degree: 0, quality: "major", roman: "I" },
      { degree: 5, quality: "minor", roman: "iv" },
    ] satisfies readonly ProgressionChord[]),
  }),
} as const satisfies Record<string, { readonly label: string; readonly chords: readonly ProgressionChord[] }>);

export type ProgressionPresetId = keyof typeof PROGRESSION_PRESETS;

export const HARMONY_MISSIONS: readonly HarmonyMission[] = Object.freeze([
  { id: "roots", label: "Roots only", detail: "Track structural motion" },
  { id: "thirds", label: "Thirds only", detail: "Hear chord quality from inside" },
  { id: "nearest", label: "Nearest chord tone", detail: "Minimize movement at every change" },
  { id: "shared", label: "Shared note", detail: "Stay still whenever harmony allows" },
  { id: "tension", label: "Tension → release", detail: "Color beat three; resolve on one" },
  { id: "free", label: "Chord-tone improv", detail: "Choose freely inside each sonority" },
]);

export const FOLLOW_MELODY = Object.freeze([0, 2, 4, 5, 7, 5, 4, 2]);
export const FOLLOW_LINES = Object.freeze([
  Object.freeze({ label: "Unison", offsets: FOLLOW_MELODY }),
  Object.freeze({ label: "Octave", offsets: FOLLOW_MELODY.map((offset) => offset + 12) }),
  Object.freeze({ label: "Fixed third above", offsets: Object.freeze([3, 5, 7, 8, 10, 8, 7, 5]) }),
  Object.freeze({ label: "Nearest chord tone", offsets: Object.freeze([4, 4, 4, 5, 7, 5, 4, 4]) }),
  Object.freeze({ label: "Contrary motion", offsets: Object.freeze([8, 6, 4, 3, 1, 3, 4, 6]) }),
  Object.freeze({ label: "Free chord-constrained", offsets: Object.freeze([7, 4, 7, 5, 4, 5, 7, 4]) }),
]);

export function harmonyView(mode: HarmonyMode): HarmonyView {
  if (mode === "scale-degree-recognition" || mode === "scale-degree-production") return "scaleDegree";
  if (mode === "voice-leading") return "voiceLeading";
  if (mode === "harmony-follow") return "harmonyFollow";
  return "chordTone";
}

export function defaultModeForHarmonyView(view: HarmonyView): HarmonyMode {
  if (view === "scaleDegree") return "scale-degree-recognition";
  if (view === "voiceLeading") return "voice-leading";
  if (view === "harmonyFollow") return "harmony-follow";
  return "chord-tone";
}

export function midiNearMiddleC(pitchClass: number): number {
  const candidate = 60 + normalizePitchClass(pitchClass);
  return candidate > 71 ? candidate - 12 : candidate;
}

export function chordMidiFor(tonicPitchClass: number, item: ProgressionChord): readonly number[] {
  const rootPitchClass = normalizePitchClass(tonicPitchClass + item.degree);
  const rootMidi = midiNearMiddleC(rootPitchClass);
  return CHORD_PRESETS[item.quality].intervals.map((interval) => rootMidi + interval);
}

function pitchClassCandidates(pitchClass: number): readonly number[] {
  const candidates: number[] = [];
  for (let midi = 44; midi <= 76; midi += 1) {
    if (normalizePitchClass(midi) === pitchClass) candidates.push(midi);
  }
  return candidates;
}

function threeItemPermutations(values: readonly number[]): readonly (readonly number[])[] {
  const [a, b, c] = values;
  if (a === undefined || b === undefined || c === undefined) return [];
  return [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
}

export function nearestVoicing(previous: readonly number[], pitchClasses: readonly number[]): readonly number[] {
  let best: readonly number[] | undefined;
  let bestMovement = Number.POSITIVE_INFINITY;
  for (const assignment of threeItemPermutations(pitchClasses.slice(0, 3))) {
    const candidateSets = assignment.map(pitchClassCandidates);
    const lowCandidates = candidateSets[0] ?? [];
    const middleCandidates = candidateSets[1] ?? [];
    const highCandidates = candidateSets[2] ?? [];
    for (const low of lowCandidates) {
      for (const middle of middleCandidates) {
        for (const high of highCandidates) {
          if (low >= middle || middle >= high) continue;
          const candidate = [low, middle, high];
          const movement = candidate.reduce(
            (sum, midi, index) => sum + Math.abs(midi - (previous[index] ?? midi)),
            0,
          );
          const lexicalTieBreak = candidate.join(",") < (best?.join(",") ?? "");
          if (movement < bestMovement || (movement === bestMovement && lexicalTieBreak)) {
            best = candidate;
            bestMovement = movement;
          }
        }
      }
    }
  }
  if (!best) throw new Error("Unable to construct a bounded three-voice chord voicing.");
  return best;
}

export function nearestVoiceLines(
  chords: readonly ProgressionChord[],
  tonicPitchClass: number,
): readonly (readonly number[])[] {
  if (chords.length === 0) return [[], [], []];
  const first = [...chordMidiFor(tonicPitchClass, chords[0] ?? chords[0]!)].slice(0, 3);
  while (Math.max(...first) > 76) first.forEach((midi, index) => { first[index] = midi - 12; });
  while (Math.min(...first) < 44) first.forEach((midi, index) => { first[index] = midi + 12; });
  const voicings: number[][] = [first];
  for (const chord of chords.slice(1)) {
    const rootPitchClass = normalizePitchClass(tonicPitchClass + chord.degree);
    const pitchClasses = CHORD_PRESETS[chord.quality].intervals
      .slice(0, 3)
      .map((interval) => normalizePitchClass(rootPitchClass + interval));
    voicings.push([...nearestVoicing(voicings.at(-1) ?? first, pitchClasses)]);
  }
  return [0, 1, 2].map((voiceIndex) => (
    voicings.map((voicing) => voicing[voiceIndex] ?? 60)
  ));
}

export function chordQualitySuffix(quality: keyof typeof CHORD_PRESETS): string {
  const suffixes: Partial<Record<keyof typeof CHORD_PRESETS, string>> = {
    minor: "m",
    minor7: "m7",
    dominant7: "7",
    major7: "maj7",
  };
  return suffixes[quality] ?? "";
}
