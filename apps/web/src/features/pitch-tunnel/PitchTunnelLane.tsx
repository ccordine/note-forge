import type { CSSProperties } from "react";
import { noteLabel } from "@/lib/music-display";
import type {
  PitchTunnelMetrics,
  PitchTunnelState,
} from "./pitch-tunnel-engine";

interface PitchTunnelLaneProps {
  readonly inputState: "disabled" | "opening" | "running" | "error";
  readonly state: Readonly<PitchTunnelState>;
  readonly metrics: Readonly<PitchTunnelMetrics>;
}

const DISPLAY_ERROR_LIMIT_CENTS = 60;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function signedCents(value: number): string {
  if (Math.abs(value) < .05) return "0¢";
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}¢`;
}

function offsetLabel(value: number): string {
  return value === 0 ? "0¢" : `${value > 0 ? "+" : "−"}${Math.abs(value)}¢`;
}

function pitchLabel(midiFloat: number | null): string {
  if (midiFloat === null) return "—";
  const nearestMidi = Math.round(midiFloat);
  return `${noteLabel(nearestMidi)} ${signedCents((midiFloat - nearestMidi) * 100)}`;
}

function frequencyLabel(midiFloat: number | null): string {
  if (midiFloat === null) return "no voiced F0 in this window";
  const frequencyHz = 440 * 2 ** ((midiFloat - 69) / 12);
  return `${frequencyHz.toFixed(2)} Hz`;
}

function metric(value: number | null, suffix: string, digits = 1): string {
  return value === null ? "—" : `${value.toFixed(digits)}${suffix}`;
}

function laneDescription(state: Readonly<PitchTunnelState>): string {
  const target = state.checkpoint?.targetOffsetCents ?? 0;
  if (state.currentMidiFloat === null) {
    return `Pitch Tunnel lane. No voiced pitch in the current observation. Target ${offsetLabel(target)} from the anchor.`;
  }
  if (state.status === "idle") {
    return `Pitch Tunnel lane. Current anchor candidate ${pitchLabel(state.currentMidiFloat)}.`;
  }
  return `Pitch Tunnel lane. Current pitch is ${signedCents(state.currentErrorCents ?? 0)} from the ${offsetLabel(target)} target.`;
}

export function PitchTunnelMetricsView({ metrics }: { readonly metrics: Readonly<PitchTunnelMetrics> }) {
  return (
    <div className="pitch-tunnel-metrics" aria-label="Pitch Tunnel metrics">
      <span className="pitch-tunnel-metric"><small>Distance</small><strong>{metric(metrics.currentAbsoluteErrorCents, "¢")}</strong></span>
      <span className="pitch-tunnel-metric"><small>Time in lane</small><strong>{metric(metrics.timeInLaneSeconds, " s", 2)}</strong></span>
      <span className="pitch-tunnel-metric"><small>Overshoots</small><strong>{metrics.overshootCount}</strong></span>
      <span className="pitch-tunnel-metric"><small>Correction</small><strong>{metric(metrics.meanCorrectionLatencySeconds, " s", 2)}</strong></span>
      <span className="pitch-tunnel-metric"><small>Stability</small><strong>{metric(metrics.stabilityCents, "¢")}</strong></span>
    </div>
  );
}

export function PitchTunnelLane({ inputState, state, metrics }: PitchTunnelLaneProps) {
  const checkpoint = state.checkpoint;
  const targetOffset = checkpoint?.targetOffsetCents ?? 0;
  const errorCents = state.currentErrorCents;
  const currentMidi = state.currentMidiFloat;
  const detectedMidi = currentMidi === null ? null : Math.round(currentMidi);
  const pointPosition = errorCents === null
    ? 50
    : 50 + clamp(
      errorCents,
      -DISPLAY_ERROR_LIMIT_CENTS,
      DISPLAY_ERROR_LIMIT_CENTS,
    ) / (DISPLAY_ERROR_LIMIT_CENTS * 2) * 100;
  const heldSeconds = checkpoint?.heldSeconds ?? 0;
  const requiredSeconds = state.options.requiredInLaneSeconds;
  const holdPercent = clamp(heldSeconds / requiredSeconds * 100, 0, 100);
  const wallInset = 50
    - state.options.laneHalfWidthCents / (DISPLAY_ERROR_LIMIT_CENTS * 2) * 100;
  const laneStyle = {
    "--pitch-tunnel-point-x": `${pointPosition}%`,
    "--pitch-tunnel-wall-inset": `${wallInset}%`,
  } as CSSProperties;
  const progressStyle = {
    "--pitch-tunnel-hold": `${holdPercent}%`,
  } as CSSProperties;
  const laneClass = [
    "pitch-tunnel-lane",
    state.currentInLane === true ? "in-lane" : "",
    currentMidi === null ? "no-pitch" : "",
  ].filter(Boolean).join(" ");

  return (
    <>
      <ol className="pitch-tunnel-checkpoints" aria-label="Pitch Tunnel checkpoint sequence">
        {state.options.checkpointOffsetsCents.map((offset, index) => {
          const complete = state.status === "complete" || index < (checkpoint?.index ?? 0);
          const current = state.status === "tracking" && index === checkpoint?.index;
          return (
            <li
              className={`pitch-tunnel-checkpoint ${complete ? "complete" : ""} ${current ? "current" : ""}`}
              aria-current={current ? "step" : undefined}
              key={`${index}-${offset}`}
            >
              {offsetLabel(offset)}
            </li>
          );
        })}
      </ol>

      <div
        className={laneClass}
        data-note-input
        data-pitch-tunnel-lane
        data-workflow-step={state.status}
        data-input-state={inputState}
        data-detected-note={detectedMidi === null ? "" : noteLabel(detectedMidi)}
        data-observation-kind={state.currentObservationKind ?? ""}
        data-observed-frame-count={state.observedFrameCount}
        data-sample-rate={state.lastAuthority?.sampleRate ?? ""}
        data-start-sample={state.lastAuthority?.startSample ?? ""}
        data-end-sample={state.lastAuthority?.endSample ?? ""}
        data-processed-sample-count={state.lastAuthority?.processedSampleCount ?? ""}
        data-worklet-process-count={state.lastAuthority?.workletProcessCount ?? ""}
        data-capture-epoch={state.lastAuthority?.captureEpoch ?? ""}
        data-continuity-epoch={state.lastAuthority?.continuityEpoch ?? ""}
        data-graph-generation={state.lastAuthority?.graphGeneration ?? ""}
        data-target-offset-cents={targetOffset}
        data-target-midi={checkpoint?.targetMidiFloat ?? ""}
        data-live-midi={currentMidi ?? ""}
        data-error-cents={errorCents ?? ""}
        data-confidence={state.currentConfidence}
        data-in-lane={state.currentInLane === null ? "" : String(state.currentInLane)}
        data-elapsed-seconds={state.elapsedSeconds}
        data-in-lane-seconds={metrics.timeInLaneSeconds}
        data-tracking-loss-seconds={metrics.trackingLossSeconds}
        data-checkpoint-index={checkpoint?.index ?? ""}
        data-checkpoint-held-seconds={heldSeconds}
        style={laneStyle}
        role="img"
        aria-label={laneDescription(state)}
      >
        <span className="pitch-tunnel-lane-label">±{state.options.laneHalfWidthCents}¢ TARGET WALLS</span>
        <span className="pitch-tunnel-centerline" aria-hidden="true" />
        <span className="pitch-tunnel-point" aria-hidden="true" />
        <span className="pitch-tunnel-readout" aria-hidden="true">
          <small>CURRENT F0</small>
          <strong>{pitchLabel(currentMidi)}</strong>
          <small>{frequencyLabel(currentMidi)}</small>
        </span>
        <span className="pitch-tunnel-axis" aria-hidden="true">
          <b>−60¢</b><b>−30¢</b><b>&nbsp;</b><b>+30¢</b><b>+60¢</b>
        </span>
      </div>

      <div className="pitch-tunnel-progress" style={progressStyle} aria-label="Current checkpoint occupancy">
        <span>{heldSeconds.toFixed(2)} s</span>
        <i aria-hidden="true"><span /></i>
        <span>{requiredSeconds.toFixed(2)} s</span>
      </div>
    </>
  );
}
