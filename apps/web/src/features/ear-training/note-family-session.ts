import { TIMBRES, type Timbre } from "@/audio/synth";
import {
  createEmptyNoteFamilyProgress,
  createNoteFamilyTrial,
  createReferenceTrial,
  recordNoteAttempt,
  type FamilyEvidence,
  type NoteFamilyId,
  type NoteFamilyProgress,
  type NoteFamilyTrial,
  type NoteLetter,
  type ReferenceTrial,
} from "./trials";
export type FoundationEarMode = "letters" | "reference";

export interface PromptTrial {
  readonly kind: FoundationEarMode;
  readonly note: NoteFamilyTrial | ReferenceTrial;
  readonly timbreA: Timbre;
  readonly timbreB: Timbre;
  readonly startedAt: string;
}

export interface NoteFamilySession {
  readonly activeFamilyId: NoteFamilyId;
  readonly anchorLetter: NoteLetter;
  readonly progress: NoteFamilyProgress;
  readonly trial: PromptTrial;
  readonly answerLetter: NoteLetter | null;
  readonly dirty: boolean;
  readonly notice: string;
  readonly storage:
    | { readonly status: "loading" }
    | { readonly status: "ready" }
    | { readonly status: "error"; readonly message: string };
}

export type NoteFamilySessionAction =
  | { readonly type: "hydrate"; readonly progress: NoteFamilyProgress }
  | { readonly type: "replace-trial"; readonly activeFamilyId: NoteFamilyId; readonly anchorLetter: NoteLetter; readonly trial: PromptTrial }
  | { readonly type: "answer"; readonly letter: NoteLetter }
  | { readonly type: "storage-error"; readonly message: string }
  | { readonly type: "notice"; readonly message: string };

function randomTimbre(rng: () => number): Timbre {
  return TIMBRES[Math.floor(rng() * TIMBRES.length)] ?? "sine";
}

export function makePromptTrial(
  kind: FoundationEarMode,
  familyId: NoteFamilyId,
  evidence: Readonly<FamilyEvidence>,
  anchorLetter: NoteLetter,
  rng: () => number = Math.random,
  startedAt = new Date().toISOString(),
): PromptTrial {
  const timbreA = randomTimbre(rng);
  return {
    kind,
    note: kind === "reference"
      ? createReferenceTrial(familyId, { anchorLetter, evidence, allowSame: true, rng })
      : createNoteFamilyTrial(familyId, rng, evidence),
    timbreA,
    timbreB: randomTimbre(rng),
    startedAt,
  };
}

export function createNoteFamilySession(
  mode: FoundationEarMode,
  rng: () => number = Math.random,
  startedAt = new Date().toISOString(),
): NoteFamilySession {
  const progress = createEmptyNoteFamilyProgress();
  return {
    activeFamilyId: "low",
    anchorLetter: "A",
    progress,
    trial: makePromptTrial(mode, "low", progress.low, "A", rng, startedAt),
    answerLetter: null,
    dirty: false,
    notice: "",
    storage: { status: "loading" },
  };
}

export function reduceNoteFamilySession(
  state: Readonly<NoteFamilySession>,
  action: Readonly<NoteFamilySessionAction>,
): NoteFamilySession {
  switch (action.type) {
    case "hydrate":
      return { ...state, storage: { status: "ready" }, progress: state.dirty ? state.progress : action.progress };
    case "replace-trial":
      return { ...state, activeFamilyId: action.activeFamilyId, anchorLetter: action.anchorLetter, trial: action.trial, answerLetter: null, notice: "" };
    case "answer": {
      if (state.answerLetter !== null) return state;
      const correct = action.letter === state.trial.note.targetLetter;
      return {
        ...state,
        answerLetter: action.letter,
        dirty: true,
        progress: {
          ...state.progress,
          [state.activeFamilyId]: recordNoteAttempt(
            state.progress[state.activeFamilyId],
            state.trial.note.targetLetter,
            correct,
          ),
        },
      };
    }
    case "storage-error":
      return { ...state, storage: { status: "error", message: action.message } };
    case "notice":
      return { ...state, notice: action.message };
  }
}

export function isReferencePrompt(trial: Readonly<PromptTrial>): trial is PromptTrial & { readonly note: ReferenceTrial } {
  return trial.kind === "reference";
}
