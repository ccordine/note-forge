import { validateRestoredToneMapTone } from "./tone-map-course-validation";
import type {
  ProductionEligibility,
  ToneMapCourseState,
  ToneMapSkillEvidence,
  ToneMapToneState,
} from "./tone-map-model";

interface ToneMapCourseRestoreConfig {
  readonly minimumMidi: number;
  readonly maximumMidi: number;
  readonly levelSize: number;
  readonly guidedCorrectRequired: number;
  readonly blindCorrectRequired: number;
  readonly validateOrder: (candidate: unknown) => readonly number[];
  readonly requireLevel: (level: number) => void;
  readonly emptyTones: () => Record<number, ToneMapToneState>;
}

function requireRecord(candidate: unknown, label: string): Record<string, unknown> {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return candidate as Record<string, unknown>;
}

function requireCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${key} must be a non-negative integer.`);
  }
  return value as number;
}

function restoreEvidence(
  candidate: unknown,
  config: ToneMapCourseRestoreConfig,
): ToneMapSkillEvidence {
  const record = requireRecord(candidate, "Skill evidence");
  const attempts = requireCount(record, "attempts");
  const correct = requireCount(record, "correct");
  const correctStreak = requireCount(record, "correctStreak");
  const bestCorrectStreak = requireCount(record, "bestCorrectStreak");
  const guidedAttempts = requireCount(record, "guidedAttempts");
  const guidedCorrect = requireCount(record, "guidedCorrect");
  const guidedStreak = requireCount(record, "guidedStreak");
  const bestGuidedStreak = requireCount(record, "bestGuidedStreak");
  const blindAttempts = requireCount(record, "blindAttempts");
  const blindCorrect = requireCount(record, "blindCorrect");
  const blindStreak = requireCount(record, "blindStreak");
  const bestBlindStreak = requireCount(record, "bestBlindStreak");
  const lapses = requireCount(record, "lapses");
  const blindConfirmedAfterGuidance = record.blindConfirmedAfterGuidance;
  const stable = record.stable;
  const recovery = record.guidedRecoveryRemaining;
  const confirmed = record.lastBlindConfirmedLevel;
  const countsValid = correct <= attempts
    && guidedCorrect <= guidedAttempts
    && blindCorrect <= blindAttempts
    && guidedAttempts + blindAttempts === attempts
    && guidedCorrect + blindCorrect === correct
    && correctStreak <= correct
    && correctStreak <= bestCorrectStreak
    && bestCorrectStreak <= correct
    && guidedStreak <= guidedCorrect
    && guidedStreak <= bestGuidedStreak
    && bestGuidedStreak <= guidedCorrect
    && blindStreak <= blindCorrect
    && blindStreak <= bestBlindStreak
    && bestBlindStreak <= blindCorrect
    && lapses <= blindAttempts;
  if (!countsValid) throw new RangeError("Stored evidence counters are inconsistent.");
  if (typeof blindConfirmedAfterGuidance !== "boolean") {
    throw new TypeError("Stored post-guidance blind confirmation must be boolean.");
  }
  if (recovery !== 0 && recovery !== 1) {
    throw new RangeError("Stored guided recovery must be zero or one.");
  }
  if (recovery === 1 && lapses === 0) {
    throw new RangeError("Stored guided recovery requires a blind lapse.");
  }
  const expectedStable = guidedStreak >= config.guidedCorrectRequired
    && blindStreak >= config.blindCorrectRequired
    && blindConfirmedAfterGuidance
    && recovery === 0;
  if (typeof stable !== "boolean" || stable !== expectedStable) {
    throw new TypeError("Stored stability must agree with guided and blind evidence ordering.");
  }
  if (blindConfirmedAfterGuidance && (
    guidedStreak < config.guidedCorrectRequired || blindStreak < 1 || recovery !== 0
  )) throw new RangeError("Stored blind confirmation is not post-guidance evidence.");
  if (confirmed !== null) config.requireLevel(confirmed as number);
  return {
    attempts, correct, correctStreak, bestCorrectStreak,
    guidedAttempts, guidedCorrect, guidedStreak, bestGuidedStreak,
    blindAttempts, blindCorrect, blindStreak, bestBlindStreak,
    blindConfirmedAfterGuidance, stable, lapses, guidedRecoveryRemaining: recovery,
    lastBlindConfirmedLevel: confirmed as number | null,
  };
}

function restoreEligibility(candidate: unknown, midi: number): ProductionEligibility {
  if (candidate !== "unassessed" && candidate !== "reachable" && candidate !== "unreachable") {
    throw new RangeError(`Stored MIDI ${midi} has invalid production eligibility.`);
  }
  return candidate;
}

function validateStoredMidiKeys(
  storedTones: Record<string, unknown>,
  config: ToneMapCourseRestoreConfig,
): void {
  const expected = Array.from(
    { length: config.maximumMidi - config.minimumMidi + 1 },
    (_, index) => String(config.minimumMidi + index),
  );
  const actual = Object.keys(storedTones);
  if (actual.length !== expected.length || expected.some((midi) => !Object.hasOwn(storedTones, midi))) {
    throw new RangeError("Stored tones must contain exactly the physical piano MIDI keys.");
  }
}

export function createToneMapCourseRestorer(
  config: ToneMapCourseRestoreConfig,
): (candidate: unknown) => ToneMapCourseState {
  return (candidate) => {
    const record = requireRecord(candidate, "Tone-map course");
    if (record.version !== 1) throw new RangeError("Unsupported tone-map course version.");
    const order = config.validateOrder(record.order);
    const currentLevel = record.currentLevel;
    if (typeof currentLevel !== "number") throw new TypeError("Stored level must be numeric.");
    config.requireLevel(currentLevel);
    const storedTones = requireRecord(record.tones, "Stored tones");
    validateStoredMidiKeys(storedTones, config);
    const tones = config.emptyTones();
    const active = new Set(order.slice(0, currentLevel * config.levelSize));
    for (let midi = config.minimumMidi; midi <= config.maximumMidi; midi += 1) {
      const storedTone = requireRecord(storedTones[String(midi)], `Stored MIDI ${midi}`);
      const tone: ToneMapToneState = {
        identification: restoreEvidence(storedTone.identification, config),
        production: restoreEvidence(storedTone.production, config),
        productionEligibility: restoreEligibility(storedTone.productionEligibility, midi),
      };
      validateRestoredToneMapTone(midi, tone, currentLevel, active.has(midi));
      tones[midi] = tone;
    }
    return { version: 1, order, currentLevel, tones };
  };
}
