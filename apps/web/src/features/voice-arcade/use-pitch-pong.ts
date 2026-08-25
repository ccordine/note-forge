import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { useAudioInput } from "@/audio/use-audio-input";
import {
  PitchPongRuntime,
} from "./pitch-pong-runtime";
import { getDifficultyPreset } from "./model";
import { createPitchPongSpec } from "./pitch-pong-session";
import type { ArcadeGameProps } from "./types";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** React subscribes to one bounded runtime snapshot; detector callbacks stay imperative. */
export function usePitchPongRuntime({
  difficulty,
  curriculumStage,
  voiceRange,
  onComplete,
}: ArcadeGameProps) {
  const spec = useMemo(() => createPitchPongSpec({
    difficulty,
    curriculumStage,
    voiceRange,
  }), [
    curriculumStage,
    difficulty,
    voiceRange.baselineMidi,
    voiceRange.highMidi,
    voiceRange.lowMidi,
  ]);
  const runtime = useMemo(
    () => new PitchPongRuntime(spec, onComplete),
    [onComplete, spec],
  );
  const state = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const input = useAudioInput({ onFrame: runtime.observe });

  useEffect(() => {
    return () => {
      runtime.dispose();
    };
  }, [runtime]);

  const courtVariables = {
    "--pong-ball-x": `${state.game.ball.x * 100}%`,
    "--pong-ball-y": `${state.game.ball.y * 100}%`,
    "--pong-player-y": `${state.game.playerPaddleY * 100}%`,
    "--pong-opponent-y": `${state.game.opponentPaddleY * 100}%`,
    "--pong-player-x": `${state.game.config.playerPaddleX * 100}%`,
    "--pong-opponent-x": `${state.game.config.opponentPaddleX * 100}%`,
    "--pong-paddle-height": `${state.game.config.paddleHeight * 100}%`,
    "--pong-paddle-width": `${state.game.config.paddleWidth * 100}%`,
    "--pong-ball-diameter": `${state.game.config.ballRadius * 200}%`,
  } as CSSProperties;
  const rangeLabels = [
    voiceRange.highMidi,
    (voiceRange.highMidi + spec.controllerCenterMidi) / 2,
    spec.controllerCenterMidi,
    (voiceRange.lowMidi + spec.controllerCenterMidi) / 2,
    voiceRange.lowMidi,
  ].filter((_, index) => spec.curriculum.feedback.rangeLabelDensity === "full"
    || spec.curriculum.feedback.rangeLabelDensity === "anchors"
      && (index === 0 || index === 2 || index === 4));

  return {
    cancelBeforePlay: runtime.cancel,
    controllerCenterMidi: spec.controllerCenterMidi,
    countdown: state.countdown,
    courtVariables,
    currentGame: state.game,
    curriculum: spec.curriculum,
    endActiveRound: runtime.finish,
    input,
    achievementCount: state.achievementCount,
    latestAchievement: state.latestAchievement,
    maximumRally: state.stats.maximumRally,
    maximumRallyPercent: clamp(state.stats.maximumRally / 10 * 100, 0, 100),
    phase: state.phase,
    preset: getDifficultyPreset(difficulty),
    rangeLabels,
    resetToSetup: runtime.reset,
    result: state.result,
    scoreFlash: state.scoreFlash,
    startRound: runtime.start,
    status: state.status,
  };
}
