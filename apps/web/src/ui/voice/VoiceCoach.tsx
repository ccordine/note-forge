import type { CSSProperties } from "react";
import { noteLabel, signed } from "@/lib/music-display";
import { clampUnit } from "@/lib/numeric";
import { isAuthoritativeVoicedPitch } from "@/realtime/authoritative-voiced-pitch";
import { createVoiceCoachView, type VoiceCoachViewInput } from "./view";
import {
  PITCH_METER_MAXIMUM_MIDI,
  PITCH_METER_MINIMUM_MIDI,
  pitchMeterBandPercent,
  pitchMeterMidiIsInRange,
  pitchMeterPositionPercent,
} from "./pitch-meter-scale";

export { createVoiceCoachView } from "./view";
export type { VoiceCoachHold, VoiceCoachPhase, VoiceCoachView } from "./view";

export interface VoiceCoachProps extends VoiceCoachViewInput {
  title?: string;
  feedbackLevel?: "full" | "reduced" | "gameplay";
  guidanceLive?: boolean;
  /** Occupancy reports continuous target time without presenting it as a gate. */
  holdMode?: "goal" | "occupancy";
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
    feedbackLevel = "full",
    guidanceLive = true,
    holdMode = "goal",
  } = props;
  const view = createVoiceCoachView(props);
  const inputRunning = inputState === "running";
  const currentFrame = inputRunning ? frame : undefined;
  const evidenceFrame = currentFrame && isAuthoritativeVoicedPitch(currentFrame)
    ? currentFrame
    : undefined;
  const detectorLabel = detectorStatusLabel(inputState);
  const pitchPosition = pitchMeterPositionPercent(
    evidenceFrame?.midiFloat ?? null,
    targetMidi,
  );
  const toleranceBand = pitchMeterBandPercent(targetMidi, toleranceCents);
  const targetPosition = pitchMeterPositionPercent(targetMidi, targetMidi) ?? 50;
  const holdProgress = hold.requiredSeconds <= 0
    ? 0
    : clampUnit(hold.heldSeconds / hold.requiredSeconds);
  const style = {
    "--nf-voice-position": `${pitchPosition ?? 50}%`,
    "--nf-voice-target-position": `${targetPosition}%`,
    "--nf-voice-tolerance-left": `${toleranceBand.leftPercent}%`,
    "--nf-voice-tolerance-width": `${toleranceBand.widthPercent}%`,
    "--nf-voice-hold": `${holdProgress * 100}%`,
  } as CSSProperties;
  const focusTicks = [-100, -50, 0, 50, 100]
    .map((tick) => ({ tick, midi: targetMidi + tick / 100 }))
    .filter(({ midi }) => (
      pitchMeterMidiIsInRange(midi)
      && midi > PITCH_METER_MINIMUM_MIDI
      && midi < PITCH_METER_MAXIMUM_MIDI
    ))
    .map(({ tick, midi }) => ({
      key: String(tick),
      label: tick > 0 ? `+${tick}` : String(tick),
      position: pitchMeterPositionPercent(midi, targetMidi) ?? 50,
      className: tick === 0 ? "target" : "focus",
    }));
  const pitchTicks = [
    {
      key: "minimum",
      label: noteLabel(Math.round(PITCH_METER_MINIMUM_MIDI)),
      position: pitchMeterPositionPercent(
        PITCH_METER_MINIMUM_MIDI,
        targetMidi,
      ) ?? 0,
      className: "range-start",
    },
    ...focusTicks,
    {
      key: "maximum",
      label: noteLabel(Math.round(PITCH_METER_MAXIMUM_MIDI)),
      position: pitchMeterPositionPercent(
        PITCH_METER_MAXIMUM_MIDI,
        targetMidi,
      ) ?? 100,
      className: "range-end",
    },
  ];
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
      data-detected-note={evidenceFrame ? noteLabel(evidenceFrame.nearestMidi) : ""}
      data-frame-time={currentFrame?.timeSeconds ?? ""}
      data-observation-kind={currentFrame?.observationKind ?? ""}
      data-start-sample={currentFrame?.startSample ?? ""}
      data-end-sample={currentFrame?.endSample ?? ""}
      data-capture-epoch={currentFrame?.captureEpoch ?? ""}
      data-continuity-epoch={currentFrame?.continuityEpoch ?? ""}
      data-graph-generation={currentFrame?.graphGeneration ?? ""}
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
          data-live-pitch-meter
          data-live-midi={evidenceFrame?.midiFloat ?? ""}
          data-pitch-position={pitchPosition ?? ""}
          data-pitch-scale="full-depth-target-lens"
          data-observation-kind={currentFrame?.observationKind ?? ""}
          data-start-sample={currentFrame?.startSample ?? ""}
          data-end-sample={currentFrame?.endSample ?? ""}
          data-capture-epoch={currentFrame?.captureEpoch ?? ""}
          data-continuity-epoch={currentFrame?.continuityEpoch ?? ""}
          data-graph-generation={currentFrame?.graphGeneration ?? ""}
          role={view.errorCents === null ? "status" : "meter"}
          aria-label={`Live pitch position relative to ${noteLabel(targetMidi)}`}
          aria-valuemin={view.errorCents === null ? undefined : Math.round((PITCH_METER_MINIMUM_MIDI - targetMidi) * 100)}
          aria-valuemax={view.errorCents === null ? undefined : Math.round((PITCH_METER_MAXIMUM_MIDI - targetMidi) * 100)}
          aria-valuenow={view.errorCents === null ? undefined : Math.round(view.errorCents)}
          aria-valuetext={view.errorCents === null ? "No periodic pitch in current window" : `${signed(view.errorCents, 0)} cents from target`}
        >
          <span className="nf-voice-tolerance" />
          <i className="nf-voice-center" />
          {pitchPosition !== null && <b className="nf-voice-needle" data-live-pitch-marker><em /></b>}
          <div className="nf-voice-ticks">
            {pitchTicks.map((tick) => <i
              className={tick.className}
              data-pitch-tick-position={tick.position}
              key={tick.key}
              style={{ left: `${tick.position}%` }}
            ><span>{tick.label}</span></i>)}
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
        <summary>Local input diagnostics</summary>
        <div>
          <span>DIRECT FRAME <b>{evidenceFrame?.midiFloat.toFixed(3) ?? currentFrame?.reason ?? "—"}</b></span>
          <span>LOCAL VIEW · REMOTE SHARING IS A SEPARATE SETTING</span>
        </div>
      </details>
    </section>
  );
}
