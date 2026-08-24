import type { AudioInputState } from "@/audio/use-audio-input";
import { ActionButton, Eyebrow } from "@/ui/Controls";
import { vocalCalibrationReadiness, type VocalCalibrationStage } from "./calibration";
import type { VocalFlightSessionState } from "./vocal-flight-session";

interface CalibrationCopy {
  readonly stage: string;
  readonly title: string;
  readonly instruction: string;
  readonly sampleLabel: string;
  readonly acceptLabel: string;
}

const CALIBRATION_COPY = Object.freeze({
  neutral: Object.freeze({
    stage: "A · NEUTRAL CENTER",
    title: "Give the joystick a center.",
    instruction: "Use one comfortable, unforced oo or mm. Let pitch and vocal color settle without making the sound louder for the game.",
    sampleLabel: "Sample center",
    acceptLabel: "Keep this center",
  }),
  "pitch-upper": Object.freeze({
    stage: "B · VERTICAL EXTENT",
    title: "Explore comfortably higher.",
    instruction: "Glide above center and hold a comfortable plateau. This is control space, not a highest-note test.",
    sampleLabel: "Sample upper space",
    acceptLabel: "Keep upper extent",
  }),
  "pitch-lower": Object.freeze({
    stage: "B · VERTICAL EXTENT",
    title: "Explore comfortably lower.",
    instruction: "Glide below center and settle. Stop well before strain; asymmetric range is expected.",
    sampleLabel: "Sample lower space",
    acceptLabel: "Keep lower extent",
  }),
  "brightness-dark": Object.freeze({
    stage: "C · HORIZONTAL EXTENT",
    title: "Make the same pitch darker.",
    instruction: "Keep F0 near center while making the sound rounder or darker. The reticle exposes any pitch coupling honestly.",
    sampleLabel: "Sample darker space",
    acceptLabel: "Keep darker extent",
  }),
  "brightness-bright": Object.freeze({
    stage: "C · HORIZONTAL EXTENT",
    title: "Make the same pitch brighter.",
    instruction: "Keep F0 near center while moving the sound brighter or more forward. Loudness is diagnostic only.",
    sampleLabel: "Sample brighter space",
    acceptLabel: "Keep brighter extent",
  }),
  "center-recovery": Object.freeze({
    stage: "D · CENTER RECOVERY",
    title: "Release the acoustic joystick.",
    instruction: "Move away, then vocally return to the center three times. Silence neutralizes controls safely but does not count as a center recovery.",
    sampleLabel: "Begin recoveries",
    acceptLabel: "Use this control space",
  }),
} satisfies Readonly<Record<Exclude<VocalCalibrationStage, "complete">, CalibrationCopy>>);

const STAGE_ORDER: readonly Exclude<VocalCalibrationStage, "complete">[] = Object.freeze([
  "neutral",
  "pitch-upper",
  "pitch-lower",
  "brightness-dark",
  "brightness-bright",
  "center-recovery",
]);

interface VocalFlightCalibrationProps {
  readonly state: Readonly<VocalFlightSessionState>;
  readonly inputState: AudioInputState;
  readonly onBeginSample: () => void;
  readonly onNext: () => void;
  readonly onBack: () => void;
  readonly onResetStage: () => void;
  readonly onContinuePitchOnly: () => void;
  readonly onExit: () => void;
}

function observationMessage(state: Readonly<VocalFlightSessionState>): string {
  if (state.telemetry === null) return "No derived observation has arrived yet.";
  if (state.telemetry.observationKind === "unvoiced") return "Silence is normal. Produce the requested sound when ready.";
  if (state.telemetry.observationKind === "uncertain") return "This window is uncertain; it contributes no calibration evidence.";
  return "Voiced pitch and shared brightness evidence are arriving continuously.";
}

function inputMessage(inputState: AudioInputState): string | null {
  if (inputState === "disabled") return "Voice input is off. Enable voice once in the global header to calibrate.";
  if (inputState === "opening") return "Voice input is opening. Calibration begins as soon as live evidence arrives.";
  if (inputState === "error") return "Voice input needs attention in the global header.";
  return null;
}

function dbfs(rms: number): string {
  if (rms <= 0) return "−∞ dBFS";
  return `${(20 * Math.log10(rms)).toFixed(1)} dBFS`;
}

function captureAction(stage: Exclude<VocalCalibrationStage, "complete">): string {
  if (stage === "pitch-upper") return "capture-upper";
  if (stage === "pitch-lower") return "capture-lower";
  if (stage === "brightness-dark") return "capture-dark";
  if (stage === "brightness-bright") return "capture-bright";
  if (stage === "center-recovery") return "capture-center-recovery";
  return "capture-neutral";
}

export function VocalFlightCalibration({
  state,
  inputState,
  onBeginSample,
  onNext,
  onBack,
  onResetStage,
  onContinuePitchOnly,
  onExit,
}: VocalFlightCalibrationProps) {
  const stage = state.calibration.stage as Exclude<VocalCalibrationStage, "complete">;
  const copy = CALIBRATION_COPY[stage];
  const stageIndex = STAGE_ORDER.indexOf(stage);
  const readiness = vocalCalibrationReadiness(state.calibration);
  const inputNotice = inputMessage(inputState);
  const canRecord = inputState === "running";
  const canAccept = state.calibrationRecording && readiness.ready;
  let actionLabel: string = copy.sampleLabel;
  if (state.calibrationRecording) actionLabel = canAccept ? copy.acceptLabel : "Keep exploring…";
  const handlePrimary = canAccept ? onNext : onBeginSample;
  const disabled = !canRecord || state.calibrationRecording && !canAccept;
  const canChoosePitchOnly = state.calibrationRecording
    && (stage === "brightness-dark" || stage === "brightness-bright")
    && state.calibration.stageAttemptSeconds >= 3
    && !readiness.ready;
  const frequency = state.telemetry?.frequencyHz;
  const brightness = state.telemetry?.brightness;
  const rms = state.telemetry?.rms ?? 0;

  return (
    <section className="vocal-flight-overlay vocal-flight-calibration" aria-labelledby="vocal-flight-step-title">
      <header>
        <Eyebrow>{copy.stage} · STEP {stageIndex + 1} OF {STAGE_ORDER.length}</Eyebrow>
        <h1 id="vocal-flight-step-title">{copy.title}</h1>
        <p>{copy.instruction}</p>
      </header>

      <div className="vocal-flight-calibration-status">
        <b>{state.calibrationRecording
          ? `${state.calibration.stageQualifiedSeconds.toFixed(1)} s qualified · ${state.calibration.stageAttemptSeconds.toFixed(1)} s explored`
          : "Ready when you are"}</b>
        <span>{state.calibration.validationMessage ?? readiness.message ?? observationMessage(state)}</span>
      </div>

      {inputNotice && <div className="vocal-flight-input-notice" role="status">{inputNotice}</div>}

      <footer>
        <ActionButton data-flight-action="exit" onClick={onExit}>Exit game</ActionButton>
        {stageIndex > 0 && <ActionButton data-flight-action="calibration-back" onClick={onBack}>Previous step</ActionButton>}
        {state.calibrationRecording && <ActionButton data-flight-action="calibration-retry" onClick={onResetStage}>Retry this step</ActionButton>}
        {canChoosePitchOnly && <ActionButton data-flight-action="continue-pitch-only" onClick={onContinuePitchOnly}>Continue pitch-only</ActionButton>}
        <ActionButton data-flight-action={captureAction(stage)} className="primary" disabled={disabled} onClick={handlePrimary}>{actionLabel}</ActionButton>
      </footer>

      <details className="vocal-flight-calibration-diagnostics">
        <summary>Live derived diagnostics</summary>
        <div className="vocal-flight-calibration-evidence" aria-live="polite">
          <span><small>F0</small><b>{frequency === null || frequency === undefined ? "—" : `${frequency.toFixed(1)} Hz`}</b></span>
          <span><small>BRIGHTNESS</small><b>{brightness === null || brightness === undefined ? "—" : brightness.toFixed(3)}</b></span>
          <span><small>CONFIDENCE</small><b>{Math.round((state.telemetry?.confidence ?? 0) * 100)}%</b></span>
          <span><small>LEVEL · DIAGNOSTIC</small><b>{dbfs(rms)}</b></span>
        </div>
      </details>
    </section>
  );
}
