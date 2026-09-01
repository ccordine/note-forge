import {
  requireSupportedProductionEligibility,
} from "./tone-map-course-validation";
import { createToneMapCourseRestorer } from "./tone-map-course-restore";
import { requireToneMapSimonLength } from "./tone-map-config";
import { isToneMapProductionMidiSupported } from "./tone-map-production-range";

export const TONE_MAP_MIN_MIDI = 21;
export const TONE_MAP_MAX_MIDI = 108;
export const TONE_MAP_LEVEL_SIZE = 6;
export const TONE_MAP_GUIDED_CORRECT_REQUIRED = 2;
export const TONE_MAP_BLIND_CORRECT_REQUIRED = 3;
export const TONE_MAP_TONE_COUNT = TONE_MAP_MAX_MIDI - TONE_MAP_MIN_MIDI + 1;
export const TONE_MAP_LEVEL_COUNT = Math.ceil(TONE_MAP_TONE_COUNT / TONE_MAP_LEVEL_SIZE);

export type ToneMapSeed = string | number;
export type ToneMapSkill = "identification" | "production";
export type ToneMapCueVisibility = "guided" | "blind";
export type ToneMapChallengeKind =
  | "keyboard-identification"
  | "voice-production"
  | "voice-imitation";
export type ProductionEligibility = "unassessed" | "reachable" | "unreachable";
export type ToneMapTaskResult = "correct" | "incorrect" | "production-unreachable";

export const TONE_MAP_KEYBOARD_SKILLS = Object.freeze(["identification"] as const);
export const TONE_MAP_VOICE_SKILLS = Object.freeze(["production"] as const);
export const TONE_MAP_MIXED_SKILLS = Object.freeze(["identification", "production"] as const);

export interface ToneMapSkillEvidence {
  readonly attempts: number;
  readonly correct: number;
  readonly correctStreak: number;
  readonly bestCorrectStreak: number;
  readonly guidedAttempts: number;
  readonly guidedCorrect: number;
  readonly guidedStreak: number;
  readonly bestGuidedStreak: number;
  readonly blindAttempts: number;
  readonly blindCorrect: number;
  readonly blindStreak: number;
  readonly bestBlindStreak: number;
  readonly blindConfirmedAfterGuidance: boolean;
  readonly stable: boolean;
  readonly lapses: number;
  readonly guidedRecoveryRemaining: 0 | 1;
  readonly lastBlindConfirmedLevel: number | null;
}

export interface ToneMapToneState {
  readonly identification: ToneMapSkillEvidence;
  readonly production: ToneMapSkillEvidence;
  readonly productionEligibility: ProductionEligibility;
}

export interface ToneMapCourseState {
  readonly version: 2;
  /** Persist this exact progressive order; never regenerate it when restoring a course. */
  readonly order: readonly number[];
  readonly currentLevel: number;
  readonly tones: Readonly<Record<number, ToneMapToneState>>;
}

export interface ToneMapTask {
  readonly midi: number;
  readonly skill: ToneMapSkill;
  readonly challengeKind: ToneMapChallengeKind;
  readonly cueVisibility: ToneMapCueVisibility;
}

export interface ChooseToneMapTaskOptions {
  readonly requiredSkills: readonly ToneMapSkill[];
  readonly seed: ToneMapSeed;
  readonly previousTask?: Pick<ToneMapTask, "midi" | "skill"> | null;
  readonly productionChallengeKind?: Extract<ToneMapChallengeKind, "voice-production" | "voice-imitation">;
}

export interface ToneMapSkillSummary {
  readonly eligibleMidis: readonly number[];
  readonly excludedMidis: readonly number[];
  readonly stableMidis: readonly number[];
  readonly unstableMidis: readonly number[];
  readonly blindConfirmedMidis: readonly number[];
  readonly allStable: boolean;
  readonly hasCurrentLevelBlindConfirmation: boolean;
}

export interface ToneMapLevelSummary {
  readonly currentLevel: number;
  readonly totalLevels: number;
  readonly introducedMidis: readonly number[];
  readonly activeMidis: readonly number[];
  readonly requiredSkills: readonly ToneMapSkill[];
  readonly identification: ToneMapSkillSummary;
  readonly production: ToneMapSkillSummary;
  readonly canAdvance: boolean;
  readonly courseComplete: boolean;
}

const SKILLS = Object.freeze(["identification", "production"] as const);
const TONE_MAP_REGISTER_BASES = Object.freeze([60, 48, 72, 36, 84, 24, 96] as const);
const TONE_MAP_LANDMARK_OFFSETS = Object.freeze([0, 2, 4, 6, 8, 10] as const);
const TONE_MAP_GAP_OFFSETS = Object.freeze([1, 3, 5, 7, 9, 11] as const);
const TONE_MAP_EDGE_MIDIS = Object.freeze([21, 22, 23, 108] as const);
const EMPTY_EVIDENCE: ToneMapSkillEvidence = Object.freeze({
  attempts: 0,
  correct: 0,
  correctStreak: 0,
  bestCorrectStreak: 0,
  guidedAttempts: 0,
  guidedCorrect: 0,
  guidedStreak: 0,
  bestGuidedStreak: 0,
  blindAttempts: 0,
  blindCorrect: 0,
  blindStreak: 0,
  bestBlindStreak: 0,
  blindConfirmedAfterGuidance: false,
  stable: false,
  lapses: 0,
  guidedRecoveryRemaining: 0,
  lastBlindConfirmedLevel: null,
});

function requireMidi(midi: number): void {
  if (!Number.isInteger(midi) || midi < TONE_MAP_MIN_MIDI || midi > TONE_MAP_MAX_MIDI) {
    throw new RangeError(`MIDI must be an integer from ${TONE_MAP_MIN_MIDI} through ${TONE_MAP_MAX_MIDI}.`);
  }
}

function requireLevel(level: number): void {
  if (!Number.isInteger(level) || level < 1 || level > TONE_MAP_LEVEL_COUNT) {
    throw new RangeError(`Level must be an integer from 1 through ${TONE_MAP_LEVEL_COUNT}.`);
  }
}

function requireSkills(skills: readonly ToneMapSkill[]): readonly ToneMapSkill[] {
  if (skills.length === 0) throw new RangeError("At least one required skill is needed.");
  const unique = [...new Set(skills)];
  if (unique.length !== skills.length || unique.some((skill) => !SKILLS.includes(skill))) {
    throw new RangeError("Required skills must be unique identification and/or production values.");
  }
  return unique;
}

function normalizedSeed(seed: ToneMapSeed): number {
  if (typeof seed === "number" && !Number.isFinite(seed)) throw new RangeError("Seed must be finite.");
  const text = `${typeof seed}:${String(seed)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function createSeededRandom(seed: ToneMapSeed): () => number {
  let state = normalizedSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(values: readonly T[], seed: ToneMapSeed): T[] {
  const result = [...values];
  const random = createSeededRandom(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function pianoMidis(): number[] {
  return Array.from({ length: TONE_MAP_TONE_COUNT }, (_, index) => TONE_MAP_MIN_MIDI + index);
}

/**
 * The map begins with coarse landmarks in C4-B4, fills the semitone gaps, and
 * then repeats that landmark/gap relationship in neighboring registers while
 * alternating outward. The four physical-piano edge keys form the final band.
 */
function progressiveLevelBands(): readonly (readonly number[])[] {
  return Object.freeze([
    ...TONE_MAP_REGISTER_BASES.flatMap((baseMidi) => [
      Object.freeze(TONE_MAP_LANDMARK_OFFSETS.map((offset) => baseMidi + offset)),
      Object.freeze(TONE_MAP_GAP_OFFSETS.map((offset) => baseMidi + offset)),
    ]),
    TONE_MAP_EDGE_MIDIS,
  ]);
}

const TONE_MAP_LEVEL_BANDS = progressiveLevelBands();

function hasSameMidis(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((midi) => right.includes(midi));
}

function emptyTones(): Record<number, ToneMapToneState> {
  return Object.fromEntries(pianoMidis().map((midi) => [midi, {
    identification: { ...EMPTY_EVIDENCE },
    production: { ...EMPTY_EVIDENCE },
    productionEligibility: isToneMapProductionMidiSupported(midi) ? "unassessed" : "unreachable",
  }])) as Record<number, ToneMapToneState>;
}

export function validateToneMapCourseOrder(candidate: unknown): readonly number[] {
  if (!Array.isArray(candidate) || candidate.length !== TONE_MAP_TONE_COUNT) {
    throw new TypeError(`Course order must contain all ${TONE_MAP_TONE_COUNT} piano notes.`);
  }
  const order = candidate.map((value) => {
    if (typeof value !== "number") throw new TypeError("Course order values must be MIDI numbers.");
    requireMidi(value);
    return value;
  });
  if (new Set(order).size !== TONE_MAP_TONE_COUNT) throw new RangeError("Course order cannot repeat a MIDI note.");
  for (let levelIndex = 0; levelIndex < TONE_MAP_LEVEL_BANDS.length; levelIndex += 1) {
    const start = levelIndex * TONE_MAP_LEVEL_SIZE;
    const actual = order.slice(start, start + TONE_MAP_LEVEL_SIZE);
    const expected = TONE_MAP_LEVEL_BANDS[levelIndex]!;
    if (!hasSameMidis(actual, expected)) {
      throw new RangeError("Course order must preserve progressive landmark and gap-fill levels.");
    }
  }
  return order;
}

export function createToneMapCourse(seed: ToneMapSeed): ToneMapCourseState {
  const order = TONE_MAP_LEVEL_BANDS.flatMap((band, levelIndex) => (
    shuffled(band, `${String(seed)}:level:${levelIndex + 1}`)
  ));
  return { version: 2, order, currentLevel: 1, tones: emptyTones() };
}

/** Strictly restores the persisted model without regenerating its course order. */
export const restoreToneMapCourse = createToneMapCourseRestorer({
  minimumMidi: TONE_MAP_MIN_MIDI,
  maximumMidi: TONE_MAP_MAX_MIDI,
  levelSize: TONE_MAP_LEVEL_SIZE,
  guidedCorrectRequired: TONE_MAP_GUIDED_CORRECT_REQUIRED,
  blindCorrectRequired: TONE_MAP_BLIND_CORRECT_REQUIRED,
  validateOrder: validateToneMapCourseOrder,
  requireLevel,
  emptyTones,
});

export function toneMapLevelMidis(course: ToneMapCourseState, level = course.currentLevel): readonly number[] {
  requireLevel(level);
  const start = (level - 1) * TONE_MAP_LEVEL_SIZE;
  return course.order.slice(start, Math.min(start + TONE_MAP_LEVEL_SIZE, TONE_MAP_TONE_COUNT));
}

export function toneMapActiveMidis(course: ToneMapCourseState): readonly number[] {
  return course.order.slice(0, Math.min(course.currentLevel * TONE_MAP_LEVEL_SIZE, TONE_MAP_TONE_COUNT));
}

export function toneMapCueVisibility(evidence: ToneMapSkillEvidence): ToneMapCueVisibility {
  if (evidence.guidedRecoveryRemaining > 0) return "guided";
  return evidence.guidedStreak < TONE_MAP_GUIDED_CORRECT_REQUIRED ? "guided" : "blind";
}

function evidenceFor(course: ToneMapCourseState, midi: number, skill: ToneMapSkill): ToneMapSkillEvidence {
  requireMidi(midi);
  return course.tones[midi]![skill];
}

function replaceEvidence(
  course: ToneMapCourseState,
  midi: number,
  skill: ToneMapSkill,
  evidence: ToneMapSkillEvidence,
): ToneMapCourseState {
  const tone = course.tones[midi]!;
  return {
    ...course,
    tones: { ...course.tones, [midi]: { ...tone, [skill]: evidence } },
  };
}

function updatedEvidence(
  previous: ToneMapSkillEvidence,
  cueVisibility: ToneMapCueVisibility,
  wasCorrect: boolean,
  level: number,
): ToneMapSkillEvidence {
  const correctStreak = wasCorrect ? previous.correctStreak + 1 : 0;
  const common = {
    ...previous,
    attempts: previous.attempts + 1,
    correct: previous.correct + (wasCorrect ? 1 : 0),
    correctStreak,
    bestCorrectStreak: Math.max(previous.bestCorrectStreak, correctStreak),
  };
  if (cueVisibility === "guided") {
    const guidedStreak = wasCorrect ? previous.guidedStreak + 1 : 0;
    const recovering = previous.guidedRecoveryRemaining > 0;
    const establishingAssociation = previous.guidedStreak < TONE_MAP_GUIDED_CORRECT_REQUIRED;
    return {
      ...common,
      guidedAttempts: previous.guidedAttempts + 1,
      guidedCorrect: previous.guidedCorrect + (wasCorrect ? 1 : 0),
      guidedStreak,
      bestGuidedStreak: Math.max(previous.bestGuidedStreak, guidedStreak),
      blindStreak: recovering || establishingAssociation ? 0 : previous.blindStreak,
      blindConfirmedAfterGuidance: recovering || !wasCorrect ? false : previous.blindConfirmedAfterGuidance,
      stable: recovering || establishingAssociation || !wasCorrect ? false : previous.stable,
      guidedRecoveryRemaining: wasCorrect ? 0 : previous.guidedRecoveryRemaining,
      lastBlindConfirmedLevel: establishingAssociation ? null : previous.lastBlindConfirmedLevel,
    };
  }
  const guidanceEstablished = previous.guidedStreak >= TONE_MAP_GUIDED_CORRECT_REQUIRED
    && previous.guidedRecoveryRemaining === 0;
  const blindConfirmedAfterGuidance = wasCorrect && guidanceEstablished;
  const blindStreak = blindConfirmedAfterGuidance ? previous.blindStreak + 1 : 0;
  const stable = blindStreak >= TONE_MAP_BLIND_CORRECT_REQUIRED && blindConfirmedAfterGuidance;
  return {
    ...common,
    blindAttempts: previous.blindAttempts + 1,
    blindCorrect: previous.blindCorrect + (wasCorrect ? 1 : 0),
    blindStreak,
    bestBlindStreak: Math.max(previous.bestBlindStreak, blindStreak),
    blindConfirmedAfterGuidance,
    stable,
    lapses: previous.lapses + (wasCorrect ? 0 : 1),
    guidedRecoveryRemaining: wasCorrect ? previous.guidedRecoveryRemaining : 1,
    lastBlindConfirmedLevel: stable ? level : null,
  };
}

export function recordToneMapTaskResult(
  course: ToneMapCourseState,
  task: ToneMapTask,
  result: ToneMapTaskResult,
): ToneMapCourseState {
  if (!toneMapActiveMidis(course).includes(task.midi)) throw new RangeError("Task MIDI is not active in this level.");
  if (result === "production-unreachable") {
    if (task.skill !== "production") throw new RangeError("Only production tasks can be marked unreachable.");
    return setToneMapProductionEligibility(course, task.midi, "unreachable");
  }
  const previous = evidenceFor(course, task.midi, task.skill);
  const withEvidence = replaceEvidence(
    course,
    task.midi,
    task.skill,
    updatedEvidence(previous, task.cueVisibility, result === "correct", course.currentLevel),
  );
  return task.skill === "production" && result === "correct"
    ? setToneMapProductionEligibility(withEvidence, task.midi, "reachable")
    : withEvidence;
}

export function setToneMapProductionEligibility(
  course: ToneMapCourseState,
  midi: number,
  eligibility: ProductionEligibility,
): ToneMapCourseState {
  requireMidi(midi);
  requireSupportedProductionEligibility(midi, eligibility);
  const tone = course.tones[midi]!;
  if (tone.productionEligibility === eligibility) return course;
  return {
    ...course,
    tones: { ...course.tones, [midi]: { ...tone, productionEligibility: eligibility } },
  };
}

/**
 * Every active task advances through one cumulative randomized challenge. New
 * tones spend their first two rounds building association while retained tones
 * immediately supply blind evidence. Lowest-round selection makes every active
 * task appear before any task advances again, so an added band cannot replace
 * or starve the familiar pool.
 */
function taskSelectionRank(course: ToneMapCourseState, task: ToneMapTask): readonly number[] {
  const evidence = evidenceFor(course, task.midi, task.skill);
  if (evidence.guidedRecoveryRemaining > 0) return [-1, -evidence.lapses];
  const introduced = toneMapLevelMidis(course).includes(task.midi);
  const needsLevelGuidance = introduced || evidence.bestBlindStreak < TONE_MAP_BLIND_CORRECT_REQUIRED;
  const guidanceProgress = needsLevelGuidance
    ? Math.min(evidence.guidedStreak, TONE_MAP_GUIDED_CORRECT_REQUIRED)
    : 0;
  return [guidanceProgress + evidence.blindStreak, -evidence.lapses];
}

function compareTaskRank(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function chooseToneMapTask(
  course: ToneMapCourseState,
  options: ChooseToneMapTaskOptions,
): ToneMapTask | null {
  const skills = requireSkills(options.requiredSkills);
  const candidates: ToneMapTask[] = [];
  for (const midi of toneMapActiveMidis(course)) {
    for (const skill of skills) {
      if (skill === "production" && course.tones[midi]!.productionEligibility === "unreachable") continue;
      const challengeKind = skill === "identification"
        ? "keyboard-identification"
        : options.productionChallengeKind ?? "voice-production";
      candidates.push({ midi, skill, challengeKind, cueVisibility: toneMapCueVisibility(evidenceFor(course, midi, skill)) });
    }
  }
  if (candidates.length === 0) return null;
  const withoutRepeat = candidates.filter((task) => task.midi !== options.previousTask?.midi);
  const eligible = withoutRepeat.length > 0 ? withoutRepeat : candidates;
  eligible.sort((left, right) => compareTaskRank(taskSelectionRank(course, left), taskSelectionRank(course, right)));
  const nextRank = taskSelectionRank(course, eligible[0]!);
  const pool = eligible.filter((task) => compareTaskRank(taskSelectionRank(course, task), nextRank) === 0);
  const random = createSeededRandom(options.seed);
  return pool[Math.floor(random() * pool.length)]!;
}

function summarizeSkill(
  course: ToneMapCourseState,
  skill: ToneMapSkill,
  activeMidis: readonly number[],
): ToneMapSkillSummary {
  const excludedMidis = skill === "production"
    ? activeMidis.filter((midi) => course.tones[midi]!.productionEligibility === "unreachable")
    : [];
  const excluded = new Set(excludedMidis);
  const eligibleMidis = activeMidis.filter((midi) => !excluded.has(midi));
  const stableMidis = eligibleMidis.filter((midi) => evidenceFor(course, midi, skill).stable);
  const blindConfirmedMidis = eligibleMidis.filter(
    (midi) => evidenceFor(course, midi, skill).lastBlindConfirmedLevel === course.currentLevel,
  );
  return {
    eligibleMidis,
    excludedMidis,
    stableMidis,
    unstableMidis: eligibleMidis.filter((midi) => !evidenceFor(course, midi, skill).stable),
    blindConfirmedMidis,
    allStable: stableMidis.length === eligibleMidis.length,
    hasCurrentLevelBlindConfirmation: blindConfirmedMidis.length === eligibleMidis.length,
  };
}

export function summarizeToneMapLevel(
  course: ToneMapCourseState,
  requiredSkills: readonly ToneMapSkill[],
): ToneMapLevelSummary {
  const required = requireSkills(requiredSkills);
  const activeMidis = toneMapActiveMidis(course);
  const identification = summarizeSkill(course, "identification", activeMidis);
  const production = summarizeSkill(course, "production", activeMidis);
  const bySkill = { identification, production };
  const gateOpen = required.every((skill) => (
    bySkill[skill].allStable && bySkill[skill].hasCurrentLevelBlindConfirmation
  ));
  return {
    currentLevel: course.currentLevel,
    totalLevels: TONE_MAP_LEVEL_COUNT,
    introducedMidis: toneMapLevelMidis(course),
    activeMidis,
    requiredSkills: required,
    identification,
    production,
    canAdvance: gateOpen && course.currentLevel < TONE_MAP_LEVEL_COUNT,
    courseComplete: gateOpen && course.currentLevel === TONE_MAP_LEVEL_COUNT,
  };
}

export function advanceToneMapLevel(
  course: ToneMapCourseState,
  requiredSkills: readonly ToneMapSkill[],
): ToneMapCourseState {
  if (!summarizeToneMapLevel(course, requiredSkills).canAdvance) return course;
  const tones = { ...course.tones };
  for (const midi of toneMapActiveMidis(course)) {
    const tone = tones[midi]!;
    tones[midi] = {
      ...tone,
      identification: resetLevelStabilityProof(tone.identification),
      production: resetLevelStabilityProof(tone.production),
    };
  }
  return { ...course, currentLevel: course.currentLevel + 1, tones };
}

function resetLevelStabilityProof(evidence: ToneMapSkillEvidence): ToneMapSkillEvidence {
  return {
    ...evidence,
    blindStreak: 0,
    blindConfirmedAfterGuidance: false,
    stable: false,
    lastBlindConfirmedLevel: null,
  };
}

export function createToneMapSimonSequence(
  course: ToneMapCourseState,
  options: Readonly<{ seed: ToneMapSeed; length: number }>,
): readonly number[] {
  requireToneMapSimonLength(options.length);
  const active = toneMapActiveMidis(course);
  const sequence: number[] = [];
  let cycle = 0;
  while (sequence.length < options.length) {
    let batch = shuffled(active, `${String(options.seed)}:${cycle}`);
    if (sequence.length > 0 && batch.length > 1 && batch[0] === sequence[sequence.length - 1]) {
      [batch[0], batch[1]] = [batch[1]!, batch[0]!];
    }
    sequence.push(...batch.slice(0, options.length - sequence.length));
    cycle += 1;
  }
  return sequence;
}
