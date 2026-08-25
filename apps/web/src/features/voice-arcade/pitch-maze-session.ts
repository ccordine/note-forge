import type { PitchObservation } from "../../audio/note-input";
import { getDifficultyPreset } from "./model";
import {
  createPitchMazeController,
  updatePitchMazeController,
  type PitchMazeCommandQuality,
  type PitchMazeControllerState,
} from "./pitch-maze-controller";
import {
  applyCompletedPitchMazeMove,
  createPitchMazeLevel,
  getPitchMazeShortestPathLength,
  type CardinalDirection,
  type PitchMazeLevel,
  type PitchMazeMappingMode,
} from "./pitch-maze-model";
import type {
  ArcadeCurriculumStage,
  ArcadeDifficultyId,
  ArcadeOutcome,
  ArcadeVoiceRange,
} from "./types";

export const PITCH_MAZE_CAMPAIGN_LEVELS = 5;
export const PITCH_MAZE_MAX_RETAINED_COMMANDS = 128;

export type PitchMazeSessionPhase =
  | "setup"
  | "playing"
  | "campaign-result";

export type PitchMazeCommandResult = "moved" | "wall";

export interface RecordedPitchMazeCommand extends PitchMazeCommandQuality {
  readonly level: number;
  readonly result: PitchMazeCommandResult;
}

/** Exact aggregate authority; the command array is only a bounded recent window. */
export interface PitchMazeCommandMetrics {
  readonly commandCount: number;
  readonly movedCommandCount: number;
  readonly blockedCommandCount: number;
  readonly qualityTotal: number;
  readonly inBandPercentTotal: number;
  readonly absoluteAttackErrorTotalCents: number;
  readonly settleTotalMs: number;
  readonly spreadTotalCents: number;
  readonly overshootCount: number;
  readonly currentQualityCombo: number;
  readonly bestQualityCombo: number;
  readonly lastCommand: RecordedPitchMazeCommand | null;
}

export interface PitchMazeLevelResult {
  readonly level: number;
  readonly rows: number;
  readonly columns: number;
  readonly optimalMoves: number;
  readonly moves: number;
  readonly commands: number;
  readonly blockedCommands: number;
  readonly durationMs: number;
  readonly averageQuality: number;
  readonly pitchAccuracy: number;
  readonly navigationEfficiency: number;
  readonly lastCommand: RecordedPitchMazeCommand;
}

export interface PitchMazeCampaignSpec {
  readonly seed: string;
  readonly difficulty: ArcadeDifficultyId;
  readonly curriculumStage: ArcadeCurriculumStage;
  readonly voiceRange: ArcadeVoiceRange;
  readonly mappingMode: PitchMazeMappingMode;
}

export interface PitchMazeSessionState {
  readonly phase: PitchMazeSessionPhase;
  readonly mappingMode: PitchMazeMappingMode;
  readonly campaign: PitchMazeCampaignSpec | null;
  readonly levelNumber: number;
  readonly level: PitchMazeLevel | null;
  readonly controller: PitchMazeControllerState | null;
  readonly selectedDirection: CardinalDirection;
  readonly commands: readonly RecordedPitchMazeCommand[];
  readonly currentLevelMetrics: PitchMazeCommandMetrics;
  readonly campaignMetrics: PitchMazeCommandMetrics;
  /** Includes every command until explicit Finish, including post-goal play. */
  readonly observedCommandCount: number;
  readonly levelResults: readonly PitchMazeLevelResult[];
  readonly currentResult: PitchMazeLevelResult | null;
  readonly lastCommandResult: PitchMazeCommandResult | null;
  readonly levelStartedAtSeconds: number | null;
  readonly campaignStartedAtSeconds: number | null;
  readonly lastObservedAtSeconds: number | null;
  readonly levelOptimalMoves: number;
  readonly notice: string;
  /** Exact snapshot when the fifth maze was first cleared; never terminal. */
  readonly achievementOutcome: ArcadeOutcome | null;
  /** Whole-session outcome created only by explicit Finish. */
  readonly outcome: ArcadeOutcome | null;
}

export type PitchMazeSessionAction =
  | { readonly type: "set-mapping"; readonly mappingMode: PitchMazeMappingMode }
  | { readonly type: "start"; readonly campaign: PitchMazeCampaignSpec }
  | { readonly type: "observation"; readonly observation: PitchObservation }
  | { readonly type: "continue" }
  | { readonly type: "finish" }
  | { readonly type: "reset" };

function gradeFor(score: number): string {
  if (score >= 94) return "S";
  if (score >= 86) return "A";
  if (score >= 76) return "B";
  if (score >= 64) return "C";
  return "D";
}

function createCommandMetrics(): PitchMazeCommandMetrics {
  return Object.freeze({
    commandCount: 0,
    movedCommandCount: 0,
    blockedCommandCount: 0,
    qualityTotal: 0,
    inBandPercentTotal: 0,
    absoluteAttackErrorTotalCents: 0,
    settleTotalMs: 0,
    spreadTotalCents: 0,
    overshootCount: 0,
    currentQualityCombo: 0,
    bestQualityCombo: 0,
    lastCommand: null,
  });
}

function recordCommandMetrics(
  metrics: Readonly<PitchMazeCommandMetrics>,
  command: Readonly<RecordedPitchMazeCommand>,
): PitchMazeCommandMetrics {
  const moved = command.result === "moved";
  const currentQualityCombo = moved && command.qualityScore >= 75
    ? metrics.currentQualityCombo + 1
    : 0;
  return Object.freeze({
    commandCount: metrics.commandCount + 1,
    movedCommandCount: metrics.movedCommandCount + Number(moved),
    blockedCommandCount: metrics.blockedCommandCount + Number(!moved),
    qualityTotal: metrics.qualityTotal + command.qualityScore,
    inBandPercentTotal: metrics.inBandPercentTotal + command.inBandRatio * 100,
    absoluteAttackErrorTotalCents: metrics.absoluteAttackErrorTotalCents
      + Math.abs(command.attackErrorCents),
    settleTotalMs: metrics.settleTotalMs
      + (command.settleTimeSeconds ?? command.durationSeconds) * 1_000,
    spreadTotalCents: metrics.spreadTotalCents + command.spreadCents,
    overshootCount: metrics.overshootCount + command.overshootCount,
    currentQualityCombo,
    bestQualityCombo: Math.max(metrics.bestQualityCombo, currentQualityCombo),
    lastCommand: command,
  });
}

function retainRecentCommand(
  commands: readonly RecordedPitchMazeCommand[],
  command: Readonly<RecordedPitchMazeCommand>,
): readonly RecordedPitchMazeCommand[] {
  const overflow = Math.max(0, commands.length + 1 - PITCH_MAZE_MAX_RETAINED_COMMANDS);
  return Object.freeze([...commands.slice(overflow), command]);
}

function summarizeLevel(
  level: Readonly<PitchMazeLevel>,
  levelNumber: number,
  optimalMoves: number,
  metrics: Readonly<PitchMazeCommandMetrics>,
  durationMs: number,
): PitchMazeLevelResult {
  if (metrics.lastCommand === null) throw new Error("A completed maze requires one command.");
  return Object.freeze({
    level: levelNumber,
    rows: level.config.rows,
    columns: level.config.columns,
    optimalMoves,
    moves: level.moves,
    commands: metrics.commandCount,
    blockedCommands: metrics.blockedCommandCount,
    durationMs,
    averageQuality: metrics.qualityTotal / metrics.commandCount,
    pitchAccuracy: metrics.inBandPercentTotal / metrics.commandCount,
    navigationEfficiency: metrics.commandCount === 0
      ? 0
      : Math.min(100, optimalMoves / metrics.commandCount * 100),
    lastCommand: metrics.lastCommand,
  });
}

function campaignOutcome(
  campaign: Readonly<PitchMazeCampaignSpec>,
  metrics: Readonly<PitchMazeCommandMetrics>,
  levels: readonly PitchMazeLevelResult[],
  durationMs: number,
): ArcadeOutcome {
  const pitchQuality = metrics.commandCount === 0 ? 0 : metrics.qualityTotal / metrics.commandCount;
  const accuracy = metrics.commandCount === 0 ? 0 : metrics.inBandPercentTotal / metrics.commandCount;
  const optimalMoves = levels.reduce((total, level) => total + level.optimalMoves, 0);
  const efficiency = metrics.commandCount === 0
    ? 0
    : Math.min(100, optimalMoves / metrics.commandCount * 100);
  const score = Math.round(pitchQuality * 0.78 + efficiency * 0.22);
  return Object.freeze({
    mode: "maze",
    curriculumStage: campaign.curriculumStage,
    variant: campaign.mappingMode,
    score,
    grade: gradeFor(score),
    xp: Math.round(score * getDifficultyPreset(campaign.difficulty).scoreMultiplier),
    accuracy,
    bestCombo: metrics.bestQualityCombo,
    durationMs,
    details: {
      pitchQuality,
      navigationEfficiency: efficiency,
      commands: metrics.commandCount,
      movedCommands: metrics.movedCommandCount,
      blockedCommands: metrics.blockedCommandCount,
      averageAttackErrorCents: metrics.commandCount === 0
        ? 0
        : metrics.absoluteAttackErrorTotalCents / metrics.commandCount,
      averageSettleMs: metrics.commandCount === 0 ? 0 : metrics.settleTotalMs / metrics.commandCount,
      averageSpreadCents: metrics.commandCount === 0
        ? 0
        : metrics.spreadTotalCents / metrics.commandCount,
      overshoots: metrics.overshootCount,
      levelsCompleted: levels.length,
    },
  });
}

function createLevel(
  state: Readonly<PitchMazeSessionState>,
  campaign: Readonly<PitchMazeCampaignSpec>,
  levelNumber: number,
): PitchMazeSessionState {
  const level = createPitchMazeLevel({
    seed: campaign.seed,
    voiceRange: campaign.voiceRange,
    level: levelNumber,
    mappingMode: campaign.mappingMode,
    difficulty: campaign.difficulty,
  });
  const controller = createPitchMazeController({
    directionNotes: level.directionNotes,
    requiredHoldSeconds: level.config.holdDurationSeconds,
    toleranceCents: level.config.toleranceCents,
    minimumConfidence: 0.58,
    acquisitionCorridorCents: 48,
    directionSwitchHysteresisCents: 10,
  });
  return Object.freeze({
    ...state,
    phase: "playing",
    campaign,
    mappingMode: campaign.mappingMode,
    levelNumber,
    level,
    controller,
    selectedDirection: "north",
    currentResult: null,
    lastCommandResult: null,
    currentLevelMetrics: createCommandMetrics(),
    levelStartedAtSeconds: null,
    levelOptimalMoves: getPitchMazeShortestPathLength(level, level.start, level.goal),
    notice: levelNumber === 1
      ? "Voice controller live. Hold any mapped note to move one cell."
      : "New maze and compass live. Choose any mapped direction note.",
    outcome: null,
  });
}

export function createPitchMazeSession(
  mappingMode: PitchMazeMappingMode = "adjacent",
): PitchMazeSessionState {
  return Object.freeze({
    phase: "setup",
    mappingMode,
    campaign: null,
    levelNumber: 1,
    level: null,
    controller: null,
    selectedDirection: "north",
    commands: Object.freeze([]),
    currentLevelMetrics: createCommandMetrics(),
    campaignMetrics: createCommandMetrics(),
    observedCommandCount: 0,
    levelResults: Object.freeze([]),
    currentResult: null,
    lastCommandResult: null,
    levelStartedAtSeconds: null,
    campaignStartedAtSeconds: null,
    lastObservedAtSeconds: null,
    levelOptimalMoves: 0,
    notice: "Choose a compass mapping, then start a five-maze run.",
    achievementOutcome: null,
    outcome: null,
  });
}

function consumeObservation(
  state: Readonly<PitchMazeSessionState>,
  observation: Readonly<PitchObservation>,
): PitchMazeSessionState {
  if (state.phase !== "playing" || state.level === null || state.controller === null) {
    return state as PitchMazeSessionState;
  }
  const campaignStartedAtSeconds = state.campaignStartedAtSeconds ?? observation.timeSeconds;
  const levelStartedAtSeconds = state.levelStartedAtSeconds ?? observation.timeSeconds;
  const update = updatePitchMazeController(state.controller, observation);
  const selectedDirection = update.state.activeDirection ?? state.selectedDirection;
  if (update.event === null) {
    return Object.freeze({
      ...state,
      controller: update.state,
      selectedDirection,
      campaignStartedAtSeconds,
      levelStartedAtSeconds,
      lastObservedAtSeconds: observation.timeSeconds,
    });
  }

  const move = applyCompletedPitchMazeMove(state.level, update.event.command.direction);
  const recorded: RecordedPitchMazeCommand = Object.freeze({
    ...update.event.command,
    level: state.levelNumber,
    result: move.moved ? "moved" : "wall",
  });
  const commands = retainRecentCommand(state.commands, recorded);
  const observedCommandCount = state.observedCommandCount + 1;
  const currentLevelMetrics = recordCommandMetrics(state.currentLevelMetrics, recorded);
  const campaignMetrics = recordCommandMetrics(state.campaignMetrics, recorded);
  // A cleared maze is a latched achievement inside the still-live campaign,
  // but the user's later commands remain part of the whole-session score.
  if (state.currentResult !== null) {
    return Object.freeze({
      ...state,
      level: move.level,
      controller: update.state,
      selectedDirection,
      commands,
      currentLevelMetrics,
      campaignMetrics,
      observedCommandCount,
      lastCommandResult: move.moved ? "moved" : "wall",
      campaignStartedAtSeconds,
      levelStartedAtSeconds,
      lastObservedAtSeconds: observation.timeSeconds,
    });
  }
  if (!move.levelComplete) {
    return Object.freeze({
      ...state,
      level: move.level,
      controller: update.state,
      selectedDirection,
      commands,
      currentLevelMetrics,
      campaignMetrics,
      observedCommandCount,
      lastCommandResult: recorded.result,
      campaignStartedAtSeconds,
      levelStartedAtSeconds,
      lastObservedAtSeconds: observation.timeSeconds,
      notice: move.reason === "wall"
        ? `${recorded.direction} was detected, but that cell is blocked. Choose another note.`
        : `${recorded.direction} moved one cell · quality ${recorded.qualityScore}.`,
    });
  }

  const result = summarizeLevel(
    move.level,
    state.levelNumber,
    state.levelOptimalMoves,
    currentLevelMetrics,
    Math.max(1, Math.round((update.event.command.endedAtSeconds - levelStartedAtSeconds) * 1_000)),
  );
  const levelResults = Object.freeze([...state.levelResults, result]);
  const campaignComplete = state.levelNumber >= PITCH_MAZE_CAMPAIGN_LEVELS;
  return Object.freeze({
    ...state,
    phase: "playing",
    level: move.level,
    controller: update.state,
    selectedDirection,
    commands,
    currentLevelMetrics,
    campaignMetrics,
    observedCommandCount,
    levelResults,
    currentResult: result,
    lastCommandResult: recorded.result,
    campaignStartedAtSeconds,
    levelStartedAtSeconds,
    lastObservedAtSeconds: observation.timeSeconds,
    notice: campaignComplete
      ? "Five mazes cleared. The voice controller remains live until you choose Finish campaign."
      : `Maze ${state.levelNumber} clear. The controller remains live; continue when you choose.`,
    achievementOutcome: campaignComplete && state.campaign !== null
      ? campaignOutcome(
          state.campaign,
          campaignMetrics,
          levelResults,
          Math.max(1, Math.round((update.event.command.endedAtSeconds - campaignStartedAtSeconds) * 1_000)),
        )
      : null,
  });
}

export function reducePitchMazeSession(
  state: Readonly<PitchMazeSessionState>,
  action: Readonly<PitchMazeSessionAction>,
): PitchMazeSessionState {
  switch (action.type) {
    case "set-mapping":
      return state.phase === "setup"
        ? Object.freeze({ ...state, mappingMode: action.mappingMode })
        : state as PitchMazeSessionState;
    case "start": {
      if (state.phase !== "setup") return state as PitchMazeSessionState;
      const clean = createPitchMazeSession(action.campaign.mappingMode);
      return createLevel(clean, action.campaign, 1);
    }
    case "observation":
      return consumeObservation(state, action.observation);
    case "continue":
      return state.phase === "playing"
        && state.currentResult !== null
        && state.levelNumber < PITCH_MAZE_CAMPAIGN_LEVELS
        && state.campaign !== null
        ? createLevel(state, state.campaign, state.levelNumber + 1)
        : state as PitchMazeSessionState;
    case "finish": {
      if (state.phase !== "playing" || state.campaign === null) {
        return state as PitchMazeSessionState;
      }
      const durationMs = state.campaignStartedAtSeconds === null
        || state.lastObservedAtSeconds === null
        ? 0
        : Math.max(0, Math.round(
            (state.lastObservedAtSeconds - state.campaignStartedAtSeconds) * 1_000,
          ));
      return Object.freeze({
        ...state,
        phase: "campaign-result",
        outcome: campaignOutcome(
          state.campaign,
          state.campaignMetrics,
          state.levelResults,
          durationMs,
        ),
        notice: "Campaign finished by you. Voice-control evidence is frozen until you start another campaign.",
      });
    }
    case "reset":
      return state.phase === "campaign-result"
        ? createPitchMazeSession(state.mappingMode)
        : state as PitchMazeSessionState;
  }
}
