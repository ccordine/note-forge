export const NOTE_LETTERS = ["C", "D", "E", "F", "G", "A", "B"] as const;

export type NoteLetter = (typeof NOTE_LETTERS)[number];
export type NaturalPitchClass = 0 | 2 | 4 | 5 | 7 | 9 | 11;
export type NoteFamilyId = "low" | "middle" | "high";
export type RandomSource = () => number;

export const NOTE_LETTER_TO_PITCH_CLASS: Readonly<Record<NoteLetter, NaturalPitchClass>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

export interface NoteFamilyDefinition {
  id: NoteFamilyId;
  label: string;
  octave: 3 | 4 | 5;
  firstMidi: number;
  lastMidi: number;
  rangeLabel: string;
}

export const NOTE_FAMILIES = [
  { id: "low", label: "Low", octave: 3, firstMidi: 48, lastMidi: 59, rangeLabel: "C3–B3" },
  { id: "middle", label: "Middle", octave: 4, firstMidi: 60, lastMidi: 71, rangeLabel: "C4–B4" },
  { id: "high", label: "High", octave: 5, firstMidi: 72, lastMidi: 83, rangeLabel: "C5–B5" },
] as const satisfies readonly NoteFamilyDefinition[];

export interface NoteEvidence {
  attempts: number;
  correct: number;
  /** Once earned, mastery remains earned even if the note is reviewed later. */
  mastered: boolean;
}

export type FamilyEvidence = Record<NoteLetter, NoteEvidence>;
export type NoteFamilyProgress = Record<NoteFamilyId, FamilyEvidence>;

export interface MasteryRequirement {
  minimumCorrect: number;
  minimumAccuracy: number;
}

export const DEFAULT_MASTERY_REQUIREMENT: Readonly<MasteryRequirement> = {
  minimumCorrect: 3,
  minimumAccuracy: 0.75,
};

export interface NoteFamilyTrial {
  familyId: NoteFamilyId;
  octave: number;
  targetLetter: NoteLetter;
  targetPitchClass: NaturalPitchClass;
  targetMidi: number;
}

export interface ReferenceTrial extends NoteFamilyTrial {
  anchorLetter: NoteLetter;
  anchorPitchClass: NaturalPitchClass;
  anchorMidi: number;
}

export interface ReferenceTrialOptions {
  /** A remains the default known anchor, but it stays inside the selected family. */
  anchorLetter?: NoteLetter;
  evidence?: FamilyEvidence;
  rng?: RandomSource;
  allowSame?: boolean;
}

const familyById = new Map<NoteFamilyId, NoteFamilyDefinition>(
  NOTE_FAMILIES.map((family) => [family.id, family]),
);

const emptyNoteEvidence = (): NoteEvidence => ({
  attempts: 0,
  correct: 0,
  mastered: false,
});

export function getNoteFamily(familyId: NoteFamilyId): NoteFamilyDefinition {
  const family = familyById.get(familyId);
  if (!family) throw new RangeError(`Unknown note family: ${String(familyId)}`);
  return family;
}

export function pitchClassForLetter(letter: NoteLetter): NaturalPitchClass {
  return NOTE_LETTER_TO_PITCH_CLASS[letter];
}

export function parseNoteLetterKey(key: string): NoteLetter | null {
  const normalized = key.trim().toUpperCase();
  return NOTE_LETTERS.includes(normalized as NoteLetter)
    ? normalized as NoteLetter
    : null;
}

export function pitchClassFromLetterKey(key: string): NaturalPitchClass | null {
  const letter = parseNoteLetterKey(key);
  return letter ? pitchClassForLetter(letter) : null;
}

export function midiForFamilyLetter(
  familyId: NoteFamilyId,
  letter: NoteLetter,
): number {
  const { octave } = getNoteFamily(familyId);
  return 12 * (octave + 1) + pitchClassForLetter(letter);
}

export function naturalMidisInFamily(familyId: NoteFamilyId): number[] {
  return NOTE_LETTERS.map((letter) => midiForFamilyLetter(familyId, letter));
}

export function createEmptyFamilyEvidence(): FamilyEvidence {
  return Object.fromEntries(
    NOTE_LETTERS.map((letter) => [letter, emptyNoteEvidence()]),
  ) as FamilyEvidence;
}

export function createEmptyNoteFamilyProgress(): NoteFamilyProgress {
  return {
    low: createEmptyFamilyEvidence(),
    middle: createEmptyFamilyEvidence(),
    high: createEmptyFamilyEvidence(),
  };
}

export function isNoteMastered(
  evidence: Readonly<NoteEvidence>,
  requirement: Readonly<MasteryRequirement> = DEFAULT_MASTERY_REQUIREMENT,
): boolean {
  if (evidence.mastered) return true;
  if (evidence.attempts <= 0 || evidence.correct < requirement.minimumCorrect) return false;
  return evidence.correct / evidence.attempts >= requirement.minimumAccuracy;
}

export function recordNoteAttempt(
  evidence: Readonly<FamilyEvidence>,
  letter: NoteLetter,
  wasCorrect: boolean,
  requirement: Readonly<MasteryRequirement> = DEFAULT_MASTERY_REQUIREMENT,
): FamilyEvidence {
  const previous = evidence[letter];
  const updated: NoteEvidence = {
    attempts: previous.attempts + 1,
    correct: previous.correct + (wasCorrect ? 1 : 0),
    mastered: previous.mastered,
  };
  updated.mastered = isNoteMastered(updated, requirement);

  return {
    ...evidence,
    [letter]: updated,
  };
}

export function masteredNoteCount(
  evidence: Readonly<FamilyEvidence>,
  requirement: Readonly<MasteryRequirement> = DEFAULT_MASTERY_REQUIREMENT,
): number {
  return NOTE_LETTERS.filter((letter) => isNoteMastered(evidence[letter], requirement)).length;
}

export function isFamilyComplete(
  evidence: Readonly<FamilyEvidence>,
  requirement: Readonly<MasteryRequirement> = DEFAULT_MASTERY_REQUIREMENT,
): boolean {
  return masteredNoteCount(evidence, requirement) === NOTE_LETTERS.length;
}

export function getUnlockedFamilyIds(
  progress: Readonly<NoteFamilyProgress>,
  requirement: Readonly<MasteryRequirement> = DEFAULT_MASTERY_REQUIREMENT,
): NoteFamilyId[] {
  const unlocked: NoteFamilyId[] = [];

  for (const family of NOTE_FAMILIES) {
    unlocked.push(family.id);
    if (!isFamilyComplete(progress[family.id], requirement)) break;
  }

  return unlocked;
}

export function isFamilyUnlocked(
  familyId: NoteFamilyId,
  progress: Readonly<NoteFamilyProgress>,
  requirement: Readonly<MasteryRequirement> = DEFAULT_MASTERY_REQUIREMENT,
): boolean {
  return getUnlockedFamilyIds(progress, requirement).includes(familyId);
}

function chooseIndex(length: number, rng: RandomSource): number {
  if (length < 1) throw new RangeError("Cannot choose from an empty set");
  const sample = rng();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("Random source must return a finite number from 0 (inclusive) to 1 (exclusive)");
  }
  return Math.floor(sample * length);
}

function practiceCandidates(
  evidence: Readonly<FamilyEvidence> | undefined,
  excluded: ReadonlySet<NoteLetter> = new Set(),
): NoteLetter[] {
  const available = NOTE_LETTERS.filter((letter) => !excluded.has(letter));
  if (!evidence) return available;

  const learning = available.filter((letter) => !isNoteMastered(evidence[letter]));
  return learning.length ? learning : available;
}

export function choosePracticeLetter(
  evidence?: Readonly<FamilyEvidence>,
  rng: RandomSource = Math.random,
): NoteLetter {
  const candidates = practiceCandidates(evidence);
  return candidates[chooseIndex(candidates.length, rng)];
}

export function createNoteFamilyTrial(
  familyId: NoteFamilyId,
  rng: RandomSource = Math.random,
  evidence?: Readonly<FamilyEvidence>,
): NoteFamilyTrial {
  const family = getNoteFamily(familyId);
  const targetLetter = choosePracticeLetter(evidence, rng);

  return {
    familyId,
    octave: family.octave,
    targetLetter,
    targetPitchClass: pitchClassForLetter(targetLetter),
    targetMidi: midiForFamilyLetter(familyId, targetLetter),
  };
}

export function createReferenceTrial(
  familyId: NoteFamilyId,
  options: Readonly<ReferenceTrialOptions> = {},
): ReferenceTrial {
  const family = getNoteFamily(familyId);
  const anchorLetter = options.anchorLetter ?? "A";
  const excluded = options.allowSame ? new Set<NoteLetter>() : new Set([anchorLetter]);
  const candidates = practiceCandidates(options.evidence, excluded);
  const rng = options.rng ?? Math.random;
  const targetLetter = candidates[chooseIndex(candidates.length, rng)];

  return {
    familyId,
    octave: family.octave,
    anchorLetter,
    anchorPitchClass: pitchClassForLetter(anchorLetter),
    anchorMidi: midiForFamilyLetter(familyId, anchorLetter),
    targetLetter,
    targetPitchClass: pitchClassForLetter(targetLetter),
    targetMidi: midiForFamilyLetter(familyId, targetLetter),
  };
}
