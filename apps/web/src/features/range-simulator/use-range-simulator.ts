import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAudioInput, type AudioInputController } from "@/audio/use-audio-input";
import {
  useSustainedNote,
  type SustainedNoteControl,
} from "@/audio/use-sustained-note";
import { queueRangeLoopHandoff } from "@/features/range-loop/handoff";
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
  readonly referencePlayback: Readonly<SustainedNoteControl>;
  readonly chooseRating: (rating: EffortRating) => void;
  readonly setCoordinationChange: (value: boolean) => void;
  readonly retry: () => void;
  readonly saveRating: () => void;
  readonly finish: () => void;
  readonly recheck: () => void;
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
  const preferenceToleranceRef = useRef(preferenceToleranceCents);
  preferenceToleranceRef.current = preferenceToleranceCents;
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
    onFrame: (observation) => realtime.observe({ type: "observation", observation }),
  });

  useLayoutEffect(() => {
    realtime.dispatch({
      type: "reconfigure-tolerance",
      toleranceCents: preferenceToleranceCents,
    });
  }, [preferenceToleranceCents, realtime.dispatch]);

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
        toleranceCents: preferenceToleranceRef.current,
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
  const referencePlayback = useSustainedNote({
    frequencyHz: continuousMidiToHz(targetMidi),
    timbre,
    amplitude: 0.2,
  });
  useEffect(() => {
    setSelectedMidi(targetMidi);
    setCentsOffset(0);
  }, [setCentsOffset, setSelectedMidi, targetMidi]);

  const begin = useCallback(() => {
    realtime.dispatch({ type: "begin", toleranceCents: preferenceToleranceCents });
  }, [preferenceToleranceCents, realtime.dispatch]);

  const chooseRating = useCallback((rating: EffortRating) => {
    realtime.dispatch({ type: "select-rating", rating });
  }, [realtime.dispatch]);
  const setCoordinationChange = useCallback((value: boolean) => {
    realtime.dispatch({ type: "set-coordination", value });
  }, [realtime.dispatch]);
  const retry = useCallback(() => {
    realtime.dispatch({ type: "retry", toleranceCents: activeToleranceCents });
  }, [activeToleranceCents, realtime.dispatch]);
  const saveRating = useCallback(() => {
    realtime.dispatch({
      type: "save-rating",
      ratedAt: metadataTimestamp(state.session.updatedAt),
      toleranceCents: activeToleranceCents,
    });
  }, [activeToleranceCents, realtime.dispatch, state.session.updatedAt]);
  const finish = useCallback(() => {
    realtime.dispatch({ type: "finish", stoppedAt: metadataTimestamp(state.session.updatedAt) });
  }, [realtime.dispatch, state.session.updatedAt]);
  const recheck = useCallback(() => {
    realtime.dispatch({
      type: "recheck",
      startedAt: metadataTimestamp(state.session.updatedAt),
      toleranceCents: activeToleranceCents,
    });
  }, [activeToleranceCents, realtime.dispatch, state.session.updatedAt]);
  const startFresh = useCallback((anchorMidi: number, preparation: RangePreparation) => {
    realtime.dispatch({
      type: "fresh",
      anchorMidi,
      preparation,
      startedAt: new Date().toISOString(),
      toleranceCents: preferenceToleranceCents,
    });
  }, [preferenceToleranceCents, realtime.dispatch]);
  const openEndlessLoop = useCallback((baselineMidi: number) => {
    void persistence.flushWhileActive().then((active) => {
      if (!active) return;
      queueRangeLoopHandoff(baselineMidi);
      setSelectedMidi(baselineMidi);
      setCentsOffset(0);
      navigate({ surface: "practice", activity: "range-loop" });
    });
  }, [navigate, persistence, setCentsOffset, setSelectedMidi]);

  return {
    state,
    input,
    hydrated,
    persistenceState,
    toleranceCents: activeToleranceCents,
    begin,
    referencePlayback,
    chooseRating,
    setCoordinationChange,
    retry,
    saveRating,
    finish,
    recheck,
    startFresh,
    openEndlessLoop,
  };
}
