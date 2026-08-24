/** Every equal-tempered semitone enclosed by the canonical 45–1,200 Hz detector. */
export const RANGE_SIMULATOR_MIN_MIDI = 30;
export const RANGE_SIMULATOR_MAX_MIDI = 86;
export const RANGE_SIMULATOR_MAX_RATED_PROBES = 24;
export const RANGE_SIMULATOR_INITIAL_RADIUS = 4;

export type EffortRating = 1 | 2 | 3 | 4 | 5;
export type ProbeDirection = "center" | "ascending" | "descending";
export type ProbeKind = "baseline-candidate" | "initial" | "expansion" | "retest";
export type RangePreparation = "unwarmed" | "light-warmup" | "warmed";

export const EFFORT_RATING_LABELS: Readonly<Record<EffortRating, { label: string; detail: string }>> = {
  1: { label: "Effortless", detail: "Automatic and repeatable" },
  2: { label: "Easy", detail: "Clean with little attention" },
  3: { label: "Deliberate", detail: "Workable; effort is noticeable" },
  4: { label: "Unstable", detail: "Inconsistent or coordination is unclear" },
  5: { label: "Can't reliably produce", detail: "Close this direction for today" },
};

export interface ProbeTask {
  id: number;
  midi: number;
  direction: ProbeDirection;
  kind: ProbeKind;
  attempt: 0 | 1;
}

export interface CoordinationFlags {
  ascending: boolean;
  descending: boolean;
}

export interface RatedProbe {
  task: ProbeTask;
  rating: EffortRating;
  coordination: CoordinationFlags;
  ratedAt: string;
}

export type ProbeSideStatus = "open" | "awaiting-retest" | "closed-unstable" | "closed-unreliable" | "capped" | "incomplete";

export interface ProbeSideState {
  direction: "ascending" | "descending";
  status: ProbeSideStatus;
  plannedEdgeMidi: number;
  pendingRetestMidi: number | null;
}

export type RangeSimulatorPhase = "baseline" | "probing" | "complete";
export type RangeSimulatorCompletionStatus = "in-progress" | "complete" | "probe-cap" | "no-usable-baseline" | "stopped";

export interface RangeSimulatorSessionState {
  sessionId: string;
  anchorMidi: number;
  preparation: RangePreparation;
  startedAt: string;
  updatedAt: string;
  phase: RangeSimulatorPhase;
  completionStatus: RangeSimulatorCompletionStatus;
  baselineCandidates: number[];
  baselineMidi: number | null;
  queue: ProbeTask[];
  observations: RatedProbe[];
  ascending: ProbeSideState | null;
  descending: ProbeSideState | null;
  nextTaskId: number;
  ratedProbeCount: number;
}

export interface CreateRangeSimulatorOptions {
  anchorMidi?: number;
  preparation?: RangePreparation;
  startedAt: string;
  sessionId?: string;
}

export interface RateRangeSimulatorProbeInput {
  taskId: number;
  rating: EffortRating;
  coordinationChange?: boolean;
  ratedAt: string;
}

const DIRECTIONS = new Set<ProbeDirection>(["center", "ascending", "descending"]);
const KINDS = new Set<ProbeKind>(["baseline-candidate", "initial", "expansion", "retest"]);
const PREPARATIONS = new Set<RangePreparation>(["unwarmed", "light-warmup", "warmed"]);

function isMidi(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= RANGE_SIMULATOR_MIN_MIDI
    && (value as number) <= RANGE_SIMULATOR_MAX_MIDI;
}

function requireMidi(value: number, label = "MIDI note"): void {
  if (!isMidi(value)) {
    throw new RangeError(`${label} must be an integer from ${RANGE_SIMULATOR_MIN_MIDI} through ${RANGE_SIMULATOR_MAX_MIDI}.`);
  }
}

function isRating(value: unknown): value is EffortRating {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5;
}

function canonicalDate(value: string, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new RangeError(`${label} must be a valid date.`);
  return new Date(value).toISOString();
}

function isPreparation(value: unknown): value is RangePreparation {
  return typeof value === "string" && PREPARATIONS.has(value as RangePreparation);
}

export function baselineCandidatesForAnchor(anchorMidi: number): number[] {
  requireMidi(anchorMidi, "Baseline anchor");
  return [...new Set([anchorMidi, anchorMidi - 2, anchorMidi - 1, anchorMidi + 1, anchorMidi + 2]
    .filter(isMidi))];
}

function createTasks(
  midis: readonly number[],
  direction: ProbeDirection,
  kind: ProbeKind,
  firstId: number,
  attempt: 0 | 1 = 0,
): ProbeTask[] {
  return midis.map((midi, index) => ({ id: firstId + index, midi, direction, kind, attempt }));
}

export function createRangeSimulatorSession(options: Readonly<CreateRangeSimulatorOptions>): RangeSimulatorSessionState {
  const anchorMidi = options.anchorMidi ?? 48;
  requireMidi(anchorMidi, "Baseline anchor");
  const startedAt = canonicalDate(options.startedAt, "Session start");
  const preparation = options.preparation ?? "unwarmed";
  if (!isPreparation(preparation)) throw new RangeError(`Unknown preparation: ${String(preparation)}`);
  const sessionId = options.sessionId?.trim() || `range-map-${startedAt}`;
  const baselineCandidates = baselineCandidatesForAnchor(anchorMidi);
  const queue = createTasks(baselineCandidates, "center", "baseline-candidate", 1);
  return {
    sessionId,
    anchorMidi,
    preparation,
    startedAt,
    updatedAt: startedAt,
    phase: "baseline",
    completionStatus: "in-progress",
    baselineCandidates,
    baselineMidi: null,
    queue,
    observations: [],
    ascending: null,
    descending: null,
    nextTaskId: queue.length + 1,
    ratedProbeCount: 0,
  };
}

export function currentRangeSimulatorProbe(session: Readonly<RangeSimulatorSessionState>): ProbeTask | null {
  return session.phase === "complete" ? null : session.queue[0] ?? null;
}

function chooseBaseline(session: Readonly<RangeSimulatorSessionState>, observations: readonly RatedProbe[]): number | null {
  const candidates = observations
    .filter((observation) => observation.task.kind === "baseline-candidate")
    .map((observation) => ({ midi: observation.task.midi, rating: observation.rating }))
    .sort((left, right) => left.rating - right.rating
      || Math.abs(left.midi - session.anchorMidi) - Math.abs(right.midi - session.anchorMidi)
      || left.midi - right.midi);
  return candidates[0] && candidates[0].rating <= 3 ? candidates[0].midi : null;
}

function initializeProbeBand(
  baselineMidi: number,
  nextTaskId: number,
): Pick<RangeSimulatorSessionState, "queue" | "ascending" | "descending" | "nextTaskId"> {
  const ascendingMidis = Array.from({ length: RANGE_SIMULATOR_INITIAL_RADIUS }, (_, index) => baselineMidi + index + 1).filter(isMidi);
  const descendingMidis = Array.from({ length: RANGE_SIMULATOR_INITIAL_RADIUS }, (_, index) => baselineMidi - index - 1).filter(isMidi);
  const centerTasks = createTasks([baselineMidi], "center", "initial", nextTaskId);
  const ascendingTasks = createTasks(ascendingMidis, "ascending", "initial", nextTaskId + centerTasks.length);
  const descendingTasks = createTasks(descendingMidis, "descending", "initial", nextTaskId + centerTasks.length + ascendingTasks.length);
  const queue = [...centerTasks, ...ascendingTasks, ...descendingTasks];
  return {
    queue,
    ascending: {
      direction: "ascending",
      status: ascendingMidis.length === 0 ? "capped" : "open",
      plannedEdgeMidi: ascendingMidis.at(-1) ?? baselineMidi,
      pendingRetestMidi: null,
    },
    descending: {
      direction: "descending",
      status: descendingMidis.length === 0 ? "capped" : "open",
      plannedEdgeMidi: descendingMidis.at(-1) ?? baselineMidi,
      pendingRetestMidi: null,
    },
    nextTaskId: nextTaskId + queue.length,
  };
}

function sideKey(direction: ProbeDirection): "ascending" | "descending" | null {
  return direction === "ascending" || direction === "descending" ? direction : null;
}

function nextOutwardMidis(direction: "ascending" | "descending", edgeMidi: number, count: number): number[] {
  const step = direction === "ascending" ? 1 : -1;
  return Array.from({ length: count }, (_, index) => edgeMidi + step * (index + 1)).filter(isMidi);
}

function finalizeIfFinished(session: RangeSimulatorSessionState): RangeSimulatorSessionState {
  if (session.phase === "complete") return session;
  const sides = [session.ascending, session.descending];
  const bothClosed = sides.every((side) => side !== null && side.status !== "open" && side.status !== "awaiting-retest");
  if (session.queue.length === 0 && bothClosed) {
    return { ...session, phase: "complete", completionStatus: "complete" };
  }
  return session;
}

function markOpenSidesIncomplete(session: RangeSimulatorSessionState): RangeSimulatorSessionState {
  const markSide = (side: ProbeSideState | null): ProbeSideState | null => side !== null
    && (side.status === "open" || side.status === "awaiting-retest")
    ? { ...side, status: "incomplete", pendingRetestMidi: null }
    : side;
  return {
    ...session,
    ascending: markSide(session.ascending),
    descending: markSide(session.descending),
  };
}

export function rateRangeSimulatorProbe(
  session: Readonly<RangeSimulatorSessionState>,
  input: Readonly<RateRangeSimulatorProbeInput>,
): RangeSimulatorSessionState {
  if (session.phase === "complete") throw new Error("This range-map session is already complete.");
  if (!Number.isInteger(input.taskId)) throw new RangeError("Task ID must be an integer.");
  if (!isRating(input.rating)) throw new RangeError("Rating must be an integer from 1 through 5.");
  const ratedAt = canonicalDate(input.ratedAt, "Rating timestamp");
  if (Date.parse(ratedAt) < Date.parse(session.updatedAt)) {
    throw new RangeError("Rating timestamp cannot be earlier than the current session state.");
  }
  const task = currentRangeSimulatorProbe(session);
  if (!task || task.id !== input.taskId) throw new Error("Only the current range probe can be rated.");
  const coordinationChange = input.coordinationChange === true;
  const observation: RatedProbe = {
    task: { ...task },
    rating: input.rating,
    coordination: {
      ascending: coordinationChange && task.direction === "ascending",
      descending: coordinationChange && task.direction === "descending",
    },
    ratedAt,
  };
  const observations = [...session.observations, observation];
  const ratedProbeCount = observations.length;
  let next: RangeSimulatorSessionState = {
    ...session,
    updatedAt: ratedAt,
    observations,
    queue: session.queue.slice(1),
    ratedProbeCount,
  };

  if (session.phase === "baseline") {
    if (next.queue.length > 0) return next;
    const baselineMidi = chooseBaseline(session, observations);
    if (baselineMidi === null) {
      return { ...next, phase: "complete", completionStatus: "no-usable-baseline", baselineMidi: null };
    }
    const initialized = initializeProbeBand(baselineMidi, next.nextTaskId);
    return {
      ...next,
      ...initialized,
      phase: "probing",
      baselineMidi,
    };
  }

  if (task.direction === "center") {
    if (input.rating === 5 || (input.rating === 4 && (task.kind === "retest" || task.attempt === 1))) {
      return {
        ...next,
        phase: "complete",
        completionStatus: "no-usable-baseline",
        baselineMidi: null,
        ascending: null,
        descending: null,
        queue: [],
      };
    }
    if (input.rating === 4) {
      const retest: ProbeTask = {
        id: next.nextTaskId,
        midi: task.midi,
        direction: "center",
        kind: "retest",
        attempt: 1,
      };
      next = {
        ...next,
        queue: [retest, ...next.queue],
        nextTaskId: next.nextTaskId + 1,
      };
    }
  } else {
    const key = sideKey(task.direction)!;
    const currentSide = next[key]!;
    if (input.rating === 5) {
      next = {
        ...next,
        [key]: { ...currentSide, status: "closed-unreliable", plannedEdgeMidi: task.midi, pendingRetestMidi: null },
        queue: next.queue.filter((candidate) => candidate.direction !== task.direction),
      };
    } else if (input.rating === 4) {
      if (task.kind === "retest" || task.attempt === 1) {
        next = {
          ...next,
          [key]: { ...currentSide, status: "closed-unstable", plannedEdgeMidi: task.midi, pendingRetestMidi: null },
          queue: next.queue.filter((candidate) => candidate.direction !== task.direction),
        };
      } else {
        const retainedQueue = next.queue.filter((candidate) => candidate.direction !== task.direction);
        const retest: ProbeTask = {
          id: next.nextTaskId,
          midi: task.midi,
          direction: task.direction,
          kind: "retest",
          attempt: 1,
        };
        next = {
          ...next,
          [key]: { ...currentSide, status: "awaiting-retest", plannedEdgeMidi: task.midi, pendingRetestMidi: task.midi },
          queue: [...retainedQueue, retest],
          nextTaskId: next.nextTaskId + 1,
        };
      }
    } else {
      const remainingInDirection = next.queue.some((candidate) => candidate.direction === task.direction);
      const reopenedSide: ProbeSideState = {
        ...currentSide,
        status: "open",
        plannedEdgeMidi: task.midi,
        pendingRetestMidi: null,
      };
      next = { ...next, [key]: reopenedSide };
      if (!remainingInDirection) {
        const expansionCount = input.rating <= 2 ? 2 : 1;
        const midis = nextOutwardMidis(key, task.midi, expansionCount);
        if (midis.length === 0) {
          next = { ...next, [key]: { ...reopenedSide, status: "capped" } };
        } else {
          const tasks = createTasks(midis, key, "expansion", next.nextTaskId);
          next = {
            ...next,
            [key]: { ...reopenedSide, plannedEdgeMidi: midis.at(-1)! },
            queue: [...next.queue, ...tasks],
            nextTaskId: next.nextTaskId + tasks.length,
          };
        }
      }
    }
  }

  const finalized = finalizeIfFinished(next);
  if (finalized.phase === "complete") return finalized;
  if (ratedProbeCount >= RANGE_SIMULATOR_MAX_RATED_PROBES) {
    return markOpenSidesIncomplete({ ...finalized, phase: "complete", completionStatus: "probe-cap", queue: [] });
  }
  return finalized;
}

export function stopRangeSimulatorSession(
  session: Readonly<RangeSimulatorSessionState>,
  stoppedAt: string,
): RangeSimulatorSessionState {
  if (session.phase === "complete") return { ...session };
  const canonicalStoppedAt = canonicalDate(stoppedAt, "Session stop");
  if (Date.parse(canonicalStoppedAt) < Date.parse(session.updatedAt)) {
    throw new RangeError("Session stop cannot be earlier than the current session state.");
  }
  return markOpenSidesIncomplete({
    ...session,
    updatedAt: canonicalStoppedAt,
    phase: "complete",
    completionStatus: "stopped",
    queue: [],
  });
}

function normalizeTask(candidate: unknown): ProbeTask | null {
  if (!candidate || typeof candidate !== "object") return null;
  const source = candidate as Partial<ProbeTask>;
  if (!Number.isInteger(source.id) || (source.id as number) < 1 || !isMidi(source.midi)) return null;
  if (typeof source.direction !== "string" || !DIRECTIONS.has(source.direction as ProbeDirection)) return null;
  if (typeof source.kind !== "string" || !KINDS.has(source.kind as ProbeKind)) return null;
  if (source.attempt !== 0 && source.attempt !== 1) return null;
  return { id: source.id as number, midi: source.midi, direction: source.direction as ProbeDirection, kind: source.kind as ProbeKind, attempt: source.attempt };
}

export function normalizeRangeSimulatorSession(
  candidate: unknown,
  fallback: Readonly<CreateRangeSimulatorOptions>,
): RangeSimulatorSessionState {
  if (!candidate || typeof candidate !== "object") return createRangeSimulatorSession(fallback);
  const source = candidate as Partial<RangeSimulatorSessionState>;
  if (!isMidi(source.anchorMidi)) return createRangeSimulatorSession(fallback);
  if (typeof source.startedAt !== "string" || !Number.isFinite(Date.parse(source.startedAt))) return createRangeSimulatorSession(fallback);
  const startedAt = new Date(source.startedAt).toISOString();
  const sessionId = typeof source.sessionId === "string" && source.sessionId.trim()
    ? source.sessionId
    : `range-map-${startedAt}`;
  const preparation = isPreparation(source.preparation) ? source.preparation : "unwarmed";
  let replayed = createRangeSimulatorSession({
    anchorMidi: source.anchorMidi,
    preparation,
    startedAt,
    sessionId,
  });
  if (Array.isArray(source.observations)) {
    for (const raw of source.observations) {
      if (replayed.phase === "complete") break;
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Partial<RatedProbe>;
      const task = normalizeTask(item.task);
      const expected = currentRangeSimulatorProbe(replayed);
      if (!task || !expected || !isRating(item.rating)) continue;
      if (task.id !== expected.id
        || task.midi !== expected.midi
        || task.direction !== expected.direction
        || task.kind !== expected.kind
        || task.attempt !== expected.attempt) continue;
      if (typeof item.ratedAt !== "string" || !Number.isFinite(Date.parse(item.ratedAt))) continue;
      const ratedAt = new Date(item.ratedAt).toISOString();
      if (Date.parse(ratedAt) < Date.parse(replayed.updatedAt)) continue;
      replayed = rateRangeSimulatorProbe(replayed, {
        taskId: expected.id,
        rating: item.rating,
        coordinationChange: expected.direction === "ascending"
          ? item.coordination?.ascending === true
          : expected.direction === "descending" && item.coordination?.descending === true,
        ratedAt,
      });
    }
  }
  if (source.phase === "complete" && source.completionStatus === "stopped" && replayed.phase !== "complete") {
    const stoppedAt = typeof source.updatedAt === "string"
      && Number.isFinite(Date.parse(source.updatedAt))
      && Date.parse(source.updatedAt) >= Date.parse(replayed.updatedAt)
      ? new Date(source.updatedAt).toISOString()
      : replayed.updatedAt;
    replayed = stopRangeSimulatorSession(replayed, stoppedAt);
  }
  return replayed;
}
