import { useId, useMemo } from "react";
import { noteLabel, signed } from "@/lib/music-display";
import type { AudioInputController, InputTelemetry } from "@/audio/use-audio-input";
import { Icon } from "./Icon";

export interface InputScopeProps {
  input: AudioInputController;
  targetMidiFloat?: number;
  toleranceCents?: number;
  title?: string;
}

const METER_MIN_DBFS = -96;
const METER_MAX_DBFS = 0;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function meterPercent(dbfs: number): number {
  return clamp((dbfs - METER_MIN_DBFS) / (METER_MAX_DBFS - METER_MIN_DBFS), 0, 1) * 100;
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

function diagnosis(input: AudioInputController): {
  label: string;
  detail: string;
  tone: "off" | "waiting" | "good" | "warn" | "danger";
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
      tone: "waiting",
    };
  }
  if (input.state === "disabled") {
    return {
      label: "Input is off",
      detail: "Enable the microphone to begin continuous note detection.",
      tone: "off",
    };
  }
  if (input.telemetry && hasMeaningfulClipping(input.telemetry)) {
    return {
      label: "Input clipping",
      detail: "Pitch detection is still running. Lower hardware gain for a cleaner result.",
      tone: "danger",
    };
  }
  const frame = input.liveFrame;
  if (frame?.voiced && frame.nearestMidi !== null) {
    return {
      label: `${noteLabel(frame.nearestMidi)} detected`,
      detail: "Direct result from the current PCM window with no acquisition delay.",
      tone: "good",
    };
  }
  return {
    label: "Listening continuously",
    detail: `Current detector result: ${frame?.reason ?? "no observation yet"}.`,
    tone: "warn",
  };
}

export function InputScope({
  input,
  targetMidiFloat,
  toleranceCents = 20,
  title = "Live note input",
}: InputScopeProps) {
  const gradientId = useId().replaceAll(":", "");
  const frame = input.state === "running" ? input.liveFrame : undefined;
  const status = diagnosis(input);
  const pitchError = frame?.midiFloat == null
    ? null
    : targetMidiFloat === undefined
      ? frame.centsFromNearest
      : (frame.midiFloat - targetMidiFloat) * 100;
  const pitchPosition = pitchError === null
    ? 50
    : clamp((pitchError + 100) / 200, 0, 1) * 100;
  const inputPercent = meterPercent(input.telemetry?.rmsDbfs ?? METER_MIN_DBFS);
  const confidence = frame?.confidence ?? 0;
  const liveNote = input.state === "running" ? input.liveNote : null;
  const microphoneInfo = input.microphoneInfo;
  const windowDurationMs = microphoneInfo
    ? microphoneInfo.analysisWindowSize / microphoneInfo.sampleRate * 1_000
    : null;
  const hopDurationMs = microphoneInfo
    ? microphoneInfo.analysisHopSize / microphoneInfo.sampleRate * 1_000
    : null;
  const livePathLabel = input.state === "running"
    ? "LIVE PCM → NOTE · CONTINUOUS"
    : input.state === "opening"
      ? "OPENING MICROPHONE"
      : input.state === "error"
        ? "MICROPHONE ERROR"
        : "MICROPHONE OFF";

  const historyPoints = useMemo(() => {
    if (input.telemetryHistory.length < 2) return "";
    return input.telemetryHistory.map((item, index) => {
      const x = index / (input.telemetryHistory.length - 1) * 640;
      const y = 104 - meterPercent(item.rmsDbfs) / 100 * 96;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }, [input.telemetryHistory]);

  const peakHistoryPoints = useMemo(() => {
    if (input.telemetryHistory.length < 2) return "";
    return input.telemetryHistory.map((item, index) => {
      const x = index / (input.telemetryHistory.length - 1) * 640;
      const y = 104 - meterPercent(item.peakDbfs) / 100 * 96;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }, [input.telemetryHistory]);

  return (
    <section
      className={`panel input-scope ${input.state} ${status.tone}`}
      aria-label="Live microphone note detection"
      data-note-input
      data-input-state={input.state}
      data-frame-count={input.processedWindowCount}
      data-buffered-frame-count={input.frames.length}
      data-frame-time={frame?.timeSeconds ?? ""}
      data-end-sample={input.liveFrame?.endSample ?? ""}
      data-capture-epoch={input.liveFrame?.captureEpoch ?? ""}
      data-continuity-epoch={input.liveFrame?.continuityEpoch ?? ""}
      data-graph-generation={input.liveFrame?.graphGeneration ?? ""}
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
        <div className="scope-actions">
          {input.state === "running"
            ? <button type="button" onClick={input.disable}><Icon name="mic" size={15} /> Stop input</button>
            : <button type="button" className="primary" disabled={input.state === "opening"} onClick={() => void input.enable()}><Icon name="mic" size={15} /> {input.state === "opening" ? "Connecting…" : "Enable input"}</button>}
        </div>
      </div>

      {input.error && <div className="scope-error"><b>Microphone error</b><span>{input.error}</span></div>}

      <div className="scope-grid">
        <div className="scope-module input-module">
          <div className="scope-module-label"><span>INPUT LEVEL</span><b>diagnostic only · never gates pitch</b></div>
          <svg viewBox="0 0 640 112" preserveAspectRatio="none" aria-label="Recent input level history">
            <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop stopColor="#d8ff3e" stopOpacity=".36" /><stop offset="1" stopColor="#d8ff3e" stopOpacity="0" /></linearGradient></defs>
            {[0, 1, 2, 3, 4].map((row) => <line key={row} className="scope-grid-line" x1="0" x2="640" y1={8 + row * 24} y2={8 + row * 24} />)}
            {historyPoints && <><polyline className="scope-history-fill" points={`0,108 ${historyPoints} 640,108`} fill={`url(#${gradientId})`} /><polyline className="scope-history-line" points={historyPoints} /></>}
            {peakHistoryPoints && <polyline className="scope-peak-line" points={peakHistoryPoints} />}
            {input.telemetryHistory.map((item, index) => hasMeaningfulClipping(item) && <circle key={`clip-${index}`} className="clip-point" cx={index / Math.max(1, input.telemetryHistory.length - 1) * 640} cy="7" r="2.5" />)}
          </svg>
          <div className="scope-level-bar" role="meter" aria-label="Current microphone level" aria-valuemin={METER_MIN_DBFS} aria-valuemax={METER_MAX_DBFS} aria-valuenow={input.telemetry ? Math.round(clamp(input.telemetry.rmsDbfs, METER_MIN_DBFS, METER_MAX_DBFS)) : undefined}>
            <span style={{ width: `${inputPercent}%` }} />
          </div>
        </div>

        <div className={`scope-module pitch-module ${frame?.voiced ? "locked" : ""}`}>
          <div className="scope-module-label"><span>DIRECT NOTE RESULT</span><b>{frame ? `${Math.round(confidence * 100)}% confidence` : "waiting"}</b></div>
          <div className="scope-pitch-readout" data-detected-note={frame?.voiced && frame.nearestMidi !== null ? noteLabel(frame.nearestMidi) : ""}>
            <div><strong>{frame?.voiced && frame.nearestMidi !== null ? noteLabel(frame.nearestMidi) : "—"}</strong><span>{frame?.frequencyHz == null ? "No periodic pitch in this window" : `${frame.frequencyHz.toFixed(2)} Hz · ${liveNote?.heldSeconds.toFixed(2) ?? "0.00"} s in note region`}</span></div>
            <div className="scope-cents"><b>{pitchError === null ? "—" : signed(pitchError, 0)}{pitchError !== null && <small>¢</small>}</b><span>{targetMidiFloat === undefined ? "cents from nearest note" : "cents from target"}</span></div>
          </div>
          <div className="scope-pitch-lane" aria-label={pitchError === null ? "No pitch coordinate" : `${signed(pitchError, 0)} cents`}>
            <span className="lane-tolerance" style={{ left: `${50 - toleranceCents / 2}%`, width: `${toleranceCents}%` }} />
            <i className="lane-center" />
            {pitchError !== null && <b className={Math.abs(pitchError) <= toleranceCents ? "in-band" : ""} style={{ left: `${pitchPosition}%` }} />}
          </div>
        </div>
      </div>

      <div className="scope-stats">
        <div><span>INPUT RMS</span><b>{formatDb(input.telemetry?.rmsDbfs)}<small>FS</small></b></div>
        <div><span>PEAK</span><b>{formatDb(input.telemetry?.peakDbfs)}<small>FS</small></b></div>
        <div><span>DETECTOR</span><b>{frame?.reason ?? (input.state === "running" ? "no observation yet" : input.state)}</b></div>
        <div><span>OBSERVATION</span><b>{frame?.observationKind ?? "—"}</b></div>
        <div><span>CONFIDENCE</span><b>{frame ? `${Math.round(frame.confidence * 100)}%` : "—"}</b></div>
        <div><span>PERIODICITY</span><b>{frame ? `${Math.round(frame.periodicity * 100)}%` : "—"}</b></div>
        <div><span>NOTE OCCUPANCY</span><b>{liveNote ? `${liveNote.heldSeconds.toFixed(2)} s` : "—"}</b></div>
        <div><span>HEADROOM</span><b>{input.telemetry ? `${input.telemetry.headroomDb.toFixed(1)} dB` : "—"}</b></div>
        <div><span>PCM WINDOWS</span><b>{input.processedWindowCount}</b></div>
        <div><span>PCM SAMPLES</span><b>{input.processedSampleCount.toLocaleString()}</b></div>
        <div><span>WORKLET CALLBACKS</span><b>{input.workletProcessCount.toLocaleString()}</b></div>
        <div><span>CAPTURE EPOCH</span><b>{input.captureEpoch || "—"}</b></div>
        <div><span>CONTINUITY EPOCH</span><b>{input.continuityEpoch}</b></div>
        <div><span>GRAPH GENERATION</span><b>{input.graphGeneration}</b></div>
        <div><span>INTERNAL REPAIRS</span><b>{input.transportRepairCount}</b></div>
        <div><span>AUDIO PATH</span><b>{microphoneInfo ? `${microphoneInfo.sampleRate.toLocaleString()} Hz` : "unknown"}</b></div>
        <div><span>PITCH WINDOW</span><b>{microphoneInfo && windowDurationMs !== null ? `${microphoneInfo.analysisWindowSize.toLocaleString()} samples · ${windowDurationMs.toFixed(1)} ms` : "unknown"}</b></div>
        <div><span>ANALYSIS HOP</span><b>{microphoneInfo && hopDurationMs !== null ? `${microphoneInfo.analysisHopSize.toLocaleString()} samples · ${hopDurationMs.toFixed(1)} ms` : "unknown"}</b></div>
        <div><span>METER WINDOW</span><b>{microphoneInfo ? `${microphoneInfo.meterWindowSize.toLocaleString()} samples` : "unknown"}</b></div>
        <div><span>ECHO CANCELLATION</span><b>{formatNegotiatedSwitch(microphoneInfo?.settings.echoCancellation)}</b></div>
        <div><span>NOISE SUPPRESSION</span><b>{formatNegotiatedSwitch(microphoneInfo?.settings.noiseSuppression)}</b></div>
        <div><span>AUTO GAIN</span><b>{formatNegotiatedSwitch(microphoneInfo?.settings.autoGainControl)}</b></div>
      </div>
    </section>
  );
}
