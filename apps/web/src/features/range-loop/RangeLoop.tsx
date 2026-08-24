import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { type YinPitchFrame } from "@noteforge/pitch-engine";
import { scoreSustainedNote, type AttemptMetrics } from "@noteforge/trainer-core";
import { useAudioInput } from "@/audio/use-audio-input";
import { playTone, type ActiveVoice } from "@/audio/synth";
import { continuousMidiToHz, noteLabel, signed } from "@/lib/music-display";
import { useLab } from "@/state/LabContext";
import { getSetting, saveAttempt, setSettings } from "@/storage/database";
import { ActionButton, Eyebrow, Panel, PlayButton, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { WorkflowDialog, type WorkflowStep } from "@/ui/workflow";
import { PitchRibbon } from "@/features/pitch-mirror/PitchRibbon";
import {
  RANGE_FAMILIES,
  appendBoundedFrame,
  createSupportPlan,
  createSustainTracker,
  rangeFamilyForMidi,
  targetsForFamily,
  updateSustainTracker,
  type FamilyNoteSet,
  type RangeFamilyId,
  type SupportMode,
  type SustainTrackerState,
  type TargetOrder,
} from "./model";
import {
  availableTargets,
  buildProfileFamilyQueue,
  emptyLoopProgress,
  firstPendingTarget,
  nextProfileFamily,
  normalizeProgress,
  parkMidiAcrossNoteSets,
  profileFamilyOrder,
  recheckMidisAcrossNoteSets,
  restoreMidiAsPending,
  type LoopProgress,
} from "./progress";
import {
  DEFAULT_BASELINE_MIDI,
  RANGE_PROFILE_MAX_MIDI,
  RANGE_PROFILE_MIN_MIDI,
  VOCAL_PROFILE_STORAGE_KEY,
  cleanStableBounds,
  createDefaultRangeProfile,
  manualAccuracyEdges,
  normalizeRangeProfile,
  pitchStableBounds,
  recordRangeEvidence,
  setRangeProfileBaseline,
  suggestedAccuracyEdges,
  toggleProfileObservation,
  toggleRegisterShift,
  type AccuracyEdges,
  type PersonalRangeProfile,
  type ProfileObservationKind,
  type RangeBounds,
  type ShiftDirection,
} from "./profile";
import { clearRangeLoopHandoff, consumeRangeLoopHandoff } from "./handoff";
import { gradeRangeAttempt, type RangeAttemptGrade } from "./grade";
import { pitchDiagnostics } from "@/diagnostics/pitch-diagnostics";

type LoopPhase = "idle" | "connecting" | "prompting" | "guide-check" | "guide-leak" | "listening" | "success" | "transition";

interface StoredRangeLoopState {
  activeFamilyId?: RangeFamilyId;
  noteSet?: FamilyNoteSet;
  order?: TargetOrder;
  supportMode?: SupportMode;
  holdSeconds?: number;
  progress?: unknown;
}

interface LastResult {
  midi: number;
  note: string;
  medianErrorCents?: number;
  stabilityCents?: number;
  timeToAcquireMs: number;
  resetCount: number;
  grade: RangeAttemptGrade;
  familyId: RangeFamilyId;
}

interface SessionStats {
  notes: number;
  families: number;
  resets: number;
}

type PersistenceState = "loading" | "saving" | "saved" | "error";

const STORAGE_KEY = "hum.range-loop";
const RETAINED_ATTEMPT_FRAMES = 720;
const MINIMUM_CONFIDENCE = 0.58;
const GUIDE_SETTLE_MS = 420;
const GUIDE_LEAK_SETTLE_MS = 240;
const GUIDE_LEAK_CHECK_MS = 1_150;
const GUIDE_LEAK_TOLERANCE_CENTS = 35;
const GUIDE_LEAK_REQUIRED_CONSECUTIVE_FRAMES = 4;
const TARGET_PROMPT_MS = 1_080;
const PROFILE_MIDIS = Array.from(
  { length: RANGE_PROFILE_MAX_MIDI - RANGE_PROFILE_MIN_MIDI + 1 },
  (_, index) => RANGE_PROFILE_MIN_MIDI + index,
);
const RANGE_LOOP_WORKFLOW_STEPS = [
  { id: "hear", label: "Hear" },
  { id: "find", label: "Find" },
  { id: "hold", label: "Hold" },
  { id: "grade", label: "Grade" },
  { id: "next", label: "Next" },
] as const satisfies readonly WorkflowStep[];

const SUPPORT_OPTIONS: Readonly<Record<SupportMode, { label: string; relation: string; detail: string }>> = {
  solo: {
    label: "Prompt, then solo",
    relation: "solo target",
    detail: "The target sounds once, then the room goes quiet while you reproduce it.",
  },
  unison: {
    label: "Match a sustained guide",
    relation: "unison · same note",
    detail: "The target keeps sounding while you match it. Headphones are required so the guide cannot score itself.",
  },
  "major-third": {
    label: "Sing a major 3rd",
    relation: "major 3rd above guide",
    detail: "The lower guide keeps sounding while your measured target forms a major third.",
  },
  "perfect-fifth": {
    label: "Sing a perfect 5th",
    relation: "perfect 5th above guide",
    detail: "The lower guide keeps sounding while your measured target forms a perfect fifth.",
  },
  octave: {
    label: "Sing the octave",
    relation: "octave above guide",
    detail: "The lower guide keeps sounding while your measured target sits one octave above it.",
  },
};

const HOLD_OPTIONS = [1.5, 2, 3, 5, 8] as const;

function isFamilyId(value: unknown): value is RangeFamilyId {
  return RANGE_FAMILIES.some((family) => family.id === value);
}

function isNoteSet(value: unknown): value is FamilyNoteSet {
  return value === "natural" || value === "chromatic";
}

function isTargetOrder(value: unknown): value is TargetOrder {
  return value === "ascending" || value === "descending" || value === "shuffled";
}

function isSupportMode(value: unknown): value is SupportMode {
  return value === "solo" || value === "unison" || value === "major-third" || value === "perfect-fifth" || value === "octave";
}

function numericMetrics(
  metrics: AttemptMetrics,
  extras: Record<string, number>,
): Record<string, number | undefined> {
  return {
    ...extras,
    attackErrorCents: metrics.attackErrorCents,
    medianErrorCents: metrics.medianErrorCents,
    meanAbsoluteErrorCents: metrics.meanAbsoluteErrorCents,
    stabilityCents: metrics.stabilityCents,
    vibratoAdjustedStabilityCents: metrics.vibratoAdjustedStabilityCents,
    driftCentsPerSecond: metrics.driftCentsPerSecond,
    inToleranceRatio: metrics.inToleranceRatio,
    detectorConfidence: metrics.detectorConfidence,
    voicedFrameCount: metrics.voicedFrameCount,
    analyzedFrameCount: metrics.analyzedFrameCount,
    totalFrameCount: metrics.totalFrameCount,
  };
}

function phaseLabel(phase: LoopPhase, running: boolean): string {
  if (!running && phase === "idle") return "READY WHEN YOU ARE";
  if (phase === "connecting") return "CONNECTING MICROPHONE";
  if (phase === "guide-check") return "CHECKING HEADPHONE ISOLATION";
  if (phase === "guide-leak") return "GUIDE LEAK NEEDS ATTENTION";
  if (phase === "prompting") return "HEAR THE TARGET";
  if (phase === "success") return "NOTE HELD · REVIEW GRADE";
  if (phase === "transition") return "RELEASE · MOVING ON";
  return "LISTENING UNTIL IT HOLDS";
}

function tunerGuidance(
  phase: LoopPhase,
  voiced: boolean,
  errorCents: number | null,
  toleranceCents: number,
): { title: string; detail: string; tone: "waiting" | "flat" | "sharp" | "locked" | "success" } {
  if (phase === "success") return { title: "Note earned", detail: "Release, breathe, and read your grade before the next target.", tone: "success" };
  if (phase === "guide-check") return { title: "Stay quiet for the isolation check", detail: "NoteForge is verifying that the guide is not entering the microphone.", tone: "waiting" };
  if (phase === "guide-leak") return { title: "Guide heard by the microphone", detail: "Move playback fully into headphones before retrying.", tone: "waiting" };
  if (phase === "prompting") return { title: "Listen first", detail: "The reference tone never counts toward your hold.", tone: "waiting" };
  if (phase === "transition") return { title: "Preparing the next note", detail: "Release your voice so the next reference can begin cleanly.", tone: "waiting" };
  if (!voiced || errorCents === null) return { title: "Waiting for your voice", detail: "Hum or sing the target; the tuner will show exactly where you land.", tone: "waiting" };
  if (Math.abs(errorCents) <= toleranceCents) return { title: "Locked · keep it steady", detail: "Stay inside the bright target lane until the hold meter fills.", tone: "locked" };
  if (errorCents < 0) return { title: "You’re flat · glide upward", detail: `${Math.abs(errorCents).toFixed(0)} cents below the target.`, tone: "flat" };
  return { title: "You’re sharp · ease downward", detail: `${Math.abs(errorCents).toFixed(0)} cents above the target.`, tone: "sharp" };
}

function gradeCoaching(result: Readonly<LastResult>, toleranceCents: number): string {
  const center = result.medianErrorCents;
  const stability = result.stabilityCents;
  if (center !== undefined && Math.abs(center) > toleranceCents * 0.55) {
    return center < 0
      ? "You completed the hold, but its center leaned flat. Approach the next note from slightly above."
      : "You completed the hold, but its center leaned sharp. Let the next note settle downward sooner.";
  }
  if (stability !== undefined && stability > toleranceCents * 0.48) {
    return "Your center was usable, with noticeable movement around it. Aim for less correction once the tuner locks.";
  }
  if (result.resetCount > 1) return "The final hold was steady. The next gain is finding that center with fewer restarts.";
  return "The pitch centered quickly and stayed controlled through the required hold.";
}

function formatBounds(bounds: RangeBounds): string {
  if (bounds.lowMidi === null || bounds.highMidi === null) return "Not mapped yet";
  if (bounds.lowMidi === bounds.highMidi) return noteLabel(bounds.lowMidi);
  return `${noteLabel(bounds.lowMidi)} → ${noteLabel(bounds.highMidi)}`;
}

function formatAccuracyEdges(edges: AccuracyEdges): string {
  if (edges.lowMidi === null && edges.highMidi === null) return "Not marked yet";
  return `${edges.lowMidi === null ? "—" : noteLabel(edges.lowMidi)} / ${edges.highMidi === null ? "—" : noteLabel(edges.highMidi)}`;
}

export function RangeLoop() {
  const {
    selectedMidi,
    setSelectedMidi,
    setCentsOffset,
    timbre,
    setTimbre,
    toleranceCents,
    setToleranceCents,
  } = useLab();
  const [phase, setPhase] = useState<LoopPhase>("idle");
  const [sessionRunning, setSessionRunning] = useState(false);
  const sessionModalOpen = sessionRunning || phase === "connecting";
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [advanceAvailable, setAdvanceAvailable] = useState(false);
  const [releaseConfirmed, setReleaseConfirmed] = useState(false);
  const [guideLeakMatchFrames, setGuideLeakMatchFrames] = useState(0);
  const [status, setStatus] = useState("READY · PRESS START");
  const [noteSet, setNoteSet] = useState<FamilyNoteSet>("natural");
  const [order, setOrder] = useState<TargetOrder>("ascending");
  const [supportMode, setSupportMode] = useState<SupportMode>("unison");
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false);
  const [holdSeconds, setHoldSeconds] = useState<number>(3);
  const [sessionToleranceCents, setSessionToleranceCents] = useState(toleranceCents);
  const [activeFamilyId, setActiveFamilyId] = useState<RangeFamilyId>("low");
  const [progress, setProgress] = useState<LoopProgress>(emptyLoopProgress);
  const [targetMidi, setTargetMidi] = useState(DEFAULT_BASELINE_MIDI);
  const [trackerView, setTrackerView] = useState<SustainTrackerState | null>(null);
  const [resetCount, setResetCount] = useState(0);
  const [sessionStats, setSessionStats] = useState<SessionStats>({ notes: 0, families: 0, resets: 0 });
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [profile, setProfile] = useState<PersonalRangeProfile>(createDefaultRangeProfile);
  const [profileNotice, setProfileNotice] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [loopStorageReady, setLoopStorageReady] = useState(false);
  const [profileStorageReady, setProfileStorageReady] = useState(false);
  const [persistenceState, setPersistenceState] = useState<PersistenceState>("loading");

  const onFrameRef = useRef<(frame: YinPitchFrame) => void>(() => undefined);
  const completeTargetRef = useRef<(tracker: SustainTrackerState) => void>(() => undefined);
  const cueTargetRef = useRef<(target: number, sessionToken: number) => void>(() => undefined);
  const stopLoopRef = useRef<(message?: string) => void>(() => undefined);
  const runningRef = useRef(false);
  const connectingRef = useRef(false);
  const sessionTokenRef = useRef(0);
  const audioGenerationRef = useRef(0);
  const currentTargetRef = useRef(targetMidi);
  const activeFamilyRef = useRef(activeFamilyId);
  const progressRef = useRef(progress);
  const profileRef = useRef(profile);
  const noteSetRef = useRef(noteSet);
  const orderRef = useRef(order);
  const supportModeRef = useRef(supportMode);
  const holdSecondsRef = useRef(holdSeconds);
  const sessionToleranceRef = useRef(toleranceCents);
  const timbreRef = useRef(timbre);
  const attemptActiveRef = useRef(false);
  const successLockedRef = useRef(false);
  const trackerRef = useRef<SustainTrackerState | null>(null);
  const attemptFramesRef = useRef<YinPitchFrame[]>([]);
  const attemptStartedAtRef = useRef("");
  const attemptFirstFrameTimeRef = useRef<number | null>(null);
  const resetCountRef = useRef(0);
  const carriedResetCountRef = useRef(0);
  const familyQueueRef = useRef<number[]>([]);
  const timersRef = useRef<number[]>([]);
  const cueVoiceRef = useRef<ActiveVoice | null>(null);
  const guideVoiceRef = useRef<ActiveVoice | null>(null);
  const guideIsolationVerifiedRef = useRef(false);
  const guideLeakCheckRef = useRef({
    active: false,
    guideMidi: DEFAULT_BASELINE_MIDI,
    startedAtMs: 0,
    consecutiveMatches: 0,
    maximumConsecutiveMatches: 0,
    totalMatches: 0,
  });
  const profileRulerWrapRef = useRef<HTMLDivElement | null>(null);
  const releaseWaitingRef = useRef(false);
  const releaseQuietSinceRef = useRef<number | null>(null);
  const releaseEarliestAtRef = useRef(0);
  const pendingAdvanceRef = useRef<(() => void) | null>(null);
  const advanceReadyRef = useRef(true);
  const persistenceChainRef = useRef<Promise<void>>(Promise.resolve());
  const persistenceWriteIdRef = useRef(0);
  const persistenceMountedRef = useRef(true);
  const reviewSummaryRef = useRef<HTMLElement | null>(null);
  const reviewFocusFrameRef = useRef<number | null>(null);
  const beginConnectedSessionRef = useRef<(sessionToken: number) => void>(() => undefined);

  const input = useAudioInput({
    diagnostics: {
      flow: "range-loop",
      phase,
      targetMidi,
      toleranceCents: sessionRunning ? sessionToleranceCents : toleranceCents,
      stableMs: (trackerView?.heldSeconds ?? 0) * 1_000,
      requiredHoldMs: holdSeconds * 1_000,
      resetReason: trackerView?.inGrace ? "hold-preserved-unvoiced" : null,
    },
    onFrame: (frame) => onFrameRef.current(frame),
  });
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    pitchDiagnostics.record("range-loop", {
      kind: "workflow",
      workflow: {
        phase,
        state: sessionRunning ? "running" : phase === "connecting" ? "connecting" : "idle",
        targetMidi,
        holdMs: (trackerView?.heldSeconds ?? 0) * 1_000,
        requiredHoldMs: holdSeconds * 1_000,
        resetReason: trackerView?.inGrace ? "detector-evidence-grace" : null,
      },
    });
  }, [holdSeconds, phase, sessionRunning, targetMidi, trackerView?.inGrace]);

  progressRef.current = progress;
  profileRef.current = profile;
  activeFamilyRef.current = activeFamilyId;
  noteSetRef.current = noteSet;
  orderRef.current = order;
  supportModeRef.current = supportMode;
  holdSecondsRef.current = holdSeconds;
  timbreRef.current = timbre;
  currentTargetRef.current = targetMidi;

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(window.clearTimeout);
    timersRef.current = [];
    if (reviewFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(reviewFocusFrameRef.current);
      reviewFocusFrameRef.current = null;
    }
  }, []);

  const schedule = useCallback((callback: () => void, delayMs: number) => {
    timersRef.current.push(window.setTimeout(callback, delayMs));
  }, []);

  const stopAudio = useCallback(() => {
    audioGenerationRef.current += 1;
    guideLeakCheckRef.current.active = false;
    cueVoiceRef.current?.stop(0.04);
    guideVoiceRef.current?.stop(0.08);
    cueVoiceRef.current = null;
    guideVoiceRef.current = null;
  }, []);

  const triggerPendingAdvance = useCallback(() => {
    if (!releaseWaitingRef.current || !advanceReadyRef.current) return;
    releaseWaitingRef.current = false;
    setAdvanceAvailable(false);
    releaseQuietSinceRef.current = null;
    const pending = pendingAdvanceRef.current;
    pendingAdvanceRef.current = null;
    pending?.();
  }, []);

  const waitForRelease = useCallback((callback: () => void, completedAtSeconds: number, confirmNext = false) => {
    pendingAdvanceRef.current = callback;
    releaseWaitingRef.current = true;
    advanceReadyRef.current = !confirmNext;
    setAdvanceAvailable(false);
    setReleaseConfirmed(false);
    releaseQuietSinceRef.current = null;
    releaseEarliestAtRef.current = completedAtSeconds + 0.55;
  }, []);

  const startGuide = useCallback(async (guideMidi: number, sessionToken: number): Promise<boolean> => {
    const audioGeneration = ++audioGenerationRef.current;
    let voice: ActiveVoice;
    try {
      voice = await playTone({
        frequencyHz: continuousMidiToHz(guideMidi),
        timbre: "sine",
        duration: 3_600,
        amplitude: 0.085,
        attack: 0.08,
        release: 0.12,
      });
    } catch {
      if (
        audioGeneration === audioGenerationRef.current
        && sessionToken === sessionTokenRef.current
        && runningRef.current
      ) {
        stopLoopRef.current("GUIDE AUDIO COULD NOT START · SESSION STOPPED");
      }
      return false;
    }
    if (
      audioGeneration !== audioGenerationRef.current
      || sessionToken !== sessionTokenRef.current
      || !runningRef.current
    ) {
      voice.stop(0.02);
      return false;
    }
    guideVoiceRef.current?.stop(0.04);
    guideVoiceRef.current = voice;
    return true;
  }, []);

  const beginListening = useCallback((sessionToken: number) => {
    if (sessionToken !== sessionTokenRef.current || !runningRef.current) return;
    attemptFramesRef.current = [];
    attemptFirstFrameTimeRef.current = null;
    trackerRef.current = null;
    resetCountRef.current = carriedResetCountRef.current;
    successLockedRef.current = false;
    attemptActiveRef.current = true;
    attemptStartedAtRef.current = new Date().toISOString();
    setResetCount(carriedResetCountRef.current);
    setTrackerView(null);
    setPhase("listening");
    setStatus(supportModeRef.current === "solo" ? "YOUR TURN · HOLD THE TARGET" : "GUIDE ON · SING YOUR TARGET");
  }, []);

  const beginGuideIsolationCheck = useCallback((guideMidi: number, sessionToken: number) => {
    if (sessionToken !== sessionTokenRef.current || !runningRef.current) return;
    guideLeakCheckRef.current = {
      active: true,
      guideMidi,
      startedAtMs: performance.now(),
      consecutiveMatches: 0,
      maximumConsecutiveMatches: 0,
      totalMatches: 0,
    };
    setGuideLeakMatchFrames(0);
    setPhase("guide-check");
    setStatus("HEADPHONE CHECK · STAY SILENT WHILE THE GUIDE PLAYS");
    schedule(() => {
      const check = guideLeakCheckRef.current;
      if (!check.active || sessionToken !== sessionTokenRef.current || !runningRef.current) return;
      check.active = false;
      const leaked = check.maximumConsecutiveMatches >= GUIDE_LEAK_REQUIRED_CONSECUTIVE_FRAMES;
      if (leaked) {
        stopAudio();
        setPhase("guide-leak");
        setStatus("GUIDE REACHED THE MICROPHONE · SCORING REMAINS LOCKED");
        return;
      }
      guideIsolationVerifiedRef.current = true;
      setStatus("HEADPHONE ISOLATION PASSED · YOUR TURN");
      beginListening(sessionToken);
    }, GUIDE_LEAK_CHECK_MS);
  }, [beginListening, schedule, stopAudio]);

  const cueTarget = useCallback((nextTarget: number, sessionToken: number) => {
    if (sessionToken !== sessionTokenRef.current || !runningRef.current) return;
    clearTimers();
    stopAudio();
    attemptActiveRef.current = false;
    releaseWaitingRef.current = false;
    advanceReadyRef.current = true;
    setAdvanceAvailable(false);
    setReleaseConfirmed(false);
    releaseQuietSinceRef.current = null;
    pendingAdvanceRef.current = null;
    trackerRef.current = null;
    attemptFramesRef.current = [];
    successLockedRef.current = false;
    if (nextTarget !== currentTargetRef.current) carriedResetCountRef.current = 0;
    currentTargetRef.current = nextTarget;
    setTargetMidi(nextTarget);
    setSelectedMidi(nextTarget);
    setCentsOffset(0);
    setTrackerView(null);
    setResetCount(carriedResetCountRef.current);
    setPhase("prompting");
    setStatus("LISTEN · THIS IS YOUR TARGET");

    const audioGeneration = ++audioGenerationRef.current;
    void playTone({
      frequencyHz: continuousMidiToHz(nextTarget),
      timbre: timbreRef.current,
      duration: 0.9,
      amplitude: 0.21,
      release: 0.08,
    }).then((voice) => {
      if (
        audioGeneration !== audioGenerationRef.current
        || sessionToken !== sessionTokenRef.current
        || !runningRef.current
      ) {
        voice.stop(0.02);
        return;
      }
      cueVoiceRef.current = voice;
      schedule(() => {
        if (sessionToken !== sessionTokenRef.current || !runningRef.current) return;
        cueVoiceRef.current?.stop(0.03);
        cueVoiceRef.current = null;
        const support = createSupportPlan(nextTarget, supportModeRef.current);
        if (support.guideMidi === null) {
          beginListening(sessionToken);
          return;
        }
        setStatus(`GUIDE ${noteLabel(support.guideMidi)} · FIND ${noteLabel(nextTarget)}`);
        void startGuide(support.guideMidi, sessionToken).then((started) => {
          if (!started) return;
          if (!guideIsolationVerifiedRef.current) {
            beginGuideIsolationCheck(support.guideMidi!, sessionToken);
            return;
          }
          schedule(() => beginListening(sessionToken), GUIDE_SETTLE_MS);
        });
      }, TARGET_PROMPT_MS);
    }).catch(() => {
      if (
        audioGeneration === audioGenerationRef.current
        && sessionToken === sessionTokenRef.current
        && runningRef.current
      ) {
        stopLoopRef.current("TARGET AUDIO COULD NOT START · SESSION STOPPED");
      }
    });
  }, [beginGuideIsolationCheck, beginListening, clearTimers, schedule, setCentsOffset, setSelectedMidi, startGuide, stopAudio]);

  cueTargetRef.current = cueTarget;

  const queueForFamily = useCallback((familyId: RangeFamilyId): number[] => {
    return buildProfileFamilyQueue(
      progressRef.current,
      noteSetRef.current,
      familyId,
      orderRef.current,
      profileRef.current.baseline.midi,
    );
  }, []);

  const stopLoop = useCallback((message = "STOPPED · SESSION ENDED") => {
    const wasRunning = runningRef.current;
    sessionTokenRef.current += 1;
    runningRef.current = false;
    connectingRef.current = false;
    guideIsolationVerifiedRef.current = false;
    guideLeakCheckRef.current.active = false;
    setGuideLeakMatchFrames(0);
    attemptActiveRef.current = false;
    successLockedRef.current = false;
    releaseWaitingRef.current = false;
    advanceReadyRef.current = true;
    setAdvanceAvailable(false);
    setReleaseConfirmed(false);
    releaseQuietSinceRef.current = null;
    pendingAdvanceRef.current = null;
    clearTimers();
    stopAudio();
    familyQueueRef.current = [];
    carriedResetCountRef.current = 0;
    trackerRef.current = null;
    setTrackerView(null);
    setSessionRunning(false);
    setPhase("idle");
    setStatus(message);
    if (wasRunning) {
      setDetailsOpen(true);
      reviewFocusFrameRef.current = window.requestAnimationFrame(() => {
        reviewFocusFrameRef.current = null;
        reviewSummaryRef.current?.focus();
      });
    }
  }, [clearTimers, stopAudio]);

  stopLoopRef.current = stopLoop;
  const exitWorkflow = useCallback(() => {
    stopLoop(connectingRef.current ? "MICROPHONE CONNECTION CANCELLED" : undefined);
  }, [stopLoop]);

  const completeTarget = useCallback((completedTracker: SustainTrackerState) => {
    if (!runningRef.current) return;
    const sessionToken = sessionTokenRef.current;
    const completedTarget = currentTargetRef.current;
    attemptActiveRef.current = false;
    stopAudio();
    setTrackerView(completedTracker);
    setPhase("success");
    setStatus(`${noteLabel(completedTarget)} HELD · RELEASE AND BREATHE`);

    const winningFrames = completedTracker.runStartedAtSeconds === null
      ? attemptFramesRef.current
      : attemptFramesRef.current.filter((frame) => frame.timeSeconds >= completedTracker.runStartedAtSeconds!);
    const metrics = scoreSustainedNote(
      winningFrames,
      {
        midi: completedTarget,
        centsOffset: 0,
        durationMs: holdSecondsRef.current * 1_000,
        timbre: timbreRef.current,
        amplitude: 0.21,
      },
      {
        toleranceCents: sessionToleranceRef.current,
        minimumConfidence: MINIMUM_CONFIDENCE,
        promptTimeSeconds: winningFrames[0]?.timeSeconds,
        maximumVoicedGapSeconds: 0.22,
      },
    );
    const firstFrameTime = attemptFirstFrameTimeRef.current ?? completedTracker.runStartedAtSeconds ?? completedTracker.lastProcessedTimeSeconds ?? 0;
    const completedFrameTime = completedTracker.lastProcessedTimeSeconds ?? firstFrameTime;
    const acquiredFrameTime = completedTracker.runStartedAtSeconds ?? completedFrameTime;
    const timeToAcquireMs = Math.max(0, (acquiredFrameTime - firstFrameTime) * 1_000);
    const timeToSuccessMs = Math.max(0, (completedFrameTime - firstFrameTime) * 1_000);
    const completedAt = new Date();
    const support = createSupportPlan(completedTarget, supportModeRef.current);
    const targetResetCount = resetCountRef.current;
    const stabilityCents = metrics.vibratoAdjustedStabilityCents ?? metrics.stabilityCents;
    const grade = gradeRangeAttempt({
      medianErrorCents: metrics.medianErrorCents,
      stabilityCents,
      timeToAcquireMs,
      resetCount: targetResetCount,
      toleranceCents: sessionToleranceRef.current,
      requiredHoldMs: holdSecondsRef.current * 1_000,
    });
    setLastResult({
      midi: completedTarget,
      note: noteLabel(completedTarget),
      medianErrorCents: metrics.medianErrorCents,
      stabilityCents,
      timeToAcquireMs,
      resetCount: targetResetCount,
      grade,
      familyId: activeFamilyRef.current,
    });
    const nextProfile = recordRangeEvidence(profileRef.current, {
      midi: completedTarget,
      supportMode: supportModeRef.current,
      toleranceCents: sessionToleranceRef.current,
      requiredHoldMs: holdSecondsRef.current * 1_000,
      resetCount: targetResetCount,
      timeToAcquireMs,
      medianErrorCents: metrics.medianErrorCents,
      stabilityCents: metrics.vibratoAdjustedStabilityCents ?? metrics.stabilityCents,
      observedAt: completedAt.toISOString(),
    });
    profileRef.current = nextProfile;
    setProfile(nextProfile);
    setSessionStats((current) => ({ ...current, notes: current.notes + 1 }));

    void saveAttempt({
      id: crypto.randomUUID(),
      exerciseType: "hum.range_loop.sustain",
      target: {
        familyId: activeFamilyRef.current,
        midi: completedTarget,
        requiredHoldMs: holdSecondsRef.current * 1_000,
        noteSet: noteSetRef.current,
        order: orderRef.current,
        supportMode: supportModeRef.current,
        guideMidi: support.guideMidi,
        guideIntervalSemitones: support.intervalSemitones,
        profileBaselineMidi: profileRef.current.baseline.midi,
      },
      metrics: numericMetrics(metrics, {
        success: 1,
        requiredHoldMs: holdSecondsRef.current * 1_000,
        qualifiedHoldMs: completedTracker.heldSeconds * 1_000,
        timeToAcquireMs,
        timeToSuccessMs,
        resetCount: targetResetCount,
      }),
      pitchFrames: winningFrames,
      startedAt: attemptStartedAtRef.current || new Date(completedAt.getTime() - timeToSuccessMs).toISOString(),
      completedAt: completedAt.toISOString(),
    }).catch(() => {
      if (persistenceMountedRef.current) {
        setProfileNotice("The completed attempt could not be added to local history. Its current range-map updates remain visible in this page.");
      }
    });

    const familyId = activeFamilyRef.current;
    const currentRecord = progressRef.current[noteSetRef.current][familyId];
    const passedMidis = [...new Set([...currentRecord.passedMidis, completedTarget])];
    const remainingQueue = familyQueueRef.current.filter((midi) => midi !== completedTarget);

    if (remainingQueue.length > 0) {
      const nextProgress: LoopProgress = {
        ...progressRef.current,
        [noteSetRef.current]: {
          ...progressRef.current[noteSetRef.current],
          [familyId]: { ...currentRecord, passedMidis },
        },
      };
      progressRef.current = nextProgress;
      setProgress(nextProgress);
      familyQueueRef.current = remainingQueue;
      waitForRelease(
        () => cueTargetRef.current(remainingQueue[0]!, sessionToken),
        completedFrameTime,
        true,
      );
      return;
    }

    const nextProgress: LoopProgress = {
      ...progressRef.current,
      [noteSetRef.current]: {
        ...progressRef.current[noteSetRef.current],
        [familyId]: {
          passedMidis: [],
          parkedMidis: currentRecord.parkedMidis,
          cyclesCompleted: currentRecord.cyclesCompleted + 1,
        },
      },
    };
    progressRef.current = nextProgress;
    setProgress(nextProgress);
    setSessionStats((current) => ({ ...current, families: current.families + 1 }));

    const familyAdvance = nextProfileFamily(familyId, nextProgress, noteSetRef.current, orderRef.current, profileRef.current.baseline.midi);
    if (!familyAdvance) {
      stopLoopRef.current("EVERY NOTE IS OUTSIDE THE CURRENT RANGE · RECHECK A FAMILY TO CONTINUE");
      return;
    }
    const nextFamilyId = familyAdvance.familyId;
    activeFamilyRef.current = nextFamilyId;
    setActiveFamilyId(nextFamilyId);
    familyQueueRef.current = buildProfileFamilyQueue(nextProgress, noteSetRef.current, nextFamilyId, orderRef.current, profileRef.current.baseline.midi);
    setStatus(familyAdvance.wrapped ? "FAMILY ROUTE WRAPPED · RETURNING TO HOME REGISTER" : `${noteLabel(completedTarget)} CLOSED THE FAMILY · MOVING ON`);
    waitForRelease(
      () => cueTargetRef.current(familyQueueRef.current[0]!, sessionToken),
      completedFrameTime,
      true,
    );
  }, [stopAudio, waitForRelease]);

  completeTargetRef.current = completeTarget;

  onFrameRef.current = (frame) => {
    const guideCheck = guideLeakCheckRef.current;
    if (guideCheck.active) {
      const settled = performance.now() - guideCheck.startedAtMs >= GUIDE_LEAK_SETTLE_MS;
      const matchesGuide = settled
        && frame.voiced
        && frame.midiFloat !== null
        && Number.isFinite(frame.midiFloat)
        && frame.confidence >= MINIMUM_CONFIDENCE
        && Math.abs((frame.midiFloat - guideCheck.guideMidi) * 100) <= GUIDE_LEAK_TOLERANCE_CENTS;
      if (matchesGuide) {
        guideCheck.consecutiveMatches += 1;
        guideCheck.totalMatches += 1;
        guideCheck.maximumConsecutiveMatches = Math.max(
          guideCheck.maximumConsecutiveMatches,
          guideCheck.consecutiveMatches,
        );
        setGuideLeakMatchFrames(guideCheck.totalMatches);
      } else if (settled) {
        guideCheck.consecutiveMatches = 0;
      }
      return;
    }
    if (releaseWaitingRef.current && runningRef.current) {
      const reliableVoice = frame.voiced
        && Number.isFinite(frame.confidence)
        && frame.confidence >= MINIMUM_CONFIDENCE
        && frame.midiFloat !== null
        && Number.isFinite(frame.midiFloat);
      if (reliableVoice) {
        releaseQuietSinceRef.current = null;
        if (!advanceReadyRef.current) setAdvanceAvailable(false);
      } else {
        releaseQuietSinceRef.current ??= frame.timeSeconds;
        if (
          frame.timeSeconds >= releaseEarliestAtRef.current
          && frame.timeSeconds - releaseQuietSinceRef.current >= 0.3
        ) {
          if (advanceReadyRef.current) triggerPendingAdvance();
          else {
            setReleaseConfirmed(true);
            setAdvanceAvailable(true);
          }
        }
      }
      return;
    }
    if (!attemptActiveRef.current || successLockedRef.current || !runningRef.current) return;
    attemptFramesRef.current = appendBoundedFrame(attemptFramesRef.current, frame, RETAINED_ATTEMPT_FRAMES);
    if (attemptFirstFrameTimeRef.current === null) attemptFirstFrameTimeRef.current = frame.timeSeconds;
    const previous = trackerRef.current ?? createSustainTracker({
      targetMidi: currentTargetRef.current,
      requiredHoldSeconds: holdSecondsRef.current,
      toleranceCents: sessionToleranceRef.current,
      listeningStartedAtSeconds: frame.timeSeconds,
      minimumConfidence: MINIMUM_CONFIDENCE,
      graceSeconds: 0.22,
    });
    const next = updateSustainTracker(previous, frame);
    const restartedAfterGap = previous.status === "holding"
      && next.status === "holding"
      && previous.runStartedAtSeconds !== next.runStartedAtSeconds;
    if (previous.status === "holding" && (next.status === "waiting" || restartedAfterGap)) {
      resetCountRef.current += 1;
      setResetCount(resetCountRef.current);
      setSessionStats((current) => ({ ...current, resets: current.resets + 1 }));
    }
    trackerRef.current = next;
    setTrackerView(next);
    if (next.status === "complete") {
      successLockedRef.current = true;
      completeTargetRef.current(next);
    }
  };

  const beginConnectedSession = (sessionToken: number) => {
    if (sessionToken !== sessionTokenRef.current || document.visibilityState === "hidden") return;
    connectingRef.current = false;
    runningRef.current = true;
    sessionToleranceRef.current = toleranceCents;
    setSessionToleranceCents(toleranceCents);
    setSessionRunning(true);
    setSessionStats({ notes: 0, families: 0, resets: 0 });
    guideIsolationVerifiedRef.current = supportModeRef.current === "solo";
    const familyId = activeFamilyRef.current;
    let queue = familyQueueRef.current[0] === currentTargetRef.current
      ? [...familyQueueRef.current]
      : queueForFamily(familyId);
    if (queue.length === 0) {
      const available = availableTargets(progressRef.current, noteSetRef.current, familyId);
      if (available.length > 0) {
        const currentRecord = progressRef.current[noteSetRef.current][familyId];
        const nextProgress: LoopProgress = {
          ...progressRef.current,
          [noteSetRef.current]: {
            ...progressRef.current[noteSetRef.current],
            [familyId]: { ...currentRecord, passedMidis: [], cyclesCompleted: currentRecord.cyclesCompleted + 1 },
          },
        };
        progressRef.current = nextProgress;
        setProgress(nextProgress);
        queue = buildProfileFamilyQueue(nextProgress, noteSetRef.current, familyId, orderRef.current, profileRef.current.baseline.midi);
      } else {
        const familyAdvance = nextProfileFamily(familyId, progressRef.current, noteSetRef.current, orderRef.current, profileRef.current.baseline.midi);
        if (!familyAdvance) {
          stopLoop("EVERY NOTE IS OUTSIDE THE CURRENT RANGE · RECHECK A FAMILY TO CONTINUE");
          return;
        }
        activeFamilyRef.current = familyAdvance.familyId;
        setActiveFamilyId(familyAdvance.familyId);
        queue = buildProfileFamilyQueue(progressRef.current, noteSetRef.current, familyAdvance.familyId, orderRef.current, profileRef.current.baseline.midi);
      }
    }
    familyQueueRef.current = queue;
    cueTargetRef.current(queue[0]!, sessionToken);
  };
  beginConnectedSessionRef.current = beginConnectedSession;

  const startLoop = async () => {
    if (!hydrated) return;
    if (phase === "connecting") {
      stopLoop("MICROPHONE CONNECTION CANCELLED");
      return;
    }
    if (runningRef.current) {
      stopLoop();
      return;
    }
    if (supportModeRef.current !== "solo" && !headphonesConfirmed) {
      setStatus("CONFIRM HEADPHONES BEFORE ASSISTED SCORING");
      return;
    }
    connectingRef.current = true;
    setDetailsOpen(false);
    setPhase("connecting");
    setStatus("CONNECTING · ALLOW MICROPHONE ACCESS");
    const sessionToken = ++sessionTokenRef.current;
    const microphone = await input.enable();
    if (sessionToken !== sessionTokenRef.current) return;
    if (!microphone) {
      connectingRef.current = false;
      setPhase("idle");
      setStatus("MICROPHONE NEEDED TO START");
      return;
    }
    if (document.visibilityState === "hidden") {
      stopLoop("MICROPHONE CONNECTION CANCELLED WHILE THE TAB WAS HIDDEN");
      return;
    }

    beginConnectedSessionRef.current(sessionToken);
  };

  const replayTarget = () => {
    if (!runningRef.current || phase !== "listening") return;
    carriedResetCountRef.current = resetCountRef.current + 1;
    setResetCount(carriedResetCountRef.current);
    setSessionStats((current) => ({ ...current, resets: current.resets + 1 }));
    cueTargetRef.current(currentTargetRef.current, sessionTokenRef.current);
  };

  const retryGuideIsolation = () => {
    if (!runningRef.current || phase !== "guide-leak") return;
    guideIsolationVerifiedRef.current = false;
    setGuideLeakMatchFrames(0);
    cueTargetRef.current(currentTargetRef.current, sessionTokenRef.current);
  };

  const continueAfterGrade = () => {
    if (phase !== "success" || !advanceAvailable) return;
    advanceReadyRef.current = true;
    triggerPendingAdvance();
  };

  const deferTarget = () => {
    if (!runningRef.current || phase !== "listening") return;
    attemptActiveRef.current = false;
    clearTimers();
    stopAudio();
    const current = currentTargetRef.current;
    const otherTargets = familyQueueRef.current.filter((midi) => midi !== current);
    familyQueueRef.current = [...otherTargets, current];
    setTrackerView(null);
    setPhase("transition");
    setStatus(`${noteLabel(current)} DEFERRED · IT WILL RETURN`);
    const lastFrameTime = input.liveFrame?.timeSeconds ?? 0;
    waitForRelease(
      () => cueTargetRef.current(familyQueueRef.current[0]!, sessionTokenRef.current),
      lastFrameTime,
    );
  };

  const parkTarget = () => {
    if (!runningRef.current || phase !== "listening") return;
    attemptActiveRef.current = false;
    clearTimers();
    stopAudio();
    const familyId = activeFamilyRef.current;
    const current = currentTargetRef.current;
    const currentRecord = progressRef.current[noteSetRef.current][familyId];
    let nextProgress = parkMidiAcrossNoteSets(progressRef.current, familyId, current);
    const remainingQueue = familyQueueRef.current.filter((midi) => midi !== current);
    const lastFrameTime = input.liveFrame?.timeSeconds ?? 0;
    setTrackerView(null);
    setPhase("transition");

    if (remainingQueue.length > 0) {
      progressRef.current = nextProgress;
      setProgress(nextProgress);
      familyQueueRef.current = remainingQueue;
      setStatus(`${noteLabel(current)} MARKED OUTSIDE YOUR CURRENT RANGE`);
      waitForRelease(
        () => cueTargetRef.current(remainingQueue[0]!, sessionTokenRef.current),
        lastFrameTime,
      );
      return;
    }

    const remainingAvailable = availableTargets(nextProgress, noteSetRef.current, familyId);
    if (remainingAvailable.length > 0) {
      nextProgress = {
        ...nextProgress,
        [noteSetRef.current]: {
          ...nextProgress[noteSetRef.current],
          [familyId]: {
            ...nextProgress[noteSetRef.current][familyId],
            passedMidis: [],
            cyclesCompleted: currentRecord.cyclesCompleted + 1,
          },
        },
      };
      setSessionStats((stats) => ({ ...stats, families: stats.families + 1 }));
    }
    progressRef.current = nextProgress;
    setProgress(nextProgress);
    const familyAdvance = nextProfileFamily(familyId, nextProgress, noteSetRef.current, orderRef.current, profileRef.current.baseline.midi);
    if (!familyAdvance) {
      stopLoop("EVERY NOTE IS OUTSIDE THE CURRENT RANGE · RECHECK A FAMILY TO CONTINUE");
      return;
    }
    activeFamilyRef.current = familyAdvance.familyId;
    setActiveFamilyId(familyAdvance.familyId);
    familyQueueRef.current = buildProfileFamilyQueue(nextProgress, noteSetRef.current, familyAdvance.familyId, orderRef.current, profileRef.current.baseline.midi);
    setStatus(`${noteLabel(current)} PARKED · MOVING TO A TRAINABLE FAMILY`);
    waitForRelease(
      () => cueTargetRef.current(familyQueueRef.current[0]!, sessionTokenRef.current),
      lastFrameTime,
    );
  };

  const selectFamily = (familyId: RangeFamilyId) => {
    if (sessionRunning || phase === "connecting") return;
    activeFamilyRef.current = familyId;
    setActiveFamilyId(familyId);
    const queue = buildProfileFamilyQueue(progressRef.current, noteSetRef.current, familyId, orderRef.current, profileRef.current.baseline.midi);
    familyQueueRef.current = queue;
    const preview = queue[0] ?? firstPendingTarget(progressRef.current, noteSetRef.current, familyId);
    currentTargetRef.current = preview;
    setTargetMidi(preview);
    setSelectedMidi(preview);
    setCentsOffset(0);
    const label = RANGE_FAMILIES.find((family) => family.id === familyId)!.label.toUpperCase();
    setStatus(queue.length > 0
      ? `${label} FAMILY READY`
      : `${label} HAS NO TRAINABLE NOTES · RECHECK OR START TO SKIP`);
  };

  const changeNoteSet = (nextNoteSet: FamilyNoteSet) => {
    if (sessionRunning || phase === "connecting") return;
    noteSetRef.current = nextNoteSet;
    setNoteSet(nextNoteSet);
    const familyId = activeFamilyRef.current;
    const queue = buildProfileFamilyQueue(progressRef.current, nextNoteSet, familyId, orderRef.current, profileRef.current.baseline.midi);
    familyQueueRef.current = queue;
    const preview = queue[0] ?? firstPendingTarget(progressRef.current, nextNoteSet, familyId);
    currentTargetRef.current = preview;
    setTargetMidi(preview);
    setSelectedMidi(preview);
    setCentsOffset(0);
  };

  const changeOrder = (nextOrder: TargetOrder) => {
    if (sessionRunning || phase === "connecting") return;
    orderRef.current = nextOrder;
    setOrder(nextOrder);
    const familyId = activeFamilyRef.current;
    const queue = buildProfileFamilyQueue(progressRef.current, noteSetRef.current, familyId, nextOrder, profileRef.current.baseline.midi);
    familyQueueRef.current = queue;
    const preview = queue[0] ?? firstPendingTarget(progressRef.current, noteSetRef.current, familyId);
    currentTargetRef.current = preview;
    setTargetMidi(preview);
    setSelectedMidi(preview);
    setCentsOffset(0);
  };

  const recheckParkedNotes = () => {
    if (sessionRunning || phase === "connecting") return;
    const familyId = activeFamilyRef.current;
    const currentRecord = progressRef.current[noteSetRef.current][familyId];
    if (currentRecord.parkedMidis.length === 0) return;
    const nextProgress = recheckMidisAcrossNoteSets(
      progressRef.current,
      familyId,
      new Set(currentRecord.parkedMidis),
    );
    progressRef.current = nextProgress;
    setProgress(nextProgress);
    const queue = buildProfileFamilyQueue(nextProgress, noteSetRef.current, familyId, orderRef.current, profileRef.current.baseline.midi);
    familyQueueRef.current = queue;
    const preview = queue[0] ?? firstPendingTarget(nextProgress, noteSetRef.current, familyId);
    currentTargetRef.current = preview;
    setTargetMidi(preview);
    setSelectedMidi(preview);
    setCentsOffset(0);
    setStatus("PARKED NOTES RETURNED TO THIS FAMILY");
  };

  const changeBaseline = (nextMidi: number) => {
    if (sessionRunning || phase === "connecting") return;
    const nextProfile = setRangeProfileBaseline(profileRef.current, nextMidi, "manual");
    const familyId = rangeFamilyForMidi(nextMidi);
    const previousNoteSet = noteSetRef.current;
    const nextNoteSet = targetsForFamily(familyId, previousNoteSet).includes(nextMidi) ? previousNoteSet : "chromatic";
    const nextProgress = restoreMidiAsPending(progressRef.current, familyId, nextMidi);
    const queue = buildProfileFamilyQueue(nextProgress, nextNoteSet, familyId, orderRef.current, nextMidi);
    const preview = queue[0] ?? firstPendingTarget(nextProgress, nextNoteSet, familyId);
    profileRef.current = nextProfile;
    progressRef.current = nextProgress;
    activeFamilyRef.current = familyId;
    noteSetRef.current = nextNoteSet;
    currentTargetRef.current = preview;
    familyQueueRef.current = queue;
    setProfile(nextProfile);
    setProgress(nextProgress);
    setActiveFamilyId(familyId);
    setNoteSet(nextNoteSet);
    setTargetMidi(preview);
    setSelectedMidi(preview);
    setCentsOffset(0);
    setProfileNotice(previousNoteSet !== nextNoteSet
      ? `${noteLabel(nextMidi)} is now your comfortable baseline and will lead this family. Chromatic notes were enabled so that exact pitch stays in the loop.`
      : `${noteLabel(nextMidi)} is now your comfortable baseline and will lead this family.`);
    setStatus(`${noteLabel(nextMidi).toUpperCase()} BASELINE SET · ${RANGE_FAMILIES.find((candidate) => candidate.id === familyId)!.label.toUpperCase()} FAMILY READY`);
  };

  const toggleLastObservation = (kind: ProfileObservationKind) => {
    if (!lastResult) return;
    const collection = kind === "clean" ? profileRef.current.cleanStableMidis : profileRef.current.accuracyChallengeMidis;
    const wasMarked = collection.includes(lastResult.midi);
    const nextProfile = toggleProfileObservation(profileRef.current, kind, lastResult.midi);
    profileRef.current = nextProfile;
    setProfile(nextProfile);
    setProfileNotice(`${lastResult.note} ${wasMarked ? "removed from" : "marked in"} your ${kind === "clean" ? "clean, stable range" : "accuracy-challenge map"}.`);
  };

  const toggleLastShift = (direction: ShiftDirection) => {
    if (!lastResult) return;
    const marker = profileRef.current.registerShifts.find((candidate) => candidate.midi === lastResult.midi);
    const wasMarked = marker?.[direction] === true;
    const nextProfile = toggleRegisterShift(profileRef.current, lastResult.midi, direction);
    profileRef.current = nextProfile;
    setProfile(nextProfile);
    setProfileNotice(`${lastResult.note} ${wasMarked ? "removed as" : "marked as"} a register shift while moving ${direction === "ascending" ? "up" : "down"}.`);
  };

  useEffect(() => {
    let cancelled = false;
    const handoffMidi = consumeRangeLoopHandoff();
    void Promise.allSettled([
      getSetting<StoredRangeLoopState>(STORAGE_KEY),
      getSetting<PersonalRangeProfile>(VOCAL_PROFILE_STORAGE_KEY),
    ])
      .then(([loopResult, profileResult]) => {
        if (cancelled) return;
        const loopRead = loopResult.status === "fulfilled";
        const profileRead = profileResult.status === "fulfilled";
        const stored = loopRead ? loopResult.value : undefined;
        const storedProfile = profileRead ? profileResult.value : undefined;
        setLoopStorageReady(loopRead);
        setProfileStorageReady(profileRead);
        setPersistenceState(loopRead && profileRead ? "saved" : "error");
        const normalizedProfile = normalizeRangeProfile(storedProfile);
        const restoredProfile = handoffMidi === null
          ? normalizedProfile
          : setRangeProfileBaseline(normalizedProfile, handoffMidi, "manual");
        const baselineFamily = rangeFamilyForMidi(restoredProfile.baseline.midi);
        const storedNoteSet = isNoteSet(stored?.noteSet) ? stored.noteSet : "natural";
        const restoredNoteSet = targetsForFamily(baselineFamily, storedNoteSet).includes(restoredProfile.baseline.midi)
          ? storedNoteSet
          : "chromatic";
        const normalizedProgress = normalizeProgress(stored?.progress);
        const restoredProgress = handoffMidi === null
          ? normalizedProgress
          : restoreMidiAsPending(normalizedProgress, baselineFamily, handoffMidi);
        const restoredActive = handoffMidi !== null
          ? baselineFamily
          : isFamilyId(stored?.activeFamilyId) ? stored.activeFamilyId : baselineFamily;
        const restoredOrder = isTargetOrder(stored?.order) ? stored.order : "ascending";
        const restoredSupport = isSupportMode(stored?.supportMode) ? stored.supportMode : "unison";
        const restoredHold = HOLD_OPTIONS.includes(stored?.holdSeconds as typeof HOLD_OPTIONS[number]) ? stored!.holdSeconds! : 3;
        const restoredQueue = buildProfileFamilyQueue(
          restoredProgress,
          restoredNoteSet,
          restoredActive,
          restoredOrder,
          restoredProfile.baseline.midi,
        );
        const preview = restoredQueue[0] ?? firstPendingTarget(restoredProgress, restoredNoteSet, restoredActive);
        profileRef.current = restoredProfile;
        progressRef.current = restoredProgress;
        activeFamilyRef.current = restoredActive;
        noteSetRef.current = restoredNoteSet;
        orderRef.current = restoredOrder;
        supportModeRef.current = restoredSupport;
        holdSecondsRef.current = restoredHold;
        currentTargetRef.current = preview;
        familyQueueRef.current = restoredQueue;
        setProfile(restoredProfile);
        setProgress(restoredProgress);
        setActiveFamilyId(restoredActive);
        setNoteSet(restoredNoteSet);
        setOrder(restoredOrder);
        setSupportMode(restoredSupport);
        setHoldSeconds(restoredHold);
        setTargetMidi(preview);
        setSelectedMidi(preview);
        setCentsOffset(0);
        if (restoredQueue.length === 0) {
          const label = RANGE_FAMILIES.find((family) => family.id === restoredActive)!.label.toUpperCase();
          setStatus(`${label} HAS NO TRAINABLE NOTES · RECHECK OR START TO SKIP`);
        }
        if (handoffMidi !== null) {
          setProfileNotice(`${noteLabel(handoffMidi)} was handed off from the guided map and restored as the first trainable target.`);
        }
        if (!loopRead || !profileRead) {
          setProfileNotice("Local storage could not be fully read. The available record was preserved, and this page will not overwrite the unavailable one.");
        }
        clearRangeLoopHandoff();
      })
      .catch(() => {
        if (cancelled) return;
        setLoopStorageReady(false);
        setProfileStorageReady(false);
        setPersistenceState("error");
        setProfileNotice("Local storage is unavailable. This session can continue, but its map may not survive a reload.");
      })
      .finally(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, [setCentsOffset, setSelectedMidi]);

  useEffect(() => {
    if (!hydrated || (!loopStorageReady && !profileStorageReady)) return;
    const loopSnapshot: StoredRangeLoopState = {
      activeFamilyId,
      noteSet,
      order,
      supportMode,
      holdSeconds,
      progress,
    };
    const entries = [
      ...(loopStorageReady ? [{ key: STORAGE_KEY, value: loopSnapshot }] : []),
      ...(profileStorageReady ? [{ key: VOCAL_PROFILE_STORAGE_KEY, value: profile }] : []),
    ];
    const writeId = ++persistenceWriteIdRef.current;
    setPersistenceState("saving");
    persistenceChainRef.current = persistenceChainRef.current
      .catch(() => undefined)
      .then(() => setSettings(entries))
      .then(() => {
        if (persistenceMountedRef.current && writeId === persistenceWriteIdRef.current) setPersistenceState("saved");
      })
      .catch(() => {
        if (persistenceMountedRef.current && writeId === persistenceWriteIdRef.current) setPersistenceState("error");
      });
  }, [activeFamilyId, holdSeconds, hydrated, loopStorageReady, noteSet, order, profile, profileStorageReady, progress, supportMode]);

  useEffect(() => {
    if (!hydrated) return;
    const animationFrame = window.requestAnimationFrame(() => {
      const wrap = profileRulerWrapRef.current;
      if (!wrap || wrap.scrollWidth <= wrap.clientWidth) return;
      const noteRatio = (profile.baseline.midi - RANGE_PROFILE_MIN_MIDI) / (RANGE_PROFILE_MAX_MIDI - RANGE_PROFILE_MIN_MIDI);
      const baselinePosition = noteRatio * wrap.scrollWidth;
      wrap.scrollLeft = Math.max(0, Math.min(wrap.scrollWidth - wrap.clientWidth, baselinePosition - wrap.clientWidth / 2));
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [hydrated, profile.baseline.midi]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden" && (runningRef.current || connectingRef.current)) {
        stopLoopRef.current("PAUSED WHEN THE TAB WAS HIDDEN · SESSION ENDED");
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  useEffect(() => {
    if (input.state === "error" && (runningRef.current || connectingRef.current)) {
      stopLoopRef.current("MICROPHONE DISCONNECTED · SESSION ENDED");
    }
  }, [input.state]);

  useEffect(() => {
    persistenceMountedRef.current = true;
    return () => {
      persistenceMountedRef.current = false;
      sessionTokenRef.current += 1;
      runningRef.current = false;
      connectingRef.current = false;
      attemptActiveRef.current = false;
      clearTimers();
      stopAudio();
    };
  }, [clearTimers, stopAudio]);

  const family = RANGE_FAMILIES.find((candidate) => candidate.id === activeFamilyId)!;
  const resultFamily = lastResult
    ? RANGE_FAMILIES.find((candidate) => candidate.id === lastResult.familyId) ?? family
    : family;
  const modalFamily = phase === "success" ? resultFamily : family;
  const familyTargets = targetsForFamily(activeFamilyId, noteSet);
  const passedMidis = new Set(progress[noteSet][activeFamilyId].passedMidis);
  const parkedMidis = new Set(progress[noteSet][activeFamilyId].parkedMidis);
  const trainableTargetCount = familyTargets.length - parkedMidis.size;
  const support = createSupportPlan(targetMidi, supportMode);
  const effectiveToleranceCents = sessionRunning ? sessionToleranceCents : toleranceCents;
  const displayFrames = attemptFramesRef.current.slice(-360);
  const displayFrame = input.liveFrame;
  const candidateMeterFrame = phase === "listening"
    && displayFrame?.voiced === true
    && displayFrame.midiFloat !== null
    && Number.isFinite(displayFrame.midiFloat)
    ? displayFrame
    : undefined;
  const meterFrame = candidateMeterFrame;
  const liveError = meterFrame?.midiFloat == null ? null : (meterFrame.midiFloat - targetMidi) * 100;
  const progressRatio = phase === "success" ? 1 : trackerView?.progress ?? 0;
  const locked = trackerView?.status === "holding" && !trackerView.inGrace;
  const tuner = tunerGuidance(phase, meterFrame !== undefined, liveError, effectiveToleranceCents);
  const sessionFlowIndex = phase === "prompting"
    ? 0
    : phase === "guide-check" || phase === "guide-leak"
      ? 0
    : phase === "listening" && !locked
      ? 1
      : phase === "listening"
        ? 2
        : phase === "success" ? advanceAvailable ? 4 : 3 : phase === "transition" ? 4 : -1;
  const holdState = phase === "success"
    ? "EARNED"
    : phase === "prompting"
      ? "REFERENCE PLAYING"
      : trackerView?.inGrace
        ? "BRIEF SIGNAL GAP · HOLD PRESERVED"
        : locked
          ? "LOCKED · HOLD CLOCK MOVING"
          : meterFrame
            ? liveError !== null && Math.abs(liveError) <= effectiveToleranceCents
              ? "CENTER FOUND · STABILIZING"
              : "OUTSIDE TARGET · HOLD RESET"
            : "WAITING FOR A RELIABLE PITCH";
  const sessionAnnouncement = phase === "success" && lastResult
    ? `${lastResult.note} earned. Grade ${lastResult.grade.letter}, ${lastResult.grade.score} out of 100. ${advanceAvailable ? releaseConfirmed ? "Voice released. Next note is ready." : "Release was not observed; Next is available without claiming one." : "Release your voice before continuing."}`
    : phase === "prompting"
      ? `Hear target ${noteLabel(targetMidi)}. The reference does not count toward the hold.`
      : phase === "listening"
        ? `${tuner.title}. ${holdState}.`
      : phase === "transition"
          ? "Preparing the next target."
            : phase === "guide-check"
              ? "Stay silent while NoteForge checks whether the sustained guide is reaching the microphone."
            : phase === "guide-leak"
              ? "The guide reached the microphone, so scoring is locked until headphone isolation is fixed."
          : "Opening microphone.";
  const advancing = phase === "success" || phase === "transition";
  const nextMidi = familyQueueRef.current[advancing ? 0 : 1]
    ?? familyTargets.find((midi) => midi !== targetMidi && !passedMidis.has(midi) && !parkedMidis.has(midi));
  const ringStyle = { "--hold-progress": progressRatio } as CSSProperties;
  const familySizeStyle = { "--range-family-size": familyTargets.length } as CSSProperties;
  const errorMessage = input.error;
  const configuringLocked = !hydrated || sessionRunning || phase === "connecting";
  const noTrainableTarget = !sessionRunning && !RANGE_FAMILIES.some(({ id }) => availableTargets(progress, noteSet, id).length > 0);
  const stableBounds = pitchStableBounds(profile);
  const confirmedCleanBounds = cleanStableBounds(profile);
  const confirmedAccuracyEdges = manualAccuracyEdges(profile);
  const emergingAccuracyEdges = suggestedAccuracyEdges(profile, supportMode, effectiveToleranceCents, holdSeconds * 1_000);
  const evidenceMidis = new Set(Object.keys(profile.evidenceByMidi).map(Number));
  const cleanMidis = new Set(profile.cleanStableMidis);
  const accuracyMidis = new Set(profile.accuracyChallengeMidis);
  const shiftMarkers = new Map(profile.registerShifts.map((marker) => [marker.midi, marker]));
  const suggestedMidis = new Set([
    ...(emergingAccuracyEdges.lowMidi === null ? [] : [emergingAccuracyEdges.lowMidi]),
    ...(emergingAccuracyEdges.highMidi === null ? [] : [emergingAccuracyEdges.highMidi]),
  ]);
  const registerShiftSummary = profile.registerShifts.length === 0
    ? "Not marked yet"
    : profile.registerShifts.flatMap((marker) => [
      ...(marker.ascending ? [`${noteLabel(marker.midi)} ↑`] : []),
      ...(marker.descending ? [`${noteLabel(marker.midi)} ↓`] : []),
    ]).join(", ");
  const lastCleanMarked = lastResult ? cleanMidis.has(lastResult.midi) : false;
  const lastAccuracyMarked = lastResult ? accuracyMidis.has(lastResult.midi) : false;
  const lastShiftMarker = lastResult ? shiftMarkers.get(lastResult.midi) : undefined;
  const mappedProfileMidis = PROFILE_MIDIS.filter((midi) => (
    midi === profile.baseline.midi
    || evidenceMidis.has(midi)
    || cleanMidis.has(midi)
    || accuracyMidis.has(midi)
    || suggestedMidis.has(midi)
    || shiftMarkers.has(midi)
  ));
  const profileFamilyRoute = profileFamilyOrder(profile.baseline.midi);
  const familyRouteLabel = profileFamilyRoute
    .map((familyId) => RANGE_FAMILIES.find((candidate) => candidate.id === familyId)!.label)
    .join(" → ");
  const baselineFamilyIndex = RANGE_FAMILIES.findIndex((candidate) => candidate.id === rangeFamilyForMidi(profile.baseline.midi));
  const familyRoutePurpose = baselineFamilyIndex === 0
    ? "establish home, then move upward"
    : baselineFamilyIndex === RANGE_FAMILIES.length - 1
      ? "establish home, then explore lower notes"
      : "establish home, explore lower notes, then move upward";
  const persistenceLabel = !hydrated
    ? "Loading local map"
    : !loopStorageReady || !profileStorageReady
      ? "Local storage limited"
      : persistenceState === "saving"
        ? "Saving local map"
        : persistenceState === "error" ? "Local save needs attention" : "Local map saved";

  return (
    <div className="page range-loop-page">
      <div className="lab-intro range-loop-intro">
        <div>
          <Eyebrow>Prompt → listen without a deadline → earn the note → repeat</Eyebrow>
          <h1>Stay with one note until your voice owns it.</h1>
          <p>A fresh map starts from your comfortable baseline—C3 by default—and never fails you on a timer. It advances only after one continuous, in-tune hold, then walks the family and expands into the next register.</p>
        </div>
        <div className={`range-loop-state-pill ${sessionRunning ? "running" : ""} ${phase === "success" ? "success" : ""}`}>
          <i /><div><small>ENDLESS SESSION</small><strong>{phaseLabel(phase, sessionRunning)}</strong></div>
        </div>
      </div>

      <Panel className="range-loop-config">
        <div className="range-loop-config-copy">
          <Eyebrow>Loop contract</Eyebrow>
          <b>Choose what counts, then let the loop run.</b>
          <small>Controls lock during a session so every target uses the same evidence threshold.</small>
        </div>
        <div className="range-loop-fields">
          <Select className="support-field" label="Support" value={supportMode} disabled={configuringLocked} onChange={(event) => {
            const nextSupport = event.target.value as SupportMode;
            setSupportMode(nextSupport);
            if (nextSupport !== "solo") setHeadphonesConfirmed(false);
          }}>
            {(Object.entries(SUPPORT_OPTIONS) as [SupportMode, typeof SUPPORT_OPTIONS[SupportMode]][]).map(([value, option]) => <option value={value} key={value}>{option.label}</option>)}
          </Select>
          <Select label="Hold time" value={holdSeconds} disabled={configuringLocked} onChange={(event) => setHoldSeconds(Number(event.target.value))}>
            {HOLD_OPTIONS.map((seconds) => <option value={seconds} key={seconds}>{seconds} seconds</option>)}
          </Select>
          <Select label="Notes" value={noteSet} disabled={configuringLocked} onChange={(event) => changeNoteSet(event.target.value as FamilyNoteSet)}>
            <option value="natural">Natural · 7</option><option value="chromatic">Chromatic · 12</option>
          </Select>
          <Select label="Order" value={order} disabled={configuringLocked} onChange={(event) => changeOrder(event.target.value as TargetOrder)}>
            <option value="ascending">Ascending</option><option value="descending">Descending</option><option value="shuffled">Shuffled</option>
          </Select>
          <Select label="Tolerance" value={effectiveToleranceCents} disabled={configuringLocked} onChange={(event) => setToleranceCents(Number(event.target.value))}>
            <option value="35">Beginner ±35¢</option><option value="20">Developing ±20¢</option><option value="10">Precise ±10¢</option>
          </Select>
          <Select label="Prompt timbre" value={timbre} disabled={configuringLocked} onChange={(event) => setTimbre(event.target.value as typeof timbre)}>
            <option>sine</option><option>triangle</option><option>piano</option><option>guitar</option><option>bass</option><option>flute</option><option>voice</option><option>rich synth</option>
          </Select>
        </div>
      </Panel>

      <div className="range-workflow-input-scope">
        <NoteInput
          variant="scope"
          input={input}
          title="Workflow microphone setup"
          targetMidiFloat={targetMidi}
          toleranceCents={effectiveToleranceCents}
        />
      </div>

      {supportMode !== "solo" && (
        <Panel id="range-headphone-requirement" className={`range-assist-preflight ${headphonesConfirmed ? "confirmed" : ""}`}>
          <Icon name="headphones" size={20} />
          <div><b>{supportMode === "unison" ? "Sustained matching requires headphones." : "Harmony assist requires headphones."}</b><span>The guide and your voice share one monophonic detector. Speaker playback can earn a false pass or hide a correct note.</span></div>
          <ActionButton aria-pressed={headphonesConfirmed} onClick={() => setHeadphonesConfirmed(true)} disabled={headphonesConfirmed || configuringLocked}>{headphonesConfirmed ? "Headphones confirmed" : "I’m wearing headphones"}</ActionButton>
        </Panel>
      )}

      {errorMessage && <div className="error-banner" role="alert"><strong>Microphone needs attention.</strong><span>{errorMessage}</span></div>}

      <Panel className="range-workflow-launch">
        <div className="range-workflow-launch-copy">
          <Eyebrow>Guided workflow · setup</Eyebrow>
          <h2>Choose a starting family, then enter the tuner.</h2>
          <p>Once started, this page gives way to one focused sequence: hear the note, find it on the live meter, sustain it, read the grade, then choose when to continue.</p>
          <div className="range-workflow-contract">
            <span><b>{SUPPORT_OPTIONS[supportMode].label}</b><small>support</small></span>
            <span><b>{holdSeconds.toFixed(1)} seconds</b><small>continuous hold</small></span>
            <span><b>±{toleranceCents} cents</b><small>target lane</small></span>
            <span><b>{noteSet === "natural" ? "7 natural notes" : "12 chromatic notes"}</b><small>per family</small></span>
          </div>
        </div>
        <div className="range-workflow-family-picker" role="group" aria-label="Starting note family">
          {profileFamilyRoute.map((familyId) => {
            const candidate = RANGE_FAMILIES.find((item) => item.id === familyId)!;
            return <button type="button" key={familyId} className={candidate.id === activeFamilyId ? "active" : ""} aria-pressed={candidate.id === activeFamilyId} disabled={configuringLocked} onClick={() => selectFamily(candidate.id)}><span>{candidate.label}</span><small>{candidate.rangeLabel}</small></button>;
          })}
        </div>
        <ActionButton
          aria-describedby={supportMode === "solo" ? undefined : "range-headphone-requirement"}
          className="primary range-workflow-start"
          disabled={configuringLocked || (supportMode !== "solo" && !headphonesConfirmed) || noTrainableTarget}
          onClick={startLoop}
        >
          <Icon name={input.state === "running" ? "loop" : "mic"} size={19} /> Start guided tuner workflow
        </ActionButton>
        <small className="range-workflow-start-note">Target {noteLabel(targetMidi)} · microphone {input.state === "running" ? "running and detecting continuously" : "opens after Start"}</small>
      </Panel>

      <details className="range-loop-details" open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
        <summary ref={reviewSummaryRef}><span><b>Voice map, diagnostics &amp; session history</b><small>Open the advanced dashboard without interrupting the guided workflow.</small></span><Icon name="arrow" size={16} /></summary>
        <div className="range-loop-details-body">
      <div className="range-loop-workspace">
        <Panel className={`range-loop-stage ${sessionRunning ? "active" : ""}`}>
          <span className="range-live-announcement" aria-live="polite" aria-atomic="true">{status}. {noTrainableTarget ? "No vocal target is queued." : `Vocal target ${noteLabel(targetMidi)}.`}</span>
          <div className="range-loop-coordinates">
            <div className="range-coordinate guide">
              <span>AUDIBLE GUIDE</span>
              <strong>{noTrainableTarget ? "not queued" : support.guideMidi === null ? "silence" : noteLabel(support.guideMidi)}</strong>
              <small>{noTrainableTarget ? "choose another family or recheck parked notes" : support.guideMidi === null ? "after the prompt" : `${continuousMidiToHz(support.guideMidi).toFixed(1)} Hz · sine drone`}</small>
            </div>
            <div className="range-relationship"><Icon name={noTrainableTarget ? "pause" : support.guideMidi === null ? "arrow" : "harmony"} size={20} /><span>{noTrainableTarget ? "no target" : SUPPORT_OPTIONS[supportMode].relation}</span></div>
            <div className="range-coordinate target">
              <span>YOUR MEASURED TARGET</span>
              <strong>{noTrainableTarget ? "none queued" : noteLabel(targetMidi)}</strong>
              <small>{noTrainableTarget ? `all ${family.label} notes are parked` : `${continuousMidiToHz(targetMidi).toFixed(2)} Hz · lane ±${effectiveToleranceCents}¢`}</small>
            </div>
          </div>

          <div className="range-hold-zone">
            <div
              className={`range-hold-ring ${locked ? "locked" : ""} ${phase === "success" ? "success" : ""}`}
              style={ringStyle}
              role="progressbar"
              aria-label="Continuous in-tune hold"
              aria-valuemin={0}
              aria-valuemax={holdSeconds}
              aria-valuenow={trackerView?.heldSeconds ?? 0}
              aria-valuetext={`${(phase === "success" ? holdSeconds : trackerView?.heldSeconds ?? 0).toFixed(1)} of ${holdSeconds.toFixed(1)} seconds held continuously`}
            >
              <div className="range-hold-readout"><small>CONTINUOUS HOLD</small><strong>{(phase === "success" ? holdSeconds : trackerView?.heldSeconds ?? 0).toFixed(1)}s</strong><span>of {holdSeconds.toFixed(1)}s</span></div>
            </div>
            <div className="range-live-copy">
              <span>{status}</span>
              <strong className={liveError != null && Math.abs(liveError) <= effectiveToleranceCents ? "in-band" : ""}>{liveError == null ? "—" : `${signed(liveError, 0)}¢`}</strong>
              <small>{phase === "prompting" ? "Listen first; prompt audio never counts toward the hold." : meterFrame?.voiced ? `${noteLabel(meterFrame.nearestMidi ?? selectedMidi)} · ${(meterFrame.frequencyHz ?? 0).toFixed(1)} Hz · ${locked ? "hold clock moving" : "find the target lane"}` : sessionRunning ? "The loop is still listening. Take a breath whenever you need one." : input.state === "running" ? "Input is running. Start the loop to hear the first target." : "Start the loop to connect the microphone and hear the first target."}</small>
              <div className="range-hold-track" style={ringStyle}><span /></div>
            </div>
          </div>

          <div className="range-loop-actions">
            <PlayButton label="Restart note + replay" disabled={!sessionRunning || phase !== "listening"} onClick={replayTarget} />
            <ActionButton aria-describedby={supportMode === "solo" ? undefined : "range-headphone-requirement"} className="primary" disabled={!hydrated || (phase !== "connecting" && supportMode !== "solo" && !headphonesConfirmed)} onClick={startLoop}>
              <Icon name={sessionRunning || phase === "connecting" ? "pause" : input.state === "running" ? "loop" : "mic"} size={18} />
              {phase === "connecting" ? "Cancel connection" : sessionRunning ? "Stop · keep progress" : "Start endless loop"}
            </ActionButton>
            <ActionButton disabled={!sessionRunning || phase !== "listening"} onClick={deferTarget}>Try this note later</ActionButton>
            <ActionButton disabled={!sessionRunning || phase !== "listening"} onClick={parkTarget}>Outside my current range</ActionButton>
          </div>

          {noTrainableTarget
            ? <div className="range-no-target"><Icon name="pause" size={22} /><div><b>No target queued in {family.label}.</b><span>Choose another register below, or bring parked notes back into practice.</span></div></div>
            : <PitchRibbon frames={displayFrames} targetMidiFloat={targetMidi} toleranceCents={effectiveToleranceCents} durationSeconds={18} />}
        </Panel>

        <aside className="range-loop-sidebar">
          <Panel className="range-cycle-panel">
            <Eyebrow>Current family · {family.label}</Eyebrow>
            <h2>{passedMidis.size}/{trainableTargetCount} trainable notes held this lap</h2>
            <p>Only a completed continuous hold lights a note. Defer rotates once; “outside range” parks a note across sessions until you recheck it.</p>
            <div className="range-note-grid" style={familySizeStyle} role="list" aria-label={`${family.label} family note progress`}>
              {familyTargets.map((midi) => {
                const noteState = passedMidis.has(midi) ? "held" : parkedMidis.has(midi) ? "outside current range" : midi === targetMidi ? "current target" : "pending";
                return <span role="listitem" aria-label={`${noteLabel(midi)}, ${noteState}`} key={midi} className={`${passedMidis.has(midi) ? "passed" : ""} ${parkedMidis.has(midi) ? "parked" : ""} ${midi === targetMidi && !parkedMidis.has(midi) ? "current" : ""}`}>{noteLabel(midi)}{(passedMidis.has(midi) || parkedMidis.has(midi) || midi === targetMidi) && <i />}</span>;
              })}
            </div>
            <div className="range-next-note"><div><span>Up next</span><small>{order === "shuffled" ? "random order stays inside this register" : `${order} through ${family.rangeLabel}`}</small></div><strong>{nextMidi == null ? "next family" : noteLabel(nextMidi)}</strong></div>
            {parkedMidis.size > 0 && <ActionButton className="range-recheck-button" disabled={configuringLocked} onClick={recheckParkedNotes}>Recheck {parkedMidis.size} outside-range {parkedMidis.size === 1 ? "note" : "notes"}</ActionButton>}
          </Panel>

          <Panel className="range-evidence-panel">
            <Eyebrow>Session evidence</Eyebrow>
            <h2>No deadline. Exact scoring boundary.</h2>
            <p>A wrong note can remain voiced forever and still never pass. Brief detector gaps get 220 ms of grace but add no time to the hold.</p>
            <div className="range-session-stats"><div><span>Notes</span><strong>{sessionStats.notes}</strong></div><div><span>Families</span><strong>{sessionStats.families}</strong></div><div><span>Resets</span><strong>{sessionStats.resets}</strong></div></div>
            {supportMode !== "solo" && <div className="range-headphone-note"><Icon name="headphones" size={18} /><div><b>Headphones are required for trustworthy harmony scoring.</b><small>The pitch detector is monophonic; speakers can leak the guide or its harmonics into the microphone.</small></div></div>}
            <div className="range-last-result">
              <div><span>Current-note resets</span><b>{resetCount}</b></div>
              <div><span>Last success</span><b>{lastResult?.note ?? "—"}</b></div>
              <div><span>Time to acquire</span><b>{lastResult ? `${(lastResult.timeToAcquireMs / 1_000).toFixed(1)}s` : "—"}</b></div>
              <div><span>Pitch center</span><b>{lastResult?.medianErrorCents == null ? "—" : `${signed(lastResult.medianErrorCents, 1)}¢`}</b></div>
              <div><span>Stability</span><b>{lastResult?.stabilityCents == null ? "—" : `${lastResult.stabilityCents.toFixed(1)}¢`}</b></div>
            </div>
            <fieldset className="range-observation" disabled={!lastResult}>
              <legend aria-live="polite" aria-atomic="true">{lastResult ? `Your read of ${lastResult.note} · the detector does not infer these` : "Complete one note to add your own observations"}</legend>
              <div className="range-observation-actions">
                <button type="button" aria-label={lastResult ? `Clean and stable at ${lastResult.note}` : "Clean and stable"} aria-pressed={lastCleanMarked} onClick={() => toggleLastObservation("clean")}>Clean &amp; stable</button>
                <button type="button" aria-label={lastResult ? `Accuracy got harder at ${lastResult.note}` : "Accuracy got harder"} aria-pressed={lastAccuracyMarked} disabled={lastResult?.midi === profile.baseline.midi && !lastAccuracyMarked} onClick={() => toggleLastObservation("accuracy")}>Accuracy got harder</button>
                <button type="button" aria-label={lastResult ? `Register shift going up at ${lastResult.note}` : "Register shift going up"} aria-pressed={lastShiftMarker?.ascending === true} onClick={() => toggleLastShift("ascending")}>Shift going up ↑</button>
                <button type="button" aria-label={lastResult ? `Register shift going down at ${lastResult.note}` : "Register shift going down"} aria-pressed={lastShiftMarker?.descending === true} onClick={() => toggleLastShift("descending")}>Shift going down ↓</button>
              </div>
              {lastResult?.midi === profile.baseline.midi && <small className="range-observation-hint">Your baseline is the comparison point. Mark “accuracy got harder” on a note above or below it.</small>}
            </fieldset>
          </Panel>
        </aside>
      </div>

      <Panel className="range-profile-panel" aria-labelledby="range-profile-title">
        <div className="range-profile-header">
          <div>
            <Eyebrow>Personal voice map</Eyebrow>
            <h2 id="range-profile-title">Start at {noteLabel(profile.baseline.midi)}, then let evidence expand the map.</h2>
            <p id="range-profile-baseline-help">This is a working map of pitches you can reproduce, not a baritone/tenor classification. A completed hold adds pitch-stability evidence; clean phonation and register changes stay yours to confirm.</p>
          </div>
          <label className="range-profile-baseline">
            <span>Comfortable baseline</span>
            <select
              value={profile.baseline.midi}
              disabled={configuringLocked}
              aria-describedby="range-profile-baseline-help"
              onChange={(event) => changeBaseline(Number(event.target.value))}
            >
              {PROFILE_MIDIS.map((midi) => <option value={midi} key={midi}>{noteLabel(midi)} · {continuousMidiToHz(midi).toFixed(2)} Hz</option>)}
            </select>
          </label>
        </div>

        <dl className="range-profile-summary">
          <div><dt>Comfortable baseline</dt><dd>{noteLabel(profile.baseline.midi)} · {continuousMidiToHz(profile.baseline.midi).toFixed(2)} Hz</dd></div>
          <div><dt>Pitch-stable evidence</dt><dd>{formatBounds(stableBounds)}</dd></div>
          <div><dt>Clean-confirmed range</dt><dd>{formatBounds(confirmedCleanBounds)}</dd></div>
          <div><dt>Accuracy got harder</dt><dd>{formatAccuracyEdges(confirmedAccuracyEdges)}</dd></div>
          <div><dt>Emerging friction · 3+ comparable holds</dt><dd>{formatAccuracyEdges(emergingAccuracyEdges)}</dd></div>
          <div><dt>Register shifts · direction matters</dt><dd className="range-profile-shifts">{registerShiftSummary}</dd></div>
        </dl>

        <small className="range-profile-scroll-cue">C2–B5 map · scroll horizontally to inspect every note</small>
        <div className="range-profile-ruler-wrap" aria-hidden="true" ref={profileRulerWrapRef}>
          <div className="range-profile-ruler">
            {PROFILE_MIDIS.map((midi) => {
              const marker = shiftMarkers.get(midi);
              const classNames = [
                "range-profile-cell",
                midi === profile.baseline.midi ? "is-baseline" : "",
                evidenceMidis.has(midi) ? "is-pitch-stable" : "",
                cleanMidis.has(midi) ? "is-clean" : "",
                accuracyMidis.has(midi) ? "is-accuracy" : "",
                suggestedMidis.has(midi) && !accuracyMidis.has(midi) ? "is-suggested" : "",
                marker?.ascending ? "is-shift-up" : "",
                marker?.descending ? "is-shift-down" : "",
              ].filter(Boolean).join(" ");
              return (
                <span className={classNames} key={midi}>
                  {cleanMidis.has(midi) ? <b className="range-profile-clean-glyph">✓</b> : null}
                  {marker?.ascending || marker?.descending
                    ? <b className="range-profile-shift-glyph">{marker.ascending ? "↑" : ""}{marker.descending ? "↓" : ""}</b>
                    : null}
                  {midi % 12 === 0 ? <small>{noteLabel(midi)}</small> : null}
                </span>
              );
            })}
          </div>
        </div>

        <div className="range-profile-legend" aria-label="Voice map marker legend">
          <span><i className="is-baseline" />Home baseline</span>
          <span><i className="is-pitch-stable" />Pitch hold earned</span>
          <span><i className="is-clean" />Clean · your mark</span>
          <span><i className="is-accuracy" />Accuracy harder · your mark</span>
          <span><i className="is-suggested" />Dashed · repeated friction</span>
          <span><i className="is-shift-up" />Shift ↑ / ↓ · your mark</span>
        </div>
        <details className="range-profile-note-details">
          <summary>Per-note map · {mappedProfileMidis.length} {mappedProfileMidis.length === 1 ? "pitch" : "pitches"} marked</summary>
          <ul>
            {mappedProfileMidis.map((midi) => {
              const marker = shiftMarkers.get(midi);
              const states = [
                midi === profile.baseline.midi ? "comfortable baseline" : "",
                evidenceMidis.has(midi) ? "pitch hold earned" : "",
                cleanMidis.has(midi) ? "clean and stable, singer-confirmed" : "",
                accuracyMidis.has(midi) ? "accuracy got harder, singer-confirmed" : "",
                suggestedMidis.has(midi) && !accuracyMidis.has(midi) ? "repeated friction emerging" : "",
                marker?.ascending ? "register shift going up" : "",
                marker?.descending ? "register shift going down" : "",
              ].filter(Boolean);
              return <li key={midi}><b>{noteLabel(midi)} · {continuousMidiToHz(midi).toFixed(2)} Hz</b><span>{states.join("; ")}</span></li>;
            })}
          </ul>
        </details>
        <div className="range-profile-notice" aria-live="polite" aria-atomic="true">
          <Icon name="spark" size={17} />
          <span>{profileNotice || "Successful holds add pitch-stability evidence automatically. After a success, use the four observation buttons to confirm what the detector cannot know."}</span>
        </div>
      </Panel>

      <Panel className="range-family-path" aria-label="Range family progression">
        <div className="range-family-copy">
          <Eyebrow>Family loop</Eyebrow>
          <b>Choose a register or let the loop move progressively.</b>
          <small>From {noteLabel(profile.baseline.midi)}, the mapping route is {familyRouteLabel}: {familyRoutePurpose} before wrapping.</small>
          <span className={`range-persistence-status ${persistenceState === "error" || !loopStorageReady || !profileStorageReady ? "error" : ""}`} aria-live="polite">{persistenceLabel}</span>
        </div>
        <div className="range-family-stage-wrap">
          <div className="range-family-stages">
            {profileFamilyRoute.map((familyId) => {
            const candidate = RANGE_FAMILIES.find((family) => family.id === familyId)!;
            const candidateTargets = targetsForFamily(candidate.id, noteSet);
            const candidateRecord = progress[noteSet][candidate.id];
            const candidatePassed = new Set(candidateRecord.passedMidis);
            const candidateParked = new Set(candidateRecord.parkedMidis);
            const candidateTrainable = candidateTargets.length - candidateParked.size;
            const active = candidate.id === activeFamilyId;
            const statusLabel = candidateTrainable === 0
              ? active ? "All parked" : "Parked"
              : active ? "Active" : candidateRecord.cyclesCompleted ? "Review" : "Ready";
            return (
              <button
                type="button"
                key={candidate.id}
                className={`${active ? "active" : ""} ${candidateRecord.cyclesCompleted ? "complete" : ""}`}
                disabled={configuringLocked}
                onClick={() => selectFamily(candidate.id)}
                aria-pressed={active}
                aria-label={`${candidate.label} family, ${candidate.rangeLabel}, ${statusLabel}, ${candidatePassed.size} of ${candidateTrainable} trainable notes held this lap, ${candidateParked.size} outside current range`}
              >
                <span>{statusLabel}</span>
                <strong>{candidate.label}</strong>
                <small>{candidate.rangeLabel}</small>
                <i style={{ "--range-family-size": candidateTargets.length } as CSSProperties}>{candidateTargets.map((midi) => <em key={midi} className={candidatePassed.has(midi) ? "earned" : candidateParked.has(midi) ? "parked" : ""} />)}</i>
                <b>{candidatePassed.size}/{candidateTrainable} trainable · {candidateParked.size} outside · {candidateRecord.cyclesCompleted} laps</b>
              </button>
            );
            })}
          </div>
          {parkedMidis.size > 0 && <ActionButton className="range-map-recheck" disabled={configuringLocked} onClick={recheckParkedNotes}>Recheck {parkedMidis.size} parked {parkedMidis.size === 1 ? "note" : "notes"} in {family.label}</ActionButton>}
        </div>
      </Panel>

        </div>
      </details>

      <Panel className="range-privacy-strip"><Icon name="record" size={17} /><span><b>Listening is not raw-audio recording.</b> Stop session ends scoring but keeps the microphone ready for this app; use <b>Stop input</b> in the input panel to close it fully. NoteForge sends bounded derived pitch diagnostics to this NoteForge server and never sends or saves the voice waveform.</span></Panel>

      <WorkflowDialog
        open={sessionModalOpen}
        steps={RANGE_LOOP_WORKFLOW_STEPS}
        activeStep={Math.max(0, sessionFlowIndex)}
        label="Guided range loop"
        exitLabel="Stop session"
        onExit={exitWorkflow}
        className={`range-session-dialog phase-${phase}`}
      >
            <span className="range-session-announcement" aria-live="polite" aria-atomic="true">{sessionAnnouncement}</span>
            <div className="range-session-brand">
              <span><i /> LIVE RANGE WORKFLOW</span>
              <b>{modalFamily.label} family · {modalFamily.rangeLabel}</b>
            </div>

            {phase === "connecting" ? (
              <div className="range-session-connecting">
                <span className="range-connecting-orb"><Icon name="mic" size={34} /></span>
                <Eyebrow>Opening local microphone</Eyebrow>
                <h2 id="range-session-title">Allow input once. The workflow takes it from here.</h2>
                <p>NoteForge is preparing the tuner and pitch detector. Raw voice audio is not saved.</p>
                <div className="range-connecting-track"><span /></div>
                <ActionButton onClick={() => stopLoop("MICROPHONE CONNECTION CANCELLED")}>Cancel</ActionButton>
              </div>
            ) : phase === "guide-check" || phase === "guide-leak" ? (
              <div className="range-session-isolation range-guide-isolation">
                <div className="range-session-isolation-copy">
                  <span className="range-connecting-orb"><Icon name="headphones" size={34} /></span>
                  <div>
                    <Eyebrow>Scoring safeguard · first assisted note only</Eyebrow>
                    <h2 id="range-session-title">{phase === "guide-check" ? "Stay silent while the guide plays." : "The microphone heard the guide."}</h2>
                    <p>{phase === "guide-check"
                      ? "Do not hum yet. NoteForge is checking that headphone playback cannot earn this target for you."
                      : "Scoring stayed locked. Check that audio is not playing through speakers, reseat the headphones, and move the microphone farther from the earcups."}</p>
                  </div>
                </div>
                <NoteInput variant="scope" input={input} title="Guide isolation monitor" targetMidiFloat={support.guideMidi ?? targetMidi} toleranceCents={GUIDE_LEAK_TOLERANCE_CENTS} />
                {phase === "guide-check" ? (
                  <div className="range-guide-check-status" role="status"><i /><span><b>LISTENING FOR GUIDE LEAK</b><small>{guideLeakMatchFrames === 0 ? "No matching guide frames detected" : `${guideLeakMatchFrames} matching ${guideLeakMatchFrames === 1 ? "frame" : "frames"} detected`}</small></span></div>
                ) : (
                  <div className="range-isolation-retry danger" role="alert"><span>The sustained guide matched the microphone repeatedly. No hold time or grade was awarded.</span><ActionButton className="primary" onClick={retryGuideIsolation}>I fixed it · retry check</ActionButton></div>
                )}
                <ActionButton onClick={() => stopLoop("GUIDE ISOLATION CHECK CANCELLED")}>{phase === "guide-check" ? "Cancel setup" : "Stop and change support mode"}</ActionButton>
              </div>
            ) : phase === "success" ? (
              <div className="range-session-result">
                {lastResult ? (
                  <>
                    <div className="range-grade-hero">
                      <div className="range-grade-mark">
                        <span>ATTEMPT GRADE</span>
                        <strong>{lastResult.grade.letter}</strong>
                        <b>{lastResult.grade.score}<small>/100</small></b>
                      </div>
                      <div>
                        <Eyebrow>{lastResult.note} earned · {holdSeconds.toFixed(1)} second hold</Eyebrow>
                        <h2 id="range-session-title">{lastResult.grade.label}</h2>
                        <p>{gradeCoaching(lastResult, effectiveToleranceCents)}</p>
                      </div>
                    </div>

                    <div className="range-grade-metrics">
                      <div><span>Pitch center</span><strong>{lastResult.medianErrorCents == null ? "—" : `${signed(lastResult.medianErrorCents, 1)}¢`}</strong><small>{lastResult.grade.centerScore.toFixed(0)} / 100</small></div>
                      <div><span>Stability</span><strong>{lastResult.stabilityCents == null ? "—" : `${lastResult.stabilityCents.toFixed(1)}¢`}</strong><small>{lastResult.grade.stabilityScore.toFixed(0)} / 100</small></div>
                      <div><span>Time to lock</span><strong>{(lastResult.timeToAcquireMs / 1_000).toFixed(1)}s</strong><small>{lastResult.grade.acquisitionScore.toFixed(0)} / 100</small></div>
                      <div><span>Restarts</span><strong>{lastResult.resetCount}</strong><small>{lastResult.grade.continuityScore.toFixed(0)} / 100</small></div>
                    </div>

                    <fieldset className="range-grade-observation">
                      <legend>What did the detector miss? <small>Optional · saved to your vocal profile</small></legend>
                      <div>
                        <button type="button" aria-pressed={lastCleanMarked} onClick={() => toggleLastObservation("clean")}>Clean &amp; stable</button>
                        <button type="button" aria-pressed={lastAccuracyMarked} disabled={lastResult.midi === profile.baseline.midi && !lastAccuracyMarked} onClick={() => toggleLastObservation("accuracy")}>Accuracy felt harder</button>
                        <button type="button" aria-pressed={lastShiftMarker?.ascending === true} onClick={() => toggleLastShift("ascending")}>Register shift ↑</button>
                        <button type="button" aria-pressed={lastShiftMarker?.descending === true} onClick={() => toggleLastShift("descending")}>Register shift ↓</button>
                      </div>
                    </fieldset>

                    <div className="range-result-next" role="status" aria-live="polite">
                      <Icon name="loop" size={19} />
                      <span><b>{advanceAvailable ? "Release heard · next note ready." : "Release and breathe."}</b><small>{advanceAvailable ? "Your grade stays here until you choose to continue." : "Next unlocks after the microphone hears a clean release."}</small></span>
                      <ActionButton className="primary" disabled={!advanceAvailable} onClick={continueAfterGrade}>Next · {nextMidi == null ? "next family" : noteLabel(nextMidi)} <Icon name="arrow" size={15} /></ActionButton>
                    </div>
                  </>
                ) : (
                  <div className="range-session-connecting"><Eyebrow>Note earned</Eyebrow><h2 id="range-session-title">Calculating your result…</h2></div>
                )}
              </div>
            ) : phase === "transition" ? (
              <div className="range-session-transition">
                <span><Icon name="arrow" size={32} /></span>
                <Eyebrow>Target updated</Eyebrow>
                <h2 id="range-session-title">Release your voice. The next note is queued.</h2>
                <p>{status}</p>
                <strong>{nextMidi == null ? "NEXT FAMILY" : noteLabel(nextMidi)}</strong>
              </div>
            ) : (
              <div className="range-session-trainer">
                <div className="range-session-target-row">
                  <div className="range-session-guide-card">
                    <span>AUDIBLE GUIDE</span>
                    <strong>{support.guideMidi === null ? "prompt only" : noteLabel(support.guideMidi)}</strong>
                    <small>{support.guideMidi === null ? "silence while you sing" : `${continuousMidiToHz(support.guideMidi).toFixed(1)} Hz · headphones`}</small>
                  </div>
                  <div className="range-session-target" aria-label={`Target ${noteLabel(targetMidi)}`}>
                    <span>YOUR TARGET</span>
                    <strong>{noteLabel(targetMidi)}</strong>
                    <small>{continuousMidiToHz(targetMidi).toFixed(2)} Hz</small>
                  </div>
                  <div className="range-session-next-card">
                    <span>UP NEXT</span>
                    <strong>{nextMidi == null ? "family" : noteLabel(nextMidi)}</strong>
                    <small>{passedMidis.size}/{trainableTargetCount} held this lap</small>
                  </div>
                </div>

                <NoteInput
                  variant="target"
                  input={input}
                  targetMidi={targetMidi}
                  toleranceCents={effectiveToleranceCents}
                  phase={phase === "prompting" ? "prompting" : phase === "listening" ? "listening" : "idle"}
                  hold={{
                    heldSeconds: trackerView?.heldSeconds ?? 0,
                    requiredSeconds: holdSeconds,
                    status: trackerView?.inGrace
                        ? "paused"
                        : locked
                          ? "holding"
                          : "waiting",
                  }}
                  diagnosticsFlow="range-loop"
                />

                <div className="range-session-family-strip" role="list" aria-label={`${family.label} family progress`}>
                  {familyTargets.map((midi) => {
                    const state = passedMidis.has(midi) ? "held" : parkedMidis.has(midi) ? "outside current range" : midi === targetMidi ? "current target" : "pending";
                    return <span role="listitem" aria-label={`${noteLabel(midi)}, ${state}`} key={midi} className={`${passedMidis.has(midi) ? "passed" : ""} ${parkedMidis.has(midi) ? "parked" : ""} ${midi === targetMidi ? "current" : ""}`}><b>{noteLabel(midi)}</b><i /></span>;
                  })}
                </div>

                <div className="range-session-actions">
                  <ActionButton disabled={phase !== "listening"} onClick={replayTarget}><Icon name="play" size={16} /> Replay target</ActionButton>
                  <ActionButton disabled={phase !== "listening"} onClick={deferTarget}>Try later</ActionButton>
                  <ActionButton disabled={phase !== "listening"} onClick={parkTarget}>Outside my range</ActionButton>
                  <ActionButton className="coral" onClick={() => stopLoop()}><Icon name="pause" size={16} /> Stop &amp; review</ActionButton>
                </div>

                <div className="range-session-privacy"><Icon name="record" size={15} /><span>No raw voice audio sent or saved · derived pitch diagnostics active · {resetCount} {resetCount === 1 ? "hold reset" : "hold resets"} on this note</span></div>
              </div>
            )}
      </WorkflowDialog>
    </div>
  );
}
