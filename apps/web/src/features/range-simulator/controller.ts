import type { PitchObservation } from "@/audio/note-input";
import {
  createRangeDwell,
  updateRangeDwell,
  type RangeDwellState,
} from "@/features/range-loop/range-dwell";
import {
  createDefaultRangeProfile,
  type PersonalRangeProfile,
} from "@/features/range-loop/profile";
import {
  EFFORT_RATING_LABELS,
  createRangeSimulatorSession,
  currentRangeSimulatorProbe,
  rateRangeSimulatorProbe,
  stopRangeSimulatorSession,
  type EffortRating,
  type RangePreparation,
  type RangeSimulatorSessionState,
} from "./model";
import { projectRangeSimulatorProfile, summarizeRangeSimulatorSession } from "./summary";

export const RANGE_SIMULATOR_HOLD_SECONDS = 1.5;

export type RangeSimulatorStatus = "idle" | "tracking" | "complete";

export interface RangeSimulatorControllerState {
  readonly status: RangeSimulatorStatus;
  readonly session: RangeSimulatorSessionState;
  readonly profile: PersonalRangeProfile;
  readonly dwell: RangeDwellState;
  readonly rating: EffortRating | null;
  readonly coordinationChange: boolean;
  readonly notice: string;
  /** Changes only when persistent session/profile data changes, never per PCM frame. */
  readonly persistenceRevision: number;
}

export type RangeSimulatorControllerAction =
  | {
      readonly type: "hydrate";
      readonly session: RangeSimulatorSessionState;
      readonly profile: PersonalRangeProfile;
      readonly toleranceCents: number;
    }
  | { readonly type: "begin"; readonly toleranceCents: number }
  | { readonly type: "observation"; readonly observation: Readonly<PitchObservation> }
  | { readonly type: "select-rating"; readonly rating: EffortRating }
  | { readonly type: "set-coordination"; readonly value: boolean }
  | { readonly type: "retry"; readonly toleranceCents: number }
  | { readonly type: "save-rating"; readonly ratedAt: string; readonly toleranceCents: number }
  | { readonly type: "finish"; readonly stoppedAt: string }
  | {
      readonly type: "recheck";
      readonly startedAt: string;
      readonly toleranceCents: number;
    }
  | {
      readonly type: "fresh";
      readonly anchorMidi: number;
      readonly preparation: RangePreparation;
      readonly startedAt: string;
      readonly toleranceCents: number;
    };

function targetMidiForSession(session: Readonly<RangeSimulatorSessionState>): number {
  const current = currentRangeSimulatorProbe(session);
  const latest = session.observations.at(-1)?.task.midi;
  return current?.midi ?? latest ?? session.baselineMidi ?? session.anchorMidi;
}

function createDwellForSession(
  session: Readonly<RangeSimulatorSessionState>,
  toleranceCents: number,
): RangeDwellState {
  return createRangeDwell({
    targetMidi: targetMidiForSession(session),
    toleranceCents,
    requiredHoldSeconds: RANGE_SIMULATOR_HOLD_SECONDS,
  });
}

function completionNotice(session: Readonly<RangeSimulatorSessionState>): string {
  const summary = summarizeRangeSimulatorSession(session);
  const { lowMidi, highMidi } = summary.usableBounds;
  if (lowMidi === null || highMidi === null) {
    return "Check complete without claiming a usable boundary. The result records only what you actually rated.";
  }
  return `Range check complete with ${summary.usableMidis.length} contiguous usable notes in today’s map.`;
}

function nextProbeNotice(
  rating: EffortRating,
  nextSession: Readonly<RangeSimulatorSessionState>,
): string {
  const next = currentRangeSimulatorProbe(nextSession);
  const saved = `${EFFORT_RATING_LABELS[rating].label} rating saved.`;
  if (!next) return saved;
  if (nextSession.phase === "probing" && next.kind === "initial" && next.direction === "center") {
    return `${saved} The working home is set; continue outward one note at a time.`;
  }
  return `${saved} Continue with the next displayed target.`;
}

export function createRangeSimulatorController(options: {
  readonly startedAt: string;
  readonly toleranceCents: number;
  readonly anchorMidi?: number;
  readonly preparation?: RangePreparation;
  readonly profile?: PersonalRangeProfile;
}): RangeSimulatorControllerState {
  const session = createRangeSimulatorSession({
    startedAt: options.startedAt,
    anchorMidi: options.anchorMidi,
    preparation: options.preparation,
    sessionId: `range-map-${new Date(options.startedAt).toISOString()}`,
  });
  return {
    status: "idle",
    session,
    profile: options.profile ?? createDefaultRangeProfile(),
    dwell: createDwellForSession(session, options.toleranceCents),
    rating: null,
    coordinationChange: false,
    notice: "Choose today’s starting area, then begin. Live input remains continuous throughout the check.",
    persistenceRevision: 0,
  };
}

export function canRateRangeProbe(state: Readonly<RangeSimulatorControllerState>): boolean {
  return state.status === "tracking"
    && currentRangeSimulatorProbe(state.session) !== null
    && (state.dwell.achievementReached || state.rating === 4 || state.rating === 5);
}

function hydrateController(
  action: Extract<RangeSimulatorControllerAction, { type: "hydrate" }>,
): RangeSimulatorControllerState {
  const explicitlyFinished = action.session.completionStatus === "stopped";
  const achievementReached = action.session.phase === "complete" && !explicitlyFinished;
  let notice = action.session.ratedProbeCount > 0
    ? "Saved progress is ready. Continue from the next target when you choose."
    : "Choose today’s starting area, then begin. Live input remains continuous throughout the check.";
  if (achievementReached) {
    notice = `${completionNotice(action.session)} Press Start saved assessment to make the live pitch surface authoritative again.`;
  }
  if (explicitlyFinished) notice = completionNotice(action.session);
  return {
    // Loading persisted achievement/configuration never starts a live session.
    status: explicitlyFinished ? "complete" : "idle",
    session: action.session,
    profile: action.profile,
    dwell: createDwellForSession(action.session, action.toleranceCents),
    rating: null,
    coordinationChange: false,
    notice,
    persistenceRevision: 0,
  };
}

function saveCurrentRating(
  state: Readonly<RangeSimulatorControllerState>,
  action: Extract<RangeSimulatorControllerAction, { type: "save-rating" }>,
): RangeSimulatorControllerState {
  const current = currentRangeSimulatorProbe(state.session);
  if (!current || state.rating === null || !canRateRangeProbe(state)) return state as RangeSimulatorControllerState;
  const nextSession = rateRangeSimulatorProbe(state.session, {
    taskId: current.id,
    rating: state.rating,
    coordinationChange: state.coordinationChange,
    ratedAt: action.ratedAt,
  });
  const achievementReached = nextSession.phase === "complete";
  return {
    ...state,
    // Exhausting the probe queue records an assessment achievement. It is not
    // authority to end the user-started live workspace.
    status: "tracking",
    session: nextSession,
    profile: achievementReached ? projectRangeSimulatorProfile(state.profile, nextSession) : state.profile,
    dwell: achievementReached ? state.dwell : createDwellForSession(nextSession, action.toleranceCents),
    rating: null,
    coordinationChange: false,
    notice: achievementReached
      ? `${completionNotice(nextSession)} The live pitch surface remains active until you choose Finish today.`
      : nextProbeNotice(state.rating, nextSession),
    persistenceRevision: state.persistenceRevision + 1,
  };
}

function finishController(
  state: Readonly<RangeSimulatorControllerState>,
  stoppedAt: string,
): RangeSimulatorControllerState {
  if (state.status === "complete") return state as RangeSimulatorControllerState;
  const session = stopRangeSimulatorSession(state.session, stoppedAt);
  return {
    ...state,
    status: "complete",
    session,
    // Explicitly finishing an incomplete assessment must not replace a
    // previously established full voice map with only today's partial probes.
    // A naturally completed assessment was already projected when its final
    // rating established both boundaries.
    profile: state.profile,
    rating: null,
    coordinationChange: false,
    notice: completionNotice(session),
    persistenceRevision: state.persistenceRevision + 1,
  };
}

export function reduceRangeSimulatorController(
  state: Readonly<RangeSimulatorControllerState>,
  action: Readonly<RangeSimulatorControllerAction>,
): RangeSimulatorControllerState {
  switch (action.type) {
    case "hydrate":
      return hydrateController(action);
    case "begin":
      if (state.status !== "idle") return state as RangeSimulatorControllerState;
      return {
        ...state,
        status: "tracking",
        dwell: createDwellForSession(state.session, action.toleranceCents),
        notice: "Sing the current target. Qualified time comes only from continuous PCM sample coordinates.",
      };
    case "observation": {
      if (state.status !== "tracking") return state as RangeSimulatorControllerState;
      const dwell = updateRangeDwell(state.dwell, action.observation);
      if (dwell === state.dwell) return state as RangeSimulatorControllerState;
      return {
        ...state,
        dwell,
        notice: !state.dwell.achievementReached && dwell.achievementReached
          ? "Pitch hold confirmed. Rate comfort and repeatability to advance."
          : state.notice,
      };
    }
    case "select-rating":
      if (state.status !== "tracking") return state as RangeSimulatorControllerState;
      if (!state.dwell.achievementReached && action.rating < 4) return state as RangeSimulatorControllerState;
      return { ...state, rating: action.rating };
    case "set-coordination":
      return state.status === "tracking"
        ? { ...state, coordinationChange: action.value }
        : state as RangeSimulatorControllerState;
    case "retry":
      if (state.status !== "tracking") return state as RangeSimulatorControllerState;
      return {
        ...state,
        dwell: createDwellForSession(state.session, action.toleranceCents),
        rating: null,
        coordinationChange: false,
        notice: "Retrying the same target. Existing saved ratings are unchanged.",
      };
    case "save-rating":
      return saveCurrentRating(state, action);
    case "finish":
      return finishController(state, action.stoppedAt);
    case "recheck": {
      if (state.status !== "tracking" || state.session.phase !== "complete") {
        return state as RangeSimulatorControllerState;
      }
      const next = createRangeSimulatorSession({
        anchorMidi: state.session.baselineMidi ?? state.session.anchorMidi,
        preparation: state.session.preparation,
        startedAt: action.startedAt,
        sessionId: `range-map-${new Date(action.startedAt).toISOString()}`,
      });
      return {
        ...state,
        // This is an explicit new assessment pass inside the already-running
        // user-owned live workspace. It neither starts nor stops that lifetime.
        session: next,
        dwell: createDwellForSession(next, action.toleranceCents),
        rating: null,
        coordinationChange: false,
        notice: "Boundary recheck started. The live session never stopped; rate the new displayed probes when ready.",
        persistenceRevision: state.persistenceRevision + 1,
      };
    }
    case "fresh": {
      if (state.status === "tracking") return state as RangeSimulatorControllerState;
      const next = createRangeSimulatorSession({
        anchorMidi: action.anchorMidi,
        preparation: action.preparation,
        startedAt: action.startedAt,
        sessionId: `range-map-${new Date(action.startedAt).toISOString()}`,
      });
      return {
        ...state,
        status: "idle",
        session: next,
        dwell: createDwellForSession(next, action.toleranceCents),
        rating: null,
        coordinationChange: false,
        notice: "Fresh assessment ready. The shared microphone and saved voice map were not reset.",
        persistenceRevision: state.persistenceRevision + 1,
      };
    }
  }
}

export function activeRangeSimulatorTarget(state: Readonly<RangeSimulatorControllerState>): number {
  return targetMidiForSession(state.session);
}
