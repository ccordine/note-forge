import "../../styles-pitch-tunnel.css";
import { noteLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { PitchTunnelLane, PitchTunnelMetricsView } from "./PitchTunnelLane";
import { usePitchTunnel } from "./use-pitch-tunnel";

function signedCents(value: number): string {
  if (Math.abs(value) < .05) return "0¢";
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}¢`;
}

function anchorLabel(midiFloat: number | null): string {
  if (midiFloat === null) return "—";
  const nearest = Math.round(midiFloat);
  return `${noteLabel(nearest)} ${signedCents((midiFloat - nearest) * 100)}`;
}

function targetHeading(
  status: "idle" | "tracking" | "complete",
  achievementReached: boolean,
  offset: number,
): string {
  if (status === "idle") return "Make this pitch zero.";
  if (status === "complete") return "Trace finished.";
  if (achievementReached) return "Round trip reached. The trace is still live.";
  if (offset === 0) return "Hold the anchor center.";
  return `Steer to ${offset > 0 ? "+" : "−"}${Math.abs(offset)} cents.`;
}

function guidance(
  inputState: "disabled" | "opening" | "running" | "error",
  status: "idle" | "tracking" | "complete",
  achievementReached: boolean,
  currentMidiFloat: number | null,
  errorCents: number | null,
  inLane: boolean | null,
): string {
  if (inputState === "disabled") return "Enable voice in the global header. The exercise never starts or stops the microphone.";
  if (inputState === "opening") return "The app-owned microphone is opening. This instrument will follow the first voiced window.";
  if (inputState === "error") return "Voice input is unavailable. Use Retry voice in the global header after fixing permission or the device.";
  if (status === "complete") return "You finished this trace. The app-owned live point still follows your current F0.";
  if (achievementReached) return "The round trip is recorded. Keep steering for as long as you want, then choose Finish trace.";
  if (status === "idle") {
    return currentMidiFloat === null
      ? "Produce one comfortable steady pitch, then anchor its exact live F0."
      : "Keep this vowel and volume comfortable. Anchor the exact pitch when it feels repeatable.";
  }
  if (currentMidiFloat === null) return "No voiced F0 in this window. Qualified hold time pauses; continuous detection does not.";
  if (inLane) return "Inside the tunnel. Keep the point near the center until the next 25-cent checkpoint.";
  if (errorCents !== null && errorCents < 0) return `Steer upward by ${Math.abs(errorCents).toFixed(1)} cents.`;
  return `Steer downward by ${Math.abs(errorCents ?? 0).toFixed(1)} cents.`;
}

function actionView(
  status: "idle" | "tracking" | "complete",
  inputState: "disabled" | "opening" | "running" | "error",
  canAnchor: boolean,
): Readonly<{ label: string; className: string; disabled: boolean }> {
  if (status === "complete") {
    return { label: "Choose a new anchor", className: "", disabled: false };
  }
  if (status === "tracking") {
    return { label: "Finish trace", className: "primary", disabled: false };
  }
  if (inputState !== "running") {
    return { label: "Voice input required", className: "", disabled: true };
  }
  if (!canAnchor) {
    return { label: "Hold a pitch to anchor", className: "", disabled: true };
  }
  return { label: "Start trace here", className: "primary", disabled: false };
}

function statusKicker(
  status: "idle" | "tracking" | "complete",
  achievementReached: boolean,
): string {
  if (achievementReached && status === "tracking") {
    return "ROUND TRIP REACHED · USER-OWNED TRACE LIVE";
  }
  if (status === "complete") return "FINISHED · SENSOR STILL LIVE";
  return "CURRENT CHECKPOINT";
}

export function PitchTunnel() {
  const session = usePitchTunnel();
  const { input, metrics, state } = session;
  const checkpointOffset = state.checkpoint?.targetOffsetCents ?? 0;
  const currentCandidate = state.status === "idle" ? state.currentMidiFloat : state.anchorMidiFloat;
  const canAnchor = input.state === "running"
    && state.currentObservationKind === "voiced"
    && state.currentMidiFloat !== null
    && state.latestCandidate?.supportsTrajectory === true;
  const instruction = guidance(
    input.state,
    state.status,
    state.achievementReached,
    state.currentMidiFloat,
    state.currentErrorCents,
    state.currentInLane,
  );
  const action = actionView(state.status, input.state, canAnchor);
  const handleAction = () => {
    if (state.status === "idle") session.anchorCurrentPitch();
    else if (state.status === "tracking") session.finish();
    else session.reset();
  };

  return (
    <div className="page pitch-tunnel-page">
      <div className="lab-intro pitch-tunnel-intro">
        <div>
          <Eyebrow>Continuous F0 steering · 25-cent checkpoints</Eyebrow>
          <h1>Move only the pitch.</h1>
          <p>Anchor one comfortable sound, climb from 0 to +100 cents in quarter-semitone steps, then return. Every hold and metric comes from microphone sample coordinates.</p>
        </div>
      </div>

      <Panel className="pitch-tunnel-instrument" data-pitch-tunnel>
        <header className="pitch-tunnel-header">
          <div className="pitch-tunnel-heading">
            <small>{statusKicker(state.status, state.achievementReached)}</small>
            <h2 aria-live="polite">{targetHeading(state.status, state.achievementReached, checkpointOffset)}</h2>
          </div>
          <div className="pitch-tunnel-anchor">
            <small>{state.status === "idle" ? "LIVE ANCHOR CANDIDATE" : "FROZEN SESSION ANCHOR"}</small>
            <strong>{anchorLabel(currentCandidate)}</strong>
            <span>{state.anchorMidiFloat === null ? "waiting for your exact F0" : `${(440 * 2 ** ((state.anchorMidiFloat - 69) / 12)).toFixed(2)} Hz`}</span>
          </div>
        </header>

        <PitchTunnelLane inputState={input.state} state={state} metrics={metrics} />

        <div className="pitch-tunnel-guidance">
          <span>
            <b>{instruction}</b>
            <small>This version measures fundamental pitch only. It does not claim that vowel, loudness, resonance, or timbre remained unchanged.</small>
          </span>
          <div>
            <ActionButton
              className={action.className}
              disabled={action.disabled}
              onClick={handleAction}
            >
              {action.label}
            </ActionButton>
          </div>
        </div>

        <PitchTunnelMetricsView metrics={metrics} />

        <div className="pitch-tunnel-footnote">
          One app-owned stream · one user-finished pitch trace · ±{state.options.laneHalfWidthCents}¢ walls · {state.options.requiredInLaneSeconds.toFixed(1)} sample-timed second per checkpoint · no automatic cutoff
        </div>
      </Panel>
    </div>
  );
}
