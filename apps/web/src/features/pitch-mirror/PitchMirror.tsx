import { useEffect, useMemo, useRef, useState } from "react";
import { smoothPitchFrames, type PitchFrame } from "@noteforge/pitch-engine";
import { scoreSustainedNote, type AttemptMetrics } from "@noteforge/trainer-core";
import { useAudioInput } from "@/audio/use-audio-input";
import { playSafely, playTone, type ActiveVoice, type Timbre } from "@/audio/synth";
import { useLab } from "@/state/LabContext";
import { saveAttempt } from "@/storage/database";
import { continuousMidiToHz, noteLabel, signed } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { PitchRibbon } from "./PitchRibbon";

type MirrorMode = "glide" | "delayed" | "cold" | "anchor" | "silent";

interface AttemptConfiguration {
  mode: MirrorMode;
  midi: number;
  centsOffset: number;
  timbre: Timbre;
  toleranceCents: number;
}

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
  const [attemptStarting, setAttemptStarting] = useState(false);
  const [metrics, setMetrics] = useState<AttemptMetrics | null>(null);
  const [countdown, setCountdown] = useState<string>("READY");
  const [saveError, setSaveError] = useState("");
  const [attemptError, setAttemptError] = useState("");
  const attemptFramesRef = useRef<PitchFrame[]>([]);
  const attemptStartRef = useRef(0);
  const attemptActiveRef = useRef(false);
  const attemptTimersRef = useRef<number[]>([]);
  const attemptStartInFlightRef = useRef(false);
  const attemptGenerationRef = useRef(0);
  const attemptConfigurationRef = useRef<AttemptConfiguration | null>(null);
  const attemptMountedRef = useRef(false);
  const promptVoiceRef = useRef<ActiveVoice | null>(null);
  const input = useAudioInput({
    onFrame: (frame) => {
      if (attemptStartRef.current > 0) attemptFramesRef.current.push(frame);
    }
  });
  const targetFrequency = continuousMidiToHz(selectedMidi, centsOffset);
  const targetMidiFloat = selectedMidi + centsOffset / 100;
  const displayFrames = useMemo(() => smoothPitchFrames(input.frames.slice(-180), { correctOctaveJumps: true }), [input.frames]);
  const liveFrame = input.liveFrame;
  const smoothedLiveFrame = displayFrames.at(-1);

  useEffect(() => {
    attemptMountedRef.current = true;
    return () => {
      attemptMountedRef.current = false;
      attemptGenerationRef.current += 1;
      attemptStartInFlightRef.current = false;
      attemptActiveRef.current = false;
      attemptStartRef.current = 0;
      attemptConfigurationRef.current = null;
      attemptTimersRef.current.forEach(window.clearTimeout);
      attemptTimersRef.current = [];
      promptVoiceRef.current?.stop(0.02);
      promptVoiceRef.current = null;
    };
  }, []);

  const finishAttempt = () => {
    if (!attemptActiveRef.current) return;
    attemptActiveRef.current = false;
    attemptTimersRef.current.forEach(window.clearTimeout);
    attemptTimersRef.current = [];
    promptVoiceRef.current?.stop(0.04);
    promptVoiceRef.current = null;
    const configuration = attemptConfigurationRef.current;
    attemptConfigurationRef.current = null;
    if (!configuration) return;
    const frames = smoothPitchFrames(attemptFramesRef.current, { correctOctaveJumps: true });
    attemptStartRef.current = 0;
    setAttemptFrames(frames);
    setAttempting(false);
    setCountdown("COMPLETE");
    const result = scoreSustainedNote(frames, { midi: configuration.midi, centsOffset: configuration.centsOffset, durationMs: 4_000, timbre: configuration.timbre, amplitude: 0.28 }, { toleranceCents: configuration.toleranceCents, promptTimeSeconds: frames[0]?.timeSeconds });
    setMetrics(result);
    const now = new Date();
    void saveAttempt({
      id: crypto.randomUUID(), exerciseType: `pitch.match.${configuration.mode}`, target: { midi: configuration.midi, centsOffset: configuration.centsOffset },
      metrics: result as Record<string, number | undefined>, pitchFrames: frames, startedAt: new Date(now.getTime() - 4_000).toISOString(), completedAt: now.toISOString()
    }).catch(() => setSaveError("The measured attempt could not be saved to local history."));
  };

  const beginAttempt = async () => {
    if (attemptActiveRef.current || attemptStartInFlightRef.current) return;
    const generation = ++attemptGenerationRef.current;
    const configuration: AttemptConfiguration = { mode, midi: selectedMidi, centsOffset, timbre, toleranceCents };
    attemptStartInFlightRef.current = true;
    promptVoiceRef.current?.stop(0.03);
    promptVoiceRef.current = null;
    setAttemptStarting(true);
    setCountdown("CONNECTING");
    setAttemptError("");
    // Always cross the canonical resume path. A live MediaStream can outlast a
    // browser-suspended AudioContext and otherwise look ready while producing no PCM.
    let microphone: Awaited<ReturnType<typeof input.enable>>;
    try {
      microphone = await input.enable();
    } catch {
      if (!attemptMountedRef.current || generation !== attemptGenerationRef.current) return;
      attemptStartInFlightRef.current = false;
      setAttemptStarting(false);
      setCountdown("MIC ERROR");
      setAttemptError("The microphone could not start. No measurement began.");
      return;
    }
    if (!attemptMountedRef.current || generation !== attemptGenerationRef.current) return;
    if (!microphone) {
      attemptStartInFlightRef.current = false;
      setAttemptStarting(false);
      setCountdown("MIC ERROR");
      setAttemptError(input.error || "The microphone could not start. No measurement began.");
      return;
    }
    const attemptFrequency = continuousMidiToHz(configuration.midi, configuration.centsOffset);
    setCountdown("STARTING AUDIO");
    let promptVoice: ActiveVoice;
    try {
      promptVoice = configuration.mode === "glide"
        ? await playTone({ frequencyHz: attemptFrequency, timbre: configuration.timbre, duration: 4.5, amplitude: 0.18 })
        : configuration.mode === "anchor"
          ? await playTone({ frequencyHz: 440, timbre: configuration.timbre, duration: 1.1 })
          : await playTone({ frequencyHz: attemptFrequency, timbre: configuration.timbre, duration: 1.1 });
    } catch {
      if (!attemptMountedRef.current || generation !== attemptGenerationRef.current) return;
      attemptStartInFlightRef.current = false;
      attemptActiveRef.current = false;
      attemptConfigurationRef.current = null;
      attemptStartRef.current = 0;
      setAttemptStarting(false);
      setAttempting(false);
      setCountdown("AUDIO ERROR");
      setAttemptError("The required listening prompt could not start. The attempt stayed ready and no microphone frames were scored.");
      return;
    }
    if (!attemptMountedRef.current || generation !== attemptGenerationRef.current) {
      promptVoice.stop(0.02);
      return;
    }
    promptVoiceRef.current = promptVoice;
    attemptStartInFlightRef.current = false;
    attemptConfigurationRef.current = configuration;
    setAttemptStarting(false);
    setSaveError("");
    setMetrics(null);
    setAttemptFrames([]);
    attemptFramesRef.current = [];
    setAttempting(true);
    attemptActiveRef.current = true;
    setCountdown(configuration.mode === "silent" ? "PREPARE" : "LISTEN");

    const beginScoring = (label: string) => {
      if (
        !attemptMountedRef.current
        || generation !== attemptGenerationRef.current
        || !attemptActiveRef.current
      ) return;
      attemptStartRef.current = performance.now() / 1000;
      setCountdown(label);
    };
    if (configuration.mode === "glide") {
      beginScoring("PHONATE");
    } else if (configuration.mode === "anchor") {
      attemptTimersRef.current.push(window.setTimeout(() => beginScoring("RECALL A4"), 1_600));
    } else {
      const delay = configuration.mode === "silent" ? 2_250 : 1_450;
      attemptTimersRef.current.push(window.setTimeout(() => beginScoring(configuration.mode === "cold" ? "LAND" : "PHONATE"), delay));
    }
    attemptTimersRef.current.push(window.setTimeout(() => {
      if (attemptMountedRef.current && generation === attemptGenerationRef.current) finishAttempt();
    }, configuration.mode === "glide" ? 5_000 : configuration.mode === "silent" ? 7_000 : 6_000));
  };

  const controlsLocked = attempting || attemptStarting;

  const shownFrames = attempting ? displayFrames : attemptFrames.length ? attemptFrames : displayFrames;
  const effectiveTargetMidi = mode === "anchor" ? 69 : targetMidiFloat;
  const liveError = smoothedLiveFrame?.midiFloat == null ? null : (smoothedLiveFrame.midiFloat - effectiveTargetMidi) * 100;

  return (
    <div className="page pitch-mirror-page">
      <div className="lab-intro mirror-intro">
        <div><Eyebrow>Sound → prediction → mechanics</Eyebrow><h1>{modeInfo[mode].instruction}</h1><p>{modeInfo[mode].detail} The ribbon keeps attack, correction, drift, and release visible.</p></div>
      </div>

      {saveError && <div className="error-banner"><strong>Local history needs attention.</strong><span>{saveError}</span></div>}
      {attemptError && <div className="error-banner" role="alert"><strong>Attempt did not start.</strong><span>{attemptError}</span></div>}

      <Panel className="mirror-mode-panel">
        <Segmented value={mode} disabled={controlsLocked} onChange={setMode} options={Object.entries(modeInfo).map(([value, item]) => ({ value: value as MirrorMode, label: item.label }))} />
        <div className="mirror-settings">
          <Select label="Target" value={selectedMidi} disabled={controlsLocked} onChange={(event) => setSelectedMidi(Number(event.target.value))}>{Array.from({ length: 36 }, (_, index) => 45 + index).map((midi) => <option value={midi} key={midi}>{noteLabel(midi)}</option>)}</Select>
          <Select label="Timbre" value={timbre} disabled={controlsLocked} onChange={(event) => setTimbre(event.target.value as typeof timbre)}><option>sine</option><option>triangle</option><option>piano</option><option>guitar</option><option>bass</option><option>flute</option><option>voice</option><option>rich synth</option></Select>
          <Select label="Tolerance" value={toleranceCents} disabled={controlsLocked} onChange={(event) => setToleranceCents(Number(event.target.value))}>{tolerances.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</Select>
          <button className="randomize-button" disabled={controlsLocked} onClick={() => setSelectedMidi(48 + Math.floor(Math.random() * 25))}><Icon name="spark" size={16} /> Randomize</button>
        </div>
      </Panel>

      <NoteInput
        variant="scope"
        input={input}
        targetMidiFloat={mode === "anchor" ? 69 : targetMidiFloat}
        toleranceCents={toleranceCents}
        title="Pitch mirror input"
      />

      <Panel className={`mirror-stage ${attempting ? "active" : ""}`}>
        <div className="target-display">
          <span className="target-kicker">TARGET</span>
          <strong>{mode === "anchor" ? "A4" : noteLabel(selectedMidi)}</strong>
          <span>{mode === "anchor" ? "440.00" : targetFrequency.toFixed(2)} Hz</span>
          <button className="round-play" disabled={controlsLocked} onClick={() => playSafely(playTone({ frequencyHz: mode === "anchor" ? 440 : targetFrequency, timbre, duration: 1.15 }), "Pitch Mirror target tone")} aria-label="Hear target"><Icon name="play" size={21} /></button>
        </div>
        <div className="stage-status"><span>{countdown}</span>{liveError != null && <b className={Math.abs(liveError) <= toleranceCents ? "in-band" : ""}>{signed(liveError, 0)}¢</b>}<small>{smoothedLiveFrame?.voiced ? noteLabel(smoothedLiveFrame.nearestMidi ?? selectedMidi) : input.state === "running" ? "waiting for voiced sound" : "enable the microphone"}</small></div>
        <PitchRibbon frames={shownFrames} targetMidiFloat={mode === "anchor" ? 69 : targetMidiFloat} toleranceCents={toleranceCents} />
        <div className="stage-actions">
          <PlayButton label="Hear target" disabled={controlsLocked} onClick={() => playSafely(playTone({ frequencyHz: mode === "anchor" ? 440 : targetFrequency, timbre, duration: 1.15 }), "Pitch Mirror target tone")} />
          <ActionButton className={`primary attempt-button ${attempting ? "recording" : ""}`} disabled={controlsLocked || input.state === "opening"} onClick={beginAttempt}><Icon name={input.state === "running" ? "mic" : "headphones"} size={18} /> {attempting ? "Measuring…" : attemptStarting ? "Connecting…" : input.state === "running" ? "Begin attempt" : "Enable mic to begin"}</ActionButton>
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

      {expertMode && <Panel className="debug-panel"><div className="panel-heading"><div><Eyebrow>Detector evidence</Eyebrow><h2>Canonical → displayed trace</h2></div><span className="debug-live"><i /> live</span></div><dl><div><dt>Canonical MIDI</dt><dd>{liveFrame?.midiFloat?.toFixed(4) ?? "—"}</dd></div><div><dt>Smoothed MIDI</dt><dd>{smoothedLiveFrame?.midiFloat?.toFixed(4) ?? "—"}</dd></div><div><dt>Display correction</dt><dd>{liveFrame?.midiFloat == null || smoothedLiveFrame?.midiFloat == null ? "—" : `${signed((smoothedLiveFrame.midiFloat - liveFrame.midiFloat) * 100, 1)}¢`}</dd></div><div><dt>YIN value</dt><dd>{liveFrame?.yinValue?.toFixed(4) ?? "—"}</dd></div><div><dt>Live buffer</dt><dd>{input.frames.length} frames</dd></div><div><dt>Attempt buffer</dt><dd>{attemptFramesRef.current.length} frames</dd></div></dl></Panel>}
    </div>
  );
}
