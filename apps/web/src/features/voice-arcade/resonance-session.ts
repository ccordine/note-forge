import type { PitchObservation } from "@/audio/note-input";
import { clampPercent } from "@/lib/numeric";
import { observationContinuity } from "@/realtime/observation-continuity";
import {
  createResonanceController,
  toResonanceVoiceInput,
  updateResonanceControllerFromFrame,
  type ResonanceControllerState,
} from "./resonance-controller";
import {
  generateResonanceLevel,
  type GenerateResonanceLevelOptions,
  type GeneratedResonanceLevel,
} from "./resonance-level";
import {
  advanceResonanceGame,
} from "./resonance-physics";
import type {
  FrequencyTunedResonator,
  ResonanceGameState,
  ResonatorActivation,
} from "./resonance-types";
import { createResonanceGame } from "./resonance-world";
import {
  advanceResonanceRunStats,
  createResonanceRunStats,
  summarizeResonanceRun,
  type ResonanceResult,
  type ResonanceRunStats,
} from "./resonance-scoring";

export type ResonanceSessionPhase = "idle" | "tracking" | "complete";

export interface ResonanceTargetDwell {
  readonly targetId: string | null;
  readonly heldSamples: number;
  readonly sampleRate: number;
}

export interface ResonanceSessionState {
  readonly phase: ResonanceSessionPhase;
  readonly runSerial: number;
  readonly chamberNumber: number;
  readonly generated: GeneratedResonanceLevel;
  readonly game: ResonanceGameState;
  readonly controller: ResonanceControllerState;
  readonly stats: ResonanceRunStats;
  /** Exact score when the goal was first captured; never terminal authority. */
  readonly achievement: ResonanceResult | null;
  /** Whole-session score created only by explicit Finish. */
  readonly result: ResonanceResult | null;
  readonly targetDwell: ResonanceTargetDwell;
  readonly authorityBreakCount: number;
}

export type ResonanceSessionAction =
  | Readonly<{
      type: "install";
      chamberNumber: number;
      generated: GeneratedResonanceLevel;
    }>
  | Readonly<{ type: "start" }>
  | Readonly<{ type: "finish" }>
  | Readonly<{ type: "observation"; observation: Readonly<PitchObservation> }>;

export function focusedResonator(
  game: Readonly<ResonanceGameState>,
): FrequencyTunedResonator | null {
  return game.level.resonators.find((resonator) => (
    resonator.position.x >= game.ball.position.x
  )) ?? game.level.resonators.at(-1) ?? null;
}

export function goalProgressPercent(game: Readonly<ResonanceGameState>): number {
  const startX = game.level.ball.position.x;
  const goalX = game.level.goal.position.x;
  if (goalX <= startX) return game.status === "won" ? 100 : 0;
  return clampPercent(
    (game.ball.position.x - startX) / (goalX - startX) * 100,
  );
}

export function resonatorIsCoupled(
  controller: Readonly<ResonanceControllerState>,
  target: Readonly<FrequencyTunedResonator> | null,
  activation: Readonly<ResonatorActivation> | null | undefined,
): boolean {
  return controller.evidenceReliable
    && target !== null
    && activation?.resonatorId === target.id
    && activation.centsError !== null
    && Math.abs(activation.centsError) <= target.bandwidthCents
    && activation.effectiveEnergy > 0;
}

function emptyDwell(game: Readonly<ResonanceGameState>): ResonanceTargetDwell {
  return {
    targetId: focusedResonator(game)?.id ?? null,
    heldSamples: 0,
    sampleRate: 0,
  };
}

function sessionWithGame(
  phase: ResonanceSessionPhase,
  runSerial: number,
  chamberNumber: number,
  generated: Readonly<GeneratedResonanceLevel>,
): ResonanceSessionState {
  const game = createResonanceGame(generated.definition);
  return {
    phase,
    runSerial,
    chamberNumber,
    generated: generated as GeneratedResonanceLevel,
    game,
    controller: createResonanceController(),
    stats: createResonanceRunStats(game),
    achievement: null,
    result: null,
    targetDwell: emptyDwell(game),
    authorityBreakCount: 0,
  };
}

export function createResonanceSession(
  options: Readonly<GenerateResonanceLevelOptions>,
): ResonanceSessionState {
  return sessionWithGame("idle", 0, options.level ?? 1, generateResonanceLevel(options));
}

function updateDwell(
  current: Readonly<ResonanceTargetDwell>,
  target: Readonly<FrequencyTunedResonator> | null,
  controller: Readonly<ResonanceControllerState>,
  deltaSamples: number,
  sampleRate: number,
): ResonanceTargetDwell {
  if (current.targetId !== target?.id) {
    return { targetId: target?.id ?? null, heldSamples: 0, sampleRate };
  }
  if (!controller.evidenceReliable || controller.midiFloat === null || target === null) {
    return { ...current, sampleRate };
  }
  const inRange = Math.abs((controller.midiFloat - target.targetMidi) * 100)
    <= target.bandwidthCents;
  return {
    targetId: current.targetId,
    heldSamples: inRange ? current.heldSamples + deltaSamples : 0,
    sampleRate,
  };
}

function advanceFromObservation(
  state: Readonly<ResonanceSessionState>,
  observation: Readonly<PitchObservation>,
): ResonanceSessionState {
  if (state.phase !== "tracking") return state as ResonanceSessionState;
  const previousAuthority = state.controller.authority;
  const continuity = observationContinuity(previousAuthority, observation);
  if (!continuity.accepted) return state as ResonanceSessionState;
  const controllerUpdate = updateResonanceControllerFromFrame(state.controller, observation);
  if (controllerUpdate.duplicate) return state as ResonanceSessionState;

  const delta = {
    samples: continuity.deltaSamples,
    boundary: continuity.boundary,
  };
  const targetBeforeAdvance = focusedResonator(state.game);
  const voice = toResonanceVoiceInput(controllerUpdate.state);
  const physics = advanceResonanceGame(
    state.game,
    voice,
    delta.samples / observation.sampleRate,
  );
  let targetDwell = updateDwell(
    state.targetDwell,
    targetBeforeAdvance,
    controllerUpdate.state,
    delta.samples,
    observation.sampleRate,
  );
  const targetAfterAdvance = focusedResonator(physics.state);
  if (targetAfterAdvance?.id !== targetDwell.targetId) {
    targetDwell = {
      targetId: targetAfterAdvance?.id ?? null,
      heldSamples: 0,
      sampleRate: observation.sampleRate,
    };
  }
  const stats = advanceResonanceRunStats(state.stats, {
    previousGame: state.game,
    nextGame: physics.state,
    deltaSeconds: delta.samples / observation.sampleRate,
    coherence: controllerUpdate.state.coherence,
    reliable: controllerUpdate.accepted,
    targetResonatorId: targetBeforeAdvance?.id ?? null,
  });
  const achievement = state.achievement ?? (
    physics.wonThisAdvance ? summarizeResonanceRun(physics.state, stats) : null
  );
  return {
    ...state,
    // Capturing the goal latches an achievement snapshot. It never owns the
    // user-started chamber lifetime or stops the controller/physics reducers.
    phase: "tracking",
    game: physics.state,
    controller: controllerUpdate.state,
    stats,
    achievement,
    targetDwell,
    authorityBreakCount: state.authorityBreakCount + (delta.boundary ? 1 : 0),
  };
}

export function reduceResonanceSession(
  state: Readonly<ResonanceSessionState>,
  action: Readonly<ResonanceSessionAction>,
): ResonanceSessionState {
  switch (action.type) {
    case "install":
      return state.phase === "tracking"
        ? state as ResonanceSessionState
        : sessionWithGame("idle", state.runSerial, action.chamberNumber, action.generated);
    case "start":
      return state.phase === "idle" || state.phase === "complete"
        ? {
            ...sessionWithGame("tracking", state.runSerial + 1, state.chamberNumber, state.generated),
            // Keep the user-owned active transition explicit at the reducer
            // boundary so lifetime authority is statically auditable.
            phase: "tracking",
          }
        : state as ResonanceSessionState;
    case "finish":
      return state.phase === "tracking"
        ? {
            ...state,
            phase: "complete",
            result: summarizeResonanceRun(state.game, state.stats),
          }
        : state as ResonanceSessionState;
    case "observation":
      return advanceFromObservation(state, action.observation);
  }
}

export function resonanceHeldSeconds(state: Readonly<ResonanceSessionState>): number {
  return state.targetDwell.sampleRate > 0
    ? state.targetDwell.heldSamples / state.targetDwell.sampleRate
    : 0;
}
