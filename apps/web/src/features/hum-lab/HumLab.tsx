import { useEffect, useState, type ReactNode } from "react";
import "../../styles-hum.css";
import { useAudioInput } from "@/audio/use-audio-input";
import { useSustainedNote } from "@/audio/use-sustained-note";
import {
  attemptRecentScoringFrames,
  attemptScoringFrames,
  type AttemptRunnerStatus,
  type CompletedAttempt,
} from "@/features/training-session/attempt-runner";
import { useAttemptRunner } from "@/features/training-session/use-attempt-runner";
import { PitchRibbon } from "@/features/pitch-mirror/PitchRibbon";
import { continuousMidiToHz, noteLabel, signed } from "@/lib/music-display";
import type { HumMode } from "@/navigation";
import { useMusicalState } from "@/state/MusicalContext";
import { useUserPreferences } from "@/state/UserPreferencesContext";
import { useAppNavigation } from "@/routing/use-app-navigation";
import { saveAttempt } from "@/storage/database";
import { ActionButton, Eyebrow, Panel, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NotePlaybackToggle } from "@/ui/NotePlaybackToggle";
import { NoteInput } from "@/ui/voice";
import {
  humRibbonAnchorMidi,
  scoreHumTake,
  type HumResult,
  type HumShape,
  type HumTakeConfiguration,
} from "./hum-analysis";

const MODES: Record<HumMode, { label: string; headline: string; detail: string }> = {
  anchor: { label: "Find anchor", headline: "Find the note inside your natural hum.", detail: "Hum without aiming; finish when the trace contains the center you want measured." },
  match: { label: "Target match", headline: "Keep a target in memory.", detail: "Toggle the reference off when you are ready, then measure for as long as you choose." },
  glide: { label: "Glide", headline: "Slide the hum into the target lane.", detail: "The guide never accompanies you; the landing portion of your own trace is scored." },
  sustain: { label: "Long sustain", headline: "Keep the center while the breath moves.", detail: "Keep the trace live for as long as you want; finish only when you choose." },
};
const TRACE_WINDOW_SECONDS = 8;

const SHAPES: Record<HumShape, { symbol: string; label: string; cue: string }> = {
  m: { symbol: "M", label: "Lips together", cue: "A plain mmm. Let the jaw stay easy; placement is not graded." },
  n: { symbol: "N", label: "Tongue tip", cue: "Use an nnn gesture. Compare the mechanics without changing the intended pitch." },
  ng: { symbol: "NG", label: "Tongue back", cue: "Use the end of “sing.” Keep the target the same while the tract shape changes." },
};

const TOLERANCES = [
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

function statusText(status: AttemptRunnerStatus, inputState: string): string {
  if (status === "tracking") return "MEASURING LIVE HUM";
  if (status === "complete") return "TRACE COMPLETE";
  if (inputState === "running") return "READY TO MEASURE";
  return "USE ENABLE VOICE IN THE HEADER";
}

export function HumLab() {
  const {
    selectedMidi, setSelectedMidi, centsOffset, setCentsOffset, timbre, setTimbre,
  } = useMusicalState();
  const { toleranceCents, setToleranceCents } = useUserPreferences();
  const { route, navigate } = useAppNavigation();
  const mode = route.surface === "practice" && route.activity === "hum" ? route.mode : "anchor";
  const [shape, setShape] = useState<HumShape>("m");
  const [result, setResult] = useState<HumResult | null>(null);
  const [evidenceError, setEvidenceError] = useState("");
  const [saveError, setSaveError] = useState("");

  const completeAttempt = (completed: Readonly<CompletedAttempt<HumTakeConfiguration>>) => {
    const configuration = completed.configuration;
    const nextResult = scoreHumTake(completed);
    setResult(nextResult);
    if (!nextResult.metrics) {
      setEvidenceError("This trace contained fewer than three voiced observations. PCM still flowed; try another hum when ready.");
      return;
    }
    setEvidenceError("");
    if (nextResult.anchor) {
      setSelectedMidi(nextResult.anchor.nearestMidi);
      setCentsOffset(Math.round(nextResult.anchor.cents));
    }
    const completedAt = new Date().toISOString();
    const exerciseType = configuration.mode === "anchor"
      ? "hum.anchor.discover"
      : configuration.mode === "sustain" ? "hum.sustain.control" : "hum.target.match";
    return saveAttempt({
      id: crypto.randomUUID(),
      exerciseType,
      target: nextResult.anchor
        ? { discoveredMidi: nextResult.anchor.nearestMidi, centsOffset: nextResult.anchor.cents, humShape: configuration.shape }
        : { midi: configuration.midi, centsOffset: configuration.centsOffset, humShape: configuration.shape, variant: configuration.mode },
      metrics: { ...(nextResult.metrics as Record<string, number | undefined>), continuityRatio: nextResult.continuityRatio },
      pitchFrames: [...nextResult.frames],
      startedAt: completed.startedAt ?? completedAt,
      completedAt,
    });
  };
  const attempt = useAttemptRunner<HumTakeConfiguration>({
    scoringProfile: (configuration) => configuration.mode === "anchor" ? null : ({
      targetMidiFloat: configuration.midi + configuration.centsOffset / 100,
      toleranceCents: configuration.toleranceCents,
      minimumConfidence: 0.5,
      maximumVoicedGapSeconds: 0.24,
    }),
    onComplete: completeAttempt,
    onCompletionError: () => setSaveError("The measured hum trace could not be saved to local history."),
  });
  const input = useAudioInput({ onFrame: attempt.observe });
  const storedConfiguration = attempt.state.configuration;
  const attemptConfiguration = storedConfiguration?.mode === mode ? storedConfiguration : null;
  const workflowStatus = storedConfiguration !== null && attemptConfiguration === null
    ? "idle"
    : attempt.state.status;
  const activeMode = attemptConfiguration?.mode ?? mode;
  const activeShape = attemptConfiguration?.shape ?? shape;
  const activeMidi = attemptConfiguration?.midi ?? selectedMidi;
  const activeCentsOffset = attemptConfiguration?.centsOffset ?? centsOffset;
  const activeTimbre = attemptConfiguration?.timbre ?? timbre;
  const activeToleranceCents = attemptConfiguration?.toleranceCents ?? toleranceCents;
  const liveFrames = attemptRecentScoringFrames(attempt.state);
  const sessionFrames = attemptScoringFrames(attempt.state);
  const targetMidiFloat = activeMidi + activeCentsOffset / 100;
  const targetFrequency = continuousMidiToHz(activeMidi, activeCentsOffset);
  const targetPlayback = useSustainedNote({
    frequencyHz: targetFrequency,
    timbre: activeTimbre,
    amplitude: 0.22,
  });
  const anchorPreview = humRibbonAnchorMidi(sessionFrames);
  const ribbonTarget = activeMode === "anchor"
    ? result?.anchor?.midiFloat ?? anchorPreview ?? targetMidiFloat
    : targetMidiFloat;
  const ribbonFrames = result?.frames ?? liveFrames;
  const metrics = result?.metrics ?? null;
  const anchor = result?.anchor ?? null;
  const centered = Math.abs(metrics?.medianErrorCents ?? Number.POSITIVE_INFINITY) <= activeToleranceCents;
  const resetAttempt = attempt.reset;

  useEffect(() => {
    resetAttempt();
    setResult(null);
    setEvidenceError("");
    setSaveError("");
  }, [mode, resetAttempt]);

  const clearTake = () => {
    resetAttempt();
    setResult(null);
    setEvidenceError("");
    setSaveError("");
  };
  const begin = () => {
    clearTake();
    attempt.begin({ mode, shape, midi: selectedMidi, centsOffset, timbre, toleranceCents });
  };
  const noteInputTarget = activeMode === "anchor" ? undefined : targetMidiFloat;
  let orbLabel = "TARGET";
  let orbNote = noteLabel(activeMidi);
  let orbDetail = `${targetFrequency.toFixed(2)} Hz`;
  let metricsTitle = "Target anatomy";
  let primaryMetricLabel = "Attack";
  let primaryMetricValue = metrics?.attackErrorCents;
  let centerMetricLabel = "Pitch center";
  let centerMetricValue = metrics?.medianErrorCents;
  let centerMetricUnit = "¢";
  if (activeMode === "anchor") {
    orbLabel = "FOUND CENTER";
    orbNote = anchor ? noteLabel(anchor.nearestMidi) : "mmm";
    orbDetail = anchor
      ? `${signed(anchor.cents, 0)}¢ · ${anchor.frequencyHz.toFixed(1)} Hz`
      : "hum where you settle";
    metricsTitle = "Natural center";
    primaryMetricLabel = "Found center";
    primaryMetricValue = anchor?.cents;
    centerMetricLabel = "Frequency";
    centerMetricValue = anchor?.frequencyHz;
    centerMetricUnit = "Hz";
  } else if (activeMode === "glide") {
    metricsTitle = "Landing anatomy";
    primaryMetricLabel = "Landing center";
    primaryMetricValue = metrics?.medianErrorCents;
  }
  let guidanceTitle = "Begin whenever the hum is ready.";
  if (metrics && activeMode === "anchor") {
    const anchorLabel = anchor ? noteLabel(anchor.nearestMidi) : "a center";
    guidanceTitle = `Your hum settled near ${anchorLabel}.`;
  } else if (metrics) {
    guidanceTitle = centered
      ? "The hum center found the lane."
      : "The trace shows where the center settled.";
  }
  const beginLabel = input.state === "running" ? "Start trace" : "Enable voice in header";
  const modeOptions = (Object.entries(MODES) as [HumMode, (typeof MODES)[HumMode]][])
    .map(([value, item]) => ({ value, label: item.label }));
  const shapeOptions = Object.entries(SHAPES) as [HumShape, (typeof SHAPES)[HumShape]][];
  const chooseMode = (nextMode: HumMode) => navigate({ surface: "practice", activity: "hum", mode: nextMode });

  let currentStep: ReactNode;
  if (workflowStatus === "idle") {
    currentStep = (
      <div className="hum-workspace" data-workflow-step="idle">
        <Panel className="hum-config">
          <Segmented value={mode} onChange={chooseMode} options={modeOptions} label="Training primitive" />
          <div className="hum-config-fields">
            <Select label="Target" value={selectedMidi} disabled={mode === "anchor"} onChange={(event) => { clearTake(); setSelectedMidi(Number(event.target.value)); setCentsOffset(0); }}>{Array.from({ length: 36 }, (_, index) => 43 + index).map((midi) => <option value={midi} key={midi}>{noteLabel(midi)}</option>)}</Select>
            <Select label="Timbre" value={timbre} onChange={(event) => { clearTake(); setTimbre(event.target.value as typeof timbre); }}><option>sine</option><option>triangle</option><option>piano</option><option>guitar</option><option>bass</option><option>flute</option><option>voice</option><option>rich synth</option></Select>
            <Select label="Tolerance" value={toleranceCents} onChange={(event) => { clearTake(); setToleranceCents(Number(event.target.value)); }}>{TOLERANCES.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</Select>
            <button className="randomize-button" disabled={mode === "anchor"} onClick={() => { clearTake(); setSelectedMidi(45 + Math.floor(Math.random() * 28)); setCentsOffset(0); }}><Icon name="spark" size={16} /> Randomize</button>
          </div>
        </Panel>
        <Panel className="hum-shape-panel">
          <Eyebrow>Mechanics selector</Eyebrow><h2>Choose a hum gesture</h2><p>The detector measures the fundamental; placement is not graded.</p>
          <div className="hum-shapes">{shapeOptions.map(([value, item]) => <button key={value} className={shape === value ? "active" : ""} onClick={() => { clearTake(); setShape(value); }}><strong>{item.symbol}</strong><span>{item.label}</span></button>)}</div>
          <div className="shape-cue"><span>{SHAPES[shape].symbol}</span><p>{SHAPES[shape].cue}</p></div>
          <div className="stage-actions">
            <ActionButton className="primary attempt-button" disabled={input.state !== "running"} onClick={begin}><Icon name="hum" size={18} /> {beginLabel}</ActionButton>
          </div>
        </Panel>
      </div>
    );
  } else if (workflowStatus === "tracking") {
    currentStep = (
      <Panel className="hum-stage active" data-workflow-step="tracking" data-trace-lifetime="user-owned">
        <div className="hum-target-row">
          <div className="hum-orb sounding"><small>{orbLabel}</small><strong>{orbNote}</strong><span>{orbDetail}</span><i>m</i><i>m</i><i>m</i></div>
          <div className="hum-stage-copy"><span>{statusText(attempt.state.status, input.state)}</span><strong>{attempt.state.elapsedSeconds.toFixed(2)} s</strong><small>{SHAPES[activeShape].cue}</small></div>
        </div>
        <PitchRibbon frames={ribbonFrames} targetMidiFloat={ribbonTarget} toleranceCents={activeToleranceCents} windowSeconds={TRACE_WINDOW_SECONDS} />
        <div className="stage-actions">
          <ActionButton onClick={attempt.finish}>Finish trace</ActionButton>
        </div>
      </Panel>
    );
  } else {
    currentStep = (
      <div className="mirror-results-grid hum-results" data-workflow-step="complete">
        <Panel className="metrics-panel">
          <div className="panel-heading"><div><Eyebrow>Hum evidence</Eyebrow><h2>{metricsTitle}</h2></div><span className="attempt-badge">measured</span></div>
          <PitchRibbon frames={ribbonFrames} targetMidiFloat={ribbonTarget} toleranceCents={activeToleranceCents} windowSeconds={TRACE_WINDOW_SECONDS} />
          <div className="metrics-grid">
            <Metric label={primaryMetricLabel} value={primaryMetricValue} unit="¢" tone="coral" />
            <Metric label={centerMetricLabel} value={centerMetricValue} unit={centerMetricUnit} tone="lime" />
            <Metric label="Continuity" value={result == null ? undefined : result.continuityRatio * 100} unit="%" tone="blue" />
            <Metric label="In lane" value={metrics?.inToleranceRatio == null ? undefined : metrics.inToleranceRatio * 100} unit="%" />
            <Metric label="Stability" value={metrics?.vibratoAdjustedStabilityCents ?? metrics?.stabilityCents} unit="¢" />
            <Metric label="Drift" value={metrics?.driftCentsPerSecond} unit="¢/s" />
            <Metric label="Longest hold" value={metrics?.holdDurationMs == null ? undefined : metrics.holdDurationMs / 1_000} unit="s" />
            <Metric label="Confidence" value={metrics?.detectorConfidence == null ? undefined : metrics.detectorConfidence * 100} unit="%" />
          </div>
        </Panel>
        <Panel className="guidance-panel hum-guidance">
          <Eyebrow>Interpret the trace</Eyebrow><h2>{guidanceTitle}</h2>
          <p>Center, continuity, and drift are independent mathematics over the same live observations. No prompt or silence can restart capture.</p>
          <ActionButton className="wide" onClick={clearTake}>Measure another hum</ActionButton>
        </Panel>
      </div>
    );
  }

  return (
    <div className="page hum-lab-page">
      <div className="lab-intro mirror-intro">
        <div><Eyebrow>Continuous hum evidence</Eyebrow><h1>{MODES[mode].headline}</h1><p>{MODES[mode].detail} Quiet input remains part of the trace and never changes microphone state.</p></div>
      </div>

      {saveError && <div className="error-banner"><strong>Local history needs attention.</strong><span>{saveError}</span></div>}
      {evidenceError && <div className="error-banner"><strong>No voiced center in this trace.</strong><span>{evidenceError}</span></div>}

      <NoteInput variant="scope" input={input} title="Hum input scope" targetMidiFloat={noteInputTarget} toleranceCents={activeToleranceCents} />
      {(activeMode !== "anchor" || targetPlayback.playing) && <div className="practice-reference-control"><NotePlaybackToggle playback={targetPlayback} label={noteLabel(activeMidi)} /></div>}
      <section className="practice-current-step">{currentStep}</section>
    </div>
  );
}
