import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useAudioInput } from "@/audio/use-audio-input";
import type { PitchObservation } from "@/audio/note-input";
import { noteLabel, signed } from "@/lib/music-display";
import { ActionButton, Eyebrow } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { resolveArcadeCurriculum } from "./curriculum";
import { getDifficultyPreset } from "./model";
import type { ArcadeGameProps } from "./types";
import {
  VOICE_DRAW_TRACE_TARGETS,
  centerVoiceDrawCursor,
  clearVoiceDraw,
  configureVoiceDrawState,
  createVoiceDrawState,
  getVoiceDrawTraceTarget,
  scoreVoiceDrawTrace,
  undoVoiceDrawStroke,
  updateVoiceDrawFromObservation,
  type VoiceDrawBrushStyle,
  type VoiceDrawDirection,
  type VoiceDrawSegment,
  type VoiceDrawState,
  type VoiceDrawTraceScore,
  type VoiceDrawTraceTargetId,
  type VoiceDrawTool,
} from "./voice-draw-engine";

type VoiceDrawMode = "free" | "trace" | "puzzle";

interface DrawModeCopy {
  readonly label: string;
  readonly shortLabel: string;
  readonly detail: string;
}

interface PuzzlePrompt {
  readonly id: string;
  readonly label: string;
  readonly guidance: string;
}

interface RenderedStroke {
  readonly id: number;
  readonly path: string;
  readonly style: VoiceDrawBrushStyle;
}

interface RecordedTraceResult {
  readonly score: VoiceDrawTraceScore;
  readonly segments: readonly VoiceDrawSegment[];
}

const CANVAS_SIZE = 1_000;
const CANVAS_BACKGROUND = "#090c0b";
const DRAW_MODES = Object.freeze([
  Object.freeze({
    id: "free",
    label: "Free Draw",
    shortLabel: "No score",
    detail: "Make anything. Pitch chooses direction; silence stops the cursor.",
  }),
  Object.freeze({
    id: "trace",
    label: "Trace",
    shortLabel: "Path score",
    detail: "Follow a visible route and score path accuracy plus target coverage.",
  }),
  Object.freeze({
    id: "puzzle",
    label: "Puzzle",
    shortLabel: "No route",
    detail: "Draw the named object from your own plan. The app does not pretend to judge the picture.",
  }),
] as const satisfies readonly (DrawModeCopy & { readonly id: VoiceDrawMode })[]);
const PUZZLE_PROMPTS = Object.freeze([
  Object.freeze({ id: "house", label: "Draw a house", guidance: "Plan the walls, roof, door, and windows with your eight directions." }),
  Object.freeze({ id: "rocket", label: "Draw a rocket", guidance: "Build a body, nose, fins, and a voice-steered flame." }),
  Object.freeze({ id: "flower", label: "Draw a flower", guidance: "Use direction changes to place a stem, leaves, center, and petals." }),
  Object.freeze({ id: "face", label: "Draw a face", guidance: "Navigate the outline, then lift the pen to place eyes and a mouth." }),
] as const satisfies readonly PuzzlePrompt[]);
const PALETTE = Object.freeze([
  "#f5f2df",
  "#ff75d8",
  "#60e8ff",
  "#d8ff3e",
  "#ff6b45",
  "#b39aff",
  "#ffcf5a",
  "#57e389",
]);
const DIRECTION_GLYPHS: Readonly<Record<VoiceDrawDirection, string>> = Object.freeze({
  up: "↑",
  "up-right": "↗",
  right: "→",
  "down-right": "↘",
  down: "↓",
  "down-left": "↙",
  left: "←",
  "up-left": "↖",
});

function speedForDifficulty(difficulty: ArcadeGameProps["difficulty"]): number {
  if (difficulty === "easy") return 0.16;
  if (difficulty === "hard") return 0.29;
  return 0.22;
}

function canvasCoordinate(value: number): number {
  return Math.round(value * CANVAS_SIZE * 100) / 100;
}

function tracePath(targetId: VoiceDrawTraceTargetId): string {
  const target = getVoiceDrawTraceTarget(targetId);
  const commands = target.points.map((point, index) => (
    `${index === 0 ? "M" : "L"} ${canvasCoordinate(point.x)} ${canvasCoordinate(point.y)}`
  ));
  if (target.closed) commands.push("Z");
  return commands.join(" ");
}

function groupRenderedStrokes(segments: readonly VoiceDrawSegment[]): readonly RenderedStroke[] {
  const strokes: { id: number; path: string; style: VoiceDrawBrushStyle }[] = [];
  for (const segment of segments) {
    const previous = strokes.at(-1);
    const line = `L ${canvasCoordinate(segment.to.x)} ${canvasCoordinate(segment.to.y)}`;
    if (previous?.id === segment.strokeId) {
      previous.path += ` ${line}`;
      continue;
    }
    strokes.push({
      id: segment.strokeId,
      path: `M ${canvasCoordinate(segment.from.x)} ${canvasCoordinate(segment.from.y)} ${line}`,
      style: segment.style,
    });
  }
  return strokes;
}

function styleWith(
  state: Readonly<VoiceDrawState>,
  changes: Partial<VoiceDrawBrushStyle>,
): VoiceDrawBrushStyle {
  return {
    color: changes.color ?? state.style.color,
    width: changes.width ?? state.style.width,
    tool: changes.tool ?? state.style.tool,
  };
}

function cleanVoiceDrawRun(state: Readonly<VoiceDrawState>): VoiceDrawState {
  return centerVoiceDrawCursor(clearVoiceDraw(state));
}

function stateDescription(state: Readonly<VoiceDrawState>): string {
  if (state.activeDirection !== null && state.activeMidi !== null) {
    return `${noteLabel(state.activeMidi)} moves ${state.activeDirection}.`;
  }
  if (state.stopReason === "unmapped") return "Cursor stationary: the current note is outside this direction bank.";
  if (state.stopReason === "uncertain") return "Cursor stationary: pitch evidence is uncertain.";
  return "Cursor stationary: silence or no voiced pitch.";
}

export function VoiceDraw({
  difficulty,
  curriculumStage,
  voiceRange,
  onComplete,
}: ArcadeGameProps) {
  const [mode, setMode] = useState<VoiceDrawMode>("free");
  const [targetId, setTargetId] = useState<VoiceDrawTraceTargetId>("square");
  const [puzzleId, setPuzzleId] = useState<string>(PUZZLE_PROMPTS[0].id);
  const [traceResult, setTraceResult] = useState<RecordedTraceResult | null>(null);
  const [drawState, setDrawState] = useState(() => createVoiceDrawState({
    voiceRange,
    speedNormalizedPerSecond: speedForDifficulty(difficulty),
  }));
  const onFrameRef = useRef<(frame: Readonly<PitchObservation>) => void>(() => undefined);
  const completedTraceSegmentsRef = useRef<readonly VoiceDrawSegment[] | null>(null);
  const configurationKeyRef = useRef(`${difficulty}:${voiceRange.lowMidi}:${voiceRange.highMidi}:${voiceRange.baselineMidi}`);

  const input = useAudioInput({
    diagnostics: {
      flow: "voice-arcade",
      phase: `draw-${mode}`,
    },
    onFrame: (frame) => onFrameRef.current(frame),
  });
  const curriculum = resolveArcadeCurriculum("draw", curriculumStage);
  const showCompass = curriculum.feedback.level !== "gameplay";
  const showCompassNotes = curriculum.feedback.level === "full";
  const showLivePitch = curriculum.feedback.showLiveNote;
  const selectedPrompt = PUZZLE_PROMPTS.find((prompt) => prompt.id === puzzleId) ?? PUZZLE_PROMPTS[0];
  const renderedStrokes = useMemo(
    () => groupRenderedStrokes(drawState.segments),
    [drawState.segments],
  );
  const selectedTracePath = useMemo(() => tracePath(targetId), [targetId]);
  const visibleTraceResult = traceResult?.segments === drawState.segments
    ? traceResult.score
    : null;
  const liveFrame = input.state === "running" ? input.liveFrame : undefined;
  const liveCents = liveFrame?.voiced === true
    && liveFrame.endSample === drawState.lastAuthority?.endSample
    && liveFrame.captureEpoch === drawState.lastAuthority.captureEpoch
    && liveFrame.continuityEpoch === drawState.lastAuthority.continuityEpoch
    && liveFrame.graphGeneration === drawState.lastAuthority.graphGeneration
    && liveFrame.nearestMidi === drawState.activeMidi
    && liveFrame.centsFromNearest !== null
    && Number.isFinite(liveFrame.centsFromNearest)
    ? liveFrame.centsFromNearest
    : null;
  const directionStatus = drawState.activeDirection !== null && drawState.activeMidi !== null
    ? `${noteLabel(drawState.activeMidi)} ${DIRECTION_GLYPHS[drawState.activeDirection]} · ${drawState.activeHeldSeconds.toFixed(2)} s`
    : drawState.stopReason === "unmapped"
      ? "Stationary · unmapped note"
      : drawState.stopReason === "uncertain"
        ? "Stationary · uncertain"
        : "Stationary · silence";

  onFrameRef.current = (frame) => {
    setDrawState((current) => updateVoiceDrawFromObservation(current, frame));
  };

  const resetConfiguration = useCallback(() => {
    setDrawState(createVoiceDrawState({
      voiceRange,
      speedNormalizedPerSecond: speedForDifficulty(difficulty),
    }));
    setTraceResult(null);
    completedTraceSegmentsRef.current = null;
  }, [difficulty, voiceRange]);

  useEffect(() => {
    const key = `${difficulty}:${voiceRange.lowMidi}:${voiceRange.highMidi}:${voiceRange.baselineMidi}`;
    if (configurationKeyRef.current === key) return;
    configurationKeyRef.current = key;
    resetConfiguration();
  }, [difficulty, resetConfiguration, voiceRange.baselineMidi, voiceRange.highMidi, voiceRange.lowMidi]);

  const configureStyle = useCallback((changes: Partial<VoiceDrawBrushStyle>) => {
    setDrawState((current) => configureVoiceDrawState(current, {
      style: styleWith(current, changes),
    }));
  }, []);

  const chooseMode = useCallback((nextMode: VoiceDrawMode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    setDrawState((current) => cleanVoiceDrawRun(current));
    setTraceResult(null);
    completedTraceSegmentsRef.current = null;
  }, [mode]);

  const chooseTraceTarget = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setTargetId(event.target.value as VoiceDrawTraceTargetId);
    setDrawState((current) => cleanVoiceDrawRun(current));
    setTraceResult(null);
    completedTraceSegmentsRef.current = null;
  }, []);

  const choosePuzzlePrompt = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setPuzzleId(event.target.value);
    setDrawState((current) => cleanVoiceDrawRun(current));
    setTraceResult(null);
    completedTraceSegmentsRef.current = null;
  }, []);

  const clearDrawing = useCallback(() => {
    setDrawState((current) => clearVoiceDraw(current));
    setTraceResult(null);
    completedTraceSegmentsRef.current = null;
  }, []);

  const resetCursor = useCallback(() => {
    setDrawState((current) => centerVoiceDrawCursor(current));
  }, []);

  const undo = useCallback(() => {
    setDrawState((current) => undoVoiceDrawStroke(current));
    setTraceResult(null);
    completedTraceSegmentsRef.current = null;
  }, []);

  const finishTrace = useCallback(() => {
    if (
      drawState.segments.length === 0
      || completedTraceSegmentsRef.current === drawState.segments
    ) return;
    completedTraceSegmentsRef.current = drawState.segments;
    const result = scoreVoiceDrawTrace(drawState.segments, targetId);
    setTraceResult({ score: result, segments: drawState.segments });
    onComplete({
      mode: "draw",
      curriculumStage,
      variant: `trace-${targetId}`,
      score: result.score,
      grade: result.grade,
      xp: Math.round(result.score * getDifficultyPreset(difficulty).scoreMultiplier),
      accuracy: result.accuracy,
      bestCombo: 0,
      durationMs: Math.round(drawState.elapsedSeconds * 1_000),
      details: {
        pathDeviation: result.pathDeviation,
        targetCoveragePercent: result.targetCoverage * 100,
        drawnLength: result.drawnLength,
        evaluatedPointCount: result.evaluatedPointCount,
        targetPointCount: result.targetPointCount,
        brushSegments: drawState.segments.filter((segment) => segment.style.tool === "brush").length,
        eraserSegments: drawState.segments.filter((segment) => segment.style.tool === "eraser").length,
        totalDistance: drawState.totalDistance,
      },
    });
  }, [curriculumStage, difficulty, drawState, onComplete, targetId]);

  const enableInput = useCallback(() => {
    void input.enable();
  }, [input]);

  return (
    <section
      className="voice-draw"
      data-voice-draw
      data-draw-mode={mode}
      data-input-state={input.state}
      data-end-sample={drawState.lastAuthority?.endSample ?? ""}
      data-capture-epoch={drawState.lastAuthority?.captureEpoch ?? ""}
      data-continuity-epoch={drawState.lastAuthority?.continuityEpoch ?? ""}
      data-graph-generation={drawState.lastAuthority?.graphGeneration ?? ""}
      data-active-midi={drawState.activeMidi ?? ""}
      data-active-direction={drawState.activeDirection ?? ""}
      data-held-seconds={drawState.activeHeldSeconds}
      data-cursor-x={drawState.cursor.x}
      data-cursor-y={drawState.cursor.y}
      data-segment-count={drawState.segments.length}
      data-observed-frame-count={drawState.observedFrameCount}
    >
      <header className="voice-draw-header">
        <div>
          <Eyebrow>Voice Arcade · eight-direction instrument</Eyebrow>
          <h1>Voice Draw</h1>
          <p>One live pitch stream drives one cursor. Hold a mapped note to move, change note to turn, and use silence to stop exactly where you are.</p>
        </div>
        <div className="voice-draw-mode-tabs" role="radiogroup" aria-label="Drawing mode">
          {DRAW_MODES.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={mode === candidate.id}
              className={mode === candidate.id ? "active" : ""}
              onClick={() => chooseMode(candidate.id)}
            >
              <b>{candidate.label}</b>
              <small>{candidate.shortLabel}</small>
            </button>
          ))}
        </div>
      </header>

      <div className="voice-draw-layout">
        <aside className="voice-draw-tools" aria-label="Drawing tools">
          <section className="voice-draw-tool-group">
            <h2>Color</h2>
            <div className="voice-draw-palette">
              {PALETTE.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`voice-draw-swatch ${drawState.style.color === color ? "active" : ""}`}
                  style={{ backgroundColor: color }}
                  aria-label={`Use ${color} brush color`}
                  aria-pressed={drawState.style.color === color}
                  onClick={() => configureStyle({ color, tool: "brush" })}
                />
              ))}
            </div>
            <label className="voice-draw-color-input">
              Custom color
              <input
                type="color"
                value={drawState.style.color}
                aria-label="Custom brush color"
                onChange={(event) => configureStyle({ color: event.target.value, tool: "brush" })}
              />
            </label>
          </section>

          <section className="voice-draw-tool-group">
            <h2>Brush</h2>
            <label className="voice-draw-size">
              <input
                type="range"
                min="0.004"
                max="0.04"
                step="0.002"
                value={drawState.style.width}
                aria-label="Brush size"
                onChange={(event) => configureStyle({ width: Number(event.target.value) })}
              />
              <output>{Math.round(drawState.style.width * CANVAS_SIZE)} px</output>
            </label>
            <div className="voice-draw-tool-buttons" role="group" aria-label="Brush tool">
              {(["brush", "eraser"] as const satisfies readonly VoiceDrawTool[]).map((tool) => (
                <button
                  key={tool}
                  type="button"
                  className={drawState.style.tool === tool ? "active" : ""}
                  aria-pressed={drawState.style.tool === tool}
                  onClick={() => configureStyle({ tool })}
                >
                  {tool === "brush" ? "Brush" : "Eraser"}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`voice-draw-pen-button ${drawState.penDown ? "active" : ""}`}
              aria-pressed={drawState.penDown}
              onClick={() => setDrawState((current) => configureVoiceDrawState(current, { penDown: !current.penDown }))}
            >
              {drawState.penDown ? "Lift pen" : "Lower pen"}
            </button>
          </section>

          <section className="voice-draw-tool-group">
            <h2>History</h2>
            <div className="voice-draw-history-buttons">
              <button type="button" disabled={drawState.segments.length === 0} onClick={undo}>Undo stroke</button>
              <button type="button" disabled={drawState.segments.length === 0} onClick={clearDrawing}>Clear</button>
            </div>
            <button
              type="button"
              className="voice-draw-pen-button"
              onClick={resetCursor}
              title="Return the voice cursor to the center without changing the artwork"
            >
              Reset cursor
            </button>
          </section>
        </aside>

        <section className="voice-draw-stage-wrap" aria-label="Voice drawing canvas">
          <div className="voice-draw-status-bar" aria-hidden={curriculum.feedback.level === "gameplay"}>
            <span><small>Mode</small><b>{DRAW_MODES.find((candidate) => candidate.id === mode)?.label}</b></span>
            <span><small>Pen</small><b>{drawState.penDown ? `${drawState.style.tool} down` : "lifted"}</b></span>
            <span className={drawState.activeDirection !== null ? "active" : ""}><small>Voice cursor</small><b>{curriculum.feedback.level === "gameplay" ? "Live" : directionStatus}</b></span>
          </div>

          <div className="voice-draw-surface">
            <svg
              className="voice-draw-canvas"
              viewBox={`0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}`}
              role="img"
              aria-label={`${mode === "trace" ? `${getVoiceDrawTraceTarget(targetId).label} trace surface. ` : "Drawing surface. "}${stateDescription(drawState)}`}
            >
              <rect width={CANVAS_SIZE} height={CANVAS_SIZE} fill={CANVAS_BACKGROUND} />
              <g className="voice-draw-artwork">
                {renderedStrokes.map((stroke) => (
                  <path
                    key={stroke.id}
                    className="voice-draw-segment"
                    data-tool={stroke.style.tool}
                    d={stroke.path}
                    stroke={stroke.style.tool === "eraser" ? CANVAS_BACKGROUND : stroke.style.color}
                    strokeWidth={stroke.style.width * CANVAS_SIZE}
                  />
                ))}
              </g>
              <g className="voice-draw-grid" aria-hidden="true">
                {Array.from({ length: 9 }, (_, index) => (index + 1) * 100).map((coordinate) => (
                  <g key={coordinate}>
                    <line x1={coordinate} x2={coordinate} y1="0" y2={CANVAS_SIZE} />
                    <line x1="0" x2={CANVAS_SIZE} y1={coordinate} y2={coordinate} />
                  </g>
                ))}
              </g>
              {mode === "trace" && <path className="voice-draw-target" d={selectedTracePath} aria-hidden="true" />}
              <g
                className="voice-draw-cursor"
                transform={`translate(${canvasCoordinate(drawState.cursor.x)} ${canvasCoordinate(drawState.cursor.y)})`}
                aria-hidden="true"
              >
                <circle className="voice-draw-cursor-halo" r="24" />
                <circle className="voice-draw-cursor-dot" r="8" />
                {curriculum.feedback.level !== "gameplay" && drawState.activeDirection !== null && (
                  <text className="voice-draw-cursor-label" x="18" y="-18">{DIRECTION_GLYPHS[drawState.activeDirection]}</text>
                )}
              </g>
            </svg>

            {input.state !== "running" && (
              <div className="voice-draw-enable">
                <Icon name="mic" size={26} />
                <strong>{input.state === "opening" ? "Opening the voice cursor" : "Enable the voice cursor"}</strong>
                <p>{input.state === "error" ? input.error : "Voice Draw uses the same permanent NoteForge microphone stream as every other voice game."}</p>
                {input.state !== "opening" && (
                  <ActionButton type="button" onClick={enableInput}>
                    <Icon name="mic" size={17} /> Enable voice input
                  </ActionButton>
                )}
              </div>
            )}
            <span className="voice-draw-surface-note">voice moves · silence stops · controls never capture audio</span>
          </div>
          <div className="voice-draw-screen-reader-status" role="status" aria-live="polite">
            {stateDescription(drawState)}
          </div>
        </section>

        <aside className="voice-draw-guide" aria-label="Voice drawing guide">
          <section className="voice-draw-guide-card">
            <h2>{mode === "trace" ? "Trace target" : mode === "puzzle" ? "Drawing prompt" : "Free canvas"}</h2>
            <p className="voice-draw-mode-brief">{DRAW_MODES.find((candidate) => candidate.id === mode)?.detail}</p>
            {mode === "trace" && (
              <>
                <label>
                  <span className="voice-draw-screen-reader-status">Trace shape</span>
                  <select className="voice-draw-select" value={targetId} onChange={chooseTraceTarget} aria-label="Trace shape">
                    {VOICE_DRAW_TRACE_TARGETS.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
                  </select>
                </label>
                <ActionButton className="voice-draw-finish" type="button" disabled={drawState.segments.length === 0 || visibleTraceResult !== null} onClick={finishTrace}>{visibleTraceResult ? "Trace recorded" : "Finish trace"}</ActionButton>
                {visibleTraceResult && (
                  <div className="voice-draw-score-card" aria-live="polite">
                    <strong>{visibleTraceResult.grade}</strong>
                    <span><b>{visibleTraceResult.score.toFixed(0)} / 100</b><small>{(visibleTraceResult.targetCoverage * 100).toFixed(0)}% route coverage · {visibleTraceResult.accuracy.toFixed(0)}% path accuracy</small></span>
                  </div>
                )}
              </>
            )}
            {mode === "puzzle" && (
              <>
                <label>
                  <span className="voice-draw-screen-reader-status">Puzzle prompt</span>
                  <select className="voice-draw-select" value={puzzleId} onChange={choosePuzzlePrompt} aria-label="Puzzle prompt">
                    {PUZZLE_PROMPTS.map((prompt) => <option key={prompt.id} value={prompt.id}>{prompt.label}</option>)}
                  </select>
                </label>
                <div className="voice-draw-prompt"><small>Your challenge</small><strong>{selectedPrompt.label}</strong><span className="voice-draw-mode-brief">{selectedPrompt.guidance}</span></div>
              </>
            )}
          </section>

          {showCompass && (
            <section className="voice-draw-guide-card">
              <h2>{showCompassNotes ? "Eight-note compass" : "Direction memory"}</h2>
              <div className="voice-draw-compass" aria-label="Voice note direction map">
                {drawState.noteBank.mappings.map((mapping) => (
                  <span
                    key={mapping.midi}
                    className={`voice-draw-direction ${drawState.activeDirection === mapping.direction ? "active" : ""} ${mapping.inProfileRange ? "" : "outside-profile"}`}
                    data-direction={mapping.direction}
                    title={`${noteLabel(mapping.midi)} moves ${mapping.direction}${mapping.inProfileRange ? "" : "; outside measured profile"}`}
                  >
                    <b>{DIRECTION_GLYPHS[mapping.direction]}</b>
                    {showCompassNotes && <small>{noteLabel(mapping.midi)}</small>}
                  </span>
                ))}
                <span className="voice-draw-compass-center">silence<br />stop</span>
              </div>
              {showCompassNotes && (
                <p className="voice-draw-bank-note">
                  {drawState.noteBank.expandedOutsideProfile
                    ? `${drawState.noteBank.outsideProfileNoteCount} controller notes extend beyond the current map; detection remains live across the full bank.`
                    : `${noteLabel(drawState.noteBank.baseMidi)}–${noteLabel(drawState.noteBank.topMidi)} fits entirely inside your measured profile.`}
                </p>
              )}
            </section>
          )}

          {showLivePitch && (
            <section className="voice-draw-guide-card">
              <h2>Current command</h2>
              <div className="voice-draw-live-readout">
                <strong>{drawState.activeMidi === null ? "—" : noteLabel(drawState.activeMidi)}</strong>
                <b>{drawState.activeDirection === null ? "stationary" : `${DIRECTION_GLYPHS[drawState.activeDirection]} ${drawState.activeHeldSeconds.toFixed(2)} s`}</b>
                <small>{curriculum.feedback.showCents && liveCents !== null ? `${signed(liveCents, 0)}¢ from center` : directionStatus}</small>
              </div>
            </section>
          )}
        </aside>
      </div>

      <footer className="voice-draw-footer">
        <span><b>Continuous authority:</b> {input.processedWindowCount.toLocaleString()} detector windows · {input.processedSampleCount.toLocaleString()} PCM samples</span>
        <span>{curriculum.stageLabel} · {curriculum.focus}</span>
      </footer>
    </section>
  );
}
