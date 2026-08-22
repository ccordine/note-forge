import { getUnlockedSkillDefinitions, SKILL_CATALOG } from "./skill-graph";
import type { SkillDefinition, SkillState } from "./types";

export type RandomSource = () => number;
export type SessionBucket = "weak_due" | "recent" | "exploration" | "maintenance";
export type ExerciseDirection = "ascending" | "descending";

export interface SessionMix {
  weakDue: number;
  recent: number;
  exploration: number;
}

export interface ExerciseVariation {
  keyPitchClass: number;
  octave: number;
  startingMidi: number;
  timbre: string;
  direction: ExerciseDirection;
  noteDurationMs: number;
  amplitude: number;
}

export interface VariationPools {
  keyPitchClasses: readonly number[];
  octaves: readonly number[];
  timbres: readonly string[];
  directions: readonly ExerciseDirection[];
  noteDurationsMs: readonly number[];
  amplitudes: readonly number[];
}

export interface AdaptiveSessionOptions {
  sessionSize: number;
  now?: Date;
  rng?: RandomSource;
  mix?: Partial<SessionMix>;
  weakMasteryThreshold?: number;
  weakRecentAccuracyThreshold?: number;
  recentWindowDays?: number;
  prerequisiteMasteryThreshold?: number;
  respectPrerequisites?: boolean;
  variationPools?: Partial<VariationPools>;
}

export interface ScheduledPractice {
  skillId: string;
  definition: SkillDefinition;
  /** Why this skill qualified at scheduling time. */
  bucket: SessionBucket;
  /** The requested part of the 60/20/20 mix; may differ when a pool is empty. */
  plannedBucket: Exclude<SessionBucket, "maintenance">;
  variation: ExerciseVariation;
}

const DEFAULT_MIX: SessionMix = { weakDue: 0.6, recent: 0.2, exploration: 0.2 };
const DAY_MS = 86_400_000;

const DEFAULT_VARIATION_POOLS: VariationPools = {
  keyPitchClasses: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  octaves: [2, 3, 4, 5],
  timbres: [
    "sine",
    "triangle",
    "piano",
    "guitar",
    "bass",
    "flute",
    "voice",
    "harmonic-synth",
  ],
  directions: ["ascending", "descending"],
  noteDurationsMs: [500, 750, 1_000, 1_500, 2_000],
  amplitudes: [0.25, 0.4, 0.55, 0.7],
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const normalizedRandom = (rng: RandomSource): number => {
  const value = rng();
  if (!Number.isFinite(value)) throw new TypeError("The injected RNG must return a finite number.");
  return clamp(value, 0, 1 - Number.EPSILON);
};

const choose = <T>(values: readonly T[], rng: RandomSource): T => {
  if (values.length === 0) throw new RangeError("Variation pools cannot be empty.");
  return values[Math.floor(normalizedRandom(rng) * values.length)];
};

/** Mulberry32: a small repeatable RNG for reproducible sessions and tests. */
export const createSeededRng = (seed: number): RandomSource => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const timestamp = (isoDate: string | undefined): number | undefined => {
  if (!isoDate) return undefined;
  const value = Date.parse(isoDate);
  return Number.isFinite(value) ? value : undefined;
};

const normalizedMix = (mix: Partial<SessionMix> | undefined): SessionMix => {
  const candidate = {
    weakDue: Math.max(0, mix?.weakDue ?? DEFAULT_MIX.weakDue),
    recent: Math.max(0, mix?.recent ?? DEFAULT_MIX.recent),
    exploration: Math.max(0, mix?.exploration ?? DEFAULT_MIX.exploration),
  };
  const total = candidate.weakDue + candidate.recent + candidate.exploration;
  if (!(total > 0) || !Number.isFinite(total)) return DEFAULT_MIX;
  return {
    weakDue: candidate.weakDue / total,
    recent: candidate.recent / total,
    exploration: candidate.exploration / total,
  };
};

/** Uses largest remainders so a ten-item session is exactly 6/2/2. */
export const allocateSessionMix = (sessionSize: number, mix?: Partial<SessionMix>): Record<
  Exclude<SessionBucket, "maintenance">,
  number
> => {
  if (!Number.isInteger(sessionSize) || sessionSize < 0) {
    throw new RangeError("sessionSize must be a non-negative integer.");
  }
  const normalized = normalizedMix(mix);
  const rows = [
    { bucket: "weak_due" as const, raw: normalized.weakDue * sessionSize, order: 0 },
    { bucket: "recent" as const, raw: normalized.recent * sessionSize, order: 1 },
    { bucket: "exploration" as const, raw: normalized.exploration * sessionSize, order: 2 },
  ].map((row) => ({ ...row, count: Math.floor(row.raw), remainder: row.raw - Math.floor(row.raw) }));
  let remaining = sessionSize - rows.reduce((sum, row) => sum + row.count, 0);
  const remainderOrder = [...rows].sort(
    (left, right) => right.remainder - left.remainder || left.order - right.order,
  );
  for (let index = 0; index < remaining; index += 1) {
    remainderOrder[index % remainderOrder.length].count += 1;
  }
  return {
    weak_due: rows.find((row) => row.bucket === "weak_due")?.count ?? 0,
    recent: rows.find((row) => row.bucket === "recent")?.count ?? 0,
    exploration: rows.find((row) => row.bucket === "exploration")?.count ?? 0,
  };
};

const shuffle = <T>(values: T[], rng: RandomSource): T[] => {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(normalizedRandom(rng) * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
};

interface Candidate {
  definition: SkillDefinition;
  state?: SkillState;
  bucket: SessionBucket;
  weight: number;
}

const weightedChoice = (
  candidates: readonly Candidate[],
  selectionCounts: Readonly<Record<string, number>>,
  rng: RandomSource,
): Candidate => {
  const adjustedWeights = candidates.map((candidate) => {
    const repeatPenalty = 1 + (selectionCounts[candidate.definition.skillId] ?? 0);
    return Math.max(0.0001, candidate.weight / repeatPenalty);
  });
  const total = adjustedWeights.reduce((sum, weight) => sum + weight, 0);
  let cursor = normalizedRandom(rng) * total;
  for (let index = 0; index < candidates.length; index += 1) {
    cursor -= adjustedWeights[index];
    if (cursor < 0) return candidates[index];
  }
  return candidates[candidates.length - 1];
};

const resolveVariationPools = (overrides: Partial<VariationPools> | undefined): VariationPools => {
  const result: VariationPools = {
    keyPitchClasses: overrides?.keyPitchClasses ?? DEFAULT_VARIATION_POOLS.keyPitchClasses,
    octaves: overrides?.octaves ?? DEFAULT_VARIATION_POOLS.octaves,
    timbres: overrides?.timbres ?? DEFAULT_VARIATION_POOLS.timbres,
    directions: overrides?.directions ?? DEFAULT_VARIATION_POOLS.directions,
    noteDurationsMs: overrides?.noteDurationsMs ?? DEFAULT_VARIATION_POOLS.noteDurationsMs,
    amplitudes: overrides?.amplitudes ?? DEFAULT_VARIATION_POOLS.amplitudes,
  };
  for (const [name, values] of Object.entries(result)) {
    if (values.length === 0) throw new RangeError(`${name} cannot be empty.`);
  }
  return result;
};

const makeVariation = (pools: VariationPools, rng: RandomSource): ExerciseVariation => {
  const keyPitchClass = ((Math.round(choose(pools.keyPitchClasses, rng)) % 12) + 12) % 12;
  const octave = Math.round(choose(pools.octaves, rng));
  return {
    keyPitchClass,
    octave,
    startingMidi: keyPitchClass + 12 * (octave + 1),
    timbre: choose(pools.timbres, rng),
    direction: choose(pools.directions, rng),
    noteDurationMs: choose(pools.noteDurationsMs, rng),
    amplitude: clamp(choose(pools.amplitudes, rng), 0, 1),
  };
};

const fallbackOrder: Record<Exclude<SessionBucket, "maintenance">, SessionBucket[]> = {
  weak_due: ["weak_due", "maintenance", "recent", "exploration"],
  recent: ["recent", "weak_due", "maintenance", "exploration"],
  exploration: ["exploration", "weak_due", "recent", "maintenance"],
};

/**
 * Builds an adaptive practice queue. It only consumes persisted skill observations;
 * exercise generation and audio capture remain outside this package.
 */
export function generateAdaptiveSession(
  definitions: readonly SkillDefinition[],
  states: Readonly<Record<string, SkillState | undefined>>,
  options: AdaptiveSessionOptions,
): ScheduledPractice[] {
  if (!options) throw new TypeError("Adaptive session options are required.");
  const allocations = allocateSessionMix(options.sessionSize, options.mix);
  if (options.sessionSize === 0 || definitions.length === 0) return [];
  const rng = options.rng ?? Math.random;
  const nowMs = (options.now ?? new Date()).getTime();
  const weakMasteryThreshold = clamp(options.weakMasteryThreshold ?? 0.62, 0, 1);
  const weakRecentAccuracyThreshold = clamp(options.weakRecentAccuracyThreshold ?? 0.65, 0, 1);
  const recentCutoff = nowMs - (options.recentWindowDays ?? 7) * DAY_MS;
  const respectPrerequisites = options.respectPrerequisites ?? true;
  const allowedIds = new Set(
    (respectPrerequisites
      ? getUnlockedSkillDefinitions(
          states,
          definitions,
          options.prerequisiteMasteryThreshold ?? 0.6,
        )
      : definitions
    ).map((definition) => definition.skillId),
  );
  const pools: Record<SessionBucket, Candidate[]> = {
    weak_due: [],
    recent: [],
    exploration: [],
    maintenance: [],
  };

  for (const definition of definitions) {
    if (!allowedIds.has(definition.skillId)) continue;
    const state = states[definition.skillId];
    if (!state || state.attemptCount === 0) {
      pools.exploration.push({
        definition,
        state,
        bucket: "exploration",
        weight: 1.25 - definition.difficulty * 0.5,
      });
      continue;
    }
    const dueAt = timestamp(state.dueAt);
    const isDue = dueAt !== undefined && dueAt <= nowMs;
    const isWeak =
      state.mastery < weakMasteryThreshold || state.recentAccuracy < weakRecentAccuracyThreshold;
    if (isDue || isWeak) {
      const overdueDays = isDue && dueAt !== undefined ? Math.min(14, (nowMs - dueAt) / DAY_MS) : 0;
      pools.weak_due.push({
        definition,
        state,
        bucket: "weak_due",
        weight: 1 + (1 - state.mastery) * 3 + overdueDays * 0.15,
      });
      continue;
    }
    const lastPracticedAt = timestamp(state.lastPracticedAt);
    if (lastPracticedAt !== undefined && lastPracticedAt >= recentCutoff) {
      pools.recent.push({
        definition,
        state,
        bucket: "recent",
        weight: 1 + (1 - state.mastery),
      });
      continue;
    }
    pools.maintenance.push({
      definition,
      state,
      bucket: "maintenance",
      weight: 0.5 + (1 - state.mastery),
    });
  }

  const plannedBuckets: Array<Exclude<SessionBucket, "maintenance">> = [];
  for (const bucket of ["weak_due", "recent", "exploration"] as const) {
    for (let count = 0; count < allocations[bucket]; count += 1) plannedBuckets.push(bucket);
  }
  shuffle(plannedBuckets, rng);
  const selectionCounts: Record<string, number> = {};
  const variationPools = resolveVariationPools(options.variationPools);
  const session: ScheduledPractice[] = [];
  for (const plannedBucket of plannedBuckets) {
    const sourceBucket = fallbackOrder[plannedBucket].find((bucket) => pools[bucket].length > 0);
    if (!sourceBucket) break;
    const selected = weightedChoice(pools[sourceBucket], selectionCounts, rng);
    selectionCounts[selected.definition.skillId] = (selectionCounts[selected.definition.skillId] ?? 0) + 1;
    session.push({
      skillId: selected.definition.skillId,
      definition: selected.definition,
      bucket: selected.bucket,
      plannedBucket,
      variation: makeVariation(variationPools, rng),
    });
  }
  return session;
}

export const scheduleSession = generateAdaptiveSession;

export const generateDefaultAdaptiveSession = (
  states: Readonly<Record<string, SkillState | undefined>>,
  options: AdaptiveSessionOptions,
): ScheduledPractice[] => generateAdaptiveSession(SKILL_CATALOG, states, options);
