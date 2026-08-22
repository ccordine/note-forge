import { useEffect, useMemo, useRef, useState } from "react";
import { detectPitch, smoothPitchFrames, type PitchFrame } from "@noteforge/pitch-engine";
import { scoreSustainedNote, type AttemptMetrics } from "@noteforge/trainer-core";
import { MicrophoneCapture } from "@/audio/microphone";
import { playTone } from "@/audio/synth";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import { useLab } from "@/state/LabContext";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { PitchRibbon } from "@/features/pitch-mirror/PitchRibbon";

type EnvelopeType = "free" | "steady" | "crescendo" | "decrescendo" | "diamond" | "pulses";

const envelopes: Record<EnvelopeType, { label: string; points: number[]; cue: string }> = {
  free: { label: "Free volume", points: [0.5, 0.5], cue: "Hold pitch; shape volume however you choose." },
  steady: { label: "Steady", points: [0.48, 0.48], cue: "One pitch. One volume. No drift." },
  crescendo: { label: "Crescendo", points: [0.12, 0.2, 0.38, 0.62, 0.92], cue: "Grow without lifting the fundamental." },
  decrescendo: { label: "Decrescendo", points: [0.92, 0.68, 0.42, 0.22, 0.12], cue: "Release energy without letting pitch sag." },
  diamond: { label: "Quiet → loud → quiet", points: [0.12, 0.32, 0.78, 0.96, 0.78, 0.32, 0.12], cue: "Open and close the dynamic arc around one center." },
  pulses: { label: "Pulses", points: [0.18, 0.82, 0.18, 0.82, 0.18, 0.82, 0.18], cue: "Change energy in clean steps while pitch stays put." }
};

function interpolateEnvelope(points: readonly number[], progress: number): number {
  const position = Math.max(0, Math.min(1, progress)) * (points.length - 1);
  const index = Math.floor(position);
  const fraction = position - index;
  return points[index] * (1 - fraction) + (points[Math.min(index + 1, points.length - 1)] ?? points[index]) * fraction;
}

function scoreEnvelope(frames: readonly PitchFrame[], points: readonly number[], start: number, duration: number): number | undefined {
  const data = frames.filter((frame) => frame.timeSeconds >= start && frame.timeSeconds <= start + duration && Number.isFinite(frame.rms));
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
  const [micReady, setMicReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [frames, setFrames] = useState<PitchFrame[]>([]);
  const [metrics, setMetrics] = useState<AttemptMetrics | null>(null);
  const [volumeScore, setVolumeScore] = useState<number>();
  const [elapsed, setElapsed] = useState(0);
  const capture = useRef(new MicrophoneCapture());
  const recording = useRef<PitchFrame[]>([]);
  const startTime = useRef(0);
  const displayStartTime = useRef(0);
  const recordingActive = useRef(false);
  const finishTimer = useRef<number | undefined>(undefined);
  const startTimer = useRef<number | undefined>(undefined);
  const animation = useRef<number | undefined>(undefined);
  const envelope = envelopes[envelopeType];

  useEffect(() => () => {
    capture.current.stop();
    if (finishTimer.current) window.clearTimeout(finishTimer.current);
    if (startTimer.current) window.clearTimeout(startTimer.current);
    if (animation.current) cancelAnimationFrame(animation.current);
  }, []);

  const enableMic = async () => {
    try {
      await capture.current.start(({ samples, capturedAt, sampleRate }) => {
        const frame = detectPitch(samples, { sampleRate, minFrequency: 65, maxFrequency: 1_100, rmsThreshold: 0.004, minConfidence: 0.7, timeSeconds: capturedAt });
        setFrames((current) => [...current.slice(-200), frame]);
        if (recordingActive.current) {
          if (startTime.current === 0) startTime.current = frame.timeSeconds;
          recording.current.push(frame);
        }
      });
      setMicReady(true);
    } catch { setMicReady(false); }
  };

  const finish = () => {
    recordingActive.current = false;
    if (startTimer.current) window.clearTimeout(startTimer.current);
    if (!startTime.current) {
      setRunning(false);
      setElapsed(0);
      return;
    }
    const smooth = smoothPitchFrames(recording.current);
    const result = scoreSustainedNote(smooth, { midi: selectedMidi, centsOffset, durationMs: duration * 1000, timbre, amplitude: 0.25 }, { toleranceCents, promptTimeSeconds: startTime.current });
    setFrames(smooth);
    setMetrics(result);
    setVolumeScore(scoreEnvelope(smooth, envelope.points, startTime.current, duration));
    startTime.current = 0;
    displayStartTime.current = 0;
    setRunning(false);
    setElapsed(duration);
  };

  const start = async () => {
    if (!micReady) { await enableMic(); return; }
    recording.current = [];
    setFrames([]);
    setMetrics(null);
    setVolumeScore(undefined);
    setElapsed(0);
    setRunning(true);
    void playTone({ frequencyHz: continuousMidiToHz(selectedMidi, centsOffset), timbre, duration: 1.1, amplitude: 0.18 });
    const animate = () => {
      if (!recordingActive.current) return;
      setElapsed(Math.max(0, Math.min(duration, performance.now() / 1000 - displayStartTime.current)));
      animation.current = requestAnimationFrame(animate);
    };
    startTime.current = 0;
    recordingActive.current = false;
    startTimer.current = window.setTimeout(() => {
      recordingActive.current = true;
      displayStartTime.current = performance.now() / 1000;
      animation.current = requestAnimationFrame(animate);
    }, 1_250);
    finishTimer.current = window.setTimeout(finish, (duration + 1.4) * 1000);
  };

  const normalizedRms = useMemo(() => {
    const values = frames.map((frame) => frame.rms);
    const max = Math.max(...values, 0.001);
    return values.map((value) => value / max);
  }, [frames]);
  const currentTargetLevel = interpolateEnvelope(envelope.points, elapsed / duration);

  return (
    <div className="page control-page">
      <div className="lab-intro">
        <div><Eyebrow>Decouple the controls</Eyebrow><h1>Move the energy. Keep the center.</h1><p>Pitch and loudness are scored as independent dimensions. A crescendo is not an invitation to go sharp.</p></div>
        <div className={`mic-pill ${micReady ? "ready" : "off"}`}><span className="mic-pulse"><Icon name="mic" size={18} /></span><div><small>MICROPHONE</small><b>{micReady ? "Listening locally" : "Not connected"}</b></div><button onClick={enableMic}>{micReady ? "Ready" : "Enable"}</button></div>
      </div>

      <Panel className="control-config">
        <div className="control-config-main">
          <Segmented value={envelopeType} onChange={setEnvelopeType} options={(Object.entries(envelopes) as [EnvelopeType, (typeof envelopes)[EnvelopeType]][]).map(([value, item]) => ({ value, label: item.label }))} />
        </div>
        <div className="control-config-fields">
          <Select label="Target" value={selectedMidi} onChange={(event) => setSelectedMidi(Number(event.target.value))}>{Array.from({ length: 30 }, (_, index) => 45 + index).map((midi) => <option key={midi} value={midi}>{noteLabel(midi)}</option>)}</Select>
          <Select label="Gesture" value={vowel} onChange={(event) => setVowel(event.target.value)}><option value="hum">Hum</option><option value="oo">Oo</option><option value="oh">Oh</option><option value="ah">Ah</option><option value="ee">Ee</option></Select>
          <Select label="Duration" value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value="5">5 seconds</option><option value="8">8 seconds</option><option value="12">12 seconds</option></Select>
        </div>
      </Panel>

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
        <PitchRibbon frames={frames} targetMidiFloat={selectedMidi + centsOffset / 100} toleranceCents={toleranceCents} durationSeconds={duration} envelope={normalizedRms} />
        <div className="stage-actions"><PlayButton label="Reference pitch" onClick={() => playTone({ frequencyHz: continuousMidiToHz(selectedMidi, centsOffset), timbre, duration: 1.15 })} /><ActionButton className="primary" onClick={start} disabled={running}><Icon name="mic" size={18} /> {running ? `${Math.max(0, duration - elapsed).toFixed(1)}s` : micReady ? "Begin controlled hold" : "Enable mic to begin"}</ActionButton>{running && <ActionButton onClick={finish}>Finish</ActionButton>}</div>
      </Panel>

      <div className="split-score">
        <Panel className="dimension-score pitch"><Eyebrow>Dimension 01</Eyebrow><div className="dimension-title"><span className="dimension-icon">∿</span><div><h2>Pitch control</h2><p>Center, stability, and drift</p></div><strong>{metrics?.inToleranceRatio == null ? "—" : `${(metrics.inToleranceRatio * 100).toFixed(0)}%`}</strong></div><dl><div><dt>Median center</dt><dd>{metrics?.medianErrorCents == null ? "—" : `${metrics.medianErrorCents > 0 ? "+" : ""}${metrics.medianErrorCents.toFixed(1)}¢`}</dd></div><div><dt>Stability</dt><dd>{metrics?.stabilityCents == null ? "—" : `${metrics.stabilityCents.toFixed(1)}¢`}</dd></div><div><dt>Drift</dt><dd>{metrics?.driftCentsPerSecond == null ? "—" : `${metrics.driftCentsPerSecond.toFixed(1)}¢/s`}</dd></div></dl></Panel>
        <Panel className="dimension-score volume"><Eyebrow>Dimension 02</Eyebrow><div className="dimension-title"><span className="dimension-icon">◢</span><div><h2>Dynamic control</h2><p>Envelope shape, separate from pitch</p></div><strong>{volumeScore == null ? "—" : `${volumeScore.toFixed(0)}%`}</strong></div><dl><div><dt>Shape match</dt><dd>{volumeScore == null ? "—" : `${volumeScore.toFixed(1)}%`}</dd></div><div><dt>Dynamic range</dt><dd>{metrics?.volume?.dynamicRangeDb == null ? "—" : `${metrics.volume.dynamicRangeDb.toFixed(1)} dB`}</dd></div><div><dt>Peak RMS</dt><dd>{metrics?.volume?.maximumRms == null ? "—" : metrics.volume.maximumRms.toFixed(3)}</dd></div></dl></Panel>
      </div>
    </div>
  );
}
