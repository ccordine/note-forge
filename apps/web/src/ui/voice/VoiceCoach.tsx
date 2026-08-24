import type { CSSProperties } from "react";
import type { InputTelemetry } from "@/audio/use-audio-input";
import { noteLabel, signed } from "@/lib/music-display";
import { pitchDiagnosticSessionId, PITCH_DIAGNOSTICS_ENABLED } from "@/diagnostics/pitch-diagnostics";
import { createVoiceCoachView, type VoiceCoachViewInput } from "./view";

export { createVoiceCoachView } from "./view";
export type { VoiceCoachHold, VoiceCoachPhase, VoiceCoachView } from "./view";

export interface VoiceCoachProps extends VoiceCoachViewInput {
  telemetry: InputTelemetry | null;
  title?: string;
  diagnosticsFlow?: string;
  feedbackLevel?: "full" | "reduced" | "gameplay";
  guidanceLive?: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function VoiceCoach(props: VoiceCoachProps) {
  const {
    targetMidi,
    toleranceCents,
    inputState,
    frame,
    telemetry,
    hold,
    title = "Voice controller",
    diagnosticsFlow,
    feedbackLevel = "full",
    guidanceLive = true,
  } = props;
  const view = createVoiceCoachView(props);
  const inputRunning = inputState === "running";
  const evidenceFrame = inputRunning ? frame : undefined;
  const evidenceTelemetry = inputRunning ? telemetry : null;
  const detectorLabel = inputState === "disabled"
    ? "MICROPHONE OFF"
    : inputState === "opening"
      ? "OPENING MICROPHONE"
      : inputState === "error"
        ? "MICROPHONE ERROR"
        : "LIVE DETECTOR";
  const clampedError = view.errorCents === null ? 0 : clamp(view.errorCents, -100, 100);
  const toleranceWidth = clamp(toleranceCents, 0, 100);
  const holdProgress = hold.requiredSeconds <= 0
    ? 0
    : clamp(hold.heldSeconds / hold.requiredSeconds, 0, 1);
  const levelPercent = evidenceTelemetry === null
    ? 0
    : clamp((evidenceTelemetry.rmsDbfs + 96) / 96 * 100, 0, 100);
  const style = {
    "--nf-voice-position": `${50 + clampedError / 2}%`,
    "--nf-voice-tolerance-left": `${50 - toleranceWidth / 2}%`,
    "--nf-voice-tolerance-width": `${toleranceWidth}%`,
    "--nf-voice-hold": `${holdProgress * 100}%`,
    "--nf-voice-level": `${levelPercent}%`,
  } as CSSProperties;

  return (
    <section
      className={`nf-voice-coach ${view.guidanceTone} feedback-${feedbackLevel}`}
      style={style}
      aria-label={title}
      data-note-input
      data-detected-note={evidenceFrame?.voiced && evidenceFrame.nearestMidi !== null ? noteLabel(evidenceFrame.nearestMidi) : ""}
      data-frame-time={evidenceFrame?.timeSeconds ?? ""}
    >
      <div className="nf-voice-target">
        <span>CURRENT TARGET</span>
        <strong>{noteLabel(targetMidi)}</strong>
        <small>{toleranceCents} cent lane</small>
      </div>

      <div className={`nf-voice-guidance ${view.guidanceTone}`} role={guidanceLive ? "status" : undefined} aria-live={guidanceLive ? "polite" : undefined} aria-atomic={guidanceLive ? "true" : undefined}>
        <span>{view.holdLabel}</span>
        <h2>{view.guidanceTitle}</h2>
        <p>{view.guidanceDetail}</p>
      </div>

      {feedbackLevel !== "gameplay" && <div className="nf-voice-tuner">
        <div className="nf-voice-readout">
          <span>{detectorLabel}</span>
          <strong>{view.measuredNote}</strong>
          <small>{inputRunning ? feedbackLevel === "full" ? view.frequencyLabel : "current PCM result" : view.guidanceDetail}</small>
        </div>
        <div className={`nf-voice-lane ${view.errorCents === null ? "waiting" : view.inBand ? "locked" : "searching"}`} role={view.errorCents === null ? "status" : "meter"} aria-label={`Live pitch position relative to ${noteLabel(targetMidi)}`} aria-valuemin={view.errorCents === null ? undefined : -100} aria-valuemax={view.errorCents === null ? undefined : 100} aria-valuenow={view.errorCents === null ? undefined : Math.round(clampedError)} aria-valuetext={view.errorCents === null ? "No periodic pitch in current window" : `${signed(view.errorCents, 0)} cents from target`}>
          <span className="nf-voice-tolerance" />
          <i className="nf-voice-center" />
          {view.errorCents !== null && <b className="nf-voice-needle"><em /></b>}
          <div className="nf-voice-ticks">{[-100, -50, 0, 50, 100].map((tick) => <i key={tick}><span>{tick > 0 ? `+${tick}` : tick}</span></i>)}</div>
        </div>
        <div className="nf-voice-error">
          <span>OFFSET</span>
          <strong>{view.errorCents === null ? "—" : `${signed(view.errorCents, 0)}¢`}</strong>
          <small>{view.errorCents === null ? "current window unvoiced" : view.inBand ? "inside target" : view.errorCents < 0 ? "move up ↑" : "move down ↓"}</small>
        </div>
        <div className="nf-voice-scale"><span>FLAT</span><b>±{toleranceCents}¢ TARGET</b><span>SHARP</span></div>
      </div>}

      {feedbackLevel === "gameplay" && (
        <div className={`nf-voice-gameplay-feedback ${view.guidanceTone}`} role="status" aria-live="polite">
          <span>{inputRunning ? "LIVE NOTE · DIRECT PCM RESULT" : detectorLabel}</span>
          <strong>{view.measuredNote}</strong>
          <small>{inputRunning ? `${view.frequencyLabel} · ${view.errorCents === null ? "listening" : view.inBand ? "voice locked" : "keep steering"}. Exact correction remains an exercise-level choice.` : view.guidanceDetail}</small>
        </div>
      )}

      <div className={`nf-voice-hold ${hold.status}`}>
        <div className="nf-voice-hold__heading">
          <span>EXERCISE HOLD</span>
          <strong>{hold.heldSeconds.toFixed(1)}<small> / {hold.requiredSeconds.toFixed(1)} sec</small></strong>
          <b>{Math.max(0, hold.requiredSeconds - hold.heldSeconds).toFixed(1)}s remaining</b>
        </div>
        <div className="nf-voice-hold__track" role="progressbar" aria-label="Exercise in-tune hold" aria-valuemin={0} aria-valuemax={hold.requiredSeconds} aria-valuenow={hold.heldSeconds}><span /></div>
        <div className="nf-voice-input-level">
          <span>MIC LEVEL · DIAGNOSTIC ONLY</span>
          <div role="meter" aria-label="Microphone input level" aria-valuemin={-96} aria-valuemax={0} aria-valuenow={evidenceTelemetry ? Math.round(clamp(evidenceTelemetry.rmsDbfs, -96, 0)) : -96}><i /></div>
          <b>{evidenceTelemetry ? `${evidenceTelemetry.rmsDbfs.toFixed(0)} dBFS` : inputState === "disabled" ? "off" : "waiting"}</b>
          <small>{evidenceFrame ? `${Math.round(evidenceFrame.confidence * 100)}% CONFIDENCE · LEVEL NEVER GATES PITCH` : detectorLabel}</small>
        </div>
      </div>

      <details className="nf-voice-diagnostics">
        <summary>{PITCH_DIAGNOSTICS_ENABLED ? "Derived pitch diagnostics active" : "Input diagnostics"}</summary>
        <div>
          <span>SESSION <b>{pitchDiagnosticSessionId}</b></span>
          {diagnosticsFlow && <span>FLOW <b>{diagnosticsFlow}</b></span>}
          <span>DIRECT FRAME <b>{evidenceFrame?.midiFloat?.toFixed(3) ?? evidenceFrame?.reason ?? "—"}</b></span>
          <span>NO PCM OR VOICE RECORDING IS SENT</span>
        </div>
      </details>
    </section>
  );
}
