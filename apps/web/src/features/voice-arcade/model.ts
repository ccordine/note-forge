import { clamp } from "@/lib/numeric";

export type VoiceArcadeDifficulty = "easy" | "medium" | "hard";
export type VoiceChallengeMode = "simon" | "ddr";
export type SeedValue = number | string;
export type RandomSource = () => number;

export interface DifficultyPreset {
  id: VoiceArcadeDifficulty;
  label: string;
  toleranceCents: number;
  sustainDurationSeconds: number;
  tempoBpm: number;
  speedMultiplier: number;
  timingWindowSeconds: number;
  patternLength: number;
  beatsPerStep: number;
  scoreMultiplier: number;
}

/**
 * Shared tuning for every voice-controlled challenge. Increasing difficulty
 * narrows the pitch lane, lengthens the required hold, and moves cues faster.
 */
export const DIFFICULTY_PRESETS = Object.freeze({
  easy: Object.freeze({
    id: "easy",
    label: "Easy",
    toleranceCents: 45,
    sustainDurationSeconds: 0.45,
    tempoBpm: 72,
    speedMultiplier: 0.72,
    timingWindowSeconds: 0.5,
    patternLength: 6,
    beatsPerStep: 2,
    scoreMultiplier: 1,
  }),
  medium: Object.freeze({
    id: "medium",
    label: "Medium",
    toleranceCents: 30,
    sustainDurationSeconds: 0.65,
    tempoBpm: 96,
    speedMultiplier: 1,
    timingWindowSeconds: 0.34,
    patternLength: 8,
    beatsPerStep: 2,
    scoreMultiplier: 1.2,
  }),
  hard: Object.freeze({
    id: "hard",
    label: "Hard",
    toleranceCents: 18,
    sustainDurationSeconds: 0.8,
    tempoBpm: 124,
    speedMultiplier: 1.35,
    timingWindowSeconds: 0.22,
    patternLength: 12,
    beatsPerStep: 2.5,
    scoreMultiplier: 1.5,
  }),
} as const satisfies Readonly<Record<VoiceArcadeDifficulty, DifficultyPreset>>);

const MIDI_MIN = 0;
const MIDI_MAX = 127;
const EPSILON = 1e-9;

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function requireNonNegative(value: number, label: string): void {
  requireFinite(value, label);
  if (value < 0) throw new RangeError(`${label} cannot be negative.`);
}

function requirePositive(value: number, label: string): void {
  requireFinite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero.`);
}

function requireMidi(value: number, label: string): void {
  if (!Number.isInteger(value) || value < MIDI_MIN || value > MIDI_MAX) {
    throw new RangeError(`${label} must be an integer MIDI note from ${MIDI_MIN} through ${MIDI_MAX}.`);
  }
}

export function getDifficultyPreset(difficulty: VoiceArcadeDifficulty): DifficultyPreset {
  switch (difficulty) {
    case "easy": return DIFFICULTY_PRESETS.easy;
    case "medium": return DIFFICULTY_PRESETS.medium;
    case "hard": return DIFFICULTY_PRESETS.hard;
    default: throw new RangeError(`Unknown Voice Arcade difficulty: ${String(difficulty)}`);
  }
}

export function normalizedSeed(seed: SeedValue): number {
  if (typeof seed === "number") {
    requireFinite(seed, "Seed");
  } else if (typeof seed !== "string") {
    throw new TypeError("Seed must be a finite number or a string.");
  }

  const text = `${typeof seed}:${String(seed)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A repeatable Mulberry32 source suitable for procedural challenge content. */
export function createSeededRandom(seed: SeedValue): RandomSource {
  let state = normalizedSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface PitchPatternStep {
  index: number;
  targetMidi: number;
  offsetFromBaseline: number;
  cueBeat: number;
  durationBeats: number;
}

export interface GeneratePitchPatternOptions {
  seed: SeedValue;
  baselineMidi: number;
  lowMidi: number;
  highMidi: number;
  difficulty?: VoiceArcadeDifficulty;
  length?: number;
}

const PATTERN_INTERVALS: Readonly<Record<VoiceArcadeDifficulty, readonly number[]>> = {
  easy: [-2, -1, 1, 2],
  medium: [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5],
  hard: [-12, -9, -7, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 7, 9, 12],
};

/**
 * Build a deterministic bounded random walk. The first cue is always the
 * user's baseline, so every generated drill begins from a familiar pitch.
 */
export function generatePitchPattern(
  options: Readonly<GeneratePitchPatternOptions>,
): PitchPatternStep[] {
  requireMidi(options.baselineMidi, "Baseline");
  requireMidi(options.lowMidi, "Low range edge");
  requireMidi(options.highMidi, "High range edge");
  if (options.lowMidi > options.highMidi) {
    throw new RangeError("Low range edge cannot be above the high range edge.");
  }
  if (options.baselineMidi < options.lowMidi || options.baselineMidi > options.highMidi) {
    throw new RangeError("Baseline must be inside the requested range.");
  }

  const difficulty = options.difficulty ?? "medium";
  const preset = getDifficultyPreset(difficulty);
  const length = options.length ?? preset.patternLength;
  if (!Number.isInteger(length) || length < 1 || length > 128) {
    throw new RangeError("Pattern length must be an integer from 1 through 128.");
  }

  const rng = createSeededRandom(options.seed);
  const secondsPerBeat = 60 / preset.tempoBpm;
  const durationBeats = preset.sustainDurationSeconds / secondsPerBeat;
  const targets = [options.baselineMidi];
  const intervals = PATTERN_INTERVALS[difficulty];

  while (targets.length < length) {
    const previous = targets.at(-1)!;
    const candidates = intervals
      .map((interval) => previous + interval)
      .filter((midi) => midi >= options.lowMidi && midi <= options.highMidi);
    const available = candidates.length > 0 ? candidates : [previous];
    targets.push(available[Math.floor(rng() * available.length)]!);
  }

  return targets.map((targetMidi, index) => ({
    index,
    targetMidi,
    offsetFromBaseline: targetMidi - options.baselineMidi,
    cueBeat: index * preset.beatsPerStep,
    durationBeats,
  }));
}

export interface ChallengeStep {
  id: string;
  index: number;
  mode: VoiceChallengeMode;
  targetMidi: number;
  cueAtSeconds: number;
  windowStartSeconds: number;
  windowEndSeconds: number;
  requiredSustainSeconds: number;
  toleranceCents: number;
  maximumPoints: number;
}

export interface CreateChallengeStepsOptions {
  mode: VoiceChallengeMode;
  difficulty?: VoiceArcadeDifficulty;
  startAtSeconds?: number;
}

function requireChallengeMode(mode: VoiceChallengeMode): void {
  if (mode !== "simon" && mode !== "ddr") {
    throw new RangeError(`Unknown voice challenge mode: ${String(mode)}`);
  }
}

/** Turn the same note pattern into either listen-then-repeat or rhythm cues. */
export function createChallengeSteps(
  pattern: readonly PitchPatternStep[],
  options: Readonly<CreateChallengeStepsOptions>,
): ChallengeStep[] {
  if (pattern.length === 0) throw new RangeError("A challenge needs at least one pattern step.");
  requireChallengeMode(options.mode);
  const preset = getDifficultyPreset(options.difficulty ?? "medium");
  const startAtSeconds = options.startAtSeconds ?? 0;
  requireNonNegative(startAtSeconds, "Challenge start time");
  const secondsPerBeat = 60 / preset.tempoBpm;
  let previousCueBeat = -1;
  let previousWindowEnd = -Infinity;

  return pattern.map((patternStep, index) => {
    requireMidi(patternStep.targetMidi, `Pattern target ${index + 1}`);
    requireNonNegative(patternStep.cueBeat, `Pattern cue beat ${index + 1}`);
    requirePositive(patternStep.durationBeats, `Pattern duration ${index + 1}`);
    if (patternStep.cueBeat <= previousCueBeat) {
      throw new RangeError("Pattern cue beats must be strictly increasing.");
    }
    previousCueBeat = patternStep.cueBeat;

    const modeTimeScale = options.mode === "simon" ? 1.5 : 1;
    let cueAtSeconds = startAtSeconds + patternStep.cueBeat * secondsPerBeat * modeTimeScale;
    let windowStartSeconds = options.mode === "simon"
      ? cueAtSeconds + secondsPerBeat * 0.75
      : Math.max(startAtSeconds, cueAtSeconds - preset.timingWindowSeconds);
    let windowEndSeconds = options.mode === "simon"
      ? windowStartSeconds + preset.sustainDurationSeconds + preset.timingWindowSeconds * 2
      : cueAtSeconds + preset.timingWindowSeconds + preset.sustainDurationSeconds;

    // Custom patterns can be more tightly packed than a preset. Shift a later
    // response window intact instead of allowing two targets to be active.
    if (windowStartSeconds < previousWindowEnd) {
      const shift = previousWindowEnd - windowStartSeconds + 0.001;
      cueAtSeconds += shift;
      windowStartSeconds += shift;
      windowEndSeconds += shift;
    }
    previousWindowEnd = windowEndSeconds;

    return {
      id: `${options.mode}-${index + 1}`,
      index,
      mode: options.mode,
      targetMidi: patternStep.targetMidi,
      cueAtSeconds,
      windowStartSeconds,
      windowEndSeconds,
      requiredSustainSeconds: preset.sustainDurationSeconds,
      toleranceCents: preset.toleranceCents,
      maximumPoints: Math.round(1_000 * preset.scoreMultiplier),
    };
  });
}

export type ChallengeStepStatus = "pending" | "active" | "hit" | "miss";
export type ChallengeSessionStatus = "ready" | "running" | "complete";

export interface ChallengeStepProgress extends ChallengeStep {
  status: ChallengeStepStatus;
  heldSeconds: number;
  progress: number;
  evaluatedFrames: number;
  matchedFrames: number;
  pitchQualityTotal: number;
  firstMatchedAtSeconds: number | null;
  hitAtSeconds: number | null;
  awardedPoints: number;
  bestAbsoluteCentsError: number | null;
}

export interface ChallengeSessionState {
  status: ChallengeSessionStatus;
  steps: ChallengeStepProgress[];
  activeStepIndex: number;
  score: number;
  combo: number;
  maxCombo: number;
  hitSteps: number;
  missedSteps: number;
  evaluatedFrames: number;
  matchedFrames: number;
  pitchQualityTotal: number;
  accuracyPercent: number;
  lastFrameTimeSeconds: number | null;
  lastFrameMatched: boolean;
}

function validateChallengeStep(step: Readonly<ChallengeStep>, index: number): void {
  requireMidi(step.targetMidi, `Challenge target ${index + 1}`);
  requireNonNegative(step.cueAtSeconds, `Challenge cue ${index + 1}`);
  requireNonNegative(step.windowStartSeconds, `Challenge window start ${index + 1}`);
  requirePositive(step.windowEndSeconds, `Challenge window end ${index + 1}`);
  if (step.windowEndSeconds <= step.windowStartSeconds) {
    throw new RangeError(`Challenge window ${index + 1} must end after it starts.`);
  }
  requirePositive(step.requiredSustainSeconds, `Challenge sustain ${index + 1}`);
  requirePositive(step.toleranceCents, `Challenge tolerance ${index + 1}`);
  if (!Number.isInteger(step.maximumPoints) || step.maximumPoints <= 0) {
    throw new RangeError(`Challenge maximum points ${index + 1} must be a positive integer.`);
  }
  requireChallengeMode(step.mode);
}

export function createChallengeSession(
  steps: readonly ChallengeStep[],
): ChallengeSessionState {
  if (steps.length === 0) throw new RangeError("A challenge session needs at least one step.");
  const ids = new Set<string>();
  let previousWindowEnd = -Infinity;
  const progress = steps.map((step, index): ChallengeStepProgress => {
    validateChallengeStep(step, index);
    if (ids.has(step.id)) throw new RangeError(`Duplicate challenge step id: ${step.id}`);
    ids.add(step.id);
    if (step.windowStartSeconds < previousWindowEnd - EPSILON) {
      throw new RangeError("Challenge response windows cannot overlap.");
    }
    previousWindowEnd = step.windowEndSeconds;
    return {
      ...step,
      status: "pending",
      heldSeconds: 0,
      progress: 0,
      evaluatedFrames: 0,
      matchedFrames: 0,
      pitchQualityTotal: 0,
      firstMatchedAtSeconds: null,
      hitAtSeconds: null,
      awardedPoints: 0,
      bestAbsoluteCentsError: null,
    };
  });

  return {
    status: "ready",
    steps: progress,
    activeStepIndex: 0,
    score: 0,
    combo: 0,
    maxCombo: 0,
    hitSteps: 0,
    missedSteps: 0,
    evaluatedFrames: 0,
    matchedFrames: 0,
    pitchQualityTotal: 0,
    accuracyPercent: 0,
    lastFrameTimeSeconds: null,
    lastFrameMatched: false,
  };
}

function markStepMissed(step: Readonly<ChallengeStepProgress>): ChallengeStepProgress {
  return {
    ...step,
    status: "miss",
    heldSeconds: 0,
    progress: 0,
    firstMatchedAtSeconds: null,
  };
}

/** End early and turn every unresolved cue into an explicit miss. */
export function finishChallengeSession(
  state: Readonly<ChallengeSessionState>,
): ChallengeSessionState {
  if (state.status === "complete") return state as ChallengeSessionState;
  let missedSteps = state.missedSteps;
  const steps = state.steps.map((step) => {
    if (step.status === "hit" || step.status === "miss") return { ...step };
    missedSteps += 1;
    return markStepMissed(step);
  });
  return {
    ...state,
    status: "complete",
    steps,
    activeStepIndex: steps.length,
    combo: 0,
    missedSteps,
    lastFrameMatched: false,
  };
}

export type ChallengeGrade = "A+" | "A" | "B" | "C" | "D";

export interface ChallengeScoreSummary {
  grade: ChallengeGrade;
  gradeLabel: string;
  score: number;
  maximumScore: number;
  scorePercent: number;
  accuracyPercent: number;
  completionPercent: number;
  hitSteps: number;
  missedSteps: number;
  maxCombo: number;
  totalSteps: number;
}

export function gradeChallengeScore(scorePercent: number): Pick<ChallengeScoreSummary, "grade" | "gradeLabel"> {
  requireFinite(scorePercent, "Challenge score percentage");
  if (scorePercent < 0 || scorePercent > 100) {
    throw new RangeError("Challenge score percentage must be from 0 through 100.");
  }
  if (scorePercent >= 95) return { grade: "A+", gradeLabel: "Pitch-perfect run" };
  if (scorePercent >= 88) return { grade: "A", gradeLabel: "Locked in" };
  if (scorePercent >= 78) return { grade: "B", gradeLabel: "Strong control" };
  if (scorePercent >= 65) return { grade: "C", gradeLabel: "Building control" };
  return { grade: "D", gradeLabel: "Keep the phrase in play" };
}

export function summarizeChallenge(
  state: Readonly<ChallengeSessionState>,
): ChallengeScoreSummary {
  const totalSteps = state.steps.length;
  const completionPercent = state.hitSteps / totalSteps * 100;
  const comboPercent = state.maxCombo / totalSteps * 100;
  const scorePercent = Math.round(clamp(
    completionPercent * 0.65 + state.accuracyPercent * 0.25 + comboPercent * 0.1,
    0,
    100,
  ));
  const grade = gradeChallengeScore(scorePercent);
  return {
    ...grade,
    score: state.score,
    maximumScore: state.steps.reduce((total, step) => total + step.maximumPoints, 0),
    scorePercent,
    accuracyPercent: state.accuracyPercent,
    completionPercent,
    hitSteps: state.hitSteps,
    missedSteps: state.missedSteps,
    maxCombo: state.maxCombo,
    totalSteps,
  };
}

export interface PitchVerticalControllerOptions {
  lowMidi: number;
  highMidi: number;
  centerMidi?: number;
  deadZoneCents?: number;
  invert?: boolean;
}

export interface PitchVerticalMapping {
  normalizedY: number;
  clampedMidi: number;
  inDeadZone: boolean;
}

/**
 * Map pitch to a screen-space Y coordinate: high notes are at 0 (top), low
 * notes at 1 (bottom). A center dead zone snaps small vocal drift to 0.5.
 */
export function mapPitchToNormalizedVertical(
  pitchMidi: number,
  options: Readonly<PitchVerticalControllerOptions>,
): PitchVerticalMapping {
  requireFinite(pitchMidi, "Controller pitch");
  requireFinite(options.lowMidi, "Controller low edge");
  requireFinite(options.highMidi, "Controller high edge");
  if (options.lowMidi >= options.highMidi) {
    throw new RangeError("Controller high edge must be above its low edge.");
  }
  const centerMidi = options.centerMidi ?? (options.lowMidi + options.highMidi) / 2;
  requireFinite(centerMidi, "Controller center");
  if (centerMidi <= options.lowMidi || centerMidi >= options.highMidi) {
    throw new RangeError("Controller center must be strictly inside its pitch range.");
  }
  const deadZoneCents = options.deadZoneCents ?? 0;
  requireNonNegative(deadZoneCents, "Controller dead zone");
  const deadZoneSemitones = deadZoneCents / 100;
  if (
    deadZoneSemitones >= centerMidi - options.lowMidi
    || deadZoneSemitones >= options.highMidi - centerMidi
  ) {
    throw new RangeError("Controller dead zone must leave usable pitch space on both sides.");
  }

  const clampedMidi = clamp(pitchMidi, options.lowMidi, options.highMidi);
  const lowerDeadEdge = centerMidi - deadZoneSemitones;
  const upperDeadEdge = centerMidi + deadZoneSemitones;
  const inDeadZone = clampedMidi >= lowerDeadEdge - EPSILON
    && clampedMidi <= upperDeadEdge + EPSILON;
  let pitchPosition: number;
  if (inDeadZone) {
    pitchPosition = 0.5;
  } else if (clampedMidi < lowerDeadEdge) {
    pitchPosition = 0.5 * (clampedMidi - options.lowMidi) / (lowerDeadEdge - options.lowMidi);
  } else {
    pitchPosition = 0.5 + 0.5 * (clampedMidi - upperDeadEdge) / (options.highMidi - upperDeadEdge);
  }
  return {
    normalizedY: options.invert === true ? pitchPosition : 1 - pitchPosition,
    clampedMidi,
    inDeadZone,
  };
}
