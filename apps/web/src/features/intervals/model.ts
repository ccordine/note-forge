export type IntervalPresentation = "ascending" | "descending" | "harmonic";
export type ComparisonAnswer = "a" | "same" | "b";

export interface IntervalTrial {
  readonly start: number;
  readonly semitones: number;
  readonly presentation: IntervalPresentation;
}

export interface RecognitionState {
  readonly stage: "answering" | "review";
  readonly trial: IntervalTrial;
  readonly answer?: number;
  readonly right: number;
  readonly total: number;
}

export type RecognitionAction =
  | Readonly<{ type: "choose"; semitones: number }>
  | Readonly<{ type: "submit" }>
  | Readonly<{ type: "next"; trial: IntervalTrial }>;

export interface ComparisonState {
  readonly stage: "answering" | "review";
  readonly a: IntervalTrial;
  readonly b: IntervalTrial;
  readonly answer?: ComparisonAnswer;
}

export type ComparisonAction =
  | Readonly<{ type: "choose"; answer: ComparisonAnswer }>
  | Readonly<{ type: "submit" }>
  | Readonly<{ type: "next"; a: IntervalTrial; b: IntervalTrial }>;

function randomIndex(length: number, random: () => number): number {
  return Math.min(length - 1, Math.floor(random() * length));
}

export function createIntervalTrial(
  presentation?: IntervalPresentation,
  random: () => number = Math.random,
): IntervalTrial {
  const presentations: readonly IntervalPresentation[] = ["ascending", "descending", "harmonic"];
  return {
    start: 48 + randomIndex(15, random),
    semitones: 1 + randomIndex(12, random),
    presentation: presentation ?? presentations[randomIndex(presentations.length, random)] ?? "ascending",
  };
}

export function intervalTrialNotes(trial: IntervalTrial): readonly [number, number] {
  const direction = trial.presentation === "descending" ? -1 : 1;
  return [trial.start, trial.start + direction * trial.semitones];
}

export function comparisonResult(a: IntervalTrial, b: IntervalTrial): ComparisonAnswer {
  if (a.semitones === b.semitones) return "same";
  return a.semitones > b.semitones ? "a" : "b";
}

export function createRecognitionState(trial: IntervalTrial): RecognitionState {
  return { stage: "answering", trial, right: 0, total: 0 };
}

export function reduceRecognitionState(
  state: RecognitionState,
  action: RecognitionAction,
): RecognitionState {
  if (action.type === "next") {
    return {
      stage: "answering",
      trial: action.trial,
      right: state.right,
      total: state.total,
    };
  }
  if (state.stage === "review") return state;
  if (action.type === "choose") return { ...state, answer: action.semitones };
  if (state.answer === undefined) return state;
  return {
    ...state,
    stage: "review",
    right: state.right + Number(state.answer === state.trial.semitones),
    total: state.total + 1,
  };
}

export function createComparisonState(
  a: IntervalTrial,
  b: IntervalTrial,
): ComparisonState {
  return { stage: "answering", a, b };
}

export function reduceComparisonState(
  state: ComparisonState,
  action: ComparisonAction,
): ComparisonState {
  if (action.type === "next") {
    return { stage: "answering", a: action.a, b: action.b };
  }
  if (state.stage === "review") return state;
  if (action.type === "choose") return { ...state, answer: action.answer };
  if (state.answer === undefined) return state;
  return { ...state, stage: "review" };
}

export function mutationPhrase(startMidi: number): readonly number[] {
  return [0, 2, 5, 3].map((offset) => startMidi + offset);
}
