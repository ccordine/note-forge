import { describe, expect, it } from "vitest";

import { createDefaultRangeProfile, type PersonalRangeProfile } from "../apps/web/src/features/range-loop/profile";
import {
  EFFORT_RATING_LABELS,
  RANGE_SIMULATOR_INITIAL_RADIUS,
  RANGE_SIMULATOR_MAX_MIDI,
  RANGE_SIMULATOR_MAX_RATED_PROBES,
  RANGE_SIMULATOR_MIN_MIDI,
  baselineCandidatesForAnchor,
  createRangeSimulatorSession,
  currentRangeSimulatorProbe,
  normalizeRangeSimulatorSession,
  projectRangeSimulatorProfile,
  rateRangeSimulatorProbe,
  stopRangeSimulatorSession,
  summarizeRangeSimulatorSession,
  type CoordinationFlags,
  type EffortRating,
  type ProbeDirection,
  type ProbeKind,
  type RangeSimulatorSessionState,
  type RatedProbe,
} from "../apps/web/src/features/range-simulator/model";

const STARTED_AT = "2026-08-22T12:00:00.000Z";
const STARTED_AT_MS = Date.parse(STARTED_AT);

function createSession(anchorMidi = 48): RangeSimulatorSessionState {
  return createRangeSimulatorSession({
    anchorMidi,
    preparation: "light-warmup",
    startedAt: STARTED_AT,
    sessionId: `session-${anchorMidi}`,
  });
}

function rateCurrent(
  session: RangeSimulatorSessionState,
  rating: EffortRating,
  coordinationChange = false,
): RangeSimulatorSessionState {
  const task = currentRangeSimulatorProbe(session);
  if (!task) throw new Error("Test fixture expected an active probe.");
  return rateRangeSimulatorProbe(session, {
    taskId: task.id,
    rating,
    coordinationChange,
    ratedAt: new Date(STARTED_AT_MS + (session.ratedProbeCount + 1) * 1_000).toISOString(),
  });
}

function finishBaseline(
  session: RangeSimulatorSessionState,
  ratings: Readonly<Record<number, EffortRating>> = {},
  fallbackRating: EffortRating = 3,
): RangeSimulatorSessionState {
  let next = session;
  while (next.phase === "baseline") {
    const task = currentRangeSimulatorProbe(next);
    if (!task) throw new Error("Baseline phase was missing its current probe.");
    next = rateCurrent(next, ratings[task.midi] ?? fallbackRating);
  }
  return next;
}

function probingSession(anchorMidi = 48): RangeSimulatorSessionState {
  const session = finishBaseline(createSession(anchorMidi), { [anchorMidi]: 1 }, 3);
  if (session.phase !== "probing" || session.baselineMidi !== anchorMidi) {
    throw new Error("Fixture did not select its anchor as the baseline.");
  }
  return session;
}

interface SummaryEntry {
  midi: number;
  rating: EffortRating;
  direction?: ProbeDirection;
  kind?: ProbeKind;
  coordination?: Partial<CoordinationFlags>;
}

function summarySession(entries: readonly SummaryEntry[], baselineMidi = 48): RangeSimulatorSessionState {
  const base = createSession(baselineMidi);
  const observations: RatedProbe[] = entries.map((entry, index) => {
    const direction = entry.direction
      ?? (entry.midi === baselineMidi ? "center" : entry.midi > baselineMidi ? "ascending" : "descending");
    return {
      task: {
        id: index + 1,
        midi: entry.midi,
        direction,
        kind: entry.kind ?? "initial",
        attempt: entry.kind === "retest" ? 1 : 0,
      },
      rating: entry.rating,
      coordination: {
        ascending: entry.coordination?.ascending === true,
        descending: entry.coordination?.descending === true,
      },
      ratedAt: new Date(STARTED_AT_MS + (index + 1) * 1_000).toISOString(),
    };
  });
  return {
    ...base,
    phase: "probing",
    baselineMidi,
    queue: [],
    observations,
    ascending: {
      direction: "ascending",
      status: "open",
      plannedEdgeMidi: baselineMidi,
      pendingRetestMidi: null,
    },
    descending: {
      direction: "descending",
      status: "open",
      plannedEdgeMidi: baselineMidi,
      pendingRetestMidi: null,
    },
    nextTaskId: observations.length + 1,
    ratedProbeCount: observations.length,
    updatedAt: observations.at(-1)?.ratedAt ?? STARTED_AT,
  };
}

describe("range simulator defaults and baseline selection", () => {
  it("publishes the 1 effortless through 5 unreliable rating contract", () => {
    expect(EFFORT_RATING_LABELS[1]).toMatchObject({ label: "Effortless" });
    expect(EFFORT_RATING_LABELS[2]).toMatchObject({ label: "Easy" });
    expect(EFFORT_RATING_LABELS[3]).toMatchObject({ label: "Deliberate" });
    expect(EFFORT_RATING_LABELS[4]).toMatchObject({ label: "Unstable" });
    expect(EFFORT_RATING_LABELS[5]).toMatchObject({ label: "Can't reliably produce" });
  });

  it("creates a canonical C3-anchored baseline survey with independent state", () => {
    const session = createRangeSimulatorSession({ startedAt: "2026-08-22T08:00:00-04:00" });
    const second = createRangeSimulatorSession({ startedAt: STARTED_AT });

    expect(session).toMatchObject({
      anchorMidi: 48,
      preparation: "unwarmed",
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
      phase: "baseline",
      completionStatus: "in-progress",
      baselineCandidates: [48, 46, 47, 49, 50],
      baselineMidi: null,
      nextTaskId: 6,
      ratedProbeCount: 0,
    });
    expect(session.queue.map((task) => [task.id, task.midi, task.direction, task.kind, task.attempt]))
      .toEqual([
        [1, 48, "center", "baseline-candidate", 0],
        [2, 46, "center", "baseline-candidate", 0],
        [3, 47, "center", "baseline-candidate", 0],
        [4, 49, "center", "baseline-candidate", 0],
        [5, 50, "center", "baseline-candidate", 0],
      ]);
    session.queue.pop();
    expect(second.queue).toHaveLength(5);
  });

  it("chooses the lowest-effort usable candidate and breaks ties toward the anchor", () => {
    const lowerWins = finishBaseline(createSession(), { 48: 2, 46: 1 }, 3);
    expect(lowerWins).toMatchObject({ phase: "probing", baselineMidi: 46 });

    const anchorTie = finishBaseline(createSession(), { 48: 1, 46: 1, 47: 1, 49: 1, 50: 1 });
    expect(anchorTie).toMatchObject({ phase: "probing", baselineMidi: 48 });
  });

  it("finishes without probing when every baseline candidate is unusable", () => {
    const session = finishBaseline(createSession(), {}, 4);

    expect(session).toMatchObject({
      phase: "complete",
      completionStatus: "no-usable-baseline",
      baselineMidi: null,
      queue: [],
    });
    expect(currentRangeSimulatorProbe(session)).toBeNull();
  });

  it("initializes one contiguous chromatic radius on each available side", () => {
    const session = probingSession(48);

    expect(RANGE_SIMULATOR_INITIAL_RADIUS).toBe(4);
    expect(session.queue.map((task) => [task.midi, task.direction, task.kind])).toEqual([
      [48, "center", "initial"],
      [49, "ascending", "initial"],
      [50, "ascending", "initial"],
      [51, "ascending", "initial"],
      [52, "ascending", "initial"],
      [47, "descending", "initial"],
      [46, "descending", "initial"],
      [45, "descending", "initial"],
      [44, "descending", "initial"],
    ]);
  });

  it("rechecks one unstable home confirmation and withdraws it only if instability repeats", () => {
    let session = probingSession(48);
    expect(currentRangeSimulatorProbe(session)).toMatchObject({ midi: 48, direction: "center" });

    session = rateCurrent(session, 4);

    expect(session.phase).toBe("probing");
    expect(currentRangeSimulatorProbe(session)).toMatchObject({
      midi: 48,
      direction: "center",
      kind: "retest",
      attempt: 1,
    });

    session = rateCurrent(session, 4);

    expect(session).toMatchObject({
      phase: "complete",
      completionStatus: "no-usable-baseline",
      baselineMidi: null,
      ascending: null,
      descending: null,
      queue: [],
    });
    expect(summarizeRangeSimulatorSession(session).usableBounds).toEqual({ lowMidi: null, highMidi: null });
  });

  it("accepts a successful home recheck, replays it exactly, and timestamps the confirmed baseline", () => {
    let session = probingSession(48);
    session = rateCurrent(session, 4);
    session = rateCurrent(session, 2);

    expect(session).toMatchObject({ phase: "probing", baselineMidi: 48 });
    expect(currentRangeSimulatorProbe(session)).toMatchObject({ midi: 49, direction: "ascending" });
    expect(summarizeRangeSimulatorSession(session).usableMidis).toEqual([48]);
    expect(normalizeRangeSimulatorSession(session, { startedAt: STARTED_AT })).toEqual(session);
    expect(projectRangeSimulatorProfile(createDefaultRangeProfile(46), session).baseline).toEqual({
      midi: 48,
      source: "manual",
      updatedAt: new Date(STARTED_AT_MS + 7_000).toISOString(),
    });
  });

  it("closes immediately when the home confirmation is rated 5", () => {
    const session = rateCurrent(probingSession(48), 5);

    expect(session).toMatchObject({
      phase: "complete",
      completionStatus: "no-usable-baseline",
      baselineMidi: null,
      queue: [],
    });
  });
});

describe("adaptive probe scheduling", () => {
  it.each([1, 2] as const)("expands an exhausted side by two semitones after rating %i", (rating) => {
    let session = probingSession();
    session = rateCurrent(session, 1); // center
    for (const midi of [49, 50, 51, 52]) {
      expect(currentRangeSimulatorProbe(session)?.midi).toBe(midi);
      session = rateCurrent(session, rating);
    }

    const ascending = session.queue.filter((task) => task.direction === "ascending");
    expect(ascending.map((task) => [task.midi, task.kind, task.attempt])).toEqual([
      [53, "expansion", 0],
      [54, "expansion", 0],
    ]);
    expect(session.ascending).toMatchObject({ status: "open", plannedEdgeMidi: 54 });
  });

  it("expands an exhausted side by one semitone after rating 3", () => {
    let session = probingSession();
    session = rateCurrent(session, 1);
    for (const expectedMidi of [49, 50, 51]) {
      expect(currentRangeSimulatorProbe(session)?.midi).toBe(expectedMidi);
      session = rateCurrent(session, 1);
    }
    expect(currentRangeSimulatorProbe(session)?.midi).toBe(52);
    session = rateCurrent(session, 3);

    expect(session.queue.filter((task) => task.direction === "ascending")
      .map((task) => [task.midi, task.kind])).toEqual([[53, "expansion"]]);
    expect(session.ascending).toMatchObject({ status: "open", plannedEdgeMidi: 53 });
  });

  it("rating 4 prunes outward tasks and schedules exactly one retest", () => {
    let session = probingSession();
    session = rateCurrent(session, 1);
    expect(currentRangeSimulatorProbe(session)?.midi).toBe(49);
    const descendingBefore = session.descending;

    session = rateCurrent(session, 4, true);

    const ascending = session.queue.filter((task) => task.direction === "ascending");
    expect(ascending).toEqual([{
      id: session.nextTaskId - 1,
      midi: 49,
      direction: "ascending",
      kind: "retest",
      attempt: 1,
    }]);
    expect(session.ascending).toMatchObject({
      status: "awaiting-retest",
      plannedEdgeMidi: 49,
      pendingRetestMidi: 49,
    });
    expect(session.descending).toEqual(descendingBefore);
    expect(session.queue.filter((task) => task.direction === "descending")).toHaveLength(4);
  });

  it("a repeated rating 4 closes that side without creating another retest", () => {
    let session = probingSession();
    session = rateCurrent(session, 1);
    session = rateCurrent(session, 4);

    expect(currentRangeSimulatorProbe(session)?.direction).toBe("descending");
    session = rateCurrent(session, 5); // close the other side and expose the queued retest
    expect(currentRangeSimulatorProbe(session)).toMatchObject({
      midi: 49,
      direction: "ascending",
      kind: "retest",
      attempt: 1,
    });
    session = rateCurrent(session, 4);

    expect(session.ascending).toMatchObject({
      status: "closed-unstable",
      pendingRetestMidi: null,
    });
    expect(session.queue.filter((task) => task.direction === "ascending")).toEqual([]);
    expect(session.observations
      .filter((item) => item.task.midi === 49 && item.task.kind !== "baseline-candidate")
      .map((item) => item.rating))
      .toEqual([4, 4]);
    expect(session).toMatchObject({ phase: "complete", completionStatus: "complete" });
  });

  it("rating 5 closes one side immediately while leaving the other side untouched", () => {
    let session = probingSession();
    session = rateCurrent(session, 1);
    const descendingBefore = session.descending;
    const descendingTaskIds = session.queue
      .filter((task) => task.direction === "descending")
      .map((task) => task.id);

    session = rateCurrent(session, 5);

    expect(session.ascending).toMatchObject({
      status: "closed-unreliable",
      plannedEdgeMidi: 49,
      pendingRetestMidi: null,
    });
    expect(session.queue.some((task) => task.direction === "ascending")).toBe(false);
    expect(session.descending).toEqual(descendingBefore);
    expect(session.queue.map((task) => task.id)).toEqual(descendingTaskIds);
    expect(session.phase).toBe("probing");
  });

  it("stops at the rated-probe cap even while both directions could keep expanding", () => {
    let session = probingSession();
    let guard = 0;
    while (session.phase !== "complete" && guard < 100) {
      session = rateCurrent(session, 1);
      guard += 1;
    }

    expect(guard).toBeLessThan(100);
    expect(session).toMatchObject({
      phase: "complete",
      completionStatus: "probe-cap",
      ratedProbeCount: RANGE_SIMULATOR_MAX_RATED_PROBES,
      queue: [],
    });
    expect(session.ascending).toMatchObject({ status: "incomplete", pendingRetestMidi: null });
    expect(session.descending).toMatchObject({ status: "incomplete", pendingRetestMidi: null });
  });

  it("does not leave a phantom recheck when rating 4 reaches the probe cap", () => {
    let session = probingSession();
    while (session.ratedProbeCount < RANGE_SIMULATOR_MAX_RATED_PROBES - 1) session = rateCurrent(session, 1);
    const finalDirection = currentRangeSimulatorProbe(session)?.direction;
    expect(finalDirection === "ascending" || finalDirection === "descending").toBe(true);

    session = rateCurrent(session, 4);

    expect(session).toMatchObject({ phase: "complete", completionStatus: "probe-cap", queue: [] });
    expect(session[finalDirection as "ascending" | "descending"]).toMatchObject({
      status: "incomplete",
      pendingRetestMidi: null,
    });
  });

  it("can be stopped explicitly without changing the source session", () => {
    const session = probingSession();
    const originalQueue = session.queue.map((task) => ({ ...task }));
    const stopped = stopRangeSimulatorSession(session, "2026-08-22T09:30:00-04:00");

    expect(stopped).toMatchObject({
      phase: "complete",
      completionStatus: "stopped",
      updatedAt: "2026-08-22T13:30:00.000Z",
      queue: [],
    });
    expect(session.phase).toBe("probing");
    expect(session.queue).toEqual(originalQueue);
    expect(currentRangeSimulatorProbe(stopped)).toBeNull();
    expect(stopped.ascending).toMatchObject({ status: "incomplete", pendingRetestMidi: null });
    expect(stopped.descending).toMatchObject({ status: "incomplete", pendingRetestMidi: null });
  });

  it("cancels a pending boundary recheck when the user stops", () => {
    let session = probingSession();
    session = rateCurrent(session, 1);
    session = rateCurrent(session, 4);
    expect(session.ascending).toMatchObject({ status: "awaiting-retest", pendingRetestMidi: 49 });

    const stopped = stopRangeSimulatorSession(session, new Date(STARTED_AT_MS + 20_000).toISOString());

    expect(stopped.ascending).toMatchObject({ status: "incomplete", pendingRetestMidi: null });
    expect(stopped.descending).toMatchObject({ status: "incomplete", pendingRetestMidi: null });
  });
});

describe("range inference and coordination markers", () => {
  it("does not turn the baseline survey into a confirmed contiguous range", () => {
    const session = probingSession();
    const summary = summarizeRangeSimulatorSession(session);

    expect(summary.testedMidis).toEqual([46, 47, 48, 49, 50]);
    expect(summary.easyMidis).toEqual([]);
    expect(summary.usableMidis).toEqual([]);
  });

  it("infers only contiguous easy and usable paths and will not bridge a chromatic gap", () => {
    const session = summarySession([
      { midi: 48, rating: 1 },
      { midi: 47, rating: 2 },
      { midi: 46, rating: 1 },
      { midi: 45, rating: 4 },
      { midi: 49, rating: 2 },
      { midi: 50, rating: 3 },
      { midi: 52, rating: 1 }, // 51 is deliberately untested
    ]);

    const summary = summarizeRangeSimulatorSession(session);

    expect(summary.testedMidis).toEqual([45, 46, 47, 48, 49, 50, 52]);
    expect(summary.easyMidis).toEqual([46, 47, 48, 49]);
    expect(summary.usableMidis).toEqual([46, 47, 48, 49, 50]);
    expect(summary.easyBounds).toEqual({ lowMidi: 46, highMidi: 49 });
    expect(summary.usableBounds).toEqual({ lowMidi: 46, highMidi: 50 });
    expect(summary.difficultyEdges).toEqual({ lowMidi: 45, highMidi: 50 });
    expect(summary.unreliableEdges).toEqual({ lowMidi: 45, highMidi: null });
    expect(summary.usableMidis).not.toContain(52);
  });

  it("uses the latest retest rating at a MIDI when deriving contiguous bounds", () => {
    const session = summarySession([
      { midi: 48, rating: 1 },
      { midi: 49, rating: 1 },
      { midi: 50, rating: 2 },
      { midi: 50, rating: 4, kind: "retest" },
    ]);

    const summary = summarizeRangeSimulatorSession(session);
    expect(summary.easyMidis).toEqual([48, 49]);
    expect(summary.usableMidis).toEqual([48, 49]);
    expect(summary.unreliableEdges.highMidi).toBe(50);
  });

  it("preserves an earlier instability report when a later retest succeeds", () => {
    const session = summarySession([
      { midi: 48, rating: 1 },
      { midi: 49, rating: 1 },
      { midi: 50, rating: 4 },
      { midi: 50, rating: 2, kind: "retest" },
    ]);

    const summary = summarizeRangeSimulatorSession(session);
    expect(summary.usableMidis).toEqual([48, 49, 50]);
    expect(summary.unreliableEdges.highMidi).toBe(50);
  });

  it("keeps ascending and descending coordination-change markers independent and sorted", () => {
    const session = summarySession([
      { midi: 48, rating: 1 },
      { midi: 55, rating: 2, direction: "ascending", coordination: { ascending: true } },
      { midi: 52, rating: 2, direction: "descending", coordination: { descending: true } },
      { midi: 55, rating: 3, direction: "descending", coordination: { descending: true } },
    ]);

    expect(summarizeRangeSimulatorSession(session).coordinationMarkers).toEqual([
      { midi: 52, ascending: false, descending: true },
      { midi: 55, ascending: true, descending: true },
    ]);
  });
});

describe("profile projection", () => {
  it("is idempotent and keeps comfort ratings separate from clean and accuracy claims", () => {
    const session = summarySession([
      { midi: 48, rating: 1 },
      { midi: 47, rating: 2 },
      { midi: 46, rating: 3 },
      { midi: 45, rating: 4 },
      { midi: 49, rating: 1, coordination: { ascending: true } },
      { midi: 50, rating: 4 },
    ]);
    const evidenceByMidi: PersonalRangeProfile["evidenceByMidi"] = {
      60: [{
        supportMode: "solo",
        toleranceCents: 20,
        requiredHoldMs: 3_000,
        resetCount: 0,
        timeToAcquireMs: 500,
        observedAt: STARTED_AT,
      }],
    };
    const profile: PersonalRangeProfile = {
      ...createDefaultRangeProfile(),
      cleanStableMidis: [40, 49],
      accuracyChallengeMidis: [44, 70],
      registerShifts: [
        { midi: 49, ascending: false, descending: true },
        { midi: 60, ascending: true, descending: false },
      ],
      evidenceByMidi,
    };

    const projected = projectRangeSimulatorProfile(profile, session);
    const projectedAgain = projectRangeSimulatorProfile(projected, session);

    expect(projected).toMatchObject({
      baseline: { midi: 48, source: "manual", updatedAt: "2026-08-22T12:00:01.000Z" },
      cleanStableMidis: [40, 49],
      accuracyChallengeMidis: [44, 70],
      registerShifts: [
        { midi: 49, ascending: true, descending: true },
        { midi: 60, ascending: true, descending: false },
      ],
    });
    expect(projected.evidenceByMidi).toBe(evidenceByMidi);
    expect(projectedAgain).toEqual(projected);
    expect(profile.cleanStableMidis).toEqual([40, 49]);
    expect(profile.registerShifts[0]).toEqual({ midi: 49, ascending: false, descending: true });
  });

  it("does not project inferred marks when no usable baseline was selected", () => {
    const profile = createDefaultRangeProfile();
    const session = finishBaseline(createSession(), {}, 5);

    const projected = projectRangeSimulatorProfile(profile, session);
    expect(projected).toEqual(profile);
    expect(projected).not.toBe(profile);
  });

  it("does not project a survey-selected baseline before its mapping confirmation", () => {
    const profile = createDefaultRangeProfile(46);
    const session = probingSession(48);

    expect(projectRangeSimulatorProfile(profile, session)).toEqual(profile);
  });
});

describe("hard MIDI boundaries", () => {
  it("clips baseline candidates and initial directions at the supported endpoints", () => {
    expect(baselineCandidatesForAnchor(RANGE_SIMULATOR_MIN_MIDI)).toEqual([36, 37, 38]);
    expect(baselineCandidatesForAnchor(RANGE_SIMULATOR_MAX_MIDI)).toEqual([83, 81, 82]);

    const low = probingSession(RANGE_SIMULATOR_MIN_MIDI);
    expect(low.descending).toMatchObject({ status: "capped", plannedEdgeMidi: 36 });
    expect(low.queue.some((task) => task.direction === "descending")).toBe(false);

    const high = probingSession(RANGE_SIMULATOR_MAX_MIDI);
    expect(high.ascending).toMatchObject({ status: "capped", plannedEdgeMidi: 83 });
    expect(high.queue.some((task) => task.direction === "ascending")).toBe(false);
  });

  it("caps expansion at MIDI 83 without emitting an out-of-range task", () => {
    let session = probingSession(79);
    session = rateCurrent(session, 1);
    for (const midi of [80, 81, 82, 83]) {
      expect(currentRangeSimulatorProbe(session)?.midi).toBe(midi);
      session = rateCurrent(session, 1);
    }

    expect(session.ascending?.status).toBe("capped");
    expect(session.queue.some((task) => task.direction === "ascending")).toBe(false);
    expect(session.queue.every((task) => task.midi <= RANGE_SIMULATOR_MAX_MIDI)).toBe(true);
  });

  it("caps expansion at MIDI 36 without emitting an out-of-range task", () => {
    let session = probingSession(40);
    session = rateCurrent(session, 1);
    expect(currentRangeSimulatorProbe(session)).toMatchObject({ midi: 41, direction: "ascending" });
    session = rateCurrent(session, 5); // close ascending and expose descending initial probes
    for (const midi of [39, 38, 37, 36]) {
      expect(currentRangeSimulatorProbe(session)?.midi).toBe(midi);
      session = rateCurrent(session, 1);
    }

    expect(session.descending?.status).toBe("capped");
    expect(session.queue.some((task) => task.direction === "descending")).toBe(false);
    expect(session.queue.every((task) => task.midi >= RANGE_SIMULATOR_MIN_MIDI)).toBe(true);
  });
});

describe("range simulator persistence normalization", () => {
  it("falls back to a fresh session for absent or invalid current-schema data", () => {
    const fallback = { anchorMidi: 48, preparation: "warmed" as const, startedAt: STARTED_AT, sessionId: "fallback" };
    const expected = createRangeSimulatorSession(fallback);

    expect(normalizeRangeSimulatorSession(null, fallback)).toEqual(expected);
    expect(normalizeRangeSimulatorSession({}, fallback)).toEqual(expected);
    expect(normalizeRangeSimulatorSession({ anchorMidi: 84 }, fallback)).toEqual(expected);
  });

  it("rejects corrupt task history and rebuilds a safe deterministic queue", () => {
    const validObservation = {
      task: { id: 10, midi: 49, direction: "ascending", kind: "initial", attempt: 0 },
      rating: 2,
      coordination: { ascending: true, descending: true },
      ratedAt: "2026-08-22T08:00:01-04:00",
    };
    const candidate = {
      sessionId: "   ",
      anchorMidi: 48,
      preparation: "raw",
      startedAt: "2026-08-22T08:00:00-04:00",
      updatedAt: "not-a-date",
      phase: "probing",
      completionStatus: "mystery",
      baselineCandidates: [999],
      baselineMidi: 48,
      queue: [
        { id: 20, midi: 50, direction: "ascending", kind: "initial", attempt: 0 },
        { id: 20, midi: 51, direction: "ascending", kind: "initial", attempt: 0 },
        { id: 10, midi: 49, direction: "ascending", kind: "initial", attempt: 0 },
        { id: 30, midi: 999, direction: "ascending", kind: "initial", attempt: 0 },
      ],
      observations: [
        validObservation,
        { ...validObservation, rating: 1 },
        { task: { id: 11, midi: 47, direction: "descending", kind: "initial", attempt: 0 }, rating: 0, ratedAt: STARTED_AT },
        { task: { id: 12, midi: 47, direction: "descending", kind: "initial", attempt: 0 }, rating: 2, ratedAt: "bad" },
      ],
      ascending: { status: "broken", plannedEdgeMidi: 999, pendingRetestMidi: 999 },
      descending: null,
      nextTaskId: -4,
      ratedProbeCount: 500,
    };
    const before = JSON.parse(JSON.stringify(candidate));
    const fallback = { anchorMidi: 46, preparation: "warmed" as const, startedAt: STARTED_AT, sessionId: "fallback" };

    const normalized = normalizeRangeSimulatorSession(candidate, fallback);

    expect(normalized).toEqual(createRangeSimulatorSession({
      anchorMidi: 48,
      preparation: "unwarmed",
      startedAt: STARTED_AT,
      sessionId: `range-map-${STARTED_AT}`,
    }));
    expect(candidate).toEqual(before);
    expect(normalizeRangeSimulatorSession(normalized, fallback)).toEqual(normalized);
  });

  it("ignores a claimed probing phase that has no replayable baseline history", () => {
    const source = createSession();
    const normalized = normalizeRangeSimulatorSession({
      ...source,
      phase: "probing",
      completionStatus: "in-progress",
      baselineMidi: null,
    }, { startedAt: STARTED_AT });

    expect(normalized).toMatchObject({
      phase: "baseline",
      completionStatus: "in-progress",
      baselineMidi: null,
      ratedProbeCount: 0,
      ascending: null,
      descending: null,
    });
  });

  it("round-trips valid active and explicitly stopped sessions by replaying observations", () => {
    let active = probingSession();
    active = rateCurrent(active, 1);
    active = rateCurrent(active, 2);
    const fallback = { startedAt: STARTED_AT };

    expect(normalizeRangeSimulatorSession(active, fallback)).toEqual(active);

    const stopped = stopRangeSimulatorSession(active, "2026-08-22T12:30:00.000Z");
    expect(normalizeRangeSimulatorSession(stopped, fallback)).toEqual(stopped);
  });
});

describe("range simulator invalid inputs", () => {
  it("rejects invalid session construction and baseline-anchor inputs", () => {
    expect(() => baselineCandidatesForAnchor(35)).toThrow(RangeError);
    expect(() => baselineCandidatesForAnchor(83.5)).toThrow(RangeError);
    expect(() => createRangeSimulatorSession({ anchorMidi: 84, startedAt: STARTED_AT })).toThrow(RangeError);
    expect(() => createRangeSimulatorSession({ anchorMidi: 48.5, startedAt: STARTED_AT })).toThrow(RangeError);
    expect(() => createRangeSimulatorSession({ startedAt: "not-a-date" })).toThrow(RangeError);
    expect(() => createRangeSimulatorSession({ preparation: "raw" as never, startedAt: STARTED_AT })).toThrow(RangeError);
  });

  it("rejects invalid or out-of-order ratings", () => {
    const session = createSession();
    const current = currentRangeSimulatorProbe(session)!;
    const submit = (taskId: number, rating: number, ratedAt = STARTED_AT) => rateRangeSimulatorProbe(session, {
      taskId,
      rating: rating as EffortRating,
      ratedAt,
    });

    expect(() => submit(current.id + 1, 1)).toThrow(Error);
    expect(() => submit(1.5, 1)).toThrow(RangeError);
    for (const rating of [0, 1.5, 6, Number.NaN]) {
      expect(() => submit(current.id, rating)).toThrow(RangeError);
    }
    expect(() => submit(current.id, 1, "not-a-date")).toThrow(RangeError);

    const advanced = rateCurrent(session, 1);
    const nextTask = currentRangeSimulatorProbe(advanced)!;
    expect(() => rateRangeSimulatorProbe(advanced, {
      taskId: nextTask.id,
      rating: 1,
      ratedAt: STARTED_AT,
    })).toThrow(RangeError);

    const stopped = stopRangeSimulatorSession(session, STARTED_AT);
    expect(() => rateRangeSimulatorProbe(stopped, {
      taskId: current.id,
      rating: 1,
      ratedAt: STARTED_AT,
    })).toThrow(Error);
  });

  it("rejects an invalid stop timestamp for an active session", () => {
    expect(() => stopRangeSimulatorSession(createSession(), "not-a-date")).toThrow(RangeError);

    const advanced = rateCurrent(createSession(), 1);
    expect(() => stopRangeSimulatorSession(advanced, STARTED_AT)).toThrow(RangeError);
  });
});
