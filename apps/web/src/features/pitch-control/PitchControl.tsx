import { useEffect, useState, type ReactNode } from "react";
import "../../styles-pitch-control.css";
import { smoothPitchFrames, type PitchFrame } from "@noteforge/pitch-engine";
import { scoreSustainedNote, type AttemptMetrics } from "@noteforge/trainer-core";
import { useAudioInput } from "@/audio/use-audio-input";
import { playTone, type Timbre } from "@/audio/synth";
import type { CompletedAttempt } from "@/features/training-session/attempt-runner";
import { useAttemptRunner } from "@/features/training-session/use-attempt-runner";
import { BRIEF_REFERENCE_SECONDS } from "@/features/training-session/use-session-effect-scope";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import type { ControlMode } from "@/navigation";
import { useMusicalState } from "@/state/MusicalContext";
import { useUserPreferences } from "@/state/UserPreferencesContext";
import { useAppNavigation } from "@/routing/use-app-navigation";
import { saveAttempt } from "@/storage/database";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { PitchRibbon } from "@/features/pitch-mirror/PitchRibbon";

interface ControlTakeConfiguration {
  readonly envelopeType: ControlMode;
  readonly vowel: string;
  readonly midi: number;
  readonly centsOffset: number;
  readonly timbre: Timbre;
  readonly toleranceCents: number;
  readonly duration: number;
}

interface ControlResult {
  readonly metrics: AttemptMetrics;
  readonly volumeScore: number | undefined;
}

const envelopes: Record<ControlMode, { label: string; points: readonly number[]; cue: string }> = {
  free: { label: "Free volume", points: [0.5, 0.5], cue: "Hold pitch; shape volume however you choose." },
  steady: { label: "Steady", points: [0.48, 0.48], cue: "One pitch. One volume. No drift." },
  crescendo: { label: "Crescendo", points: [0.12, 0.2, 0.38, 0.62, 0.92], cue: "Grow without lifting the fundamental." },
  decrescendo: { label: "Decrescendo", points: [0.92, 0.68, 0.42, 0.22, 0.12], cue: "Release energy without letting pitch sag." },
  diamond: { label: "Quiet → loud → quiet", points: [0.12, 0.32, 0.78, 0.96, 0.78, 0.32, 0.12], cue: "Open and close the dynamic arc around one center." },
  pulses: { label: "Pulses", points: [0.18, 0.82, 0.18, 0.82, 0.18, 0.82, 0.18], cue: "Change energy in clean steps while pitch stays put." },
};

const NUMERICAL_SILENCE_RMS = 1e-6;

export function interpolateEnvelope(points: readonly number[], progress: number): number {
  const position = Math.max(0, Math.min(1, progress)) * (points.length - 1);
  const index = Math.floor(position);
  const fraction = position - index;
  const next = points[Math.min(index + 1, points.length - 1)] ?? points[index]!;
  return points[index]! * (1 - fraction) + next * fraction;
}

export function scoreEnvelope(
  frames: readonly Pick<PitchFrame, "rms">[],
  frameElapsedSeconds: readonly number[],
  points: readonly number[],
  durationSeconds: number,
  rmsThreshold = NUMERICAL_SILENCE_RMS,
): number | undefined {
  const data = frames.flatMap((frame, index) => {
    const elapsed = frameElapsedSeconds[index];
    return elapsed != null && Number.isFinite(frame.rms) && frame.rms >= rmsThreshold
      ? [{ level: frame.rms, progress: elapsed / durationSeconds }]
      : [];
  });
  if (data.length < 4) return undefined;
  const levels = data.map(({ level }) => level);
  const minimum = Math.min(...levels);
  const maximum = Math.max(...levels);
  if (maximum - minimum < 1e-5) {
    return points.every((point) => Math.abs(point - points[0]!) < 0.05) ? 100 : 0;
  }
  const error = data.reduce((sum, item) => {
    const actual = (item.level - minimum) / (maximum - minimum);
    return sum + Math.abs(actual - interpolateEnvelope(points, item.progress));
  }, 0) / data.length;
  return Math.max(0, (1 - error) * 100);
}

function scoreTake(take: Readonly<CompletedAttempt<ControlTakeConfiguration>>): ControlResult {
  const configuration = take.configuration;
  const frames = smoothPitchFrames(take.frames);
  const metrics = scoreSustainedNote(
    frames,
    { midi: configuration.midi, centsOffset: configuration.centsOffset, durationMs: configuration.duration * 1_000, timbre: configuration.timbre, amplitude: 0.25 },
    { toleranceCents: configuration.toleranceCents, promptTimeSeconds: frames[0]?.timeSeconds },
  );
  return {
    metrics,
    volumeScore: scoreEnvelope(
      frames,
      take.frameElapsedSeconds,
      envelopes[configuration.envelopeType].points,
      configuration.duration,
    ),
  };
}

export function PitchControl() {
  const { selectedMidi, setSelectedMidi, centsOffset, timbre } = useMusicalState();
  const { toleranceCents } = useUserPreferences();
  const { route, navigate } = useAppNavigation();
  const envelopeType = route.surface === "practice" && route.activity === "pitch-control" ? route.mode : "diamond";
  const [vowel, setVowel] = useState("oo");
  const [duration, setDuration] = useState(8);
  const [result, setResult] = useState<ControlResult | null>(null);
  const [saveError, setSaveError] = useState("");

  const completeAttempt = (completed: Readonly<CompletedAttempt<ControlTakeConfiguration>>) => {
    const configuration = completed.configuration;
    const nextResult = scoreTake(completed);
    setResult(nextResult);
    const frames = smoothPitchFrames(completed.frames);
    const completedAt = new Date().toISOString();
    return saveAttempt({
      id: crypto.randomUUID(),
      exerciseType: `pitch.control.${configuration.envelopeType}`,
      target: { midi: configuration.midi, centsOffset: configuration.centsOffset, durationSeconds: configuration.duration },
      metrics: { ...(nextResult.metrics as Record<string, number | undefined>), volumeScore: nextResult.volumeScore },
      pitchFrames: frames,
      startedAt: completed.startedAt ?? completedAt,
      completedAt,
    });
  };
  const attempt = useAttemptRunner<ControlTakeConfiguration>({
    onComplete: completeAttempt,
    onCompletionError: () => setSaveError("The controlled-hold trace could not be saved to local history."),
  });
  const input = useAudioInput({ onFrame: attempt.observe });
  const storedConfiguration = attempt.state.configuration;
  const attemptConfiguration = storedConfiguration?.envelopeType === envelopeType
    ? storedConfiguration
    : null;
  const workflowStatus = storedConfiguration !== null && attemptConfiguration === null
    ? "idle"
    : attempt.state.status;
  const activeEnvelopeType = attemptConfiguration?.envelopeType ?? envelopeType;
  const activeVowel = attemptConfiguration?.vowel ?? vowel;
  const activeMidi = attemptConfiguration?.midi ?? selectedMidi;
  const activeCentsOffset = attemptConfiguration?.centsOffset ?? centsOffset;
  const activeTimbre = attemptConfiguration?.timbre ?? timbre;
  const activeToleranceCents = attemptConfiguration?.toleranceCents ?? toleranceCents;
  const activeDuration = attemptConfiguration?.duration ?? duration;
  const envelope = envelopes[activeEnvelopeType];
  const frames = attempt.state.frames;
  const normalizedRms = (() => {
    const maximum = Math.max(...frames.map((frame) => frame.rms), 0.001);
    return frames.map((frame) => frame.rms / maximum);
  })();
  const currentTargetLevel = interpolateEnvelope(envelope.points, attempt.state.elapsedSeconds / activeDuration);
  const resetAttempt = attempt.reset;

  useEffect(() => {
    resetAttempt();
    setResult(null);
    setSaveError("");
  }, [envelopeType, resetAttempt]);

  const clearTake = () => {
    resetAttempt();
    setResult(null);
    setSaveError("");
  };
  const begin = () => {
    setSaveError("");
    setResult(null);
    attempt.begin({ envelopeType, vowel, midi: selectedMidi, centsOffset, timbre, toleranceCents, duration }, duration);
  };
  const hearReference = () => attempt.playReference("Pitch Control reference", () => playTone({
    frequencyHz: continuousMidiToHz(activeMidi, activeCentsOffset),
    timbre: activeTimbre,
    duration: BRIEF_REFERENCE_SECONDS,
    amplitude: 0.22,
  }));
  let dynamicCue = "LOUD";
  if (currentTargetLevel < 0.3) dynamicCue = "QUIET";
  else if (currentTargetLevel < 0.7) dynamicCue = "MEDIUM";
  const medianCenter = result?.metrics.medianErrorCents == null
    ? "—"
    : `${result.metrics.medianErrorCents > 0 ? "+" : ""}${result.metrics.medianErrorCents.toFixed(1)}¢`;
  const targetMidiFloat = activeMidi + activeCentsOffset / 100;
  const beginLabel = input.state === "running" ? `Begin ${duration} s trace` : "Enable voice in header";
  const envelopeOptions = (Object.entries(envelopes) as [ControlMode, (typeof envelopes)[ControlMode]][])
    .map(([value, item]) => ({ value, label: item.label }));
  const chooseMode = (nextMode: ControlMode) => navigate({ surface: "practice", activity: "pitch-control", mode: nextMode });

  let currentStep: ReactNode;
  if (workflowStatus === "idle") {
    currentStep = (
      <Panel className="control-config" data-workflow-step="idle">
        <div className="control-config-main"><Segmented value={envelopeType} onChange={chooseMode} options={envelopeOptions} /></div>
        <div className="control-config-fields">
          <Select label="Target" value={selectedMidi} onChange={(event) => { clearTake(); setSelectedMidi(Number(event.target.value)); }}>{Array.from({ length: 30 }, (_, index) => 45 + index).map((midi) => <option key={midi} value={midi}>{noteLabel(midi)}</option>)}</Select>
          <Select label="Gesture" value={vowel} onChange={(event) => { clearTake(); setVowel(event.target.value); }}><option value="hum">Hum</option><option value="oo">Oo</option><option value="oh">Oh</option><option value="ah">Ah</option><option value="ee">Ee</option></Select>
          <Select label="Duration" value={duration} onChange={(event) => { clearTake(); setDuration(Number(event.target.value)); }}><option value="5">5 seconds</option><option value="8">8 seconds</option><option value="12">12 seconds</option></Select>
        </div>
        <div className="envelope-header"><div><span>MISSION · {vowel.toUpperCase()}</span><h2>{envelopes[envelopeType].cue}</h2></div><div className="envelope-target"><small>PITCH CENTER</small><strong>{noteLabel(selectedMidi)}</strong><span>±{toleranceCents}¢</span></div></div>
        <div className="stage-actions">
          <PlayButton label="Hear brief reference" onClick={hearReference} />
          <ActionButton className="primary" disabled={input.state !== "running"} onClick={begin}><Icon name="mic" size={18} /> {beginLabel}</ActionButton>
        </div>
      </Panel>
    );
  } else if (workflowStatus === "tracking") {
    currentStep = (
      <Panel className="envelope-stage active" data-workflow-step="tracking">
        <div className="envelope-header"><div><span>MISSION · {activeVowel.toUpperCase()}</span><h2>{envelope.cue}</h2></div><div className="envelope-target"><small>PITCH CENTER</small><strong>{noteLabel(activeMidi)}</strong><span>±{activeToleranceCents}¢</span></div></div>
        <div className="envelope-visual">
          <svg viewBox="0 0 1000 220" preserveAspectRatio="none" aria-label="Target volume envelope">
            <defs><linearGradient id="envelope-fill" x1="0" x2="1"><stop stopColor="#63d7ff" stopOpacity=".05" /><stop offset=".5" stopColor="#d8ff3e" stopOpacity=".3" /><stop offset="1" stopColor="#ff6b45" stopOpacity=".08" /></linearGradient></defs>
            {[0, 1, 2, 3, 4].map((row) => <line key={row} x1="0" x2="1000" y1={20 + row * 45} y2={20 + row * 45} />)}
            <path className="target-envelope-area" d={`M 0 205 ${envelope.points.map((point, index) => `L ${(index / (envelope.points.length - 1)) * 1000} ${205 - point * 170}`).join(" ")} L 1000 205 Z`} />
            <path className="target-envelope-line" d={envelope.points.map((point, index) => `${index ? "L" : "M"} ${(index / (envelope.points.length - 1)) * 1000} ${205 - point * 170}`).join(" ")} />
            <line className="playhead" x1={(attempt.state.elapsedSeconds / activeDuration) * 1000} x2={(attempt.state.elapsedSeconds / activeDuration) * 1000} y1="0" y2="220" />
            {normalizedRms.length > 1 && <path className="actual-envelope-line" d={normalizedRms.map((point, index) => `${index ? "L" : "M"} ${(index / (normalizedRms.length - 1)) * 1000} ${205 - point * 170}`).join(" ")} />}
          </svg>
          <div className="dynamic-readout"><span>FOLLOW</span><b style={{ transform: `scale(${0.8 + currentTargetLevel * 0.4})` }}>{dynamicCue}</b></div>
          <div className="envelope-axis"><span>quiet</span><span>VOLUME · RMS</span><span>loud</span></div>
        </div>
        <PitchRibbon frames={frames} targetMidiFloat={targetMidiFloat} toleranceCents={activeToleranceCents} durationSeconds={activeDuration} envelope={normalizedRms} />
        <div className="stage-actions"><PlayButton label="Hear brief reference" onClick={hearReference} /><ActionButton onClick={attempt.finish}>Finish trace</ActionButton></div>
      </Panel>
    );
  } else {
    currentStep = (
      <div className="split-score" data-workflow-step="complete">
        <Panel className="dimension-score pitch">
          <Eyebrow>Dimension 01</Eyebrow>
          <div className="dimension-title"><span className="dimension-icon">∿</span><div><h2>Pitch control</h2><p>Center, stability, and drift</p></div><strong>{result?.metrics.inToleranceRatio == null ? "—" : `${(result.metrics.inToleranceRatio * 100).toFixed(0)}%`}</strong></div>
          <dl>
            <div><dt>Median center</dt><dd>{medianCenter}</dd></div>
            <div><dt>Stability</dt><dd>{result?.metrics.stabilityCents == null ? "—" : `${result.metrics.stabilityCents.toFixed(1)}¢`}</dd></div>
            <div><dt>Drift</dt><dd>{result?.metrics.driftCentsPerSecond == null ? "—" : `${result.metrics.driftCentsPerSecond.toFixed(1)}¢/s`}</dd></div>
          </dl>
        </Panel>
        <Panel className="dimension-score volume">
          <Eyebrow>Dimension 02</Eyebrow>
          <div className="dimension-title"><span className="dimension-icon">◢</span><div><h2>Dynamic control</h2><p>Envelope shape, separate from pitch</p></div><strong>{result?.volumeScore == null ? "—" : `${result.volumeScore.toFixed(0)}%`}</strong></div>
          <dl>
            <div><dt>Shape match</dt><dd>{result?.volumeScore == null ? "—" : `${result.volumeScore.toFixed(1)}%`}</dd></div>
            <div><dt>Dynamic range</dt><dd>{result?.metrics.volume?.dynamicRangeDb == null ? "—" : `${result.metrics.volume.dynamicRangeDb.toFixed(1)} dB`}</dd></div>
            <div><dt>Peak RMS</dt><dd>{result?.metrics.volume?.maximumRms == null ? "—" : result.metrics.volume.maximumRms.toFixed(3)}</dd></div>
          </dl>
          <ActionButton className="wide" onClick={clearTake}>Shape another trace</ActionButton>
        </Panel>
      </div>
    );
  }

  return (
    <div className="page control-page">
      <div className="lab-intro">
        <div><Eyebrow>Continuous pitch + level evidence</Eyebrow><h1>Move the energy. Keep the center.</h1><p>Begin a sample-timed trace whenever you are ready. The microphone never follows the exercise lifecycle.</p></div>
      </div>

      {saveError && <div className="error-banner"><strong>Local history needs attention.</strong><span>{saveError}</span></div>}

      <NoteInput variant="scope" input={input} targetMidiFloat={targetMidiFloat} toleranceCents={activeToleranceCents} title="Pitch and level monitor" />
      <section className="practice-current-step">{currentStep}</section>
    </div>
  );
}
