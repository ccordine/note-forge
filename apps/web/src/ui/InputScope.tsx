import { useId, useMemo, useState } from "react";
import "../styles-input.css";
import { noteLabel, signed } from "@/lib/music-display";
import {
  useAudioCounterSnapshot,
  useAudioHistorySnapshot,
  useAudioPitchSnapshot,
  useAudioTelemetrySnapshot,
  useAudioTransportSnapshot,
  type AudioInputController,
  type AudioInputState,
  type InputTelemetry,
} from "@/audio/use-audio-input";
import type { PitchObservation } from "@/audio/note-input";
import {
  AUDIO_LEVEL_DISPLAY_MAXIMUM_DBFS,
  AUDIO_LEVEL_DISPLAY_MINIMUM_DBFS,
  dbfsDisplayPercent,
} from "@/lib/audio-level-display";
import { clamp } from "@/lib/numeric";
import { isAuthoritativeVoicedPitch } from "@/realtime/authoritative-voiced-pitch";
import {
  pitchMeterBandPercent,
  pitchMeterPositionPercent,
} from "@/ui/voice/pitch-meter-scale";

export interface InputScopeProps {
  input: AudioInputController;
  targetMidiFloat?: number;
  toleranceCents?: number;
  title?: string;
}

function formatDb(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)} dB`;
}

function formatNegotiatedSwitch(value: boolean | string | undefined): string {
  if (value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "on" : "off";
  return value;
}

function hasMeaningfulClipping(telemetry: Readonly<InputTelemetry>): boolean {
  return telemetry.clippedSampleCount >= 4 && telemetry.clipRatio >= 0.002;
}

function diagnosis(input: Readonly<{
  state: AudioInputState;
  error: string;
  liveFrame: Readonly<PitchObservation> | undefined;
}>): {
  label: string;
  detail: string;
  tone: "off" | "opening" | "active" | "good" | "danger";
} {
  if (input.state === "error") {
    return {
      label: "Input unavailable",
      detail: "Check browser permission, the selected device, and secure HTTPS.",
      tone: "danger",
    };
  }
  if (input.state === "opening") {
    return {
      label: "Opening input",
      detail: "Opening the microphone and production audio worklet.",
      tone: "opening",
    };
  }
  if (input.state === "disabled") {
    return {
      label: "Input is off",
      detail: "Use Enable voice in the global header to begin continuous note detection.",
      tone: "off",
    };
  }
  const frame = input.liveFrame;
  if (frame && isAuthoritativeVoicedPitch(frame)) {
    return {
      label: `${noteLabel(frame.nearestMidi)} detected`,
      detail: "Direct result from the current PCM window with no acquisition delay.",
      tone: "good",
    };
  }
  return {
    label: frame?.observationKind === "uncertain" ? "Pitch is uncertain" : "Listening continuously",
    detail: frame
      ? "PCM is flowing normally; this window does not contain a credible voiced note."
      : "PCM is flowing; the first analysis window is on its way.",
    tone: "active",
  };
}

interface AdvancedInputDiagnosticsProps {
  input: AudioInputController;
  frame: Readonly<PitchObservation> | undefined;
  liveNoteSeconds: number | null;
}

/**
 * Raw histories are an explicitly mounted developer view. Keeping this child
 * out of the tree while <details> is closed prevents 50 Hz history snapshots
 * and telemetry renders from leaking into the ordinary live-note surface.
 */
function AdvancedInputDiagnostics({
  input,
  frame,
  liveNoteSeconds,
}: AdvancedInputDiagnosticsProps) {
  const gradientId = useId().replaceAll(":", "");
  const transport = useAudioTransportSnapshot(input);
  const counters = useAudioCounterSnapshot(input);
  const { telemetry } = useAudioTelemetrySnapshot(input);
  const { telemetryHistory } = useAudioHistorySnapshot(input);
  const { state, microphoneInfo, transportRepairCount } = transport;
  const inputPercent = dbfsDisplayPercent(
    telemetry?.rmsDbfs ?? AUDIO_LEVEL_DISPLAY_MINIMUM_DBFS,
  );
  const windowDurationMs = microphoneInfo
    ? microphoneInfo.analysisWindowSize / microphoneInfo.sampleRate * 1_000
    : null;
  const hopDurationMs = microphoneInfo
    ? microphoneInfo.analysisHopSize / microphoneInfo.sampleRate * 1_000
    : null;
  const historyPoints = useMemo(() => {
    if (telemetryHistory.length < 2) return "";
    return telemetryHistory.map((item, index) => {
      const x = index / (telemetryHistory.length - 1) * 640;
      const y = 104 - dbfsDisplayPercent(item.rmsDbfs) / 100 * 96;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }, [telemetryHistory]);
  const peakHistoryPoints = useMemo(() => {
    if (telemetryHistory.length < 2) return "";
    return telemetryHistory.map((item, index) => {
      const x = index / (telemetryHistory.length - 1) * 640;
      const y = 104 - dbfsDisplayPercent(item.peakDbfs) / 100 * 96;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }, [telemetryHistory]);

  return (
    <>
      <div className="scope-grid">
        <div className="scope-module input-module">
          <div className="scope-module-label"><span>INPUT LEVEL HISTORY</span><b>diagnostic only · never gates pitch</b></div>
          <svg viewBox="0 0 640 112" preserveAspectRatio="none" aria-label="Recent input level history">
            <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop stopColor="#d8ff3e" stopOpacity=".36" /><stop offset="1" stopColor="#d8ff3e" stopOpacity="0" /></linearGradient></defs>
            {[0, 1, 2, 3, 4].map((row) => <line key={row} className="scope-grid-line" x1="0" x2="640" y1={8 + row * 24} y2={8 + row * 24} />)}
            {historyPoints && <><polyline className="scope-history-fill" points={`0,108 ${historyPoints} 640,108`} fill={`url(#${gradientId})`} /><polyline className="scope-history-line" points={historyPoints} /></>}
            {peakHistoryPoints && <polyline className="scope-peak-line" points={peakHistoryPoints} />}
            {telemetryHistory.map((item, index) => hasMeaningfulClipping(item) && <circle key={`clip-${index}`} className="clip-point" cx={index / Math.max(1, telemetryHistory.length - 1) * 640} cy="7" r="2.5" />)}
          </svg>
          <div className="scope-level-bar" role="meter" aria-label="Current microphone level" aria-valuemin={AUDIO_LEVEL_DISPLAY_MINIMUM_DBFS} aria-valuemax={AUDIO_LEVEL_DISPLAY_MAXIMUM_DBFS} aria-valuenow={telemetry ? Math.round(clamp(telemetry.rmsDbfs, AUDIO_LEVEL_DISPLAY_MINIMUM_DBFS, AUDIO_LEVEL_DISPLAY_MAXIMUM_DBFS)) : undefined}>
            <span style={{ width: `${inputPercent}%` }} />
          </div>
        </div>
      </div>

      <div className="scope-stats">
        <div><span>INPUT RMS</span><b>{formatDb(telemetry?.rmsDbfs)}<small>FS</small></b></div>
        <div><span>PEAK</span><b>{formatDb(telemetry?.peakDbfs)}<small>FS</small></b></div>
        <div><span>DETECTOR</span><b>{frame?.reason ?? (state === "running" ? "no observation yet" : state)}</b></div>
        <div><span>OBSERVATION</span><b>{frame?.observationKind ?? "—"}</b></div>
        <div><span>CONFIDENCE</span><b>{frame ? `${Math.round(frame.confidence * 100)}%` : "—"}</b></div>
        <div><span>PERIODICITY</span><b>{frame ? `${Math.round(frame.periodicity * 100)}%` : "—"}</b></div>
        <div><span>NOTE OCCUPANCY</span><b>{liveNoteSeconds === null ? "—" : `${liveNoteSeconds.toFixed(2)} s`}</b></div>
        <div><span>HEADROOM</span><b>{telemetry ? `${telemetry.headroomDb.toFixed(1)} dB` : "—"}</b></div>
        <div><span>PCM WINDOWS</span><b>{counters.processedWindowCount}</b></div>
        <div><span>PCM SAMPLES</span><b>{counters.processedSampleCount.toLocaleString()}</b></div>
        <div><span>WORKLET CALLBACKS</span><b>{counters.workletProcessCount.toLocaleString()}</b></div>
        <div><span>CAPTURE EPOCH</span><b>{counters.captureEpoch || "—"}</b></div>
        <div><span>CONTINUITY EPOCH</span><b>{counters.continuityEpoch}</b></div>
        <div><span>GRAPH GENERATION</span><b>{counters.graphGeneration}</b></div>
        <div><span>INTERNAL REPAIRS</span><b>{transportRepairCount}</b></div>
        <div><span>AUDIO PATH</span><b>{microphoneInfo ? `${microphoneInfo.sampleRate.toLocaleString()} Hz` : "unknown"}</b></div>
        <div><span>PITCH WINDOW</span><b>{microphoneInfo && windowDurationMs !== null ? `${microphoneInfo.analysisWindowSize.toLocaleString()} samples · ${windowDurationMs.toFixed(1)} ms` : "unknown"}</b></div>
        <div><span>ANALYSIS HOP</span><b>{microphoneInfo && hopDurationMs !== null ? `${microphoneInfo.analysisHopSize.toLocaleString()} samples · ${hopDurationMs.toFixed(1)} ms` : "unknown"}</b></div>
        <div><span>METER WINDOW</span><b>{microphoneInfo ? `${microphoneInfo.meterWindowSize.toLocaleString()} samples` : "unknown"}</b></div>
        <div><span>ECHO CANCELLATION</span><b>{formatNegotiatedSwitch(microphoneInfo?.settings.echoCancellation)}</b></div>
        <div><span>NOISE SUPPRESSION</span><b>{formatNegotiatedSwitch(microphoneInfo?.settings.noiseSuppression)}</b></div>
        <div><span>AUTO GAIN</span><b>{formatNegotiatedSwitch(microphoneInfo?.settings.autoGainControl)}</b></div>
      </div>
    </>
  );
}

export function InputScope({
  input,
  targetMidiFloat,
  toleranceCents = 20,
  title = "Live note input",
}: InputScopeProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const transport = useAudioTransportSnapshot(input);
  const pitch = useAudioPitchSnapshot(input);
  const { state, error } = transport;
  const frame = state === "running" ? pitch.liveFrame : undefined;
  const voicedFrame = frame && isAuthoritativeVoicedPitch(frame) ? frame : undefined;
  const liveNote = state === "running" ? pitch.liveNote : null;
  const status = diagnosis({ state, error, liveFrame: frame });
  const pitchError = voicedFrame?.midiFloat == null
    ? null
    : targetMidiFloat === undefined
      ? voicedFrame.centsFromNearest
      : (voicedFrame.midiFloat - targetMidiFloat) * 100;
  const pitchPosition = pitchMeterPositionPercent(
    voicedFrame?.midiFloat ?? null,
    targetMidiFloat,
  );
  const targetBand = targetMidiFloat === undefined
    ? null
    : pitchMeterBandPercent(targetMidiFloat, toleranceCents);
  const targetPosition = targetMidiFloat === undefined
    ? null
    : pitchMeterPositionPercent(targetMidiFloat, targetMidiFloat);
  const confidence = frame?.confidence ?? 0;
  const pitchInBand = pitchError !== null
    && Math.abs(pitchError) <= toleranceCents;
  const pitchPresentationClaim = frame === undefined
    ? ""
    : JSON.stringify([
        frame.endSample,
        frame.captureEpoch,
        frame.continuityEpoch,
        frame.graphGeneration,
        frame.observationKind,
        frame.pitchTrackingDecision ?? null,
        frame.pitchCandidate?.nearestMidi ?? null,
        frame.pitchCandidate?.frequencyHz ?? null,
        frame.pitchCandidate?.rawCandidate?.frequencyHz ?? null,
        voicedFrame?.nearestMidi ?? null,
        state,
      ]);
  const livePathLabel = state === "running"
    ? "LIVE PCM → NOTE · CONTINUOUS"
    : state === "opening"
      ? "OPENING MICROPHONE"
      : state === "error"
        ? "MICROPHONE ERROR"
        : "MICROPHONE OFF";

  return (
    <section
      className={`panel input-scope ${state} ${status.tone}`}
      aria-label="Live microphone note detection"
      data-note-input
      data-input-state={state}
      data-frame-count={input.processedWindowCount}
      data-frame-time={frame?.timeSeconds ?? ""}
      data-observation-kind={frame?.observationKind ?? ""}
      data-end-sample={frame?.endSample ?? ""}
      data-capture-epoch={frame?.captureEpoch ?? ""}
      data-continuity-epoch={frame?.continuityEpoch ?? ""}
      data-graph-generation={frame?.graphGeneration ?? ""}
      data-pitch-tracking-decision={frame?.pitchTrackingDecision ?? ""}
      data-pitch-candidate-midi={frame?.pitchCandidate?.nearestMidi ?? ""}
      data-pitch-candidate-frequency={frame?.pitchCandidate?.frequencyHz ?? ""}
      data-pitch-candidate-raw-frequency={frame?.pitchCandidate?.rawCandidate?.frequencyHz ?? ""}
      data-pitch-presentation-claim={pitchPresentationClaim}
      data-held-samples={liveNote?.heldSamples ?? ""}
      data-held-seconds={liveNote?.heldSeconds ?? ""}
    >
      <div className="input-scope-header">
        <div>
          <span className="scope-eyebrow"><i /> {livePathLabel}</span>
          <h2>{title}</h2>
        </div>
        <div className={`scope-diagnosis ${status.tone}`} aria-live="polite" aria-atomic="true">
          <i />
          <span><b>{status.label}</b><small>{status.detail}</small></span>
        </div>
      </div>

      {error && <div className="scope-error"><b>Microphone error</b><span>{error}</span></div>}

      <div className={`scope-module pitch-module scope-primary-result ${pitchInBand ? "locked" : ""}`}>
        <div className="scope-module-label"><span>DIRECT NOTE RESULT</span><b>{frame ? `${Math.round(confidence * 100)}% confidence` : "waiting"}</b></div>
        <div className="scope-pitch-readout" data-detected-note={voicedFrame ? noteLabel(voicedFrame.nearestMidi) : ""}>
          <div><strong>{voicedFrame ? noteLabel(voicedFrame.nearestMidi) : "—"}</strong><span>{!voicedFrame ? "No periodic pitch in this window" : `${voicedFrame.frequencyHz.toFixed(2)} Hz · ${liveNote?.heldSeconds.toFixed(2) ?? "0.00"} s in note region`}</span></div>
          <div className="scope-cents"><b>{pitchError === null ? "—" : signed(pitchError, 0)}{pitchError !== null && <small>¢</small>}</b><span>{targetMidiFloat === undefined ? "cents from nearest note" : "cents from target"}</span></div>
        </div>
        <div
          className="scope-pitch-lane"
          data-live-pitch-meter
          data-live-midi={voicedFrame?.midiFloat ?? ""}
          data-pitch-position={pitchPosition ?? ""}
          data-pitch-scale={targetMidiFloat === undefined ? "full-detector-range" : "full-depth-target-lens"}
          aria-label={pitchError === null ? "No pitch coordinate" : `${signed(pitchError, 0)} cents`}
        >
          {targetBand && <span className="lane-tolerance" style={{ left: `${targetBand.leftPercent}%`, width: `${targetBand.widthPercent}%` }} />}
          {targetPosition !== null && <i
            className="lane-center"
            style={{ left: `${targetPosition}%` }}
          />}
          {pitchPosition !== null && <b
            className={pitchError !== null && Math.abs(pitchError) <= toleranceCents ? "in-band" : ""}
            data-live-pitch-marker
            style={{ left: `${pitchPosition}%` }}
          />}
        </div>
      </div>

      <details className="scope-advanced" onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary><span>Advanced PCM diagnostics</span><small>{input.processedSampleCount.toLocaleString()} samples · {input.processedWindowCount.toLocaleString()} windows</small></summary>
        {advancedOpen && <AdvancedInputDiagnostics input={input} frame={frame} liveNoteSeconds={liveNote?.heldSeconds ?? null} />}
      </details>
    </section>
  );
}
