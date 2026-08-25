import { normalizePitchClass } from "@noteforge/music-core";
import { TIMBRES, type Timbre } from "@/audio/synth";
import { clamp } from "@/lib/numeric";
import type { EarMode } from "@/navigation";
import type { FoundationEarMode } from "./NoteFamilyTrainer";

export type AdvancedEarMode = Exclude<EarMode, FoundationEarMode | "map">;
export type RelationAnswer = "same" | "different" | "higher" | "lower";
export type AdvancedAnswerKind = "relation" | "pitch-class" | "octave" | "complete";

export interface AdvancedEarTrial {
  readonly firstMidi: number;
  readonly targetMidi: number;
  readonly timbreA: Timbre;
  readonly timbreB: Timbre;
}

export interface AdvancedEarAnswer {
  readonly pitchClass?: number;
  readonly octave?: number;
  readonly relation?: RelationAnswer;
}

export interface AdvancedEarScore {
  readonly attempts: number;
  readonly pitchClass: number;
  readonly pitchClassAttempts: number;
  readonly octave: number;
  readonly octaveAttempts: number;
  readonly relation: number;
  readonly relationAttempts: number;
}

export interface AdvancedEarState {
  readonly stage: "answering" | "review";
  readonly trial: AdvancedEarTrial;
  readonly answer: AdvancedEarAnswer;
  readonly score: AdvancedEarScore;
}

export type AdvancedEarAction =
  | Readonly<{ type: "choose-pitch-class"; pitchClass: number }>
  | Readonly<{ type: "choose-octave"; octave: number }>
  | Readonly<{ type: "choose-relation"; relation: RelationAnswer }>
  | Readonly<{ type: "submit"; mode: AdvancedEarMode }>
  | Readonly<{ type: "next"; trial: AdvancedEarTrial }>;

const EMPTY_SCORE: AdvancedEarScore = Object.freeze({
  attempts: 0,
  pitchClass: 0,
  pitchClassAttempts: 0,
  octave: 0,
  octaveAttempts: 0,
  relation: 0,
  relationAttempts: 0,
});

const ANSWER_KIND: Readonly<Record<AdvancedEarMode, AdvancedAnswerKind>> = Object.freeze({
  "same-different": "relation",
  direction: "relation",
  "pitch-class": "pitch-class",
  octave: "octave",
  complete: "complete",
  family: "pitch-class",
});

const PROMPTS: Readonly<Record<AdvancedEarMode, string>> = Object.freeze({
  "same-different": "Did the pitch change?",
  direction: "Where did the second sound move?",
  family: "What remains constant across registers?",
  octave: "Which register contains the sound?",
  complete: "Name both identity and register.",
  "pitch-class": "Name the chromatic pitch class across mixed registers.",
});

function randomIndex(length: number, random: () => number): number {
  return Math.min(length - 1, Math.floor(random() * length));
}

function randomTimbre(random: () => number): Timbre {
  return TIMBRES[randomIndex(TIMBRES.length, random)] ?? "sine";
}

export function isFoundationEarMode(mode: EarMode): mode is FoundationEarMode {
  return mode === "letters" || mode === "reference";
}

export function advancedAnswerKind(mode: AdvancedEarMode): AdvancedAnswerKind {
  return ANSWER_KIND[mode];
}

export function advancedEarPrompt(mode: AdvancedEarMode): string {
  return PROMPTS[mode];
}

export function createAdvancedEarTrial(
  mode: AdvancedEarMode,
  crossTimbre: boolean,
  random: () => number = Math.random,
): AdvancedEarTrial {
  const timbreA = randomTimbre(random);
  const timbreB = crossTimbre ? randomTimbre(random) : timbreA;
  const targetMidi = mode === "octave"
    ? 36 + randomIndex(48, random)
    : 48 + randomIndex(24, random);

  if (mode === "same-different") {
    if (random() < 0.45) return { firstMidi: targetMidi, targetMidi, timbreA, timbreB };
    const offsets = [-5, -2, -1, 1, 2, 5] as const;
    const offset = offsets[randomIndex(offsets.length, random)] ?? 1;
    return {
      firstMidi: clamp(targetMidi + offset, 45, 76),
      targetMidi,
      timbreA,
      timbreB,
    };
  }

  if (mode === "direction") {
    const distance = 1 + randomIndex(7, random);
    const offset = random() < 0.5 ? -distance : distance;
    return {
      firstMidi: clamp(targetMidi + offset, 45, 76),
      targetMidi,
      timbreA,
      timbreB,
    };
  }

  return { firstMidi: 69, targetMidi, timbreA, timbreB };
}

export function createAdvancedEarState(trial: AdvancedEarTrial): AdvancedEarState {
  return {
    stage: "answering",
    trial,
    answer: {},
    score: EMPTY_SCORE,
  };
}

export function targetPitchClass(trial: AdvancedEarTrial): number {
  return normalizePitchClass(trial.targetMidi);
}

export function targetOctave(trial: AdvancedEarTrial): number {
  return Math.floor(trial.targetMidi / 12) - 1;
}

export function correctRelation(
  mode: Extract<AdvancedEarMode, "same-different" | "direction">,
  trial: AdvancedEarTrial,
): RelationAnswer {
  if (mode === "same-different") {
    return trial.firstMidi === trial.targetMidi ? "same" : "different";
  }
  return trial.targetMidi > trial.firstMidi ? "higher" : "lower";
}

export function canSubmitAdvancedAnswer(mode: AdvancedEarMode, answer: AdvancedEarAnswer): boolean {
  const kind = advancedAnswerKind(mode);
  if (kind === "relation") return answer.relation !== undefined;
  if (kind === "pitch-class") return answer.pitchClass !== undefined;
  if (kind === "octave") return answer.octave !== undefined;
  return answer.pitchClass !== undefined && answer.octave !== undefined;
}

export function advancedAnswerIsCorrect(
  mode: AdvancedEarMode,
  trial: AdvancedEarTrial,
  answer: AdvancedEarAnswer,
): boolean {
  const kind = advancedAnswerKind(mode);
  if (kind === "pitch-class") return answer.pitchClass === targetPitchClass(trial);
  if (kind === "octave") return answer.octave === targetOctave(trial);
  if (kind === "complete") {
    return answer.pitchClass === targetPitchClass(trial) && answer.octave === targetOctave(trial);
  }
  return answer.relation === correctRelation(
    mode as Extract<AdvancedEarMode, "same-different" | "direction">,
    trial,
  );
}

function scoreAnswer(
  score: AdvancedEarScore,
  mode: AdvancedEarMode,
  trial: AdvancedEarTrial,
  answer: AdvancedEarAnswer,
): AdvancedEarScore {
  const kind = advancedAnswerKind(mode);
  const scoresPitchClass = kind === "pitch-class" || kind === "complete";
  const scoresOctave = kind === "octave" || kind === "complete";
  const scoresRelation = kind === "relation";
  const pitchClassCorrect = answer.pitchClass === targetPitchClass(trial);
  const octaveCorrect = answer.octave === targetOctave(trial);
  const relationCorrect = scoresRelation && answer.relation === correctRelation(
    mode as Extract<AdvancedEarMode, "same-different" | "direction">,
    trial,
  );

  return {
    attempts: score.attempts + 1,
    pitchClass: score.pitchClass + Number(scoresPitchClass && pitchClassCorrect),
    pitchClassAttempts: score.pitchClassAttempts + Number(scoresPitchClass),
    octave: score.octave + Number(scoresOctave && octaveCorrect),
    octaveAttempts: score.octaveAttempts + Number(scoresOctave),
    relation: score.relation + Number(relationCorrect),
    relationAttempts: score.relationAttempts + Number(scoresRelation),
  };
}

export function reduceAdvancedEarState(
  state: AdvancedEarState,
  action: AdvancedEarAction,
): AdvancedEarState {
  if (action.type === "next") {
    return { ...state, stage: "answering", trial: action.trial, answer: {} };
  }
  if (state.stage === "review") return state;
  if (action.type === "choose-pitch-class") {
    return { ...state, answer: { ...state.answer, pitchClass: action.pitchClass } };
  }
  if (action.type === "choose-octave") {
    return { ...state, answer: { ...state.answer, octave: action.octave } };
  }
  if (action.type === "choose-relation") {
    return { ...state, answer: { ...state.answer, relation: action.relation } };
  }
  if (!canSubmitAdvancedAnswer(action.mode, state.answer)) return state;
  return {
    ...state,
    stage: "review",
    score: scoreAnswer(state.score, action.mode, state.trial, state.answer),
  };
}
