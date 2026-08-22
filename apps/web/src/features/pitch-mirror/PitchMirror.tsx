import { useEffect, useMemo, useRef, useState } from "react";
import { smoothPitchFrames, type PitchFrame, type YinPitchFrame } from "@noteforge/pitch-engine";
import { scoreSustainedNote, type AttemptMetrics } from "@noteforge/trainer-core";
import { useAudioInput } from "@/audio/use-audio-input";
import { playTone } from "@/audio/synth";
import { useLab } from "@/state/LabContext";
import { saveAttempt } from "@/storage/database";
import { continuousMidiToHz, noteLabel, signed } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { InputScope } from "@/ui/InputScope";
import { PitchRibbon } from "./PitchRibbon";

type MirrorMode = "glide" | "delayed" | "cold" | "anchor" | "silent";

const modeInfo: Record<MirrorMode, { label: string; instruction: string; detail: string }> = {
  glide: { label: "Glide", instruction: "Let your voice find the lane.", detail: "The target stays audible while you slide toward it." },
  delayed: { label: "Delayed", instruction: "Hold the sound after it disappears.", detail: "Hear it, keep it internally, then reproduce it." },
  cold: { label: "Cold attack", instruction: "Predict first. Arrive directly.", detail: "Hear the note once, then begin without a scoop." },
  anchor: { label: "Memory anchor", instruction: "Recover the session anchor.", detail: "A4 is established once; produce it later from memory." },
  silent: { label: "Silent prep", instruction: "Configure before you phonate.", detail: "Simulate the note internally, prepare, then release it." }
};

const tolerances = [{ value: "35", label: "Beginner ±35¢" }, { value: "20", label: "Developing ±20¢" }, { value: "10", label: "Precise ±10¢" }];

function Metric({ label, value, unit, tone }: { label: string; value?: number; unit?: string; tone?: string }) {
  return <div className={`metric ${tone ?? ""}`}><span>{label}</span><strong>{value == null || !Number.isFinite(value) ? "—" : `${value >= 0 && (unit === "¢" || unit === "¢/s") ? "+" : ""}${value.toFixed(unit === "%" ? 0 : 1)}`}<small>{value == null ? "" : unit}</small></strong></div>;
}

export function PitchMirror() {
  const { selectedMidi, setSelectedMidi, centsOffset, timbre, setTimbre, toleranceCents, setToleranceCents, expertMode } = useLab();
  const [mode, setMode] = useState<MirrorMode>("glide");
  const [attemptFrames, setAttemptFrames] = useState<PitchFrame[]>([]);
  const [attempting, setAttempting] = useState(false);
  const [metrics, setMetrics] = useState<AttemptMetrics | null>(null);
  const [countdown, setCountdown] = useState<string>("READY");
  const attemptFramesRef = useRef<PitchFrame[]>([]);
  const attemptStartRef = useRef(0);
  const attemptActiveRef = useRef(false);
  const attemptTimersRef = useRef<number[]>([]);
  const input = useAudioInput({
    detector: {
      minFrequency: 65,
      maxFrequency: 1_100,
      analysisWindowSize: 2_048,
      yinThreshold: 0.16,
      minConfidence: 0.7
    },
    bufferSize: 4_096,
    maxFrames: 240,
    onFrame: (frame) => {
      if (attemptStartRef.current > 0) attemptFramesRef.current.push(frame);
    }
  });
  const targetFrequency = continuousMidiToHz(selectedMidi, centsOffset);
  const targetMidiFloat = selectedMidi + centsOffset / 100;
  const displayFrames = useMemo(() => smoothPitchFrames(input.frames.slice(-180), { correctOctaveJumps: true }), [input.frames]);
  const rawLiveFrame = input.liveFrame;
  const smoothedLiveFrame = displayFrames.at(-1);

  useEffect(() => () => {
    attemptActiveRef.current = false;
    attemptTimersRef.current.forEach(window.clearTimeout);
  }, []);

  const finishAttempt = () => {
    if (!attemptActiveRef.current) return;
    attemptActiveRef.current = false;
    attemptTimersRef.current.forEach(window.clearTimeout);
    attemptTimersRef.current = [];
    const frames = smoothPitchFrames(attemptFramesRef.current, { correctOctaveJumps: true });
    attemptStartRef.current = 0;
    setAttemptFrames(frames);
    setAttempting(false);
    setCountdown("COMPLETE");
    const result = scoreSustainedNote(frames, { midi: selectedMidi, centsOffset, durationMs: 4_000, timbre, amplitude: 0.28 }, { toleranceCents, promptTimeSeconds: frames[0]?.timeSeconds });
    setMetrics(result);
    const now = new Date();
    void saveAttempt({
      id: crypto.randomUUID(), exerciseType: `pitch.match.${mode}`, target: { midi: selectedMidi, centsOffset },
      metrics: result as Record<string, number | undefined>, pitchFrames: frames, startedAt: new Date(now.getTime() - 4_000).toISOString(), completedAt: now.toISOString()
    }).catch(() => undefined);
  };

  const beginAttempt = async () => {
    if (input.state !== "ready") {
      await input.start();
      return;
    }
    setMetrics(null);
    setAttemptFrames([]);
    input.clearFrames();
    attemptFramesRef.current = [];
    setAttempting(true);
    attemptActiveRef.current = true;
    setCountdown(mode === "silent" ? "PREPARE" : "LISTEN");

    if (mode === "glide") {
      void playTone({ frequencyHz: targetFrequency, timbre, duration: 4.5, amplitude: 0.18 });
      attemptStartRef.current = performance.now() / 1000;
      setCountdown("PHONATE");
    } else if (mode === "anchor") {
      void playTone({ frequencyHz: 440, timbre, duration: 1.1 });
      attemptTimersRef.current.push(window.setTimeout(() => { attemptStartRef.current = performance.now() / 1000; setCountdown("RECALL A4"); }, 1_600));
    } else {
      void playTone({ frequencyHz: targetFrequency, timbre, duration: 1.1 });
      const delay = mode === "silent" ? 2_250 : 1_450;
      attemptTimersRef.current.push(window.setTimeout(() => { attemptStartRef.current = performance.now() / 1000; setCountdown(mode === "cold" ? "LAND" : "PHONATE"); }, delay));
    }
    attemptTimersRef.current.push(window.setTimeout(finishAttempt, mode === "glide" ? 5_000 : mode === "silent" ? 7_000 : 6_000));
  };

  const shownFrames = attempting ? displayFrames : attemptFrames.length ? attemptFrames : displayFrames;
  const effectiveTargetMidi = mode === "anchor" ? 69 : targetMidiFloat;
  const liveError = smoothedLiveFrame?.midiFloat == null ? null : (smoothedLiveFrame.midiFloat - effectiveTargetMidi) * 100;

  return (
    <div className="page pitch-mirror-page">
      <div className="lab-intro mirror-intro">
        <div><Eyebrow>Sound → prediction → mechanics</Eyebrow><h1>{modeInfo[mode].instruction}</h1><p>{modeInfo[mode].detail} The ribbon keeps attack, correction, drift, and release visible.</p></div>
      </div>

      <Panel className="mirror-mode-panel">
        <Segmented value={mode} onChange={setMode} options={Object.entries(modeInfo).map(([value, item]) => ({ value: value as MirrorMode, label: item.label }))} />
        <div className="mirror-settings">
          <Select label="Target" value={selectedMidi} onChange={(event) => setSelectedMidi(Number(event.target.value))}>{Array.from({ length: 36 }, (_, index) => 45 + index).map((midi) => <option value={midi} key={midi}>{noteLabel(midi)}</option>)}</Select>
          <Select label="Timbre" value={timbre} onChange={(event) => setTimbre(event.target.value as typeof timbre)}><option>sine</option><option>triangle</option><option>piano</option><option>guitar</option><option>bass</option><option>flute</option><option>voice</option><option>rich synth</option></Select>
          <Select label="Tolerance" value={toleranceCents} onChange={(event) => setToleranceCents(Number(event.target.value))}>{tolerances.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</Select>
          <button className="randomize-button" onClick={() => setSelectedMidi(48 + Math.floor(Math.random() * 25))}><Icon name="spark" size={16} /> Randomize</button>
        </div>
      </Panel>

      <InputScope
        input={input}
        targetMidiFloat={mode === "anchor" ? 69 : targetMidiFloat}
        toleranceCents={toleranceCents}
        busy={attempting}
        title="Pitch mirror input"
      />

      <Panel className={`mirror-stage ${attempting ? "active" : ""}`}>
        <div className="target-display">
          <span className="target-kicker">TARGET</span>
          <strong>{mode === "anchor" ? "A4" : noteLabel(selectedMidi)}</strong>
          <span>{mode === "anchor" ? "440.00" : targetFrequency.toFixed(2)} Hz</span>
          <button className="round-play" onClick={() => playTone({ frequencyHz: mode === "anchor" ? 440 : targetFrequency, timbre, duration: 1.15 })} aria-label="Hear target"><Icon name="play" size={21} /></button>
        </div>
        <div className="stage-status"><span>{countdown}</span>{liveError != null && <b className={Math.abs(liveError) <= toleranceCents ? "in-band" : ""}>{signed(liveError, 0)}¢</b>}<small>{smoothedLiveFrame?.voiced ? noteLabel(smoothedLiveFrame.nearestMidi ?? selectedMidi) : input.state === "ready" ? "waiting for voiced sound" : "enable the microphone"}</small></div>
        <PitchRibbon frames={shownFrames} targetMidiFloat={mode === "anchor" ? 69 : targetMidiFloat} toleranceCents={toleranceCents} />
        <div className="stage-actions">
          <PlayButton label="Hear target" onClick={() => playTone({ frequencyHz: mode === "anchor" ? 440 : targetFrequency, timbre, duration: 1.15 })} />
          <ActionButton className={`primary attempt-button ${attempting ? "recording" : ""}`} disabled={attempting || input.state === "starting"} onClick={beginAttempt}><Icon name={input.state === "ready" ? "mic" : "headphones"} size={18} /> {attempting ? "Measuring…" : input.state === "ready" ? "Begin attempt" : "Enable mic to begin"}</ActionButton>
          {attempting && <ActionButton onClick={finishAttempt}>Finish now</ActionButton>}
        </div>
      </Panel>

      <div className="mirror-results-grid">
        <Panel className="metrics-panel">
          <div className="panel-heading"><div><Eyebrow>Separate evidence</Eyebrow><h2>Attempt anatomy</h2></div>{metrics && <span className="attempt-badge">measured</span>}</div>
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
          {metrics?.vibrato?.detected && <div className="vibrato-callout"><span>Centered motion detected</span><b>{metrics.vibratoDepthCents?.toFixed(0)}¢ depth · {metrics.vibratoRateHz?.toFixed(1)} Hz</b><small>Scored around its center, not punished frame-by-frame.</small></div>}
        </Panel>

        <Panel className="guidance-panel">
          <Eyebrow>Read the gesture</Eyebrow>
          <h2>{!metrics ? "Make one trace." : Math.abs(metrics.medianErrorCents ?? 100) <= toleranceCents ? "The center found home." : (metrics.medianErrorCents ?? 0) < 0 ? "Your center settled below the lane." : "Your center settled above the lane."}</h2>
          <p>{!metrics ? "One attempt is not a verdict. It is a shape: how you arrived, what you corrected, and what you sustained." : "Compare the attack with the center. A wide attack and accurate center means your ear corrected what motor prediction missed."}</p>
          <div className="gesture-legend"><span><i className="attack" /> attack</span><span><i className="center" /> center</span><span><i className="motion" /> motion</span></div>
          <ActionButton className="wide" onClick={() => { setMetrics(null); setAttemptFrames([]); setCountdown("READY"); }}>Clear trace</ActionButton>
        </Panel>
      </div>

      {expertMode && <Panel className="debug-panel"><div className="panel-heading"><div><Eyebrow>Detector evidence</Eyebrow><h2>Raw → displayed trace</h2></div><span className="debug-live"><i /> live</span></div><dl><div><dt>Raw MIDI</dt><dd>{rawLiveFrame?.midiFloat?.toFixed(4) ?? "—"}</dd></div><div><dt>Smoothed MIDI</dt><dd>{smoothedLiveFrame?.midiFloat?.toFixed(4) ?? "—"}</dd></div><div><dt>Display correction</dt><dd>{rawLiveFrame?.midiFloat == null || smoothedLiveFrame?.midiFloat == null ? "—" : `${signed((smoothedLiveFrame.midiFloat - rawLiveFrame.midiFloat) * 100, 1)}¢`}</dd></div><div><dt>YIN value</dt><dd>{rawLiveFrame?.yinValue?.toFixed(4) ?? "—"}</dd></div><div><dt>Live buffer</dt><dd>{input.frames.length} frames</dd></div><div><dt>Attempt buffer</dt><dd>{attemptFramesRef.current.length} frames</dd></div></dl></Panel>}
    </div>
  );
}
