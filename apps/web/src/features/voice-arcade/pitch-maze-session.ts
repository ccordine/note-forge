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

export type PitchMazeSessionPhase =
  | "setup"
  | "playing"
  | "level-result"
  | "campaign-result";

export type PitchMazeCommandResult = "moved" | "wall";

export interface RecordedPitchMazeCommand extends PitchMazeCommandQuality {
  readonly level: number;
  readonly result: PitchMazeCommandResult;
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
  readonly levelResults: readonly PitchMazeLevelResult[];
  readonly currentResult: PitchMazeLevelResult | null;
  readonly lastCommandResult: PitchMazeCommandResult | null;
  readonly levelCommandStart: number;
  readonly levelStartedAtSeconds: number | null;
  readonly campaignStartedAtSeconds: number | null;
  readonly levelOptimalMoves: number;
  readonly notice: string;
  readonly outcome: ArcadeOutcome | null;
}

export type PitchMazeSessionAction =
  | { readonly type: "set-mapping"; readonly mappingMode: PitchMazeMappingMode }
  | { readonly type: "start"; readonly campaign: PitchMazeCampaignSpec }
  | { readonly type: "observation"; readonly observation: PitchObservation }
  | { readonly type: "continue" }
  | { readonly type: "reset" };

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function gradeFor(score: number): string {
  if (score >= 94) return "S";
  if (score >= 86) return "A";
  if (score >= 76) return "B";
  if (score >= 64) return "C";
  return "D";
}

function bestQualityCombo(commands: readonly RecordedPitchMazeCommand[]): number {
  let run = 0;
  let best = 0;
  for (const command of commands) {
    run = command.result === "moved" && command.qualityScore >= 75 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

function summarizeLevel(
  level: Readonly<PitchMazeLevel>,
  levelNumber: number,
  optimalMoves: number,
  commands: readonly RecordedPitchMazeCommand[],
  durationMs: number,
): PitchMazeLevelResult {
  const blockedCommands = commands.filter((command) => command.result === "wall").length;
  return Object.freeze({
    level: levelNumber,
    rows: level.config.rows,
    columns: level.config.columns,
    optimalMoves,
    moves: level.moves,
    commands: commands.length,
    blockedCommands,
    durationMs,
    averageQuality: average(commands.map((command) => command.qualityScore)),
    pitchAccuracy: average(commands.map((command) => command.inBandRatio * 100)),
    navigationEfficiency: commands.length === 0
      ? 0
      : Math.min(100, optimalMoves / commands.length * 100),
    lastCommand: commands.at(-1)!,
  });
}

function campaignOutcome(
  campaign: Readonly<PitchMazeCampaignSpec>,
  commands: readonly RecordedPitchMazeCommand[],
  levels: readonly PitchMazeLevelResult[],
  durationMs: number,
): ArcadeOutcome {
  const pitchQuality = average(commands.map((command) => command.qualityScore));
  const accuracy = average(commands.map((command) => command.inBandRatio * 100));
  const optimalMoves = levels.reduce((total, level) => total + level.optimalMoves, 0);
  const efficiency = commands.length === 0
    ? 0
    : Math.min(100, optimalMoves / commands.length * 100);
  const score = Math.round(pitchQuality * 0.78 + efficiency * 0.22);
  return Object.freeze({
    mode: "maze",
    curriculumStage: campaign.curriculumStage,
    variant: campaign.mappingMode,
    score,
    grade: gradeFor(score),
    xp: Math.round(score * getDifficultyPreset(campaign.difficulty).scoreMultiplier),
    accuracy,
    bestCombo: bestQualityCombo(commands),
    durationMs,
    details: {
      pitchQuality,
      navigationEfficiency: efficiency,
      commands: commands.length,
      movedCommands: commands.filter((command) => command.result === "moved").length,
      blockedCommands: commands.filter((command) => command.result === "wall").length,
      averageAttackErrorCents: average(commands.map((command) => Math.abs(command.attackErrorCents))),
      averageSettleMs: average(commands.map((command) => (
        command.settleTimeSeconds ?? command.durationSeconds
      ) * 1_000)),
      averageSpreadCents: average(commands.map((command) => command.spreadCents)),
      overshoots: commands.reduce((total, command) => total + command.overshootCount, 0),
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
    levelCommandStart: state.commands.length,
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
    levelResults: Object.freeze([]),
    currentResult: null,
    lastCommandResult: null,
    levelCommandStart: 0,
    levelStartedAtSeconds: null,
    campaignStartedAtSeconds: null,
    levelOptimalMoves: 0,
    notice: "Choose a compass mapping, then start a five-maze run.",
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
    });
  }

  const move = applyCompletedPitchMazeMove(state.level, update.event.command.direction);
  const recorded: RecordedPitchMazeCommand = Object.freeze({
    ...update.event.command,
    level: state.levelNumber,
    result: move.moved ? "moved" : "wall",
  });
  const commands = Object.freeze([...state.commands, recorded]);
  if (!move.levelComplete) {
    return Object.freeze({
      ...state,
      level: move.level,
      controller: update.state,
      selectedDirection,
      commands,
      lastCommandResult: recorded.result,
      campaignStartedAtSeconds,
      levelStartedAtSeconds,
      notice: move.reason === "wall"
        ? `${recorded.direction} was detected, but that cell is blocked. Choose another note.`
        : `${recorded.direction} moved one cell · quality ${recorded.qualityScore}.`,
    });
  }

  const levelCommands = commands.slice(state.levelCommandStart);
  const result = summarizeLevel(
    move.level,
    state.levelNumber,
    state.levelOptimalMoves,
    levelCommands,
    Math.max(1, Math.round((update.event.command.endedAtSeconds - levelStartedAtSeconds) * 1_000)),
  );
  const levelResults = Object.freeze([...state.levelResults, result]);
  const campaignComplete = state.levelNumber >= PITCH_MAZE_CAMPAIGN_LEVELS;
  return Object.freeze({
    ...state,
    phase: campaignComplete ? "campaign-result" : "level-result",
    level: move.level,
    controller: update.state,
    selectedDirection,
    commands,
    levelResults,
    currentResult: result,
    lastCommandResult: recorded.result,
    campaignStartedAtSeconds,
    levelStartedAtSeconds,
    notice: campaignComplete
      ? "Five mazes cleared. Voice-control evidence is ready."
      : `Maze ${state.levelNumber} clear. Continue when you are ready.`,
    outcome: campaignComplete && state.campaign !== null
      ? campaignOutcome(
          state.campaign,
          commands,
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
      const clean = createPitchMazeSession(action.campaign.mappingMode);
      return createLevel(clean, action.campaign, 1);
    }
    case "observation":
      return consumeObservation(state, action.observation);
    case "continue":
      return state.phase === "level-result" && state.campaign !== null
        ? createLevel(state, state.campaign, state.levelNumber + 1)
        : state as PitchMazeSessionState;
    case "reset":
      return createPitchMazeSession(state.mappingMode);
  }
}
