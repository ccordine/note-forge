import type { CSSProperties } from "react";
import { noteLabel, signed } from "@/lib/music-display";
import { pitchDiagnosticSessionId, PITCH_DIAGNOSTICS_ENABLED } from "@/diagnostics/pitch-diagnostics";
import { createVoiceCoachView, type VoiceCoachViewInput } from "./view";

export { createVoiceCoachView } from "./view";
export type { VoiceCoachHold, VoiceCoachPhase, VoiceCoachView } from "./view";

export interface VoiceCoachProps extends VoiceCoachViewInput {
  title?: string;
  diagnosticsFlow?: string;
  feedbackLevel?: "full" | "reduced" | "gameplay";
  guidanceLive?: boolean;
  /** Occupancy reports continuous target time without presenting it as a gate. */
  holdMode?: "goal" | "occupancy";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function detectorStatusLabel(inputState: VoiceCoachProps["inputState"]): string {
  switch (inputState) {
    case "disabled": return "MICROPHONE OFF";
    case "opening": return "OPENING MICROPHONE";
    case "error": return "MICROPHONE ERROR";
    case "running": return "LIVE DETECTOR";
  }
}

export function VoiceCoach(props: VoiceCoachProps) {
  const {
    targetMidi,
    toleranceCents,
    inputState,
    frame,
    hold,
    title = "Voice controller",
    diagnosticsFlow,
    feedbackLevel = "full",
    guidanceLive = true,
    holdMode = "goal",
  } = props;
  const view = createVoiceCoachView(props);
  const inputRunning = inputState === "running";
  const evidenceFrame = inputRunning ? frame : undefined;
  const detectorLabel = detectorStatusLabel(inputState);
  const clampedError = view.errorCents === null ? 0 : clamp(view.errorCents, -100, 100);
  const toleranceWidth = clamp(toleranceCents, 0, 100);
  const holdProgress = hold.requiredSeconds <= 0
    ? 0
    : clamp(hold.heldSeconds / hold.requiredSeconds, 0, 1);
  const style = {
    "--nf-voice-position": `${50 + clampedError / 2}%`,
    "--nf-voice-tolerance-left": `${50 - toleranceWidth / 2}%`,
    "--nf-voice-tolerance-width": `${toleranceWidth}%`,
    "--nf-voice-hold": `${holdProgress * 100}%`,
  } as CSSProperties;
  let readoutDetail = view.guidanceDetail;
  if (inputRunning) {
    readoutDetail = feedbackLevel === "full" ? view.frequencyLabel : "current PCM result";
  }
  let laneState = "waiting";
  if (view.errorCents !== null) laneState = view.inBand ? "locked" : "searching";
  let correctionDetail = "current window unvoiced";
  if (view.errorCents !== null && view.inBand) correctionDetail = "inside target";
  else if (view.errorCents !== null && view.errorCents < 0) correctionDetail = "move up ↑";
  else if (view.errorCents !== null) correctionDetail = "move down ↓";
  let gameplayState = "listening";
  if (view.errorCents !== null) gameplayState = view.inBand ? "voice locked" : "keep steering";
  const gameplayDetail = inputRunning
    ? `${view.frequencyLabel} · ${gameplayState}. Exact correction remains an exercise-level choice.`
    : view.guidanceDetail;

  return (
    <section
      className={`nf-voice-coach ${view.guidanceTone} feedback-${feedbackLevel}`}
      style={style}
      aria-label={title}
      data-note-input
      data-input-state={inputState}
      data-detected-note={evidenceFrame?.voiced && evidenceFrame.nearestMidi !== null ? noteLabel(evidenceFrame.nearestMidi) : ""}
      data-frame-time={evidenceFrame?.timeSeconds ?? ""}
      data-held-seconds={hold.heldSeconds}
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
          <small>{readoutDetail}</small>
        </div>
        <div
          className={`nf-voice-lane ${laneState}`}
          role={view.errorCents === null ? "status" : "meter"}
          aria-label={`Live pitch position relative to ${noteLabel(targetMidi)}`}
          aria-valuemin={view.errorCents === null ? undefined : -100}
          aria-valuemax={view.errorCents === null ? undefined : 100}
          aria-valuenow={view.errorCents === null ? undefined : Math.round(clampedError)}
          aria-valuetext={view.errorCents === null ? "No periodic pitch in current window" : `${signed(view.errorCents, 0)} cents from target`}
        >
          <span className="nf-voice-tolerance" />
          <i className="nf-voice-center" />
          {view.errorCents !== null && <b className="nf-voice-needle"><em /></b>}
          <div className="nf-voice-ticks">
            {[-100, -50, 0, 50, 100].map((tick) => <i key={tick}><span>{tick > 0 ? `+${tick}` : tick}</span></i>)}
          </div>
        </div>
        <div className="nf-voice-error">
          <span>OFFSET</span>
          <strong>{view.errorCents === null ? "—" : `${signed(view.errorCents, 0)}¢`}</strong>
          <small>{correctionDetail}</small>
        </div>
        <div className="nf-voice-scale"><span>FLAT</span><b>±{toleranceCents}¢ TARGET</b><span>SHARP</span></div>
      </div>}

      {feedbackLevel === "gameplay" && (
        <div className={`nf-voice-gameplay-feedback ${view.guidanceTone}`} role="status" aria-live="polite">
          <span>{inputRunning ? "LIVE NOTE · DIRECT PCM RESULT" : detectorLabel}</span>
          <strong>{view.measuredNote}</strong>
          <small>{gameplayDetail}</small>
        </div>
      )}

      <div className={`nf-voice-hold ${hold.status} mode-${holdMode}`}>
        <div className="nf-voice-hold__heading">
          <span>{holdMode === "occupancy" ? "TARGET OCCUPANCY" : "EXERCISE HOLD"}</span>
          <strong>{hold.heldSeconds.toFixed(1)}<small>{holdMode === "occupancy" ? " sec in lane" : ` / ${hold.requiredSeconds.toFixed(1)} sec`}</small></strong>
          <b>{holdMode === "occupancy" ? "CONTINUOUS SAMPLE TIME" : `${Math.max(0, hold.requiredSeconds - hold.heldSeconds).toFixed(1)}s remaining`}</b>
        </div>
        <div
          className="nf-voice-hold__track"
          role={holdMode === "goal" ? "progressbar" : undefined}
          aria-label={holdMode === "goal" ? "Exercise in-tune hold" : undefined}
          aria-valuemin={holdMode === "goal" ? 0 : undefined}
          aria-valuemax={holdMode === "goal" ? hold.requiredSeconds : undefined}
          aria-valuenow={holdMode === "goal" ? Math.min(hold.heldSeconds, hold.requiredSeconds) : undefined}
        ><span /></div>
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
