import { useId, useMemo } from "react";
import type { YinPitchFrame } from "@noteforge/pitch-engine";
import { noteLabel, signed } from "@/lib/music-display";
import type { AudioInputController, InputTelemetry } from "@/audio/use-audio-input";
import { Icon } from "./Icon";

interface InputScopeProps {
  input: AudioInputController;
  targetMidiFloat?: number;
  toleranceCents?: number;
  title?: string;
  busy?: boolean;
  showPitch?: boolean;
}

interface ScopeDiagnosis {
  label: string;
  detail: string;
  tone: "off" | "waiting" | "good" | "warn" | "danger";
}

const METER_MIN_DBFS = -72;
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

function diagnose(
  state: AudioInputController["state"],
  telemetry: InputTelemetry | null,
  frame: YinPitchFrame | undefined,
  calibrated: boolean,
  calibrating: boolean
): ScopeDiagnosis {
  if (state === "error") return { label: "Input unavailable", detail: "Check browser permission, the selected device, and secure HTTPS.", tone: "danger" };
  if (state === "starting") return { label: "Opening input", detail: "Negotiating the microphone and loading the local pitch worklet.", tone: "waiting" };
  if (state === "off") return { label: "Input is off", detail: "Enable the microphone to see level, noise, pitch lock, and cents.", tone: "off" };
  if (calibrating) return { label: "Measuring the room", detail: "Stay quiet for three seconds. Avoid touching the microphone or keyboard.", tone: "waiting" };
  if (!telemetry) return { label: "Waiting for samples", detail: "The stream is open; the first meter window has not arrived yet.", tone: "waiting" };
  if (telemetry.clippedSampleCount > 0 || telemetry.peakDbfs >= -0.1) {
    return { label: "Clipping", detail: "Back away or lower input gain. Full-scale samples cannot be measured accurately.", tone: "danger" };
  }
  if (telemetry.peakDbfs >= -3) return { label: "Nearly clipping", detail: "There is very little headroom. Lower gain or move back slightly.", tone: "warn" };
  if (!calibrated) return { label: "Signal visible · room unknown", detail: "Run room calibration so noise and quiet phonation are separated for this microphone.", tone: "warn" };
  if (!telemetry.gateOpen) {
    return { label: "Below detector gate", detail: "This level is being treated as room noise. Voice audio remains untouched.", tone: "off" };
  }
  if (!frame?.voiced) {
    return { label: "Level present · no pitch lock", detail: "The signal cleared the gate, but YIN cannot find a stable fundamental yet.", tone: "warn" };
  }
  if (frame.confidence < 0.78) {
    return { label: "Pitch forming", detail: "A fundamental is present, but periodicity is still uncertain or noisy.", tone: "waiting" };
  }
  return { label: "Pitch locked", detail: "The input is above the room, below clipping, and periodic enough to measure.", tone: "good" };
}

function deviceProcessingDescription(input: AudioInputController): string {
  const settings = input.microphoneInfo?.settings;
  if (!settings) return "Not negotiated";
  return `EC ${settings.echoCancellation === true ? "on" : "off"} · NS ${settings.noiseSuppression === true ? "on" : "off"} · AGC ${settings.autoGainControl === true ? "on" : "off"}`;
}

export function InputScope({
  input,
  targetMidiFloat,
  toleranceCents = 20,
  title = "Input scope",
  busy = false,
  showPitch = true
}: InputScopeProps) {
  const gradientId = useId().replaceAll(":", "");
  const telemetry = input.telemetry;
  const frame = input.state === "ready" ? input.liveFrame : undefined;
  const calibrated = input.noiseFloorDbfs !== null;
  const calibrating = input.calibration.status === "calibrating";
  const diagnosis = diagnose(input.state, telemetry, frame, calibrated, calibrating);
  const pitchError = frame?.midiFloat == null
    ? null
    : targetMidiFloat === undefined
      ? frame.centsFromNearest
      : (frame.midiFloat - targetMidiFloat) * 100;
  const pitchPosition = pitchError === null ? 50 : clamp((pitchError + 100) / 200, 0, 1) * 100;
  const inputPercent = meterPercent(telemetry?.rmsDbfs ?? METER_MIN_DBFS);
  const floorPercent = input.noiseFloorDbfs === null ? null : meterPercent(input.noiseFloorDbfs);
  const ceilingPercent = input.noiseCeilingDbfs === null ? floorPercent : meterPercent(input.noiseCeilingDbfs);
  const gatePercent = meterPercent(input.gateThresholdDbfs);
  const confidence = frame?.confidence ?? 0;
  const sensitivity = input.gateMarginDb <= 8 ? "Sensitive" : input.gateMarginDb >= 17 ? "Isolated" : "Balanced";

  const peakHoldDbfs = useMemo(() => {
    const recent = input.telemetryHistory.slice(-36);
    return recent.length ? Math.max(...recent.map((item) => item.peakDbfs)) : null;
  }, [input.telemetryHistory]);
  const peakHoldPercent = meterPercent(peakHoldDbfs ?? METER_MIN_DBFS);

  const historyPoints = useMemo(() => {
    const history = input.telemetryHistory;
    if (history.length < 2) return "";
    return history.map((item, index) => {
      const x = index / (history.length - 1) * 640;
      const y = 104 - meterPercent(item.rmsDbfs) / 100 * 96;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }, [input.telemetryHistory]);

  const peakHistoryPoints = useMemo(() => {
    const history = input.telemetryHistory;
    if (history.length < 2) return "";
    return history.map((item, index) => {
      const x = index / (history.length - 1) * 640;
      const y = 104 - meterPercent(item.peakDbfs) / 100 * 96;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }, [input.telemetryHistory]);

  const dspSettings = input.microphoneInfo?.settings;
  const browserDspActive = dspSettings?.echoCancellation === true
    || dspSettings?.noiseSuppression === true
    || dspSettings?.autoGainControl === true;

  return (
    <section className={`panel input-scope ${input.state} ${diagnosis.tone}`} aria-label="Live microphone input diagnostics">
      <div className="input-scope-header">
        <div>
          <span className="scope-eyebrow"><i /> LIVE INPUT · LOCAL ONLY</span>
          <h2>{title}</h2>
        </div>
        <div className={`scope-diagnosis ${diagnosis.tone}`} aria-live="polite" aria-atomic="true">
          <i />
          <span><b>{diagnosis.label}</b><small>{diagnosis.detail}</small></span>
        </div>
        <div className="scope-actions">
          {input.state === "ready"
            ? <button type="button" disabled={busy} onClick={input.stop}><Icon name="mic" size={15} /> Stop input</button>
            : <button type="button" className="primary" disabled={input.state === "starting"} onClick={() => void input.start()}><Icon name="mic" size={15} /> {input.state === "starting" ? "Connecting…" : "Enable input"}</button>}
          <button type="button" disabled={input.state !== "ready" || busy} onClick={calibrating ? input.cancelCalibration : input.beginCalibration}>
            {calibrating ? "Cancel" : calibrated ? "Recalibrate room" : "Calibrate room"}
          </button>
        </div>
      </div>

      {input.error && <div className="scope-error"><b>Microphone error</b><span>{input.error}</span></div>}
      {calibrating && <div className="scope-calibration" role="progressbar" aria-label="Room calibration" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(input.calibration.progress * 100)}><span style={{ width: `${input.calibration.progress * 100}%` }} /><b>{Math.ceil((1 - input.calibration.progress) * 3)}s · stay quiet</b></div>}
      {!calibrating && input.calibration.message && <div className={`scope-calibration-note ${input.calibration.status}`}>{input.calibration.message}</div>}

      <div className={`input-scope-grid ${showPitch ? "" : "level-only"}`}>
        {showPitch && <div className="scope-pitch">
          <div className="scope-module-label"><span>PITCH POSITION</span><b>{targetMidiFloat === undefined ? "nearest note" : "target relative"}</b></div>
          <div className="scope-pitch-readout">
            <strong>{frame?.voiced && frame.nearestMidi !== null ? noteLabel(frame.nearestMidi) : "—"}</strong>
            <div><b>{pitchError === null ? "—" : `${signed(pitchError, 0)}¢`}</b><small>{frame?.frequencyHz == null ? "waiting for periodic sound" : `${frame.frequencyHz.toFixed(2)} Hz`}</small></div>
            <span className="confidence-ring" style={{ "--confidence": `${confidence * 360}deg` } as React.CSSProperties} role="meter" aria-label="Pitch confidence" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(confidence * 100)} aria-valuetext={`${Math.round(confidence * 100)} percent pitch confidence`}><i>{Math.round(confidence * 100)}</i><small>%</small></span>
          </div>
          <div className="scope-cent-lane" role="meter" aria-label="Pitch position in cents" aria-valuemin={-100} aria-valuemax={100} aria-valuenow={pitchError === null ? undefined : Math.round(clamp(pitchError, -100, 100))} aria-valuetext={pitchError === null ? "No pitch detected" : `${signed(pitchError, 0)} cents`}>
            <span className="tolerance-band" style={{ left: `${50 - Math.min(toleranceCents, 100) / 2}%`, width: `${Math.min(toleranceCents, 100)}%` }} />
            <i className="cent-center" />
            {pitchError !== null && <b className={Math.abs(pitchError) <= toleranceCents ? "in-band" : ""} style={{ left: `${pitchPosition}%` }} />}
          </div>
          <div className="scope-scale"><span>−100¢</span><span>−50</span><b>{targetMidiFloat === undefined ? "note" : "target"}</b><span>+50</span><span>+100¢</span></div>
        </div>}

        <div className="scope-level">
          <div className="scope-module-label"><span>INPUT LEVEL</span><b>{telemetry?.gateOpen ? "gate open" : "gate closed"}</b></div>
          <div className="level-history" role="img" aria-label="Eight seconds of input RMS, peaks, gate state, and clipping">
            <svg viewBox="0 0 640 112" preserveAspectRatio="none">
              <defs><linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0"><stop stopColor="#63d7ff" /><stop offset=".64" stopColor="#d8ff3e" /><stop offset="1" stopColor="#ff6b45" /></linearGradient></defs>
              {[0, 1, 2, 3].map((line) => <line key={line} className="scope-grid-line" x1="0" x2="640" y1={8 + line * 32} y2={8 + line * 32} />)}
              {floorPercent !== null && <rect className="noise-region" x="0" y={104 - (ceilingPercent ?? floorPercent) / 100 * 96} width="640" height={(ceilingPercent ?? floorPercent) / 100 * 96 + 8} />}
              <line className="gate-line" x1="0" x2="640" y1={104 - gatePercent / 100 * 96} y2={104 - gatePercent / 100 * 96} />
              {input.telemetryHistory.map((item, index) => item.gateOpen && <rect key={index} className="gate-open-tick" x={index / Math.max(1, input.telemetryHistory.length - 1) * 640} y="106" width="3.5" height="4" />)}
              {peakHistoryPoints && <polyline className="peak-history-line" points={peakHistoryPoints} />}
              {historyPoints && <polyline className="rms-history-line" stroke={`url(#${gradientId})`} points={historyPoints} />}
              {input.telemetryHistory.map((item, index) => item.clippedSampleCount > 0 && <circle key={`clip-${index}`} className="clip-point" cx={index / Math.max(1, input.telemetryHistory.length - 1) * 640} cy="7" r="2.5" />)}
            </svg>
            {!historyPoints && <span>enable input to begin level history</span>}
          </div>
          <div className="scope-level-bar" role="meter" aria-label="Current microphone level" aria-valuemin={METER_MIN_DBFS} aria-valuemax={METER_MAX_DBFS} aria-valuenow={telemetry ? Math.round(telemetry.rmsDbfs) : undefined} aria-valuetext={telemetry ? `${telemetry.rmsDbfs.toFixed(1)} dBFS, ${telemetry.gateOpen ? "above" : "below"} detector gate` : "No input"}>
            <span className="level-fill" style={{ width: `${inputPercent}%` }} />
            {floorPercent !== null && <i className="floor-marker" style={{ left: `${floorPercent}%` }} title={`Room floor ${input.noiseFloorDbfs?.toFixed(1)} dBFS`} />}
            <i className="gate-marker" style={{ left: `${gatePercent}%` }} title={`Detector gate ${input.gateThresholdDbfs.toFixed(1)} dBFS`} />
            <b className="peak-marker" style={{ left: `${peakHoldPercent}%` }} />
          </div>
          <div className="scope-level-scale"><span>−72</span><span>−48</span><span>−24</span><b>0 dBFS</b></div>
        </div>
      </div>

      <div className="scope-readouts">
        <div><span>INPUT RMS</span><b>{formatDb(telemetry?.rmsDbfs)}<small>FS</small></b></div>
        <div><span>PEAK HOLD</span><b>{formatDb(peakHoldDbfs)}<small>FS</small></b></div>
        <div><span>ROOM FLOOR</span><b>{formatDb(input.noiseFloorDbfs)}<small>FS</small></b></div>
        <div><span>DETECTOR GATE</span><b>{formatDb(input.gateThresholdDbfs)}<small>FS</small></b></div>
        <div><span>ABOVE ROOM</span><b>{telemetry?.signalMarginDb == null ? "—" : `${telemetry.signalMarginDb >= 0 ? "+" : ""}${telemetry.signalMarginDb.toFixed(1)} dB`}</b></div>
        <div><span>HEADROOM</span><b>{telemetry ? `${telemetry.headroomDb.toFixed(1)} dB` : "—"}</b></div>
      </div>

      <div className="scope-setup">
        <label>
          <span>Noise rejection <b>{sensitivity} · +{input.gateMarginDb} dB</b></span>
          <input type="range" min="6" max="24" step="1" value={input.gateMarginDb} disabled={!calibrated || calibrating || busy} onChange={(event) => input.setGateMarginDb(Number(event.target.value))} />
          <small>Sensitive hears quieter input. Isolated rejects more room noise.</small>
        </label>
        <div className="scope-legend"><span><i className="room" /> room band</span><span><i className="gate" /> detector gate</span><span><i className="signal" /> input</span><span><i className="clip" /> clipping</span></div>
        <details>
          <summary>Troubleshooting details</summary>
          <dl>
            <div><dt>Device</dt><dd>{input.microphoneInfo?.label || "Not connected"}</dd></div>
            <div><dt>Sample rate</dt><dd>{input.microphoneInfo ? `${input.microphoneInfo.sampleRate.toLocaleString()} Hz` : "—"}</dd></div>
            <div><dt>Pitch status</dt><dd>{frame?.reason ?? "no frame"}</dd></div>
            <div><dt>Confidence</dt><dd>{frame ? `${(frame.confidence * 100).toFixed(1)}%` : "—"}</dd></div>
            <div><dt>DC offset</dt><dd>{telemetry ? telemetry.dcOffset.toFixed(5) : "—"}</dd></div>
            <div><dt>Clipped samples</dt><dd>{telemetry ? `${telemetry.clippedSampleCount} / ${telemetry.sampleCount}` : "—"}</dd></div>
            <div><dt>Browser DSP</dt><dd className={browserDspActive ? "warn" : ""}>{deviceProcessingDescription(input)}</dd></div>
            <div><dt>Pitch window</dt><dd>4096 samples · YIN</dd></div>
          </dl>
          <div className="scope-detail-actions">
            {calibrated && <button type="button" disabled={busy || calibrating} onClick={input.resetCalibration}>Forget room calibration</button>}
            <p><b>dBFS is digital level, not room loudness.</b> Calibration changes pitch acceptance only; NoteForge does not filter or rewrite your audio.</p>
          </div>
        </details>
      </div>
    </section>
  );
}
