import { normalizePitchClass } from "@noteforge/music-core";

export type FamilyNoteSet = "natural" | "chromatic";
export type TargetOrder = "ascending" | "descending" | "shuffled";
export type RangeFamilyId = "foundation" | "deep" | "low" | "middle" | "high" | "upper";
export type RandomSource = () => number;

export interface RangeFamilyDefinition {
  id: RangeFamilyId;
  label: string;
  octave: 1 | 2 | 3 | 4 | 5 | 6;
  firstMidi: number;
  lastMidi: number;
  rangeLabel: string;
}

export const RANGE_FAMILIES = Object.freeze([
  Object.freeze({ id: "foundation", label: "Foundation", octave: 1, firstMidi: 30, lastMidi: 35, rangeLabel: "F♯1–B1" }),
  Object.freeze({ id: "deep", label: "Deep", octave: 2, firstMidi: 36, lastMidi: 47, rangeLabel: "C2–B2" }),
  Object.freeze({ id: "low", label: "Low", octave: 3, firstMidi: 48, lastMidi: 59, rangeLabel: "C3–B3" }),
  Object.freeze({ id: "middle", label: "Middle", octave: 4, firstMidi: 60, lastMidi: 71, rangeLabel: "C4–B4" }),
  Object.freeze({ id: "high", label: "High", octave: 5, firstMidi: 72, lastMidi: 83, rangeLabel: "C5–B5" }),
  Object.freeze({ id: "upper", label: "Upper", octave: 6, firstMidi: 84, lastMidi: 86, rangeLabel: "C6–D6" }),
] as const satisfies readonly RangeFamilyDefinition[]);

const NATURAL_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11]);

export function getRangeFamily(familyId: RangeFamilyId): RangeFamilyDefinition {
  const family = RANGE_FAMILIES.find((candidate) => candidate.id === familyId);
  if (!family) throw new RangeError(`Unknown range family: ${String(familyId)}`);
  return family;
}

/** Find the octave family containing a MIDI note, clamped to the curriculum edges. */
export function rangeFamilyForMidi(midi: number): RangeFamilyId {
  requireMidi(midi, "MIDI note");
  return RANGE_FAMILIES.find((family) => midi >= family.firstMidi && midi <= family.lastMidi)?.id
    ?? (midi < RANGE_FAMILIES[0].firstMidi ? RANGE_FAMILIES[0].id : RANGE_FAMILIES.at(-1)!.id);
}

export interface FamilyTargetSequenceOptions {
  familyId: RangeFamilyId;
  noteSet?: FamilyNoteSet;
  order?: TargetOrder;
  rng?: RandomSource;
}

export interface FamilyAdvance {
  previousFamilyId: RangeFamilyId;
  familyId: RangeFamilyId;
  wrapped: boolean;
}

function requireMidi(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 127) {
    throw new RangeError(`${label} must be an integer MIDI note from 0 through 127.`);
  }
}

function requireKnownNoteSet(noteSet: FamilyNoteSet): void {
  if (noteSet !== "natural" && noteSet !== "chromatic") {
    throw new RangeError(`Unknown family note set: ${String(noteSet)}`);
  }
}

function requireKnownOrder(order: TargetOrder): void {
  if (order !== "ascending" && order !== "descending" && order !== "shuffled") {
    throw new RangeError(`Unknown target order: ${String(order)}`);
  }
}

function randomIndex(maximumInclusive: number, rng: RandomSource): number {
  const sample = rng();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("Random source must return a finite number from 0 (inclusive) to 1 (exclusive).");
  }
  return Math.floor(sample * (maximumInclusive + 1));
}

/** Return the ascending targets for one fixed C-through-B family. */
export function targetsForFamily(
  familyId: RangeFamilyId,
  noteSet: FamilyNoteSet = "natural",
): number[] {
  requireKnownNoteSet(noteSet);
  const family = getRangeFamily(familyId);
  const chromatic = Array.from(
    { length: family.lastMidi - family.firstMidi + 1 },
    (_, index) => family.firstMidi + index,
  );
  return noteSet === "natural"
    ? chromatic.filter((midi) => NATURAL_PITCH_CLASSES.has(normalizePitchClass(midi)))
    : chromatic;
}

/** Copy and order targets without mutating the caller's array. */
export function orderTargets(
  targets: readonly number[],
  order: TargetOrder,
  rng: RandomSource = Math.random,
): number[] {
  requireKnownOrder(order);
  if (order === "ascending") return [...targets].sort((left, right) => left - right);
  if (order === "descending") return [...targets].sort((left, right) => right - left);
  if (typeof rng !== "function") throw new TypeError("Random source must be a function.");

  const shuffled = [...targets];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index, rng);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

export function createFamilyTargetSequence(
  options: Readonly<FamilyTargetSequenceOptions>,
): number[] {
  const noteSet = options.noteSet ?? "natural";
  const order = options.order ?? "ascending";
  return orderTargets(targetsForFamily(options.familyId, noteSet), order, options.rng);
}

/** Advance through every detector-backed family and report the cycle boundary. */
export function advanceFamily(currentFamilyId: RangeFamilyId): FamilyAdvance {
  const currentIndex = RANGE_FAMILIES.findIndex((family) => family.id === currentFamilyId);
  if (currentIndex < 0) throw new RangeError(`Unknown note family: ${String(currentFamilyId)}`);
  const nextIndex = (currentIndex + 1) % RANGE_FAMILIES.length;
  return {
    previousFamilyId: currentFamilyId,
    familyId: RANGE_FAMILIES[nextIndex]!.id,
    wrapped: nextIndex === 0,
  };
}
