import {
  RANGE_FAMILIES,
  createFamilyTargetSequence,
  rangeFamilyForMidi,
  targetsForFamily,
  type FamilyNoteSet,
  type RangeFamilyId,
  type TargetOrder,
} from "./model";

export interface FamilyCycleRecord {
  passedMidis: number[];
  parkedMidis: number[];
  cyclesCompleted: number;
}

export type FamilyCycleProgress = Record<RangeFamilyId, FamilyCycleRecord>;
export type LoopProgress = Record<FamilyNoteSet, FamilyCycleProgress>;

function emptyFamilyProgress(): FamilyCycleProgress {
  return {
    deep: { passedMidis: [], parkedMidis: [], cyclesCompleted: 0 },
    low: { passedMidis: [], parkedMidis: [], cyclesCompleted: 0 },
    middle: { passedMidis: [], parkedMidis: [], cyclesCompleted: 0 },
    high: { passedMidis: [], parkedMidis: [], cyclesCompleted: 0 },
  };
}

export function emptyLoopProgress(): LoopProgress {
  return { natural: emptyFamilyProgress(), chromatic: emptyFamilyProgress() };
}

export function normalizeProgress(candidate: unknown): LoopProgress {
  const result = emptyLoopProgress();
  const stored = (candidate ?? {}) as Partial<Record<FamilyNoteSet, Partial<Record<RangeFamilyId, Partial<FamilyCycleRecord>>>>>;
  for (const noteSet of ["natural", "chromatic"] as const) {
    for (const family of RANGE_FAMILIES) {
      const record = stored[noteSet]?.[family.id];
      const validTargets = new Set(targetsForFamily(family.id, noteSet));
      const passedMidis = Array.isArray(record?.passedMidis)
        ? [...new Set(record.passedMidis.filter((midi): midi is number => Number.isInteger(midi) && validTargets.has(midi)))]
        : [];
      const parkedMidis = Array.isArray(record?.parkedMidis)
        ? [...new Set(record.parkedMidis.filter((midi): midi is number => Number.isInteger(midi) && validTargets.has(midi)))]
        : [];
      const cyclesCompleted = typeof record?.cyclesCompleted === "number" && Number.isFinite(record.cyclesCompleted)
        ? Math.max(0, Math.floor(record.cyclesCompleted))
        : 0;
      result[noteSet][family.id] = {
        passedMidis: passedMidis.filter((midi) => !parkedMidis.includes(midi)),
        parkedMidis,
        cyclesCompleted,
      };
    }
  }

  // “Outside my current range” describes a physical pitch, not a curriculum
  // spelling. Keep shared natural notes parked when switching note sets.
  for (const family of RANGE_FAMILIES) {
    const parkedAcrossSets = new Set([
      ...result.natural[family.id].parkedMidis,
      ...result.chromatic[family.id].parkedMidis,
    ]);
    for (const noteSet of ["natural", "chromatic"] as const) {
      const record = result[noteSet][family.id];
      const validTargets = new Set(targetsForFamily(family.id, noteSet));
      const parkedMidis = [...parkedAcrossSets].filter((midi) => validTargets.has(midi));
      const passedMidis = record.passedMidis.filter((midi) => !parkedMidis.includes(midi));
      const trainableMidis = targetsForFamily(family.id, noteSet).filter((midi) => !parkedMidis.includes(midi));
      const completeButUnfinalized = trainableMidis.length > 0
        && trainableMidis.every((midi) => passedMidis.includes(midi));
      result[noteSet][family.id] = {
        ...record,
        passedMidis: completeButUnfinalized ? [] : passedMidis,
        parkedMidis,
      };
    }
  }
  return result;
}

export function firstPendingTarget(
  progress: LoopProgress,
  noteSet: FamilyNoteSet,
  familyId: RangeFamilyId,
): number {
  const record = progress[noteSet][familyId];
  const unavailable = new Set([...record.passedMidis, ...record.parkedMidis]);
  return targetsForFamily(familyId, noteSet).find((midi) => !unavailable.has(midi))
    ?? targetsForFamily(familyId, noteSet)[0]!;
}

export function buildFamilyQueue(
  progress: LoopProgress,
  noteSet: FamilyNoteSet,
  familyId: RangeFamilyId,
  order: TargetOrder,
): number[] {
  const record = progress[noteSet][familyId];
  const unavailable = new Set([...record.passedMidis, ...record.parkedMidis]);
  return createFamilyTargetSequence({ familyId, noteSet, order })
    .filter((midi) => !unavailable.has(midi));
}

export function buildProfileFamilyQueue(
  progress: LoopProgress,
  noteSet: FamilyNoteSet,
  familyId: RangeFamilyId,
  order: TargetOrder,
  baselineMidi: number,
): number[] {
  const queue = buildFamilyQueue(progress, noteSet, familyId, order);
  // Validate the anchor through the same boundary-aware path used by the
  // family route, even when this particular family does not contain it.
  rangeFamilyForMidi(baselineMidi);

  // Every family expands away from the singer's home pitch. This matters most
  // when the route crosses below the baseline: a C3 anchor should enter Deep
  // at B2, not jump straight to C2 because the selected display order happens
  // to be ascending. The selected order remains the tie-breaker for equally
  // distant pitches (lower first for ascending, higher first for descending,
  // and the shuffled order for shuffled).
  return queue
    .map((midi, index) => ({ midi, index, distance: Math.abs(midi - baselineMidi) }))
    .sort((left, right) => left.distance - right.distance || left.index - right.index)
    .map(({ midi }) => midi);
}

export function restoreMidiAsPending(
  progress: LoopProgress,
  familyId: RangeFamilyId,
  midi: number,
): LoopProgress {
  let nextProgress = recheckMidisAcrossNoteSets(progress, familyId, new Set([midi]));
  for (const noteSet of ["natural", "chromatic"] as const) {
    if (!targetsForFamily(familyId, noteSet).includes(midi)) continue;
    const record = nextProgress[noteSet][familyId];
    nextProgress = {
      ...nextProgress,
      [noteSet]: {
        ...nextProgress[noteSet],
        [familyId]: {
          ...record,
          passedMidis: record.passedMidis.filter((candidate) => candidate !== midi),
        },
      },
    };
  }
  return nextProgress;
}

export function profileFamilyOrder(baselineMidi: number): RangeFamilyId[] {
  const baselineFamily = rangeFamilyForMidi(baselineMidi);
  const baselineIndex = RANGE_FAMILIES.findIndex((family) => family.id === baselineFamily);
  return [
    baselineFamily,
    ...RANGE_FAMILIES.slice(0, baselineIndex).reverse().map((family) => family.id),
    ...RANGE_FAMILIES.slice(baselineIndex + 1).map((family) => family.id),
  ];
}

export function nextProfileFamily(
  currentFamilyId: RangeFamilyId,
  progress: LoopProgress,
  noteSet: FamilyNoteSet,
  order: TargetOrder,
  baselineMidi: number,
): { familyId: RangeFamilyId; wrapped: boolean } | null {
  const familyOrder = profileFamilyOrder(baselineMidi);
  const currentIndex = familyOrder.indexOf(currentFamilyId);
  for (let offset = 1; offset <= familyOrder.length; offset += 1) {
    const absoluteIndex = currentIndex + offset;
    const familyId = familyOrder[absoluteIndex % familyOrder.length]!;
    if (buildProfileFamilyQueue(progress, noteSet, familyId, order, baselineMidi).length > 0) {
      return { familyId, wrapped: absoluteIndex >= familyOrder.length };
    }
  }
  return null;
}

export function availableTargets(
  progress: LoopProgress,
  noteSet: FamilyNoteSet,
  familyId: RangeFamilyId,
): number[] {
  const parked = new Set(progress[noteSet][familyId].parkedMidis);
  return targetsForFamily(familyId, noteSet).filter((midi) => !parked.has(midi));
}

export function parkMidiAcrossNoteSets(
  progress: LoopProgress,
  familyId: RangeFamilyId,
  midi: number,
): LoopProgress {
  let nextProgress = progress;
  for (const noteSet of ["natural", "chromatic"] as const) {
    if (!targetsForFamily(familyId, noteSet).includes(midi)) continue;
    const record = nextProgress[noteSet][familyId];
    nextProgress = {
      ...nextProgress,
      [noteSet]: {
        ...nextProgress[noteSet],
        [familyId]: {
          ...record,
          passedMidis: record.passedMidis.filter((candidate) => candidate !== midi),
          parkedMidis: [...new Set([...record.parkedMidis, midi])],
        },
      },
    };
  }
  return nextProgress;
}

export function recheckMidisAcrossNoteSets(
  progress: LoopProgress,
  familyId: RangeFamilyId,
  midis: ReadonlySet<number>,
): LoopProgress {
  let nextProgress = progress;
  for (const noteSet of ["natural", "chromatic"] as const) {
    const record = nextProgress[noteSet][familyId];
    nextProgress = {
      ...nextProgress,
      [noteSet]: {
        ...nextProgress[noteSet],
        [familyId]: {
          ...record,
          parkedMidis: record.parkedMidis.filter((midi) => !midis.has(midi)),
        },
      },
    };
  }
  return nextProgress;
}
