import {
  TONE_MAP_KEYBOARD_SKILLS,
  TONE_MAP_MIXED_SKILLS,
  TONE_MAP_VOICE_SKILLS,
  advanceToneMapLevel,
  chooseToneMapTask,
  recordToneMapTaskResult,
  setToneMapProductionEligibility,
  summarizeToneMapLevel,
  toneMapActiveMidis,
  type ToneMapCourseState,
  type ToneMapSeed,
  type ToneMapSkill,
  type ToneMapTask,
} from "./tone-map-model";
import { isToneMapProductionMidiSupported } from "./tone-map-production-range";

export type ToneMapResponseMode = "keyboard" | "voice" | "mixed";

export type ToneMapCommittedAnswer =
  | Readonly<{
      kind: "midi";
      midi: number;
      correct: boolean;
      attemptId: string;
      committedAt: string;
    }>
  | Readonly<{ kind: "production-unreachable" }>;

export interface ToneMapSessionState {
  readonly course: ToneMapCourseState;
  readonly responseMode: ToneMapResponseMode;
  readonly task: ToneMapTask | null;
  readonly answer: ToneMapCommittedAnswer | null;
  readonly trialOrdinal: number;
}

export type ToneMapSessionAction =
  | Readonly<{
      type: "answer-midi";
      midi: number;
      trialOrdinal: number;
      attemptId: string;
      committedAt: string;
    }>
  | Readonly<{ type: "production-unreachable"; trialOrdinal: number }>
  | Readonly<{ type: "next"; seed: ToneMapSeed }>
  | Readonly<{ type: "change-response-mode"; responseMode: ToneMapResponseMode; seed: ToneMapSeed }>
  | Readonly<{ type: "advance-level"; seed: ToneMapSeed }>
  | Readonly<{ type: "retry-excluded-production"; seed: ToneMapSeed }>
  | Readonly<{
      type: "replace-course";
      course: ToneMapCourseState;
      responseMode?: ToneMapResponseMode;
      seed: ToneMapSeed;
    }>;

export const TONE_MAP_RESPONSE_OPTIONS = Object.freeze([
  { value: "keyboard", label: "Find on keyboard" },
  { value: "voice", label: "Sing it" },
  { value: "mixed", label: "Mixed recall" },
] satisfies readonly Readonly<{ value: ToneMapResponseMode; label: string }>[]);

export function toneMapRequiredSkills(
  responseMode: ToneMapResponseMode,
): readonly ToneMapSkill[] {
  if (responseMode === "keyboard") return TONE_MAP_KEYBOARD_SKILLS;
  if (responseMode === "voice") return TONE_MAP_VOICE_SKILLS;
  if (responseMode === "mixed") return TONE_MAP_MIXED_SKILLS;
  throw new RangeError(`Unknown tone-map response mode: ${String(responseMode)}.`);
}

function taskFor(
  course: ToneMapCourseState,
  responseMode: ToneMapResponseMode,
  seed: ToneMapSeed,
  previousTask: ToneMapTask | null = null,
): ToneMapTask | null {
  return chooseToneMapTask(course, {
    requiredSkills: toneMapRequiredSkills(responseMode),
    seed,
    previousTask,
    productionChallengeKind: "voice-imitation",
  });
}

export function createToneMapSession(
  course: ToneMapCourseState,
  responseMode: ToneMapResponseMode,
  seed: ToneMapSeed,
): ToneMapSessionState {
  return {
    course,
    responseMode,
    task: taskFor(course, responseMode, seed),
    answer: null,
    trialOrdinal: 1,
  };
}

function replaceTask(
  state: ToneMapSessionState,
  course: ToneMapCourseState,
  responseMode: ToneMapResponseMode,
  seed: ToneMapSeed,
): ToneMapSessionState {
  return {
    course,
    responseMode,
    task: taskFor(course, responseMode, seed, state.task),
    answer: null,
    trialOrdinal: state.trialOrdinal + 1,
  };
}

function commitMidi(
  state: ToneMapSessionState,
  action: Extract<ToneMapSessionAction, { type: "answer-midi" }>,
): ToneMapSessionState {
  if (
    state.task === null
    || state.answer !== null
    || action.trialOrdinal !== state.trialOrdinal
  ) return state;
  const { midi } = action;
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    throw new RangeError("Committed answer MIDI must be an integer from 0 through 127.");
  }
  if (action.attemptId.trim().length === 0) {
    throw new TypeError("Committed answer attempt id cannot be empty.");
  }
  if (!Number.isFinite(new Date(action.committedAt).getTime())) {
    throw new TypeError("Committed answer time must be a valid date.");
  }
  const correct = midi === state.task.midi;
  const course = recordToneMapTaskResult(
    state.course,
    state.task,
    correct ? "correct" : "incorrect",
  );
  return {
    ...state,
    course,
    answer: {
      kind: "midi",
      midi,
      correct,
      attemptId: action.attemptId,
      committedAt: new Date(action.committedAt).toISOString(),
    },
  };
}

function markUnreachable(
  state: ToneMapSessionState,
  trialOrdinal: number,
): ToneMapSessionState {
  if (
    state.task === null
    || state.task.skill !== "production"
    || state.answer !== null
    || trialOrdinal !== state.trialOrdinal
  ) return state;
  const course = recordToneMapTaskResult(
    state.course,
    state.task,
    "production-unreachable",
  );
  return { ...state, course, answer: { kind: "production-unreachable" } };
}

function retryExcludedProduction(
  state: ToneMapSessionState,
  seed: ToneMapSeed,
): ToneMapSessionState {
  let course = state.course;
  for (const midi of toneMapActiveMidis(course)) {
    if (
      isToneMapProductionMidiSupported(midi)
      && course.tones[midi]!.productionEligibility === "unreachable"
    ) {
      course = setToneMapProductionEligibility(course, midi, "reachable");
    }
  }
  return replaceTask(state, course, state.responseMode, seed);
}

export function reduceToneMapSession(
  state: ToneMapSessionState,
  action: ToneMapSessionAction,
): ToneMapSessionState {
  if (action.type === "answer-midi") return commitMidi(state, action);
  if (action.type === "production-unreachable") {
    return markUnreachable(state, action.trialOrdinal);
  }
  if (action.type === "next") {
    if (state.answer === null) return state;
    return replaceTask(state, state.course, state.responseMode, action.seed);
  }
  if (action.type === "change-response-mode") {
    if (state.answer !== null || action.responseMode === state.responseMode) return state;
    return replaceTask(state, state.course, action.responseMode, action.seed);
  }
  if (action.type === "advance-level") {
    const course = advanceToneMapLevel(
      state.course,
      toneMapRequiredSkills(state.responseMode),
    );
    if (course === state.course) return state;
    return replaceTask(state, course, state.responseMode, action.seed);
  }
  if (action.type === "retry-excluded-production") {
    return retryExcludedProduction(state, action.seed);
  }
  return replaceTask(
    state,
    action.course,
    action.responseMode ?? state.responseMode,
    action.seed,
  );
}

export function toneMapSessionCanAdvance(state: ToneMapSessionState): boolean {
  return summarizeToneMapLevel(
    state.course,
    toneMapRequiredSkills(state.responseMode),
  ).canAdvance;
}
