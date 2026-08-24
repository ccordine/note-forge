import type { PitchObservation } from "../../audio/note-input";
import {
  createChallengeSession,
  createChallengeSteps,
  finishChallengeSession,
  generatePitchPattern,
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
  readonly minimumConfidence?: number;
}

interface PatternSampleClock {
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly sampleRate: number;
  readonly lastEndSample: number;
}

export interface PatternChallengeControllerState {
  readonly options: PatternChallengeControllerOptions;
  readonly phase: PatternChallengePhase;
  readonly mode: VoiceChallengeMode;
  readonly round: number;
  readonly runSerial: number;
  readonly pattern: readonly PitchPatternStep[];
  readonly session: ChallengeSessionState | null;
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

const DEFAULT_MINIMUM_CONFIDENCE = 0.55;
const EPSILON = 1e-9;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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

function reliableVoicedObservation(
  observation: Readonly<PitchObservation>,
  minimumConfidence: number,
): observation is Readonly<PitchObservation> & { midiFloat: number } {
  return observation.observationKind === "voiced"
    && observation.detector === "yin"
    && observation.reason === "detected"
    && observation.voiced
    && observation.midiFloat !== null
    && Number.isFinite(observation.midiFloat)
    && observation.confidence >= minimumConfidence;
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

  if (!reliableVoicedObservation(observation, session.minimumConfidence)) {
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
    result: null,
    liveMidi: null,
    elapsedSeconds: 0,
    clock: null,
  };
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
    session: createChallengeSession(steps, {
      minimumConfidence: state.options.minimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE,
    }),
    result: null,
    elapsedSeconds: 0,
    clock: null,
  };
}

function completePatternChallenge(
  state: Readonly<PatternChallengeControllerState>,
  session: Readonly<ChallengeSessionState>,
): PatternChallengeControllerState {
  const completed = session.status === "complete"
    ? session as ChallengeSessionState
    : finishChallengeSession(session);
  return {
    ...state,
    phase: "result",
    session: completed,
    result: summarizeChallenge(completed),
    clock: null,
  };
}

function observationStartsNewSegment(
  clock: Readonly<PatternSampleClock> | null,
  observation: Readonly<PitchObservation>,
): boolean {
  if (!clock || observation.discontinuity) return true;
  if (
    observation.captureEpoch !== clock.captureEpoch
    || observation.continuityEpoch !== clock.continuityEpoch
    || observation.graphGeneration !== clock.graphGeneration
    || observation.sampleRate !== clock.sampleRate
  ) return true;
  const expectedHopSamples = Math.max(1, Math.round(observation.sampleRate * 0.02));
  return observation.endSample - clock.lastEndSample > expectedHopSamples * 1.5;
}

function advancePatternChallenge(
  state: Readonly<PatternChallengeControllerState>,
  observation: Readonly<PitchObservation>,
): PatternChallengeControllerState {
  if (state.phase !== "playing" || !state.session) {
    return state as PatternChallengeControllerState;
  }
  if (
    state.clock
    && observation.captureEpoch === state.clock.captureEpoch
    && observation.continuityEpoch === state.clock.continuityEpoch
    && observation.graphGeneration === state.clock.graphGeneration
    && observation.sampleRate === state.clock.sampleRate
    && observation.endSample <= state.clock.lastEndSample
  ) return state as PatternChallengeControllerState;

  const startsNewSegment = observationStartsNewSegment(state.clock, observation);
  const liveMidi = observation.observationKind === "voiced"
    && observation.voiced
    && observation.midiFloat !== null
    && Number.isFinite(observation.midiFloat)
    ? observation.midiFloat
    : null;
  const elapsedSeconds = startsNewSegment || !state.clock
    ? state.elapsedSeconds
    : state.elapsedSeconds
      + (observation.endSample - state.clock.lastEndSample) / observation.sampleRate;
  const clock: PatternSampleClock = {
    captureEpoch: observation.captureEpoch,
    continuityEpoch: observation.continuityEpoch,
    graphGeneration: observation.graphGeneration,
    sampleRate: observation.sampleRate,
    lastEndSample: observation.endSample,
  };
  const session = scorePatternObservation(
    state.session,
    observation,
    elapsedSeconds,
    !startsNewSegment,
  );
  const next = { ...state, session, liveMidi, elapsedSeconds, clock };
  return session.status === "complete"
    ? completePatternChallenge(next, session)
    : next;
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
        ? { ...state, phase: "playing", runSerial: state.runSerial + 1, liveMidi: null, elapsedSeconds: 0, clock: null }
        : state as PatternChallengeControllerState;
    case "observation":
      return advancePatternChallenge(state, action.observation);
    case "stop":
      return state.phase === "playing" && state.session
        ? completePatternChallenge(state, state.session)
        : state as PatternChallengeControllerState;
    case "change-loadout":
      return { ...state, phase: "setup", pattern: [], session: null, result: null, liveMidi: null, elapsedSeconds: 0, clock: null };
    case "next-round":
      return { ...state, phase: "setup", round: state.round + 1, pattern: [], session: null, result: null, liveMidi: null, elapsedSeconds: 0, clock: null };
  }
}
