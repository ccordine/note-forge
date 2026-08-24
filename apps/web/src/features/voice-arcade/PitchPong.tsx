import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { YinPitchFrame } from "@noteforge/pitch-engine";
import { useAudioInput, type AudioInputController } from "@/audio/use-audio-input";
import { noteLabel, signed } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import {
  createPongState,
  getDifficultyPreset,
  gradeChallengeScore,
  updatePongState,
  type PongConfig,
  type PongState,
} from "./model";
import { resolveArcadeCurriculum } from "./curriculum";
import type { ArcadeGameProps } from "./types";
import {
  advanceVoiceAxisController,
  createVoiceAxisController,
  freezeVoiceAxisController,
  updateVoiceAxisFromFrame,
  type VoiceAxisControllerOptions,
  type VoiceAxisControllerState,
} from "./voice-axis-controller";

type PongPhase = "setup" | "connecting" | "countdown" | "playing" | "paused" | "result";

interface PongRoundStats {
  playerReturns: number;
  maximumRally: number;
  reliableFrames: number;
  observedFrames: number;
  voicedControlSeconds: number;
  lowestPitchMidi: number | null;
  highestPitchMidi: number | null;
}

interface PongRoundResult {
  grade: ReturnType<typeof gradeChallengeScore>["grade"];
  gradeLabel: string;
  scorePercent: number;
  returnRatePercent: number;
  matchSharePercent: number;
  rangeCoveragePercent: number;
  maximumRally: number;
  playerReturns: number;
  incomingShots: number;
  playerScore: number;
  opponentScore: number;
  durationSeconds: number;
  lowestPitchMidi: number | null;
  highestPitchMidi: number | null;
  winner: PongState["winner"];
}

const COUNTDOWN_STEP_MS = 650;
const CONTROL_FRESHNESS_SECONDS = 0.35;
const EMPTY_STATS: PongRoundStats = {
  playerReturns: 0,
  maximumRally: 0,
  reliableFrames: 0,
  observedFrames: 0,
  voicedControlSeconds: 0,
  lowestPitchMidi: null,
  highestPitchMidi: null,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function gradeLabel(grade: PongRoundResult["grade"]): string {
  switch (grade) {
    case "A+": return "Total pitch command";
    case "A": return "Controlled and responsive";
    case "B": return "Strong vocal navigation";
    case "C": return "Rally control is forming";
    case "D": return "Keep the paddle in motion";
  }
}

function createDifficultyConfig(difficulty: ArcadeGameProps["difficulty"]): Partial<PongConfig> {
  if (difficulty === "easy") {
    return { winningScore: 3, paddleHeight: 0.3, ballSpeed: 0.33, aiSpeed: 0.2 };
  }
  if (difficulty === "hard") {
    return { winningScore: 7, paddleHeight: 0.17, ballSpeed: 0.57, aiSpeed: 0.34 };
  }
  return { winningScore: 5, paddleHeight: 0.22, ballSpeed: 0.44, aiSpeed: 0.27 };
}

function scoreRound(
  game: Readonly<PongState>,
  stats: Readonly<PongRoundStats>,
  rangeSpan: number,
): PongRoundResult {
  const incomingShots = stats.playerReturns + game.opponentScore;
  const returnRatePercent = incomingShots === 0 ? 0 : stats.playerReturns / incomingShots * 100;
  const decidedPoints = game.playerScore + game.opponentScore;
  const matchSharePercent = decidedPoints === 0 ? 0 : game.playerScore / decidedPoints * 100;
  const observedSpan = stats.lowestPitchMidi === null || stats.highestPitchMidi === null
    ? 0
    : stats.highestPitchMidi - stats.lowestPitchMidi;
  const rangeCoveragePercent = clamp(observedSpan / rangeSpan * 100, 0, 100);
  const rallyPercent = clamp(stats.maximumRally / 10 * 100, 0, 100);
  const scorePercent = Math.round(clamp(
    returnRatePercent * 0.5
      + matchSharePercent * 0.25
      + rallyPercent * 0.15
      + rangeCoveragePercent * 0.1,
    0,
    100,
  ));
  const { grade } = gradeChallengeScore(scorePercent);
  return {
    grade,
    gradeLabel: gradeLabel(grade),
    scorePercent,
    returnRatePercent,
    matchSharePercent,
    rangeCoveragePercent,
    maximumRally: stats.maximumRally,
    playerReturns: stats.playerReturns,
    incomingShots,
    playerScore: game.playerScore,
    opponentScore: game.opponentScore,
    durationSeconds: game.elapsedSeconds,
    lowestPitchMidi: stats.lowestPitchMidi,
    highestPitchMidi: stats.highestPitchMidi,
    winner: game.winner,
  };
}

export function PitchPong({
  difficulty,
  curriculumStage,
  voiceRange,
  onExit,
  onComplete,
}: ArcadeGameProps) {
  const [phase, setPhase] = useState<PongPhase>("setup");
  const [game, setGame] = useState<PongState | null>(null);
  const [countdown, setCountdown] = useState(3);
  const [status, setStatus] = useState("Glide through your mapped range to move the left paddle.");
  const [scoreFlash, setScoreFlash] = useState<"player" | "opponent" | null>(null);
  const [result, setResult] = useState<PongRoundResult | null>(null);

  const phaseRef = useRef<PongPhase>(phase);
  const gameRef = useRef<PongState | null>(game);
  const inputRef = useRef<AudioInputController | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastAnimationAtRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const scoreFlashTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const completedRef = useRef(false);
  const voiceAxisRef = useRef<VoiceAxisControllerState | null>(null);
  const statsRef = useRef<PongRoundStats>({ ...EMPTY_STATS });
  const finishRef = useRef<(finalGame: PongState, message: string) => void>(() => undefined);
  const pauseRef = useRef<(message?: string) => void>(() => undefined);
  const animationTickRef = useRef<(now: number) => void>(() => undefined);
  const onFrameRef = useRef<(frame: YinPitchFrame) => void>(() => undefined);

  phaseRef.current = phase;
  gameRef.current = game;

  const preset = getDifficultyPreset(difficulty);
  const curriculum = resolveArcadeCurriculum("pong", curriculumStage);
  const rangeSpan = Math.max(0.01, voiceRange.highMidi - voiceRange.lowMidi);
  const controllerDeadZoneCents = difficulty === "easy" ? 25 : difficulty === "hard" ? 10 : 18;
  const controllerDeadZoneSemitones = controllerDeadZoneCents / 100;
  const controllerCenterMidi = clamp(
    voiceRange.baselineMidi,
    voiceRange.lowMidi + controllerDeadZoneSemitones + 0.01,
    voiceRange.highMidi - controllerDeadZoneSemitones - 0.01,
  );
  const pongConfig = useMemo(() => createDifficultyConfig(difficulty), [difficulty]);
  const voiceAxisOptions = useMemo<VoiceAxisControllerOptions>(() => ({
    lowMidi: voiceRange.lowMidi,
    highMidi: voiceRange.highMidi,
    centerMidi: controllerCenterMidi,
    deadZoneCents: controllerDeadZoneCents,
    responsePerSecond: difficulty === "hard" ? 15 : 11,
    freshnessSeconds: CONTROL_FRESHNESS_SECONDS,
  }), [controllerCenterMidi, controllerDeadZoneCents, difficulty, voiceRange.highMidi, voiceRange.lowMidi]);

  const input = useAudioInput({
    onFrame: (frame) => onFrameRef.current(frame),
  });
  inputRef.current = input;

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(window.clearTimeout);
    timersRef.current = [];
    if (scoreFlashTimerRef.current !== null) {
      window.clearTimeout(scoreFlashTimerRef.current);
      scoreFlashTimerRef.current = null;
    }
  }, []);

  const cancelAnimation = useCallback(() => {
    if (animationRef.current !== null) {
      window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const finishGame = useCallback((finalGame: PongState, message: string) => {
    if (completedRef.current) return;
    completedRef.current = true;
    cancelAnimation();
    clearTimers();
    if (voiceAxisRef.current) {
      voiceAxisRef.current = freezeVoiceAxisController(voiceAxisRef.current);
    }
    phaseRef.current = "result";
    const summary = scoreRound(finalGame, statsRef.current, rangeSpan);
    gameRef.current = finalGame;
    setGame(finalGame);
    setResult(summary);
    setPhase("result");
    setStatus(message);
    onComplete({
      mode: "pong",
      curriculumStage,
      variant: "continuous-axis",
      score: summary.scorePercent,
      grade: summary.grade,
      xp: Math.round(summary.scorePercent * preset.scoreMultiplier),
      accuracy: summary.returnRatePercent,
      bestCombo: summary.maximumRally,
      durationMs: Math.round(summary.durationSeconds * 1_000),
      details: {
        playerScore: summary.playerScore,
        opponentScore: summary.opponentScore,
        playerReturns: summary.playerReturns,
        incomingShots: summary.incomingShots,
        matchSharePercent: summary.matchSharePercent,
        rangeCoveragePercent: summary.rangeCoveragePercent,
        reliableFrames: statsRef.current.reliableFrames,
        voicedControlSeconds: statsRef.current.voicedControlSeconds,
      },
    });
  }, [cancelAnimation, clearTimers, curriculumStage, onComplete, preset.scoreMultiplier, rangeSpan]);
  finishRef.current = finishGame;

  const triggerScoreFlash = useCallback((scorer: "player" | "opponent") => {
    setScoreFlash(scorer);
    if (scoreFlashTimerRef.current !== null) window.clearTimeout(scoreFlashTimerRef.current);
    scoreFlashTimerRef.current = window.setTimeout(() => {
      scoreFlashTimerRef.current = null;
      if (mountedRef.current) setScoreFlash(null);
    }, 720);
  }, []);

  animationTickRef.current = (now: number) => {
    if (phaseRef.current !== "playing" || !gameRef.current) return;
    const rawDeltaSeconds = lastAnimationAtRef.current === 0
      ? 0
      : (now - lastAnimationAtRef.current) / 1_000;
    lastAnimationAtRef.current = now;
    const deltaSeconds = clamp(rawDeltaSeconds, 0, 0.1);

    const currentAxis = voiceAxisRef.current
      ?? createVoiceAxisController(voiceAxisOptions);
    const nextAxis = advanceVoiceAxisController(currentAxis, {
      nowSeconds: now / 1_000,
      deltaSeconds,
    });
    voiceAxisRef.current = nextAxis;
    if (nextAxis.status === "steering") {
      statsRef.current.voicedControlSeconds += deltaSeconds;
    }

    const previous = gameRef.current;
    const next = updatePongState(previous, {
      deltaSeconds,
      voicePaddleY: nextAxis.position,
    });
    if (
      previous.ball.velocityX < 0
      && next.ball.velocityX > 0
      && next.rally > previous.rally
    ) {
      statsRef.current.playerReturns += 1;
    }
    statsRef.current.maximumRally = Math.max(statsRef.current.maximumRally, next.rally);
    if (next.playerScore > previous.playerScore) {
      triggerScoreFlash("player");
      setStatus("Point secured. Reset your pitch and read the next serve.");
    } else if (next.opponentScore > previous.opponentScore) {
      triggerScoreFlash("opponent");
      setStatus("Ball passed. Breathe, recenter, and catch the next line.");
    }
    gameRef.current = next;
    setGame(next);

    if (next.status === "finished") {
      finishRef.current(
        next,
        next.winner === "player"
          ? "Match won. Your voice held the court."
          : "Match complete. The result now shows exactly what to train next.",
      );
      return;
    }
    animationRef.current = window.requestAnimationFrame(animationTickRef.current);
  };

  const beginAnimation = useCallback(() => {
    cancelAnimation();
    phaseRef.current = "playing";
    setPhase("playing");
    setStatus("Court live. Sing higher to rise, lower to drop, or breathe to freeze.");
    lastAnimationAtRef.current = performance.now();
    animationRef.current = window.requestAnimationFrame(animationTickRef.current);
  }, [cancelAnimation]);

  onFrameRef.current = (frame) => {
    const receivedAtMs = performance.now();
    if (phaseRef.current !== "playing") {
      if (voiceAxisRef.current) {
        voiceAxisRef.current = freezeVoiceAxisController(voiceAxisRef.current);
      }
      return;
    }
    statsRef.current.observedFrames += 1;
    const currentAxis = voiceAxisRef.current
      ?? createVoiceAxisController(voiceAxisOptions);
    const update = updateVoiceAxisFromFrame(currentAxis, frame, receivedAtMs / 1_000);
    voiceAxisRef.current = update.state;
    if (!update.accepted || update.state.pitchMidi === null) return;
    const midiFloat = update.state.pitchMidi;
    statsRef.current.reliableFrames += 1;
    statsRef.current.lowestPitchMidi = Math.min(statsRef.current.lowestPitchMidi ?? Infinity, midiFloat);
    statsRef.current.highestPitchMidi = Math.max(statsRef.current.highestPitchMidi ?? -Infinity, midiFloat);
  };

  const prepareCountdown = useCallback((generation: number) => {
    if (!mountedRef.current || generation !== generationRef.current) return;
    const nextGame = createPongState({
      seed: `${Date.now()}:${difficulty}`,
      serveToward: "player",
      config: pongConfig,
    });
    gameRef.current = nextGame;
    setGame(nextGame);
    statsRef.current = { ...EMPTY_STATS };
    voiceAxisRef.current = createVoiceAxisController(voiceAxisOptions);
    setCountdown(3);
    phaseRef.current = "countdown";
    setPhase("countdown");
    setStatus(`Find ${noteLabel(controllerCenterMidi)} for center court.`);

    timersRef.current.push(window.setTimeout(() => setCountdown(2), COUNTDOWN_STEP_MS));
    timersRef.current.push(window.setTimeout(() => setCountdown(1), COUNTDOWN_STEP_MS * 2));
    timersRef.current.push(window.setTimeout(() => {
      if (generation !== generationRef.current || !mountedRef.current) return;
      setCountdown(0);
      beginAnimation();
    }, COUNTDOWN_STEP_MS * 3));
  }, [beginAnimation, controllerCenterMidi, difficulty, pongConfig, voiceAxisOptions]);

  const startRound = useCallback(async () => {
    if (phaseRef.current !== "setup") return;
    const generation = ++generationRef.current;
    completedRef.current = false;
    clearTimers();
    cancelAnimation();
    phaseRef.current = "connecting";
    setPhase("connecting");
    setStatus("Opening the retained local microphone…");
    setResult(null);
    const microphone = await inputRef.current?.enable();
    if (!mountedRef.current || generation !== generationRef.current) return;
    if (!microphone) {
      phaseRef.current = "setup";
      setPhase("setup");
      setStatus(inputRef.current?.error || "Microphone access is needed to control the paddle.");
      return;
    }

    const currentInput = inputRef.current;
    if (!currentInput) return;
    prepareCountdown(generation);
  }, [cancelAnimation, clearTimers, prepareCountdown]);

  const cancelBeforePlay = useCallback(() => {
    generationRef.current += 1;
    clearTimers();
    cancelAnimation();
    if (voiceAxisRef.current) {
      voiceAxisRef.current = freezeVoiceAxisController(voiceAxisRef.current);
    }
    gameRef.current = null;
    setGame(null);
    phaseRef.current = "setup";
    setPhase("setup");
    setStatus("Round cancelled. The microphone remains available for the next start.");
  }, [cancelAnimation, clearTimers]);

  const pauseGame = useCallback((message = "Match paused. Your paddle and ball are frozen." ) => {
    if (phaseRef.current !== "playing") return;
    cancelAnimation();
    if (voiceAxisRef.current) {
      voiceAxisRef.current = freezeVoiceAxisController(voiceAxisRef.current);
    }
    phaseRef.current = "paused";
    setPhase("paused");
    setStatus(message);
  }, [cancelAnimation]);
  pauseRef.current = pauseGame;

  const resumeGame = useCallback(() => {
    if (phaseRef.current !== "paused" || !gameRef.current || inputRef.current?.state !== "running") return;
    if (voiceAxisRef.current) {
      voiceAxisRef.current = freezeVoiceAxisController(voiceAxisRef.current);
    }
    beginAnimation();
  }, [beginAnimation]);

  const endActiveRound = useCallback(() => {
    if (!gameRef.current) {
      cancelBeforePlay();
      return;
    }
    finishRef.current(gameRef.current, "Round ended safely. Here is the control you demonstrated so far.");
  }, [cancelBeforePlay]);

  const resetToSetup = useCallback(() => {
    generationRef.current += 1;
    completedRef.current = false;
    setResult(null);
    setGame(null);
    gameRef.current = null;
    voiceAxisRef.current = null;
    statsRef.current = { ...EMPTY_STATS };
    setScoreFlash(null);
    setCountdown(3);
    phaseRef.current = "setup";
    setPhase("setup");
    setStatus("New court ready. The active app-scoped microphone stream will be reused when available.");
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const handleVisibility = () => {
      if (document.visibilityState === "hidden" && phaseRef.current === "playing") {
        pauseRef.current("Auto-paused because this tab was hidden. Nothing advanced offscreen.");
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && phaseRef.current === "playing") pauseRef.current();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      clearTimers();
      cancelAnimation();
      if (voiceAxisRef.current) {
        voiceAxisRef.current = freezeVoiceAxisController(voiceAxisRef.current);
      }
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("keydown", handleKeyDown);
      // Leave stream ownership untouched: AudioInputProvider retains the
      // permission-bearing capture for navigation and the next cabinet.
    };
  }, [cancelAnimation, clearTimers]);

  useEffect(() => {
    if (input.state === "error" && phaseRef.current === "playing") {
      pauseRef.current("Microphone disconnected. The match is paused; end it to review the score earned so far.");
    }
  }, [input.state]);

  const controllerSteering = phase === "playing"
    && voiceAxisRef.current?.status === "steering";
  const liveFrame = phase === "playing" ? input.liveFrame : undefined;
  const hasLivePitch = liveFrame?.voiced === true
    && liveFrame.midiFloat !== null;
  const detectedLabel = hasLivePitch && liveFrame.nearestMidi !== null
    ? noteLabel(liveFrame.nearestMidi)
    : "—";
  const detectedDetail = hasLivePitch && liveFrame.centsFromNearest !== null
    ? `${signed(liveFrame.centsFromNearest, 0)}¢`
    : "waiting for periodic pitch";
  const detectedDisplayLabel = curriculum.feedback.showLiveNote
    ? detectedLabel
    : hasLivePitch ? "DETECTED" : "—";
  const detectedDisplayDetail = curriculum.feedback.showCents
    ? detectedDetail
    : controllerSteering
      ? "voice axis steering"
      : hasLivePitch
        ? "pitch detected · controller confirming"
        : "paddle frozen";
  const microphoneRmsDbfs = input.telemetry?.rmsDbfs ?? null;
  const microphoneLevel = microphoneRmsDbfs === null
    ? 0
    : clamp((microphoneRmsDbfs + 96) / 96 * 100, 0, 100);
  const currentGame = game ?? createPongState({ seed: "pong-preview", config: pongConfig });
  const courtVariables = {
    "--pong-ball-x": `${currentGame.ball.x * 100}%`,
    "--pong-ball-y": `${currentGame.ball.y * 100}%`,
    "--pong-player-y": `${currentGame.playerPaddleY * 100}%`,
    "--pong-opponent-y": `${currentGame.opponentPaddleY * 100}%`,
    "--pong-player-x": `${currentGame.config.playerPaddleX * 100}%`,
    "--pong-opponent-x": `${currentGame.config.opponentPaddleX * 100}%`,
    "--pong-paddle-height": `${currentGame.config.paddleHeight * 100}%`,
    "--pong-paddle-width": `${currentGame.config.paddleWidth * 100}%`,
    "--pong-ball-diameter": `${currentGame.config.ballRadius * 200}%`,
  } as CSSProperties;
  const rangeLabels = [
    voiceRange.highMidi,
    (voiceRange.highMidi + controllerCenterMidi) / 2,
    controllerCenterMidi,
    (voiceRange.lowMidi + controllerCenterMidi) / 2,
    voiceRange.lowMidi,
  ].filter((_, index) => curriculum.feedback.rangeLabelDensity === "full"
    || curriculum.feedback.rangeLabelDensity === "anchors" && (index === 0 || index === 2 || index === 4));

  return (
    <section className={`arcade-game-shell pitch-pong-shell curriculum-${curriculumStage}`}>
      <div className="arcade-game-hud">
        <div className="pong-hud-score">
          <span>YOU</span><strong>{currentGame.playerScore}</strong><i>:</i><strong>{currentGame.opponentScore}</strong><span>CPU</span>
        </div>
        <div><span>RALLY</span><strong>{currentGame.rally}<small>×</small></strong></div>
        <div className="pong-hud-pitch"><span>VOICE</span><strong>{detectedDisplayLabel}</strong><small>{detectedDisplayDetail}</small></div>
        <div><span>FIRST TO</span><strong>{currentGame.config.winningScore}</strong></div>
        <div className="arcade-game-hud-actions">
          {phase === "playing" && <ActionButton onClick={() => pauseGame()}><Icon name="pause" size={16} /> Pause</ActionButton>}
          {(phase === "playing" || phase === "paused") && <ActionButton className="coral" onClick={endActiveRound}>Stop & grade</ActionButton>}
          {(phase === "connecting" || phase === "countdown") && <ActionButton onClick={cancelBeforePlay}>Cancel</ActionButton>}
          {(phase === "setup" || phase === "result") && <ActionButton onClick={onExit}><Icon name="arrow" size={16} /> Exit game</ActionButton>}
        </div>
      </div>

      {phase === "setup" && (
        <Panel className="arcade-game-loadout pong-game-loadout">
          <div>
            <Eyebrow>{curriculum.stageLabel} · Pitch Pong</Eyebrow>
            <h1>Your pitch is the paddle.</h1>
            <p>{curriculum.focus} Glide higher to rise and lower to drop. Silence freezes the paddle, so take real breaths instead of forcing nonstop sound.</p>
          </div>
          <div className="arcade-contract-grid">
            <span><b>{noteLabel(voiceRange.lowMidi)}–{noteLabel(voiceRange.highMidi)}</b><small>voice controller</small></span>
            <span><b>{noteLabel(controllerCenterMidi)}</b><small>center pitch</small></span>
            <span><b>{currentGame.config.winningScore}</b><small>points to win</small></span>
            <span><b>{preset.speedMultiplier.toFixed(2)}×</b><small>ball pace</small></span>
          </div>
          <div className="pong-instruction-strip">
            <span><i>↑</i><b>Sing higher</b><small>paddle rises</small></span>
            <span><i>↓</i><b>Sing lower</b><small>paddle drops</small></span>
            <span><i>◇</i><b>Go silent</b><small>paddle freezes</small></span>
          </div>
          {input.error && <div className="error-banner" role="alert">{input.error}</div>}
          <div className="arcade-start-row">
            <span>{status}</span>
            <ActionButton className="primary" disabled={input.state === "opening"} onClick={() => { void startRound(); }}>
              <Icon name="mic" size={18} /> {input.state === "opening" ? "Connecting…" : "Start pitch match"}
            </ActionButton>
          </div>
        </Panel>
      )}

      {(phase === "connecting" || phase === "countdown") && (
        <Panel className="arcade-countdown-stage">
          <NoteInput variant="compact" input={input} compact />
          <span className="arcade-countdown-orb">
            {phase === "connecting" ? <Icon name="mic" size={34} /> : countdown}
          </span>
          <Eyebrow>{phase === "connecting" ? "Connecting local pitch controller" : "Center your voice"}</Eyebrow>
          <h2 aria-live="polite" aria-atomic="true">{phase === "connecting" ? "Opening the microphone…" : countdown === 0 ? "GO" : noteLabel(controllerCenterMidi)}</h2>
          <p>{status}</p>
          <ActionButton onClick={cancelBeforePlay}>Cancel match</ActionButton>
        </Panel>
      )}

      {phase === "setup" && (
        <div className="pong-input-scope">
          <NoteInput
            variant="scope"
            input={input}
            title="Pitch Pong microphone setup"
            targetMidiFloat={controllerCenterMidi}
            toleranceCents={preset.toleranceCents}
          />
        </div>
      )}

      {(phase === "playing" || phase === "paused") && (
        <div className={`pong-play-stage ${phase === "paused" ? "is-paused" : ""}`}>
          <NoteInput variant="compact" input={input} compact />
          <div className="pong-voice-readout">
            <div className={`pong-detected-note ${hasLivePitch ? "is-voiced" : "is-silent"}`}>
              <span>{curriculum.feedback.showLiveNote ? "DETECTED PITCH" : "VOICE AXIS"}</span><strong>{detectedDisplayLabel}</strong><small>{detectedDisplayDetail}</small>
            </div>
            {curriculum.feedback.rangeLabelDensity === "none"
              ? <div className="pong-background-cue"><span>BACKGROUND CONTROL</span><strong>Eyes on the ball</strong><small>The paddle is the pitch feedback now.</small></div>
              : <div className="pong-range-readout" aria-label={`Controller range ${noteLabel(voiceRange.lowMidi)} through ${noteLabel(voiceRange.highMidi)}`}>
                <span>{noteLabel(voiceRange.highMidi)}</span>
                <div className="pong-range-track"><i style={{ "--pong-voice-y": `${currentGame.playerPaddleY * 100}%` } as CSSProperties} /></div>
                <b>{noteLabel(controllerCenterMidi)} center</b>
                <span>{noteLabel(voiceRange.lowMidi)}</span>
              </div>}
            <div className={`pong-silence-cue ${controllerSteering ? "is-steering" : "is-frozen"}`}>
              <span>{controllerSteering ? "STEERING" : "BREATH / SILENCE"}</span>
              <strong>{controllerSteering ? "Paddle tracking voice" : "Paddle frozen safely"}</strong>
              <div className="pong-mic-meter" role="meter" aria-label="Microphone level" aria-valuemin={-96} aria-valuemax={0} aria-valuenow={microphoneRmsDbfs === null ? undefined : Math.round(clamp(microphoneRmsDbfs, -96, 0))} aria-valuetext={microphoneRmsDbfs === null ? "No input" : `${microphoneRmsDbfs.toFixed(1)} dBFS`}><i style={{ width: `${microphoneLevel}%` }} /></div>
            </div>
          </div>

          <div
            className={`pong-court ${scoreFlash ? `score-${scoreFlash}` : ""}`}
            style={courtVariables}
            role="img"
            aria-label={`Pitch Pong court. You ${currentGame.playerScore}, computer ${currentGame.opponentScore}. Current rally ${currentGame.rally}.`}
          >
            <div className="pong-court-grid" aria-hidden="true" />
            <div className="pong-net" aria-hidden="true" />
            {rangeLabels.map((midi, index) => (
              <span className={`pong-range-label ${index === 0 ? "pong-range-high" : index === rangeLabels.length - 1 ? "pong-range-low" : ""}`} key={`${midi}-${index}`}>{noteLabel(midi)}</span>
            ))}
            <span className="pong-paddle pong-player" aria-hidden="true" />
            <span className="pong-paddle pong-opponent" aria-hidden="true" />
            <span className="pong-ball-trail" aria-hidden="true" />
            <span className="pong-ball" aria-hidden="true" />
            {scoreFlash && <strong className="pong-score-flash" aria-live="polite">{scoreFlash === "player" ? "POINT" : "MISSED"}</strong>}

            {phase === "paused" && (
              <Panel className="pong-pause-overlay" role="dialog" aria-modal="false" aria-labelledby="pong-paused-title">
                <Icon name="pause" size={30} />
                <Eyebrow>Everything is frozen</Eyebrow>
                <h2 id="pong-paused-title">Match paused</h2>
                <p>{status}</p>
                <div>
                  <ActionButton className="primary" disabled={input.state !== "running"} onClick={resumeGame}><Icon name="play" size={16} /> {input.state === "running" ? "Resume" : "Input unavailable"}</ActionButton>
                  <ActionButton className="coral" onClick={endActiveRound}>End & grade</ActionButton>
                </div>
              </Panel>
            )}
          </div>

          <div className="pong-live-footer">
            <span>{status}</span>
            <div className="pong-rally-meter"><small>LONGEST RALLY</small><b>{statsRef.current.maximumRally}×</b><i><span style={{ width: `${clamp(statsRef.current.maximumRally / 10 * 100, 0, 100)}%` }} /></i></div>
          </div>
        </div>
      )}

      {phase === "result" && result && (
        <Panel className="arcade-result-stage pong-result-stage">
          <div className="arcade-result-grade">
            <span>CONTROL GRADE</span><strong>{result.grade}</strong><b>{result.scorePercent}<small>/100</small></b>
          </div>
          <div className="arcade-result-copy">
            <Eyebrow>{result.winner === "player" ? "Pitch match won" : "Pitch match complete"}</Eyebrow>
            <h2>{result.gradeLabel}</h2>
            <p>{status} Breathing time was neutral; only demonstrated steering and actual ball exchanges shaped this grade.</p>
            <div className="arcade-result-metrics">
              <span><small>Returns made</small><b>{result.playerReturns}/{result.incomingShots || "—"}</b></span>
              <span><small>Return rate</small><b>{result.returnRatePercent.toFixed(0)}%</b></span>
              <span><small>Longest rally</small><b>{result.maximumRally}×</b></span>
              <span><small>Match score</small><b>{result.playerScore}–{result.opponentScore}</b></span>
              <span><small>Range explored</small><b>{result.rangeCoveragePercent.toFixed(0)}%</b></span>
              <span><small>Observed notes</small><b>{result.lowestPitchMidi === null || result.highestPitchMidi === null ? "—" : `${noteLabel(result.lowestPitchMidi)}–${noteLabel(result.highestPitchMidi)}`}</b></span>
            </div>
            <div className="arcade-result-actions">
              <ActionButton onClick={onExit}>Back to cabinet</ActionButton>
              <ActionButton className="primary" onClick={resetToSetup}>Play another match <Icon name="arrow" size={16} /></ActionButton>
            </div>
          </div>
        </Panel>
      )}
    </section>
  );
}
