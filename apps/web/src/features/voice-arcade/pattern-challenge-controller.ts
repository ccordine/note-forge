import type { PitchObservation } from "../../audio/note-input";
import { clamp } from "@/lib/numeric";
import { isAuthoritativeVoicedPitch } from "@/realtime/authoritative-voiced-pitch";
import {
  observationContinuity,
  type ObservationSampleAuthority,
} from "@/realtime/observation-continuity";
import {
  createChallengeSession,
  createChallengeSteps,
  finishChallengeSession,
  generatePitchPattern,
  gradeChallengeScore,
  summarizeChallenge,
  type ChallengeScoreSummary,
  type ChallengeSessionState,
  type ChallengeStepProgress,
  type PitchPatternStep,
  type SeedValue,
  type VoiceArcadeDifficulty,
  type VoiceChallengeMode,
} from "./model";

export type PatternChallengePhase = "setup" | "preview" | "playing" | "result";

export interface PatternChallengeControllerOptions {
  readonly difficulty: VoiceArcadeDifficulty;
  readonly lowMidi: number;
  readonly highMidi: number;
  readonly baselineMidi: number;
}

interface PatternSampleClock {
  readonly authority: Readonly<ObservationSampleAuthority>;
  readonly observationKind: PitchObservation["observationKind"];
}

export interface PatternChallengeScoreAggregate {
  readonly score: number;
  readonly maximumScore: number;
  readonly hitSteps: number;
  readonly missedSteps: number;
  readonly totalSteps: number;
  readonly evaluatedFrames: number;
  readonly pitchQualityTotal: number;
  readonly maxCombo: number;
}

export interface PatternChallengeControllerState {
  readonly options: PatternChallengeControllerOptions;
  readonly phase: PatternChallengePhase;
  readonly mode: VoiceChallengeMode;
  readonly round: number;
  readonly runSerial: number;
  readonly pattern: readonly PitchPatternStep[];
  readonly session: ChallengeSessionState | null;
  readonly scoreAggregate: PatternChallengeScoreAggregate;
  readonly achievementCount: number;
  readonly achievementResult: ChallengeScoreSummary | null;
  readonly result: ChallengeScoreSummary | null;
  /** Latest authoritative voiced coordinate for the bounded game presentation. */
  readonly liveMidi: number | null;
  readonly elapsedSeconds: number;
  readonly clock: PatternSampleClock | null;
}

export type PatternChallengeAction =
  | { readonly type: "select-mode"; readonly mode: VoiceChallengeMode }
  | { readonly type: "prepare"; readonly seed: SeedValue }
  | { readonly type: "begin" }
  | { readonly type: "observation"; readonly observation: Readonly<PitchObservation> }
  | { readonly type: "stop" }
  | { readonly type: "change-loadout" }
  | { readonly type: "next-round" };

const EPSILON = 1e-9;
const EMPTY_SCORE_AGGREGATE: PatternChallengeScoreAggregate = Object.freeze({
  score: 0,
  maximumScore: 0,
  hitSteps: 0,
  missedSteps: 0,
  totalSteps: 0,
  evaluatedFrames: 0,
  pitchQualityTotal: 0,
  maxCombo: 0,
});

function markStepMissed(step: Readonly<ChallengeStepProgress>): ChallengeStepProgress {
  return {
    ...step,
    status: "miss",
    heldSeconds: 0,
    progress: 0,
    firstMatchedAtSeconds: null,
  };
}

function reliableVoicedObservation(
  observation: Readonly<PitchObservation>,
): observation is Readonly<PitchObservation> & { midiFloat: number } {
  return isAuthoritativeVoicedPitch(observation);
}

/**
 * Score one authoritative observation at a sample-derived game coordinate.
 * Silence and uncertain evidence advance the note rail but preserve earned
 * dwell. Only a credible voiced pitch outside the lane resets that dwell.
 */
export function scorePatternObservation(
  session: Readonly<ChallengeSessionState>,
  observation: Readonly<PitchObservation>,
  elapsedSeconds: number,
  continuousEvidence: boolean,
): ChallengeSessionState {
  if (session.status === "complete") return session as ChallengeSessionState;

  const steps = session.steps.map((step) => ({ ...step }));
  let activeStepIndex = session.activeStepIndex;
  let combo = session.combo;
  let missedSteps = session.missedSteps;

  while (
    activeStepIndex < steps.length
    && elapsedSeconds > steps[activeStepIndex]!.windowEndSeconds + EPSILON
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
      ...session,
      status: "complete",
      steps,
      activeStepIndex,
      combo,
      missedSteps,
      lastFrameTimeSeconds: elapsedSeconds,
      lastFrameMatched: false,
    };
  }

  const step = steps[activeStepIndex]!;
  if (elapsedSeconds < step.windowStartSeconds - EPSILON) {
    return {
      ...session,
      status: "running",
      steps,
      activeStepIndex,
      combo,
      missedSteps,
      lastFrameTimeSeconds: elapsedSeconds,
      lastFrameMatched: false,
    };
  }

  if (!reliableVoicedObservation(observation)) {
    return {
      ...session,
      status: "running",
      steps,
      activeStepIndex,
      combo,
      missedSteps,
      lastFrameTimeSeconds: elapsedSeconds,
      lastFrameMatched: false,
    };
  }

  const absoluteCentsError = Math.abs((observation.midiFloat - step.targetMidi) * 100);
  const matched = absoluteCentsError <= step.toleranceCents + EPSILON;
  const quality = clamp(1 - absoluteCentsError / step.toleranceCents, 0, 1);
  const nextEvaluatedFrames = session.evaluatedFrames + 1;
  const nextMatchedFrames = session.matchedFrames + (matched ? 1 : 0);
  const nextPitchQualityTotal = session.pitchQualityTotal + quality;
  const evaluatedStep: ChallengeStepProgress = {
    ...step,
    status: "active",
    evaluatedFrames: step.evaluatedFrames + 1,
    matchedFrames: step.matchedFrames + (matched ? 1 : 0),
    pitchQualityTotal: step.pitchQualityTotal + quality,
    bestAbsoluteCentsError: Math.min(step.bestAbsoluteCentsError ?? Infinity, absoluteCentsError),
  };

  if (!matched) {
    steps[activeStepIndex] = {
      ...evaluatedStep,
      heldSeconds: 0,
      progress: 0,
      firstMatchedAtSeconds: null,
    };
    return {
      ...session,
      status: "running",
      steps,
      activeStepIndex,
      combo,
      missedSteps,
      evaluatedFrames: nextEvaluatedFrames,
      matchedFrames: nextMatchedFrames,
      pitchQualityTotal: nextPitchQualityTotal,
      accuracyPercent: nextPitchQualityTotal / nextEvaluatedFrames * 100,
      lastFrameTimeSeconds: elapsedSeconds,
      lastFrameMatched: false,
    };
  }

  const previousTime = session.lastFrameTimeSeconds;
  const mayAccumulate = continuousEvidence
    && session.lastFrameMatched
    && previousTime !== null
    && elapsedSeconds > previousTime;
  const heldSeconds = Math.min(
    step.requiredSustainSeconds,
    step.heldSeconds + (mayAccumulate ? elapsedSeconds - previousTime : 0),
  );
  const firstMatchedAtSeconds = step.firstMatchedAtSeconds ?? elapsedSeconds;
  const matchedStep: ChallengeStepProgress = {
    ...evaluatedStep,
    heldSeconds,
    progress: clamp(heldSeconds / step.requiredSustainSeconds, 0, 1),
    firstMatchedAtSeconds,
  };

  let score = session.score;
  let hitSteps = session.hitSteps;
  let maxCombo = session.maxCombo;
  let lastFrameMatched = true;

  if (heldSeconds + EPSILON >= step.requiredSustainSeconds) {
    combo += 1;
    maxCombo = Math.max(maxCombo, combo);
    hitSteps += 1;
    const pitchQuality = matchedStep.pitchQualityTotal / matchedStep.evaluatedFrames;
    const idealStart = step.mode === "ddr" ? step.cueAtSeconds : step.windowStartSeconds;
    const timingRange = Math.max(step.windowEndSeconds - step.windowStartSeconds, EPSILON);
    const timingQuality = clamp(
      1 - Math.abs(firstMatchedAtSeconds - idealStart) / timingRange,
      0,
      1,
    );
    const comboBonus = Math.min(combo - 1, 10) * 0.01;
    const awardedPoints = Math.min(
      step.maximumPoints,
      Math.round(step.maximumPoints * clamp(
        pitchQuality * 0.75 + timingQuality * 0.25 + comboBonus,
        0,
        1,
      )),
    );
    steps[activeStepIndex] = {
      ...matchedStep,
      status: "hit",
      heldSeconds: step.requiredSustainSeconds,
      progress: 1,
      hitAtSeconds: elapsedSeconds,
      awardedPoints,
    };
    score += awardedPoints;
    activeStepIndex += 1;
    lastFrameMatched = false;
  } else {
    steps[activeStepIndex] = matchedStep;
  }

  return {
    ...session,
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
    lastFrameTimeSeconds: elapsedSeconds,
    lastFrameMatched,
  };
}

export function createPatternChallengeController(
  options: Readonly<PatternChallengeControllerOptions>,
): PatternChallengeControllerState {
  return {
    options: { ...options },
    phase: "setup",
    mode: "simon",
    round: 1,
    runSerial: 0,
    pattern: [],
    session: null,
    scoreAggregate: EMPTY_SCORE_AGGREGATE,
    achievementCount: 0,
    achievementResult: null,
    result: null,
    liveMidi: null,
    elapsedSeconds: 0,
    clock: null,
  };
}

function foldPhraseScore(
  aggregate: Readonly<PatternChallengeScoreAggregate>,
  session: Readonly<ChallengeSessionState>,
): PatternChallengeScoreAggregate {
  return Object.freeze({
    score: aggregate.score + session.score,
    maximumScore: aggregate.maximumScore
      + session.steps.reduce((total, step) => total + step.maximumPoints, 0),
    hitSteps: aggregate.hitSteps + session.hitSteps,
    missedSteps: aggregate.missedSteps + session.missedSteps,
    totalSteps: aggregate.totalSteps + session.steps.length,
    evaluatedFrames: aggregate.evaluatedFrames + session.evaluatedFrames,
    pitchQualityTotal: aggregate.pitchQualityTotal + session.pitchQualityTotal,
    maxCombo: Math.max(aggregate.maxCombo, session.maxCombo),
  });
}

function summarizePatternScore(
  aggregate: Readonly<PatternChallengeScoreAggregate>,
): ChallengeScoreSummary {
  const totalSteps = Math.max(1, aggregate.totalSteps);
  const completionPercent = aggregate.hitSteps / totalSteps * 100;
  const accuracyPercent = aggregate.evaluatedFrames === 0
    ? 0
    : aggregate.pitchQualityTotal / aggregate.evaluatedFrames * 100;
  const comboPercent = aggregate.maxCombo / totalSteps * 100;
  const scorePercent = Math.round(clamp(
    completionPercent * .65 + accuracyPercent * .25 + comboPercent * .1,
    0,
    100,
  ));
  return Object.freeze({
    ...gradeChallengeScore(scorePercent),
    score: aggregate.score,
    maximumScore: aggregate.maximumScore,
    scorePercent,
    accuracyPercent,
    completionPercent,
    hitSteps: aggregate.hitSteps,
    missedSteps: aggregate.missedSteps,
    maxCombo: aggregate.maxCombo,
    totalSteps: aggregate.totalSteps,
  });
}

function nextPhraseSession(
  state: Readonly<PatternChallengeControllerState>,
  elapsedSeconds: number,
): ChallengeSessionState {
  return createChallengeSession(createChallengeSteps(state.pattern, {
    mode: state.mode,
    difficulty: state.options.difficulty,
    startAtSeconds: elapsedSeconds + .001,
  }));
}

function preparePatternChallenge(
  state: Readonly<PatternChallengeControllerState>,
  seed: SeedValue,
): PatternChallengeControllerState {
  if (state.phase !== "setup") return state as PatternChallengeControllerState;
  const pattern = generatePitchPattern({
    seed,
    baselineMidi: state.options.baselineMidi,
    lowMidi: state.options.lowMidi,
    highMidi: state.options.highMidi,
    difficulty: state.options.difficulty,
  });
  const steps = createChallengeSteps(pattern, {
    mode: state.mode,
    difficulty: state.options.difficulty,
    startAtSeconds: 0,
  });
  return {
    ...state,
    phase: "preview",
    pattern,
    session: createChallengeSession(steps),
    scoreAggregate: EMPTY_SCORE_AGGREGATE,
    achievementCount: 0,
    achievementResult: null,
    result: null,
    elapsedSeconds: 0,
    clock: null,
  };
}

function finishPatternChallenge(
  state: Readonly<PatternChallengeControllerState>,
  session: Readonly<ChallengeSessionState>,
): PatternChallengeControllerState {
  const completed = session.status === "complete"
    ? session as ChallengeSessionState
    : finishChallengeSession(session);
  const scoreAggregate = foldPhraseScore(state.scoreAggregate, completed);
  return {
    ...state,
    phase: "result",
    session: completed,
    scoreAggregate,
    result: summarizePatternScore(scoreAggregate),
    clock: null,
  };
}

function advancePatternChallenge(
  state: Readonly<PatternChallengeControllerState>,
  observation: Readonly<PitchObservation>,
): PatternChallengeControllerState {
  if (state.phase !== "playing" || !state.session) {
    return state as PatternChallengeControllerState;
  }
  const continuity = observationContinuity(state.clock?.authority ?? null, observation);
  if (!continuity.accepted || continuity.authority === null) {
    return state as PatternChallengeControllerState;
  }
  const liveMidi = reliableVoicedObservation(observation)
    ? observation.midiFloat
    : null;
  const elapsedSeconds = state.elapsedSeconds + continuity.deltaSeconds;
  const clock: PatternSampleClock = {
    authority: continuity.authority,
    observationKind: observation.observationKind,
  };
  const session = scorePatternObservation(
    state.session,
    observation,
    elapsedSeconds,
    continuity.contiguous,
  );
  if (session.status !== "complete") {
    return { ...state, session, liveMidi, elapsedSeconds, clock };
  }
  // A phrase is a repeatable milestone inside one user-owned run. Fold its
  // exact score into bounded aggregate authority, latch its result, and put
  // the next authored phrase on the same sample clock. Only Stop is terminal.
  return {
    ...state,
    session: nextPhraseSession(state, elapsedSeconds),
    scoreAggregate: foldPhraseScore(state.scoreAggregate, session),
    achievementCount: state.achievementCount + 1,
    achievementResult: summarizeChallenge(session),
    liveMidi,
    elapsedSeconds,
    clock,
  };
}

export function reducePatternChallenge(
  state: Readonly<PatternChallengeControllerState>,
  action: Readonly<PatternChallengeAction>,
): PatternChallengeControllerState {
  switch (action.type) {
    case "select-mode":
      return state.phase === "setup" ? { ...state, mode: action.mode } : state as PatternChallengeControllerState;
    case "prepare":
      return preparePatternChallenge(state, action.seed);
    case "begin":
      return state.phase === "preview" && state.session
        ? {
            ...state,
            phase: "playing",
            runSerial: state.runSerial + 1,
            scoreAggregate: EMPTY_SCORE_AGGREGATE,
            achievementCount: 0,
            achievementResult: null,
            result: null,
            liveMidi: null,
            elapsedSeconds: 0,
            clock: null,
          }
        : state as PatternChallengeControllerState;
    case "observation":
      return advancePatternChallenge(state, action.observation);
    case "stop":
      return state.phase === "playing" && state.session
        ? finishPatternChallenge(state, state.session)
        : state as PatternChallengeControllerState;
    case "change-loadout":
      return state.phase === "preview" || state.phase === "result"
        ? {
            ...state,
            phase: "setup",
            pattern: [],
            session: null,
            scoreAggregate: EMPTY_SCORE_AGGREGATE,
            achievementCount: 0,
            achievementResult: null,
            result: null,
            liveMidi: null,
            elapsedSeconds: 0,
            clock: null,
          }
        : state as PatternChallengeControllerState;
    case "next-round":
      return state.phase === "result"
        ? {
            ...state,
            phase: "setup",
            round: state.round + 1,
            pattern: [],
            session: null,
            scoreAggregate: EMPTY_SCORE_AGGREGATE,
            achievementCount: 0,
            achievementResult: null,
            result: null,
            liveMidi: null,
            elapsedSeconds: 0,
            clock: null,
          }
        : state as PatternChallengeControllerState;
  }
}
