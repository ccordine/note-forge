import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { YinPitchFrame } from "@noteforge/pitch-engine";
import { useAudioInput } from "@/audio/use-audio-input";
import { playTone, playToneSequence, type ActiveVoice } from "@/audio/synth";
import { pitchDiagnostics } from "@/diagnostics/pitch-diagnostics";
import { continuousMidiToHz, noteLabel, signed } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { WorkflowDialog, WorkflowStage, type WorkflowStep } from "@/ui/workflow";
import {
  createPitchMazeController,
  updatePitchMazeController,
  type PitchMazeCommandQuality,
  type PitchMazeControllerState,
} from "./pitch-maze-controller";
import {
  CARDINAL_DIRECTIONS,
  PITCH_MAZE_DIFFICULTY_PRESETS,
  PITCH_MAZE_MAPPING_POLICIES,
  applyCompletedPitchMazeMove,
  createPitchMazeLevel,
  getPitchMazeCell,
  getPitchMazeShortestPathLength,
  type CardinalDirection,
  type PitchMazeLevel,
  type PitchMazeMappingMode,
} from "./pitch-maze-model";
import { getDifficultyPreset } from "./model";
import { resolveArcadeCurriculum } from "./curriculum";
import type { ArcadeGameProps, ArcadeOutcome } from "./types";

const CAMPAIGN_LEVELS = 5;
const PREVIEW_TONE_SECONDS = 0.78;
const PREVIEW_SETTLE_MS = 260;
const DIRECTION_GLYPHS: Readonly<Record<CardinalDirection, string>> = {
  north: "↑",
  east: "→",
  south: "↓",
  west: "←",
};
const WORKFLOW_STEPS = [
  { id: "loadout", label: "Learn controls", detail: "Four-note compass" },
  { id: "navigate", label: "Navigate", detail: "Hold · move · release" },
  { id: "review", label: "Review", detail: "Movement quality" },
] as const satisfies readonly WorkflowStep[];

type PitchMazePhase = "setup" | "connecting" | "playing" | "level-result" | "campaign-result";
type CommandResult = "moved" | "wall";

interface RecordedMazeCommand extends PitchMazeCommandQuality {
  readonly level: number;
  readonly result: CommandResult;
}

interface PitchMazeLevelResult {
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
  readonly lastCommand: RecordedMazeCommand;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function gradeFor(score: number): string {
  if (score >= 94) return "S";
  if (score >= 86) return "A";
  if (score >= 76) return "B";
  if (score >= 64) return "C";
  return "D";
}

function bestQualityCombo(commands: readonly RecordedMazeCommand[]): number {
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
  commands: readonly RecordedMazeCommand[],
  durationMs: number,
): PitchMazeLevelResult {
  const blockedCommands = commands.filter((command) => command.result === "wall").length;
  const averageQuality = average(commands.map((command) => command.qualityScore));
  const pitchAccuracy = average(commands.map((command) => command.inBandRatio * 100));
  const navigationEfficiency = commands.length === 0
    ? 0
    : Math.min(100, optimalMoves / commands.length * 100);
  return {
    level: levelNumber,
    rows: level.config.rows,
    columns: level.config.columns,
    optimalMoves,
    moves: level.moves,
    commands: commands.length,
    blockedCommands,
    durationMs,
    averageQuality,
    pitchAccuracy,
    navigationEfficiency,
    lastCommand: commands.at(-1)!,
  };
}

function createCampaignOutcome(
  difficulty: ArcadeGameProps["difficulty"],
  curriculumStage: ArcadeGameProps["curriculumStage"],
  mappingMode: PitchMazeMappingMode,
  commands: readonly RecordedMazeCommand[],
  levels: readonly PitchMazeLevelResult[],
  durationMs: number,
): ArcadeOutcome {
  const pitchQuality = average(commands.map((command) => command.qualityScore));
  const accuracy = average(commands.map((command) => command.inBandRatio * 100));
  const optimalMoves = levels.reduce((total, level) => total + level.optimalMoves, 0);
  const efficiency = commands.length === 0 ? 0 : Math.min(100, optimalMoves / commands.length * 100);
  const score = Math.round(pitchQuality * .78 + efficiency * .22);
  return {
    mode: "maze",
    curriculumStage,
    variant: mappingMode,
    score,
    grade: gradeFor(score),
    xp: Math.round(score * getDifficultyPreset(difficulty).scoreMultiplier),
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
      averageSettleMs: average(commands.map((command) => (command.settleTimeSeconds ?? command.durationSeconds) * 1_000)),
      averageSpreadCents: average(commands.map((command) => command.spreadCents)),
      overshoots: commands.reduce((total, command) => total + command.overshootCount, 0),
      levelsCompleted: levels.length,
    },
  };
}

function samePosition(
  left: Readonly<{ row: number; column: number }>,
  right: Readonly<{ row: number; column: number }>,
): boolean {
  return left.row === right.row && left.column === right.column;
}

function commandCopy(command: Readonly<RecordedMazeCommand>): string {
  const attack = `${signed(command.attackErrorCents, 0)}¢ attack`;
  const settle = command.settleTimeSeconds === null ? "no tight settle" : `${Math.round(command.settleTimeSeconds * 1_000)} ms settle`;
  return `${noteLabel(command.targetMidi)} ${command.direction} · ${attack} · ${settle} · ±${command.spreadCents.toFixed(0)}¢ spread`;
}

export function PitchMaze({ difficulty, curriculumStage, voiceRange, onComplete }: ArcadeGameProps) {
  const [phase, setPhase] = useState<PitchMazePhase>("setup");
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [mappingMode, setMappingMode] = useState<PitchMazeMappingMode>("adjacent");
  const [levelNumber, setLevelNumber] = useState(1);
  const [level, setLevel] = useState<PitchMazeLevel | null>(null);
  const [controllerView, setControllerView] = useState<PitchMazeControllerState | null>(null);
  const [selectedDirection, setSelectedDirection] = useState<CardinalDirection>("north");
  const [commands, setCommands] = useState<RecordedMazeCommand[]>([]);
  const [levelResults, setLevelResults] = useState<PitchMazeLevelResult[]>([]);
  const [currentResult, setCurrentResult] = useState<PitchMazeLevelResult | null>(null);
  const [lastCommandResult, setLastCommandResult] = useState<CommandResult | null>(null);
  const [notice, setNotice] = useState("Choose how the four-note compass changes, then start a five-maze run.");
  const [previewing, setPreviewing] = useState(false);
  const [connectionSlow, setConnectionSlow] = useState(false);

  const phaseRef = useRef(phase);
  const levelRef = useRef<PitchMazeLevel | null>(level);
  const levelNumberRef = useRef(levelNumber);
  const controllerRef = useRef<PitchMazeControllerState | null>(controllerView);
  const selectedDirectionRef = useRef<CardinalDirection>(selectedDirection);
  const commandsRef = useRef<RecordedMazeCommand[]>(commands);
  const levelResultsRef = useRef<PitchMazeLevelResult[]>(levelResults);
  const levelCommandStartRef = useRef(0);
  const campaignStartedAtRef = useRef(0);
  const levelStartedAtRef = useRef(0);
  const levelOptimalMovesRef = useRef(0);
  const sessionSeedRef = useRef("");
  const sessionTokenRef = useRef(0);
  const completionRecordedRef = useRef(false);
  const onFrameRef = useRef<(frame: YinPitchFrame) => void>(() => undefined);
  const inputRef = useRef<ReturnType<typeof useAudioInput> | null>(null);
  const onCompleteRef = useRef(onComplete);
  const promptVoiceRef = useRef<ActiveVoice | null>(null);
  const promptTimerRef = useRef<number | null>(null);
  const promptGenerationRef = useRef(0);
  const scoringExcludedRef = useRef(false);

  phaseRef.current = phase;
  levelRef.current = level;
  levelNumberRef.current = levelNumber;
  controllerRef.current = controllerView;
  selectedDirectionRef.current = selectedDirection;
  commandsRef.current = commands;
  levelResultsRef.current = levelResults;
  onCompleteRef.current = onComplete;

  const activeTargetMidi = level
    ? level.directionNotes[controllerView?.activeDirection ?? selectedDirection]
    : voiceRange.baselineMidi;

  const input = useAudioInput({
    diagnostics: {
      flow: "voice-arcade",
      phase,
      targetMidi: activeTargetMidi,
      toleranceCents: level?.config.toleranceCents ?? null,
      stableMs: (controllerView?.sustain?.heldSeconds ?? 0) * 1_000,
      requiredHoldMs: (level?.config.holdDurationSeconds ?? 0) * 1_000,
      resetReason: scoringExcludedRef.current
        ? "reference-excluded"
        : controllerView?.phase === "awaiting-release"
          ? "awaiting-release"
          : controllerView?.sustain?.inGrace
            ? "hold-preserved-unvoiced"
            : null,
    },
    onFrame: (frame) => onFrameRef.current(frame),
  });
  inputRef.current = input;

  const preset = PITCH_MAZE_DIFFICULTY_PRESETS[difficulty];
  const curriculum = resolveArcadeCurriculum("maze", curriculumStage);
  const previewLevel = useMemo(() => createPitchMazeLevel({
    seed: "pitch-maze-loadout-preview",
    voiceRange,
    level: 1,
    mappingMode,
    difficulty,
  }), [difficulty, mappingMode, voiceRange]);

  const clearPrompt = useCallback(() => {
    promptGenerationRef.current += 1;
    if (promptTimerRef.current !== null) window.clearTimeout(promptTimerRef.current);
    promptTimerRef.current = null;
    promptVoiceRef.current?.stop(.04);
    promptVoiceRef.current = null;
    scoringExcludedRef.current = false;
    setPreviewing(false);
  }, []);

  const createControllerFor = useCallback((nextLevel: Readonly<PitchMazeLevel>, startedAtSeconds = 0) => createPitchMazeController({
    directionNotes: nextLevel.directionNotes,
    requiredHoldSeconds: nextLevel.config.holdDurationSeconds,
    toleranceCents: nextLevel.config.toleranceCents,
    listeningStartedAtSeconds: Math.max(0, startedAtSeconds),
    minimumConfidence: .58,
    acquisitionCorridorCents: 48,
    directionSwitchHysteresisCents: 10,
    releaseDurationSeconds: .275,
  }), []);

  const requireReleaseBeforeArming = useCallback((controller: Readonly<PitchMazeControllerState>): PitchMazeControllerState => ({
    ...controller,
    phase: "awaiting-release",
    activeDirection: null,
    activeTargetMidi: null,
    sustain: null,
    capture: null,
    releaseStartedAtSeconds: null,
    releaseProgress: 0,
  }), []);

  const installLevel = useCallback((nextLevelNumber: number) => {
    const nextLevel = createPitchMazeLevel({
      seed: sessionSeedRef.current,
      voiceRange,
      level: nextLevelNumber,
      mappingMode,
      difficulty,
    });
    const lastFrameTime = inputRef.current?.liveFrame?.timeSeconds ?? 0;
    const createdController = createControllerFor(nextLevel, lastFrameTime);
    const nextController = nextLevelNumber === 1
      ? createdController
      : requireReleaseBeforeArming(createdController);
    levelCommandStartRef.current = commandsRef.current.length;
    levelStartedAtRef.current = performance.now();
    levelOptimalMovesRef.current = getPitchMazeShortestPathLength(nextLevel, nextLevel.start, nextLevel.goal);
    levelNumberRef.current = nextLevelNumber;
    levelRef.current = nextLevel;
    controllerRef.current = nextController;
    selectedDirectionRef.current = "north";
    setLevelNumber(nextLevelNumber);
    setLevel(nextLevel);
    setControllerView(nextController);
    setSelectedDirection("north");
    setLastCommandResult(null);
    setCurrentResult(null);
    phaseRef.current = "playing";
    setPhase("playing");
    setNotice(nextLevelNumber === 1
      ? "Controller armed. Sing any mapped note to choose a direction; sustain it, then release before the next move."
      : "New compass loaded. Give the controller a short clear release, then make the first directional note.");
  }, [createControllerFor, difficulty, mappingMode, requireReleaseBeforeArming, voiceRange]);

  const finishCampaign = useCallback((
    nextCommands: readonly RecordedMazeCommand[],
    nextResults: readonly PitchMazeLevelResult[],
  ) => {
    if (completionRecordedRef.current) return;
    completionRecordedRef.current = true;
    const durationMs = Math.max(1, Math.round(performance.now() - campaignStartedAtRef.current));
    onCompleteRef.current(createCampaignOutcome(difficulty, curriculumStage, mappingMode, nextCommands, nextResults, durationMs));
  }, [curriculumStage, difficulty, mappingMode]);

  onFrameRef.current = (frame) => {
    if (phaseRef.current !== "playing" || scoringExcludedRef.current) return;
    const currentController = controllerRef.current;
    const currentLevel = levelRef.current;
    if (!currentController || !currentLevel) return;

    const update = updatePitchMazeController(currentController, frame);
    controllerRef.current = update.state;
    setControllerView(update.state);
    if (update.state.activeDirection && update.state.activeDirection !== selectedDirectionRef.current) {
      selectedDirectionRef.current = update.state.activeDirection;
      setSelectedDirection(update.state.activeDirection);
    }
    if (!update.event) return;

    if (update.event.type === "rearmed") {
      setLastCommandResult(null);
      setNotice("Release heard. Controller armed for one new directional note.");
      return;
    }

    const move = applyCompletedPitchMazeMove(currentLevel, update.event.command.direction);
    const recorded: RecordedMazeCommand = {
      ...update.event.command,
      level: levelNumberRef.current,
      result: move.moved ? "moved" : "wall",
    };
    const nextCommands = [...commandsRef.current, recorded];
    commandsRef.current = nextCommands;
    setCommands(nextCommands);
    setLastCommandResult(recorded.result);
    levelRef.current = move.level;
    setLevel(move.level);

    if (!move.levelComplete) {
      setNotice(move.reason === "wall"
        ? `${noteLabel(recorded.targetMidi)} earned as ${recorded.direction}, but a wall blocks that cell. Release, then choose another compass note.`
        : `${DIRECTION_GLYPHS[recorded.direction]} ${recorded.direction} moved one cell · quality ${recorded.qualityScore}. Release your voice to re-arm.`);
      return;
    }

    const levelCommands = nextCommands.slice(levelCommandStartRef.current);
    const result = summarizeLevel(
      move.level,
      levelNumberRef.current,
      levelOptimalMovesRef.current,
      levelCommands,
      Math.max(1, Math.round(performance.now() - levelStartedAtRef.current)),
    );
    const nextResults = [...levelResultsRef.current, result];
    levelResultsRef.current = nextResults;
    setLevelResults(nextResults);
    setCurrentResult(result);
    if (levelNumberRef.current >= CAMPAIGN_LEVELS) {
      phaseRef.current = "campaign-result";
      setPhase("campaign-result");
      setNotice("Five mazes cleared. Your route and pitch-control evidence are ready.");
      finishCampaign(nextCommands, nextResults);
    } else {
      phaseRef.current = "level-result";
      setPhase("level-result");
      setNotice(`Maze ${levelNumberRef.current} clear. Review the command quality, then continue into a larger board and a new mapping.`);
    }
  };

  const startCampaign = useCallback(async () => {
    if (phaseRef.current === "connecting" || voiceRange.highMidi - voiceRange.lowMidi < 3) return;
    const token = ++sessionTokenRef.current;
    clearPrompt();
    completionRecordedRef.current = false;
    sessionSeedRef.current = `pitch-maze:${new Date().toISOString()}:${crypto.randomUUID()}`;
    commandsRef.current = [];
    levelResultsRef.current = [];
    setCommands([]);
    setLevelResults([]);
    setCurrentResult(null);
    setLevel(null);
    setConnectionSlow(false);
    campaignStartedAtRef.current = performance.now();
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
      setNotice(inputRef.current?.error || "Microphone access is needed to use pitch as the maze controller.");
      return;
    }
    installLevel(1);
  }, [clearPrompt, input, installLevel, voiceRange.highMidi, voiceRange.lowMidi]);

  const closeWorkflow = useCallback(() => {
    sessionTokenRef.current += 1;
    clearPrompt();
    phaseRef.current = "setup";
    setPhase("setup");
    setWorkflowOpen(false);
    setConnectionSlow(false);
    setNotice(commandsRef.current.length > 0
      ? `Run stopped after ${commandsRef.current.length} voice commands. Start when you are ready for a fresh campaign.`
      : "Run stopped. The microphone permission remains available for the next start.");
  }, [clearPrompt]);

  const continueCampaign = useCallback(() => {
    clearPrompt();
    installLevel(levelNumberRef.current + 1);
  }, [clearPrompt, installLevel]);

  const resetToSetup = useCallback(() => {
    clearPrompt();
    phaseRef.current = "setup";
    setPhase("setup");
    setWorkflowOpen(false);
    setNotice("Campaign complete. Choose a mapping policy and start another run when ready.");
  }, [clearPrompt]);

  const previewMapping = useCallback(async (preview: Readonly<PitchMazeLevel> = previewLevel) => {
    const generation = ++promptGenerationRef.current;
    promptVoiceRef.current?.stop(.03);
    if (promptTimerRef.current !== null) window.clearTimeout(promptTimerRef.current);
    scoringExcludedRef.current = phaseRef.current === "playing";
    setPreviewing(true);
    setNotice("Reference compass playing north, east, south, west. Detection stays live; only maze movement waits.");
    try {
      const voice = await playToneSequence(CARDINAL_DIRECTIONS.map((direction) => ({
        frequencyHz: continuousMidiToHz(preview.directionNotes[direction]),
        duration: .42,
        gapAfter: .1,
        amplitude: .2,
        timbre: "sine" as const,
        release: .06,
      })));
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
        scoringExcludedRef.current = false;
        setPreviewing(false);
        if (phaseRef.current === "playing" && levelRef.current) {
          const startedAt = inputRef.current?.liveFrame?.timeSeconds ?? 0;
          const nextController = requireReleaseBeforeArming(createControllerFor(levelRef.current, startedAt));
          controllerRef.current = nextController;
          setControllerView(nextController);
          setNotice("Reference released. Give the controller a short clear release; then your next sustained note can move one cell.");
        } else {
          setNotice("Compass preview complete. Start the run when you are ready.");
        }
      }, 4 * 520 + PREVIEW_SETTLE_MS);
    } catch {
      if (generation !== promptGenerationRef.current) return;
      scoringExcludedRef.current = false;
      setPreviewing(false);
      setNotice("Reference tones could not start. You can still use the displayed note map.");
    }
  }, [createControllerFor, previewLevel, requireReleaseBeforeArming]);

  const previewDirection = useCallback(async (direction: CardinalDirection) => {
    const currentLevel = levelRef.current;
    if (!currentLevel || phaseRef.current !== "playing") return;
    const generation = ++promptGenerationRef.current;
    promptVoiceRef.current?.stop(.03);
    if (promptTimerRef.current !== null) window.clearTimeout(promptTimerRef.current);
    selectedDirectionRef.current = direction;
    setSelectedDirection(direction);
    scoringExcludedRef.current = true;
    setPreviewing(true);
    setNotice(`Listen to ${noteLabel(currentLevel.directionNotes[direction])} for ${direction}. Reference audio cannot move the player.`);
    try {
      const voice = await playTone({
        frequencyHz: continuousMidiToHz(currentLevel.directionNotes[direction]),
        duration: PREVIEW_TONE_SECONDS,
        amplitude: .22,
        timbre: "sine",
        release: .08,
      });
      if (generation !== promptGenerationRef.current) {
        voice.stop(.02);
        return;
      }
      promptVoiceRef.current = voice;
      promptTimerRef.current = window.setTimeout(() => {
        if (generation !== promptGenerationRef.current || !levelRef.current) return;
        promptVoiceRef.current?.stop(.03);
        promptVoiceRef.current = null;
        promptTimerRef.current = null;
        scoringExcludedRef.current = false;
        setPreviewing(false);
        const startedAt = inputRef.current?.liveFrame?.timeSeconds ?? 0;
        const nextController = requireReleaseBeforeArming(createControllerFor(levelRef.current, startedAt));
        controllerRef.current = nextController;
        setControllerView(nextController);
        setNotice(`Reference released. Clear your voice briefly, then make ${noteLabel(levelRef.current.directionNotes[direction])}.`);
      }, PREVIEW_TONE_SECONDS * 1_000 + PREVIEW_SETTLE_MS);
    } catch {
      if (generation !== promptGenerationRef.current) return;
      scoringExcludedRef.current = false;
      setPreviewing(false);
      setNotice("That reference could not play. The displayed note and live tuner remain available.");
    }
  }, [createControllerFor, requireReleaseBeforeArming]);

  useEffect(() => {
    if (phase !== "connecting") {
      setConnectionSlow(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setConnectionSlow(true), 5_000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (input.state !== "error" || phaseRef.current !== "playing") return;
    sessionTokenRef.current += 1;
    clearPrompt();
    phaseRef.current = "setup";
    setPhase("setup");
    setWorkflowOpen(false);
    setNotice(input.error || "The microphone disconnected. Start again to reconnect.");
  }, [clearPrompt, input.error, input.state]);

  useEffect(() => {
    pitchDiagnostics.record("voice-arcade", {
      kind: "workflow",
      workflow: {
        phase,
        state: controllerView?.phase ?? phase,
        targetMidi: activeTargetMidi,
        attemptId: levelNumber,
        holdMs: (controllerView?.sustain?.heldSeconds ?? 0) * 1_000,
        requiredHoldMs: (level?.config.holdDurationSeconds ?? 0) * 1_000,
        resetReason: scoringExcludedRef.current ? "reference-excluded" : controllerView?.phase === "awaiting-release" ? "awaiting-release" : null,
      },
    });
  }, [activeTargetMidi, controllerView?.phase, controllerView?.sustain?.heldSeconds, level?.config.holdDurationSeconds, levelNumber, phase]);

  useEffect(() => () => {
    sessionTokenRef.current += 1;
    clearPrompt();
  }, [clearPrompt]);

  const currentCell = level ? getPitchMazeCell(level) : null;
  const focusDirection = controllerView?.activeDirection ?? selectedDirection;
  const focusMidi = level?.directionNotes[focusDirection] ?? voiceRange.baselineMidi;
  const levelCommands = commands.filter((command) => command.level === levelNumber);
  const blockedCommands = levelCommands.filter((command) => command.result === "wall").length;
  const qualityAverage = average(levelCommands.map((command) => command.qualityScore));
  const holdSeconds = controllerView?.sustain?.heldSeconds ?? 0;
  const holdStatus = controllerView?.phase === "awaiting-release"
    ? "complete"
    : controllerView?.sustain?.inGrace
      ? "paused"
      : controllerView?.sustain?.status === "holding"
        ? "holding"
        : "waiting";
  const activeStep = phase === "level-result" || phase === "campaign-result" ? 2 : phase === "connecting" || phase === "playing" ? 1 : 0;
  const campaignOutcome = phase === "campaign-result"
    ? createCampaignOutcome(difficulty, curriculumStage, mappingMode, commands, levelResults, Math.max(1, performance.now() - campaignStartedAtRef.current))
    : null;
  const statusTone = controllerView?.phase === "awaiting-release" ? "releasing" : lastCommandResult ?? "";
  const controllerStatus = previewing
      ? "REFERENCE PLAYING · DETECTOR LIVE · MOVEMENT WAITS"
      : controllerView?.phase === "awaiting-release"
      ? `${controllerView.lastCommand ? "COMMAND EARNED" : "CLEAR INPUT TO ARM"} · RELEASE ${Math.round(controllerView.releaseProgress * 100)}%`
      : controllerView?.phase === "tracking"
      ? curriculum.feedback.showLiveNote
        ? `${focusDirection.toUpperCase()} LOCKED · HOLDING ${noteLabel(focusMidi)}`
        : `${focusDirection.toUpperCase()} LOCKED · HOLD STEADY`
        : "ARMED · ANY COMPASS NOTE CAN MOVE";
  const guidanceTitle = previewing
      ? `Listen to ${noteLabel(focusMidi)}`
      : controllerView?.phase === "awaiting-release"
      ? controllerView.lastCommand ? "Release your voice to re-arm" : "Release briefly to arm the compass"
      : controllerView?.phase === "tracking"
        ? curriculum.feedback.showLiveNote
          ? `Hold ${noteLabel(focusMidi)} for ${focusDirection}`
          : `Hold the ${focusDirection} command`
        : "Choose a direction with pitch";
  const guidanceDetail = previewing
      ? "Live detection continues during reference audio; maze movement resumes from fresh voice evidence after release."
      : controllerView?.phase === "awaiting-release"
      ? controllerView.lastCommand
        ? "One earned note always means one command. A short clear release prevents repeat movement and trains clean transitions."
        : "The new mapping or reference is loaded. A short unvoiced gap proves the previous sound ended before this compass accepts a command."
      : controllerView?.phase === "tracking"
        ? curriculum.feedback.showCents
          ? `${DIRECTION_GLYPHS[focusDirection]} ${focusDirection.toUpperCase()} · stay inside ±${level?.config.toleranceCents ?? preset.toleranceCents} cents until the hold completes.`
          : `${DIRECTION_GLYPHS[focusDirection]} ${focusDirection.toUpperCase()} · keep the vocal control steady until the hold completes.`
        : "Sing any one of the four displayed notes. The nearest reliable note locks the direction; noise and ambiguous boundaries do nothing.";

  return (
    <div className={`pitch-maze-page curriculum-${curriculumStage}`}>
      <div className="pitch-maze-setup">
        <Panel className="pitch-maze-briefing">
          <Eyebrow>Procedural dungeon · your voice is the D-pad</Eyebrow>
          <h1>Four notes become direction.</h1>
          <p>Every cell demands a real pitch decision: recall the note, attack it, correct it on the tuner, sustain the lane, move exactly once, release, and transition. Nearby notes can no longer collapse into one familiar vocal position.</p>
          <div className="pitch-maze-loop-contract" aria-label="Pitch Maze controller loop">
            <div><span>1</span><b>Choose</b><small>Recall the mapped direction note.</small></div>
            <div><span>2</span><b>Respond</b><small>Use the same canonical live note everywhere.</small></div>
            <div><span>3</span><b>Move</b><small>One completed hold moves one cell.</small></div>
            <div><span>4</span><b>Release</b><small>Silence re-arms the next command.</small></div>
          </div>
        </Panel>

        <Panel className="pitch-maze-loadout">
          <header><Eyebrow>{curriculum.stageLabel} · five-level run</Eyebrow><h2>Set the compass policy.</h2><p>{curriculum.focus} Mazes grow and mappings rotate automatically; mechanical difficulty controls pitch precision and maze growth.</p></header>
          <fieldset className="pitch-maze-mode-picker">
            <legend>Note mapping</legend>
            {(Object.keys(PITCH_MAZE_MAPPING_POLICIES) as PitchMazeMappingMode[]).map((id) => (
              <label key={id}><input type="radio" name="pitch-maze-mapping" value={id} checked={mappingMode === id} onChange={() => setMappingMode(id)} /><b>{PITCH_MAZE_MAPPING_POLICIES[id].label}</b><small>{PITCH_MAZE_MAPPING_POLICIES[id].description}</small></label>
            ))}
          </fieldset>
          <div className="pitch-maze-setup-summary">
            <div><span>FIRST BOARD</span><b>{previewLevel.config.rows}×{previewLevel.config.columns}</b></div>
            <div><span>FIRST LANE</span><b>±{preset.toleranceCents}¢</b></div>
            <div><span>FIRST HOLD</span><b>{preset.holdDurationSeconds.toFixed(2)}s</b></div>
          </div>
          <div className="pitch-maze-start-note"><Icon name="headphones" size={18} /><span><b>Headphones make reference previews cleaner.</b> They are recommended, never a blocker. Canonical note detection remains continuous while the workflow is open.</span></div>
          <NoteInput variant="compact" input={input} compact />
          <div className="pitch-maze-loadout-actions">
            <ActionButton disabled={previewing} onClick={() => { void previewMapping(); }}><Icon name="headphones" size={17} /> {previewing ? "Playing compass…" : "Hear first compass"}</ActionButton>
            <ActionButton className="primary wide" disabled={phase === "connecting" || voiceRange.highMidi - voiceRange.lowMidi < 3} onClick={() => { void startCampaign(); }}><Icon name="mic" size={18} /> {phase === "connecting" ? "Opening microphone…" : "Start Pitch Maze"}</ActionButton>
            <small role="status" aria-live="polite">{notice}</small>
          </div>
        </Panel>
      </div>

      <WorkflowDialog open={workflowOpen} steps={WORKFLOW_STEPS} activeStep={activeStep} label="Pitch Maze voice-navigation workflow" exitLabel="Stop run" onExit={closeWorkflow} className="pitch-maze-workflow panel">
        {phase === "connecting" && (
          <WorkflowStage title="Opening the voice controller" eyebrow="Pitch Maze · local microphone">
            <NoteInput variant="compact" input={input} compact />
            <div className="pitch-maze-connecting"><div><span className="pitch-maze-connecting-orb"><Icon name="mic" size={36} /></span><h2>Waiting for microphone access…</h2><p>The maze begins immediately after the browser returns the retained or newly approved microphone and the canonical note stream is ready.</p>{connectionSlow && <div className="pitch-maze-connection-help" role="status"><b>The browser has not returned the microphone request yet.</b><span>Check for a permission prompt or blocked microphone icon in the address bar. You can cancel safely and start again.</span><ActionButton onClick={closeWorkflow}>Cancel microphone request</ActionButton></div>}</div></div>
          </WorkflowStage>
        )}

        {phase === "playing" && level && currentCell && controllerView && (
          <WorkflowStage
            eyebrow={`${PITCH_MAZE_MAPPING_POLICIES[mappingMode].label} compass · maze ${levelNumber} of ${CAMPAIGN_LEVELS}`}
            title={`Navigate the ${level.config.rows}×${level.config.columns} maze.`}
            description="The canonical live note below is the controller. Sustain the note mapped to the direction you choose; walls reject movement, not the vocal command."
            status={<span>{controllerStatus}</span>}
            className="pitch-maze-run-stage"
          >
            <div className="pitch-maze-play-layout">
              <section className="pitch-maze-map-panel" aria-label={`Maze ${levelNumber} map`}>
                <div className="pitch-maze-map-heading"><span>GENERATED SOLVABLE MAP</span><b>{level.moves} CELLS MOVED · {levelOptimalMovesRef.current} OPTIMAL</b></div>
                <div className="pitch-maze-board-wrap">
                  <div className="pitch-maze-board" style={{ "--maze-rows": level.config.rows, "--maze-columns": level.config.columns } as CSSProperties} role="grid" aria-label={`${level.config.rows} by ${level.config.columns} maze; current cell row ${level.player.row + 1}, column ${level.player.column + 1}; exit row ${level.goal.row + 1}, column ${level.goal.column + 1}`}>
                    {level.cells.map((cell) => {
                      const isPlayer = samePosition(cell, level.player);
                      const isGoal = samePosition(cell, level.goal);
                      const borderStyle: CSSProperties = {
                        borderTopWidth: cell.walls.north ? 2 : 0,
                        borderLeftWidth: cell.walls.west ? 2 : 0,
                        borderRightWidth: cell.column === level.config.columns - 1 && cell.walls.east ? 2 : 0,
                        borderBottomWidth: cell.row === level.config.rows - 1 && cell.walls.south ? 2 : 0,
                      };
                      return <div key={`${cell.row}:${cell.column}`} role="gridcell" aria-label={`Row ${cell.row + 1}, column ${cell.column + 1}${isPlayer ? ", your position" : ""}${isGoal ? ", exit" : ""}`} className={`pitch-maze-cell ${isGoal ? "goal" : ""}`} style={borderStyle}>{isPlayer && <span className="pitch-maze-player" />}</div>;
                    })}
                  </div>
                </div>
                <div className="pitch-maze-map-legend"><span><i /> YOU · {level.player.row + 1},{level.player.column + 1}</span><span><i /> EXIT · {level.goal.row + 1},{level.goal.column + 1}</span></div>
              </section>

              <section className="pitch-maze-controller-panel" aria-label="Four-note voice controller">
                <div className="pitch-maze-controller-heading"><span>NOTE COMPASS · SELECTED FROM THE CANONICAL LIVE NOTE</span><b>{curriculum.feedback.allowReferenceReplay ? "CLICK A DIRECTION TO HEAR IT" : `${curriculum.stageLabel.toUpperCase()} · REPLAY OFF`}</b></div>
                <div className="pitch-maze-compass">
                  {CARDINAL_DIRECTIONS.map((direction) => (
                    <button
                      type="button"
                      key={direction}
                      disabled={previewing || !curriculum.feedback.allowReferenceReplay}
                      className={`pitch-maze-direction ${direction} ${focusDirection === direction ? "active" : ""} ${currentCell.walls[direction] ? "blocked" : "open"}`}
                      aria-label={`${direction}, ${noteLabel(level.directionNotes[direction])}, ${currentCell.walls[direction] ? "wall blocked" : "open passage"}; play reference`}
                      onClick={() => { void previewDirection(direction); }}
                    ><span>{DIRECTION_GLYPHS[direction]}</span><strong>{noteLabel(level.directionNotes[direction])}</strong><small>{curriculum.feedback.allowReferenceReplay ? currentCell.walls[direction] ? "wall · hear" : "open · hear" : currentCell.walls[direction] ? "wall · mapped" : "open · mapped"}</small></button>
                  ))}
                  <div className="pitch-maze-compass-center"><span><b>VOICE</b><small>D-PAD</small></span></div>
                </div>

                <NoteInput
                  variant="target"
                  input={input}
                  targetMidi={focusMidi}
                  toleranceCents={level.config.toleranceCents}
                  phase={previewing ? "prompting" : controllerView.phase === "awaiting-release" ? "complete" : "listening"}
                  hold={{ heldSeconds: holdSeconds, requiredSeconds: level.config.holdDurationSeconds, status: holdStatus }}
                  guidanceTitle={guidanceTitle}
                  guidanceDetail={guidanceDetail}
                  diagnosticsFlow="voice-arcade"
                  feedbackLevel={curriculum.feedback.level}
                />
                <div className={`pitch-maze-command-state ${statusTone}`} role="status" aria-live="polite"><span><b>{controllerStatus}</b><br />{controllerView.lastCommand ? commandCopy({ ...controllerView.lastCommand, level: levelNumber, result: lastCommandResult ?? "moved" }) : "Noise, low-confidence frames, and exact note boundaries cannot select a direction."}</span>{controllerView.lastCommand && <strong>{controllerView.lastCommand.qualityScore}</strong>}</div>
              </section>
            </div>

            <div className="pitch-maze-run-stats">
              <div><span>VOICE COMMANDS</span><b>{levelCommands.length}</b></div>
              <div><span>CELLS MOVED</span><b>{level.moves}</b></div>
              <div><span>BLOCKED NOTES</span><b>{blockedCommands}</b></div>
              <div><span>AVG QUALITY</span><b>{qualityAverage ? qualityAverage.toFixed(0) : "—"}</b></div>
              <div><span>RELEASE GATE</span><b>{controllerView.phase === "awaiting-release" ? `${Math.round(controllerView.releaseProgress * 100)}%` : "ARMED"}</b></div>
            </div>
            <div className="pitch-maze-live-notice" role="status" aria-live="polite">{notice}</div>
          </WorkflowStage>
        )}

        {(phase === "level-result" || phase === "campaign-result") && currentResult && (
          <WorkflowStage title={phase === "campaign-result" ? "Five mazes cleared." : `Maze ${currentResult.level} cleared.`} eyebrow={phase === "campaign-result" ? "Campaign result · voice navigation" : "Level result · new compass ahead"} className="pitch-maze-result">
            <div className="pitch-maze-result-mark">{phase === "campaign-result" ? campaignOutcome?.grade ?? "✓" : "✓"}</div>
            <h2>{phase === "campaign-result" ? `${campaignOutcome?.score ?? 0} voice-control score` : `${currentResult.averageQuality.toFixed(0)} movement quality`}</h2>
            <p>{phase === "campaign-result" ? `The ${curriculum.stageLabel.toLowerCase()} score combines the hidden quality of every produced note with route efficiency. The same successful cell move can improve as attacks get cleaner, settling gets faster, and holds get steadier.` : `The next level slides or redraws the four notes, rotates their directions, and grows according to ${difficulty} mechanical difficulty. No note keeps the same permanent direction.`}</p>
            <div className="pitch-maze-result-grid">
              <div><span>VOICE QUALITY</span><strong>{currentResult.averageQuality.toFixed(0)}</strong><small>attack + settle + hold</small></div>
              <div><span>IN-LANE FRAMES</span><strong>{currentResult.pitchAccuracy.toFixed(0)}%</strong><small>reliable command samples</small></div>
              <div><span>ROUTE EFFICIENCY</span><strong>{currentResult.navigationEfficiency.toFixed(0)}%</strong><small>{currentResult.optimalMoves} optimal commands</small></div>
              <div><span>WALL COMMANDS</span><strong>{currentResult.blockedCommands}</strong><small>note earned · no movement</small></div>
              <div><span>LEVEL TIME</span><strong>{(currentResult.durationMs / 1_000).toFixed(1)}s</strong><small>{currentResult.moves} cells moved</small></div>
            </div>
            <div className="pitch-maze-move-proof" aria-label="Last movement quality evidence">
              <div><span>LAST TARGET</span><b>{noteLabel(currentResult.lastCommand.targetMidi)} · {currentResult.lastCommand.direction}</b></div>
              <div><span>ATTACK</span><b>{signed(currentResult.lastCommand.attackErrorCents, 0)}¢</b></div>
              <div><span>SETTLED</span><b>{currentResult.lastCommand.settleTimeSeconds === null ? "not in tight lane" : `${Math.round(currentResult.lastCommand.settleTimeSeconds * 1_000)} ms`}</b></div>
              <div><span>HOLD SPREAD</span><b>±{currentResult.lastCommand.spreadCents.toFixed(1)}¢</b></div>
              <div><span>OVERSHOOTS</span><b>{currentResult.lastCommand.overshootCount}</b></div>
            </div>
            <div className="pitch-maze-result-actions">
              {phase === "level-result"
                ? <><ActionButton onClick={closeWorkflow}>Stop run</ActionButton><ActionButton className="primary" onClick={continueCampaign}>Enter maze {levelNumber + 1} <Icon name="arrow" size={16} /></ActionButton></>
                : <ActionButton className="primary" onClick={resetToSetup}>Return to Pitch Maze setup <Icon name="loop" size={16} /></ActionButton>}
            </div>
          </WorkflowStage>
        )}
      </WorkflowDialog>
    </div>
  );
}
