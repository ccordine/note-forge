import { useRef, type ReactNode } from "react";
import type { ArcadeGameProps } from "../types";
import { VocalControlReticle } from "./VocalControlReticle";
import { VocalFlightCalibration } from "./VocalFlightCalibration";
import { VocalFlightCanvas } from "./VocalFlightCanvas";
import { VocalFlightHud } from "./VocalFlightHud";
import { VocalFlightLoadout } from "./VocalFlightLoadout";
import { VocalFlightResult } from "./VocalFlightResult";
import { useVocalFlight } from "./use-vocal-flight";
import { getVocalFlightMode } from "./vocal-flight-modes";
import { provisionalVocalControlGeometry } from "./provisional-control-geometry";

function overlay(
  runtime: ReturnType<typeof useVocalFlight>,
  onExit: () => void,
): ReactNode {
  const { input, state } = runtime;
  if (state.phase === "complete" && state.result !== null) {
    return (
      <VocalFlightResult
        state={state}
        onFlyAgain={runtime.returnToLoadout}
        onRecalibrate={runtime.recalibrate}
        onExit={onExit}
      />
    );
  }
  if (state.phase !== "calibration") return null;
  if (state.calibration.stage === "complete") {
    return (
      <VocalFlightLoadout
        state={state}
        onSelectMode={runtime.selectMode}
        onSelectCourse={runtime.selectCourse}
        onLaunch={runtime.launch}
        onRecalibrate={runtime.recalibrate}
        onExit={onExit}
      />
    );
  }
  return (
    <VocalFlightCalibration
      state={state}
      inputState={input.state}
      onBeginSample={runtime.beginCalibrationSample}
      onNext={runtime.nextCalibrationStage}
      onBack={runtime.previousCalibrationStage}
      onResetStage={runtime.resetCalibrationStage}
      onContinuePitchOnly={runtime.continuePitchOnly}
      onExit={onExit}
    />
  );
}

export function VocalFlight(props: ArcadeGameProps) {
  const runtime = useVocalFlight(props);
  const { input, state } = runtime;
  const publicationCountRef = useRef(0);
  publicationCountRef.current += 1;
  const discoveryCourse = state.course?.definition.discovery === "discovery";
  const modeCourse = getVocalFlightMode(state.mode).course;
  const challengeId = state.course?.definition.id
    ?? (state.mode === "training" ? state.selectedCourseId : modeCourse?.id ?? "free-flight");
  const expandedController = state.phase === "calibration"
    || props.curriculumStage === "deliberate" && discoveryCourse;
  const calibration = state.calibration.result;
  const controlGeometry = calibration ?? provisionalVocalControlGeometry(state.calibration);

  return (
    <section
      className={`arcade-game-shell vocal-flight-shell phase-${state.phase}`}
      data-vocal-flight
      data-phase={state.phase}
      data-input-state={input.state}
      data-observation-kind={state.telemetry?.observationKind ?? "absent"}
      data-calibration-stage={state.calibration.stage}
      data-calibration-recording={state.calibrationRecording ? "true" : "false"}
      data-calibration-complete={calibration === null ? "false" : "true"}
      data-calibration-brightness={calibration?.brightnessAvailable ? "available" : "unavailable"}
      data-calibration-center-midi={calibration?.centerMidi ?? ""}
      data-calibration-center-brightness={calibration?.centerBrightness ?? ""}
      data-calibration-pitch-lower={calibration?.pitchLowerCents ?? ""}
      data-calibration-pitch-upper={calibration?.pitchUpperCents ?? ""}
      data-calibration-brightness-darker={calibration?.brightnessDarkerDelta ?? ""}
      data-calibration-brightness-brighter={calibration?.brightnessBrighterDelta ?? ""}
      data-flight-mode={state.mode}
      data-flight-challenge={challengeId}
      data-observed-frames={state.observedFrameCount}
      data-simulated-frames={state.simulatedFrameCount}
      data-fixed-steps={state.flight.fixedStepCount}
      data-react-publications={publicationCountRef.current}
      data-start-sample={state.telemetry?.startSample ?? ""}
      data-end-sample={state.telemetry?.endSample ?? ""}
      data-sample-rate={state.telemetry?.sampleRate ?? ""}
      data-processed-samples={state.telemetry?.processedSampleCount ?? ""}
      data-worklet-processes={state.telemetry?.workletProcessCount ?? ""}
      data-capture-epoch={state.telemetry?.captureEpoch ?? ""}
      data-continuity-epoch={state.telemetry?.continuityEpoch ?? ""}
      data-graph-generation={state.telemetry?.graphGeneration ?? ""}
      data-discontinuity={state.telemetry?.discontinuity ? "true" : "false"}
      data-pitch-axis={state.vector.pitchAxis.toFixed(6)}
      data-brightness-axis={state.vector.brightnessAxis.toFixed(6)}
      data-pitch-confidence={state.vector.pitchConfidence.toFixed(6)}
      data-brightness-confidence={state.vector.brightnessConfidence.toFixed(6)}
      data-control-active={state.vector.active ? "true" : "false"}
      data-control-voiced={state.vector.voiced ? "true" : "false"}
      data-aircraft-x={state.flight.position.x.toFixed(6)}
      data-aircraft-y={state.flight.position.y.toFixed(6)}
      data-aircraft-z={state.flight.position.z.toFixed(6)}
      data-aircraft-pitch={state.flight.pitchRadians.toFixed(6)}
      data-aircraft-roll={state.flight.rollRadians.toFixed(6)}
      data-aircraft-yaw={state.flight.headingRadians.toFixed(6)}
      data-aircraft-pitch-rate={state.flight.pitchRate.toFixed(6)}
      data-aircraft-roll-rate={state.flight.rollRate.toFixed(6)}
      data-aircraft-yaw-rate={state.flight.yawRate.toFixed(6)}
      data-flight-elapsed-seconds={state.flight.elapsedSeconds.toFixed(6)}
      data-flight-distance={state.flight.distanceTraveled.toFixed(6)}
    >
      <VocalFlightHud
        state={state}
        inputState={input.state}
        onFinish={runtime.finish}
      />

      <div className="vocal-flight-stage">
        <VocalFlightCanvas getScene={runtime.getScene} />
        <aside
          className={`vocal-flight-controller ${expandedController ? "is-expanded" : "is-compact"}`}
          aria-label="Vocal joystick"
        >
          <span>VOCAL CONTROL VECTOR</span>
          <VocalControlReticle
            vector={state.vector}
            calibration={controlGeometry}
            expanded={expandedController}
            showValues={props.curriculumStage !== "background"}
          />
          <small>Y · relative pitch cents</small>
          <small>X · pitch-relative brightness</small>
        </aside>
        {overlay(runtime, props.onExit)}
      </div>

      <footer className="vocal-flight-provenance">
        Your voice controls relative pitch and vocal color. Loudness never earns control or score.
      </footer>
    </section>
  );
}
