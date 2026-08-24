import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { YinPitchFrame } from "@noteforge/pitch-engine";
import { playTone, type ActiveVoice } from "@/audio/synth";
import { useAudioInput } from "@/audio/use-audio-input";
import { pitchDiagnostics } from "@/diagnostics/pitch-diagnostics";
import { continuousMidiToHz, noteLabel, signed } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { WorkflowDialog, WorkflowStage, type WorkflowStep } from "@/ui/workflow";
import { resolveArcadeCurriculum } from "./curriculum";
import { getDifficultyPreset } from "./model";
import {
  RESONANCE_REFERENCE_FRAME_COUNT,
  advanceResonanceController,
  createResonanceController,
  resetResonanceController,
  toResonanceTutorialVoiceEvidence,
  toResonanceVoiceInput,
  updateResonanceControllerFromFrame,
  type ResonanceControllerState,
} from "./resonance-controller";
import { ResonanceChamber } from "./ResonanceChamber";
import {
  ResonanceLessonBrief,
  ResonanceTutorialObjective,
  ResonanceTutorialPath,
  ResonanceTutorialProof,
} from "./ResonanceTutorialUI";
import { generateResonanceLevel, type GeneratedResonanceLevel } from "./resonance-level";
import {
  createResonanceRunStats,
  recordResonanceCollisionAdvance,
  resonanceTunedEnergyForTarget,
  summarizeResonanceRun,
  type ResonanceResult,
  type ResonanceRunStats,
} from "./resonance-scoring";
import {
  advanceResonanceGame,
  createResonanceGame,
  type FrequencyTunedResonator,
  type ResonanceGameState,
  type ResonatorActivation,
} from "./resonance-physics";
import {
  RESONANCE_TUTORIAL_LESSON_IDS,
  advanceResonanceTutorialSession,
  createResonanceTutorialCurriculum,
  createResonanceTutorialSession,
  nextResonanceTutorialLessonId as nextAuthoredTutorialLessonId,
  type ResonanceTutorialLessonId,
  type ResonanceTutorialSessionState,
} from "./resonance-tutorial";
import {
  completedResonanceTutorialLessonCount,
  isResonanceTutorialLessonUnlocked,
  nextResonanceTutorialLessonId,
  resonanceCombinedChambersUnlocked,
  type ResonanceTutorialAttempt,
  type ResonanceTutorialProgress,
} from "./resonance-tutorial-progress";
import {
  createResonanceTutorialObjectiveView,
  createResonanceTutorialPathCards,
  createResonanceTutorialProofView,
  focusedTutorialResonatorId,
  isResonanceTutorialLessonId,
  resonanceTutorialCausalRule,
  resonanceTutorialMechanicLabel,
  type ResonanceTutorialProofView,
} from "./resonance-tutorial-view";
import type { ArcadeGameProps, ArcadeOutcome } from "./types";

const CHAMBER_WORKFLOW_STEPS = [
  { id: "loadout", label: "Read the chamber", detail: "Field · walls · goal" },
  { id: "solve", label: "Shape the field", detail: "Pitch · energy · inertia" },
  { id: "review", label: "Review", detail: "Control efficiency" },
] as const satisfies readonly WorkflowStep[];

const TUTORIAL_WORKFLOW_STEPS = [
  { id: "brief", label: "Brief", detail: "One cause · one effect" },
  { id: "puzzle", label: "Puzzle", detail: "Observe · control · transfer" },
  { id: "proof", label: "Proof", detail: "Evidence · next unlock" },
] as const satisfies readonly WorkflowStep[];

const REFERENCE_TONE_SECONDS = .8;
const REFERENCE_SETTLE_MS = 320;
const RENDER_INTERVAL_MS = 50;
const DISPLAY_CHARGE_SECONDS = 1.2;
const COUPLED_ENERGY_THRESHOLD = .08;

type ResonancePhase = "setup" | "briefing" | "connecting" | "playing" | "result";
type ResonanceSessionKind = "tutorial" | "generated";

interface ResonanceProps extends ArcadeGameProps {
  readonly tutorialProgress: ResonanceTutorialProgress;
  readonly onTutorialAttempt: (attempt: ResonanceTutorialAttempt, completedAt: string) => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function distance(
  first: Readonly<{ x: number; y: number }>,
  second: Readonly<{ x: number; y: number }>,
): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function goalProgressPercent(game: Readonly<ResonanceGameState>): number {
  const startX = game.level.ball.position.x;
  const goalX = game.level.goal.position.x;
  if (goalX <= startX) return game.status === "won" ? 100 : 0;
  return clamp((game.ball.position.x - startX) / (goalX - startX) * 100, 0, 100);
}

function focusedResonator(game: Readonly<ResonanceGameState>): FrequencyTunedResonator | null {
  return game.level.resonators.find((resonator) => (
    resonator.position.x >= game.ball.position.x
  )) ?? game.level.resonators.at(-1) ?? null;
}

function resultOutcome(
  result: Readonly<ResonanceResult>,
  difficulty: ArcadeGameProps["difficulty"],
  curriculumStage: ArcadeGameProps["curriculumStage"],
  chamberNumber: number,
): ArcadeOutcome {
  return {
    mode: "resonance",
    curriculumStage,
    variant: `field-chamber-${chamberNumber}`,
    score: result.score,
    grade: result.grade,
    xp: Math.round(result.score * getDifficultyPreset(difficulty).scoreMultiplier),
    accuracy: result.tunedEfficiencyPercent,
    bestCombo: Math.round(result.bestCoherentHoldSeconds * 10),
    durationMs: Math.round(result.durationSeconds * 1_000),
    details: {
      pathEfficiencyPercent: result.pathEfficiencyPercent,
      coherentEfficiencyPercent: result.coherentEfficiencyPercent,
      tunedEfficiencyPercent: result.tunedEfficiencyPercent,
      collisionControlPercent: result.collisionControlPercent,
      speedPercent: result.speedPercent,
      collisions: result.collisionCount,
      reliableFrames: result.reliableFrames,
      bestCoherentHoldMs: result.bestCoherentHoldSeconds * 1_000,
      peakNormalizedLevel: result.peakNormalizedLevel,
      peakRelativeDb: result.peakRelativeDb ?? undefined,
      resonators: result.resonators,
    },
  };
}

function controllerStatus(state: Readonly<ResonanceControllerState> | null): string {
  if (!state) return "WAITING FOR LOCAL SIGNAL";
  switch (state.status) {
    case "coupling": return `COMFORT REFERENCE ${state.referenceSamplesDbfs.length}/${RESONANCE_REFERENCE_FRAME_COUNT} · FIELD ALREADY LIVE`;
    case "driving": return "COHERENT FIELD LIVE";
    case "unvoiced": return "VOICE RELEASED · INERTIA CONTINUES";
    case "uncertain": return "PITCH UNCERTAIN · FORCE SUPPRESSED";
    case "releasing": return "FIELD RELEASING";
    case "stale": return "STALE SIGNAL CLEARED";
    case "idle": return "WAITING FOR VOICE";
  }
}

function resonatorIsCoupled(
  controller: Readonly<ResonanceControllerState> | null,
  target: Readonly<FrequencyTunedResonator> | null,
  activation: Readonly<ResonatorActivation> | null | undefined,
): boolean {
  return controller?.evidenceReliable === true
    && target !== null
    && activation?.resonatorId === target.id
    && activation.centsError !== null
    && Math.abs(activation.centsError) <= target.bandwidthCents
    && activation.effectiveEnergy >= COUPLED_ENERGY_THRESHOLD;
}

function signalGuidance(
  controller: Readonly<ResonanceControllerState> | null,
  target: Readonly<FrequencyTunedResonator> | null,
  coupled: boolean,
  hideNote: boolean,
): string {
  if (!controller || !controller.evidenceReliable || controller.midiFloat === null) return "Make a steady comfortable tone. The room responds as soon as reliable evidence arrives.";
  if (!target) return "Keep a coherent field behind the ball and let inertia carry it into the target.";
  const cents = (controller.midiFloat - target.targetMidi) * 100;
  if (coupled) return "The focused resonator is coupled. Hold steady; extra loudness is not extra force.";
  if (Math.abs(cents) <= target.bandwidthCents) return "Pitch centered. Keep the tone steady at a comfortable level so coherent transfer can build.";
  if (hideNote) return cents < 0 ? "The next resonator wants a higher pitch." : "The next resonator wants a lower pitch.";
  return `${noteLabel(target.targetMidi)} is ${cents < 0 ? "above" : "below"} the stable reading. Move ${cents < 0 ? "up" : "down"} until the resonator wakes.`;
}

function isClearReleaseFrame(frame: Readonly<YinPitchFrame>): boolean {
  return !frame.voiced
    && (frame.reason === "below-rms-threshold" || frame.reason === "no-periodic-candidate");
}

function pageIsHidden(): boolean {
  return document.visibilityState === "hidden";
}

export function Resonance({
  difficulty,
  curriculumStage,
  voiceRange,
  onExit,
  onComplete,
  tutorialProgress,
  onTutorialAttempt,
}: ResonanceProps) {
  const [phase, setPhase] = useState<ResonancePhase>("setup");
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [sessionKind, setSessionKind] = useState<ResonanceSessionKind>("tutorial");
  const [selectedLessonId, setSelectedLessonId] = useState<ResonanceTutorialLessonId | null>(null);
  const [tutorialSessionView, setTutorialSessionView] = useState<ResonanceTutorialSessionState | null>(null);
  const [tutorialProof, setTutorialProof] = useState<ResonanceTutorialProofView | null>(null);
  const [chamberNumber, setChamberNumber] = useState(1);
  const [generated, setGenerated] = useState<GeneratedResonanceLevel | null>(null);
  const [gameView, setGameView] = useState<ResonanceGameState | null>(null);
  const [controllerView, setControllerView] = useState<ResonanceControllerState | null>(null);
  const [result, setResult] = useState<ResonanceResult | null>(null);
  const [notice, setNotice] = useState("Begin with one isolated causal proof. Canonical note detection stays continuous.");
  const [connectionSlow, setConnectionSlow] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [referenceReleaseRequired, setReferenceReleaseRequired] = useState(false);
  const [visibilityPaused, setVisibilityPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [displayChargeSeconds, setDisplayChargeSeconds] = useState(0);
  const [accessibleStatus, setAccessibleStatus] = useState("Chamber waiting to start.");

  const phaseRef = useRef(phase);
  const sessionKindRef = useRef<ResonanceSessionKind>(sessionKind);
  const gameRef = useRef<ResonanceGameState | null>(gameView);
  const tutorialSessionRef = useRef<ResonanceTutorialSessionState | null>(tutorialSessionView);
  const controllerRef = useRef<ResonanceControllerState | null>(controllerView);
  const inputRef = useRef<ReturnType<typeof useAudioInput> | null>(null);
  const animationRef = useRef<number | null>(null);
  const animationTickRef = useRef<(now: number) => void>(() => undefined);
  const lastAnimationAtRef = useRef(0);
  const lastRenderedAtRef = useRef(0);
  const statsRef = useRef<ResonanceRunStats | null>(null);
  const sessionTokenRef = useRef(0);
  const sessionSeedRef = useRef("");
  const completionRecordedRef = useRef(false);
  const onFrameRef = useRef<(frame: YinPitchFrame) => void>(() => undefined);
  const finishRef = useRef<(game: ResonanceGameState) => void>(() => undefined);
  const finishTutorialRef = useRef<(session: ResonanceTutorialSessionState) => void>(() => undefined);
  const promptVoiceRef = useRef<ActiveVoice | null>(null);
  const promptTimerRef = useRef<number | null>(null);
  const promptGenerationRef = useRef(0);
  const scoringExcludedRef = useRef(false);
  const referenceReleaseRequiredRef = useRef(false);
  const visibilityPausedRef = useRef(false);
  const accessibleAnnouncementKeyRef = useRef("");
  const accessibleAnnouncementHoldUntilRef = useRef(0);
  const chargeTargetIdRef = useRef<string | null>(null);
  const chargeSecondsRef = useRef(0);

  phaseRef.current = phase;
  sessionKindRef.current = sessionKind;

  const curriculum = resolveArcadeCurriculum("resonance", curriculumStage);
  const tutorialCurriculum = useMemo(() => createResonanceTutorialCurriculum({
    baselineMidi: voiceRange.baselineMidi,
  }), [voiceRange.baselineMidi]);
  const nextTutorialLessonId = nextResonanceTutorialLessonId(tutorialProgress);
  const completedTutorialLessons = completedResonanceTutorialLessonCount(tutorialProgress);
  const combinedChambersUnlocked = resonanceCombinedChambersUnlocked(tutorialProgress);
  const tutorialPathCards = useMemo(() => createResonanceTutorialPathCards(
    tutorialCurriculum,
    tutorialProgress,
    nextTutorialLessonId,
  ), [nextTutorialLessonId, tutorialCurriculum, tutorialProgress]);
  const selectedLesson = selectedLessonId === null
    ? null
    : tutorialCurriculum.find((lesson) => lesson.id === selectedLessonId) ?? null;
  const nextTutorialLesson = nextTutorialLessonId === null
    ? null
    : tutorialCurriculum.find((lesson) => lesson.id === nextTutorialLessonId) ?? null;
  const tutorialFocusId = selectedLesson && tutorialSessionView
    ? focusedTutorialResonatorId(selectedLesson, tutorialSessionView.objective)
    : null;
  const focusTarget = gameView
    ? sessionKind === "tutorial"
      ? gameView.level.resonators.find((resonator) => resonator.id === tutorialFocusId) ?? null
      : focusedResonator(gameView)
    : null;

  const input = useAudioInput({
    diagnostics: {
      flow: "voice-arcade",
      phase,
      targetMidi: focusTarget?.targetMidi ?? null,
      toleranceCents: focusTarget?.bandwidthCents ?? null,
      stableMs: displayChargeSeconds * 1_000,
      requiredHoldMs: DISPLAY_CHARGE_SECONDS * 1_000,
      resetReason: scoringExcludedRef.current ? "reference-excluded" : null,
    },
    onFrame: (frame) => onFrameRef.current(frame),
  });
  inputRef.current = input;

  const cancelAnimation = useCallback(() => {
    if (animationRef.current !== null) window.cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
  }, []);

  const clearPrompt = useCallback(() => {
    promptGenerationRef.current += 1;
    if (promptTimerRef.current !== null) window.clearTimeout(promptTimerRef.current);
    promptTimerRef.current = null;
    promptVoiceRef.current?.stop(.04);
    promptVoiceRef.current = null;
    scoringExcludedRef.current = false;
    referenceReleaseRequiredRef.current = false;
    setPreviewing(false);
    setReferenceReleaseRequired(false);
  }, []);

  const updateStats = useCallback((
    previous: Readonly<ResonanceGameState>,
    next: Readonly<ResonanceGameState>,
    controller: Readonly<ResonanceControllerState>,
    deltaSeconds: number,
  ) => {
    const stats = statsRef.current;
    if (!stats) return;
    stats.pathDistance += distance(previous.ball.position, next.ball.position);
    stats.lastBallX = next.ball.position.x;
    stats.lastBallY = next.ball.position.y;
    stats.effectiveIntensityIntegral += next.voice.effectiveIntensity * deltaSeconds;
    stats.coherentDriveIntegral += next.voice.directEnergy * deltaSeconds;
    stats.peakNormalizedLevel = Math.max(stats.peakNormalizedLevel, controller.normalizedLevel);
    if (controller.relativeDb !== null) {
      stats.peakRelativeDb = stats.peakRelativeDb === null
        ? controller.relativeDb
        : Math.max(stats.peakRelativeDb, controller.relativeDb);
    }
    const scoringTarget = focusedResonator(next);
    stats.tunedEnergyIntegral += resonanceTunedEnergyForTarget(
      next,
      scoringTarget?.id ?? null,
    ) * deltaSeconds;
    if (next.voice.directEnergy > 0) stats.activeSeconds += deltaSeconds;
    if (next.voice.directEnergy > .025 && controller.coherence >= .68) {
      stats.coherentSeconds += deltaSeconds;
      stats.currentCoherentHoldSeconds += deltaSeconds;
      stats.bestCoherentHoldSeconds = Math.max(stats.bestCoherentHoldSeconds, stats.currentCoherentHoldSeconds);
    } else {
      stats.currentCoherentHoldSeconds = 0;
    }

    recordResonanceCollisionAdvance(
      stats,
      previous.collisionCount,
      next.collisionCount,
      deltaSeconds,
    );

    const target = focusedResonator(next);
    if (chargeTargetIdRef.current !== target?.id) {
      chargeTargetIdRef.current = target?.id ?? null;
      chargeSecondsRef.current = 0;
    }
    const activation = target
      ? next.resonatorActivations.find((candidate) => candidate.resonatorId === target.id)
      : null;
    const chargePaused = scoringExcludedRef.current
      || referenceReleaseRequiredRef.current
      || visibilityPausedRef.current
      || controller.status === "uncertain"
      || controller.status === "releasing"
      || controller.status === "stale";
    if (resonatorIsCoupled(controller, target, activation)) {
      chargeSecondsRef.current = Math.min(DISPLAY_CHARGE_SECONDS, chargeSecondsRef.current + deltaSeconds);
    } else if (!chargePaused) {
      chargeSecondsRef.current = Math.max(0, chargeSecondsRef.current - deltaSeconds * .6);
    }
  }, []);

  const finishRoom = useCallback((finalGame: ResonanceGameState) => {
    if (completionRecordedRef.current || !statsRef.current) return;
    completionRecordedRef.current = true;
    cancelAnimation();
    clearPrompt();
    const summary = summarizeResonanceRun(finalGame, statsRef.current);
    phaseRef.current = "result";
    gameRef.current = finalGame;
    setGameView(finalGame);
    setControllerView(controllerRef.current);
    setDisplayChargeSeconds(chargeSecondsRef.current);
    setResult(summary);
    setPhase("result");
    setNotice("Goal captured. The review separates efficient field control from simply getting louder.");
    onComplete(resultOutcome(summary, difficulty, curriculumStage, chamberNumber));
  }, [cancelAnimation, chamberNumber, clearPrompt, curriculumStage, difficulty, onComplete]);
  finishRef.current = finishRoom;

  const finishTutorial = useCallback((finalSession: ResonanceTutorialSessionState) => {
    if (completionRecordedRef.current) return;
    completionRecordedRef.current = true;
    cancelAnimation();
    clearPrompt();
    const proof = createResonanceTutorialProofView(
      finalSession.lesson,
      finalSession.objective,
      finalSession.game,
    );
    const completedAt = new Date().toISOString();
    onTutorialAttempt({
      lessonId: finalSession.lesson.id,
      passed: proof.passed,
      score: proof.score,
    }, completedAt);
    phaseRef.current = "result";
    gameRef.current = finalSession.game;
    tutorialSessionRef.current = finalSession;
    setGameView(finalSession.game);
    setTutorialSessionView(finalSession);
    setTutorialProof(proof);
    setResult(null);
    setPhase("result");
    setNotice(proof.passed
      ? `${finalSession.lesson.title} proven. The next authored puzzle is unlocked.`
      : finalSession.objective.retryReason ?? "That attempt needs a clean reset before it can count as proof.");
    setAccessibleStatus(proof.passed
      ? `${finalSession.lesson.title} proven. Evidence recorded for this visit; local storage is handled by the arcade cabinet.`
      : "Puzzle proof incomplete. Reset the chamber and retry.");
  }, [cancelAnimation, clearPrompt, onTutorialAttempt]);
  finishTutorialRef.current = finishTutorial;

  animationTickRef.current = (now: number) => {
    if (phaseRef.current !== "playing" || !gameRef.current || !controllerRef.current) return;
    const deltaSeconds = lastAnimationAtRef.current === 0
      ? 0
      : clamp((now - lastAnimationAtRef.current) / 1_000, 0, .1);
    lastAnimationAtRef.current = now;

    const controller = advanceResonanceController(controllerRef.current, {
      nowSeconds: now / 1_000,
      deltaSeconds,
    });
    controllerRef.current = controller;
    const previous = gameRef.current;
    const voiceInput = scoringExcludedRef.current
      ? { voiced: false, midiFloat: null, frequencyHz: null, normalizedLevel: 0, coherentDrive: 0, confidence: 0, stability: 0 }
      : sessionKindRef.current === "tutorial"
        ? toResonanceTutorialVoiceEvidence(controller)
        : toResonanceVoiceInput(controller);
    if (sessionKindRef.current === "tutorial" && tutorialSessionRef.current) {
      const advancedTutorial = advanceResonanceTutorialSession(
        tutorialSessionRef.current,
        voiceInput,
        deltaSeconds,
      );
      tutorialSessionRef.current = advancedTutorial.state;
      gameRef.current = advancedTutorial.state.game;
      updateStats(previous, advancedTutorial.state.game, controller, deltaSeconds);
      const renderInterval = reducedMotion ? 180 : RENDER_INTERVAL_MS;
      if (now - lastRenderedAtRef.current >= renderInterval
        || advancedTutorial.passedThisAdvance
        || advancedTutorial.retryThisAdvance) {
        lastRenderedAtRef.current = now;
        setGameView(advancedTutorial.state.game);
        setTutorialSessionView(advancedTutorial.state);
        setControllerView(controller);
        setDisplayChargeSeconds(
          advancedTutorial.state.objective.chargeSeconds
            || advancedTutorial.state.objective.currentHoldSeconds,
        );
      }
      if (advancedTutorial.passedThisAdvance || advancedTutorial.retryThisAdvance) {
        finishTutorialRef.current(advancedTutorial.state);
        return;
      }
      animationRef.current = window.requestAnimationFrame(animationTickRef.current);
      return;
    }
    const advanced = advanceResonanceGame(previous, voiceInput, deltaSeconds);
    gameRef.current = advanced.state;
    updateStats(previous, advanced.state, controller, deltaSeconds);

    const renderInterval = reducedMotion ? 180 : RENDER_INTERVAL_MS;
    if (now - lastRenderedAtRef.current >= renderInterval || advanced.wonThisAdvance) {
      lastRenderedAtRef.current = now;
      setGameView(advanced.state);
      setControllerView(controller);
      setDisplayChargeSeconds(chargeSecondsRef.current);
    }
    if (advanced.wonThisAdvance) {
      finishRef.current(advanced.state);
      return;
    }
    animationRef.current = window.requestAnimationFrame(animationTickRef.current);
  };

  const beginAnimation = useCallback(() => {
    cancelAnimation();
    lastAnimationAtRef.current = performance.now();
    lastRenderedAtRef.current = 0;
    animationRef.current = window.requestAnimationFrame(animationTickRef.current);
  }, [cancelAnimation]);

  const installChamber = useCallback((nextChamber: number, seed: string) => {
    clearPrompt();
    const nextGenerated = generateResonanceLevel({
      seed,
      level: nextChamber,
      difficulty,
      lowMidi: voiceRange.lowMidi,
      highMidi: voiceRange.highMidi,
      baselineMidi: voiceRange.baselineMidi,
    });
    const nextGame = createResonanceGame(nextGenerated.definition);
    const nextController = createResonanceController();
    completionRecordedRef.current = false;
    sessionKindRef.current = "generated";
    gameRef.current = nextGame;
    tutorialSessionRef.current = null;
    controllerRef.current = nextController;
    statsRef.current = createResonanceRunStats(nextGame);
    chargeTargetIdRef.current = focusedResonator(nextGame)?.id ?? null;
    chargeSecondsRef.current = 0;
    phaseRef.current = "playing";
    setChamberNumber(nextChamber);
    setSessionKind("generated");
    setSelectedLessonId(null);
    setGenerated(nextGenerated);
    setGameView(nextGame);
    setTutorialSessionView(null);
    setTutorialProof(null);
    setControllerView(nextController);
    setResult(null);
    setDisplayChargeSeconds(0);
    const startsHidden = pageIsHidden();
    setVisibilityPaused(startsHidden);
    visibilityPausedRef.current = startsHidden;
    setPhase("playing");
    setNotice("Field live. Start at a comfortable tone; the first eight reliable frames refine level normalization without stopping the ball.");
    if (startsHidden) {
      cancelAnimation();
      setNotice("Chamber is ready but paused while this tab is hidden. Return here to continue.");
    } else {
      beginAnimation();
    }
  }, [beginAnimation, cancelAnimation, clearPrompt, difficulty, voiceRange.baselineMidi, voiceRange.highMidi, voiceRange.lowMidi]);

  const installTutorialLesson = useCallback((lessonId: ResonanceTutorialLessonId) => {
    clearPrompt();
    const nextSession = createResonanceTutorialSession(lessonId, {
      baselineMidi: voiceRange.baselineMidi,
    });
    const priorController = controllerRef.current;
    const nextController = priorController
      ? resetResonanceController(priorController, { retainReference: true })
      : createResonanceController();
    completionRecordedRef.current = false;
    sessionKindRef.current = "tutorial";
    tutorialSessionRef.current = nextSession;
    gameRef.current = nextSession.game;
    controllerRef.current = nextController;
    statsRef.current = createResonanceRunStats(nextSession.game);
    chargeTargetIdRef.current = focusedTutorialResonatorId(
      nextSession.lesson,
      nextSession.objective,
    );
    chargeSecondsRef.current = 0;
    phaseRef.current = "playing";
    setSessionKind("tutorial");
    setSelectedLessonId(lessonId);
    setGenerated(nextSession.lesson.level);
    setTutorialSessionView(nextSession);
    setTutorialProof(null);
    setGameView(nextSession.game);
    setControllerView(nextController);
    setResult(null);
    setDisplayChargeSeconds(0);
    const startsHidden = pageIsHidden();
    setVisibilityPaused(startsHidden);
    visibilityPausedRef.current = startsHidden;
    setPhase("playing");
    setNotice("Puzzle live. Its untaught voice dimensions are normalized; the microphone evidence floor is unchanged.");
    if (startsHidden) {
      cancelAnimation();
      setNotice("Puzzle ready but paused while this tab is hidden. Return here to continue.");
    } else {
      beginAnimation();
    }
  }, [beginAnimation, cancelAnimation, clearPrompt, voiceRange.baselineMidi]);

  const startGeneratedRun = useCallback(async () => {
    if (phaseRef.current === "connecting") return;
    if (!resonanceCombinedChambersUnlocked(tutorialProgress)) {
      setNotice("Combined chambers unlock only after all twelve isolated foundations proofs.");
      return;
    }
    const token = ++sessionTokenRef.current;
    sessionSeedRef.current = `resonance:${new Date().toISOString()}:${crypto.randomUUID()}`;
    sessionKindRef.current = "generated";
    setSessionKind("generated");
    setConnectionSlow(false);
    phaseRef.current = "connecting";
    setPhase("connecting");
    setWorkflowOpen(true);
    setNotice("Opening the retained local microphone and continuous note stream.");
    const microphone = await input.enable();
    if (token !== sessionTokenRef.current) return;
    if (!microphone) {
      phaseRef.current = "setup";
      setPhase("setup");
      setWorkflowOpen(false);
      setNotice(inputRef.current?.error || "Microphone access is needed to create the field.");
      return;
    }
    installChamber(1, sessionSeedRef.current);
  }, [input, installChamber, tutorialProgress]);

  const openTutorialLesson = useCallback((lessonId: ResonanceTutorialLessonId) => {
    if (!isResonanceTutorialLessonUnlocked(tutorialProgress, lessonId)) {
      setNotice("That puzzle is still locked. Prove every earlier room in order first.");
      return;
    }
    sessionTokenRef.current += 1;
    cancelAnimation();
    clearPrompt();
    sessionKindRef.current = "tutorial";
    phaseRef.current = "briefing";
    setSessionKind("tutorial");
    setSelectedLessonId(lessonId);
    setTutorialProof(null);
    setResult(null);
    setPhase("briefing");
    setWorkflowOpen(true);
    setNotice("Read the one-variable contract, then begin when the cause and effect are clear.");
  }, [cancelAnimation, clearPrompt, tutorialProgress]);

  const startTutorialLesson = useCallback(async (lessonId: ResonanceTutorialLessonId) => {
    if (phaseRef.current === "connecting") return;
    if (!isResonanceTutorialLessonUnlocked(tutorialProgress, lessonId)) {
      setNotice("This authored puzzle is still locked by an earlier proof.");
      return;
    }
    const token = ++sessionTokenRef.current;
    sessionKindRef.current = "tutorial";
    setSessionKind("tutorial");
    setConnectionSlow(false);
    phaseRef.current = "connecting";
    setPhase("connecting");
    setWorkflowOpen(true);
    setNotice("Opening the retained local microphone and continuous note stream.");
    const microphone = await input.enable();
    if (token !== sessionTokenRef.current) return;
    if (!microphone) {
      phaseRef.current = "briefing";
      setPhase("briefing");
      setNotice(inputRef.current?.error || "Microphone access is needed to run this voice-controlled puzzle.");
      return;
    }
    installTutorialLesson(lessonId);
  }, [input, installTutorialLesson, tutorialProgress]);

  const closeWorkflow = useCallback(() => {
    sessionTokenRef.current += 1;
    cancelAnimation();
    clearPrompt();
    phaseRef.current = "setup";
    setPhase("setup");
    setWorkflowOpen(false);
    setSelectedLessonId(null);
    setTutorialSessionView(null);
    setTutorialProof(null);
    setConnectionSlow(false);
    setVisibilityPaused(false);
    setNotice(gameRef.current && gameRef.current.elapsedSeconds > 0
      ? "Chamber stopped. Start again when you are ready; microphone permission remains available."
      : "Run stopped. Start again when you are ready.");
  }, [cancelAnimation, clearPrompt]);

  const restartChamber = useCallback(() => {
    if (sessionKindRef.current === "tutorial" && selectedLessonId) {
      installTutorialLesson(selectedLessonId);
    } else {
      installChamber(chamberNumber, sessionSeedRef.current);
    }
  }, [chamberNumber, installChamber, installTutorialLesson, selectedLessonId]);

  const installFromResult = useCallback((nextChamberNumber: number) => {
    if (phaseRef.current !== "result") return;
    installChamber(nextChamberNumber, sessionSeedRef.current);
  }, [installChamber]);

  const nextChamber = useCallback(() => {
    installFromResult(chamberNumber + 1);
  }, [chamberNumber, installFromResult]);

  const replayResult = useCallback(() => {
    installFromResult(chamberNumber);
  }, [chamberNumber, installFromResult]);

  const playReference = useCallback(async (midi: number) => {
    const tutorialAllowsReference = sessionKindRef.current === "tutorial"
      && tutorialSessionRef.current?.lesson.feedback.pitchMeter === true;
    if (phaseRef.current !== "playing"
      || (!tutorialAllowsReference && !curriculum.feedback.allowReferenceReplay)) return;
    const generation = ++promptGenerationRef.current;
    if (promptTimerRef.current !== null) window.clearTimeout(promptTimerRef.current);
    promptVoiceRef.current?.stop(.03);
    scoringExcludedRef.current = true;
    referenceReleaseRequiredRef.current = false;
    setPreviewing(true);
    setReferenceReleaseRequired(false);
    accessibleAnnouncementKeyRef.current = "reference-playing";
    accessibleAnnouncementHoldUntilRef.current = performance.now() + 3_000;
    setAccessibleStatus(`Reference ${noteLabel(midi)} is playing. It cannot move the ball.`);
    setNotice(`Reference ${noteLabel(midi)} is playing. Its microphone frames are excluded; movement resumes only from fresh voice evidence after release.`);
    try {
      const voice = await playTone({
        frequencyHz: continuousMidiToHz(midi),
        duration: REFERENCE_TONE_SECONDS,
        amplitude: .2,
        timbre: "sine",
        release: .08,
      });
      if (generation !== promptGenerationRef.current) {
        voice.stop(.02);
        return;
      }
      promptVoiceRef.current = voice;
      promptTimerRef.current = window.setTimeout(() => {
        if (generation !== promptGenerationRef.current) return;
        promptVoiceRef.current?.stop(.03);
        promptVoiceRef.current = null;
        promptTimerRef.current = null;
        setPreviewing(false);
        referenceReleaseRequiredRef.current = true;
        setReferenceReleaseRequired(true);
        accessibleAnnouncementKeyRef.current = "reference-release";
        accessibleAnnouncementHoldUntilRef.current = performance.now() + 3_000;
        setAccessibleStatus("Reference ended. Release your voice once; a clear unvoiced frame is required before the field re-arms.");
        setNotice("Reference released. Clear your voice once to prove the speaker tail ended; then a fresh comfortable tone can drive the field.");
      }, REFERENCE_TONE_SECONDS * 1_000 + REFERENCE_SETTLE_MS);
    } catch {
      if (generation !== promptGenerationRef.current) return;
      scoringExcludedRef.current = false;
      referenceReleaseRequiredRef.current = false;
      setPreviewing(false);
      setReferenceReleaseRequired(false);
      setNotice("That reference could not play. The visible target and field response remain available.");
    }
  }, [curriculum.feedback.allowReferenceReplay]);

  onFrameRef.current = (frame) => {
    const receivedAtSeconds = performance.now() / 1_000;
    if (phaseRef.current !== "playing" || visibilityPausedRef.current) return;
    if (referenceReleaseRequiredRef.current) {
      if (isClearReleaseFrame(frame)) {
        referenceReleaseRequiredRef.current = false;
        scoringExcludedRef.current = false;
        setReferenceReleaseRequired(false);
        accessibleAnnouncementKeyRef.current = "reference-confirmed";
        accessibleAnnouncementHoldUntilRef.current = performance.now() + 3_000;
        setAccessibleStatus("Voice release confirmed. The field is armed for fresh voice evidence.");
        setNotice("Release confirmed. The field is armed for fresh voice evidence.");
      }
      return;
    }
    if (scoringExcludedRef.current) return;
    const currentController = controllerRef.current ?? createResonanceController();
    const update = updateResonanceControllerFromFrame(currentController, frame, receivedAtSeconds);
    controllerRef.current = update.state;
    if (statsRef.current) {
      statsRef.current.observedFrames += update.duplicate ? 0 : 1;
      if (update.accepted) statsRef.current.reliableFrames += 1;
    }
  };

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(media.matches);
    updatePreference();
    media.addEventListener("change", updatePreference);
    return () => media.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    if (phase !== "connecting") {
      setConnectionSlow(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setConnectionSlow(true), 5_000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    const handleVisibility = () => {
      const hidden = document.visibilityState === "hidden";
      visibilityPausedRef.current = hidden;
      setVisibilityPaused(hidden);
      if (phaseRef.current !== "playing") return;
      if (hidden) {
        cancelAnimation();
        clearPrompt();
        setNotice("Chamber paused while this tab is hidden. No catch-up force or physics is simulated.");
      } else {
        lastAnimationAtRef.current = performance.now();
        lastRenderedAtRef.current = 0;
        setNotice("Chamber resumed. Live voice observations continue from the shared input stream.");
        animationRef.current = window.requestAnimationFrame(animationTickRef.current);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [cancelAnimation, clearPrompt]);

  useEffect(() => {
    if (input.state !== "error" || phaseRef.current !== "playing") return;
    cancelAnimation();
    clearPrompt();
    phaseRef.current = "setup";
    setPhase("setup");
    setWorkflowOpen(false);
    setNotice(input.error || "The microphone disconnected. Start again to reconnect.");
  }, [cancelAnimation, clearPrompt, input.error, input.state]);

  useEffect(() => {
    if (phase !== "playing") return undefined;
    const announce = () => {
      const currentGame = gameRef.current;
      const currentController = controllerRef.current;
      if (!currentGame || !currentController) return;
      if (performance.now() < accessibleAnnouncementHoldUntilRef.current) return;
      if (visibilityPaused) {
        const pausedStatus = "Puzzle paused while this tab is hidden. No voice evidence or catch-up physics is counted.";
        const pausedKey = `paused|${pausedStatus}`;
        if (accessibleAnnouncementKeyRef.current === pausedKey) return;
        accessibleAnnouncementKeyRef.current = pausedKey;
        setAccessibleStatus(pausedStatus);
        return;
      }
      if (scoringExcludedRef.current) {
        const release = referenceReleaseRequiredRef.current;
        const key = release ? "release-required" : "reference-playing";
        if (accessibleAnnouncementKeyRef.current === key) return;
        accessibleAnnouncementKeyRef.current = key;
        setAccessibleStatus(release
          ? "Release your voice once before the field can re-arm."
          : "Reference tone is playing and excluded from movement.");
        return;
      }
      const liveTutorial = tutorialSessionRef.current;
      if (sessionKindRef.current === "tutorial" && liveTutorial) {
        const objectiveView = createResonanceTutorialObjectiveView(
          liveTutorial.lesson,
          liveTutorial.objective,
          currentController,
          false,
        );
        const progressBucket = Math.min(100, Math.floor(liveTutorial.objective.progress * 5) * 20);
        const announcementKey = [
          "tutorial",
          liveTutorial.lesson.id,
          liveTutorial.objective.status,
          liveTutorial.objective.milestoneIndex,
          liveTutorial.objective.waitingForRelease ? "release" : "voice",
          progressBucket,
        ].join("|");
        if (announcementKey === accessibleAnnouncementKeyRef.current) return;
        accessibleAnnouncementKeyRef.current = announcementKey;
        setAccessibleStatus(
          `Puzzle ${liveTutorial.lesson.order + 1} of ${RESONANCE_TUTORIAL_LESSON_IDS.length}. `
          + `${resonanceTutorialMechanicLabel(liveTutorial.lesson.mechanic)} ${liveTutorial.lesson.stage}. `
          + `${liveTutorial.lesson.title}. ${objectiveView.metricLabel}: ${objectiveView.metricValue}. `
          + objectiveView.progressText,
        );
        return;
      }
      const tutorialTargetId = sessionKindRef.current === "tutorial" && liveTutorial
        ? focusedTutorialResonatorId(liveTutorial.lesson, liveTutorial.objective)
        : null;
      const target = sessionKindRef.current === "tutorial"
        ? currentGame.level.resonators.find((resonator) => resonator.id === tutorialTargetId) ?? null
        : focusedResonator(currentGame);
      const progress = goalProgressPercent(currentGame);
      const progressBucket = Math.min(100, Math.floor(progress / 20) * 20);
      const activation = target
        ? currentGame.resonatorActivations.find((candidate) => candidate.resonatorId === target.id)
        : null;
      const coupled = resonatorIsCoupled(currentController, target, activation);
      const cents = target !== null && currentController.midiFloat !== null
        ? (currentController.midiFloat - target.targetMidi) * 100
        : null;
      const relation = coupled
        ? "coupled"
        : cents === null
          ? currentController.status
          : Math.abs(cents) <= target!.bandwidthCents
            ? "centered-building"
            : cents < 0
              ? "below-target"
              : "above-target";
      const coherenceBucket = Math.min(100, Math.floor(currentController.coherence * 4) * 25);
      const announcementKey = [progressBucket, target?.id ?? "goal", relation, coherenceBucket].join("|");
      if (announcementKey === accessibleAnnouncementKeyRef.current) return;
      accessibleAnnouncementKeyRef.current = announcementKey;
      const targetCopy = target
        ? curriculumStage === "background"
          ? `A tuned resonator is ahead; it is ${relation.replaceAll("-", " ")}.`
          : `Target resonator ${noteLabel(target.targetMidi)} is ahead; it is ${relation.replaceAll("-", " ")}.`
        : "The goal field is ahead.";
      setAccessibleStatus(
        `Ball passed ${progressBucket} percent of the chamber. ${targetCopy} `
        + `${controllerStatus(currentController)}. Coherence is in the ${coherenceBucket} percent band.`,
      );
    };
    accessibleAnnouncementKeyRef.current = "";
    announce();
    const timer = window.setInterval(announce, 2_000);
    return () => window.clearInterval(timer);
  }, [curriculumStage, phase, visibilityPaused]);

  const diagnosticHoldMs = Math.round(displayChargeSeconds * 5) * 200;
  useEffect(() => {
    pitchDiagnostics.record("voice-arcade", {
      kind: "workflow",
      workflow: {
        phase,
        state: controllerView?.status ?? phase,
        targetMidi: focusTarget?.targetMidi ?? null,
        attemptId: chamberNumber,
        holdMs: diagnosticHoldMs,
        requiredHoldMs: DISPLAY_CHARGE_SECONDS * 1_000,
        resetReason: scoringExcludedRef.current ? "reference-excluded" : null,
      },
    });
  }, [chamberNumber, controllerView?.status, diagnosticHoldMs, focusTarget?.targetMidi, phase]);

  useEffect(() => {
    return () => {
      sessionTokenRef.current += 1;
      cancelAnimation();
      clearPrompt();
    };
  }, [cancelAnimation, clearPrompt]);

  const activeStep = phase === "result" ? 2 : phase === "connecting" || phase === "playing" ? 1 : 0;
  const targetActivation = focusTarget && gameView
    ? gameView.resonatorActivations.find((activation) => activation.resonatorId === focusTarget.id) ?? null
    : null;
  const targetCoupled = resonatorIsCoupled(controllerView, focusTarget, targetActivation);
  const holdStatus = previewing
    || referenceReleaseRequired
    ? "paused"
    : targetCoupled
      ? "holding"
      : controllerView?.status === "uncertain"
          || controllerView?.status === "releasing"
          || controllerView?.status === "stale"
        ? "paused"
        : "waiting";
  const currentErrorCents = focusTarget && controllerView?.midiFloat !== null && controllerView?.midiFloat !== undefined
    ? (controllerView.midiFloat - focusTarget.targetMidi) * 100
    : null;
  const status = previewing
      ? "REFERENCE PLAYING · MICROPHONE EVIDENCE EXCLUDED"
      : referenceReleaseRequired
        ? "REFERENCE RELEASE CHECK · CLEAR VOICE ONCE"
      : controllerStatus(controllerView);
  const normalizerProgress = controllerView?.referenceSamplesDbfs.length ?? 0;
  const intensityPercent = Math.round((controllerView?.normalizedLevel ?? 0) * 100);
  const coherencePercent = Math.round((controllerView?.coherence ?? 0) * 100);
  const stabilityPercent = Math.round((controllerView?.stability ?? 0) * 100);
  const tunedPercent = Math.round((targetActivation?.effectiveEnergy ?? 0) * 100);
  const ballProgress = gameView ? goalProgressPercent(gameView) : 0;
  const guidanceTitle = previewing && focusTarget
      ? `Listen to ${noteLabel(focusTarget.targetMidi)}`
      : referenceReleaseRequired
        ? "Clear the reference tail"
        : targetCoupled
          ? "Resonator coupled"
          : focusTarget
            ? `Find ${noteLabel(focusTarget.targetMidi)}`
            : "Shape the goal field";
  const guidanceDetail = referenceReleaseRequired
      ? "Release your voice once. A clear unvoiced frame proves the speaker tail ended before fresh evidence can move the ball."
      : signalGuidance(controllerView, focusTarget, targetCoupled, curriculumStage === "background");
  const tutorialPaused = visibilityPaused
    || previewing
    || referenceReleaseRequired;
  const tutorialObjectiveView = selectedLesson && tutorialSessionView
    ? createResonanceTutorialObjectiveView(
      selectedLesson,
      tutorialSessionView.objective,
      controllerView,
      tutorialPaused,
    )
    : null;
  const tutorialRule = selectedLesson ? resonanceTutorialCausalRule(selectedLesson) : null;
  const tutorialPuzzleIndex = selectedLesson ? selectedLesson.order % 3 : 0;
  const tutorialMechanicLabel = selectedLesson
    ? resonanceTutorialMechanicLabel(selectedLesson.mechanic)
    : "Resonance";
  const nextLessonAfterProof = selectedLessonId
    ? nextAuthoredTutorialLessonId(selectedLessonId)
    : null;
  const referenceReplayAllowed = sessionKind === "tutorial"
    ? selectedLesson?.feedback.pitchMeter === true && focusTarget !== null
    : curriculum.feedback.allowReferenceReplay;
  const tutorialUsesPitchTarget = sessionKind === "tutorial"
    && selectedLesson?.feedback.pitchMeter === true
    && focusTarget !== null;
  const signalCoachEmphasis = selectedLesson?.mechanic === "force"
    ? "level" as const
    : selectedLesson?.mechanic === "stability"
      ? "coherence" as const
      : null;
  const signalCoachVisibleAxes = selectedLesson?.mechanic === "force"
    ? ["level"] as const
    : selectedLesson?.mechanic === "stability"
      ? ["coherence"] as const
      : [] as const;
  const tutorialSignalGuidanceTitle = tutorialPaused
    ? "Puzzle evidence paused"
    : tutorialSessionView?.objective.status === "passed"
      ? "Causal proof complete"
      : !controllerView?.evidenceReliable
        ? "Make a comfortable reliable tone"
        : selectedLesson?.mechanic === "force"
          ? `Relative energy ${intensityPercent}%`
          : selectedLesson?.mechanic === "sustain"
            ? "Keep the voice continuous"
            : selectedLesson?.mechanic === "stability"
              ? `Field coherence ${coherencePercent}%`
              : "Explore the candidate pitches";
  return (
    <div className={`resonance-page curriculum-${curriculumStage}`}>
      <div className="resonance-setup">
        <Panel className="resonance-briefing">
          <Eyebrow>Field School · one mechanic · three proofs</Eyebrow>
          <h1>{nextTutorialLesson ? nextTutorialLesson.title : "The foundations are proven."}</h1>
          <p>{nextTutorialLesson
            ? nextTutorialLesson.instruction
            : "Force, pitch resonance, sustain, and stability can now be composed inside generated chambers. The training archive remains available for deliberate replay."}</p>
          <div className="resonance-foundation-spotlight">
            <span>{nextTutorialLesson ? `PUZZLE ${nextTutorialLesson.order + 1} OF ${RESONANCE_TUTORIAL_LESSON_IDS.length}` : "12 OF 12 PROVEN"}</span>
            <strong>{nextTutorialLesson
              ? resonanceTutorialMechanicLabel(nextTutorialLesson.mechanic)
              : "COMBINED CHAMBERS UNLOCKED"}</strong>
            <small>{nextTutorialLesson?.observation ?? "Generated rooms may now combine every measured axis introduced by Field School."}</small>
          </div>
          <div className="resonance-start-actions">
            {nextTutorialLesson ? (
              <ActionButton
                className="primary wide"
                disabled={phase === "connecting"}
                onClick={() => openTutorialLesson(nextTutorialLesson.id)}
              ><Icon name="arrow" size={18} /> Continue Field School</ActionButton>
            ) : (
              <ActionButton
                className="primary wide"
                disabled={phase === "connecting"}
                onClick={() => { void startGeneratedRun(); }}
              ><Icon name="mic" size={18} /> {phase === "connecting" ? "Opening microphone…" : "Generate a combined chamber"}</ActionButton>
            )}
            <small role="status" aria-live="polite">{notice}</small>
          </div>
        </Panel>

        <Panel className="resonance-loadout">
          <header><Eyebrow>Discover → Control → Apply</Eyebrow><h2>{completedTutorialLessons}/12 causal proofs.</h2><p>A mechanic cannot enter normal puzzle vocabulary until you have discovered it, controlled it deliberately, and transferred it without hand-holding.</p></header>
          <div className="resonance-loadout-summary">
            <div><span>FOUNDATIONS</span><b>4</b></div>
            <div><span>PROOFS EACH</span><b>3</b></div>
            <div><span>VOICE ANCHOR</span><b>{noteLabel(voiceRange.baselineMidi)}</b></div>
          </div>
          <details className="resonance-training-archive" open={!nextTutorialLesson}>
            <summary>{nextTutorialLesson ? "Open the 12-puzzle training map" : "Training archive · replay any proof"}</summary>
            <ResonanceTutorialPath
              mechanics={tutorialPathCards}
              completedPuzzles={completedTutorialLessons}
              totalPuzzles={RESONANCE_TUTORIAL_LESSON_IDS.length}
              onSelectPuzzle={(puzzleId) => {
                if (isResonanceTutorialLessonId(puzzleId)) openTutorialLesson(puzzleId);
              }}
            />
          </details>
          <div className={`resonance-combined-lock ${combinedChambersUnlocked ? "unlocked" : "locked"}`}>
            <Icon name={combinedChambersUnlocked ? "spark" : "lock"} size={18} />
            <span><b>{combinedChambersUnlocked ? "COMBINED CHAMBERS READY" : `COMBINED CHAMBERS LOCKED · ${completedTutorialLessons}/12`}</b>{combinedChambersUnlocked ? `${curriculum.stageLabel} assistance and ${difficulty} mechanics apply only after onboarding.` : "No generated room will test two unknown voice variables at once."}</span>
            {combinedChambersUnlocked && <ActionButton onClick={() => { void startGeneratedRun(); }}>Generate chamber</ActionButton>}
          </div>
          <div className="resonance-safety-note"><Icon name="headphones" size={18} /><span><b>Headphones are recommended for note previews, never required.</b> NoteForge reference playback is explicitly excluded from force. A microphone cannot distinguish your voice from some external stable tones, so nearby speakers or instruments may still drive the detector. The automatic eight-frame comfort reference only normalizes relative loudness; it has no failure state and does not block movement.</span></div>
          {input.state === "running" && phase === "setup" && (
            <div className="resonance-microphone-retained" role="status">
              <span><b>MICROPHONE READY</b> The app-scoped stream remains active across navigation until you explicitly stop it or the browser ends it.</span>
              <ActionButton onClick={() => { input.disable(); setNotice("Microphone capture stopped. Enabling again may reuse browser permission or ask for it again."); }}>Stop microphone</ActionButton>
            </div>
          )}
        </Panel>
      </div>

      <WorkflowDialog open={workflowOpen} steps={sessionKind === "tutorial" ? TUTORIAL_WORKFLOW_STEPS : CHAMBER_WORKFLOW_STEPS} activeStep={activeStep} focusKey={`${phase}:${selectedLessonId ?? chamberNumber}`} label={sessionKind === "tutorial" ? "Resonance Field School puzzle workflow" : "Resonance acoustic-field puzzle workflow"} exitLabel={phase === "briefing" ? "Close lesson" : "Stop chamber"} onExit={closeWorkflow} className="resonance-workflow panel">
        {phase === "briefing" && selectedLesson && tutorialRule && (
          <WorkflowStage
            title="Read one causal contract."
            eyebrow={`Field School · puzzle ${selectedLesson.order + 1} of ${RESONANCE_TUTORIAL_LESSON_IDS.length}`}
            description="Nothing moves until you begin. This room measures the normal production evidence floor, then normalizes every voice dimension not named below."
          >
            <ResonanceLessonBrief
              mechanicLabel={tutorialMechanicLabel}
              puzzleKind={selectedLesson.stage}
              puzzleIndex={tutorialPuzzleIndex}
              title={selectedLesson.title}
              instruction={selectedLesson.instruction}
              ruleInput={tutorialRule.input}
              ruleOutput={tutorialRule.output}
              success={selectedLesson.causeAndEffect}
              normalized={tutorialRule.normalized}
            >
              <div className="nf-workflow-stage__actions resonance-lesson-brief__actions">
                <ActionButton onClick={closeWorkflow}>Back to Field School</ActionButton>
                <ActionButton className="primary" onClick={() => { void startTutorialLesson(selectedLesson.id); }}>
                  <Icon name="mic" size={17} /> Begin this puzzle
                </ActionButton>
              </div>
            </ResonanceLessonBrief>
          </WorkflowStage>
        )}

        {phase === "connecting" && (
          <WorkflowStage title="Opening the voice field" eyebrow={sessionKind === "tutorial" ? `Field School · ${tutorialMechanicLabel}` : "Resonance · local microphone"}>
            <div className="resonance-connecting"><div><span className="resonance-connecting-orb"><Icon name="mic" size={38} /></span><h2>Waiting for microphone access…</h2><p>The {sessionKind === "tutorial" ? "puzzle" : "chamber"} starts the moment the browser returns the retained or newly approved microphone and the canonical note stream is ready.</p>{connectionSlow && <div className="resonance-connection-help" role="status"><b>The browser has not returned the microphone request yet.</b><span>Check for a permission prompt or blocked microphone icon in the address bar. Cancel safely and try again.</span><ActionButton onClick={closeWorkflow}>Cancel microphone request</ActionButton></div>}</div></div>
          </WorkflowStage>
        )}

        {phase === "playing" && generated && gameView && controllerView && (
          <WorkflowStage
            eyebrow={sessionKind === "tutorial" && selectedLesson
              ? `Field School · puzzle ${selectedLesson.order + 1} of ${RESONANCE_TUTORIAL_LESSON_IDS.length} · ${selectedLesson.stage}`
              : `Generated chamber ${chamberNumber} · ${difficulty} mechanics`}
            title={sessionKind === "tutorial" && selectedLesson ? selectedLesson.title : "Steer the ball with a pressure field."}
            description={sessionKind === "tutorial" && selectedLesson
              ? `${selectedLesson.observation} ${selectedLesson.causeAndEffect}`
              : "Sing steadily to create bounded direct force. Match the focused resonator when you need its tuned pull through a gate, then release and let inertia work. The visualization is stylized; the pitch, level, periodicity, and stability evidence are measured locally."}
            status={<span>{status}</span>}
            statusLive={false}
            className="resonance-run-stage"
          >
            {sessionKind === "tutorial" && selectedLesson && tutorialSessionView && tutorialObjectiveView && (
              <ResonanceTutorialObjective
                mechanicLabel={tutorialMechanicLabel}
                puzzleKind={selectedLesson.stage}
                puzzleIndex={tutorialPuzzleIndex}
                title={selectedLesson.title}
                instruction={selectedLesson.instruction}
                metricLabel={tutorialObjectiveView.metricLabel}
                metricValue={tutorialObjectiveView.metricValue}
                progress={tutorialSessionView.objective.progress}
                progressText={tutorialObjectiveView.progressText}
                state={tutorialObjectiveView.state}
                hint={tutorialObjectiveView.hint}
              />
            )}
            <div className="resonance-play-layout">
              <section className="resonance-chamber-panel" aria-label="Live Resonance chamber">
                <div className="resonance-chamber-heading"><span>{sessionKind === "tutorial" ? "AUTHORED ISOLATION CHAMBER" : "DETERMINISTIC FIELD CHAMBER"} · {gameView.fixedStepCount.toLocaleString()} FIXED STEPS</span><b>{sessionKind === "tutorial" && tutorialSessionView ? `${Math.round(tutorialSessionView.objective.progress * 100)}% PROOF` : `${ballProgress.toFixed(0)}% TO GOAL`} · {gameView.status.toUpperCase()}</b></div>
                <ResonanceChamber
                  state={gameView}
                  metadata={generated.metadata}
                  focusResonatorId={focusTarget?.id ?? null}
                  showLabels={sessionKind === "tutorial" ? selectedLesson?.feedback.exactNote === true : curriculum.feedback.showPreviewLabels}
                  showRoute={sessionKind === "tutorial" ? selectedLesson?.feedback.forceZones === true : curriculumStage === "deliberate"}
                  showForceVector={sessionKind === "tutorial" || curriculumStage === "deliberate"}
                  reducedMotion={reducedMotion}
                  tutorial={sessionKind === "tutorial" && selectedLesson && tutorialSessionView
                    ? { lesson: selectedLesson, objective: tutorialSessionView.objective }
                    : undefined}
                />
                {visibilityPaused && (
                  <div className="resonance-pause-shield">
                    <div>
                      <Icon name="pause" size={28} />
                      <b>CHAMBER PAUSED</b>
                      <small>Hidden tabs do not simulate catch-up physics. Return here to continue.</small>
                    </div>
                  </div>
                )}
              </section>

              <section className="resonance-controller-panel" aria-label="Resonance voice controller">
                <div className="resonance-controller-heading"><span>VOICE → FIELD INTERPRETER</span><b>{sessionKind === "tutorial" ? `${tutorialMechanicLabel.toUpperCase()} ISOLATED` : curriculum.stageLabel.toUpperCase()}</b></div>
                {gameView.level.resonators.length > 0 && <div className="resonance-target-bank">
                  {gameView.level.resonators.map((resonator, index) => {
                    const focused = resonator.id === focusTarget?.id;
                    const activation = gameView.resonatorActivations[index];
                    const coupled = resonatorIsCoupled(controllerView, resonator, activation);
                    const showLabel = sessionKind === "tutorial"
                      ? selectedLesson?.feedback.exactNote === true
                      : curriculum.feedback.showPreviewLabels;
                    const content = <><span>{focused ? "CURRENT RESONATOR" : `RESONATOR ${index + 1}`}</span><strong>{showLabel ? noteLabel(resonator.targetMidi) : coupled ? "COUPLED" : focused ? "FOCUSED" : "HIDDEN"}</strong><small>{Math.round((activation?.effectiveEnergy ?? 0) * 100)}% energy</small></>;
                    return referenceReplayAllowed && focused
                      ? <button type="button" key={resonator.id} className={focused ? "focus" : ""} disabled={previewing} onClick={() => { void playReference(resonator.targetMidi); }} aria-label={`Hear ${noteLabel(resonator.targetMidi)} reference for resonator ${index + 1}`}>{content}</button>
                      : <div key={resonator.id} className={focused ? "focus" : ""}>{content}</div>;
                  })}
                </div>}

                {(sessionKind === "tutorial" ? tutorialUsesPitchTarget : curriculumStage !== "background" && focusTarget !== null) && focusTarget ? (
                  <NoteInput
                    variant="target"
                    input={input}
                    targetMidi={focusTarget.targetMidi}
                    toleranceCents={Math.round(focusTarget.bandwidthCents)}
                    phase={previewing ? "prompting" : referenceReleaseRequired ? "paused" : "listening"}
                    hold={{
                      heldSeconds: displayChargeSeconds,
                      requiredSeconds: sessionKind === "tutorial"
                        ? selectedLesson?.holdRequirementSeconds ?? DISPLAY_CHARGE_SECONDS
                        : DISPLAY_CHARGE_SECONDS,
                      status: holdStatus,
                    }}
                    guidanceTitle={guidanceTitle}
                    guidanceDetail={guidanceDetail}
                    diagnosticsFlow="voice-arcade"
                    feedbackLevel={sessionKind === "tutorial" ? "full" : curriculum.feedback.level}
                    guidanceLive={false}
                  />
                ) : sessionKind === "tutorial" && selectedLesson ? (
                  <NoteInput
                    variant="signal"
                    input={input}
                    relativeLevel={controllerView.normalizedLevel}
                    stability={controllerView.stability}
                    coherence={controllerView.coherence}
                    emphasis={signalCoachEmphasis}
                    visibleAxes={signalCoachVisibleAxes}
                    state={tutorialPaused
                      ? "paused"
                      : tutorialSessionView?.objective.status === "passed"
                        ? "complete"
                        : controllerView.evidenceReliable
                          ? "responding"
                          : "waiting"}
                    guidanceTitle={tutorialSignalGuidanceTitle}
                    guidanceDetail={tutorialObjectiveView?.progressText ?? selectedLesson.instruction}
                    title={`${tutorialMechanicLabel} voice evidence`}
                    guidanceLive={false}
                  />
                ) : (
                  <>
                    <NoteInput variant="compact" input={input} compact />
                    <div className="resonance-gameplay-controller"><span>GAME-FIRST FIELD FEEDBACK</span><strong>{targetCoupled ? "RESONATOR COUPLED" : controllerView.evidenceReliable ? "FIELD RESPONDING" : "LISTENING"}</strong><small>Pitch names and the tuner are hidden in Background control. Wave color, resonator activation, force, inertia, and collision response are the feedback.</small></div>
                  </>
                )}

                {sessionKind === "generated" && (
                  <>
                    <div className="resonance-controller-readout" aria-label="Derived control signal">
                      <div className={controllerView.evidenceReliable ? "good" : "warning"}><span>DETECTED</span><b>{curriculum.feedback.showLiveNote && controllerView.midiFloat !== null ? noteLabel(controllerView.midiFloat) : controllerView.evidenceReliable ? "STABLE" : "—"}</b></div>
                      <div className={stabilityPercent >= 65 ? "good" : "warning"}><span>STABILITY</span><b>{stabilityPercent}%</b></div>
                      <div className={coherencePercent >= 65 ? "good" : "warning"}><span>COHERENCE</span><b>{coherencePercent}%</b></div>
                      <div className={tunedPercent >= 8 ? "good" : "warning"}><span>TUNED FORCE</span><b>{tunedPercent}%</b></div>
                    </div>
                    <div className="resonance-energy-panel" style={{ "--resonance-meter": `${intensityPercent}%` } as CSSProperties}>
                      <div className="resonance-energy-heading"><span>BOUNDED RELATIVE ENERGY</span><b>{intensityPercent}% · {controllerView.relativeDb === null ? "REFERENCE FORMING" : `${signed(controllerView.relativeDb, 1)} dB RELATIVE`}</b></div>
                      <div className="resonance-energy-meter" role="meter" aria-label="Bounded relative voice energy" aria-valuemin={0} aria-valuemax={100} aria-valuenow={intensityPercent} aria-valuetext={`${intensityPercent} percent; comfortable reference near the marked efficient zone`}><i /><em /></div>
                      <div className="resonance-energy-scale"><span>QUIET</span><b>COMFORTABLE EFFICIENCY</b><span>OVERDRIVE TAPERS</span></div>
                    </div>
                    <div className="resonance-normalizer-note"><b>{controllerView.referenceLocked ? "COMFORT REFERENCE LOCKED" : `NONBLOCKING COMFORT REFERENCE ${normalizerProgress}/${RESONANCE_REFERENCE_FRAME_COUNT}`}</b><br />This session-relative loudness normalization does not filter or suspend the canonical note stream. Movement is available during the ramp and no result can fail here.</div>
                    {curriculumStage === "background" && <div className="resonance-live-notice">{guidanceDetail}</div>}
                  </>
                )}
                <div className="resonance-screen-reader-status" role="status" aria-live="polite" aria-atomic="true">{accessibleStatus}</div>
              </section>

              {sessionKind === "generated" && (
                <div className="resonance-live-stats" aria-label="Chamber status">
                  <div><span>CHAMBER TIME</span><b>{gameView.elapsedSeconds.toFixed(1)}s</b></div>
                  <div><span>BALL SPEED</span><b>{Math.hypot(gameView.ball.velocity.x, gameView.ball.velocity.y).toFixed(2)}</b></div>
                  <div><span>PHYSICS CONTACTS</span><b>{gameView.collisionCount}</b></div>
                  <div><span>APPLIED DRIVE</span><b>{Math.round(gameView.voice.directEnergy * 100)}%</b></div>
                  <div><span>FOCUS OFFSET</span><b>{currentErrorCents === null || !curriculum.feedback.showCents ? "—" : `${signed(currentErrorCents, 0)}¢`}</b></div>
                  <div><span>PRESSURE MODEL</span><b>STYLIZED</b></div>
                </div>
              )}
            </div>
            <div className="nf-workflow-stage__actions"><ActionButton onClick={restartChamber}><Icon name="loop" size={16} /> Restart {sessionKind === "tutorial" ? "puzzle" : "chamber"}</ActionButton>{referenceReplayAllowed && focusTarget && <ActionButton disabled={previewing} onClick={() => { void playReference(focusTarget.targetMidi); }}><Icon name="headphones" size={16} /> {previewing ? "Reference playing…" : `Hear ${noteLabel(focusTarget.targetMidi)}`}</ActionButton>}</div>
          </WorkflowStage>
        )}

        {phase === "result" && sessionKind === "tutorial" && selectedLesson && tutorialSessionView && tutorialProof && (
          <WorkflowStage
            title={tutorialProof.passed ? "Causal proof recorded." : "This proof needs a clean retry."}
            eyebrow={`Field School · puzzle ${selectedLesson.order + 1} of ${RESONANCE_TUTORIAL_LESSON_IDS.length}`}
            className="resonance-result"
          >
            <ResonanceTutorialProof
              passed={tutorialProof.passed}
              mechanicLabel={tutorialMechanicLabel}
              puzzleKind={selectedLesson.stage}
              title={tutorialProof.title}
              summary={tutorialProof.summary}
              primaryValue={tutorialProof.primaryValue}
              primaryLabel={tutorialProof.primaryLabel}
              evidence={tutorialProof.evidence}
              unlock={tutorialProof.unlock}
            >
              <div className="resonance-result-actions">
                <ActionButton onClick={closeWorkflow}>Back to Field School</ActionButton>
                {!tutorialProof.passed && (
                  <ActionButton className="primary" onClick={() => openTutorialLesson(selectedLesson.id)}>
                    <Icon name="loop" size={16} /> Review and retry
                  </ActionButton>
                )}
                {tutorialProof.passed && nextLessonAfterProof && (
                  <ActionButton className="primary" onClick={() => openTutorialLesson(nextLessonAfterProof)}>
                    Brief puzzle {selectedLesson.order + 2} <Icon name="arrow" size={16} />
                  </ActionButton>
                )}
                {tutorialProof.passed && !nextLessonAfterProof && (
                  <ActionButton className="primary" onClick={() => { void startGeneratedRun(); }}>
                    Generate first combined chamber <Icon name="arrow" size={16} />
                  </ActionButton>
                )}
              </div>
            </ResonanceTutorialProof>
          </WorkflowStage>
        )}

        {phase === "result" && sessionKind === "generated" && result && (
          <WorkflowStage title="The ball is captured." eyebrow={`Chamber ${chamberNumber} result · ${curriculum.stageLabel}`} className="resonance-result">
            <div className="resonance-result-mark">{result.grade}</div>
            <h2>{result.score} field-control score</h2>
            <p>The score rewards coherent, tuned, economical control—not microphone level by itself. A louder unstable note loses transfer efficiency, and the relative energy curve stops rewarding overdrive.</p>
            <div className="resonance-result-grid">
              <div><span>PATH EFFICIENCY</span><strong>{result.pathEfficiencyPercent.toFixed(0)}%</strong><small>authored gate route versus traveled path</small></div>
              <div><span>VOICE COHERENCE</span><strong>{result.coherentEfficiencyPercent.toFixed(0)}%</strong><small>stable periodic control time</small></div>
              <div><span>TUNED TRANSFER</span><strong>{result.tunedEfficiencyPercent.toFixed(0)}%</strong><small>energy coupled through resonators</small></div>
              <div><span>COLLISION CONTROL</span><strong>{result.collisionControlPercent.toFixed(0)}%</strong><small>{result.collisionCount} distinct contact episodes</small></div>
              <div><span>CHAMBER TIME</span><strong>{result.durationSeconds.toFixed(1)}s</strong><small>{result.speedPercent.toFixed(0)}% target pace</small></div>
            </div>
            <div className="resonance-result-proof">
              <div><span>BEST COHERENT HOLD</span><b>{result.bestCoherentHoldSeconds.toFixed(1)} seconds</b></div>
              <div><span>PEAK RELATIVE ENERGY</span><b>{result.peakRelativeDb === null ? "reference forming" : `${signed(result.peakRelativeDb, 1)} dB`}</b></div>
              <div><span>RELIABLE DERIVED FRAMES</span><b>{result.reliableFrames} · no PCM retained</b></div>
            </div>
            <div className="resonance-result-actions"><ActionButton onClick={onExit}>Back to cabinet</ActionButton><ActionButton onClick={replayResult}><Icon name="loop" size={16} /> Replay chamber</ActionButton><ActionButton className="primary" onClick={nextChamber}>Generate chamber {chamberNumber + 1} <Icon name="arrow" size={16} /></ActionButton></div>
          </WorkflowStage>
        )}
      </WorkflowDialog>
    </div>
  );
}
