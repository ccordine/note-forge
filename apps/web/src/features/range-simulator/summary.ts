import type { PersonalRangeProfile, RegisterShiftMarker } from "@/features/range-loop/profile";
import {
  RANGE_SIMULATOR_MAX_MIDI,
  RANGE_SIMULATOR_MIN_MIDI,
  type EffortRating,
  type ProbeSideStatus,
  type RangeSimulatorCompletionStatus,
  type RangeSimulatorSessionState,
  type RatedProbe,
} from "./model";

export interface MidiBounds {
  lowMidi: number | null;
  highMidi: number | null;
}

export interface RangeSimulatorEdges {
  lowMidi: number | null;
  highMidi: number | null;
}

export interface CoordinationMarker {
  midi: number;
  ascending: boolean;
  descending: boolean;
}

export interface RangeSimulatorSummary {
  baselineMidi: number | null;
  testedMidis: number[];
  easyMidis: number[];
  usableMidis: number[];
  testedBounds: MidiBounds;
  easyBounds: MidiBounds;
  usableBounds: MidiBounds;
  difficultyEdges: RangeSimulatorEdges;
  unreliableEdges: RangeSimulatorEdges;
  coordinationMarkers: CoordinationMarker[];
  completionStatus: RangeSimulatorCompletionStatus;
  ratedProbeCount: number;
  ascendingStatus: ProbeSideStatus | null;
  descendingStatus: ProbeSideStatus | null;
}

function boundsFor(midis: readonly number[]): MidiBounds {
  return midis.length === 0
    ? { lowMidi: null, highMidi: null }
    : { lowMidi: Math.min(...midis), highMidi: Math.max(...midis) };
}

function latestRatingsByMidi(session: Readonly<RangeSimulatorSessionState>): Map<number, EffortRating> {
  const ratings = new Map<number, EffortRating>();
  for (const observation of session.observations) {
    if (observation.task.kind !== "baseline-candidate") ratings.set(observation.task.midi, observation.rating);
  }
  return ratings;
}

function contiguousMidis(
  ratings: ReadonlyMap<number, EffortRating>,
  baselineMidi: number | null,
  maximumRating: EffortRating,
): number[] {
  if (baselineMidi === null || (ratings.get(baselineMidi) ?? 6) > maximumRating) return [];
  const result = [baselineMidi];
  for (let midi = baselineMidi - 1; midi >= RANGE_SIMULATOR_MIN_MIDI; midi -= 1) {
    if ((ratings.get(midi) ?? 6) > maximumRating) break;
    result.unshift(midi);
  }
  for (let midi = baselineMidi + 1; midi <= RANGE_SIMULATOR_MAX_MIDI; midi += 1) {
    if ((ratings.get(midi) ?? 6) > maximumRating) break;
    result.push(midi);
  }
  return result;
}

function nearestObservedEdge(
  observations: readonly RatedProbe[],
  baselineMidi: number | null,
  predicate: (rating: EffortRating) => boolean,
): RangeSimulatorEdges {
  if (baselineMidi === null) return { lowMidi: null, highMidi: null };
  const relevant = observations.filter((observation) => observation.task.kind !== "baseline-candidate" && predicate(observation.rating));
  const lower = relevant.filter((observation) => observation.task.midi < baselineMidi).map((observation) => observation.task.midi);
  const upper = relevant.filter((observation) => observation.task.midi > baselineMidi).map((observation) => observation.task.midi);
  return {
    lowMidi: lower.length === 0 ? null : Math.max(...lower),
    highMidi: upper.length === 0 ? null : Math.min(...upper),
  };
}

export function summarizeRangeSimulatorSession(session: Readonly<RangeSimulatorSessionState>): RangeSimulatorSummary {
  const ratings = latestRatingsByMidi(session);
  const testedMidis = [...new Set(session.observations.map((observation) => observation.task.midi))].sort((a, b) => a - b);
  const easyMidis = contiguousMidis(ratings, session.baselineMidi, 2);
  const usableMidis = contiguousMidis(ratings, session.baselineMidi, 3);
  const markers = new Map<number, CoordinationMarker>();
  for (const observation of session.observations) {
    if (!observation.coordination.ascending && !observation.coordination.descending) continue;
    const existing = markers.get(observation.task.midi) ?? { midi: observation.task.midi, ascending: false, descending: false };
    existing.ascending ||= observation.coordination.ascending;
    existing.descending ||= observation.coordination.descending;
    markers.set(existing.midi, existing);
  }
  return {
    baselineMidi: session.baselineMidi,
    testedMidis,
    easyMidis,
    usableMidis,
    testedBounds: boundsFor(testedMidis),
    easyBounds: boundsFor(easyMidis),
    usableBounds: boundsFor(usableMidis),
    difficultyEdges: nearestObservedEdge(session.observations, session.baselineMidi, (rating) => rating >= 3),
    unreliableEdges: nearestObservedEdge(session.observations, session.baselineMidi, (rating) => rating >= 4),
    coordinationMarkers: [...markers.values()].sort((left, right) => left.midi - right.midi),
    completionStatus: session.completionStatus,
    ratedProbeCount: session.ratedProbeCount,
    ascendingStatus: session.ascending?.status ?? null,
    descendingStatus: session.descending?.status ?? null,
  };
}

/** Replace the shared voice map with the current simulator summary. */
export function projectRangeSimulatorProfile(
  profile: Readonly<PersonalRangeProfile>,
  session: Readonly<RangeSimulatorSessionState>,
): PersonalRangeProfile {
  if (session.baselineMidi === null) return { ...profile };
  const summary = summarizeRangeSimulatorSession(session);
  if (!summary.usableMidis.includes(session.baselineMidi)) return { ...profile };
  const baselineConfirmation = [...session.observations]
    .reverse()
    .find((observation) => observation.task.kind !== "baseline-candidate"
      && observation.task.direction === "center"
      && observation.task.midi === session.baselineMidi
      && observation.rating <= 3);
  const markerMap = new Map<number, RegisterShiftMarker>(profile.registerShifts.map((marker) => [marker.midi, { ...marker }]));
  for (const marker of summary.coordinationMarkers) {
    const existing = markerMap.get(marker.midi) ?? { midi: marker.midi, ascending: false, descending: false };
    markerMap.set(marker.midi, {
      midi: marker.midi,
      ascending: existing.ascending || marker.ascending,
      descending: existing.descending || marker.descending,
    });
  }
  return {
    ...profile,
    baseline: {
      midi: session.baselineMidi,
      source: "manual",
      updatedAt: baselineConfirmation?.ratedAt ?? session.startedAt,
    },
    usableMidis: [...summary.usableMidis],
    registerShifts: [...markerMap.values()].sort((left, right) => left.midi - right.midi),
  };
}
