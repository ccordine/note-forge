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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function getDifficultyPreset(difficulty: VoiceArcadeDifficulty): DifficultyPreset {
  switch (difficulty) {
    case "easy": return DIFFICULTY_PRESETS.easy;
    case "medium": return DIFFICULTY_PRESETS.medium;
    case "hard": return DIFFICULTY_PRESETS.hard;
    default: throw new RangeError(`Unknown Voice Arcade difficulty: ${String(difficulty)}`);
  }
}

function normalizedSeed(seed: SeedValue): number {
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
  minimumConfidence: number;
  lastFrameTimeSeconds: number | null;
  lastFrameMatched: boolean;
}

export interface CreateChallengeSessionOptions {
  minimumConfidence?: number;
}

export interface ChallengePitchFrame {
  timeSeconds: number;
  midiFloat: number | null;
  confidence: number;
  voiced: boolean;
}

export const DEFAULT_CHALLENGE_MINIMUM_CONFIDENCE = 0.5;
export const MAX_TRACKABLE_FRAME_GAP_SECONDS = 0.25;

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
  options: Readonly<CreateChallengeSessionOptions> = {},
): ChallengeSessionState {
  if (steps.length === 0) throw new RangeError("A challenge session needs at least one step.");
  const minimumConfidence = options.minimumConfidence ?? DEFAULT_CHALLENGE_MINIMUM_CONFIDENCE;
  requireFinite(minimumConfidence, "Minimum pitch confidence");
  if (minimumConfidence < 0 || minimumConfidence > 1) {
    throw new RangeError("Minimum pitch confidence must be from 0 through 1.");
  }

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
    minimumConfidence,
    lastFrameTimeSeconds: null,
    lastFrameMatched: false,
  };
}

function validatePitchFrame(frame: Readonly<ChallengePitchFrame>): void {
  requireNonNegative(frame.timeSeconds, "Frame timestamp");
  requireFinite(frame.confidence, "Frame confidence");
  if (frame.confidence < 0 || frame.confidence > 1) {
    throw new RangeError("Frame confidence must be from 0 through 1.");
  }
  if (frame.midiFloat !== null) requireFinite(frame.midiFloat, "Detected MIDI pitch");
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

/**
 * Score one detector frame. The reducer is immutable and timestamp-driven;
 * duplicate or out-of-order frames are ignored, while detector gaps longer
 * than 250ms break a sustain run instead of inventing held time.
 */
export function scoreChallengeFrame(
  state: Readonly<ChallengeSessionState>,
  frame: Readonly<ChallengePitchFrame>,
): ChallengeSessionState {
  validatePitchFrame(frame);
  if (state.status === "complete") return state as ChallengeSessionState;
  if (state.lastFrameTimeSeconds !== null && frame.timeSeconds <= state.lastFrameTimeSeconds) {
    return state as ChallengeSessionState;
  }

  const steps = state.steps.map((step) => ({ ...step }));
  let activeStepIndex = state.activeStepIndex;
  let combo = state.combo;
  let missedSteps = state.missedSteps;

  while (
    activeStepIndex < steps.length
    && frame.timeSeconds > steps[activeStepIndex]!.windowEndSeconds + EPSILON
  ) {
    const expired = steps[activeStepIndex]!;
    if (expired.status !== "hit" && expired.status !== "miss") {
      steps[activeStepIndex] = markStepMissed(expired);
      missedSteps += 1;
      combo = 0;
    }
    activeStepIndex += 1;
  }

  if (activeStepIndex >= steps.length) {
    return {
      ...state,
      status: "complete",
      steps,
      activeStepIndex,
      combo,
      missedSteps,
      lastFrameTimeSeconds: frame.timeSeconds,
      lastFrameMatched: false,
    };
  }

  const step = steps[activeStepIndex]!;
  if (frame.timeSeconds < step.windowStartSeconds - EPSILON) {
    return {
      ...state,
      status: "running",
      steps,
      activeStepIndex,
      combo,
      missedSteps,
      lastFrameTimeSeconds: frame.timeSeconds,
      lastFrameMatched: false,
    };
  }

  const reliable = frame.voiced
    && frame.confidence >= state.minimumConfidence
    && frame.midiFloat !== null;
  const absoluteCentsError = reliable
    ? Math.abs((frame.midiFloat! - step.targetMidi) * 100)
    : null;
  const matched = absoluteCentsError !== null
    && absoluteCentsError <= step.toleranceCents + EPSILON;
  const quality = absoluteCentsError === null
    ? 0
    : clamp(1 - absoluteCentsError / step.toleranceCents, 0, 1);
  const frameDelta = state.lastFrameTimeSeconds === null
    ? 0
    : frame.timeSeconds - state.lastFrameTimeSeconds;
  const continuesRun = matched
    && state.lastFrameMatched
    && state.activeStepIndex === activeStepIndex
    && frameDelta <= MAX_TRACKABLE_FRAME_GAP_SECONDS + EPSILON;
  const heldSeconds = matched
    ? continuesRun ? step.heldSeconds + frameDelta : 0
    : 0;
  const firstMatchedAtSeconds = matched
    ? continuesRun ? step.firstMatchedAtSeconds : frame.timeSeconds
    : null;
  const nextEvaluatedFrames = state.evaluatedFrames + 1;
  const nextMatchedFrames = state.matchedFrames + (matched ? 1 : 0);
  const nextPitchQualityTotal = state.pitchQualityTotal + quality;
  const nextStep: ChallengeStepProgress = {
    ...step,
    status: "active",
    heldSeconds: Math.min(heldSeconds, step.requiredSustainSeconds),
    progress: clamp(heldSeconds / step.requiredSustainSeconds, 0, 1),
    evaluatedFrames: step.evaluatedFrames + 1,
    matchedFrames: step.matchedFrames + (matched ? 1 : 0),
    pitchQualityTotal: step.pitchQualityTotal + quality,
    firstMatchedAtSeconds,
    bestAbsoluteCentsError: absoluteCentsError === null
      ? step.bestAbsoluteCentsError
      : Math.min(step.bestAbsoluteCentsError ?? Infinity, absoluteCentsError),
  };

  let score = state.score;
  let hitSteps = state.hitSteps;
  let maxCombo = state.maxCombo;
  let lastFrameMatched = matched;

  if (matched && heldSeconds + EPSILON >= step.requiredSustainSeconds) {
    combo += 1;
    maxCombo = Math.max(maxCombo, combo);
    hitSteps += 1;
    const pitchQuality = nextStep.pitchQualityTotal / nextStep.evaluatedFrames;
    const idealStart = step.mode === "ddr" ? step.cueAtSeconds : step.windowStartSeconds;
    const timingRange = Math.max(step.windowEndSeconds - step.windowStartSeconds, EPSILON);
    const timingQuality = clamp(
      1 - Math.abs((firstMatchedAtSeconds ?? frame.timeSeconds) - idealStart) / timingRange,
      0,
      1,
    );
    const comboBonus = Math.min(combo - 1, 10) * 0.01;
    const awardedPoints = Math.min(
      step.maximumPoints,
      Math.round(step.maximumPoints * clamp(pitchQuality * 0.75 + timingQuality * 0.25 + comboBonus, 0, 1)),
    );
    steps[activeStepIndex] = {
      ...nextStep,
      status: "hit",
      heldSeconds: step.requiredSustainSeconds,
      progress: 1,
      hitAtSeconds: frame.timeSeconds,
      awardedPoints,
    };
    score += awardedPoints;
    activeStepIndex += 1;
    lastFrameMatched = false;
  } else {
    steps[activeStepIndex] = nextStep;
  }

  return {
    ...state,
    status: activeStepIndex >= steps.length ? "complete" : "running",
    steps,
    activeStepIndex,
    score,
    combo,
    maxCombo,
    hitSteps,
    missedSteps,
    evaluatedFrames: nextEvaluatedFrames,
    matchedFrames: nextMatchedFrames,
    pitchQualityTotal: nextPitchQualityTotal,
    accuracyPercent: nextPitchQualityTotal / nextEvaluatedFrames * 100,
    lastFrameTimeSeconds: frame.timeSeconds,
    lastFrameMatched,
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

export interface PongConfig {
  playerPaddleX: number;
  opponentPaddleX: number;
  paddleWidth: number;
  paddleHeight: number;
  ballRadius: number;
  ballSpeed: number;
  aiSpeed: number;
  maximumBounceAngleRadians: number;
  winningScore: number;
  simulationStepSeconds: number;
  maximumDeltaSeconds: number;
}

export const DEFAULT_PONG_CONFIG = Object.freeze({
  playerPaddleX: 0.06,
  opponentPaddleX: 0.94,
  paddleWidth: 0.025,
  paddleHeight: 0.22,
  ballRadius: 0.018,
  ballSpeed: 0.48,
  aiSpeed: 0.38,
  maximumBounceAngleRadians: Math.PI * 0.36,
  winningScore: 7,
  simulationStepSeconds: 1 / 240,
  maximumDeltaSeconds: 2,
} as const satisfies PongConfig);

export interface PongBallState {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

export type PongWinner = "player" | "opponent" | null;

export interface PongState {
  config: PongConfig;
  seed: number;
  status: "playing" | "finished";
  elapsedSeconds: number;
  playerPaddleY: number;
  opponentPaddleY: number;
  ball: PongBallState;
  playerScore: number;
  opponentScore: number;
  rally: number;
  serveIndex: number;
  winner: PongWinner;
}

export interface CreatePongOptions {
  seed?: SeedValue;
  serveToward?: "player" | "opponent";
  config?: Readonly<Partial<PongConfig>>;
}

export interface PongFrameInput {
  deltaSeconds: number;
  voicePaddleY: number;
}

function validatePongConfig(config: Readonly<PongConfig>): void {
  for (const [label, value] of [
    ["Player paddle X", config.playerPaddleX],
    ["Opponent paddle X", config.opponentPaddleX],
    ["Paddle width", config.paddleWidth],
    ["Paddle height", config.paddleHeight],
    ["Ball radius", config.ballRadius],
    ["Ball speed", config.ballSpeed],
    ["AI speed", config.aiSpeed],
    ["Maximum bounce angle", config.maximumBounceAngleRadians],
    ["Simulation step", config.simulationStepSeconds],
    ["Maximum delta", config.maximumDeltaSeconds],
  ] as const) requirePositive(value, label);
  if (config.playerPaddleX >= 0.5 || config.opponentPaddleX <= 0.5) {
    throw new RangeError("Pong paddles must remain on opposite sides of center court.");
  }
  if (config.paddleHeight >= 1 || config.paddleWidth >= 0.5 || config.ballRadius >= 0.25) {
    throw new RangeError("Pong dimensions must fit inside normalized court space.");
  }
  if (config.playerPaddleX - config.paddleWidth / 2 < 0
    || config.opponentPaddleX + config.paddleWidth / 2 > 1) {
    throw new RangeError("Pong paddles must fit inside the court.");
  }
  if (config.maximumBounceAngleRadians >= Math.PI / 2) {
    throw new RangeError("Pong maximum bounce angle must be less than PI / 2.");
  }
  if (!Number.isInteger(config.winningScore) || config.winningScore < 1) {
    throw new RangeError("Pong winning score must be a positive integer.");
  }
  if (config.simulationStepSeconds > config.maximumDeltaSeconds) {
    throw new RangeError("Pong simulation step cannot exceed the maximum frame delta.");
  }
}

function seededServe(
  seed: number,
  serveIndex: number,
  toward: "player" | "opponent",
  speed: number,
  maximumAngle: number,
): PongBallState {
  const rng = createSeededRandom(`${seed}:${serveIndex}`);
  const angle = (rng() * 0.7 - 0.35) * maximumAngle;
  const direction = toward === "player" ? -1 : 1;
  return {
    x: 0.5,
    y: 0.5,
    velocityX: direction * speed * Math.cos(angle),
    velocityY: speed * Math.sin(angle),
  };
}

export function createPongState(options: Readonly<CreatePongOptions> = {}): PongState {
  const config: PongConfig = { ...DEFAULT_PONG_CONFIG, ...options.config };
  validatePongConfig(config);
  const seed = normalizedSeed(options.seed ?? "voice-pong");
  const serveToward = options.serveToward
    ?? (createSeededRandom(seed)() < 0.5 ? "player" : "opponent");
  if (serveToward !== "player" && serveToward !== "opponent") {
    throw new RangeError(`Unknown Pong serve direction: ${String(serveToward)}`);
  }
  return {
    config,
    seed,
    status: "playing",
    elapsedSeconds: 0,
    playerPaddleY: 0.5,
    opponentPaddleY: 0.5,
    ball: seededServe(seed, 0, serveToward, config.ballSpeed, config.maximumBounceAngleRadians),
    playerScore: 0,
    opponentScore: 0,
    rally: 0,
    serveIndex: 0,
    winner: null,
  };
}

function clampPaddleY(value: number, config: Readonly<PongConfig>): number {
  return clamp(value, config.paddleHeight / 2, 1 - config.paddleHeight / 2);
}

function reflectBallFromHorizontalWalls(ball: PongBallState, radius: number): void {
  while (ball.y - radius < 0 || ball.y + radius > 1) {
    if (ball.y - radius < 0) {
      ball.y = radius + (radius - ball.y);
      ball.velocityY = Math.abs(ball.velocityY);
    }
    if (ball.y + radius > 1) {
      ball.y = 1 - radius - (ball.y + radius - 1);
      ball.velocityY = -Math.abs(ball.velocityY);
    }
  }
}

function bounceFromPaddle(
  ball: PongBallState,
  paddleY: number,
  direction: -1 | 1,
  rally: number,
  config: Readonly<PongConfig>,
): void {
  const relativeImpact = clamp((ball.y - paddleY) / (config.paddleHeight / 2), -1, 1);
  const angle = relativeImpact * config.maximumBounceAngleRadians;
  const speed = Math.min(config.ballSpeed * (1 + (rally + 1) * 0.025), config.ballSpeed * 1.6);
  ball.velocityX = direction * speed * Math.cos(angle);
  ball.velocityY = speed * Math.sin(angle);
}

function scorePongPoint(state: PongState, scorer: "player" | "opponent"): void {
  if (scorer === "player") state.playerScore += 1;
  else state.opponentScore += 1;
  state.rally = 0;
  state.serveIndex += 1;
  if (state.playerScore >= state.config.winningScore || state.opponentScore >= state.config.winningScore) {
    state.status = "finished";
    state.winner = state.playerScore >= state.config.winningScore ? "player" : "opponent";
    state.ball = { x: 0.5, y: 0.5, velocityX: 0, velocityY: 0 };
    return;
  }
  const serveToward = scorer === "player" ? "opponent" : "player";
  state.ball = seededServe(
    state.seed,
    state.serveIndex,
    serveToward,
    state.config.ballSpeed,
    state.config.maximumBounceAngleRadians,
  );
}

/** Advance normalized Pong physics using a voice-controlled player paddle. */
export function updatePongState(
  previous: Readonly<PongState>,
  input: Readonly<PongFrameInput>,
): PongState {
  requireNonNegative(input.deltaSeconds, "Pong frame delta");
  requireFinite(input.voicePaddleY, "Voice paddle position");
  validatePongConfig(previous.config);
  if (input.deltaSeconds > previous.config.maximumDeltaSeconds) {
    throw new RangeError("Pong frame delta exceeds the configured maximum.");
  }
  if (previous.status === "finished") return previous as PongState;

  const state: PongState = {
    ...previous,
    config: { ...previous.config },
    playerPaddleY: clampPaddleY(input.voicePaddleY, previous.config),
    ball: { ...previous.ball },
  };
  if (input.deltaSeconds === 0) return state;
  const stepCount = Math.ceil(input.deltaSeconds / state.config.simulationStepSeconds);
  const delta = input.deltaSeconds / stepCount;

  for (let stepIndex = 0; stepIndex < stepCount && state.status === "playing"; stepIndex += 1) {
    state.elapsedSeconds += delta;
    const aiDifference = state.ball.y - state.opponentPaddleY;
    const aiMovement = clamp(aiDifference, -state.config.aiSpeed * delta, state.config.aiSpeed * delta);
    state.opponentPaddleY = clampPaddleY(state.opponentPaddleY + aiMovement, state.config);

    const previousX = state.ball.x;
    state.ball.x += state.ball.velocityX * delta;
    state.ball.y += state.ball.velocityY * delta;
    reflectBallFromHorizontalWalls(state.ball, state.config.ballRadius);

    const playerSurface = state.config.playerPaddleX + state.config.paddleWidth / 2;
    const crossedPlayer = state.ball.velocityX < 0
      && previousX - state.config.ballRadius >= playerSurface - EPSILON
      && state.ball.x - state.config.ballRadius <= playerSurface + EPSILON;
    const insidePlayer = Math.abs(state.ball.y - state.playerPaddleY)
      <= state.config.paddleHeight / 2 + state.config.ballRadius;
    if (crossedPlayer && insidePlayer) {
      state.ball.x = playerSurface + state.config.ballRadius;
      bounceFromPaddle(state.ball, state.playerPaddleY, 1, state.rally, state.config);
      state.rally += 1;
    }

    const opponentSurface = state.config.opponentPaddleX - state.config.paddleWidth / 2;
    const crossedOpponent = state.ball.velocityX > 0
      && previousX + state.config.ballRadius <= opponentSurface + EPSILON
      && state.ball.x + state.config.ballRadius >= opponentSurface - EPSILON;
    const insideOpponent = Math.abs(state.ball.y - state.opponentPaddleY)
      <= state.config.paddleHeight / 2 + state.config.ballRadius;
    if (crossedOpponent && insideOpponent) {
      state.ball.x = opponentSurface - state.config.ballRadius;
      bounceFromPaddle(state.ball, state.opponentPaddleY, -1, state.rally, state.config);
      state.rally += 1;
    }

    if (state.ball.x + state.config.ballRadius < 0) {
      scorePongPoint(state, "opponent");
    } else if (state.ball.x - state.config.ballRadius > 1) {
      scorePongPoint(state, "player");
    }
  }

  return state;
}
