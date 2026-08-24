import { ActionButton, Eyebrow } from "@/ui/Controls";
import type { VocalFlightSessionState } from "./vocal-flight-session";

interface VocalFlightResultProps {
  readonly state: Readonly<VocalFlightSessionState>;
  readonly onFlyAgain: () => void;
  readonly onRecalibrate: () => void;
  readonly onExit: () => void;
}

function percentage(value: number | null): string {
  return value === null ? "N/A" : `${value.toFixed(0)}%`;
}

function decimal(value: number | null, suffix = ""): string {
  return value === null ? "N/A" : `${value.toFixed(1)}${suffix}`;
}

function resultSummary(state: Readonly<VocalFlightSessionState>): string {
  const result = state.result!;
  if (result.axisIndependencePercent !== null && result.axisIndependencePercent < 65) {
    return "The course exposed cross-axis coupling. Use the single-axis tutorials to separate pitch from brightness before chasing speed.";
  }
  if (result.centerRecoveryPercent !== null && result.centerRecoveryPercent < 65) {
    return "Control was effective away from center; the next gain is releasing back to neutral sooner and more accurately.";
  }
  if (result.smoothnessPercent < 70) {
    return "The path was controllable. Smaller corrections will reduce oscillation and overshoot on the next run.";
  }
  return "The voice behaved like a continuous controller: measured corrections, stable flight, and efficient recovery.";
}

function FreeFlightSummary({
  state,
  onFlyAgain,
  onRecalibrate,
  onExit,
}: VocalFlightResultProps) {
  const result = state.result!;
  return (
    <section className="vocal-flight-overlay vocal-flight-result vocal-flight-free-result" aria-labelledby="vocal-flight-result-title">
      <div className="vocal-flight-result-copy">
        <Eyebrow>Free Flight · unscored exploration</Eyebrow>
        <h1 id="vocal-flight-result-title">Flight ended.</h1>
        <p>No grade was awarded. Free Flight is for feeling how the calibrated acoustic joystick moves the aircraft.</p>
        <div className="vocal-flight-result-metrics">
          <span><small>FLIGHT TIME</small><b>{result.scoredSeconds.toFixed(1)} s</b></span>
          <span><small>DISTANCE</small><b>{state.flight.distanceTraveled.toFixed(0)} m</b></span>
          <span><small>FINAL ALTITUDE</small><b>{state.flight.position.y.toFixed(1)} m</b></span>
          <span><small>LIVE OBSERVATIONS</small><b>{state.observedFrameCount.toLocaleString()}</b></span>
        </div>
        <footer>
          <ActionButton data-flight-action="exit" onClick={onExit}>Back to cabinet</ActionButton>
          <ActionButton data-flight-action="recalibrate" onClick={onRecalibrate}>Recalibrate</ActionButton>
          <ActionButton data-flight-action="choose-flight" className="primary" onClick={onFlyAgain}>Choose another flight</ActionButton>
        </footer>
      </div>
    </section>
  );
}

export function VocalFlightResult({
  state,
  onFlyAgain,
  onRecalibrate,
  onExit,
}: VocalFlightResultProps) {
  if (state.mode === "free-flight") {
    return <FreeFlightSummary state={state} onFlyAgain={onFlyAgain} onRecalibrate={onRecalibrate} onExit={onExit} />;
  }
  const result = state.result!;
  const course = state.course;
  const completed = course?.status === "complete";
  return (
    <section className="vocal-flight-overlay vocal-flight-result" aria-labelledby="vocal-flight-result-title">
      <div className="vocal-flight-result-grade">
        <span>CONTROL GRADE</span>
        <strong>{result.grade}</strong>
        <b>{result.score}<small>/100</small></b>
      </div>
      <div className="vocal-flight-result-copy">
        <Eyebrow>Flight evidence · not a general singing grade</Eyebrow>
        <h1 id="vocal-flight-result-title">{course?.definition.title} {completed ? "complete." : "ended."}</h1>
        <p>{resultSummary(state)}</p>
        <div className="vocal-flight-result-metrics">
          <span><small>COURSE ACCURACY</small><b>{percentage(result.courseAccuracyPercent)}</b></span>
          <span><small>SMOOTHNESS</small><b>{percentage(result.smoothnessPercent)}</b></span>
          <span><small>OVERSHOOTS</small><b>{result.overshootCount}</b></span>
          <span><small>CENTER RECOVERY</small><b>{percentage(result.centerRecoveryPercent)}</b></span>
          <span><small>AXIS INDEPENDENCE</small><b>{percentage(result.axisIndependencePercent)}</b></span>
          <span><small>CONTROL EFFICIENCY</small><b>{percentage(result.controlEfficiencyPercent)}</b></span>
          <span><small>FLIGHT TIME</small><b>{result.scoredSeconds.toFixed(1)} s</b></span>
          {result.timeEfficiencyPercent !== null && <span><small>TIME TARGET</small><b>{percentage(result.timeEfficiencyPercent)}</b></span>}
          <span><small>PITCH-TASK ROLL LEAK</small><b>{decimal(result.pitchTaskBrightnessLeak)}</b></span>
          <span><small>BRIGHTNESS-TASK PITCH LEAK</small><b>{decimal(result.brightnessTaskPitchDriftCents, "¢")}</b></span>
        </div>
        <p className="vocal-flight-result-proof">{course?.gatesPassed} gates passed · {course?.gatesMissed} missed · loudness did not affect the grade</p>
        <footer>
          <ActionButton data-flight-action="exit" onClick={onExit}>Back to cabinet</ActionButton>
          <ActionButton data-flight-action="recalibrate" onClick={onRecalibrate}>Recalibrate</ActionButton>
          <ActionButton data-flight-action="choose-flight" className="primary" onClick={onFlyAgain}>Choose next flight</ActionButton>
        </footer>
      </div>
    </section>
  );
}
