import {
  RANGE_FAMILIES,
  rangeFamilyForMidi,
  targetsForFamily,
  type FamilyNoteSet,
  type RangeFamilyId,
} from "./model";
import {
  buildProfileFamilyQueue,
  nextProfileFamily,
  normalizeProgress,
  parkMidiAcrossNoteSets,
  profileOrderedTargets,
  restoreMidiAsPending,
  type LoopProgress,
} from "./progress";
import {
  normalizeRangeProfile,
  setRangeProfileBaseline,
  type PersonalRangeProfile,
} from "./profile";

export type RangeLoopOrder = "ascending" | "descending";
export type RangeLoopLivePhase = "idle" | "tracking" | "complete";

export interface RangeLoopLiveState {
  readonly phase: RangeLoopLivePhase;
}

export type RangeLoopLiveAction =
  | Readonly<{ type: "start" }>
  | Readonly<{ type: "finish" }>;

/** A restored target is configuration, never authority to begin scoring. */
export function createRangeLoopLiveState(): RangeLoopLiveState {
  return Object.freeze({ phase: "idle" });
}

/** Only the two visible lifetime controls can cross a live-session boundary. */
export function reduceRangeLoopLiveState(
  state: Readonly<RangeLoopLiveState>,
  action: Readonly<RangeLoopLiveAction>,
): RangeLoopLiveState {
  switch (action.type) {
    case "start":
      return state.phase === "tracking"
        ? state as RangeLoopLiveState
        : Object.freeze({ phase: "tracking" });
    case "finish":
      return state.phase === "tracking"
        ? Object.freeze({ phase: "complete" })
        : state as RangeLoopLiveState;
  }
}

export const RANGE_LOOP_SCORING_VERSION = 2;

export interface StoredRangeLoopState {
  readonly scoringVersion?: unknown;
  readonly activeFamilyId?: unknown;
  readonly noteSet?: unknown;
  readonly order?: unknown;
  readonly targetMidi?: unknown;
  readonly progress?: unknown;
}

export interface HydratedRangeLoopState {
  readonly activeFamilyId: RangeFamilyId;
  readonly noteSet: FamilyNoteSet;
  readonly order: RangeLoopOrder;
  readonly targetMidi: number;
  readonly targetAcceptsCredit: boolean;
  readonly progress: LoopProgress;
  readonly profile: PersonalRangeProfile;
}

export interface RangeLoopTargetChoice {
  readonly targetMidi: number;
  readonly acceptingCredit: boolean;
}

export interface RangeLoopTargetAdvance extends RangeLoopTargetChoice {
  readonly familyId: RangeFamilyId;
  readonly progress: LoopProgress;
}

export type RangeLoopTargetOutcome = "passed" | "outside-range";

export function isRangeLoopFamily(value: unknown): value is RangeFamilyId {
  return RANGE_FAMILIES.some((family) => family.id === value);
}

export function isRangeLoopNoteSet(value: unknown): value is FamilyNoteSet {
  return value === "natural" || value === "chromatic";
}

export function isRangeLoopOrder(value: unknown): value is RangeLoopOrder {
  return value === "ascending" || value === "descending";
}

function clearPreCumulativePasses(progress: Readonly<LoopProgress>): LoopProgress {
  let next = progress as LoopProgress;
  for (const noteSet of ["natural", "chromatic"] as const) {
    for (const family of RANGE_FAMILIES) {
      const record = next[noteSet][family.id];
      if (record.passedMidis.length === 0) continue;
      next = {
        ...next,
        [noteSet]: {
          ...next[noteSet],
          [family.id]: { ...record, passedMidis: [] },
        },
      };
    }
  }
  return next;
}

/** Pick the first still-trainable note, or retain a visible excluded fallback. */
export function chooseRangeLoopTarget(
  progress: Readonly<LoopProgress>,
  familyId: RangeFamilyId,
  noteSet: FamilyNoteSet,
  order: RangeLoopOrder,
  baselineMidi: number,
): RangeLoopTargetChoice {
  const queue = buildProfileFamilyQueue(
    progress as LoopProgress,
    noteSet,
    familyId,
    order,
    baselineMidi,
  );
  return queue.length > 0
    ? Object.freeze({ targetMidi: queue[0]!, acceptingCredit: true })
    : Object.freeze({
      targetMidi: profileOrderedTargets(noteSet, familyId, order, baselineMidi)[0]!,
      acceptingCredit: false,
    });
}

/** Normalize persisted state and an optional explicit handoff before React sees it. */
export function hydrateRangeLoopState(
  stored: StoredRangeLoopState | undefined,
  storedProfile: unknown,
  handoffMidi: number | null,
  handoffUpdatedAt: string,
): HydratedRangeLoopState {
  let profile = normalizeRangeProfile(storedProfile);
  if (handoffMidi !== null) {
    profile = setRangeProfileBaseline(profile, handoffMidi, "manual", handoffUpdatedAt);
  }
  const normalizedProgress = normalizeProgress(stored?.progress);
  const migratedProgress = stored?.scoringVersion === RANGE_LOOP_SCORING_VERSION
    ? normalizedProgress
    : clearPreCumulativePasses(normalizedProgress);
  const progress = handoffMidi === null
    ? migratedProgress
    : restoreMidiAsPending(
      migratedProgress,
      rangeFamilyForMidi(handoffMidi),
      handoffMidi,
    );
  const activeFamilyId = handoffMidi !== null
    ? rangeFamilyForMidi(handoffMidi)
    : isRangeLoopFamily(stored?.activeFamilyId)
      ? stored.activeFamilyId
      : rangeFamilyForMidi(profile.baseline.midi);
  const requestedNoteSet = isRangeLoopNoteSet(stored?.noteSet) ? stored.noteSet : "natural";
  const noteSet = handoffMidi !== null
    && !targetsForFamily(activeFamilyId, requestedNoteSet).includes(handoffMidi)
    ? "chromatic"
    : requestedNoteSet;
  const order = isRangeLoopOrder(stored?.order) ? stored.order : "ascending";
  const requestedTarget = handoffMidi ?? stored?.targetMidi;
  const record = progress[noteSet][activeFamilyId];
  const requestedTargetAvailable = typeof requestedTarget === "number"
    && Number.isInteger(requestedTarget)
    && targetsForFamily(activeFamilyId, noteSet).includes(requestedTarget)
    && !record.passedMidis.includes(requestedTarget)
    && !record.parkedMidis.includes(requestedTarget);
  const choice = requestedTargetAvailable
    ? { targetMidi: requestedTarget, acceptingCredit: true }
    : chooseRangeLoopTarget(progress, activeFamilyId, noteSet, order, profile.baseline.midi);
  return {
    activeFamilyId,
    noteSet,
    order,
    targetMidi: choice.targetMidi,
    targetAcceptsCredit: choice.acceptingCredit,
    progress,
    profile,
  };
}

export function markRangeLoopTargetPassed(
  progress: Readonly<LoopProgress>,
  familyId: RangeFamilyId,
  noteSet: FamilyNoteSet,
  targetMidi: number,
): LoopProgress {
  const record = progress[noteSet][familyId];
  if (record.passedMidis.includes(targetMidi) && !record.parkedMidis.includes(targetMidi)) {
    return progress as LoopProgress;
  }
  return {
    ...progress,
    [noteSet]: {
      ...progress[noteSet],
      [familyId]: {
        ...record,
        passedMidis: [...new Set([...record.passedMidis, targetMidi])],
        parkedMidis: record.parkedMidis.filter((midi) => midi !== targetMidi),
      },
    },
  };
}

export function completeRangeLoopFamily(
  progress: Readonly<LoopProgress>,
  familyId: RangeFamilyId,
  noteSet: FamilyNoteSet,
): LoopProgress {
  const record = progress[noteSet][familyId];
  return {
    ...progress,
    [noteSet]: {
      ...progress[noteSet],
      [familyId]: {
        ...record,
        passedMidis: [],
        parkedMidis: record.parkedMidis,
        cyclesCompleted: record.cyclesCompleted + 1,
      },
    },
  };
}

/** Apply one visible target decision and select the next baseline-routed note. */
export function advanceRangeLoopTarget(
  progress: Readonly<LoopProgress>,
  familyId: RangeFamilyId,
  noteSet: FamilyNoteSet,
  order: RangeLoopOrder,
  baselineMidi: number,
  targetMidi: number,
  outcome: RangeLoopTargetOutcome,
): RangeLoopTargetAdvance {
  const decided = outcome === "passed"
    ? markRangeLoopTargetPassed(progress, familyId, noteSet, targetMidi)
    : parkMidiAcrossNoteSets(progress as LoopProgress, familyId, targetMidi);
  const sameFamily = buildProfileFamilyQueue(
    decided,
    noteSet,
    familyId,
    order,
    baselineMidi,
  );
  if (sameFamily.length > 0) {
    return Object.freeze({
      progress: decided,
      familyId,
      targetMidi: sameFamily[0]!,
      acceptingCredit: true,
    });
  }

  const completed = completeRangeLoopFamily(decided, familyId, noteSet);
  const familyAdvance = nextProfileFamily(
    familyId,
    completed,
    noteSet,
    order,
    baselineMidi,
  );
  if (familyAdvance === null) {
    const fallback = chooseRangeLoopTarget(
      completed,
      familyId,
      noteSet,
      order,
      baselineMidi,
    );
    return Object.freeze({ progress: completed, familyId, ...fallback });
  }
  const choice = chooseRangeLoopTarget(
    completed,
    familyAdvance.familyId,
    noteSet,
    order,
    baselineMidi,
  );
  return Object.freeze({
    progress: completed,
    familyId: familyAdvance.familyId,
    ...choice,
  });
}
