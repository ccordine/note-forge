import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useSustainedNote,
  type SustainedNoteControl,
} from "@/audio/use-sustained-note";
import {
  useAudioInput,
  type AudioInputController,
} from "@/audio/use-audio-input";
import { continuousMidiToHz } from "@/lib/music-display";
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
  parkedMidiCount,
  profileOrderedTargets,
  recheckAllParkedMidis,
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
  createRangeLoopCredit,
  reduceRangeLoopCredit,
  type RangeLoopCreditState,
} from "./range-loop-credit";
import {
  RANGE_LOOP_SCORING_VERSION,
  advanceRangeLoopTarget,
  chooseRangeLoopTarget,
  createRangeLoopLiveState,
  hydrateRangeLoopState,
  reduceRangeLoopLiveState,
  type RangeLoopLivePhase,
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
  readonly phase: RangeLoopLivePhase;
  readonly toleranceCents: number;
  readonly targetMidi: number;
  readonly sequence: readonly number[];
  readonly passedMidis: ReadonlySet<number>;
  readonly parkedMidis: ReadonlySet<number>;
  readonly followingMidi: number;
  readonly earnedCount: number;
  readonly credit: RangeLoopCreditState;
  readonly practicePoints: number;
  readonly achievementReached: boolean;
  readonly acceptingCredit: boolean;
  readonly holding: boolean;
  readonly excludedNoteCount: number;
  readonly hydrated: boolean;
  readonly persistenceState: RangeLoopPersistenceState;
  readonly profileBaselineMidi: number;
  readonly profileLowMidi: number | null;
  readonly profileHighMidi: number | null;
  readonly referencePlayback: Readonly<SustainedNoteControl>;
  readonly start: () => void;
  readonly finish: () => void;
  readonly advanceTarget: () => void;
  readonly markCurrentOutsideRange: () => void;
  readonly recheckExcludedNotes: () => void;
  readonly changeFamily: (familyId: RangeFamilyId) => void;
  readonly changeNoteSet: (noteSet: FamilyNoteSet) => void;
  readonly changeOrder: (order: RangeLoopOrder) => void;
  readonly changeTolerance: (cents: number) => void;
}

export function useRangeLoopSession(): RangeLoopSession {
  const { setSelectedMidi, setCentsOffset, timbre } = useMusicalState();
  const {
    toleranceCents: preferenceToleranceCents,
    setToleranceCents,
  } = useUserPreferences();
  const preferenceToleranceRef = useRef(preferenceToleranceCents);
  preferenceToleranceRef.current = preferenceToleranceCents;
  const [activeFamilyId, setActiveFamilyId] = useState<RangeFamilyId>("low");
  const [noteSet, setNoteSet] = useState<FamilyNoteSet>("natural");
  const [order, setOrder] = useState<RangeLoopOrder>("ascending");
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
  const liveSession = useRealtimeSession(
    reduceRangeLoopLiveState,
    createRangeLoopLiveState,
  );
  const creditSession = useRealtimeSession(
    reduceRangeLoopCredit,
    () => createRangeLoopCredit({
      targetMidi: DEFAULT_BASELINE_MIDI,
      toleranceCents: preferenceToleranceCents,
    }),
  );
  const credit = creditSession.state;
  const activeToleranceCents = credit.toleranceCents;
  const referencePlayback = useSustainedNote({
    frequencyHz: continuousMidiToHz(targetMidi),
    timbre,
    amplitude: 0.18,
  });

  const input = useAudioInput({
    // Persistence chooses the authoritative target/configuration. Observations
    // received before hydration remain in the AudioKernel, but score nowhere.
    onFrame: (observation) => {
      if (hydrated && liveSession.getCurrent().phase === "tracking") {
        creditSession.observe({ type: "observation", observation });
      }
    },
  });

  const replaceCredit = useCallback((next: RangeLoopCreditState) => {
    creditSession.dispatch({ type: "replace", state: next });
  }, [creditSession.dispatch]);

  useLayoutEffect(() => {
    creditSession.dispatch({
      type: "reconfigure-tolerance",
      toleranceCents: preferenceToleranceCents,
    });
  }, [creditSession.dispatch, preferenceToleranceCents]);

  const prepareTarget = useCallback((nextTarget: number, acceptingCredit = true) => {
    setTargetMidi(nextTarget);
    replaceCredit(createRangeLoopCredit({
      targetMidi: nextTarget,
      toleranceCents: creditSession.getCurrent().toleranceCents,
      acceptingCredit,
    }));
    setSelectedMidi(nextTarget);
    setCentsOffset(0);
  }, [creditSession.getCurrent, replaceCredit, setCentsOffset, setSelectedMidi]);

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
        new Date().toISOString(),
      );
      setProfile(next.profile);
      setProgress(next.progress);
      setActiveFamilyId(next.activeFamilyId);
      setNoteSet(next.noteSet);
      setOrder(next.order);
      setTargetMidi(next.targetMidi);
      setSelectedMidi(next.targetMidi);
      setCentsOffset(0);
      replaceCredit(createRangeLoopCredit({
        targetMidi: next.targetMidi,
        toleranceCents: preferenceToleranceRef.current,
        acceptingCredit: next.targetAcceptsCredit,
      }));
      setStorageReady(loopRead && profileRead);
      setPersistenceState(loopRead && profileRead ? "saved" : "error");
      setHydrated(true);
      clearRangeLoopHandoff();
    });
    return () => persistence.dispose();
  }, [persistence, replaceCredit, setCentsOffset, setSelectedMidi]);

  useEffect(() => {
    if (!hydrated || !storageReady) return;
    const snapshot: StoredRangeLoopState = {
      scoringVersion: RANGE_LOOP_SCORING_VERSION,
      activeFamilyId,
      noteSet,
      order,
      targetMidi,
      progress,
    };
    persistence.save([
      { key: STORAGE_KEY, value: snapshot },
      { key: VOCAL_PROFILE_STORAGE_KEY, value: profile },
    ], setPersistenceState);
  }, [
    activeFamilyId,
    hydrated,
    noteSet,
    order,
    persistence,
    profile,
    progress,
    storageReady,
    targetMidi,
  ]);

  const sequence = useMemo(
    () => profileOrderedTargets(noteSet, activeFamilyId, order, profile.baseline.midi),
    [activeFamilyId, noteSet, order, profile.baseline.midi],
  );
  const passedMidis = useMemo(
    () => new Set(progress[noteSet][activeFamilyId].passedMidis),
    [activeFamilyId, noteSet, progress],
  );
  const parkedMidis = useMemo(
    () => new Set(progress[noteSet][activeFamilyId].parkedMidis),
    [activeFamilyId, noteSet, progress],
  );
  const nextChoice = useMemo(() => (
    credit.acceptingCredit
      ? advanceRangeLoopTarget(
        progress,
        activeFamilyId,
        noteSet,
        order,
        profile.baseline.midi,
        targetMidi,
        "passed",
      )
      : null
  ), [activeFamilyId, credit.acceptingCredit, noteSet, order, profile.baseline.midi, progress, targetMidi]);
  const family = getRangeFamily(activeFamilyId);
  const profileBounds = usableRangeBounds(profile);
  const achievementReached = credit.achievementReached;
  const holding = input.state === "running"
    && credit.acceptingCredit
    && credit.currentInTolerance === true;

  const applyDecision = (outcome: "passed" | "outside-range") => {
    const next = advanceRangeLoopTarget(
      progress,
      activeFamilyId,
      noteSet,
      order,
      profile.baseline.midi,
      targetMidi,
      outcome,
    );
    setProgress(next.progress);
    setActiveFamilyId(next.familyId);
    prepareTarget(next.targetMidi, next.acceptingCredit);
  };

  const changeFamily = (nextFamily: RangeFamilyId) => {
    const choice = chooseRangeLoopTarget(
      progress,
      nextFamily,
      noteSet,
      order,
      profile.baseline.midi,
    );
    setActiveFamilyId(nextFamily);
    prepareTarget(choice.targetMidi, choice.acceptingCredit);
  };

  const changeNoteSet = (nextSet: FamilyNoteSet) => {
    const choice = chooseRangeLoopTarget(
      progress,
      activeFamilyId,
      nextSet,
      order,
      profile.baseline.midi,
    );
    setNoteSet(nextSet);
    prepareTarget(choice.targetMidi, choice.acceptingCredit);
  };

  const changeOrder = (nextOrder: RangeLoopOrder) => {
    const choice = chooseRangeLoopTarget(
      progress,
      activeFamilyId,
      noteSet,
      nextOrder,
      profile.baseline.midi,
    );
    setOrder(nextOrder);
    prepareTarget(choice.targetMidi, choice.acceptingCredit);
  };

  const recheckExcludedNotes = () => {
    if (parkedMidiCount(progress) === 0) return;
    const nextProgress = recheckAllParkedMidis(progress);
    setProgress(nextProgress);
    if (!creditSession.getCurrent().acceptingCredit) {
      const choice = chooseRangeLoopTarget(
        nextProgress,
        activeFamilyId,
        noteSet,
        order,
        profile.baseline.midi,
      );
      prepareTarget(choice.targetMidi, choice.acceptingCredit);
    }
  };

  return {
    input,
    family,
    noteSet,
    order,
    phase: liveSession.state.phase,
    toleranceCents: activeToleranceCents,
    targetMidi,
    sequence,
    passedMidis,
    parkedMidis,
    followingMidi: nextChoice?.targetMidi ?? targetMidi,
    earnedCount: passedMidis.size + Number(achievementReached && !passedMidis.has(targetMidi)),
    credit,
    practicePoints: Math.floor(credit.creditedSeconds * 1_000 + 1e-6),
    achievementReached,
    acceptingCredit: credit.acceptingCredit,
    holding,
    excludedNoteCount: parkedMidiCount(progress),
    hydrated,
    persistenceState,
    profileBaselineMidi: profile.baseline.midi,
    profileLowMidi: profileBounds.lowMidi,
    profileHighMidi: profileBounds.highMidi,
    referencePlayback,
    start: () => liveSession.dispatch({ type: "start" }),
    finish: () => {
      creditSession.flushPresentation();
      liveSession.dispatch({ type: "finish" });
    },
    advanceTarget: () => {
      if (creditSession.getCurrent().achievementReached) applyDecision("passed");
    },
    markCurrentOutsideRange: () => {
      const currentCredit = creditSession.getCurrent();
      if (
        liveSession.getCurrent().phase === "tracking"
        && currentCredit.acceptingCredit
        && !currentCredit.achievementReached
      ) {
        applyDecision("outside-range");
      }
    },
    recheckExcludedNotes,
    changeFamily,
    changeNoteSet,
    changeOrder,
    changeTolerance: (nextTolerance) => {
      setToleranceCents(nextTolerance);
      creditSession.dispatch({
        type: "reconfigure-tolerance",
        toleranceCents: nextTolerance,
      });
    },
  };
}
