import type { PitchObservation } from "@/audio/note-input";
import { noteLabel } from "@/lib/music-display";
import { clamp, clampPercent } from "@/lib/numeric";
import { isAuthoritativeVoicedPitch } from "@/realtime/authoritative-voiced-pitch";
import {
  observationContinuity,
  type ObservationSampleAuthority,
} from "@/realtime/observation-continuity";
import { resolveArcadeCurriculum } from "./curriculum";
import { gradeChallengeScore } from "./model";
import {
  createPongState,
  updatePongState,
  type PongConfig,
  type PongState,
} from "./pong-physics";
import type {
  ArcadeDifficultyId,
  ArcadeCurriculumStage,
  ArcadeVoiceRange,
  ResolvedArcadeCurriculum,
} from "./types";
import {
  advanceVoiceAxisController,
  createVoiceAxisController,
  updateVoiceAxisFromFrame,
  type VoiceAxisControllerOptions,
  type VoiceAxisControllerState,
} from "./voice-axis-controller";

export type PongPhase = "setup" | "countdown" | "playing" | "result";

export interface PongRoundStats {
  readonly playerReturns: number;
  readonly playerPoints: number;
  readonly opponentPoints: number;
  readonly maximumRally: number;
  readonly reliableFrames: number;
  readonly observedFrames: number;
  readonly activeSampleSeconds: number;
  readonly voicedControlSeconds: number;
  readonly lowestPitchMidi: number | null;
  readonly highestPitchMidi: number | null;
}

export interface PongRoundResult {
  readonly grade: ReturnType<typeof gradeChallengeScore>["grade"];
  readonly gradeLabel: string;
  readonly scorePercent: number;
  readonly returnRatePercent: number;
  readonly matchSharePercent: number;
  readonly rangeCoveragePercent: number;
  readonly maximumRally: number;
  readonly playerReturns: number;
  readonly incomingShots: number;
  readonly playerScore: number;
  readonly opponentScore: number;
  readonly durationSeconds: number;
  readonly lowestPitchMidi: number | null;
  readonly highestPitchMidi: number | null;
  readonly winner: PongState["winner"];
}

export interface PitchPongSpec {
  readonly difficulty: ArcadeDifficultyId;
  readonly curriculumStage: ArcadeCurriculumStage;
  readonly voiceRange: ArcadeVoiceRange;
  readonly curriculum: ResolvedArcadeCurriculum;
  readonly controllerCenterMidi: number;
  readonly rangeSpan: number;
  readonly pongConfig: Readonly<Partial<PongConfig>>;
  readonly voiceAxisOptions: VoiceAxisControllerOptions;
}

export interface PitchPongState {
  readonly phase: PongPhase;
  readonly game: PongState;
  readonly countdown: number;
  readonly status: string;
  readonly scoreFlash: "player" | "opponent" | null;
  readonly scoreFlashUntilSeconds: number | null;
  readonly result: PongRoundResult | null;
  readonly latestAchievement: PongRoundResult | null;
  readonly achievementCount: number;
  readonly voiceAxis: VoiceAxisControllerState;
  readonly stats: PongRoundStats;
  readonly lastAuthority: ObservationSampleAuthority | null;
  readonly roundNumber: number;
  readonly spec: PitchPongSpec;
}

export type PitchPongAction =
  | { readonly type: "start" }
  | { readonly type: "countdown"; readonly remaining: number }
  | { readonly type: "observation"; readonly observation: PitchObservation }
  | { readonly type: "cancel" }
  | { readonly type: "finish"; readonly message: string }
  | { readonly type: "reset" };

const SCORE_FLASH_SECONDS = 0.72;

function difficultyConfig(difficulty: ArcadeDifficultyId): Readonly<Partial<PongConfig>> {
  if (difficulty === "easy") {
    return Object.freeze({ winningScore: 3, paddleHeight: 0.3, ballSpeed: 0.33, aiSpeed: 0.2 });
  }
  if (difficulty === "hard") {
    return Object.freeze({ winningScore: 7, paddleHeight: 0.17, ballSpeed: 0.57, aiSpeed: 0.34 });
  }
  return Object.freeze({ winningScore: 5, paddleHeight: 0.22, ballSpeed: 0.44, aiSpeed: 0.27 });
}

export function createPitchPongSpec(options: Readonly<{
  difficulty: ArcadeDifficultyId;
  curriculumStage: ArcadeCurriculumStage;
  voiceRange: ArcadeVoiceRange;
}>): PitchPongSpec {
  const rangeSpan = Math.max(0.01, options.voiceRange.highMidi - options.voiceRange.lowMidi);
  const deadZoneCents = options.difficulty === "easy" ? 25 : options.difficulty === "hard" ? 10 : 18;
  const deadZoneSemitones = deadZoneCents / 100;
  const controllerCenterMidi = clamp(
    options.voiceRange.baselineMidi,
    options.voiceRange.lowMidi + deadZoneSemitones + 0.01,
    options.voiceRange.highMidi - deadZoneSemitones - 0.01,
  );
  return Object.freeze({
    ...options,
    voiceRange: Object.freeze({ ...options.voiceRange }),
    curriculum: resolveArcadeCurriculum("pong", options.curriculumStage),
    controllerCenterMidi,
    rangeSpan,
    pongConfig: difficultyConfig(options.difficulty),
    voiceAxisOptions: Object.freeze({
      lowMidi: options.voiceRange.lowMidi,
      highMidi: options.voiceRange.highMidi,
      centerMidi: controllerCenterMidi,
      deadZoneCents,
      responsePerSecond: options.difficulty === "hard" ? 15 : 11,
    }),
  });
}

function emptyStats(): PongRoundStats {
  return Object.freeze({
    playerReturns: 0,
    playerPoints: 0,
    opponentPoints: 0,
    maximumRally: 0,
    reliableFrames: 0,
    observedFrames: 0,
    activeSampleSeconds: 0,
    voicedControlSeconds: 0,
    lowestPitchMidi: null,
    highestPitchMidi: null,
  });
}

function resetAxis(state: Readonly<VoiceAxisControllerState>): VoiceAxisControllerState {
  return createVoiceAxisController({
    ...state.options,
    initialPosition: state.position,
  });
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

function scoreRound(
  game: Readonly<PongState>,
  stats: Readonly<PongRoundStats>,
  rangeSpan: number,
): PongRoundResult {
  const incomingShots = stats.playerReturns + stats.opponentPoints;
  const returnRatePercent = incomingShots === 0 ? 0 : stats.playerReturns / incomingShots * 100;
  const decidedPoints = stats.playerPoints + stats.opponentPoints;
  const matchSharePercent = decidedPoints === 0 ? 0 : stats.playerPoints / decidedPoints * 100;
  const observedSpan = stats.lowestPitchMidi === null || stats.highestPitchMidi === null
    ? 0
    : stats.highestPitchMidi - stats.lowestPitchMidi;
  const rangeCoveragePercent = clampPercent(observedSpan / rangeSpan * 100);
  const rallyPercent = clampPercent(stats.maximumRally / 10 * 100);
  const scorePercent = Math.round(clampPercent(
    returnRatePercent * 0.5
      + matchSharePercent * 0.25
      + rallyPercent * 0.15
      + rangeCoveragePercent * 0.1,
  ));
  const { grade } = gradeChallengeScore(scorePercent);
  return Object.freeze({
    grade,
    gradeLabel: gradeLabel(grade),
    scorePercent,
    returnRatePercent,
    matchSharePercent,
    rangeCoveragePercent,
    maximumRally: stats.maximumRally,
    playerReturns: stats.playerReturns,
    incomingShots,
    playerScore: stats.playerPoints,
    opponentScore: stats.opponentPoints,
    durationSeconds: stats.activeSampleSeconds,
    lowestPitchMidi: stats.lowestPitchMidi,
    highestPitchMidi: stats.highestPitchMidi,
    winner: game.winner,
  });
}

function finishState(
  state: Readonly<PitchPongState>,
  game: PongState,
  stats: PongRoundStats,
  message: string,
): PitchPongState {
  return Object.freeze({
    ...state,
    phase: "result",
    game,
    status: message,
    scoreFlash: null,
    scoreFlashUntilSeconds: null,
    result: scoreRound(game, stats, state.spec.rangeSpan),
    voiceAxis: resetAxis(state.voiceAxis),
    stats,
    lastAuthority: null,
  });
}

export function createPitchPongState(spec: PitchPongSpec): PitchPongState {
  return Object.freeze({
    phase: "setup",
    game: createPongState({ seed: "pong-preview", config: spec.pongConfig }),
    countdown: 3,
    status: "Glide through your mapped range to move the left paddle.",
    scoreFlash: null,
    scoreFlashUntilSeconds: null,
    result: null,
    latestAchievement: null,
    achievementCount: 0,
    voiceAxis: createVoiceAxisController(spec.voiceAxisOptions),
    stats: emptyStats(),
    lastAuthority: null,
    roundNumber: 0,
    spec,
  });
}

function consumeObservation(
  state: Readonly<PitchPongState>,
  observation: Readonly<PitchObservation>,
): PitchPongState {
  if (state.phase !== "playing") return state as PitchPongState;
  const continuity = observationContinuity(state.lastAuthority, observation);
  if (!continuity.accepted || continuity.authority === null) return state as PitchPongState;
  const deltaSeconds = continuity.deltaSeconds;
  const boundary = continuity.boundary;
  const previousAxis = boundary ? resetAxis(state.voiceAxis) : state.voiceAxis;
  const reliable = isAuthoritativeVoicedPitch(observation);
  const advancedAxis = reliable && previousAxis.status === "steering" && deltaSeconds > 0
    ? advanceVoiceAxisController(previousAxis, { deltaSeconds })
    : previousAxis;
  const axisUpdate = updateVoiceAxisFromFrame(advancedAxis, observation);
  const midiFloat = axisUpdate.accepted ? axisUpdate.state.pitchMidi : null;
  const previousGame = state.game;
  const nextGame = updatePongState(previousGame, {
    deltaSeconds,
    voicePaddleY: axisUpdate.state.position,
  });
  const nextStats = Object.freeze({
    ...state.stats,
    observedFrames: state.stats.observedFrames + 1,
    reliableFrames: state.stats.reliableFrames + (axisUpdate.accepted ? 1 : 0),
    playerPoints: state.stats.playerPoints
      + Math.max(0, nextGame.playerScore - previousGame.playerScore),
    opponentPoints: state.stats.opponentPoints
      + Math.max(0, nextGame.opponentScore - previousGame.opponentScore),
    activeSampleSeconds: state.stats.activeSampleSeconds + deltaSeconds,
    voicedControlSeconds: state.stats.voicedControlSeconds
      + (axisUpdate.accepted && previousAxis.status === "steering" ? deltaSeconds : 0),
    lowestPitchMidi: midiFloat === null
      ? state.stats.lowestPitchMidi
      : Math.min(state.stats.lowestPitchMidi ?? Infinity, midiFloat),
    highestPitchMidi: midiFloat === null
      ? state.stats.highestPitchMidi
      : Math.max(state.stats.highestPitchMidi ?? -Infinity, midiFloat),
  });
  const playerReturned = previousGame.ball.velocityX < 0
    && nextGame.ball.velocityX > 0
    && nextGame.rally > previousGame.rally;
  const stats = playerReturned
    ? Object.freeze({
        ...nextStats,
        playerReturns: nextStats.playerReturns + 1,
        maximumRally: Math.max(nextStats.maximumRally, nextGame.rally),
      })
    : Object.freeze({
        ...nextStats,
        maximumRally: Math.max(nextStats.maximumRally, nextGame.rally),
      });
  let scoreFlash = state.scoreFlash;
  let scoreFlashUntilSeconds = state.scoreFlashUntilSeconds;
  let status = state.status;
  if (scoreFlashUntilSeconds !== null && observation.timeSeconds >= scoreFlashUntilSeconds) {
    scoreFlash = null;
    scoreFlashUntilSeconds = null;
  }
  if (nextGame.playerScore > previousGame.playerScore) {
    scoreFlash = "player";
    scoreFlashUntilSeconds = observation.timeSeconds + SCORE_FLASH_SECONDS;
    status = "Point secured. Reset your pitch and read the next serve.";
  } else if (nextGame.opponentScore > previousGame.opponentScore) {
    scoreFlash = "opponent";
    scoreFlashUntilSeconds = observation.timeSeconds + SCORE_FLASH_SECONDS;
    status = "Ball passed. Breathe, recenter, and catch the next line.";
  }
  if (nextGame.status === "finished") {
    const achievementCount = state.achievementCount + 1;
    const latestAchievement = scoreRound(nextGame, stats, state.spec.rangeSpan);
    const serveToward = nextGame.winner === "player" ? "opponent" : "player";
    return Object.freeze({
      ...state,
      game: createPongState({
        seed: `pong:${state.spec.difficulty}:${state.roundNumber}:${achievementCount}`,
        serveToward,
        config: state.spec.pongConfig,
      }),
      status: nextGame.winner === "player"
        ? "Match won. The court stays live until you stop."
        : "CPU took the match. The next serve is already live.",
      scoreFlash,
      scoreFlashUntilSeconds,
      latestAchievement,
      achievementCount,
      voiceAxis: axisUpdate.state,
      stats,
      lastAuthority: continuity.authority,
    });
  }
  return Object.freeze({
    ...state,
    game: nextGame,
    status,
    scoreFlash,
    scoreFlashUntilSeconds,
    voiceAxis: axisUpdate.state,
    stats,
    lastAuthority: continuity.authority,
  });
}

export function reducePitchPongState(
  state: Readonly<PitchPongState>,
  action: Readonly<PitchPongAction>,
): PitchPongState {
  switch (action.type) {
    case "start": {
      if (state.phase !== "setup") return state as PitchPongState;
      const roundNumber = state.roundNumber + 1;
      return Object.freeze({
        ...state,
        phase: "countdown",
        game: createPongState({
          seed: `pong:${state.spec.difficulty}:${roundNumber}`,
          serveToward: "player",
          config: state.spec.pongConfig,
        }),
        countdown: 3,
        status: `Find ${noteLabel(state.spec.controllerCenterMidi)} for center court.`,
        scoreFlash: null,
        scoreFlashUntilSeconds: null,
        result: null,
        latestAchievement: null,
        achievementCount: 0,
        voiceAxis: createVoiceAxisController(state.spec.voiceAxisOptions),
        stats: emptyStats(),
        lastAuthority: null,
        roundNumber,
      });
    }
    case "countdown":
      if (state.phase !== "countdown") return state as PitchPongState;
      return action.remaining === 0
        ? Object.freeze({
            ...state,
            phase: "playing",
            countdown: 0,
            status: "Court live. Sing higher to rise, lower to drop, or breathe to freeze.",
            lastAuthority: null,
          })
        : Object.freeze({ ...state, countdown: action.remaining });
    case "observation": return consumeObservation(state, action.observation);
    case "cancel":
      return state.phase === "countdown"
        ? Object.freeze({
            ...createPitchPongState(state.spec),
            roundNumber: state.roundNumber,
            status: "Round cancelled. The microphone remains available for the next start.",
          })
        : state as PitchPongState;
    case "finish":
      return state.phase === "playing"
        ? finishState(state, state.game, state.stats, action.message)
        : state as PitchPongState;
    case "reset": {
      const reset = createPitchPongState(state.spec);
      return Object.freeze({
        ...reset,
        roundNumber: state.roundNumber,
        status: "New court ready. The app-owned microphone stream stays continuous.",
      });
    }
  }
}
