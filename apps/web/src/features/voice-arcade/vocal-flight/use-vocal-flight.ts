import { useCallback } from "react";
import { useAudioInput } from "@/audio/use-audio-input";
import { useRealtimeSession } from "@/realtime/use-realtime-session";
import type { RealtimePresentationPolicy } from "@/realtime/realtime-session-store";
import { sameObservationStream } from "@/realtime/observation-continuity";
import { useArcadeOutcomeHandoff } from "../use-arcade-outcome";
import type { ArcadeGameProps, ArcadeOutcome } from "../types";
import {
  canLaunchVocalFlight,
  createVocalFlightSession,
  reduceVocalFlightSession,
  type VocalFlightSessionAction,
  type VocalFlightSessionState,
} from "./vocal-flight-session";
import type { VocalFlightGameMode } from "./vocal-flight-modes";
import type { VocalFlightRenderScene } from "./vocal-flight-renderer";

function authorityChanged(
  previous: Readonly<VocalFlightSessionState>,
  next: Readonly<VocalFlightSessionState>,
): boolean {
  const before = previous.control?.lastAuthority;
  const after = next.control?.lastAuthority;
  if (before === null || before === undefined || after === null || after === undefined) return false;
  return !sameObservationStream(before, after);
}

export const VOCAL_FLIGHT_PRESENTATION_POLICY = Object.freeze({
  shouldPublishImmediately: (
    previous: Readonly<VocalFlightSessionState>,
    next: Readonly<VocalFlightSessionState>,
    action: Readonly<VocalFlightSessionAction>,
  ) => previous.phase !== next.phase
    || previous.calibration.stage !== next.calibration.stage
    || previous.achievementResult !== next.achievementResult
    || previous.result !== next.result
    || previous.course?.nextGateIndex !== next.course?.nextGateIndex
    || previous.telemetry?.observationKind !== next.telemetry?.observationKind
    || authorityChanged(previous, next)
    || action.type === "observation" && action.sample.discontinuity,
}) satisfies RealtimePresentationPolicy<VocalFlightSessionState, VocalFlightSessionAction>;

function outcomeFor(
  state: Readonly<VocalFlightSessionState>,
  curriculumStage: ArcadeGameProps["curriculumStage"],
): ArcadeOutcome | null {
  const result = state.result;
  if (result === null || state.completedRunId === null || state.mode === "free-flight") return null;
  const presetMultiplier = state.difficulty === "hard" ? 1.4 : state.difficulty === "medium" ? 1.18 : 1;
  return {
    mode: "flight",
    curriculumStage,
    variant: state.mode === "training" ? state.selectedCourseId : state.mode,
    completedVariant: state.mode === "training" && state.course?.status === "complete"
      ? state.selectedCourseId
      : undefined,
    score: result.score,
    grade: result.grade,
    xp: Math.round(result.score * presetMultiplier),
    accuracy: result.courseAccuracyPercent,
    bestCombo: state.course?.gatesPassed ?? state.course?.centerRecoveries ?? 0,
    durationMs: Math.round(result.scoredSeconds * 1_000),
    details: {
      smoothnessPercent: result.smoothnessPercent,
      overshootCount: result.overshootCount,
      centerRecoveryPercent: result.centerRecoveryPercent ?? undefined,
      axisIndependencePercent: result.axisIndependencePercent ?? undefined,
      pitchTaskBrightnessLeak: result.pitchTaskBrightnessLeak ?? undefined,
      brightnessTaskPitchDriftCents: result.brightnessTaskPitchDriftCents ?? undefined,
      controlEfficiencyPercent: result.controlEfficiencyPercent,
      timeEfficiencyPercent: result.timeEfficiencyPercent ?? undefined,
      gatesPassed: state.course?.gatesPassed,
      gatesMissed: state.course?.gatesMissed,
      detectorObservations: state.observedFrameCount,
      simulatedObservations: state.simulatedFrameCount,
    },
  };
}

export function useVocalFlight(props: ArcadeGameProps) {
  const realtime = useRealtimeSession(
    reduceVocalFlightSession,
    () => createVocalFlightSession(props.difficulty, props.completedVariants),
    24,
    VOCAL_FLIGHT_PRESENTATION_POLICY,
  );
  const state = realtime.state;
  const input = useAudioInput({
    onFrame: (observation) => realtime.observe({ type: "observation", sample: observation }),
  });
  const outcome = outcomeFor(state, props.curriculumStage);
  useArcadeOutcomeHandoff(state.completedRunId, outcome, props.onComplete);

  const getScene = useCallback((): Readonly<VocalFlightRenderScene> => {
    const current = realtime.getCurrent();
    const linkState: VocalFlightRenderScene["linkState"] = input.state === "disabled"
      ? "voice-off"
      : input.state === "opening"
        ? "opening"
        : input.state === "error"
          ? "error"
          : current.phase === "calibration" && current.calibration.stage !== "complete"
            ? "calibrating"
            : current.phase !== "flying"
              ? "ready"
              : "silence";
    return {
      flight: current.flight,
      course: current.course,
      control: current.vector,
      linkState,
    };
  }, [input.state, realtime.getCurrent]);

  return {
    input,
    state,
    getScene,
    canLaunch: canLaunchVocalFlight(state),
    beginCalibrationSample: () => realtime.dispatch({ type: "record-calibration" }),
    nextCalibrationStage: () => realtime.dispatch({ type: "calibration-next" }),
    previousCalibrationStage: () => realtime.dispatch({ type: "calibration-back" }),
    resetCalibrationStage: () => realtime.dispatch({ type: "calibration-reset-stage" }),
    continuePitchOnly: () => realtime.dispatch({ type: "skip-brightness" }),
    selectMode: (mode: VocalFlightGameMode) => realtime.dispatch({ type: "select-mode", mode }),
    selectCourse: (courseId: string) => realtime.dispatch({ type: "select-course", courseId }),
    launch: () => realtime.dispatch({ type: "launch" }),
    finish: () => realtime.dispatch({ type: "finish" }),
    returnToLoadout: () => realtime.dispatch({ type: "return-loadout" }),
    recalibrate: () => realtime.dispatch({ type: "recalibrate" }),
  };
}
