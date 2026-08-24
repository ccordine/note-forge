import { useMemo, type CSSProperties } from "react";
import { useAudioInput } from "@/audio/use-audio-input";
import { playTone, playToneSequence } from "@/audio/synth";
import { useSessionEffectScope } from "@/features/training-session/use-session-effect-scope";
import { continuousMidiToHz, noteLabel, signed } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { useRealtimeSession } from "@/realtime/use-realtime-session";
import { resolveArcadeCurriculum } from "./curriculum";
import {
  CARDINAL_DIRECTIONS,
  PITCH_MAZE_DIFFICULTY_PRESETS,
  PITCH_MAZE_MAPPING_POLICIES,
  createPitchMazeLevel,
  getPitchMazeCell,
  type CardinalDirection,
  type PitchMazeLevel,
  type PitchMazeMappingMode,
} from "./pitch-maze-model";
import {
  PITCH_MAZE_CAMPAIGN_LEVELS,
  createPitchMazeSession,
  reducePitchMazeSession,
  type PitchMazeLevelResult,
  type RecordedPitchMazeCommand,
} from "./pitch-maze-session";
import type { ArcadeGameProps, ArcadeOutcome } from "./types";
import { useArcadeOutcomeHandoff } from "./use-arcade-outcome";

const DIRECTION_GLYPHS: Readonly<Record<CardinalDirection, string>> = Object.freeze({
  north: "↑",
  east: "→",
  south: "↓",
  west: "←",
});

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function samePosition(
  left: Readonly<{ row: number; column: number }>,
  right: Readonly<{ row: number; column: number }>,
): boolean {
  return left.row === right.row && left.column === right.column;
}

function commandCopy(command: Readonly<RecordedPitchMazeCommand>): string {
  const attack = `${signed(command.attackErrorCents, 0)}¢ attack`;
  const settle = command.settleTimeSeconds === null
    ? "no tight settle"
    : `${Math.round(command.settleTimeSeconds * 1_000)} ms settle`;
  return `${noteLabel(command.targetMidi)} ${command.direction} · ${attack} · ${settle} · ±${command.spreadCents.toFixed(0)}¢ spread`;
}

function compassReference(level: Readonly<PitchMazeLevel>) {
  return playToneSequence(CARDINAL_DIRECTIONS.map((direction) => ({
    frequencyHz: continuousMidiToHz(level.directionNotes[direction]),
    duration: 0.24,
    gapAfter: 0.06,
    amplitude: 0.17,
    timbre: "sine" as const,
    release: 0.04,
  })));
}

function directionReference(level: Readonly<PitchMazeLevel>, direction: CardinalDirection) {
  return playTone({
    frequencyHz: continuousMidiToHz(level.directionNotes[direction]),
    duration: 0.32,
    amplitude: 0.17,
    timbre: "sine",
    release: 0.05,
  });
}

function MazeBoard({ level }: { readonly level: Readonly<PitchMazeLevel> }) {
  return (
    <section className="pitch-maze-map-panel" aria-label="Pitch Maze map">
      <div className="pitch-maze-map-heading">
        <span>GENERATED SOLVABLE MAP</span>
        <b>{level.moves} MOVED</b>
      </div>
      <div className="pitch-maze-board-wrap">
        <div
          className="pitch-maze-board"
          style={{
            "--maze-rows": level.config.rows,
            "--maze-columns": level.config.columns,
          } as CSSProperties}
          role="grid"
          aria-label={`${level.config.rows} by ${level.config.columns} maze; player row ${level.player.row + 1}, column ${level.player.column + 1}`}
        >
          {level.cells.map((cell) => {
            const isPlayer = samePosition(cell, level.player);
            const isGoal = samePosition(cell, level.goal);
            const borderStyle: CSSProperties = {
              borderTopWidth: cell.walls.north ? 2 : 0,
              borderLeftWidth: cell.walls.west ? 2 : 0,
              borderRightWidth: cell.column === level.config.columns - 1 && cell.walls.east ? 2 : 0,
              borderBottomWidth: cell.row === level.config.rows - 1 && cell.walls.south ? 2 : 0,
            };
            return (
              <div
                key={`${cell.row}:${cell.column}`}
                role="gridcell"
                className={`pitch-maze-cell ${isGoal ? "goal" : ""}`}
                style={borderStyle}
                aria-label={`Row ${cell.row + 1}, column ${cell.column + 1}${isPlayer ? ", player" : ""}${isGoal ? ", exit" : ""}`}
              >
                {isPlayer && <span className="pitch-maze-player" />}
              </div>
            );
          })}
        </div>
      </div>
      <div className="pitch-maze-map-legend">
        <span><i /> YOU · {level.player.row + 1},{level.player.column + 1}</span>
        <span><i /> EXIT · {level.goal.row + 1},{level.goal.column + 1}</span>
      </div>
    </section>
  );
}

interface CompassProps {
  readonly level: Readonly<PitchMazeLevel>;
  readonly activeDirection: CardinalDirection;
  readonly allowReferenceReplay: boolean;
  readonly onPlayDirection: (direction: CardinalDirection) => void;
}

function PitchCompass({ level, activeDirection, allowReferenceReplay, onPlayDirection }: CompassProps) {
  const currentCell = getPitchMazeCell(level);
  return (
    <div className="pitch-maze-compass" aria-label="Four-note voice compass">
      {CARDINAL_DIRECTIONS.map((direction) => (
        <button
          type="button"
          key={direction}
          className={`pitch-maze-direction ${direction} ${activeDirection === direction ? "active" : ""} ${currentCell.walls[direction] ? "blocked" : "open"}`}
          aria-label={`${direction}, ${noteLabel(level.directionNotes[direction])}, ${currentCell.walls[direction] ? "wall" : "open"}${allowReferenceReplay ? ", play short reference" : ""}`}
          onClick={allowReferenceReplay
            ? () => onPlayDirection(direction)
            : undefined}
        >
          <span>{DIRECTION_GLYPHS[direction]}</span>
          <strong>{noteLabel(level.directionNotes[direction])}</strong>
          <small>{currentCell.walls[direction] ? "wall" : "open"}</small>
        </button>
      ))}
      <div className="pitch-maze-compass-center"><span><b>VOICE</b><small>D-PAD</small></span></div>
    </div>
  );
}

interface SetupControlsProps {
  readonly mappingMode: PitchMazeMappingMode;
  readonly previewLevel: Readonly<PitchMazeLevel>;
  readonly difficulty: ArcadeGameProps["difficulty"];
  readonly curriculumFocus: string;
  readonly rangeReady: boolean;
  readonly onMappingChange: (mappingMode: PitchMazeMappingMode) => void;
  readonly onPlayCompass: () => void;
  readonly onStart: () => void;
}

function SetupControls({
  mappingMode,
  previewLevel,
  difficulty,
  curriculumFocus,
  rangeReady,
  onMappingChange,
  onPlayCompass,
  onStart,
}: SetupControlsProps) {
  const preset = PITCH_MAZE_DIFFICULTY_PRESETS[difficulty];
  return (
    <section className="pitch-maze-setup-panel">
      <header>
        <Eyebrow>Five-maze campaign</Eyebrow>
        <h2>Choose the compass policy.</h2>
        <p>{curriculumFocus} Every hold is reduced from the same continuous observation stream.</p>
      </header>
      <fieldset className="pitch-maze-mode-picker">
        <legend>Note mapping</legend>
        {(Object.keys(PITCH_MAZE_MAPPING_POLICIES) as PitchMazeMappingMode[]).map((id) => (
          <label key={id}>
            <input
              type="radio"
              name="pitch-maze-mapping"
              value={id}
              checked={mappingMode === id}
              onChange={() => onMappingChange(id)}
            />
            <b>{PITCH_MAZE_MAPPING_POLICIES[id].label}</b>
            <small>{PITCH_MAZE_MAPPING_POLICIES[id].description}</small>
          </label>
        ))}
      </fieldset>
      <div className="pitch-maze-setup-summary">
        <div><span>FIRST BOARD</span><b>{previewLevel.config.rows}×{previewLevel.config.columns}</b></div>
        <div><span>LANE</span><b>±{preset.toleranceCents}¢</b></div>
        <div><span>HOLD</span><b>{preset.holdDurationSeconds.toFixed(2)}s</b></div>
      </div>
      <div className="pitch-maze-loadout-actions">
        <ActionButton onClick={onPlayCompass}>
          <Icon name="headphones" size={17} /> Hear short compass
        </ActionButton>
        <ActionButton className="primary wide" disabled={!rangeReady} onClick={onStart}>
          Start Pitch Maze <Icon name="arrow" size={18} />
        </ActionButton>
      </div>
    </section>
  );
}

interface ResultProps {
  readonly result: Readonly<PitchMazeLevelResult>;
  readonly campaignOutcome: Readonly<ArcadeOutcome> | null;
  readonly campaignComplete: boolean;
  readonly nextLevel: number;
  readonly onContinue: () => void;
  readonly onReset: () => void;
  readonly onExit: () => void;
}

function ResultPanel({
  result,
  campaignOutcome,
  campaignComplete,
  nextLevel,
  onContinue,
  onReset,
  onExit,
}: ResultProps) {
  return (
    <section className="pitch-maze-result" aria-label="Pitch Maze result">
      <div className="pitch-maze-result-mark">{campaignComplete ? campaignOutcome?.grade ?? "✓" : "✓"}</div>
      <h2>{campaignComplete
        ? `${campaignOutcome?.score ?? 0} voice-control score`
        : `Maze ${result.level} cleared · ${result.averageQuality.toFixed(0)} quality`}</h2>
      <div className="pitch-maze-result-grid">
        <div><span>VOICE QUALITY</span><strong>{result.averageQuality.toFixed(0)}</strong><small>attack + settle + hold</small></div>
        <div><span>IN-LANE</span><strong>{result.pitchAccuracy.toFixed(0)}%</strong><small>credible observations</small></div>
        <div><span>EFFICIENCY</span><strong>{result.navigationEfficiency.toFixed(0)}%</strong><small>{result.optimalMoves} optimal</small></div>
        <div><span>WALL NOTES</span><strong>{result.blockedCommands}</strong><small>detected · no move</small></div>
        <div><span>SAMPLE TIME</span><strong>{(result.durationMs / 1_000).toFixed(1)}s</strong><small>{result.moves} cells moved</small></div>
      </div>
      <div className="pitch-maze-move-proof" aria-label="Last command evidence">
        <div><span>LAST TARGET</span><b>{noteLabel(result.lastCommand.targetMidi)} · {result.lastCommand.direction}</b></div>
        <div><span>ATTACK</span><b>{signed(result.lastCommand.attackErrorCents, 0)}¢</b></div>
        <div><span>SETTLED</span><b>{result.lastCommand.settleTimeSeconds === null ? "not tight" : `${Math.round(result.lastCommand.settleTimeSeconds * 1_000)} ms`}</b></div>
        <div><span>SPREAD</span><b>±{result.lastCommand.spreadCents.toFixed(1)}¢</b></div>
        <div><span>OVERSHOOTS</span><b>{result.lastCommand.overshootCount}</b></div>
      </div>
      <div className="pitch-maze-result-actions">
        <ActionButton onClick={onExit}>Exit arcade</ActionButton>
        {campaignComplete
          ? <ActionButton className="primary" onClick={onReset}>Play another campaign <Icon name="loop" size={16} /></ActionButton>
          : <ActionButton className="primary" onClick={onContinue}>Enter maze {nextLevel} <Icon name="arrow" size={16} /></ActionButton>}
      </div>
    </section>
  );
}

export function PitchMaze({
  difficulty,
  curriculumStage,
  voiceRange,
  onExit,
  onComplete,
}: ArcadeGameProps) {
  const realtime = useRealtimeSession(
    reducePitchMazeSession,
    createPitchMazeSession,
  );
  const session = realtime.state;
  const reference = useSessionEffectScope();
  const curriculum = resolveArcadeCurriculum("maze", curriculumStage);
  const previewLevel = useMemo(() => createPitchMazeLevel({
    seed: "pitch-maze-setup-preview",
    voiceRange,
    level: 1,
    mappingMode: session.mappingMode,
    difficulty,
  }), [difficulty, session.mappingMode, voiceRange]);
  const displayLevel = session.level ?? previewLevel;
  const controller = session.controller;
  const activeDirection = controller?.activeDirection ?? session.selectedDirection;
  const activeTargetMidi = displayLevel.directionNotes[activeDirection];
  const holdSeconds = controller?.dwell?.heldSeconds ?? 0;
  const input = useAudioInput({
    diagnostics: {
      flow: "voice-arcade",
      phase: session.phase,
      targetMidi: activeTargetMidi,
      toleranceCents: displayLevel.config.toleranceCents,
      stableMs: holdSeconds * 1_000,
      requiredHoldMs: displayLevel.config.holdDurationSeconds * 1_000,
      resetReason: null,
    },
    onFrame: (observation) => realtime.observe({ type: "observation", observation }),
  });
  const rangeReady = voiceRange.highMidi - voiceRange.lowMidi >= 3;
  const levelCommands = session.commands.filter((command) => command.level === session.levelNumber);
  const blockedCommands = levelCommands.filter((command) => command.result === "wall").length;
  const qualityAverage = average(levelCommands.map((command) => command.qualityScore));
  const holdStatus = controller?.dwell?.currentInTolerance === true
    ? "holding"
    : controller?.dwell?.currentInTolerance === false
      ? "waiting"
      : "waiting";
  const commandStatus = input.state !== "running"
    ? "VOICE OFF · ENABLE VOICE IN THE HEADER"
      : controller?.phase === "tracking"
        ? `${activeDirection.toUpperCase()} · ${noteLabel(activeTargetMidi)} · ${holdSeconds.toFixed(2)}S`
        : controller?.committedDirection
          ? `${controller.committedDirection.toUpperCase()} COMPLETE · CHANGE NOTE FOR NEXT MOVE`
          : "LIVE · ANY MAPPED NOTE CAN MOVE";

  useArcadeOutcomeHandoff(session.outcome, session.outcome, onComplete);

  const startCampaign = () => {
    reference.abort();
    realtime.dispatch({
      type: "start",
      campaign: {
        seed: `pitch-maze:${crypto.randomUUID()}`,
        difficulty,
        curriculumStage,
        voiceRange,
        mappingMode: session.mappingMode,
      },
    });
  };
  const exitGame = () => {
    reference.abort();
    onExit();
  };

  return (
    <div className={`pitch-maze-page curriculum-${curriculumStage}`}>
      <Panel className="pitch-maze-shell">
        <header className="pitch-maze-shell-header">
          <div>
            <Eyebrow>{curriculum.stageLabel} · voice is the D-pad</Eyebrow>
            <h1>{session.phase === "setup" ? "Four notes become direction." : `Maze ${session.levelNumber} of ${PITCH_MAZE_CAMPAIGN_LEVELS}`}</h1>
            <p>{session.notice}</p>
          </div>
          <div className="pitch-maze-shell-actions">
            <ActionButton onClick={exitGame}>Exit arcade</ActionButton>
          </div>
        </header>

        <div className="pitch-maze-play-layout">
          <div className="pitch-maze-map-stack">
            {session.phase === "setup" && (
              <SetupControls
                mappingMode={session.mappingMode}
                previewLevel={previewLevel}
                difficulty={difficulty}
                curriculumFocus={curriculum.focus}
                rangeReady={rangeReady}
                onMappingChange={(mappingMode) => realtime.dispatch({ type: "set-mapping", mappingMode })}
                onPlayCompass={() => reference.playReference(
                  "Pitch Maze compass reference",
                  () => compassReference(previewLevel),
                )}
                onStart={startCampaign}
              />
            )}
            <MazeBoard level={displayLevel} />
          </div>

          <section className="pitch-maze-controller-panel" aria-label="Continuous voice controller">
            <div className="pitch-maze-controller-heading">
              <span>ONE LIVE NOTE STREAM · FOUR DIRECTIONS</span>
              <b>{curriculum.feedback.allowReferenceReplay ? "DIRECTIONS PLAY SHORT REFERENCES" : "REFERENCE LABELS ONLY"}</b>
            </div>
            <PitchCompass
              level={displayLevel}
              activeDirection={activeDirection}
              allowReferenceReplay={curriculum.feedback.allowReferenceReplay}
              onPlayDirection={(direction) => reference.playReference(
                `Pitch Maze ${direction} reference`,
                () => directionReference(displayLevel, direction),
              )}
            />
            <NoteInput
              variant="target"
              input={input}
              targetMidi={activeTargetMidi}
              toleranceCents={displayLevel.config.toleranceCents}
              phase="listening"
              hold={{
                heldSeconds: holdSeconds,
                requiredSeconds: displayLevel.config.holdDurationSeconds,
                status: holdStatus,
              }}
              guidanceTitle={controller?.phase === "tracking"
                ? `Hold ${noteLabel(activeTargetMidi)} for ${activeDirection}`
                : "Sing any displayed direction note"}
              guidanceDetail="Every detector window stays visible. Game commands derive from continuous sample-time occupancy."
              diagnosticsFlow="voice-arcade"
              feedbackLevel={curriculum.feedback.level}
            />
            <div className={`pitch-maze-command-state ${session.lastCommandResult ?? ""}`} role="status" aria-live="polite">
              <span>
                <b>{commandStatus}</b><br />
                {controller?.lastCommand
                  ? commandCopy({
                      ...controller.lastCommand,
                      level: session.levelNumber,
                      result: session.lastCommandResult ?? "moved",
                    })
                  : "Silence and uncertain observations remain live evidence and never restart input."}
              </span>
              {controller?.lastCommand && <strong>{controller.lastCommand.qualityScore}</strong>}
            </div>
          </section>
        </div>

        {session.phase === "playing" && (
          <div className="pitch-maze-run-stats">
            <div><span>VOICE COMMANDS</span><b>{levelCommands.length}</b></div>
            <div><span>CELLS MOVED</span><b>{displayLevel.moves}</b></div>
            <div><span>BLOCKED NOTES</span><b>{blockedCommands}</b></div>
            <div><span>AVG QUALITY</span><b>{qualityAverage ? qualityAverage.toFixed(0) : "—"}</b></div>
            <div><span>OPTIMAL PATH</span><b>{session.levelOptimalMoves}</b></div>
          </div>
        )}

        {(session.phase === "level-result" || session.phase === "campaign-result") && session.currentResult && (
          <ResultPanel
            result={session.currentResult}
            campaignOutcome={session.outcome}
            campaignComplete={session.phase === "campaign-result"}
            nextLevel={session.levelNumber + 1}
            onContinue={() => realtime.dispatch({ type: "continue" })}
            onReset={() => realtime.dispatch({ type: "reset" })}
            onExit={exitGame}
          />
        )}
      </Panel>
    </div>
  );
}
