import { useEffect, useMemo, useRef, useState } from "react";
import { smoothPitchFrames, type PitchFrame } from "@noteforge/pitch-engine";
import { scoreSustainedNote, type AttemptMetrics } from "@noteforge/trainer-core";
import { useAudioInput } from "@/audio/use-audio-input";
import { playSafely, playTone, type ActiveVoice, type Timbre } from "@/audio/synth";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import { useLab } from "@/state/LabContext";
import { saveAttempt } from "@/storage/database";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { PitchRibbon } from "@/features/pitch-mirror/PitchRibbon";

type EnvelopeType = "free" | "steady" | "crescendo" | "decrescendo" | "diamond" | "pulses";

interface ControlAttemptConfiguration {
  envelopeType: EnvelopeType;
  midi: number;
  centsOffset: number;
  timbre: Timbre;
  toleranceCents: number;
  duration: number;
}

const envelopes: Record<EnvelopeType, { label: string; points: number[]; cue: string }> = {
  free: { label: "Free volume", points: [0.5, 0.5], cue: "Hold pitch; shape volume however you choose." },
  steady: { label: "Steady", points: [0.48, 0.48], cue: "One pitch. One volume. No drift." },
  crescendo: { label: "Crescendo", points: [0.12, 0.2, 0.38, 0.62, 0.92], cue: "Grow without lifting the fundamental." },
  decrescendo: { label: "Decrescendo", points: [0.92, 0.68, 0.42, 0.22, 0.12], cue: "Release energy without letting pitch sag." },
  diamond: { label: "Quiet → loud → quiet", points: [0.12, 0.32, 0.78, 0.96, 0.78, 0.32, 0.12], cue: "Open and close the dynamic arc around one center." },
  pulses: { label: "Pulses", points: [0.18, 0.82, 0.18, 0.82, 0.18, 0.82, 0.18], cue: "Change energy in clean steps while pitch stays put." }
};

const NUMERICAL_SILENCE_RMS = 1e-6;

function interpolateEnvelope(points: readonly number[], progress: number): number {
  const position = Math.max(0, Math.min(1, progress)) * (points.length - 1);
  const index = Math.floor(position);
  const fraction = position - index;
  return points[index] * (1 - fraction) + (points[Math.min(index + 1, points.length - 1)] ?? points[index]) * fraction;
}

function scoreEnvelope(
  frames: readonly PitchFrame[],
  points: readonly number[],
  start: number,
  duration: number,
  rmsThreshold: number
): number | undefined {
  const data = frames.filter((frame) => (
    frame.timeSeconds >= start
    && frame.timeSeconds <= start + duration
    && Number.isFinite(frame.rms)
    && frame.rms >= rmsThreshold
  ));
  if (data.length < 4) return undefined;
  const levels = data.map((frame) => frame.rms);
  const min = Math.min(...levels);
  const max = Math.max(...levels);
  if (max - min < 1e-5) return points.every((point) => Math.abs(point - points[0]) < 0.05) ? 100 : 0;
  const error = data.reduce((sum, frame) => {
    const actual = (frame.rms - min) / (max - min);
    const target = interpolateEnvelope(points, (frame.timeSeconds - start) / duration);
    return sum + Math.abs(actual - target);
  }, 0) / data.length;
  return Math.max(0, (1 - error) * 100);
}

export function PitchControl() {
  const { selectedMidi, setSelectedMidi, centsOffset, timbre, toleranceCents } = useLab();
  const [envelopeType, setEnvelopeType] = useState<EnvelopeType>("diamond");
  const [vowel, setVowel] = useState("oo");
  const [duration, setDuration] = useState(8);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [frames, setFrames] = useState<PitchFrame[]>([]);
  const [metrics, setMetrics] = useState<AttemptMetrics | null>(null);
  const [volumeScore, setVolumeScore] = useState<number>();
  const [saveError, setSaveError] = useState("");
  const [attemptError, setAttemptError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const recording = useRef<PitchFrame[]>([]);
  const startTime = useRef(0);
  const displayStartTime = useRef(0);
  const recordingActive = useRef(false);
  const runningRef = useRef(false);
  const startInFlightRef = useRef(false);
  const attemptGenerationRef = useRef(0);
  const attemptConfigurationRef = useRef<ControlAttemptConfiguration | null>(null);
  const attemptMountedRef = useRef(false);
  const promptVoiceRef = useRef<ActiveVoice | null>(null);
  const finishTimer = useRef<number | undefined>(undefined);
  const startTimer = useRef<number | undefined>(undefined);
  const animation = useRef<number | undefined>(undefined);
  const envelope = envelopes[envelopeType];
  const input = useAudioInput({
    onFrame: (frame) => {
      setFrames((current) => [...current.slice(-200), frame]);
      if (recordingActive.current) {
        if (startTime.current === 0) startTime.current = frame.timeSeconds;
        recording.current.push(frame);
      }
    }
  });
  const micRunning = input.state === "running";

  useEffect(() => {
    attemptMountedRef.current = true;
    return () => {
      attemptMountedRef.current = false;
      attemptGenerationRef.current += 1;
      startInFlightRef.current = false;
      runningRef.current = false;
      recordingActive.current = false;
      attemptConfigurationRef.current = null;
      if (finishTimer.current) window.clearTimeout(finishTimer.current);
      if (startTimer.current) window.clearTimeout(startTimer.current);
      if (animation.current) cancelAnimationFrame(animation.current);
      promptVoiceRef.current?.stop(0.02);
      promptVoiceRef.current = null;
    };
  }, []);

  const finish = () => {
    if (!runningRef.current) return;
    runningRef.current = false;
    recordingActive.current = false;
    if (startTimer.current !== undefined) window.clearTimeout(startTimer.current);
    if (finishTimer.current !== undefined) window.clearTimeout(finishTimer.current);
    if (animation.current !== undefined) cancelAnimationFrame(animation.current);
    startTimer.current = undefined;
    finishTimer.current = undefined;
    animation.current = undefined;
    promptVoiceRef.current?.stop(0.04);
    promptVoiceRef.current = null;
    const configuration = attemptConfigurationRef.current;
    attemptConfigurationRef.current = null;
    if (!configuration) {
      setRunning(false);
      setElapsed(0);
      return;
    }
    if (!startTime.current) {
      setRunning(false);
      setElapsed(0);
      return;
    }
    const smooth = smoothPitchFrames(recording.current);
    const result = scoreSustainedNote(smooth, { midi: configuration.midi, centsOffset: configuration.centsOffset, durationMs: configuration.duration * 1000, timbre: configuration.timbre, amplitude: 0.25 }, { toleranceCents: configuration.toleranceCents, promptTimeSeconds: startTime.current });
    setFrames(smooth);
    setMetrics(result);
    const nextVolumeScore = scoreEnvelope(smooth, envelopes[configuration.envelopeType].points, startTime.current, configuration.duration, NUMERICAL_SILENCE_RMS);
    setVolumeScore(nextVolumeScore);
    const completedAt = new Date();
    void saveAttempt({
      id: crypto.randomUUID(),
      exerciseType: `pitch.control.${configuration.envelopeType}`,
      target: { midi: configuration.midi, centsOffset: configuration.centsOffset, durationSeconds: configuration.duration },
      metrics: { ...(result as Record<string, number | undefined>), volumeScore: nextVolumeScore },
      pitchFrames: smooth,
      startedAt: new Date(completedAt.getTime() - configuration.duration * 1_000).toISOString(),
      completedAt: completedAt.toISOString(),
    }).catch(() => setSaveError("The controlled-hold attempt could not be saved to local history."));
    startTime.current = 0;
    displayStartTime.current = 0;
    setRunning(false);
    setElapsed(configuration.duration);
  };

  const start = async () => {
    if (runningRef.current || startInFlightRef.current) return;
    const generation = ++attemptGenerationRef.current;
    const configuration: ControlAttemptConfiguration = { envelopeType, midi: selectedMidi, centsOffset, timbre, toleranceCents, duration };
    startInFlightRef.current = true;
    promptVoiceRef.current?.stop(0.03);
    promptVoiceRef.current = null;
    setStarting(true);
    setAttemptError("");
    // A retained MediaStream can outlive a suspended AudioContext. Always pass
    // through the shared start/resume path before beginning an attempt.
    let microphone: Awaited<ReturnType<typeof input.enable>>;
    try {
      microphone = await input.enable();
    } catch {
      if (!attemptMountedRef.current || generation !== attemptGenerationRef.current) return;
      startInFlightRef.current = false;
      setStarting(false);
      setAttemptError("The microphone could not start. No controlled hold began.");
      return;
    }
    if (!attemptMountedRef.current || generation !== attemptGenerationRef.current) return;
    if (!microphone) {
      startInFlightRef.current = false;
      setStarting(false);
      setAttemptError(input.error || "The microphone could not start. No controlled hold began.");
      return;
    }
    let promptVoice: ActiveVoice;
    try {
      promptVoice = await playTone({
        frequencyHz: continuousMidiToHz(configuration.midi, configuration.centsOffset),
        timbre: configuration.timbre,
        duration: 1.1,
        amplitude: 0.18,
      });
    } catch {
      if (!attemptMountedRef.current || generation !== attemptGenerationRef.current) return;
      startInFlightRef.current = false;
      runningRef.current = false;
      recordingActive.current = false;
      attemptConfigurationRef.current = null;
      setStarting(false);
      setRunning(false);
      setElapsed(0);
      setAttemptError("The required reference pitch could not start. The hold stayed ready and no microphone frames were scored.");
      return;
    }
    if (!attemptMountedRef.current || generation !== attemptGenerationRef.current) {
      promptVoice.stop(0.02);
      return;
    }
    promptVoiceRef.current = promptVoice;
    startInFlightRef.current = false;
    setStarting(false);
    attemptConfigurationRef.current = configuration;
    setSaveError("");
    runningRef.current = true;
    recording.current = [];
    setFrames([]);
    setMetrics(null);
    setVolumeScore(undefined);
    setElapsed(0);
    setRunning(true);
    const animate = () => {
      if (
        !attemptMountedRef.current
        || generation !== attemptGenerationRef.current
        || !recordingActive.current
      ) return;
      setElapsed(Math.max(0, Math.min(configuration.duration, performance.now() / 1000 - displayStartTime.current)));
      animation.current = requestAnimationFrame(animate);
    };
    startTime.current = 0;
    recordingActive.current = false;
    startTimer.current = window.setTimeout(() => {
      if (
        !attemptMountedRef.current
        || generation !== attemptGenerationRef.current
        || !runningRef.current
      ) return;
      setFrames([]);
      recordingActive.current = true;
      displayStartTime.current = performance.now() / 1000;
      animation.current = requestAnimationFrame(animate);
    }, 1_250);
    finishTimer.current = window.setTimeout(() => {
      if (attemptMountedRef.current && generation === attemptGenerationRef.current) finish();
    }, (configuration.duration + 1.4) * 1000);
  };

  const controlsLocked = running || starting;

  const normalizedRms = useMemo(() => {
    const values = frames.map((frame) => frame.rms);
    const max = Math.max(...values, 0.001);
    return values.map((value) => value / max);
  }, [frames]);
  const currentTargetLevel = interpolateEnvelope(envelope.points, elapsed / duration);
  const ribbonFrames = frames;

  return (
    <div className="page control-page">
      <div className="lab-intro">
        <div><Eyebrow>Decouple the controls</Eyebrow><h1>Move the energy. Keep the center.</h1><p>Pitch and loudness are scored as independent dimensions. A crescendo is not an invitation to go sharp.</p></div>
      </div>

      {saveError && <div className="error-banner"><strong>Local history needs attention.</strong><span>{saveError}</span></div>}
      {attemptError && <div className="error-banner" role="alert"><strong>Controlled hold did not start.</strong><span>{attemptError}</span></div>}

      <Panel className="control-config">
        <div className="control-config-main">
          <Segmented value={envelopeType} disabled={controlsLocked} onChange={setEnvelopeType} options={(Object.entries(envelopes) as [EnvelopeType, (typeof envelopes)[EnvelopeType]][]).map(([value, item]) => ({ value, label: item.label }))} />
        </div>
        <div className="control-config-fields">
          <Select label="Target" value={selectedMidi} disabled={controlsLocked} onChange={(event) => setSelectedMidi(Number(event.target.value))}>{Array.from({ length: 30 }, (_, index) => 45 + index).map((midi) => <option key={midi} value={midi}>{noteLabel(midi)}</option>)}</Select>
          <Select label="Gesture" value={vowel} disabled={controlsLocked} onChange={(event) => setVowel(event.target.value)}><option value="hum">Hum</option><option value="oo">Oo</option><option value="oh">Oh</option><option value="ah">Ah</option><option value="ee">Ee</option></Select>
          <Select label="Duration" value={duration} disabled={controlsLocked} onChange={(event) => setDuration(Number(event.target.value))}><option value="5">5 seconds</option><option value="8">8 seconds</option><option value="12">12 seconds</option></Select>
        </div>
      </Panel>

      <NoteInput
        variant="scope"
        input={input}
        targetMidiFloat={selectedMidi + centsOffset / 100}
        toleranceCents={toleranceCents}
        title="Pitch and level monitor"
      />

      <Panel className={`envelope-stage ${running ? "active" : ""}`}>
        <div className="envelope-header"><div><span>MISSION · {vowel.toUpperCase()}</span><h2>{envelope.cue}</h2></div><div className="envelope-target"><small>PITCH CENTER</small><strong>{noteLabel(selectedMidi)}</strong><span>±{toleranceCents}¢</span></div></div>
        <div className="envelope-visual">
          <svg viewBox="0 0 1000 220" preserveAspectRatio="none" aria-label="Target volume envelope">
            <defs><linearGradient id="envelope-fill" x1="0" x2="1"><stop stopColor="#63d7ff" stopOpacity=".05" /><stop offset=".5" stopColor="#d8ff3e" stopOpacity=".3" /><stop offset="1" stopColor="#ff6b45" stopOpacity=".08" /></linearGradient></defs>
            {[0, 1, 2, 3, 4].map((row) => <line key={row} x1="0" x2="1000" y1={20 + row * 45} y2={20 + row * 45} />)}
            <path className="target-envelope-area" d={`M 0 205 ${envelope.points.map((point, index) => `L ${(index / (envelope.points.length - 1)) * 1000} ${205 - point * 170}`).join(" ")} L 1000 205 Z`} />
            <path className="target-envelope-line" d={envelope.points.map((point, index) => `${index ? "L" : "M"} ${(index / (envelope.points.length - 1)) * 1000} ${205 - point * 170}`).join(" ")} />
            {running && <line className="playhead" x1={(elapsed / duration) * 1000} x2={(elapsed / duration) * 1000} y1="0" y2="220" />}
            {normalizedRms.length > 1 && <path className="actual-envelope-line" d={normalizedRms.map((point, index) => `${index ? "L" : "M"} ${(index / (normalizedRms.length - 1)) * 1000} ${205 - point * 170}`).join(" ")} />}
          </svg>
          <div className="dynamic-readout"><span>FOLLOW</span><b style={{ transform: `scale(${0.8 + currentTargetLevel * 0.4})` }}>{currentTargetLevel < .3 ? "QUIET" : currentTargetLevel < .7 ? "MEDIUM" : "LOUD"}</b></div>
          <div className="envelope-axis"><span>quiet</span><span>VOLUME · RMS</span><span>loud</span></div>
        </div>
        <PitchRibbon frames={ribbonFrames} targetMidiFloat={selectedMidi + centsOffset / 100} toleranceCents={toleranceCents} durationSeconds={duration} envelope={normalizedRms} />
        <div className="stage-actions"><PlayButton label="Reference pitch" disabled={controlsLocked} onClick={() => playSafely(playTone({ frequencyHz: continuousMidiToHz(selectedMidi, centsOffset), timbre, duration: 1.15 }), "Pitch Control reference tone")} /><ActionButton className="primary" onClick={start} disabled={controlsLocked || input.state === "opening"}><Icon name="mic" size={18} /> {running ? `${Math.max(0, duration - elapsed).toFixed(1)}s` : starting || input.state === "opening" ? "Connecting…" : micRunning ? "Begin controlled hold" : "Enable mic to begin"}</ActionButton>{running && <ActionButton onClick={finish}>Finish</ActionButton>}</div>
      </Panel>

      <div className="split-score">
        <Panel className="dimension-score pitch"><Eyebrow>Dimension 01</Eyebrow><div className="dimension-title"><span className="dimension-icon">∿</span><div><h2>Pitch control</h2><p>Center, stability, and drift</p></div><strong>{metrics?.inToleranceRatio == null ? "—" : `${(metrics.inToleranceRatio * 100).toFixed(0)}%`}</strong></div><dl><div><dt>Median center</dt><dd>{metrics?.medianErrorCents == null ? "—" : `${metrics.medianErrorCents > 0 ? "+" : ""}${metrics.medianErrorCents.toFixed(1)}¢`}</dd></div><div><dt>Stability</dt><dd>{metrics?.stabilityCents == null ? "—" : `${metrics.stabilityCents.toFixed(1)}¢`}</dd></div><div><dt>Drift</dt><dd>{metrics?.driftCentsPerSecond == null ? "—" : `${metrics.driftCentsPerSecond.toFixed(1)}¢/s`}</dd></div></dl></Panel>
        <Panel className="dimension-score volume"><Eyebrow>Dimension 02</Eyebrow><div className="dimension-title"><span className="dimension-icon">◢</span><div><h2>Dynamic control</h2><p>Envelope shape, separate from pitch</p></div><strong>{volumeScore == null ? "—" : `${volumeScore.toFixed(0)}%`}</strong></div><dl><div><dt>Shape match</dt><dd>{volumeScore == null ? "—" : `${volumeScore.toFixed(1)}%`}</dd></div><div><dt>Dynamic range</dt><dd>{metrics?.volume?.dynamicRangeDb == null ? "—" : `${metrics.volume.dynamicRangeDb.toFixed(1)} dB`}</dd></div><div><dt>Peak RMS</dt><dd>{metrics?.volume?.maximumRms == null ? "—" : metrics.volume.maximumRms.toFixed(3)}</dd></div></dl></Panel>
      </div>
    </div>
  );
}
