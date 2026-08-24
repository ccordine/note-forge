import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { playTone } from "@/audio/synth";
import {
  useAudioInput,
  type AudioInputController,
} from "@/audio/use-audio-input";
import {
  BRIEF_REFERENCE_SECONDS,
  useSessionEffectScope,
} from "@/features/training-session/use-session-effect-scope";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import { useRealtimeSession } from "@/realtime/use-realtime-session";
import { useMusicalState } from "@/state/MusicalContext";
import { useUserPreferences } from "@/state/UserPreferencesContext";
import { SettingsPersistence } from "@/storage/settings-persistence";
import { clearRangeLoopHandoff, consumeRangeLoopHandoff } from "./handoff";
import {
  getRangeFamily,
  type FamilyNoteSet,
  type RangeFamilyDefinition,
  type RangeFamilyId,
} from "./model";
import {
  emptyLoopProgress,
  profileFamilyOrder,
  type LoopProgress,
} from "./progress";
import {
  DEFAULT_BASELINE_MIDI,
  VOCAL_PROFILE_STORAGE_KEY,
  createDefaultRangeProfile,
  usableRangeBounds,
  type PersonalRangeProfile,
} from "./profile";
import {
  createRangeDwell,
  reduceRangeDwell,
  type RangeDwellState,
} from "./range-dwell";
import {
  completeRangeLoopFamily,
  firstRangeLoopTarget,
  hydrateRangeLoopState,
  markRangeLoopTargetPassed,
  rangeLoopTargetSequence,
  type RangeLoopOrder,
  type StoredRangeLoopState,
} from "./range-loop-session";

export type RangeLoopPersistenceState = "loading" | "saving" | "saved" | "error";
const STORAGE_KEY = "hum.range-loop";
type RangeLoopStorageKey = typeof STORAGE_KEY | typeof VOCAL_PROFILE_STORAGE_KEY;

export interface RangeLoopSession {
  readonly input: AudioInputController;
  readonly family: RangeFamilyDefinition;
  readonly noteSet: FamilyNoteSet;
  readonly order: RangeLoopOrder;
  readonly holdSeconds: number;
  readonly toleranceCents: number;
  readonly targetMidi: number;
  readonly sequence: readonly number[];
  readonly passedMidis: ReadonlySet<number>;
  readonly followingMidi: number;
  readonly dwell: RangeDwellState;
  readonly completed: boolean;
  readonly holding: boolean;
  readonly hydrated: boolean;
  readonly persistenceState: RangeLoopPersistenceState;
  readonly profileBaselineMidi: number;
  readonly profileLowMidi: number | null;
  readonly profileHighMidi: number | null;
  readonly hearReference: () => void;
  readonly resetHold: () => void;
  readonly advanceTarget: () => void;
  readonly changeFamily: (familyId: RangeFamilyId) => void;
  readonly changeNoteSet: (noteSet: FamilyNoteSet) => void;
  readonly changeOrder: (order: RangeLoopOrder) => void;
  readonly changeHold: (seconds: number) => void;
  readonly changeTolerance: (cents: number) => void;
}

function createDwell(
  targetMidi: number,
  toleranceCents: number,
  holdSeconds: number,
): RangeDwellState {
  return createRangeDwell({
    targetMidi,
    toleranceCents,
    requiredHoldSeconds: holdSeconds,
  });
}

export function useRangeLoopSession(): RangeLoopSession {
  const { setSelectedMidi, setCentsOffset, timbre } = useMusicalState();
  const {
    toleranceCents: preferenceToleranceCents,
    setToleranceCents,
  } = useUserPreferences();
  const [initialToleranceCents] = useState(() => preferenceToleranceCents);
  const [activeFamilyId, setActiveFamilyId] = useState<RangeFamilyId>("low");
  const [noteSet, setNoteSet] = useState<FamilyNoteSet>("natural");
  const [order, setOrder] = useState<RangeLoopOrder>("ascending");
  const [holdSeconds, setHoldSeconds] = useState(3);
  const [targetMidi, setTargetMidi] = useState(DEFAULT_BASELINE_MIDI);
  const [progress, setProgress] = useState<LoopProgress>(emptyLoopProgress);
  const [profile, setProfile] = useState<PersonalRangeProfile>(createDefaultRangeProfile);
  const [hydrated, setHydrated] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [persistenceState, setPersistenceState] = useState<RangeLoopPersistenceState>("loading");
  const persistenceRef = useRef<SettingsPersistence<RangeLoopStorageKey> | null>(null);
  if (persistenceRef.current === null) {
    persistenceRef.current = new SettingsPersistence([STORAGE_KEY, VOCAL_PROFILE_STORAGE_KEY]);
  }
  const persistence = persistenceRef.current;
  const dwellSession = useRealtimeSession(
    reduceRangeDwell,
    () => createDwell(DEFAULT_BASELINE_MIDI, initialToleranceCents, 3),
  );
  const dwell = dwellSession.state;
  const activeToleranceCents = dwell.toleranceCents;
  const effects = useSessionEffectScope();

  const input = useAudioInput({
    diagnostics: {
      flow: "range-loop",
      phase: dwell.status === "complete" ? "complete" : "tracking",
      targetMidi,
      toleranceCents: activeToleranceCents,
      stableMs: dwell.heldSeconds * 1_000,
      requiredHoldMs: holdSeconds * 1_000,
      resetReason: null,
    },
    onFrame: (observation) => dwellSession.observe({ type: "observation", observation }),
  });

  const replaceDwell = useCallback((next: RangeDwellState) => {
    effects.abort();
    dwellSession.dispatch({ type: "replace", state: next });
  }, [dwellSession.dispatch, effects.abort]);

  const prepareTarget = useCallback((nextTarget: number) => {
    setTargetMidi(nextTarget);
    replaceDwell(createDwell(nextTarget, activeToleranceCents, holdSeconds));
    setSelectedMidi(nextTarget);
    setCentsOffset(0);
  }, [activeToleranceCents, holdSeconds, replaceDwell, setCentsOffset, setSelectedMidi]);

  useEffect(() => {
    const handoffMidi = consumeRangeLoopHandoff();
    void persistence.load().then((storedSettings) => {
      if (!storedSettings) return;
      const loopRead = storedSettings.readableKeys.has(STORAGE_KEY);
      const profileRead = storedSettings.readableKeys.has(VOCAL_PROFILE_STORAGE_KEY);
      const stored = storedSettings.values[STORAGE_KEY] as StoredRangeLoopState | undefined;
      const storedProfile = storedSettings.values[VOCAL_PROFILE_STORAGE_KEY] as PersonalRangeProfile | undefined;
      const next = hydrateRangeLoopState(
        stored,
        storedProfile,
        handoffMidi,
        initialToleranceCents,
        new Date().toISOString(),
      );
      setProfile(next.profile);
      setProgress(next.progress);
      setActiveFamilyId(next.activeFamilyId);
      setNoteSet(next.noteSet);
      setOrder(next.order);
      setHoldSeconds(next.holdSeconds);
      setToleranceCents(next.toleranceCents);
      setTargetMidi(next.targetMidi);
      setSelectedMidi(next.targetMidi);
      setCentsOffset(0);
      replaceDwell(createDwell(next.targetMidi, next.toleranceCents, next.holdSeconds));
      setStorageReady(loopRead && profileRead);
      setPersistenceState(loopRead && profileRead ? "saved" : "error");
      setHydrated(true);
      clearRangeLoopHandoff();
    });
    return () => persistence.dispose();
  }, [
    persistence,
    initialToleranceCents,
    replaceDwell,
    setCentsOffset,
    setSelectedMidi,
    setToleranceCents,
  ]);

  useEffect(() => {
    if (!hydrated || !storageReady) return;
    const snapshot: StoredRangeLoopState = {
      activeFamilyId,
      noteSet,
      order,
      holdSeconds,
      toleranceCents: activeToleranceCents,
      targetMidi,
      progress,
    };
    persistence.save([
      { key: STORAGE_KEY, value: snapshot },
      { key: VOCAL_PROFILE_STORAGE_KEY, value: profile },
    ], setPersistenceState);
  }, [
    activeFamilyId,
    activeToleranceCents,
    holdSeconds,
    hydrated,
    noteSet,
    order,
    persistence,
    profile,
    progress,
    storageReady,
    targetMidi,
  ]);

  useEffect(() => {
    if (dwell.status !== "complete") return;
    setProgress((current) => markRangeLoopTargetPassed(
      current,
      activeFamilyId,
      noteSet,
      targetMidi,
    ));
  }, [activeFamilyId, dwell.status, noteSet, targetMidi]);

  const sequence = useMemo(
    () => rangeLoopTargetSequence(activeFamilyId, noteSet, order),
    [activeFamilyId, noteSet, order],
  );
  const passedMidis = useMemo(
    () => new Set(progress[noteSet][activeFamilyId].passedMidis),
    [activeFamilyId, noteSet, progress],
  );
  const family = getRangeFamily(activeFamilyId);
  const targetIndex = Math.max(0, sequence.indexOf(targetMidi));
  const followingMidi = sequence[(targetIndex + 1) % sequence.length] ?? targetMidi;
  const profileBounds = usableRangeBounds(profile);
  const completed = dwell.status === "complete";
  const holding = input.state === "running" && dwell.currentInTolerance === true && !completed;

  const hearReference = () => {
    effects.playReference(`Reference ${noteLabel(targetMidi)}`, () => playTone({
      frequencyHz: continuousMidiToHz(targetMidi),
      duration: BRIEF_REFERENCE_SECONDS,
      amplitude: 0.18,
      attack: 0.02,
      release: 0.08,
      timbre,
    }));
  };

  const changeFamily = (nextFamily: RangeFamilyId) => {
    setActiveFamilyId(nextFamily);
    const baseline = profile.baseline.midi;
    const targets = rangeLoopTargetSequence(nextFamily, noteSet, order);
    prepareTarget(targets.includes(baseline)
      ? baseline
      : firstRangeLoopTarget(progress, nextFamily, noteSet, order));
  };

  const changeNoteSet = (nextSet: FamilyNoteSet) => {
    setNoteSet(nextSet);
    const baseline = profile.baseline.midi;
    const targets = rangeLoopTargetSequence(activeFamilyId, nextSet, order);
    prepareTarget(targets.includes(baseline)
      ? baseline
      : firstRangeLoopTarget(progress, activeFamilyId, nextSet, order));
  };

  const changeOrder = (nextOrder: RangeLoopOrder) => {
    setOrder(nextOrder);
    prepareTarget(firstRangeLoopTarget(progress, activeFamilyId, noteSet, nextOrder));
  };

  const changeHold = (nextHold: number) => {
    setHoldSeconds(nextHold);
    replaceDwell(createDwell(targetMidi, activeToleranceCents, nextHold));
  };

  const changeTolerance = (nextTolerance: number) => {
    setToleranceCents(nextTolerance);
    replaceDwell(createDwell(targetMidi, nextTolerance, holdSeconds));
  };

  const advanceTarget = () => {
    const completedProgress = markRangeLoopTargetPassed(
      progress,
      activeFamilyId,
      noteSet,
      targetMidi,
    );
    const completedSet = new Set(completedProgress[noteSet][activeFamilyId].passedMidis);
    const remaining = [
      ...sequence.slice(targetIndex + 1),
      ...sequence.slice(0, targetIndex),
    ].find((midi) => !completedSet.has(midi));
    if (remaining !== undefined) {
      setProgress(completedProgress);
      prepareTarget(remaining);
      return;
    }

    const cycledProgress = completeRangeLoopFamily(completedProgress, activeFamilyId, noteSet);
    const route = profileFamilyOrder(profile.baseline.midi);
    const familyIndex = Math.max(0, route.indexOf(activeFamilyId));
    const nextFamily = route[(familyIndex + 1) % route.length] ?? activeFamilyId;
    const nextTarget = firstRangeLoopTarget(cycledProgress, nextFamily, noteSet, order);
    setProgress(cycledProgress);
    setActiveFamilyId(nextFamily);
    prepareTarget(nextTarget);
  };

  return {
    input,
    family,
    noteSet,
    order,
    holdSeconds,
    toleranceCents: activeToleranceCents,
    targetMidi,
    sequence,
    passedMidis,
    followingMidi,
    dwell,
    completed,
    holding,
    hydrated,
    persistenceState,
    profileBaselineMidi: profile.baseline.midi,
    profileLowMidi: profileBounds.lowMidi,
    profileHighMidi: profileBounds.highMidi,
    hearReference,
    resetHold: () => replaceDwell(createDwell(targetMidi, activeToleranceCents, holdSeconds)),
    advanceTarget,
    changeFamily,
    changeNoteSet,
    changeOrder,
    changeHold,
    changeTolerance,
  };
}
