import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AudioInputController } from "@/audio/use-audio-input";
import {
  useSustainedNote,
  type SustainedNoteControl,
} from "@/audio/use-sustained-note";
import {
  VOCAL_PROFILE_STORAGE_KEY,
} from "@/features/range-loop/profile";
import { continuousMidiToHz } from "@/lib/music-display";
import { useUserPreferences } from "@/state/UserPreferencesContext";
import { saveAttempt } from "@/storage/database";
import { SettingsPersistence } from "@/storage/settings-persistence";
import type { Timbre } from "@/audio/synth";
import {
  createToneMapCourse,
  type ToneMapCourseState,
} from "./tone-map-model";
import {
  TONE_MAP_DEFAULT_SIMON_LENGTH,
  requireToneMapSimonLength,
  type ToneMapChallengeMode,
} from "./tone-map-config";
import { applyToneMapProductionProfile } from "./tone-map-production-profile";
import {
  createToneMapSession,
  reduceToneMapSession,
  type ToneMapResponseMode,
  type ToneMapSessionState,
} from "./tone-map-session";
import { toneMapAcceptedAttempt } from "./tone-map-attempt-history";
import {
  classifyStoredToneMap,
  mayWriteToneMapStorage,
  type StoredToneMapState,
} from "./tone-map-storage";
import type { ToneMapVoiceAnswerSnapshot } from "./tone-map-voice-answer";
import { useToneMapVoiceAnswer } from "./use-tone-map-voice-answer";

export type { ToneMapChallengeMode } from "./tone-map-config";
export type ToneMapPersistenceState = "loading" | "saving" | "saved" | "error";

export interface ToneMapSessionController {
  readonly session: ToneMapSessionState;
  readonly input: AudioInputController;
  readonly voiceAnswer: Readonly<ToneMapVoiceAnswerSnapshot>;
  readonly promptPlayback: Readonly<SustainedNoteControl>;
  readonly challengeMode: ToneMapChallengeMode;
  readonly simonLength: number;
  readonly hydrated: boolean;
  readonly persistenceState: ToneMapPersistenceState;
  readonly storageResetAvailable: boolean;
  readonly answerMidi: (midi: number) => void;
  readonly commitVoiceAnswer: () => void;
  readonly markProductionUnreachable: () => void;
  readonly next: () => void;
  readonly advanceLevel: () => void;
  readonly changeResponseMode: (mode: ToneMapResponseMode) => void;
  readonly changeChallengeMode: (mode: ToneMapChallengeMode) => void;
  readonly changeSimonLength: (length: number) => void;
  readonly retryExcludedProduction: () => void;
  readonly replaceCourseFromSimon: (course: ToneMapCourseState) => void;
  readonly resetStoredCourse: () => void;
}

export const TONE_MAP_STORAGE_KEY = "ear.tone-map";
type ToneMapStorageKey = typeof TONE_MAP_STORAGE_KEY | typeof VOCAL_PROFILE_STORAGE_KEY;

function newSeed(label: string): string {
  return `${label}:${crypto.randomUUID()}`;
}

export function useToneMapSession(timbre: Timbre): ToneMapSessionController {
  const { toleranceCents } = useUserPreferences();
  const [session, dispatch] = useReducer(
    reduceToneMapSession,
    undefined,
    () => createToneMapSession(
      createToneMapCourse(newSeed("course")),
      "keyboard",
      newSeed("first-task"),
    ),
  );
  const [challengeMode, setChallengeMode] = useState<ToneMapChallengeMode>("single");
  const [simonLength, setSimonLength] = useState(TONE_MAP_DEFAULT_SIMON_LENGTH);
  const [hydrated, setHydrated] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [storageResetAvailable, setStorageResetAvailable] = useState(false);
  const [persistenceState, setPersistenceState] = useState<ToneMapPersistenceState>("loading");
  const persistenceRef = useRef<SettingsPersistence<ToneMapStorageKey> | null>(null);
  if (persistenceRef.current === null) {
    persistenceRef.current = new SettingsPersistence([
      TONE_MAP_STORAGE_KEY,
      VOCAL_PROFILE_STORAGE_KEY,
    ]);
  }
  const persistence = persistenceRef.current;
  const profileCandidateRef = useRef<unknown>(undefined);
  const lastPromptMidiRef = useRef<number | null>(session.task?.midi ?? null);
  if (session.task !== null) lastPromptMidiRef.current = session.task.midi;
  if (lastPromptMidiRef.current === null) {
    throw new Error("Tone Map requires one real task before binding its prompt lane.");
  }
  const promptPlayback = useSustainedNote({
    frequencyHz: continuousMidiToHz(lastPromptMidiRef.current),
    timbre,
    amplitude: 0.22,
  });
  const voiceContext = useMemo(() => ({
    trialOrdinal: session.trialOrdinal,
    active: session.task?.skill === "production",
    answered: session.answer !== null,
    promptPlaying: promptPlayback.playing,
    toleranceCents,
  }), [
    promptPlayback.playing,
    session.answer,
    session.task?.skill,
    session.trialOrdinal,
    toleranceCents,
  ]);
  const voiceAnswerController = useToneMapVoiceAnswer(voiceContext);
  const input = voiceAnswerController.input;

  useEffect(() => {
    void persistence.load().then((storedSettings) => {
      if (!storedSettings) return;
      profileCandidateRef.current = storedSettings.values[VOCAL_PROFILE_STORAGE_KEY];
      const stored = classifyStoredToneMap(storedSettings.values[TONE_MAP_STORAGE_KEY]);
      const base = stored.kind === "valid" ? stored.state : {
        version: 2 as const,
        course: createToneMapCourse(newSeed("course")),
        responseMode: "keyboard" as const,
        challengeMode: "single" as const,
        simonLength: TONE_MAP_DEFAULT_SIMON_LENGTH,
      };
      const course = applyToneMapProductionProfile(
        base.course,
        storedSettings.values[VOCAL_PROFILE_STORAGE_KEY],
      );
      dispatch({
        type: "replace-course",
        course,
        responseMode: base.responseMode,
        seed: newSeed("hydrate-course"),
      });
      setChallengeMode(base.challengeMode);
      setSimonLength(base.simonLength);
      const ready = mayWriteToneMapStorage(
        storedSettings.readableKeys.has(TONE_MAP_STORAGE_KEY),
        stored,
      );
      setStorageReady(ready);
      setStorageResetAvailable(
        stored.kind === "invalid"
          && storedSettings.readableKeys.has(TONE_MAP_STORAGE_KEY),
      );
      setPersistenceState(ready ? "saved" : "error");
      setHydrated(true);
    });
    return () => persistence.dispose();
  }, [persistence]);

  useEffect(() => {
    if (!hydrated || !storageReady) return;
    const stored: StoredToneMapState = {
      version: 2,
      course: session.course,
      responseMode: session.responseMode,
      challengeMode,
      simonLength,
    };
    persistence.save(
      [{ key: TONE_MAP_STORAGE_KEY, value: stored }],
      setPersistenceState,
    );
  }, [challengeMode, hydrated, persistence, session.course, session.responseMode, simonLength, storageReady]);

  useEffect(() => {
    const attempt = toneMapAcceptedAttempt(session);
    if (attempt === null) return;
    void saveAttempt(attempt).catch(() => setPersistenceState("error"));
  }, [session.answer, session.task, session.trialOrdinal]);

  const answerMidi = (midi: number) => {
    if (session.task === null || session.answer !== null) return;
    dispatch({
      type: "answer-midi",
      midi,
      trialOrdinal: session.trialOrdinal,
      attemptId: crypto.randomUUID(),
      committedAt: new Date().toISOString(),
    });
  };

  const changeResponseMode = (responseMode: ToneMapResponseMode) => {
    dispatch({ type: "change-response-mode", responseMode, seed: newSeed("mode") });
  };

  const commitVoiceAnswer = () => {
    if (session.task?.skill !== "production" || session.answer !== null) return;
    const midi = voiceAnswerController.readCommittedMidi();
    if (midi !== null) answerMidi(midi);
  };

  const resetStoredCourse = () => {
    if (!storageResetAvailable) return;
    const course = applyToneMapProductionProfile(
      createToneMapCourse(newSeed("reset-course")),
      profileCandidateRef.current,
    );
    dispatch({
      type: "replace-course",
      course,
      responseMode: "keyboard",
      seed: newSeed("reset-task"),
    });
    setChallengeMode("single");
    setSimonLength(TONE_MAP_DEFAULT_SIMON_LENGTH);
    setStorageResetAvailable(false);
    setStorageReady(true);
    setPersistenceState("saving");
  };

  return {
    session,
    input,
    voiceAnswer: voiceAnswerController.snapshot,
    promptPlayback,
    challengeMode,
    simonLength,
    hydrated,
    persistenceState,
    storageResetAvailable,
    answerMidi,
    commitVoiceAnswer,
    markProductionUnreachable: () => dispatch({
      type: "production-unreachable",
      trialOrdinal: session.trialOrdinal,
    }),
    next: () => dispatch({ type: "next", seed: newSeed("next") }),
    advanceLevel: () => dispatch({ type: "advance-level", seed: newSeed("level") }),
    changeResponseMode,
    changeChallengeMode: setChallengeMode,
    changeSimonLength: (length) => setSimonLength(requireToneMapSimonLength(length)),
    retryExcludedProduction: () => dispatch({ type: "retry-excluded-production", seed: newSeed("retry") }),
    replaceCourseFromSimon: (course) => dispatch({ type: "replace-course", course, seed: newSeed("simon") }),
    resetStoredCourse,
  };
}
