import { useEffect, useState, type ReactNode } from "react";
import "../../styles-pitch-mirror.css";
import { type AttemptMetrics } from "@noteforge/trainer-core";
import { useAudioInput } from "@/audio/use-audio-input";
import { type Timbre } from "@/audio/synth";
import { useSustainedNote } from "@/audio/use-sustained-note";
import {
  attemptRecentScoringFrames,
  attemptScoringFrames,
  type AttemptRunnerStatus,
  type CompletedAttempt,
} from "@/features/training-session/attempt-runner";
import { useAttemptRunner } from "@/features/training-session/use-attempt-runner";
import { scoreWeightedSustainedNote } from "@/features/training-session/attempt-scoring";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import type { MirrorMode } from "@/navigation";
import { useMusicalState } from "@/state/MusicalContext";
import { useUserPreferences } from "@/state/UserPreferencesContext";
import { useAppNavigation } from "@/routing/use-app-navigation";
import { saveAttempt } from "@/storage/database";
import { ActionButton, Eyebrow, Panel, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NotePlaybackToggle } from "@/ui/NotePlaybackToggle";
import { NoteInput } from "@/ui/voice";
import { PitchRibbon } from "./PitchRibbon";

interface MirrorTakeConfiguration {
  readonly mode: MirrorMode;
  readonly midi: number;
  readonly centsOffset: number;
  readonly timbre: Timbre;
  readonly toleranceCents: number;
}

const TRACE_WINDOW_SECONDS = 8;

const modeInfo: Record<MirrorMode, { label: string; instruction: string; detail: string }> = {
  glide: { label: "Glide", instruction: "Let your voice find the lane.", detail: "Start the trace, then slide toward the remembered target." },
  delayed: { label: "Delayed", instruction: "Hold the target in memory.", detail: "Toggle the reference off, wait as long as you choose, then measure." },
  cold: { label: "Cold attack", instruction: "Predict first. Arrive directly.", detail: "Use the reference toggle if needed, turn it off, then measure the first voiced arrival." },
  anchor: { label: "Memory anchor", instruction: "Recover the session anchor.", detail: "A4 is the fixed coordinate; produce it from memory whenever you are ready." },
  silent: { label: "Silent prep", instruction: "Configure before you phonate.", detail: "Simulate the target internally, then begin the trace without playback." },
};

const tolerances = [
  { value: "35", label: "Beginner ±35¢" },
  { value: "20", label: "Developing ±20¢" },
  { value: "10", label: "Precise ±10¢" },
];

function Metric({ label, value, unit, tone }: { label: string; value?: number; unit?: string; tone?: string }) {
  const signedUnit = unit === "¢" || unit === "¢/s";
  const rendered = value == null || !Number.isFinite(value)
    ? "—"
    : `${signedUnit && value >= 0 ? "+" : ""}${value.toFixed(unit === "%" ? 0 : 1)}`;
  return <div className={`metric ${tone ?? ""}`}><span>{label}</span><strong>{rendered}<small>{value == null ? "" : unit}</small></strong></div>;
}

function scoreMirrorTake(take: Readonly<CompletedAttempt<MirrorTakeConfiguration>>): AttemptMetrics {
  const configuration = take.configuration;
  const frames = attemptScoringFrames(take);
  return scoreWeightedSustainedNote(
    take,
    frames,
    {
      midi: configuration.mode === "anchor" ? 69 : configuration.midi,
      centsOffset: configuration.mode === "anchor" ? 0 : configuration.centsOffset,
      timbre: configuration.timbre,
      amplitude: 0.28,
    },
    {
      toleranceCents: configuration.toleranceCents,
      promptTimeSeconds: frames[0]?.timeSeconds,
    },
  );
}

function takeStatus(status: AttemptRunnerStatus, inputState: string): string {
  if (status === "tracking") return "MEASURING LIVE STREAM";
  if (status === "complete") return "TRACE COMPLETE";
  if (inputState === "running") return "READY TO MEASURE";
  return "USE ENABLE VOICE IN THE HEADER";
}

export function PitchMirror() {
  const {
    selectedMidi, setSelectedMidi, centsOffset, timbre, setTimbre,
  } = useMusicalState();
  const { toleranceCents, setToleranceCents } = useUserPreferences();
  const { route, navigate } = useAppNavigation();
  const mode = route.surface === "practice" && route.activity === "pitch-match" ? route.mode : "glide";
  const [metrics, setMetrics] = useState<AttemptMetrics | null>(null);
  const [saveError, setSaveError] = useState("");

  const completeAttempt = (completed: Readonly<CompletedAttempt<MirrorTakeConfiguration>>) => {
    const configuration = completed.configuration;
    const frames = attemptScoringFrames(completed);
    const result = scoreMirrorTake(completed);
    setMetrics(result);
    const completedAt = new Date().toISOString();
    return saveAttempt({
      id: crypto.randomUUID(),
      exerciseType: `pitch.match.${configuration.mode}`,
      target: { midi: configuration.mode === "anchor" ? 69 : configuration.midi, centsOffset: configuration.mode === "anchor" ? 0 : configuration.centsOffset },
      metrics: result as Record<string, number | undefined>,
      pitchFrames: [...frames],
      startedAt: completed.startedAt ?? completedAt,
      completedAt,
    });
  };
  const attempt = useAttemptRunner<MirrorTakeConfiguration>({
    scoringProfile: (configuration) => ({
      targetMidiFloat: configuration.mode === "anchor"
        ? 69
        : configuration.midi + configuration.centsOffset / 100,
      toleranceCents: configuration.toleranceCents,
    }),
    onComplete: completeAttempt,
    onCompletionError: () => setSaveError("The measured trace could not be saved to local history."),
  });
  const input = useAudioInput({ onFrame: attempt.observe });
  const storedConfiguration = attempt.state.configuration;
  const attemptConfiguration = storedConfiguration?.mode === mode ? storedConfiguration : null;
  const workflowStatus = storedConfiguration !== null && attemptConfiguration === null
    ? "idle"
    : attempt.state.status;
  const activeMode = attemptConfiguration?.mode ?? mode;
  const configuredMidi = attemptConfiguration?.midi ?? selectedMidi;
  const configuredCents = attemptConfiguration?.centsOffset ?? centsOffset;
  const activeTimbre = attemptConfiguration?.timbre ?? timbre;
  const activeToleranceCents = attemptConfiguration?.toleranceCents ?? toleranceCents;
  const effectiveMidi = activeMode === "anchor" ? 69 : configuredMidi;
  const effectiveCents = activeMode === "anchor" ? 0 : configuredCents;
  const targetMidiFloat = effectiveMidi + effectiveCents / 100;
  const targetFrequency = continuousMidiToHz(effectiveMidi, effectiveCents);
  const targetPlayback = useSustainedNote({
    frequencyHz: targetFrequency,
    timbre: activeTimbre,
    amplitude: 0.22,
  });
  // The visible evidence trace is the detector stream itself. Smoothing or
  // octave correction would rewrite a frame while retaining its sample ID.
  const shownFrames = attemptRecentScoringFrames(attempt.state);
  const resetAttempt = attempt.reset;

  useEffect(() => {
    resetAttempt();
    setMetrics(null);
    setSaveError("");
  }, [mode, resetAttempt]);

  const resetTrace = () => {
    resetAttempt();
    setMetrics(null);
    setSaveError("");
  };
  const selectMode = (nextMode: MirrorMode) => {
    navigate({ surface: "practice", activity: "pitch-match", mode: nextMode });
  };
  const begin = () => {
    setSaveError("");
    setMetrics(null);
    attempt.begin({ mode, midi: selectedMidi, centsOffset, timbre, toleranceCents });
  };
  const resultHeading = metrics ? "The trace is measured from continuous PCM." : "Finalizing the trace…";

  let currentStep: ReactNode;
  if (workflowStatus === "idle") {
    currentStep = (
      <Panel className="mirror-mode-panel" data-workflow-step="idle">
        <Segmented label="Mode" value={mode} onChange={selectMode} options={Object.entries(modeInfo).map(([value, item]) => ({ value: value as MirrorMode, label: item.label }))} />
        <div className="mirror-settings">
          <Select label="Target" value={selectedMidi} disabled={mode === "anchor"} onChange={(event) => { resetTrace(); setSelectedMidi(Number(event.target.value)); }}>{Array.from({ length: 36 }, (_, index) => 45 + index).map((midi) => <option value={midi} key={midi}>{noteLabel(midi)}</option>)}</Select>
          <Select label="Timbre" value={timbre} onChange={(event) => { resetTrace(); setTimbre(event.target.value as typeof timbre); }}><option>sine</option><option>triangle</option><option>piano</option><option>guitar</option><option>bass</option><option>flute</option><option>voice</option><option>rich synth</option></Select>
          <Select label="Tolerance" value={toleranceCents} onChange={(event) => { resetTrace(); setToleranceCents(Number(event.target.value)); }}>{tolerances.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</Select>
          <button className="randomize-button" disabled={mode === "anchor"} onClick={() => { resetTrace(); setSelectedMidi(48 + Math.floor(Math.random() * 25)); }}><Icon name="spark" size={16} /> Randomize</button>
        </div>
        <div className="target-display"><span className="target-kicker">TARGET</span><strong>{noteLabel(effectiveMidi)}</strong><span>{targetFrequency.toFixed(2)} Hz</span></div>
        <div className="stage-actions">
          <ActionButton data-pitch-mirror-action="start-trace" className="primary attempt-button" disabled={input.state !== "running"} onClick={begin}><Icon name="mic" size={18} /> Start trace</ActionButton>
        </div>
      </Panel>
    );
  } else if (workflowStatus === "tracking") {
    currentStep = (
      <Panel className="mirror-stage active" data-workflow-step="tracking" data-trace-lifetime="user-owned">
        <div className="target-display">
          <span className="target-kicker">TARGET</span><strong>{noteLabel(effectiveMidi)}</strong><span>{targetFrequency.toFixed(2)} Hz</span>
        </div>
        <div className="stage-status"><span>{takeStatus(attempt.state.status, input.state)}</span><b>{attempt.state.elapsedSeconds.toFixed(2)} s</b><small>The canonical live note remains in the input scope above.</small></div>
        <PitchRibbon frames={shownFrames} targetMidiFloat={targetMidiFloat} toleranceCents={activeToleranceCents} windowSeconds={TRACE_WINDOW_SECONDS} />
        <div className="stage-actions"><ActionButton data-pitch-mirror-action="finish-trace" onClick={attempt.finish}>Finish trace</ActionButton></div>
      </Panel>
    );
  } else {
    currentStep = (
      <div className="mirror-results-grid" data-workflow-step="complete">
        <Panel className="metrics-panel">
          <div className="panel-heading"><div><Eyebrow>Separate evidence</Eyebrow><h2>Trace anatomy</h2></div><span className="attempt-badge">measured</span></div>
          <div className="metrics-grid">
            <Metric label="Attack" value={metrics?.attackErrorCents} unit="¢" tone="coral" />
            <Metric label="Center" value={metrics?.medianErrorCents} unit="¢" tone="lime" />
            <Metric label="Mean error" value={metrics?.meanAbsoluteErrorCents} unit="¢" />
            <Metric label="In lane" value={metrics?.inToleranceRatio == null ? undefined : metrics.inToleranceRatio * 100} unit="%" tone="blue" />
            <Metric label="Stability" value={metrics?.vibratoAdjustedStabilityCents ?? metrics?.stabilityCents} unit="¢" />
            <Metric label="Drift" value={metrics?.driftCentsPerSecond} unit="¢/s" />
            <Metric label="Hold" value={metrics?.holdDurationMs == null ? undefined : metrics.holdDurationMs / 1000} unit="s" />
            <Metric label="Confidence" value={metrics?.detectorConfidence == null ? undefined : metrics.detectorConfidence * 100} unit="%" />
          </div>
        </Panel>
        <Panel className="guidance-panel">
          <Eyebrow>Read the gesture</Eyebrow><h2>{resultHeading}</h2>
          <p>Attack, correction, center, and drift are derived from one uninterrupted observation stream. Silence remains evidence; it does not restart the microphone.</p>
          <ActionButton className="wide" onClick={resetTrace}>Measure another trace</ActionButton>
        </Panel>
      </div>
    );
  }

  return (
    <div className="page pitch-mirror-page">
      <div className="lab-intro mirror-intro">
        <div><Eyebrow>Continuous pitch evidence</Eyebrow><h1>{modeInfo[mode].instruction}</h1><p>{modeInfo[mode].detail} Playback and measurement are independent actions.</p></div>
      </div>

      {saveError && <div className="error-banner"><strong>Local history needs attention.</strong><span>{saveError}</span></div>}

      <NoteInput variant="scope" input={input} targetMidiFloat={targetMidiFloat} toleranceCents={activeToleranceCents} title="Pitch mirror input" />
      {(activeMode !== "silent" || targetPlayback.playing) && <div className="practice-reference-control"><NotePlaybackToggle playback={targetPlayback} label={noteLabel(effectiveMidi)} /></div>}
      <section className="practice-current-step">{currentStep}</section>
    </div>
  );
}
