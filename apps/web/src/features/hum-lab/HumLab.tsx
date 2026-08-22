import { useEffect, useMemo, useRef, useState } from "react";
import { smoothPitchFrames, type PitchFrame, type YinPitchFrame } from "@noteforge/pitch-engine";
import { scoreSustainedNote, type AttemptMetrics } from "@noteforge/trainer-core";
import { useAudioInput } from "@/audio/use-audio-input";
import { playTone, type ActiveVoice } from "@/audio/synth";
import { continuousMidiToHz, noteLabel, signed } from "@/lib/music-display";
import { useLab } from "@/state/LabContext";
import { saveAttempt } from "@/storage/database";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { InputScope } from "@/ui/InputScope";
import { PitchRibbon } from "@/features/pitch-mirror/PitchRibbon";

type HumMode = "anchor" | "match" | "glide" | "sustain";
type HumShape = "m" | "n" | "ng";
type Phase = "idle" | "listen" | "hum" | "complete";

interface AnchorResult {
  midiFloat: number;
  nearestMidi: number;
  cents: number;
  frequencyHz: number;
  continuityRatio: number;
}

const MODES: Record<HumMode, { label: string; headline: string; detail: string; duration: number }> = {
  anchor: {
    label: "Find anchor",
    headline: "Find the note inside your natural hum.",
    detail: "Hum without aiming. NoteForge finds the center you settle around and makes it a shared target.",
    duration: 4.5
  },
  match: {
    label: "Target match",
    headline: "Hear it, close the mouth, keep the pitch.",
    detail: "The target stops before you hum, separating auditory memory from the sound of the prompt.",
    duration: 5
  },
  glide: {
    label: "Guided glide",
    headline: "Slide the hum into the target lane.",
    detail: "The target remains audible while you approach it. The landing half of the gesture is scored.",
    duration: 5.5
  },
  sustain: {
    label: "Long sustain",
    headline: "Keep the center while the breath moves.",
    detail: "Hear the note once, then sustain the hum long enough to expose drift, breaks, and recovery.",
    duration: 8
  }
};

const SHAPES: Record<HumShape, { symbol: string; label: string; cue: string }> = {
  m: { symbol: "M", label: "Lips together", cue: "A plain mmm. Let the jaw stay easy; placement is not graded." },
  n: { symbol: "N", label: "Tongue tip", cue: "Use an nnn gesture. Compare the mechanics without changing the intended pitch." },
  ng: { symbol: "NG", label: "Tongue back", cue: "Use the end of “sing.” Keep the target the same while the tract shape changes." }
};

const TOLERANCES = [
  { value: "35", label: "Beginner ±35¢" },
  { value: "20", label: "Developing ±20¢" },
  { value: "10", label: "Precise ±10¢" }
];

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function Metric({ label, value, unit, tone }: { label: string; value?: number; unit?: string; tone?: string }) {
  const signedUnit = unit === "¢" || unit === "¢/s";
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>
        {value == null || !Number.isFinite(value) ? "—" : `${signedUnit && value >= 0 ? "+" : ""}${value.toFixed(unit === "%" ? 0 : 1)}`}
        <small>{value == null ? "" : unit}</small>
      </strong>
    </div>
  );
}

export function HumLab() {
  const {
    selectedMidi, setSelectedMidi, centsOffset, setCentsOffset, timbre, setTimbre,
    toleranceCents, setToleranceCents, expertMode
  } = useLab();
  const [mode, setMode] = useState<HumMode>("anchor");
  const [shape, setShape] = useState<HumShape>("m");
  const [phase, setPhase] = useState<Phase>("idle");
  const [microphoneError, setMicrophoneError] = useState("");
  const [attemptFrames, setAttemptFrames] = useState<PitchFrame[]>([]);
  const [metrics, setMetrics] = useState<AttemptMetrics | null>(null);
  const [anchorResult, setAnchorResult] = useState<AnchorResult | null>(null);
  const [status, setStatus] = useState("READY");

  const attemptFramesRef = useRef<YinPitchFrame[]>([]);
  const attemptActiveRef = useRef(false);
  const attemptModeRef = useRef<HumMode>("anchor");
  const attemptStartedAtRef = useRef("");
  const timersRef = useRef<number[]>([]);
  const guideVoiceRef = useRef<ActiveVoice | null>(null);
  const input = useAudioInput({
    detector: {
      minFrequency: 60,
      maxFrequency: 1_000,
      analysisWindowSize: "maximum",
      yinThreshold: 0.18,
      minConfidence: 0.62
    },
    maxFrames: 280,
    onFrame: (frame) => {
      if (attemptActiveRef.current) attemptFramesRef.current.push(frame);
    }
  });
  const micState = input.state;
  const rawFrames = input.frames;
  const targetMidiFloat = selectedMidi + centsOffset / 100;
  const targetFrequency = continuousMidiToHz(selectedMidi, centsOffset);
  const attempting = phase === "listen" || phase === "hum";
  const displayFrames = useMemo(
    () => smoothPitchFrames(rawFrames.slice(-220), { correctOctaveJumps: true }),
    [rawFrames]
  );
  const smoothedLiveFrame = displayFrames.at(-1);
  const liveFrame = input.liveFrame;

  const anchorPreview = useMemo(() => {
    const source = phase === "hum" && mode === "anchor" ? displayFrames : attemptFrames.length ? attemptFrames : displayFrames;
    return median(source.filter((frame) => frame.voiced && frame.confidence >= 0.55 && frame.midiFloat !== null).map((frame) => frame.midiFloat!));
  }, [attemptFrames, displayFrames, mode, phase]);

  const ribbonTarget = mode === "anchor"
    ? anchorResult?.midiFloat ?? anchorPreview ?? targetMidiFloat
    : targetMidiFloat;
  const shownFrames = attempting ? displayFrames : attemptFrames.length ? attemptFrames : displayFrames;
  const liveError = smoothedLiveFrame?.midiFloat == null ? null : (smoothedLiveFrame.midiFloat - ribbonTarget) * 100;

  const clearTimers = () => {
    timersRef.current.forEach(window.clearTimeout);
    timersRef.current = [];
  };

  const stopGuide = () => {
    guideVoiceRef.current?.stop();
    guideVoiceRef.current = null;
  };

  useEffect(() => () => {
    clearTimers();
    stopGuide();
    attemptActiveRef.current = false;
  }, []);

  const startMicrophone = async () => {
    setMicrophoneError("");
    setStatus("CONNECTING");
    const info = await input.start();
    if (info) {
      setStatus("MIC READY");
    } else {
      setStatus("MIC ERROR");
    }
  };

  const finishAttempt = () => {
    if (!attemptActiveRef.current) return;
    attemptActiveRef.current = false;
    clearTimers();
    stopGuide();

    const attemptMode = attemptModeRef.current;
    const frames = smoothPitchFrames(attemptFramesRef.current, { correctOctaveJumps: true });
    const voiced = frames.filter((frame) => frame.voiced && frame.confidence >= 0.5 && frame.midiFloat !== null);
    setAttemptFrames(frames);
    setPhase("complete");
    setStatus("COMPLETE");

    if (voiced.length < 3) {
      setMetrics(null);
      setMicrophoneError("Not enough continuous voiced sound was detected. Try a slightly clearer or closer hum.");
      return;
    }

    let scoreTargetMidi = selectedMidi;
    let scoreTargetCents = centsOffset;
    let scoreFrames = frames;
    let continuityRatio = frames.length ? voiced.length / frames.length : 0;

    if (attemptMode === "anchor") {
      const center = median(voiced.map((frame) => frame.midiFloat!))!;
      scoreTargetMidi = Math.round(center);
      scoreTargetCents = (center - scoreTargetMidi) * 100;
      const result: AnchorResult = {
        midiFloat: center,
        nearestMidi: scoreTargetMidi,
        cents: scoreTargetCents,
        frequencyHz: continuousMidiToHz(scoreTargetMidi, scoreTargetCents),
        continuityRatio
      };
      setAnchorResult(result);
      setSelectedMidi(scoreTargetMidi);
      setCentsOffset(Math.round(scoreTargetCents));
    } else if (attemptMode === "glide") {
      const firstTime = frames[0]?.timeSeconds ?? 0;
      const lastTime = frames.at(-1)?.timeSeconds ?? firstTime;
      const landingStart = firstTime + (lastTime - firstTime) * 0.55;
      scoreFrames = frames.filter((frame) => frame.timeSeconds >= landingStart);
    }

    const result = scoreSustainedNote(
      scoreFrames,
      {
        midi: scoreTargetMidi,
        centsOffset: scoreTargetCents,
        durationMs: MODES[attemptMode].duration * 1_000,
        timbre,
        amplitude: 0.22
      },
      {
        toleranceCents,
        minimumConfidence: 0.5,
        promptTimeSeconds: scoreFrames[0]?.timeSeconds,
        maximumVoicedGapSeconds: 0.24
      }
    );
    setMetrics(result);

    const completedAt = new Date();
    const skillId = attemptMode === "anchor"
      ? "hum.anchor.discover"
      : attemptMode === "sustain"
        ? "hum.sustain.control"
        : "hum.target.match";
    void saveAttempt({
      id: crypto.randomUUID(),
      exerciseType: skillId,
      target: attemptMode === "anchor"
        ? { discoveredMidi: scoreTargetMidi, centsOffset: scoreTargetCents, humShape: shape }
        : { midi: selectedMidi, centsOffset, humShape: shape, variant: attemptMode },
      metrics: { ...(result as Record<string, number | undefined>), continuityRatio },
      pitchFrames: frames,
      startedAt: attemptStartedAtRef.current || new Date(completedAt.getTime() - MODES[attemptMode].duration * 1_000).toISOString(),
      completedAt: completedAt.toISOString()
    }).catch(() => undefined);
  };

  const beginRecording = (attemptMode: HumMode) => {
    attemptModeRef.current = attemptMode;
    attemptFramesRef.current = [];
    input.clearFrames();
    attemptStartedAtRef.current = new Date().toISOString();
    attemptActiveRef.current = true;
    setPhase("hum");
    setStatus(attemptMode === "anchor" ? "HUM NATURALLY" : attemptMode === "glide" ? "GLIDE, THEN SETTLE" : "HOLD THE HUM");
    timersRef.current.push(window.setTimeout(finishAttempt, MODES[attemptMode].duration * 1_000));
  };

  const beginAttempt = async () => {
    if (micState !== "ready") {
      await startMicrophone();
      return;
    }
    clearTimers();
    stopGuide();
    setMicrophoneError("");
    setMetrics(null);
    setAttemptFrames([]);
    setAnchorResult(mode === "anchor" ? null : anchorResult);

    if (mode === "anchor") {
      beginRecording(mode);
      return;
    }

    setPhase("listen");
    setStatus(mode === "glide" ? "TARGET ON — BEGIN HUM" : "LISTEN");
    const voice = await playTone({
      frequencyHz: targetFrequency,
      timbre,
      duration: mode === "glide" ? MODES.glide.duration + 0.25 : 1.05,
      amplitude: mode === "glide" ? 0.12 : 0.22
    });
    if (mode === "glide") guideVoiceRef.current = voice;
    if (mode === "glide") {
      beginRecording(mode);
    } else {
      timersRef.current.push(window.setTimeout(() => beginRecording(mode), 1_350));
    }
  };

  const resetTrace = () => {
    setAttemptFrames([]);
    setMetrics(null);
    setAnchorResult(null);
    setPhase("idle");
    setStatus(micState === "ready" ? "MIC READY" : "READY");
  };

  const resultContinuity = anchorResult?.continuityRatio
    ?? (metrics?.totalFrameCount ? (metrics.voicedFrameCount ?? 0) / metrics.totalFrameCount : undefined);
  const centered = Math.abs(metrics?.medianErrorCents ?? Number.POSITIVE_INFINITY) <= toleranceCents;

  return (
    <div className="page hum-lab-page">
      <div className="lab-intro mirror-intro">
        <div>
          <Eyebrow>Vibration → pitch center → deliberate motion</Eyebrow>
          <h1>{MODES[mode].headline}</h1>
          <p>{MODES[mode].detail} The contour remains continuous; quiet humming is never snapped to a piano key before scoring.</p>
        </div>
      </div>

      <InputScope
        input={input}
        title="Hum input scope"
        targetMidiFloat={mode === "anchor" ? undefined : targetMidiFloat}
        toleranceCents={toleranceCents}
        busy={attempting}
      />

      {microphoneError && <div className="error-banner"><strong>Hum signal needs attention.</strong><span>{microphoneError}</span></div>}

      <Panel className="hum-config">
        <Segmented
          value={mode}
          onChange={(next) => { if (!attempting) { setMode(next); resetTrace(); } }}
          options={(Object.entries(MODES) as [HumMode, typeof MODES[HumMode]][]).map(([value, item]) => ({ value, label: item.label }))}
          label="Training primitive"
        />
        <div className="hum-config-fields">
          <Select label="Target" value={selectedMidi} disabled={attempting || mode === "anchor"} onChange={(event) => { setSelectedMidi(Number(event.target.value)); setCentsOffset(0); }}>
            {Array.from({ length: 36 }, (_, index) => 43 + index).map((midi) => <option value={midi} key={midi}>{noteLabel(midi)}</option>)}
          </Select>
          <Select label="Timbre" value={timbre} disabled={attempting} onChange={(event) => setTimbre(event.target.value as typeof timbre)}>
            <option>sine</option><option>triangle</option><option>piano</option><option>guitar</option><option>bass</option><option>flute</option><option>voice</option><option>rich synth</option>
          </Select>
          <Select label="Tolerance" value={toleranceCents} disabled={attempting} onChange={(event) => setToleranceCents(Number(event.target.value))}>
            {TOLERANCES.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
          </Select>
          <button className="randomize-button" disabled={attempting || mode === "anchor"} onClick={() => { setSelectedMidi(45 + Math.floor(Math.random() * 28)); setCentsOffset(0); }}><Icon name="spark" size={16} /> Randomize</button>
        </div>
      </Panel>

      <div className="hum-workspace">
        <Panel className="hum-shape-panel">
          <Eyebrow>Mechanics selector</Eyebrow>
          <h2>Choose a hum gesture</h2>
          <p>The pitch detector measures the fundamental. It does not judge where vibration “should” feel.</p>
          <div className="hum-shapes">
            {(Object.entries(SHAPES) as [HumShape, typeof SHAPES[HumShape]][]).map(([value, item]) => (
              <button key={value} disabled={attempting} className={shape === value ? "active" : ""} onClick={() => setShape(value)}>
                <strong>{item.symbol}</strong><span>{item.label}</span>
              </button>
            ))}
          </div>
          <div className="shape-cue"><span>{SHAPES[shape].symbol}</span><p>{SHAPES[shape].cue}</p></div>
          <div className="headphone-note"><Icon name="headphones" size={18} /><span><b>Headphones for guided glide.</b> They keep the target tone out of the microphone measurement.</span></div>
        </Panel>

        <Panel className={`hum-stage ${attempting ? "active" : ""}`}>
          <div className="hum-target-row">
            <div className={`hum-orb ${phase === "hum" ? "sounding" : ""}`}>
              <small>{mode === "anchor" ? "FOUND CENTER" : "TARGET"}</small>
              <strong>{mode === "anchor" ? anchorResult ? noteLabel(anchorResult.nearestMidi) : "mmm" : noteLabel(selectedMidi)}</strong>
              <span>{mode === "anchor" ? anchorResult ? `${signed(anchorResult.cents, 0)}¢ · ${anchorResult.frequencyHz.toFixed(1)} Hz` : "hum where you settle" : `${targetFrequency.toFixed(2)} Hz`}</span>
              <i>m</i><i>m</i><i>m</i>
            </div>
            <div className="hum-stage-copy">
              <span>{status}</span>
              <strong className={liveError != null && Math.abs(liveError) <= toleranceCents ? "in-band" : ""}>{liveError == null ? "—" : `${signed(liveError, 0)}¢`}</strong>
              <small>{liveFrame?.voiced ? `${noteLabel(liveFrame.nearestMidi ?? selectedMidi)} · ${(liveFrame.frequencyHz ?? 0).toFixed(1)} Hz` : micState === "ready" ? "waiting for a steady hum" : "enable the microphone"}</small>
            </div>
          </div>

          <PitchRibbon frames={shownFrames} targetMidiFloat={ribbonTarget} toleranceCents={toleranceCents} durationSeconds={MODES[mode].duration + 1} />

          <div className="stage-actions">
            {mode !== "anchor" && <PlayButton label="Hear target" disabled={attempting} onClick={() => playTone({ frequencyHz: targetFrequency, timbre, duration: 1.1, amplitude: 0.22 })} />}
            <ActionButton className={`primary attempt-button ${phase === "hum" ? "recording" : ""}`} disabled={attempting || micState === "starting"} onClick={beginAttempt}>
              <Icon name={micState === "ready" ? "hum" : "mic"} size={18} />
              {attempting ? phase === "listen" ? "Listen…" : "Measuring hum…" : micState === "ready" ? mode === "anchor" ? "Find my anchor" : "Begin hum" : "Enable mic to begin"}
            </ActionButton>
            {phase === "hum" && <ActionButton onClick={finishAttempt}>Finish now</ActionButton>}
          </div>
        </Panel>
      </div>

      <div className="mirror-results-grid hum-results">
        <Panel className="metrics-panel">
          <div className="panel-heading"><div><Eyebrow>Hum evidence</Eyebrow><h2>{mode === "anchor" ? "Natural center anatomy" : mode === "glide" ? "Landing anatomy" : "Target anatomy"}</h2></div>{metrics && <span className="attempt-badge">measured</span>}</div>
          <div className="metrics-grid">
            <Metric label={mode === "anchor" ? "Found center" : mode === "glide" ? "Landing center" : "Attack"} value={mode === "anchor" ? anchorResult?.cents : mode === "glide" ? metrics?.medianErrorCents : metrics?.attackErrorCents} unit="¢" tone="coral" />
            <Metric label={mode === "anchor" ? "Frequency" : "Pitch center"} value={mode === "anchor" ? anchorResult?.frequencyHz : metrics?.medianErrorCents} unit={mode === "anchor" ? "Hz" : "¢"} tone="lime" />
            <Metric label="Continuity" value={resultContinuity == null ? undefined : resultContinuity * 100} unit="%" tone="blue" />
            <Metric label="In lane" value={metrics?.inToleranceRatio == null ? undefined : metrics.inToleranceRatio * 100} unit="%" />
            <Metric label="Stability" value={metrics?.vibratoAdjustedStabilityCents ?? metrics?.stabilityCents} unit="¢" />
            <Metric label="Drift" value={metrics?.driftCentsPerSecond} unit="¢/s" />
            <Metric label="Longest hold" value={metrics?.holdDurationMs == null ? undefined : metrics.holdDurationMs / 1_000} unit="s" />
            <Metric label="Confidence" value={metrics?.detectorConfidence == null ? undefined : metrics.detectorConfidence * 100} unit="%" />
          </div>
        </Panel>

        <Panel className="guidance-panel hum-guidance">
          <Eyebrow>Interpret, don’t moralize</Eyebrow>
          <h2>{!metrics ? "Give the hum a visible history." : mode === "anchor" ? `Your hum settled near ${anchorResult ? noteLabel(anchorResult.nearestMidi) : "a center"}.` : centered ? "The hum center found the lane." : (metrics.medianErrorCents ?? 0) < 0 ? "The hum settled below the target." : "The hum settled above the target."}</h2>
          <p>{!metrics ? "Quiet is fine. Use an easy sound and let the detector show what actually happened over time." : mode === "anchor" ? "That center is now the shared NoteForge target. Move to Target match or Sustain to make it deliberate." : "Read center, continuity, and drift separately. A break in the hum is different from an inaccurate pitch."}</p>
          <div className="hum-score-key"><span><i className="pitch" /> pitch</span><span><i className="continuity" /> continuity</span><span><i className="signal" /> signal evidence</span></div>
          <ActionButton className="wide" onClick={resetTrace}>Clear trace</ActionButton>
        </Panel>
      </div>

      {expertMode && (
        <Panel className="debug-panel">
          <div className="panel-heading"><div><Eyebrow>Detector evidence</Eyebrow><h2>Hum debug view</h2></div><span className="debug-live"><i /> live</span></div>
          <dl>
            <div><dt>Raw frequency</dt><dd>{liveFrame?.frequencyHz?.toFixed(3) ?? "—"} Hz</dd></div>
            <div><dt>MIDI float</dt><dd>{liveFrame?.midiFloat?.toFixed(4) ?? "—"}</dd></div>
            <div><dt>Confidence</dt><dd>{liveFrame ? `${(liveFrame.confidence * 100).toFixed(1)}%` : "—"}</dd></div>
            <div><dt>RMS</dt><dd>{liveFrame?.rms.toFixed(5) ?? "—"}</dd></div>
            <div><dt>YIN value</dt><dd>{liveFrame?.yinValue?.toFixed(4) ?? "—"}</dd></div>
            <div><dt>Frame status</dt><dd>{liveFrame?.reason ?? "no frame"}</dd></div>
            <div><dt>Window</dt><dd>4096 analysis</dd></div>
            <div><dt>Detector gate</dt><dd>{input.gateThresholdDbfs.toFixed(1)} dBFS</dd></div>
          </dl>
        </Panel>
      )}
    </div>
  );
}
