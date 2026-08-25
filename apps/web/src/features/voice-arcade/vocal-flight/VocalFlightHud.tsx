import type { AudioInputState } from "@/audio/use-audio-input";
import { ActionButton } from "@/ui/Controls";
import { summarizeVocalFlightScore } from "./scoring";
import { vocalFlightCourseGateCount } from "./courses";
import type { VocalFlightSessionState } from "./vocal-flight-session";
import { getVocalFlightMode } from "./vocal-flight-modes";

interface VocalFlightHudProps {
  readonly state: Readonly<VocalFlightSessionState>;
  readonly inputState: AudioInputState;
  readonly onFinish: () => void;
}

function degrees(radians: number): string {
  const value = radians * 180 / Math.PI;
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(0)}°`;
}

function controlStatus(state: Readonly<VocalFlightSessionState>, inputState: AudioInputState): string {
  if (inputState === "disabled") return "VOICE OFF";
  if (inputState === "opening") return "OPENING";
  if (inputState === "error") return "INPUT ERROR";
  if (state.vector.active) return "VOICE ATTACHED";
  return "SILENCE · NEUTRAL";
}

function scoreStatus(state: Readonly<VocalFlightSessionState>, score: number): string {
  if (state.mode === "free-flight") return "UNSCORED";
  if (state.phase === "calibration") return "—";
  return String(score);
}

export function VocalFlightHud({
  state,
  inputState,
  onFinish,
}: VocalFlightHudProps) {
  const currentScore = summarizeVocalFlightScore(state.scoring);
  const selectedMode = getVocalFlightMode(state.mode);
  const courseTitle = state.course?.definition.title ?? selectedMode.label;
  const gateCount = state.course === null ? 0 : vocalFlightCourseGateCount(state.course.definition);
  const passed = state.course?.gatesPassed ?? 0;
  const missed = state.course?.gatesMissed ?? 0;
  const speed = state.flight.config.forwardSpeed * 3.6;
  const scoreLabel = scoreStatus(state, currentScore.score);

  return (
    <header className="vocal-flight-hud" aria-label="Flight status">
      <div className="vocal-flight-hud-title">
        <span>{selectedMode.label.toUpperCase()}</span>
        <strong>{courseTitle}</strong>
      </div>
      <div className="vocal-flight-hud-speed"><span>SPEED</span><strong>{speed.toFixed(0)}<small> km/h</small></strong></div>
      <div className="vocal-flight-hud-attitude"><span>ATTITUDE</span><strong>{degrees(state.flight.pitchRadians)} <small>PITCH</small></strong></div>
      <div className="vocal-flight-hud-bank"><span>BANK</span><strong>{degrees(state.flight.rollRadians)}</strong></div>
      <div className="vocal-flight-hud-course"><span>COURSE</span><strong>{gateCount === 0 ? "FREE" : `${passed}/${gateCount}`}<small>{missed > 0 ? ` · ${missed} missed` : ""}</small></strong></div>
      <div className="vocal-flight-hud-score"><span>CONTROL SCORE</span><strong>{scoreLabel}</strong></div>
      <div className={`vocal-flight-hud-link ${state.vector.active ? "is-active" : ""}`}><span>VOCAL LINK</span><strong>{controlStatus(state, inputState)}</strong></div>
      <div className="vocal-flight-hud-actions">
        {state.phase === "flying" && <ActionButton data-flight-action="finish-flight" className="coral" onClick={onFinish}>{state.mode === "free-flight" ? "Finish flight" : "Finish & grade"}</ActionButton>}
      </div>
    </header>
  );
}
