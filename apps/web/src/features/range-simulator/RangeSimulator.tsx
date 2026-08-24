import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { YinPitchFrame } from "@noteforge/pitch-engine";
import { useAudioInput } from "@/audio/use-audio-input";
import { playTone, type ActiveVoice } from "@/audio/synth";
import { useLab } from "@/state/LabContext";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import { getSetting, setSettings } from "@/storage/database";
import { ActionButton, Eyebrow, Panel, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { WorkflowDialog, type WorkflowStep } from "@/ui/workflow";
import {
  DEFAULT_BASELINE_MIDI,
  VOCAL_PROFILE_STORAGE_KEY,
  createDefaultRangeProfile,
  normalizeRangeProfile,
  type PersonalRangeProfile,
} from "@/features/range-loop/profile";
import { queueRangeLoopHandoff } from "@/features/range-loop/handoff";
import {
  createSustainTracker,
  updateSustainTracker,
  type SustainTrackerState,
} from "@/features/range-loop/model";
import { pitchDiagnostics } from "@/diagnostics/pitch-diagnostics";
import {
  EFFORT_RATING_LABELS,
  RANGE_SIMULATOR_MAX_MIDI,
  RANGE_SIMULATOR_MAX_RATED_PROBES,
  RANGE_SIMULATOR_MIN_MIDI,
  createRangeSimulatorSession,
  currentRangeSimulatorProbe,
  normalizeRangeSimulatorSession,
  projectRangeSimulatorProfile,
  rateRangeSimulatorProbe,
  stopRangeSimulatorSession,
  summarizeRangeSimulatorSession,
  type EffortRating,
  type ProbeDirection,
  type ProbeSideState,
  type ProbeTask,
  type RangePreparation,
  type RangeSimulatorSessionState,
} from "./model";

const RANGE_SIMULATOR_STORAGE_KEY = "hum.range-simulator";
const PROMPT_SECONDS = 1.35;
const PROMPT_SETTLE_MS = 260;
const ATTEMPT_HOLD_SECONDS = 1.5;
const MINIMUM_CONFIDENCE = 0.58;
const RATING_VALUES = [1, 2, 3, 4, 5] as const;
const TRAINABLE_MIDIS = Array.from(
  { length: RANGE_SIMULATOR_MAX_MIDI - RANGE_SIMULATOR_MIN_MIDI + 1 },
  (_, index) => RANGE_SIMULATOR_MIN_MIDI + index,
);
const RANGE_ASSESSMENT_STEPS = [
  { id: "home", label: "Find home", detail: "Nearby comparisons" },
  { id: "range", label: "Map outward", detail: "Adaptive chromatic probes" },
  { id: "profile", label: "Review", detail: "Current voice map" },
] as const satisfies readonly WorkflowStep[];

type PersistenceState = "loading" | "saving" | "saved" | "error";
type AttemptPhase = "ready" | "prompting" | "listening" | "rating";

function createFreshSession(anchorMidi: number, preparation: RangePreparation): RangeSimulatorSessionState {
  const startedAt = new Date().toISOString();
  return createRangeSimulatorSession({
    anchorMidi,
    preparation,
    startedAt,
    sessionId: `range-map-${startedAt}`,
  });
}

function formatBounds(bounds: { lowMidi: number | null; highMidi: number | null }): string {
  if (bounds.lowMidi === null || bounds.highMidi === null) return "Not established yet";
  if (bounds.lowMidi === bounds.highMidi) return noteLabel(bounds.lowMidi);
  return `${noteLabel(bounds.lowMidi)} → ${noteLabel(bounds.highMidi)}`;
}

function formatEdges(edges: { lowMidi: number | null; highMidi: number | null }): string {
  if (edges.lowMidi === null && edges.highMidi === null) return "Not encountered";
  return `${edges.lowMidi === null ? "—" : noteLabel(edges.lowMidi)} / ${edges.highMidi === null ? "—" : noteLabel(edges.highMidi)}`;
}

function directionLabel(direction: ProbeDirection): string {
  if (direction === "ascending") return "moving upward";
  if (direction === "descending") return "moving downward";
  return "home reference";
}

function taskLabel(task: ProbeTask): string {
  if (task.kind === "baseline-candidate") return "home comparison";
  if (task.kind === "retest") return task.direction === "center" ? "home recheck" : "boundary recheck";
  if (task.kind === "expansion") return "adaptive expansion";
  return task.direction === "center" ? "home confirmation" : "first chromatic band";
}

function preparationLabel(preparation: RangePreparation): string {
  if (preparation === "unwarmed") return "No targeted warm-up";
  if (preparation === "light-warmup") return "Light warm-up";
  return "Warmed up";
}

function sidePresentation(side: ProbeSideState | null): { className: string; title: string; detail: string } {
  if (!side) return { className: "", title: "Waiting for baseline", detail: "The search has not started." };
  if (side.status === "open") return { className: "open", title: "Open", detail: "The next safe chromatic step is queued." };
  if (side.status === "awaiting-retest") return { className: "retest", title: "Recheck queued", detail: `One rested recheck at ${noteLabel(side.pendingRetestMidi!)}.` };
  if (side.status === "incomplete") return { className: "partial", title: "Not finished", detail: "This check ended before the direction reached a reported boundary." };
  if (side.status === "capped") return { className: "closed", title: "Protocol cap", detail: "The C2–B5 map boundary was reached." };
  if (side.status === "closed-unreliable") return { className: "closed", title: "Closed today", detail: "A 5 stopped farther probes in this direction." };
  return { className: "closed", title: "Closed today", detail: "The boundary stayed unstable on recheck." };
}

function semitoneRelation(midi: number, baselineMidi: number | null, anchorMidi: number): string {
  if (baselineMidi === null) {
    if (midi === anchorMidi) return "starting comparison anchor";
    const anchorDistance = midi - anchorMidi;
    return `${Math.abs(anchorDistance)} semitone${Math.abs(anchorDistance) === 1 ? "" : "s"} ${anchorDistance > 0 ? "above" : "below"} starting anchor ${noteLabel(anchorMidi)}`;
  }
  if (midi === baselineMidi) return "at the working home note";
  const distance = midi - baselineMidi;
  return `${Math.abs(distance)} semitone${Math.abs(distance) === 1 ? "" : "s"} ${distance > 0 ? "above" : "below"} ${noteLabel(baselineMidi)}`;
}

function completionTitle(session: Readonly<RangeSimulatorSessionState>): string {
  if (session.completionStatus === "no-usable-baseline") return "No comfortable home was assumed.";
  if (session.completionStatus === "probe-cap") return "Today’s probe budget is complete.";
  if (session.completionStatus === "complete") return "Both directions are mapped for today.";
  return "A useful partial check is complete.";
}

export function RangeSimulator() {
  const { setView, setSelectedMidi, setCentsOffset, timbre, toleranceCents } = useLab();
  const fallbackSessionRef = useRef<RangeSimulatorSessionState | null>(null);
  if (fallbackSessionRef.current === null) {
    fallbackSessionRef.current = createFreshSession(DEFAULT_BASELINE_MIDI, "unwarmed");
  }

  const [session, setSession] = useState<RangeSimulatorSessionState>(fallbackSessionRef.current);
  const [profile, setProfile] = useState<PersonalRangeProfile>(createDefaultRangeProfile);
  const [rating, setRating] = useState<EffortRating | null>(null);
  const [coordinationChange, setCoordinationChange] = useState(false);
  const [attemptedTaskId, setAttemptedTaskId] = useState<number | null>(null);
  const [workflowStarted, setWorkflowStarted] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [rangeProposalAccepted, setRangeProposalAccepted] = useState(false);
  const [attemptPhase, setAttemptPhase] = useState<AttemptPhase>("ready");
  const [trackerView, setTrackerView] = useState<SustainTrackerState | null>(null);
  const [notice, setNotice] = useState("Compare the nearby notes; the algorithm will choose the easiest repeatable center.");
  const [hydrated, setHydrated] = useState(false);
  const [simulatorStorageReady, setSimulatorStorageReady] = useState(false);
  const [profileStorageReady, setProfileStorageReady] = useState(false);
  const [persistenceState, setPersistenceState] = useState<PersistenceState>("loading");

  const voiceRef = useRef<ActiveVoice | null>(null);
  const setupHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const currentHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const profileHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusNextProbeRef = useRef(false);
  const guideTimerRef = useRef<number | null>(null);
  const deferredAttemptTimerRef = useRef<number | null>(null);
  const audioGenerationRef = useRef(0);
  // Microphone permission/connection has a lifecycle independent from prompt
  // tone playback. A workflow rerender may correctly cancel a tone without
  // invalidating the in-flight getUserMedia result.
  const microphoneConnectionRef = useRef(0);
  const attemptActiveRef = useRef(false);
  const attemptTaskRef = useRef<{ id: number; midi: number } | null>(null);
  const trackerRef = useRef<SustainTrackerState | null>(null);
  const onFrameRef = useRef<(frame: YinPitchFrame) => void>(() => undefined);
  const beginAttemptRef = useRef<() => void>(() => undefined);
  const autoPromptNextRef = useRef(false);
  const persistenceChainRef = useRef<Promise<void>>(Promise.resolve());
  const persistenceMountedRef = useRef(true);
  const persistenceWriteRef = useRef(0);
  const navigationGenerationRef = useRef(0);

  const input = useAudioInput({
    diagnostics: {
      flow: "range-simulator",
      phase: connecting ? "connecting" : attemptPhase,
      targetMidi: attemptTaskRef.current?.midi ?? null,
      toleranceCents,
      stableMs: (trackerView?.heldSeconds ?? 0) * 1_000,
      requiredHoldMs: ATTEMPT_HOLD_SECONDS * 1_000,
      resetReason: trackerView?.inGrace ? "hold-preserved-unvoiced" : null,
    },
    onFrame: (frame) => onFrameRef.current(frame),
  });
  const inputRef = useRef(input);
  inputRef.current = input;

  const currentProbe = currentRangeSimulatorProbe(session);
  const summary = useMemo(() => summarizeRangeSimulatorSession(session), [session]);
  const currentBaselineIndex = currentProbe?.kind === "baseline-candidate"
    ? session.baselineCandidates.indexOf(currentProbe.midi)
    : -1;
  const step = session.phase === "baseline" ? 1 : session.phase === "probing" ? 2 : 3;

  useEffect(() => {
    pitchDiagnostics.record("range-simulator", {
      kind: "workflow",
      workflow: {
        phase: attemptPhase,
        state: connecting ? "connecting" : workflowStarted ? session.phase : "idle",
        targetMidi: currentProbe?.midi ?? null,
        attemptId: currentProbe?.id ?? null,
        holdMs: (trackerView?.heldSeconds ?? 0) * 1_000,
        requiredHoldMs: ATTEMPT_HOLD_SECONDS * 1_000,
        resetReason: trackerView?.inGrace ? "detector-evidence-grace" : null,
      },
    });
  }, [attemptPhase, connecting, currentProbe?.id, currentProbe?.midi, session.phase, trackerView?.inGrace, workflowStarted]);

  const stopTone = useCallback(() => {
    audioGenerationRef.current += 1;
    voiceRef.current?.stop(0.06);
    voiceRef.current = null;
    if (guideTimerRef.current !== null) window.clearTimeout(guideTimerRef.current);
    guideTimerRef.current = null;
    if (deferredAttemptTimerRef.current !== null) window.clearTimeout(deferredAttemptTimerRef.current);
    deferredAttemptTimerRef.current = null;
    attemptActiveRef.current = false;
  }, []);

  const leaveWorkflowForInput = useCallback((message: string) => {
    stopTone();
    autoPromptNextRef.current = false;
    setRating(null);
    setCoordinationChange(false);
    setAttemptedTaskId(null);
    setAttemptPhase("ready");
    setTrackerView(null);
    trackerRef.current = null;
    attemptTaskRef.current = null;
    setWorkflowStarted(false);
    setConnecting(false);
    setNotice(message);
  }, [stopTone]);

  const beginTargetAttempt = useCallback(async () => {
    if (!currentProbe) return;
    if (input.state !== "running") {
      leaveWorkflowForInput("Reconnect the microphone before hearing or scoring another target.");
      return;
    }
    stopTone();
    const startGeneration = audioGenerationRef.current;
    setRating(null);
    setCoordinationChange(false);
    setAttemptedTaskId(null);
    setTrackerView(null);
    trackerRef.current = null;
    attemptTaskRef.current = { id: currentProbe.id, midi: currentProbe.midi };
    setAttemptPhase("prompting");
    setNotice(`Listen to ${noteLabel(currentProbe.midi)}. Live detection remains visible; exercise scoring begins after the prompt.`);

    const microphone = await input.enable();
    if (!persistenceMountedRef.current || startGeneration !== audioGenerationRef.current) return;
    if (!microphone || attemptTaskRef.current?.id !== currentProbe.id) {
      setAttemptPhase("ready");
      setNotice(input.error || "The microphone is needed before this note can be measured.");
      return;
    }
    if (inputRef.current.state !== "running") {
      leaveWorkflowForInput("The microphone is not available. Reconnect it and continue from this target.");
      return;
    }

    const generation = audioGenerationRef.current;
    setSelectedMidi(currentProbe.midi);
    setCentsOffset(0);
    try {
      const voice = await playTone({
        frequencyHz: continuousMidiToHz(currentProbe.midi),
        timbre,
        duration: PROMPT_SECONDS,
        amplitude: 0.27,
        release: 0.12,
      });
      if (generation !== audioGenerationRef.current) {
        voice.stop();
        return;
      }
      voiceRef.current = voice;
      guideTimerRef.current = window.setTimeout(() => {
        if (generation !== audioGenerationRef.current) return;
        if (inputRef.current.state !== "running") {
          leaveWorkflowForInput("The microphone disconnected before listening began. Reconnect it and retry this target.");
          return;
        }
        voiceRef.current?.stop(0.04);
        voiceRef.current = null;
        guideTimerRef.current = null;
        trackerRef.current = null;
        setTrackerView(null);
        attemptActiveRef.current = true;
        setAttemptPhase("listening");
        setNotice(`Your turn. Hold ${noteLabel(currentProbe.midi)} inside the ±${toleranceCents}¢ lane for ${ATTEMPT_HOLD_SECONDS.toFixed(1)} seconds, or use an honest unstable/unable exit.`);
      }, PROMPT_SECONDS * 1_000 + PROMPT_SETTLE_MS);
    } catch {
      if (!persistenceMountedRef.current || generation !== audioGenerationRef.current) return;
      attemptActiveRef.current = false;
      setAttemptPhase("ready");
      setNotice("The tone could not start. Check browser audio permission, then try again; no rating was changed.");
    }
  }, [currentProbe, input, leaveWorkflowForInput, setCentsOffset, setSelectedMidi, stopTone, timbre, toleranceCents]);

  beginAttemptRef.current = () => { void beginTargetAttempt(); };

  const scheduleAttempt = useCallback((delayMs: number) => {
    if (deferredAttemptTimerRef.current !== null) {
      window.clearTimeout(deferredAttemptTimerRef.current);
    }
    deferredAttemptTimerRef.current = window.setTimeout(() => {
      deferredAttemptTimerRef.current = null;
      if (persistenceMountedRef.current) beginAttemptRef.current();
    }, delayMs);
  }, []);

  onFrameRef.current = (frame) => {
    const task = attemptTaskRef.current;
    if (!attemptActiveRef.current || !task || task.id !== currentProbe?.id) return;
    if (inputRef.current.state !== "running") {
      leaveWorkflowForInput("The microphone disconnected before scoring could continue. Reconnect it, then retry this note.");
      return;
    }
    const previous = trackerRef.current ?? createSustainTracker({
      targetMidi: task.midi,
      requiredHoldSeconds: ATTEMPT_HOLD_SECONDS,
      toleranceCents,
      listeningStartedAtSeconds: frame.timeSeconds,
      minimumConfidence: MINIMUM_CONFIDENCE,
      graceSeconds: 0.22,
    });
    const next = updateSustainTracker(previous, frame);
    trackerRef.current = next;
    setTrackerView(next);
    if (next.status !== "complete") return;
    attemptActiveRef.current = false;
    setAttemptedTaskId(task.id);
    setAttemptPhase("rating");
    setNotice(`${noteLabel(task.midi)} held. Now rate comfort and repeatability; the meter does not decide how the note felt.`);
  };

  const revealEscapeRating = useCallback((value: 4 | 5) => {
    if (!currentProbe || attemptPhase !== "listening") return;
    if (input.state !== "running") {
      leaveWorkflowForInput("Reconnect the microphone before recording this result.");
      return;
    }
    attemptActiveRef.current = false;
    setAttemptedTaskId(currentProbe.id);
    setRating(value);
    setAttemptPhase("rating");
    setNotice(value === 4
      ? `${noteLabel(currentProbe.midi)} opened as unstable. Confirm or change the rating below.`
      : `${noteLabel(currentProbe.midi)} opened as not reliably producible today. Confirm or change the rating below.`);
  }, [attemptPhase, currentProbe, input.state, leaveWorkflowForInput]);

  const queuePersistence = useCallback((entries: readonly { key: string; value: unknown }[]) => {
    if (entries.length === 0) return;
    const writeId = ++persistenceWriteRef.current;
    setPersistenceState("saving");
    persistenceChainRef.current = persistenceChainRef.current
      .catch(() => undefined)
      .then(() => setSettings(entries))
      .then(() => {
        if (persistenceMountedRef.current && writeId === persistenceWriteRef.current) setPersistenceState("saved");
      })
      .catch(() => {
        if (persistenceMountedRef.current && writeId === persistenceWriteRef.current) {
          setPersistenceState("error");
          setNotice("The local save did not complete. This check is still visible in memory; do not close the page if you want to copy its result.");
        }
      });
  }, []);

  const commitSession = useCallback((nextSession: RangeSimulatorSessionState, nextProfile?: PersonalRangeProfile) => {
    setSession(nextSession);
    if (nextProfile) setProfile(nextProfile);
    const entries = [
      ...(simulatorStorageReady ? [{ key: RANGE_SIMULATOR_STORAGE_KEY, value: nextSession }] : []),
      ...(nextProfile && profileStorageReady ? [{ key: VOCAL_PROFILE_STORAGE_KEY, value: nextProfile }] : []),
    ];
    queuePersistence(entries);
  }, [profileStorageReady, queuePersistence, simulatorStorageReady]);

  const completeAndProject = useCallback((completedSession: RangeSimulatorSessionState) => {
    microphoneConnectionRef.current += 1;
    const nextProfile = projectRangeSimulatorProfile(profile, completedSession);
    setWorkflowStarted(false);
    setConnecting(false);
    setAttemptPhase("ready");
    setTrackerView(null);
    trackerRef.current = null;
    attemptTaskRef.current = null;
    commitSession(completedSession, nextProfile);
    const completeSummary = summarizeRangeSimulatorSession(completedSession);
    setNotice(completeSummary.usableBounds.lowMidi === null
      ? "The check is complete without claiming a usable boundary. Try a different home area when you are ready."
      : `Range check complete. Today’s self-rated usable span is ${formatBounds(completeSummary.usableBounds)}.`);
  }, [commitSession, profile]);

  const submitRating = useCallback(() => {
    if (!currentProbe || rating === null || attemptedTaskId !== currentProbe.id || attemptPhase !== "rating") return;
    if (input.state !== "running") {
      leaveWorkflowForInput("The microphone disconnected before this result was saved. Reconnect it, then repeat the note.");
      return;
    }
    stopTone();
    try {
      const next = rateRangeSimulatorProbe(session, {
        taskId: currentProbe.id,
        rating,
        coordinationChange,
        ratedAt: new Date().toISOString(),
      });
      const ratedNote = noteLabel(currentProbe.midi);
      setRating(null);
      setCoordinationChange(false);
      setAttemptedTaskId(null);
      setAttemptPhase("ready");
      setTrackerView(null);
      trackerRef.current = null;
      attemptTaskRef.current = null;
      if (next.phase === "complete") {
        completeAndProject(next);
      } else {
        focusNextProbeRef.current = true;
        commitSession(next);
        const nextProbe = currentRangeSimulatorProbe(next);
        if (currentProbe.kind === "baseline-candidate") {
          setNotice(next.phase === "probing"
            ? `The comparisons point to ${noteLabel(next.baselineMidi!)} as today’s candidate home. Review the proposed first range before the map opens outward.`
            : `${ratedNote} comparison saved as ${EFFORT_RATING_LABELS[rating].label.toLowerCase()}. ${nextProbe ? `${noteLabel(nextProbe.midi)} is next.` : "The comparisons are ready to review."}`);
        } else if (rating === 4 && currentProbe.direction === "center") {
          setNotice(`${ratedNote} was unstable on confirmation. One immediate home recheck is next before the map opens outward.`);
        } else if (currentProbe.direction === "center") {
          setNotice(`${ratedNote} confirmed as today’s working baseline. ${nextProbe ? `${noteLabel(nextProbe.midi)} begins the outward map.` : "The map is ready to review."}`);
        } else if (rating === 4 && (currentProbe.kind === "retest" || currentProbe.attempt === 1)) {
          setNotice(`${ratedNote} remained unstable on recheck, so that direction is closed for today. ${nextProbe ? `${noteLabel(nextProbe.midi)} is next.` : "The map is ready to review."}`);
        } else if (rating === 4) {
          setNotice(`${ratedNote} was marked unstable. Farther notes on that side were paused and one recheck was queued after the other direction.`);
        } else if (rating === 5) {
          setNotice(`${ratedNote} closed that direction for today. ${nextProbe ? `${noteLabel(nextProbe.midi)} is next.` : "The map is ready to review."}`);
        } else {
          setNotice(`${ratedNote} saved as ${EFFORT_RATING_LABELS[rating].label.toLowerCase()}. ${nextProbe ? `${noteLabel(nextProbe.midi)} is next.` : "The map is ready to review."}`);
        }
        autoPromptNextRef.current = session.phase === next.phase;
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That rating could not be saved.");
    }
  }, [attemptPhase, attemptedTaskId, commitSession, completeAndProject, coordinationChange, currentProbe, input.state, leaveWorkflowForInput, rating, session, stopTone]);

  const finishToday = useCallback(() => {
    stopTone();
    try {
      completeAndProject(stopRangeSimulatorSession(session, new Date().toISOString()));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "This check could not be stopped cleanly.");
    }
  }, [completeAndProject, session, stopTone]);

  const openEndlessLoop = useCallback(async (baselineMidi: number) => {
    const navigationGeneration = ++navigationGenerationRef.current;
    await persistenceChainRef.current.catch(() => undefined);
    if (
      !persistenceMountedRef.current
      || navigationGeneration !== navigationGenerationRef.current
    ) return;
    queueRangeLoopHandoff(baselineMidi);
    setSelectedMidi(baselineMidi);
    setCentsOffset(0);
    setView("loop");
  }, [setCentsOffset, setSelectedMidi, setView]);

  const startFresh = useCallback((anchorMidi = profile.baseline.midi, preparation = session.preparation) => {
    navigationGenerationRef.current += 1;
    microphoneConnectionRef.current += 1;
    stopTone();
    const next = createFreshSession(anchorMidi, preparation);
    focusNextProbeRef.current = true;
    setRating(null);
    setCoordinationChange(false);
    setAttemptedTaskId(null);
    setWorkflowStarted(false);
    setConnecting(false);
    setRangeProposalAccepted(false);
    setAttemptPhase("ready");
    setTrackerView(null);
    trackerRef.current = null;
    attemptTaskRef.current = null;
    autoPromptNextRef.current = false;
    setNotice("Fresh home comparison ready. Nothing from the earlier shared voice map was deleted.");
    commitSession(next);
  }, [commitSession, profile.baseline.midi, session.preparation, stopTone]);

  const continueConnectedWorkflow = useCallback(() => {
    if (!currentProbe) return;
    const hasMappedProbe = session.observations.some((observation) => observation.task.kind !== "baseline-candidate");
    if (session.phase === "probing" && !hasMappedProbe && !rangeProposalAccepted) {
      setNotice(`Microphone ready. Review the first proposed span around ${noteLabel(session.baselineMidi!)}.`);
      return;
    }
    setNotice(`Microphone ready. ${noteLabel(currentProbe.midi)} is the only task now.`);
    scheduleAttempt(120);
  }, [currentProbe, rangeProposalAccepted, scheduleAttempt, session]);

  const startWorkflow = useCallback(async () => {
    if (!hydrated || !currentProbe || connecting) return;
    stopTone();
    const connectionRequest = ++microphoneConnectionRef.current;
    setConnecting(true);
    setWorkflowStarted(true);
    setNotice("Connecting the microphone. No raw voice waveform is saved; derived pitch diagnostics are sent to this NoteForge server.");
    const microphone = await input.enable();
    if (!persistenceMountedRef.current || connectionRequest !== microphoneConnectionRef.current) return;
    setConnecting(false);
    if (!microphone) {
      setWorkflowStarted(false);
      setNotice(inputRef.current.error || "Microphone access is required for the guided range check.");
      return;
    }
    continueConnectedWorkflow();
  }, [connecting, continueConnectedWorkflow, currentProbe, hydrated, input, stopTone]);

  const acceptRangeProposal = useCallback(() => {
    if (input.state !== "running") {
      leaveWorkflowForInput("Reconnect the microphone before beginning the proposed range.");
      return;
    }
    setRangeProposalAccepted(true);
    setNotice(`Starting at ${noteLabel(currentProbe?.midi ?? session.baselineMidi!)}. The bounds will adjust after every rating.`);
    scheduleAttempt(120);
  }, [currentProbe?.midi, input.state, leaveWorkflowForInput, scheduleAttempt, session.baselineMidi]);

  useEffect(() => {
    let cancelled = false;
    const fallbackStartedAt = fallbackSessionRef.current!.startedAt;
    void Promise.allSettled([
      getSetting<RangeSimulatorSessionState>(RANGE_SIMULATOR_STORAGE_KEY),
      getSetting<PersonalRangeProfile>(VOCAL_PROFILE_STORAGE_KEY),
    ]).then(([sessionResult, profileResult]) => {
      if (cancelled) return;
      const sessionReadable = sessionResult.status === "fulfilled";
      const profileReadable = profileResult.status === "fulfilled";
      const restoredProfile = normalizeRangeProfile(profileReadable ? profileResult.value : undefined);
      const restoredSession = normalizeRangeSimulatorSession(
        sessionReadable ? sessionResult.value : undefined,
        {
          anchorMidi: restoredProfile.baseline.midi,
          preparation: "unwarmed",
          startedAt: fallbackStartedAt,
          sessionId: `range-map-${fallbackStartedAt}`,
        },
      );
      setSimulatorStorageReady(sessionReadable);
      setProfileStorageReady(profileReadable);
      setProfile(restoredProfile);
      setSession(restoredSession);
      setPersistenceState(sessionReadable && profileReadable ? "saved" : "error");
      if (restoredSession.phase === "complete") {
        const restoredSummary = summarizeRangeSimulatorSession(restoredSession);
        setNotice(restoredSummary.usableBounds.lowMidi === null
          ? "This saved check did not assume a usable baseline. Start another comparison when you are ready."
          : `Local range check restored. Its self-rated usable span is ${formatBounds(restoredSummary.usableBounds)}.`);
      } else if (restoredSession.ratedProbeCount > 0) {
        const restoredProbe = currentRangeSimulatorProbe(restoredSession);
        setNotice(restoredProbe
          ? `Check restored at ${noteLabel(restoredProbe.midi)}. Hear the target again before adding the next rating.`
          : "Partial check restored.");
      }
      if (!sessionReadable || !profileReadable) {
        setNotice("Local storage is limited. You can continue this check, but the unavailable record will not be overwritten.");
      }
      if (restoredSession.phase !== "complete") {
        const restoredProbe = currentRangeSimulatorProbe(restoredSession);
        if (restoredProbe) {
          setSelectedMidi(restoredProbe.midi);
          setCentsOffset(0);
        }
      }
    }).catch(() => {
      if (cancelled) return;
      setPersistenceState("error");
      setNotice("Local storage is unavailable. This check can continue in memory for the current page visit.");
    }).finally(() => {
      if (!cancelled) setHydrated(true);
    });
    return () => { cancelled = true; };
  }, [setCentsOffset, setSelectedMidi]);

  useEffect(() => {
    if (!currentProbe) return;
    stopTone();
    setAttemptedTaskId(null);
    setAttemptPhase("ready");
    setTrackerView(null);
    trackerRef.current = null;
    attemptTaskRef.current = null;
    setSelectedMidi(currentProbe.midi);
    setCentsOffset(0);
    let promptTimer: number | null = null;
    if (workflowStarted && autoPromptNextRef.current) {
      autoPromptNextRef.current = false;
      if (inputRef.current.state === "running") {
        promptTimer = window.setTimeout(() => beginAttemptRef.current(), 520);
      } else {
        leaveWorkflowForInput("The next prompt is paused because the microphone disconnected. Reconnect it to continue.");
      }
    }
    const animationFrame = focusNextProbeRef.current
      ? window.requestAnimationFrame(() => currentHeadingRef.current?.focus())
      : null;
    focusNextProbeRef.current = false;
    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      if (promptTimer !== null) window.clearTimeout(promptTimer);
    };
  }, [currentProbe?.id, currentProbe?.midi, leaveWorkflowForInput, setCentsOffset, setSelectedMidi, stopTone, workflowStarted]);

  useEffect(() => {
    if (!workflowStarted || connecting || session.phase === "complete") return;
    if (input.state === "running") return;
    leaveWorkflowForInput(input.state === "error"
      ? input.error || "The microphone disconnected. Reconnect it before replaying this target."
      : "The microphone is no longer available. Reconnect it before continuing.");
  }, [connecting, input.error, input.state, leaveWorkflowForInput, session.phase, workflowStarted]);

  useEffect(() => {
    if (!hydrated || session.phase !== "complete") return;
    const animationFrame = window.requestAnimationFrame(() => profileHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [hydrated, session.phase]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!hydrated || !currentProbe || attemptedTaskId !== currentProbe.id || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("select, textarea, button, input:not([name='range-effort-rating'])")) return;
      const numeric = Number(event.key);
      if (RATING_VALUES.includes(numeric as EffortRating)) {
        setRating(numeric as EffortRating);
        setNotice(`${numeric} · ${EFFORT_RATING_LABELS[numeric as EffortRating].label} selected. Save when that matches how the note felt.`);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [attemptedTaskId, currentProbe, hydrated]);

  useEffect(() => {
    persistenceMountedRef.current = true;
    return () => {
      persistenceMountedRef.current = false;
      microphoneConnectionRef.current += 1;
      navigationGenerationRef.current += 1;
      stopTone();
    };
  }, [stopTone]);

  const latestByMidi = useMemo(() => {
    const latest = new Map<number, typeof session.observations[number]>();
    for (const observation of session.observations) latest.set(observation.task.midi, observation);
    return latest;
  }, [session.observations]);
  const displayedMidis = [...latestByMidi.keys()].sort((left, right) => left - right);
  const ascendingPresentation = sidePresentation(session.ascending);
  const descendingPresentation = sidePresentation(session.descending);
  const baselineConfirmed = summary.baselineMidi !== null && summary.usableMidis.includes(summary.baselineMidi);
  const persistenceLabel = !hydrated
    ? "Loading local check"
    : persistenceState === "saving"
      ? "Saving locally"
      : persistenceState === "saved"
        ? "Saved locally"
        : "Local save limited";
  const completionPersistenceLabel = persistenceState === "saving"
    ? "SAVING TODAY’S SNAPSHOT"
    : persistenceState === "saved"
      ? "TODAY’S SNAPSHOT SAVED"
      : "TODAY’S SNAPSHOT · LOCAL SAVE LIMITED";
  const progressLabel = session.phase === "baseline"
    ? `HOME ${Math.max(1, currentBaselineIndex + 1)} OF ${session.baselineCandidates.length}`
    : session.phase === "probing"
      ? `PROBE ${session.ratedProbeCount - session.baselineCandidates.length + 1} · ${session.ratedProbeCount}/${RANGE_SIMULATOR_MAX_RATED_PROBES} TOTAL`
      : "PROFILE READY";

  const hasMappedProbe = session.observations.some((observation) => observation.task.kind !== "baseline-candidate");
  const showingRangeProposal = workflowStarted
    && session.phase === "probing"
    && !hasMappedProbe
    && !rangeProposalAccepted;
  const workflowModalOpen = workflowStarted && session.phase !== "complete" && currentProbe !== null;
  const proposedLowMidi = session.descending?.plannedEdgeMidi ?? session.baselineMidi;
  const proposedHighMidi = session.ascending?.plannedEdgeMidi ?? session.baselineMidi;
  const heldSeconds = attemptPhase === "rating" && trackerView?.status === "complete"
    ? ATTEMPT_HOLD_SECONDS
    : trackerView?.heldSeconds ?? 0;
  const attemptStatus = attemptPhase === "prompting"
    ? "LISTEN · PROMPT NOT SCORED"
    : attemptPhase === "listening"
      ? trackerView?.status === "holding" ? "IN THE LANE · KEEP HOLDING" : "MIC LIVE · FIND THE LANE"
      : attemptPhase === "rating"
        ? "ATTEMPT COMPLETE · RATE THE FEELING"
        : "TARGET READY";

  useEffect(() => {
    if (!workflowModalOpen) return;
    const focusFrame = window.requestAnimationFrame(() => currentHeadingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(focusFrame);
  }, [currentProbe?.id, showingRangeProposal, workflowModalOpen]);

  return (
    <div className="page range-simulator-page">
      <div className="lab-intro range-sim-intro">
        <div>
          <Eyebrow>Start → hear one note → match it on the meter → rate → advance</Eyebrow>
          <h1>A guided range check, one note at a time.</h1>
          <p>The microphone confirms that you reached each target before comfort ratings expand or close the chromatic search. You will never be asked to manage the whole map at once.</p>
        </div>
        <div className="range-sim-status" aria-live="polite" aria-atomic="true">
          <span>{progressLabel}</span>
          <strong>{session.phase === "complete" ? completionPersistenceLabel : !workflowStarted ? "READY TO BEGIN" : connecting ? "OPENING MICROPHONE" : showingRangeProposal ? "RANGE PROPOSAL" : attemptStatus}</strong>
          <small>{preparationLabel(session.preparation)} · no raw audio saved</small>
        </div>
      </div>

      <Panel className="range-sim-steps" aria-label={`Step ${step} of 3`}>
        <ol>
          <li className={step === 1 ? "current" : step > 1 ? "complete" : ""} aria-current={step === 1 ? "step" : undefined}><span>1</span><div><b>Find home</b><small>{session.baselineCandidates.length} nearby comparisons</small></div></li>
          <li className={step === 2 ? "current" : step > 2 ? "complete" : ""} aria-current={step === 2 ? "step" : undefined}><span>2</span><div><b>Map outward</b><small>Chromatic and adaptive</small></div></li>
          <li className={step === 3 ? "current" : ""} aria-current={step === 3 ? "step" : undefined}><span>3</span><div><b>Read the profile</b><small>Today, not forever</small></div></li>
        </ol>
      </Panel>

      {session.phase !== "complete" && currentProbe && !workflowStarted && (
        <Panel className="range-sim-workflow-setup" aria-labelledby="range-sim-setup-title">
          <div className="range-sim-stage-header">
            <div>
              <Eyebrow>{session.ratedProbeCount > 0 ? "Saved check found" : "Before the first tone"}</Eyebrow>
              <h2 id="range-sim-setup-title" ref={setupHeadingRef} tabIndex={-1}>{session.ratedProbeCount > 0 ? `Continue at ${noteLabel(currentProbe.midi)}.` : "Set today’s conditions, then start the guided check."}</h2>
              <p>The microphone opens, then the workflow plays one target, shows the canonical live note and its cents position, and waits for a short in-tune hold before asking how the note felt.</p>
            </div>
            <span className={`range-sim-save-state ${persistenceState === "error" ? "error" : ""}`} role="status" aria-live="polite">{persistenceLabel}</span>
          </div>

          <div className="range-sim-baseline-config">
            <Select label="Starting anchor" value={session.anchorMidi} disabled={!hydrated || session.observations.length > 0 || connecting} onChange={(event) => startFresh(Number(event.target.value), session.preparation)}>{TRAINABLE_MIDIS.map((midi) => <option key={midi} value={midi}>{noteLabel(midi)} · {continuousMidiToHz(midi).toFixed(1)} Hz</option>)}</Select>
            <Select label="Preparation" value={session.preparation} disabled={!hydrated || session.observations.length > 0 || connecting} onChange={(event) => startFresh(session.anchorMidi, event.target.value as RangePreparation)}><option value="unwarmed">No targeted warm-up</option><option value="light-warmup">Light warm-up</option><option value="warmed">Warmed up</option></Select>
          </div>

          <div className="range-sim-setup-contract" aria-label="Guided range-check sequence">
            <div><span>1</span><b>Hear one target</b><small>The prompt ends before measurement begins.</small></div>
            <div><span>2</span><b>Match the meter</b><small>Hold inside ±{toleranceCents}¢ for {ATTEMPT_HOLD_SECONDS.toFixed(1)} seconds.</small></div>
            <div><span>3</span><b>Rate and advance</b><small>Unstable and unable exits prevent impossible notes from trapping you.</small></div>
          </div>

          <div className="range-sim-safety"><Icon name="record" size={18} /><p><b>Use an easy, conversational sound.</b> Stop for pain, worsening discomfort, or fatigue. NoteForge saves ratings locally and sends bounded derived pitch diagnostics to this NoteForge server; raw audio is never sent or saved.</p></div>
          {input.error && <div className="range-sim-input-error"><b>Microphone needs attention</b><span>{input.error}</span></div>}
          <div className="range-sim-setup-actions">
            <small aria-live="polite">{notice}</small>
            <ActionButton className="primary" disabled={!hydrated || connecting} onClick={() => { void startWorkflow(); }}><Icon name={connecting ? "pause" : "mic"} size={18} /> {connecting ? "Connecting microphone…" : session.ratedProbeCount > 0 ? "Continue guided check" : "Start guided range check"}</ActionButton>
          </div>
        </Panel>
      )}

      <WorkflowDialog
        open={workflowModalOpen}
        steps={RANGE_ASSESSMENT_STEPS}
        activeStep={session.phase === "baseline" ? 0 : session.phase === "probing" ? 1 : 2}
        label="Guided vocal range assessment"
        exitLabel="Stop & review"
        onExit={finishToday}
        className={`panel range-sim-workflow-modal ${showingRangeProposal ? "range-sim-proposal" : `attempt-${attemptPhase}`}`}
      >
        {currentProbe && (showingRangeProposal ? <>
          <div className="range-sim-stage-header">
            <div><Eyebrow>Baseline selected · proposed first pass</Eyebrow><h2 id="range-sim-proposal-title" ref={currentHeadingRef} tabIndex={-1}>Start from {noteLabel(session.baselineMidi!)} and test a small chromatic span.</h2><p>Your five comparisons chose the easiest repeatable center. This is a starting search—not a claim about your limits.</p></div>
            <span className={`range-sim-save-state ${persistenceState === "error" ? "error" : ""}`}>{persistenceLabel}</span>
          </div>
          <div className="range-sim-proposed-span">
            <div><span>LOWER FIRST PASS</span><strong>{proposedLowMidi === null ? "—" : noteLabel(proposedLowMidi)}</strong></div>
            <div className="baseline"><span>WORKING HOME</span><strong>{noteLabel(session.baselineMidi!)}</strong><small>{continuousMidiToHz(session.baselineMidi!).toFixed(1)} Hz</small></div>
            <div><span>UPPER FIRST PASS</span><strong>{proposedHighMidi === null ? "—" : noteLabel(proposedHighMidi)}</strong></div>
          </div>
          <p className="range-sim-proposal-copy">Ratings 1–2 expand that side by two notes, 3 expands cautiously by one, 4 schedules a rested recheck, and 5 closes only that direction.</p>
          <div className="range-sim-modal-actions">
            <ActionButton onClick={finishToday}>Stop &amp; review baseline only</ActionButton>
            <ActionButton className="primary" disabled={input.state !== "running"} onClick={acceptRangeProposal}>Begin this range <Icon name="arrow" size={16} /></ActionButton>
          </div>
        </> : <>
          <div className="range-sim-stage-header">
            <div><Eyebrow>{taskLabel(currentProbe)} · {directionLabel(currentProbe.direction)}</Eyebrow><h2 id="range-sim-current-title" ref={currentHeadingRef} tabIndex={-1}>{attemptPhase === "rating" ? `How did ${noteLabel(currentProbe.midi)} feel?` : `Make only ${noteLabel(currentProbe.midi)}.`}</h2><p>{session.phase === "baseline" ? `Comfort comparison ${currentBaselineIndex + 1} of ${session.baselineCandidates.length}.` : `${semitoneRelation(currentProbe.midi, session.baselineMidi, session.anchorMidi)}.`} The algorithm advances only after this note.</p></div>
            <span className={`range-sim-save-state ${persistenceState === "error" ? "error" : ""}`} role="status" aria-live="polite">{persistenceLabel}</span>
          </div>

          <div className="range-sim-focus-target">
            <div><span>ONE ACTIVE TARGET</span><strong>{noteLabel(currentProbe.midi)}</strong><small>{continuousMidiToHz(currentProbe.midi).toFixed(2)} Hz</small></div>
            <div className={`range-sim-attempt-badge ${attemptPhase}`}><i /><span>{attemptStatus}</span></div>
          </div>

          {input.error && <div className="range-sim-input-error"><b>Microphone needs attention</b><span>{input.error}</span></div>}

          <NoteInput
            variant="target"
            input={input}
            targetMidi={currentProbe.midi}
            toleranceCents={toleranceCents}
            phase={attemptPhase === "prompting" ? "prompting" : attemptPhase === "listening" ? "listening" : attemptPhase === "rating" ? "complete" : "idle"}
            hold={{
              heldSeconds,
              requiredSeconds: ATTEMPT_HOLD_SECONDS,
              status: attemptPhase === "rating" && trackerView?.status === "complete"
                ? "complete"
                : trackerView?.inGrace
                  ? "paused"
                  : trackerView?.status === "holding"
                    ? "holding"
                    : "waiting",
            }}
            diagnosticsFlow="range-simulator"
          />

          {attemptPhase === "ready" && <div className="range-sim-modal-actions"><ActionButton onClick={finishToday}>Stop &amp; review</ActionButton><ActionButton className="primary" disabled={connecting || input.state !== "running"} onClick={() => { void beginTargetAttempt(); }}><Icon name="play" size={17} /> Hear {noteLabel(currentProbe.midi)} &amp; begin</ActionButton></div>}
          {attemptPhase === "prompting" && <div className="range-sim-prompt-wait"><Icon name="headphones" size={18} /><span><b>Listen first.</b> Your meter and hold clock start only after this prompt ends.</span></div>}
          {attemptPhase === "listening" && <div className="range-sim-listening-actions"><div><ActionButton onClick={() => { void beginTargetAttempt(); }}><Icon name="play" size={16} /> Replay and restart</ActionButton><ActionButton onClick={finishToday}>Stop &amp; review</ActionButton></div><div className="range-sim-escape-actions"><span>Cannot earn the hold without strain?</span><ActionButton onClick={() => revealEscapeRating(4)}>4 · Unstable</ActionButton><ActionButton onClick={() => revealEscapeRating(5)}>5 · Can’t reliably produce</ActionButton></div></div>}

          {attemptPhase === "rating" && <>
            <fieldset className="range-rating-fieldset">
              <legend>How did {noteLabel(currentProbe.midi)} feel?<small>Rate comfort and repeatability—not talent. The meter confirms pitch; only you can report effort.</small></legend>
              <div className="range-rating-grid">
                {RATING_VALUES.map((value) => <label key={value} className={`range-rating-option rating-${value}`}><input type="radio" name="range-effort-rating" value={value} checked={rating === value} aria-keyshortcuts={String(value)} onChange={() => setRating(value)} /><strong>{value}</strong><b>{EFFORT_RATING_LABELS[value].label}</b><small>{EFFORT_RATING_LABELS[value].detail}</small></label>)}
              </div>
            </fieldset>
            {currentProbe.direction !== "center" && <label className="range-sim-coordinate-check"><input type="checkbox" checked={coordinationChange} onChange={(event) => setCoordinationChange(event.target.checked)} /><span>I noticed a different coordination or register change while moving {currentProbe.direction === "ascending" ? "up" : "down"}. This marker is directional.</span></label>}
            <div className="range-sim-rating-actions"><ActionButton onClick={() => { void beginTargetAttempt(); }}>Try {noteLabel(currentProbe.midi)} again</ActionButton><div className="range-sim-rating-buttons"><ActionButton onClick={finishToday}>Stop &amp; review</ActionButton><ActionButton className="primary" disabled={rating === null || attemptedTaskId !== currentProbe.id} onClick={submitRating}>Save rating &amp; next note <Icon name="arrow" size={16} /></ActionButton></div></div>
          </>}

          <div className="range-sim-live-notice" role="status" aria-live="polite">{notice}</div>
        </>)}
      </WorkflowDialog>

      {session.phase === "complete" && <div className="range-sim-profile-stack">
        <Panel className="range-sim-profile" aria-labelledby="range-sim-profile-title">
            <div className="range-sim-profile-header">
              <div><Eyebrow>{session.preparation === "unwarmed" ? "Untrained snapshot · current coordination" : "Current range snapshot"}</Eyebrow><h2 id="range-sim-profile-title" ref={profileHeadingRef} tabIndex={-1}>{completionTitle(session)}</h2><p>{notice}</p></div>
              <span className={`range-sim-save-state ${persistenceState === "error" ? "error" : ""}`} role="status" aria-live="polite">{persistenceLabel}</span>
            </div>
            <div className="range-sim-profile-callout">
              <div><span>{baselineConfirmed ? "Comfortable baseline" : "Provisional baseline"}</span><strong>{summary.baselineMidi === null ? "Not chosen" : `${noteLabel(summary.baselineMidi)} · ${continuousMidiToHz(summary.baselineMidi).toFixed(1)} Hz`}</strong><small>{baselineConfirmed ? "Confirmed in the outward map; still not an identity label." : summary.baselineMidi === null ? "No comparison was adopted as a reliable home today." : "Selected by comparison, but not yet confirmed in the outward map."}</small></div>
              <div><span>Self-rated easy neighborhood · 1–2</span><strong>{formatBounds(summary.easyBounds)}</strong><small>Contiguous from home; gaps are never inferred through.</small></div>
              <div><span>Self-rated usable span · 1–3</span><strong>{formatBounds(summary.usableBounds)}</strong><small>Reported today under this preparation condition.</small></div>
            </div>
            <dl className="range-sim-summary-grid">
              <div><dt>Today’s rated span</dt><dd>{formatBounds(summary.testedBounds)}</dd></div>
              <div><dt>Attention starts · rating 3+</dt><dd>{formatEdges(summary.difficultyEdges)}</dd></div>
              <div><dt>Unreliable reports · rating 4–5</dt><dd>{formatEdges(summary.unreliableEdges)}</dd></div>
              <div><dt>Coordination changes</dt><dd>{summary.coordinationMarkers.length === 0 ? "None marked" : summary.coordinationMarkers.map((marker) => `${noteLabel(marker.midi)}${marker.ascending ? " ↑" : ""}${marker.descending ? " ↓" : ""}`).join(", ")}</dd></div>
              <div><dt>Lower search</dt><dd>{descendingPresentation.title}</dd></div>
              <div><dt>Upper search</dt><dd>{ascendingPresentation.title}</dd></div>
            </dl>
            <div className="range-sim-profile-actions">
              <ActionButton className="primary" onClick={() => startFresh(summary.baselineMidi ?? profile.baseline.midi, session.preparation)}><Icon name="spark" size={16} /> Run another range check</ActionButton>
              {baselineConfirmed && summary.baselineMidi !== null && <ActionButton disabled={persistenceState === "saving"} onClick={() => { void openEndlessLoop(summary.baselineMidi!); }}><Icon name="loop" size={16} /> Open Endless Loop from {noteLabel(summary.baselineMidi)}</ActionButton>}
            </div>
            <p className="range-sim-disclaimer">Today’s map is a snapshot. Fatigue, illness, hydration, preparation, and time of day can change it. Notes outside the mapped span are untested or not reliable under this protocol—not declared impossible. This tool does not classify your voice or diagnose vocal function.</p>
          </Panel>

          <Panel className="range-sim-map" aria-labelledby="range-sim-map-title">
            <div className="range-sim-map-header"><div><Eyebrow>Latest response at each pitch</Eyebrow><h2 id="range-sim-map-title">Your completed note-by-note map.</h2></div><small>{displayedMidis.length} distinct pitches · C2–B5 protocol</small></div>
            {displayedMidis.length > 0 ? <div className="range-sim-note-map">{displayedMidis.map((midi) => { const observation = latestByMidi.get(midi)!; return <div key={midi} className={`range-sim-note rating-${observation.rating}`} aria-label={`${noteLabel(midi)}, rating ${observation.rating}, ${EFFORT_RATING_LABELS[observation.rating].label}`}><span>{observation.task.kind.replaceAll("-", " ")}</span><b>{noteLabel(midi)}</b><small>{observation.rating} · {EFFORT_RATING_LABELS[observation.rating].label}</small></div>; })}</div> : <div className="range-sim-empty"><span>No note ratings were completed in this snapshot.</span></div>}
          </Panel>
        </div>}
    </div>
  );
}
