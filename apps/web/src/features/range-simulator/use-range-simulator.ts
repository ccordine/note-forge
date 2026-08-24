import { useCallback, useEffect, useRef, useState } from "react";
import { playTone } from "@/audio/synth";
import { useAudioInput, type AudioInputController } from "@/audio/use-audio-input";
import { queueRangeLoopHandoff } from "@/features/range-loop/handoff";
import {
  BRIEF_REFERENCE_SECONDS,
  useSessionEffectScope,
} from "@/features/training-session/use-session-effect-scope";
import {
  DEFAULT_BASELINE_MIDI,
  VOCAL_PROFILE_STORAGE_KEY,
  normalizeRangeProfile,
} from "@/features/range-loop/profile";
import { continuousMidiToHz } from "@/lib/music-display";
import { useRealtimeSession } from "@/realtime/use-realtime-session";
import { useMusicalState } from "@/state/MusicalContext";
import { useUserPreferences } from "@/state/UserPreferencesContext";
import { useAppNavigation } from "@/routing/use-app-navigation";
import { SettingsPersistence } from "@/storage/settings-persistence";
import {
  activeRangeSimulatorTarget,
  createRangeSimulatorController,
  reduceRangeSimulatorController,
  type RangeSimulatorControllerState,
} from "./controller";
import {
  normalizeRangeSimulatorSession,
  type EffortRating,
  type RangePreparation,
} from "./model";

const RANGE_SIMULATOR_STORAGE_KEY = "hum.range-simulator";
type RangeSimulatorStorageKey = typeof RANGE_SIMULATOR_STORAGE_KEY | typeof VOCAL_PROFILE_STORAGE_KEY;

export type RangeSimulatorPersistenceState = "loading" | "saving" | "saved" | "error";

export interface RangeSimulatorWorkspace {
  readonly state: RangeSimulatorControllerState;
  readonly input: AudioInputController;
  readonly hydrated: boolean;
  readonly persistenceState: RangeSimulatorPersistenceState;
  readonly toleranceCents: number;
  readonly begin: () => void;
  readonly hearReference: () => void;
  readonly chooseRating: (rating: EffortRating) => void;
  readonly setCoordinationChange: (value: boolean) => void;
  readonly retry: () => void;
  readonly saveRating: () => void;
  readonly finish: () => void;
  readonly startFresh: (anchorMidi: number, preparation: RangePreparation) => void;
  readonly openEndlessLoop: (baselineMidi: number) => void;
}

function metadataTimestamp(notBefore: string): string {
  const current = new Date().toISOString();
  return Date.parse(current) >= Date.parse(notBefore) ? current : notBefore;
}

export function useRangeSimulator(): RangeSimulatorWorkspace {
  const {
    setSelectedMidi,
    setCentsOffset,
    timbre,
  } = useMusicalState();
  const { toleranceCents: preferenceToleranceCents } = useUserPreferences();
  const { navigate } = useAppNavigation();
  const [initialState] = useState(() => createRangeSimulatorController({
    anchorMidi: DEFAULT_BASELINE_MIDI,
    preparation: "unwarmed",
    startedAt: new Date().toISOString(),
    toleranceCents: preferenceToleranceCents,
  }));
  const realtime = useRealtimeSession(
    reduceRangeSimulatorController,
    () => initialState,
  );
  const state = realtime.state;
  const activeToleranceCents = state.dwell.toleranceCents;
  const { abort: abortEffects, playReference } = useSessionEffectScope();
  const [hydrated, setHydrated] = useState(false);
  const [persistenceState, setPersistenceState] = useState<RangeSimulatorPersistenceState>("loading");
  const persistenceRef = useRef<SettingsPersistence<RangeSimulatorStorageKey> | null>(null);
  if (persistenceRef.current === null) {
    persistenceRef.current = new SettingsPersistence([
      RANGE_SIMULATOR_STORAGE_KEY,
      VOCAL_PROFILE_STORAGE_KEY,
    ]);
  }
  const persistence = persistenceRef.current;

  const input = useAudioInput({
    diagnostics: {
      flow: "range-simulator",
      phase: state.status,
      targetMidi: activeRangeSimulatorTarget(state),
      toleranceCents: activeToleranceCents,
      stableMs: state.dwell.heldSeconds * 1_000,
      requiredHoldMs: state.dwell.requiredHoldSeconds * 1_000,
      resetReason: null,
    },
    onFrame: (observation) => realtime.observe({ type: "observation", observation }),
  });

  useEffect(() => {
    void persistence.load().then((stored) => {
      if (!stored) return;
      const profile = normalizeRangeProfile(stored.values[VOCAL_PROFILE_STORAGE_KEY]);
      const session = normalizeRangeSimulatorSession(
        stored.values[RANGE_SIMULATOR_STORAGE_KEY],
        {
          anchorMidi: profile.baseline.midi,
          preparation: "unwarmed",
          startedAt: initialState.session.startedAt,
          sessionId: initialState.session.sessionId,
        },
      );
      realtime.dispatch({
        type: "hydrate",
        session,
        profile,
        toleranceCents: initialState.dwell.toleranceCents,
      });
      const allReadable = stored.readableKeys.has(RANGE_SIMULATOR_STORAGE_KEY)
        && stored.readableKeys.has(VOCAL_PROFILE_STORAGE_KEY);
      setPersistenceState(allReadable ? "saved" : "error");
      setHydrated(true);
    });
    return () => persistence.dispose();
  }, [initialState, persistence, realtime.dispatch]);

  useEffect(() => {
    if (!hydrated || state.persistenceRevision === 0) return;
    persistence.save([
      { key: RANGE_SIMULATOR_STORAGE_KEY, value: state.session },
      { key: VOCAL_PROFILE_STORAGE_KEY, value: state.profile },
    ], setPersistenceState);
  }, [hydrated, persistence, state.persistenceRevision, state.profile, state.session]);

  const targetMidi = activeRangeSimulatorTarget(state);
  useEffect(() => {
    setSelectedMidi(targetMidi);
    setCentsOffset(0);
  }, [setCentsOffset, setSelectedMidi, targetMidi]);

  const begin = useCallback(() => {
    abortEffects();
    realtime.dispatch({ type: "begin", toleranceCents: activeToleranceCents });
  }, [abortEffects, activeToleranceCents, realtime.dispatch]);

  const hearReference = useCallback(() => {
    playReference("Range Simulator reference tone", () => playTone({
      frequencyHz: continuousMidiToHz(activeRangeSimulatorTarget(state)),
      timbre,
      duration: BRIEF_REFERENCE_SECONDS,
      amplitude: 0.2,
      release: 0.06,
    }));
  }, [playReference, state, timbre]);

  const chooseRating = useCallback((rating: EffortRating) => {
    realtime.dispatch({ type: "select-rating", rating });
  }, [realtime.dispatch]);
  const setCoordinationChange = useCallback((value: boolean) => {
    realtime.dispatch({ type: "set-coordination", value });
  }, [realtime.dispatch]);
  const retry = useCallback(() => {
    abortEffects();
    realtime.dispatch({ type: "retry", toleranceCents: activeToleranceCents });
  }, [abortEffects, activeToleranceCents, realtime.dispatch]);
  const saveRating = useCallback(() => {
    abortEffects();
    realtime.dispatch({
      type: "save-rating",
      ratedAt: metadataTimestamp(state.session.updatedAt),
      toleranceCents: activeToleranceCents,
    });
  }, [abortEffects, activeToleranceCents, realtime.dispatch, state.session.updatedAt]);
  const finish = useCallback(() => {
    abortEffects();
    realtime.dispatch({ type: "finish", stoppedAt: metadataTimestamp(state.session.updatedAt) });
  }, [abortEffects, realtime.dispatch, state.session.updatedAt]);
  const startFresh = useCallback((anchorMidi: number, preparation: RangePreparation) => {
    abortEffects();
    realtime.dispatch({
      type: "fresh",
      anchorMidi,
      preparation,
      startedAt: new Date().toISOString(),
      toleranceCents: preferenceToleranceCents,
    });
  }, [abortEffects, preferenceToleranceCents, realtime.dispatch]);
  const openEndlessLoop = useCallback((baselineMidi: number) => {
    abortEffects();
    void persistence.flushWhileActive().then((active) => {
      if (!active) return;
      queueRangeLoopHandoff(baselineMidi);
      setSelectedMidi(baselineMidi);
      setCentsOffset(0);
      navigate({ surface: "practice", activity: "range-loop" });
    });
  }, [abortEffects, navigate, persistence, setCentsOffset, setSelectedMidi]);

  return {
    state,
    input,
    hydrated,
    persistenceState,
    toleranceCents: activeToleranceCents,
    begin,
    hearReference,
    chooseRating,
    setCoordinationChange,
    retry,
    saveRating,
    finish,
    startFresh,
    openEndlessLoop,
  };
}
