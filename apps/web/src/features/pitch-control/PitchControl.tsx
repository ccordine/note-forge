import { useEffect, useState, type ReactNode } from "react";
import "../../styles-pitch-control.css";
import { useAudioInput } from "@/audio/use-audio-input";
import { useSustainedNote } from "@/audio/use-sustained-note";
import {
  attemptRecentScoringFrames,
  attemptScoringFrames,
  type CompletedAttempt,
} from "@/features/training-session/attempt-runner";
import { useAttemptRunner } from "@/features/training-session/use-attempt-runner";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import type { ControlMode } from "@/navigation";
import { useMusicalState } from "@/state/MusicalContext";
import { useUserPreferences } from "@/state/UserPreferencesContext";
import { useAppNavigation } from "@/routing/use-app-navigation";
import { saveAttempt } from "@/storage/database";
import { ActionButton, Eyebrow, Panel, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NotePlaybackToggle } from "@/ui/NotePlaybackToggle";
import { NoteInput } from "@/ui/voice";
import { PitchRibbon } from "@/features/pitch-mirror/PitchRibbon";
import {
  ENVELOPE_CYCLE_SECONDS,
  TRACE_WINDOW_SECONDS,
  envelopes,
  interpolateEnvelope,
  pitchControlEnvelopeDisplayLevels,
  scoreControlTake,
  type ControlResult,
  type ControlTakeConfiguration,
} from "./pitch-control-model";

export function PitchControl() {
  const { selectedMidi, setSelectedMidi, centsOffset, timbre } = useMusicalState();
  const { toleranceCents } = useUserPreferences();
  const { route, navigate } = useAppNavigation();
  const envelopeType = route.surface === "practice" && route.activity === "pitch-control" ? route.mode : "diamond";
  const [vowel, setVowel] = useState("oo");
  const [result, setResult] = useState<ControlResult | null>(null);
  const [saveError, setSaveError] = useState("");

  const completeAttempt = (completed: Readonly<CompletedAttempt<ControlTakeConfiguration>>) => {
    const configuration = completed.configuration;
    const nextResult = scoreControlTake(completed, toleranceCents);
    setResult(nextResult);
    const frames = attemptScoringFrames(completed);
    const completedAt = new Date().toISOString();
    return saveAttempt({
      id: crypto.randomUUID(),
      exerciseType: `pitch.control.${configuration.envelopeType}`,
      target: { midi: configuration.midi, centsOffset: configuration.centsOffset },
      metrics: { ...(nextResult.metrics as Record<string, number | undefined>), volumeScore: nextResult.volumeScore },
      pitchFrames: [...frames],
      startedAt: completed.startedAt ?? completedAt,
      completedAt,
    });
  };
  const attempt = useAttemptRunner<ControlTakeConfiguration>({
    scoringProfile: (configuration) => ({
      targetMidiFloat: configuration.midi + configuration.centsOffset / 100,
      envelopeCycleSeconds: configuration.cyclePeriodSeconds,
    }),
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
  const activeCyclePeriodSeconds = attemptConfiguration?.cyclePeriodSeconds ?? ENVELOPE_CYCLE_SECONDS;
  const referencePlayback = useSustainedNote({
    frequencyHz: continuousMidiToHz(activeMidi, activeCentsOffset),
    timbre: activeTimbre,
    amplitude: 0.22,
  });
  const envelope = envelopes[activeEnvelopeType];
  const frames = attemptRecentScoringFrames(attempt.state);
  const displayStartSeconds = Math.max(0, attempt.state.elapsedSeconds - TRACE_WINDOW_SECONDS);
  const displayFrames = frames.filter((frame) => frame.timeSeconds >= displayStartSeconds);
  const displayRmsLevels = pitchControlEnvelopeDisplayLevels(displayFrames);
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
    attempt.begin({
      envelopeType,
      vowel,
      midi: selectedMidi,
      centsOffset,
      timbre,
      cyclePeriodSeconds: ENVELOPE_CYCLE_SECONDS,
    });
  };
  const medianCenter = result?.metrics.medianErrorCents == null
    ? "—"
    : `${result.metrics.medianErrorCents > 0 ? "+" : ""}${result.metrics.medianErrorCents.toFixed(1)}¢`;
  const targetMidiFloat = activeMidi + activeCentsOffset / 100;
  const cycleProgress = (attempt.state.elapsedSeconds % activeCyclePeriodSeconds)
    / activeCyclePeriodSeconds;
  const currentTargetLevel = interpolateEnvelope(envelope.points, cycleProgress);
  let dynamicCue = "LOUD";
  if (currentTargetLevel < 0.3) dynamicCue = "QUIET";
  else if (currentTargetLevel < 0.7) dynamicCue = "MEDIUM";
  const beginLabel = input.state === "running" ? "Start trace" : "Enable voice in header";
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
        </div>
        <div className="envelope-header"><div><span>MISSION · {vowel.toUpperCase()}</span><h2>{envelopes[envelopeType].cue}</h2></div><div className="envelope-target"><small>PITCH CENTER</small><strong>{noteLabel(selectedMidi)}</strong><span>±{toleranceCents}¢</span></div></div>
        <div className="stage-actions">
          <ActionButton className="primary" disabled={input.state !== "running"} onClick={begin}><Icon name="mic" size={18} /> {beginLabel}</ActionButton>
        </div>
      </Panel>
    );
  } else if (workflowStatus === "tracking") {
    currentStep = (
      <Panel className="envelope-stage active" data-workflow-step="tracking" data-trace-lifetime="user-owned">
        <div className="envelope-header"><div><span>MISSION · {activeVowel.toUpperCase()}</span><h2>{envelope.cue}</h2></div><div className="envelope-target"><small>PITCH CENTER</small><strong>{noteLabel(activeMidi)}</strong><span>±{toleranceCents}¢</span></div></div>
        <div className="envelope-visual">
          <svg viewBox="0 0 1000 220" preserveAspectRatio="none" aria-label="Target volume envelope">
            <defs><linearGradient id="envelope-fill" x1="0" x2="1"><stop stopColor="#63d7ff" stopOpacity=".05" /><stop offset=".5" stopColor="#d8ff3e" stopOpacity=".3" /><stop offset="1" stopColor="#ff6b45" stopOpacity=".08" /></linearGradient></defs>
            {[0, 1, 2, 3, 4].map((row) => <line key={row} x1="0" x2="1000" y1={20 + row * 45} y2={20 + row * 45} />)}
            <path className="target-envelope-area" d={`M 0 205 ${envelope.points.map((point, index) => `L ${(index / (envelope.points.length - 1)) * 1000} ${205 - point * 170}`).join(" ")} L 1000 205 Z`} />
            <path className="target-envelope-line" d={envelope.points.map((point, index) => `${index ? "L" : "M"} ${(index / (envelope.points.length - 1)) * 1000} ${205 - point * 170}`).join(" ")} />
            <line className="playhead" x1={cycleProgress * 1000} x2={cycleProgress * 1000} y1="0" y2="220" />
            {displayRmsLevels.length > 1 && <path className="actual-envelope-line" d={displayRmsLevels.map((point, index) => `${index ? "L" : "M"} ${(index / (displayRmsLevels.length - 1)) * 1000} ${205 - point * 170}`).join(" ")} />}
          </svg>
          <div className="dynamic-readout"><span>{activeCyclePeriodSeconds}s target loop · trace stays live</span><b style={{ transform: `scale(${0.8 + currentTargetLevel * 0.4})` }}>{dynamicCue}</b></div>
          <div className="envelope-axis"><span>quiet</span><span>VOLUME · dBFS</span><span>loud</span></div>
        </div>
        <PitchRibbon frames={displayFrames} targetMidiFloat={targetMidiFloat} toleranceCents={toleranceCents} windowSeconds={TRACE_WINDOW_SECONDS} envelope={displayRmsLevels} />
        <div className="stage-actions"><ActionButton onClick={attempt.finish}>Finish trace</ActionButton></div>
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
        <div><Eyebrow>Continuous pitch + level evidence</Eyebrow><h1>Move the energy. Keep the center.</h1><p>The target gesture repeats without ending the trace. Start whenever you are ready and finish only when you choose.</p></div>
      </div>

      {saveError && <div className="error-banner"><strong>Local history needs attention.</strong><span>{saveError}</span></div>}

      <NoteInput variant="scope" input={input} targetMidiFloat={targetMidiFloat} toleranceCents={toleranceCents} title="Pitch and level monitor" />
      <div className="practice-reference-control"><NotePlaybackToggle playback={referencePlayback} label={noteLabel(activeMidi)} /></div>
      <section className="practice-current-step">{currentStep}</section>
    </div>
  );
}
