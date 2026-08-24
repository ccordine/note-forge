import { noteLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Select } from "@/ui/Controls";
import { VOCAL_FLIGHT_TUTORIALS, getVocalFlightCourse } from "./courses";
import {
  canLaunchVocalFlight,
  canSelectVocalFlightMode,
  courseRequiresBrightness,
  type VocalFlightSessionState,
} from "./vocal-flight-session";
import {
  getVocalFlightMode,
  VOCAL_FLIGHT_MODE_DEFINITIONS,
  type VocalFlightGameMode,
} from "./vocal-flight-modes";

interface VocalFlightLoadoutProps {
  readonly state: Readonly<VocalFlightSessionState>;
  readonly onSelectMode: (mode: VocalFlightGameMode) => void;
  readonly onSelectCourse: (courseId: string) => void;
  readonly onLaunch: () => void;
  readonly onRecalibrate: () => void;
  readonly onExit: () => void;
}

const CHAPTER_LABELS = Object.freeze({
  neutral: "1 · Neutral",
  pitch: "2 · Pitch / elevator",
  brightness: "3 · Brightness / roll",
  combined: "4 · Two-axis control",
  precision: "5 · Precision",
  automaticity: "6 · Automaticity",
});

function signed(value: number, suffix: string): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(0)}${suffix}`;
}

export function VocalFlightLoadout({
  state,
  onSelectMode,
  onSelectCourse,
  onLaunch,
  onRecalibrate,
  onExit,
}: VocalFlightLoadoutProps) {
  const calibration = state.calibration.result!;
  const selectedMode = getVocalFlightMode(state.mode);
  const selectedCourse = state.mode === "training"
    ? getVocalFlightCourse(state.selectedCourseId)
    : selectedMode.course;
  const launchable = canLaunchVocalFlight(state);
  const brightnessNeeded = courseRequiresBrightness(selectedCourse);
  const brightnessDrift = calibration.brightnessTaskPitchDriftCents;
  const axisStatus = calibration.brightnessAvailable
    ? calibration.brightnessIndependent
      ? "Two independent axes demonstrated"
      : brightnessDrift === null
        ? "Brightness works, but axis independence needs more evidence"
        : `Brightness works, with ${brightnessDrift.toFixed(0)}¢ average pitch coupling`
    : "Pitch axis ready · brightness axis needs another calibration pass";
  const objective = selectedCourse?.objective ?? "Explore continuously with no required path or score.";

  return (
    <section className="vocal-flight-overlay vocal-flight-loadout" aria-labelledby="vocal-flight-loadout-title">
      <header>
        <Eyebrow>Personal vocal control surface</Eyebrow>
        <h1 id="vocal-flight-loadout-title">Your neutral is the joystick center.</h1>
        <p>{axisStatus}. Choose a flight that uses the control space you just demonstrated.</p>
      </header>

      <div className="vocal-flight-calibration-summary">
        <span><small>NEUTRAL F0</small><b>{noteLabel(Math.round(calibration.centerMidi))}</b><em>{calibration.centerFrequencyHz.toFixed(1)} Hz</em></span>
        <span><small>PITCH SPACE</small><b>{signed(-calibration.pitchLowerCents, "¢")} / {signed(calibration.pitchUpperCents, "¢")}</b><em>asymmetric by design</em></span>
        <span><small>BRIGHTNESS SPACE</small><b>−{calibration.brightnessDarkerDelta.toFixed(3)} / +{calibration.brightnessBrighterDelta.toFixed(3)}</b><em>pitch-relative harmonic shape</em></span>
        <span><small>CENTER RETURNS</small><b>{calibration.completedRecoveryCount}</b><em>voiced recoveries proven</em></span>
      </div>

      <div className="vocal-flight-mode-grid" role="radiogroup" aria-label="Vocal Flight mode">
        {VOCAL_FLIGHT_MODE_DEFINITIONS.map((mode) => {
          const active = mode.id === state.mode;
          const progressionLocked = !canSelectVocalFlightMode(state, mode.id);
          const unavailable = progressionLocked || mode.course !== null
            && courseRequiresBrightness(mode.course)
            && !calibration.brightnessAvailable;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={active}
              data-flight-mode={mode.id}
              className={active ? "active" : ""}
              disabled={unavailable}
              key={mode.id}
              onClick={() => onSelectMode(mode.id)}
            >
              <b>{mode.label}</b>
              <span>{mode.detail}</span>
              {progressionLocked && <small>COMPLETE THE TRAINING SEQUENCE</small>}
              {!progressionLocked && unavailable && <small>RECALIBRATE BRIGHTNESS</small>}
            </button>
          );
        })}
      </div>

      {state.mode === "training" && (
        <Select
          label="Tutorial challenge"
          value={state.selectedCourseId}
          onChange={(event) => onSelectCourse(event.target.value)}
        >
          {VOCAL_FLIGHT_TUTORIALS.map((course) => (
            <option
              key={course.id}
              value={course.id}
              disabled={course.order > state.unlockedTutorialOrder
                || courseRequiresBrightness(course) && !calibration.brightnessAvailable}
            >
              {CHAPTER_LABELS[course.chapter]} · {course.discovery} · {course.title}
            </option>
          ))}
        </Select>
      )}

      <div className="vocal-flight-selected-course">
        <span><small>SELECTED FLIGHT</small><b>{selectedCourse?.title ?? selectedMode.label}</b></span>
        <p>{objective}</p>
        {brightnessNeeded && !calibration.brightnessAvailable && (
          <strong>This flight needs a demonstrated brightness axis. Pitch Tunnel, pitch tutorials, and pitch-only Free Flight remain available now.</strong>
        )}
      </div>

      <footer>
        <ActionButton data-flight-action="exit" onClick={onExit}>Exit game</ActionButton>
        <ActionButton data-flight-action="recalibrate" onClick={onRecalibrate}>Recalibrate</ActionButton>
        <ActionButton data-flight-action="start-flight" className="primary" disabled={!launchable} onClick={onLaunch}>Launch flight</ActionButton>
      </footer>
    </section>
  );
}
