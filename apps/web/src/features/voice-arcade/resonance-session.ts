import type { PitchObservation } from "@/audio/note-input";
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
  | Readonly<{ type: "restart" }>
  | Readonly<{ type: "observation"; observation: Readonly<PitchObservation> }>;

const ANALYSIS_HOP_SECONDS = 0.02;

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
  return Math.min(100, Math.max(
    0,
    (game.ball.position.x - startX) / (goalX - startX) * 100,
  ));
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

function sampleDelta(
  previous: Readonly<ResonanceControllerState>["authority"],
  frame: Readonly<PitchObservation>,
  authorityChanged: boolean,
): Readonly<{ samples: number; boundary: boolean }> {
  if (previous === null || authorityChanged) return { samples: 0, boundary: true };
  const delta = frame.endSample - previous.endSample;
  const expectedHop = Math.round(frame.sampleRate * ANALYSIS_HOP_SECONDS);
  if (delta !== expectedHop) return { samples: 0, boundary: true };
  return { samples: delta, boundary: false };
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
  const controllerUpdate = updateResonanceControllerFromFrame(state.controller, observation);
  if (controllerUpdate.duplicate) return state as ResonanceSessionState;

  const delta = sampleDelta(
    previousAuthority,
    observation,
    controllerUpdate.authorityChanged,
  );
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
  const complete = physics.wonThisAdvance || physics.state.status === "won";
  return {
    ...state,
    phase: complete ? "complete" : "tracking",
    game: physics.state,
    controller: controllerUpdate.state,
    stats,
    result: complete ? summarizeResonanceRun(physics.state, stats) : null,
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
      return sessionWithGame("tracking", state.runSerial + 1, action.chamberNumber, action.generated);
    case "restart":
      return sessionWithGame("tracking", state.runSerial + 1, state.chamberNumber, state.generated);
    case "observation":
      return advanceFromObservation(state, action.observation);
  }
}

export function resonanceHeldSeconds(state: Readonly<ResonanceSessionState>): number {
  return state.targetDwell.sampleRate > 0
    ? state.targetDwell.heldSamples / state.targetDwell.sampleRate
    : 0;
}
