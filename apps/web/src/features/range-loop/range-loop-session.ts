import {
  RANGE_FAMILIES,
  rangeFamilyForMidi,
  targetsForFamily,
  type FamilyNoteSet,
  type RangeFamilyId,
} from "./model";
import {
  normalizeProgress,
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

export interface StoredRangeLoopState {
  readonly activeFamilyId?: unknown;
  readonly noteSet?: unknown;
  readonly order?: unknown;
  readonly holdSeconds?: unknown;
  readonly toleranceCents?: unknown;
  readonly targetMidi?: unknown;
  readonly progress?: unknown;
}

export interface HydratedRangeLoopState {
  readonly activeFamilyId: RangeFamilyId;
  readonly noteSet: FamilyNoteSet;
  readonly order: RangeLoopOrder;
  readonly holdSeconds: number;
  readonly toleranceCents: number;
  readonly targetMidi: number;
  readonly progress: LoopProgress;
  readonly profile: PersonalRangeProfile;
}

export const RANGE_LOOP_HOLD_OPTIONS = Object.freeze([1.5, 2, 3, 5, 8] as const);
export const RANGE_LOOP_TOLERANCE_OPTIONS = Object.freeze([10, 15, 20, 30, 40, 50] as const);

export function isRangeLoopFamily(value: unknown): value is RangeFamilyId {
  return RANGE_FAMILIES.some((family) => family.id === value);
}

export function isRangeLoopNoteSet(value: unknown): value is FamilyNoteSet {
  return value === "natural" || value === "chromatic";
}

export function isRangeLoopOrder(value: unknown): value is RangeLoopOrder {
  return value === "ascending" || value === "descending";
}

export function isRangeLoopHold(value: unknown): value is number {
  return typeof value === "number"
    && RANGE_LOOP_HOLD_OPTIONS.some((candidate) => candidate === value);
}

export function isRangeLoopTolerance(value: unknown): value is number {
  return typeof value === "number"
    && RANGE_LOOP_TOLERANCE_OPTIONS.some((candidate) => candidate === value);
}

/** Normalize persisted state and an optional explicit handoff before React sees it. */
export function hydrateRangeLoopState(
  stored: StoredRangeLoopState | undefined,
  storedProfile: unknown,
  handoffMidi: number | null,
  fallbackTolerance: number,
  handoffUpdatedAt: string,
): HydratedRangeLoopState {
  let profile = normalizeRangeProfile(storedProfile);
  if (handoffMidi !== null) {
    profile = setRangeProfileBaseline(profile, handoffMidi, "manual", handoffUpdatedAt);
  }
  const progress = handoffMidi === null
    ? normalizeProgress(stored?.progress)
    : restoreMidiAsPending(
      normalizeProgress(stored?.progress),
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
  const holdSeconds = isRangeLoopHold(stored?.holdSeconds) ? stored.holdSeconds : 3;
  const toleranceCents = isRangeLoopTolerance(stored?.toleranceCents)
    ? stored.toleranceCents
    : fallbackTolerance;
  const requestedTarget = handoffMidi ?? stored?.targetMidi;
  const targetMidi = typeof requestedTarget === "number"
    && Number.isInteger(requestedTarget)
    && targetsForFamily(activeFamilyId, noteSet).includes(requestedTarget)
    ? requestedTarget
    : firstRangeLoopTarget(progress, activeFamilyId, noteSet, order);
  return {
    activeFamilyId,
    noteSet,
    order,
    holdSeconds,
    toleranceCents,
    targetMidi,
    progress,
    profile,
  };
}

export function rangeLoopTargetSequence(
  familyId: RangeFamilyId,
  noteSet: FamilyNoteSet,
  order: RangeLoopOrder,
): number[] {
  const targets = targetsForFamily(familyId, noteSet);
  return order === "descending" ? targets.reverse() : targets;
}

export function firstRangeLoopTarget(
  progress: Readonly<LoopProgress>,
  familyId: RangeFamilyId,
  noteSet: FamilyNoteSet,
  order: RangeLoopOrder,
): number {
  const sequence = rangeLoopTargetSequence(familyId, noteSet, order);
  const passed = new Set(progress[noteSet][familyId].passedMidis);
  return sequence.find((midi) => !passed.has(midi)) ?? sequence[0]!;
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
        parkedMidis: [],
        cyclesCompleted: record.cyclesCompleted + 1,
      },
    },
  };
}
