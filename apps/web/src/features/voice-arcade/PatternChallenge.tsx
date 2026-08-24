import {
  useCallback,
  useState,
  type CSSProperties,
} from "react";
import { useAudioInput } from "@/audio/use-audio-input";
import { playTone, playToneSequence } from "@/audio/synth";
import {
  attachVoiceToScope,
  useSessionEffectScope,
} from "@/features/training-session/use-session-effect-scope";
import { continuousMidiToHz, noteLabel, signed } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { useRealtimeSession } from "@/realtime/use-realtime-session";
import { resolveArcadeCurriculum } from "./curriculum";
import { getDifficultyPreset, type VoiceChallengeMode } from "./model";
import {
  createPatternChallengeController,
  reducePatternChallenge,
  type PatternChallengeControllerState,
} from "./pattern-challenge-controller";
import type { ArcadeFeedbackPolicy, ArcadeGameProps } from "./types";
import { useArcadeOutcomeHandoff } from "./use-arcade-outcome";

const MODE_COPY: Record<VoiceChallengeMode, { label: string; detail: string }> = {
  simon: { label: "Simon echo", detail: "Hear the whole phrase, then reproduce it from memory." },
  ddr: { label: "Sight run", detail: "Read the moving note rail and hit each target on time." },
};

function referenceToneDuration(difficulty: ArcadeGameProps["difficulty"]): number {
  if (difficulty === "hard") return 0.34;
  if (difficulty === "medium") return 0.42;
  return 0.5;
}

function noteRailLookAhead(difficulty: ArcadeGameProps["difficulty"]): number {
  if (difficulty === "hard") return 3.2;
  if (difficulty === "medium") return 4.2;
  return 5.2;
}

interface PatternReference {
  readonly play: (
    mode: VoiceChallengeMode,
    pattern: PatternChallengeControllerState["pattern"],
    difficulty: ArcadeGameProps["difficulty"],
  ) => Promise<void>;
  readonly stop: () => void;
  readonly error: string;
}

function usePatternReference(): PatternReference {
  const [error, setError] = useState("");
  const { abort: stop, restart } = useSessionEffectScope();

  const play = useCallback(async (
    mode: VoiceChallengeMode,
    pattern: PatternChallengeControllerState["pattern"],
    difficulty: ArcadeGameProps["difficulty"],
  ) => {
    const signal = restart();
    setError("");
    try {
      await attachVoiceToScope(signal, () => mode === "simon"
        ? playToneSequence(pattern.map((step) => ({
          frequencyHz: continuousMidiToHz(step.targetMidi),
          duration: referenceToneDuration(difficulty),
          gapAfter: difficulty === "hard" ? 0.08 : 0.12,
          timbre: "sine" as const,
          amplitude: 0.22,
          release: 0.06,
        })))
        : playTone({
          frequencyHz: continuousMidiToHz(pattern[0]!.targetMidi),
          duration: 0.55,
          amplitude: 0.2,
          release: 0.08,
        }));
    } catch (cause) {
      if (!signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Reference playback could not start.");
      }
    }
  }, [restart]);

  return { play, stop, error };
}

interface SetupProps {
  readonly game: PatternChallengeControllerState;
  readonly preset: ReturnType<typeof getDifficultyPreset>;
  readonly stageLabel: string;
  readonly stageSummary: string;
  readonly onSelectMode: (mode: VoiceChallengeMode) => void;
  readonly onPrepare: () => void;
}

function PatternSetup({
  game,
  preset,
  stageLabel,
  stageSummary,
  onSelectMode,
  onPrepare,
}: SetupProps) {
  return (
    <Panel className="arcade-game-loadout">
      <div>
        <Eyebrow>Echo Run · {stageLabel}</Eyebrow>
        <h1>Hear it. Remember it. Drive it.</h1>
        <p>Choose one phrase model. The microphone remains the same continuous controller before, during, and after the run. {stageSummary}</p>
      </div>
      <div className="arcade-mode-toggle" role="radiogroup" aria-label="Echo Run style">
        {(Object.keys(MODE_COPY) as VoiceChallengeMode[]).map((mode) => (
          <button
            type="button"
            role="radio"
            aria-checked={game.mode === mode}
            className={game.mode === mode ? "active" : ""}
            key={mode}
            onClick={() => onSelectMode(mode)}
          >
            <b>{MODE_COPY[mode].label}</b>
            <span>{MODE_COPY[mode].detail}</span>
          </button>
        ))}
      </div>
      <div className="arcade-contract-grid">
        <span><b>{preset.patternLength}</b><small>notes</small></span>
        <span><b>±{preset.toleranceCents}¢</b><small>pitch lane</small></span>
        <span><b>{preset.tempoBpm}</b><small>BPM</small></span>
        <span><b>{preset.sustainDurationSeconds.toFixed(2)}s</b><small>hold per target</small></span>
      </div>
      <div className="arcade-start-row">
        <span>Build the phrase, optionally hear it, then start when you are ready. Headphones are useful for previews but never required.</span>
        <ActionButton className="primary" onClick={onPrepare}>
          Prepare phrase <Icon name="arrow" size={17} />
        </ActionButton>
      </div>
    </Panel>
  );
}

interface PreviewProps {
  readonly game: PatternChallengeControllerState;
  readonly feedback: ArcadeFeedbackPolicy;
  readonly referenceError: string;
  readonly onHear: () => void;
  readonly onBegin: () => void;
  readonly onBack: () => void;
}

function PatternPreview({
  game,
  feedback,
  referenceError,
  onHear,
  onBegin,
  onBack,
}: PreviewProps) {
  const previewLabel = feedback.showPreviewLabels
    ? game.pattern.map((step) => noteLabel(step.targetMidi)).join(" · ")
    : `${game.pattern.length}-note phrase`;
  const hearLabel = game.mode === "simon" ? "Hear phrase" : "Hear first target";
  return (
    <Panel className="arcade-countdown-stage" aria-live="polite">
      <span className="arcade-countdown-orb"><Icon name="play" size={34} /></span>
      <Eyebrow>{game.mode === "simon" ? "Preview · then echo" : "Preview · then sight-read"}</Eyebrow>
      <h2>{previewLabel}</h2>
      <p>Reference playback is optional and one-shot. It never hides the live detector, clears pitch evidence, or changes microphone state.</p>
      <div className="arcade-preview-notes">
        {game.pattern.map((step, index) => (
          <span key={`${step.targetMidi}-${index}`}>
            <b>{feedback.showPreviewLabels ? noteLabel(step.targetMidi) : "•"}</b>
            <small>{index + 1}</small>
          </span>
        ))}
      </div>
      {referenceError && <div className="error-banner" role="alert">{referenceError}</div>}
      <div className="arcade-result-actions">
        <ActionButton onClick={onBack}>Change loadout</ActionButton>
        <ActionButton onClick={onHear}><Icon name="play" size={16} /> {hearLabel}</ActionButton>
        <ActionButton className="primary" onClick={onBegin}>
          Start voice run <Icon name="arrow" size={18} />
        </ActionButton>
      </div>
    </Panel>
  );
}

function noteTiles(
  game: PatternChallengeControllerState,
  lookAheadSeconds: number,
  lowMidi: number,
  highMidi: number,
) {
  return game.session?.steps.map((step) => ({
    step,
    left: 15 + (step.windowStartSeconds - game.elapsedSeconds) / lookAheadSeconds * 78,
    top: 8 + (1 - (step.targetMidi - lowMidi) / (highMidi - lowMidi)) * 80,
    width: Math.max(5, (step.windowEndSeconds - step.windowStartSeconds) / lookAheadSeconds * 78),
  })) ?? [];
}

function stepMarker(status: "pending" | "active" | "hit" | "miss", index: number): string | number {
  if (status === "hit") return "✓";
  if (status === "miss") return "×";
  return index + 1;
}

function upcomingNoteLabel(
  targetMidi: number | undefined,
  showUpcomingCue: boolean,
): string {
  if (targetMidi === undefined) return "END";
  return showUpcomingCue ? noteLabel(targetMidi) : "HIDDEN";
}

function pitchDirection(errorCents: number | null, showCents: boolean): string {
  if (errorCents === null) return "waiting for voiced pitch";
  let motion = "centered";
  if (errorCents < 0) motion = "move up";
  if (errorCents > 0) motion = "move down";
  return showCents ? `${signed(errorCents, 0)}¢ · ${motion}` : motion;
}

interface PlayingProps {
  readonly game: PatternChallengeControllerState;
  readonly feedback: ArcadeFeedbackPolicy;
  readonly difficulty: ArcadeGameProps["difficulty"];
  readonly lowMidi: number;
  readonly highMidi: number;
}

function PatternPlaying({ game, feedback, difficulty, lowMidi, highMidi }: PlayingProps) {
  const session = game.session!;
  const activeStep = session.steps[session.activeStepIndex];
  const liveMidi = game.liveMidi;
  const liveError = liveMidi === null || !activeStep ? null : (liveMidi - activeStep.targetMidi) * 100;
  const liveY = liveMidi === null
    ? 50
    : 8 + (1 - Math.max(0, Math.min(1, (liveMidi - lowMidi) / (highMidi - lowMidi)))) * 80;
  const lookAheadSeconds = noteRailLookAhead(difficulty);
  const tiles = noteTiles(game, lookAheadSeconds, lowMidi, highMidi);
  const nextStep = session.steps[session.activeStepIndex + 1];
  const nextLabel = upcomingNoteLabel(nextStep?.targetMidi, feedback.showUpcomingCue);
  const direction = pitchDirection(liveError, feedback.showCents);

  return (
    <div className="echo-run-stage">
      <div className="echo-target-readout echo-target-readout--two">
        <div><span>NOW</span><strong>{activeStep ? noteLabel(activeStep.targetMidi) : "FINISH"}</strong><small>{activeStep ? `${activeStep.requiredSustainSeconds.toFixed(2)}s hold` : "phrase complete"}</small></div>
        <div><span>NEXT</span><strong>{nextLabel}</strong><small>{session.hitSteps}/{session.steps.length} hits</small></div>
      </div>
      <div className="echo-highway" role="img" aria-label={`Moving note highway. Current target ${activeStep ? noteLabel(activeStep.targetMidi) : "complete"}.`}>
        <div className="echo-pitch-grid">{Array.from({ length: 7 }, (_, index) => <i key={index} />)}</div>
        <i className="echo-hit-line"><span>HIT</span></i>
        {tiles.filter(({ left }) => left > -15 && left < 110).map(({ step, left, top, width }) => (
          <span
            key={step.id}
            className={`echo-note-tile ${step.status}`}
            style={{ "--note-left": `${left}%`, "--note-top": `${top}%`, "--note-width": `${width}%` } as CSSProperties}
          >
            <b>{feedback.showUpcomingCue || step.index <= session.activeStepIndex ? noteLabel(step.targetMidi) : "•"}</b>
            <i style={{ width: `${step.progress * 100}%` }} />
          </span>
        ))}
        <span className={`echo-voice-cursor ${liveMidi === null ? "silent" : ""}`} style={{ "--voice-top": `${liveY}%` } as CSSProperties}>
          <i />{feedback.showLiveNote && <b>{liveMidi === null ? "VOICE" : noteLabel(liveMidi)}</b>}
        </span>
      </div>
      <div className="echo-step-strip">
        {session.steps.map((step) => (
          <span key={step.id} className={step.status}>
            <b>{feedback.showUpcomingCue || step.index <= session.activeStepIndex ? noteLabel(step.targetMidi) : "?"}</b>
            <i>{stepMarker(step.status, step.index)}</i>
          </span>
        ))}
      </div>
      <div className="arcade-live-status" role="status" aria-live="polite">
        <span>{direction}</span>
        <b>{activeStep?.status === "active"
          ? `${Math.round(activeStep.progress * 100)}% held`
          : `${Math.max(0, (activeStep?.windowStartSeconds ?? game.elapsedSeconds) - game.elapsedSeconds).toFixed(1)}s to target`}</b>
      </div>
    </div>
  );
}

interface ResultProps {
  readonly game: PatternChallengeControllerState;
  readonly onExit: () => void;
  readonly onChange: () => void;
  readonly onNext: () => void;
}

function PatternResult({ game, onExit, onChange, onNext }: ResultProps) {
  const result = game.result!;
  return (
    <Panel className="arcade-result-stage">
      <div className="arcade-result-grade"><span>RUN GRADE</span><strong>{result.grade}</strong><b>{result.scorePercent}<small>/100</small></b></div>
      <div className="arcade-result-copy">
        <Eyebrow>Echo Run complete</Eyebrow>
        <h2>{result.gradeLabel}</h2>
        <p>{result.hitSteps} of {result.totalSteps} notes earned · {result.accuracyPercent.toFixed(0)}% pitch quality.</p>
        <div className="arcade-result-metrics">
          <span><small>Notes hit</small><b>{result.hitSteps}/{result.totalSteps}</b></span>
          <span><small>Pitch quality</small><b>{result.accuracyPercent.toFixed(0)}%</b></span>
          <span><small>Best combo</small><b>{result.maxCombo}×</b></span>
          <span><small>Raw points</small><b>{result.score.toLocaleString()}</b></span>
        </div>
        <div className="arcade-result-actions">
          <ActionButton onClick={onExit}>Back to cabinet</ActionButton>
          <ActionButton onClick={onChange}>Change loadout</ActionButton>
          <ActionButton className="primary" onClick={onNext}>Next phrase <Icon name="arrow" size={16} /></ActionButton>
        </div>
      </div>
    </Panel>
  );
}

interface SurfaceProps extends ArcadeGameProps {
  readonly game: PatternChallengeControllerState;
  readonly referenceError: string;
  readonly onSelectMode: (mode: VoiceChallengeMode) => void;
  readonly onPrepare: () => void;
  readonly onHear: () => void;
  readonly onBegin: () => void;
  readonly onBack: () => void;
  readonly onNext: () => void;
}

function PatternSurface(props: SurfaceProps) {
  const preset = getDifficultyPreset(props.difficulty);
  const curriculum = resolveArcadeCurriculum("pattern", props.curriculumStage);
  switch (props.game.phase) {
    case "setup":
      return <PatternSetup game={props.game} preset={preset} stageLabel={curriculum.stageLabel} stageSummary={curriculum.stageSummary} onSelectMode={props.onSelectMode} onPrepare={props.onPrepare} />;
    case "preview":
      return <PatternPreview game={props.game} feedback={curriculum.feedback} referenceError={props.referenceError} onHear={props.onHear} onBegin={props.onBegin} onBack={props.onBack} />;
    case "playing":
      return <PatternPlaying game={props.game} feedback={curriculum.feedback} difficulty={props.difficulty} lowMidi={props.voiceRange.lowMidi} highMidi={props.voiceRange.highMidi} />;
    case "result":
      return <PatternResult game={props.game} onExit={props.onExit} onChange={props.onBack} onNext={props.onNext} />;
  }
}

export function PatternChallenge(props: ArcadeGameProps) {
  const { difficulty, curriculumStage, voiceRange, onComplete, onExit } = props;
  const realtime = useRealtimeSession(
    reducePatternChallenge,
    () => createPatternChallengeController({
      difficulty,
      lowMidi: voiceRange.lowMidi,
      highMidi: voiceRange.highMidi,
      baselineMidi: voiceRange.baselineMidi,
    }),
  );
  const game = realtime.state;
  const input = useAudioInput({
    onFrame: (observation) => realtime.observe({ type: "observation", observation }),
  });
  const reference = usePatternReference();
  const preset = getDifficultyPreset(difficulty);
  const curriculum = resolveArcadeCurriculum("pattern", curriculumStage);
  const completedOutcome = game.phase === "result" && game.result ? {
      mode: "pattern",
      curriculumStage,
      variant: game.mode,
      score: game.result.scorePercent,
      grade: game.result.grade,
      xp: Math.round(game.result.scorePercent * preset.scoreMultiplier),
      accuracy: game.result.accuracyPercent,
      bestCombo: game.result.maxCombo,
      durationMs: Math.round(game.elapsedSeconds * 1_000),
      details: {
        rawScore: game.result.score,
        maximumScore: game.result.maximumScore,
        completionPercent: game.result.completionPercent,
        hitSteps: game.result.hitSteps,
        missedSteps: game.result.missedSteps,
      },
    } as const : null;
  useArcadeOutcomeHandoff(
    completedOutcome ? game.runSerial : null,
    completedOutcome,
    onComplete,
  );

  const prepare = () => realtime.dispatch({
    type: "prepare",
    seed: `echo:${curriculumStage}:${difficulty}:${game.mode}:${game.round}:${voiceRange.lowMidi}:${voiceRange.highMidi}`,
  });
  const begin = () => {
    reference.stop();
    realtime.dispatch({ type: "begin" });
  };
  const exit = () => {
    reference.stop();
    onExit();
  };
  const back = () => {
    reference.stop();
    realtime.dispatch({ type: "change-loadout" });
  };
  const stop = () => {
    reference.stop();
    realtime.dispatch({ type: "stop" });
  };
  let hudAction = exit;
  let hudLabel = "Exit game";
  if (game.phase === "preview") {
    hudAction = back;
    hudLabel = "Back to setup";
  }
  if (game.phase === "playing") {
    hudAction = stop;
    hudLabel = "Stop & grade";
  }

  return (
    <section className={`arcade-game-shell echo-run-shell curriculum-${curriculum.stage}`}>
      <div className="arcade-game-hud">
        <div><span>ROUND</span><strong>{game.round.toString().padStart(2, "0")}</strong></div>
        <div><span>SCORE</span><strong>{game.session?.score.toLocaleString() ?? "0"}</strong></div>
        <div className="combo"><span>COMBO</span><strong>{game.session?.combo ?? 0}<small>×</small></strong></div>
        <div><span>PITCH QUALITY</span><strong>{game.session ? `${game.session.accuracyPercent.toFixed(0)}%` : "—"}</strong></div>
        <ActionButton className="coral" onClick={hudAction}><Icon name="pause" size={16} /> {hudLabel}</ActionButton>
      </div>

      <div className="echo-live-input">
        <NoteInput variant="compact" input={input} compact />
      </div>
      {input.error && <div className="error-banner" role="alert">{input.error}</div>}

      <PatternSurface
        {...props}
        game={game}
        referenceError={reference.error}
        onSelectMode={(mode) => realtime.dispatch({ type: "select-mode", mode })}
        onPrepare={prepare}
        onHear={() => { void reference.play(game.mode, game.pattern, difficulty); }}
        onBegin={begin}
        onBack={back}
        onNext={() => realtime.dispatch({ type: "next-round" })}
        onExit={exit}
      />
    </section>
  );
}
