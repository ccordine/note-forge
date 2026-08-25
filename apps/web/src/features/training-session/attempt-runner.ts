import type { PitchObservation } from "@/audio/note-input";
import {
  observationContinuity,
  type ObservationSampleAuthority,
} from "@/realtime/observation-continuity";
import {
  advanceAttemptScoringAggregate,
  createAttemptScoringAggregate,
  type AttemptScoringAggregate,
  type AttemptScoringProfile,
} from "./attempt-scoring-aggregate";

export type { AttemptScoringProfile } from "./attempt-scoring-aggregate";

export type AttemptRunnerStatus = "idle" | "tracking" | "complete";

type SampleCursor = ObservationSampleAuthority;

interface AttemptEvidenceChunk {
  readonly frames: readonly Readonly<PitchObservation>[];
  readonly frameElapsedSeconds: readonly number[];
  readonly observedIndices: readonly number[];
}

export interface AttemptVoicedRunSummary {
  readonly frameCount: number;
  readonly startedAtSeconds: number;
  readonly endedAtSeconds: number;
  readonly sumTimeSeconds: number;
  readonly sumMidiFloat: number;
  readonly sumTimeMidiProduct: number;
  readonly sumSquaredTimeSeconds: number;
}

interface AttemptTimeline {
  readonly elapsedSeconds: number;
  readonly startedAt: string | null;
  readonly evidenceChunks: readonly Readonly<AttemptEvidenceChunk>[];
  readonly retainedFrameCount: number;
  readonly recentEvidenceChunks: readonly Readonly<AttemptEvidenceChunk>[];
  readonly recentFrameCount: number;
  readonly observedFrameCount: number;
  readonly evidenceStride: number;
  readonly firstVoicedIndex: number | null;
  readonly scoringProfile: Readonly<AttemptScoringProfile> | null;
  readonly scoringAggregate: Readonly<AttemptScoringAggregate>;
  readonly activeVoicedRun: Readonly<AttemptVoicedRunSummary> | null;
  readonly longestVoicedRun: Readonly<AttemptVoicedRunSummary> | null;
  readonly cursor: Readonly<SampleCursor> | null;
}

export type AttemptRunnerState<Configuration> = AttemptTimeline & (
  | { readonly status: "idle"; readonly configuration: null }
  | { readonly status: "tracking"; readonly configuration: Readonly<Configuration> }
  | { readonly status: "complete"; readonly configuration: Readonly<Configuration> }
);

export type CompletedAttempt<Configuration> = AttemptTimeline & {
  readonly status: "complete";
  readonly configuration: Readonly<Configuration>;
};

export interface AttemptEvidence {
  readonly frames: readonly Readonly<PitchObservation>[];
  /** Sample-authoritative elapsed time paired by index with `frames`. */
  readonly frameElapsedSeconds: readonly number[];
  /** Original whole-session observation index paired by index with `frames`. */
  readonly observedIndices: readonly number[];
  /** Number of original observations represented by each retained point. */
  readonly representedFrameCounts: readonly number[];
}

export type AttemptScoringFrame = Readonly<PitchObservation> & {
  /** Statistical weight; presentation code must never use this as elapsed time. */
  readonly scoringWeight: number;
};

export type AttemptRunnerAction<Configuration> =
  | {
    readonly type: "begin";
    readonly configuration: Readonly<Configuration>;
    readonly startedAt: string;
    readonly scoringProfile?: Readonly<AttemptScoringProfile> | null;
  }
  | { readonly type: "observation"; readonly observation: Readonly<PitchObservation> }
  | { readonly type: "finish" }
  | { readonly type: "reset" };

const EVIDENCE_CHUNK_SIZE = 64;
const PINNED_OPENING_FRAME_COUNT = 32;
export const MAXIMUM_RECENT_TRACE_FRAMES = 512;
/**
 * A bounded, progressively decimated whole-session contour. The opening,
 * first voiced attack, and latest observation remain explicit; older evidence
 * is sampled uniformly instead of turning into a rolling tail.
 */
export const MAXIMUM_RETAINED_TRACE_FRAMES = 2_048;
const MAXIMUM_ARCHIVED_TRACE_FRAMES = MAXIMUM_RETAINED_TRACE_FRAMES
  - MAXIMUM_RECENT_TRACE_FRAMES;

export function createIdleAttemptRunner<Configuration>(): AttemptRunnerState<Configuration> {
  return {
    status: "idle",
    configuration: null,
    elapsedSeconds: 0,
    startedAt: null,
    evidenceChunks: [],
    retainedFrameCount: 0,
    recentEvidenceChunks: [],
    recentFrameCount: 0,
    observedFrameCount: 0,
    evidenceStride: 1,
    firstVoicedIndex: null,
    scoringProfile: null,
    scoringAggregate: createAttemptScoringAggregate(),
    activeVoicedRun: null,
    longestVoicedRun: null,
    cursor: null,
  };
}

export function beginAttempt<Configuration>(
  configuration: Readonly<Configuration>,
  startedAt: string,
  scoringProfile: Readonly<AttemptScoringProfile> | null = null,
): AttemptRunnerState<Configuration> {
  return {
    status: "tracking",
    configuration,
    elapsedSeconds: 0,
    startedAt,
    evidenceChunks: [],
    retainedFrameCount: 0,
    recentEvidenceChunks: [],
    recentFrameCount: 0,
    observedFrameCount: 0,
    evidenceStride: 1,
    firstVoicedIndex: null,
    scoringProfile,
    scoringAggregate: createAttemptScoringAggregate(),
    activeVoicedRun: null,
    longestVoicedRun: null,
    cursor: null,
  };
}

function evidenceFromChunks(
  chunks: readonly Readonly<AttemptEvidenceChunk>[],
): AttemptEvidence {
  const frames = chunks.flatMap((chunk) => chunk.frames);
  return {
    frames,
    frameElapsedSeconds: chunks.flatMap((chunk) => chunk.frameElapsedSeconds),
    observedIndices: chunks.flatMap((chunk) => chunk.observedIndices),
    representedFrameCounts: frames.map(() => 1),
  };
}

export function attemptRecentEvidence(timeline: Readonly<AttemptTimeline>): AttemptEvidence {
  return evidenceFromChunks(timeline.recentEvidenceChunks);
}

export function attemptEvidence(timeline: Readonly<AttemptTimeline>): AttemptEvidence {
  const archive = evidenceFromChunks(timeline.evidenceChunks);
  const recent = attemptRecentEvidence(timeline);
  const points = new Map<number, {
    frame: Readonly<PitchObservation>;
    elapsedSeconds: number;
  }>();
  archive.observedIndices.forEach((observedIndex, index) => points.set(observedIndex, {
    frame: archive.frames[index]!,
    elapsedSeconds: archive.frameElapsedSeconds[index]!,
  }));
  recent.observedIndices.forEach((observedIndex, index) => points.set(observedIndex, {
    frame: recent.frames[index]!,
    elapsedSeconds: recent.frameElapsedSeconds[index]!,
  }));
  const ordered = [...points.entries()].sort(([left], [right]) => left - right);
  const observedIndices = ordered.map(([observedIndex]) => observedIndex);
  return {
    frames: ordered.map(([, point]) => point.frame),
    frameElapsedSeconds: ordered.map(([, point]) => point.elapsedSeconds),
    observedIndices,
    representedFrameCounts: representedFrameCounts(
      observedIndices,
      timeline.observedFrameCount,
    ),
  };
}

/**
 * Partition every original observation between its nearest retained neighbors.
 * The resulting integer weights are non-overlapping and always sum to the
 * authoritative whole-session observation count. This prevents the exact
 * recent ring from becoming an increasingly overweight scoring tail.
 */
function representedFrameCounts(
  observedIndices: readonly number[],
  observedFrameCount: number,
): readonly number[] {
  if (observedIndices.length === 0) return [];
  let representedStart = 0;
  return observedIndices.map((observedIndex, index) => {
    const nextIndex = observedIndices[index + 1];
    const representedEnd = nextIndex === undefined
      ? observedFrameCount - 1
      : Math.floor((observedIndex + nextIndex) / 2);
    const count = Math.max(0, representedEnd - representedStart + 1);
    representedStart = representedEnd + 1;
    return count;
  });
}

function scoringFramesForEvidence(
  evidence: Readonly<AttemptEvidence>,
): readonly AttemptScoringFrame[] {
  return evidence.frames.map((frame, index) => {
    const timeSeconds = evidence.frameElapsedSeconds[index] ?? 0;
    const previousTime = evidence.frameElapsedSeconds[index - 1];
    const scoringWeight = evidence.representedFrameCounts[index] ?? 1;
    if (frame.discontinuity
      || (index > 0 && previousTime !== undefined && timeSeconds <= previousTime)) {
      return {
        ...frame,
        timeSeconds,
        scoringWeight,
        observationKind: "unvoiced",
        frequencyHz: null,
        midiFloat: null,
        nearestMidi: null,
        centsFromNearest: null,
        confidence: 0,
        periodicity: 0,
        voiced: false,
        periodSamples: null,
        yinValue: null,
        reason: "invalid-samples",
      };
    }
    return { ...frame, timeSeconds, scoringWeight };
  });
}

/** Give scoring the runner's gap/discontinuity-safe sample clock. */
export function attemptScoringFrames(
  timeline: Readonly<AttemptTimeline>,
): readonly AttemptScoringFrame[] {
  return scoringFramesForEvidence(attemptEvidence(timeline));
}

export function attemptRecentScoringFrames(
  timeline: Readonly<AttemptTimeline>,
): readonly AttemptScoringFrame[] {
  return scoringFramesForEvidence(attemptRecentEvidence(timeline));
}

function qualifiedVoicedObservation(
  observation: Readonly<PitchObservation>,
  scoringProfile: Readonly<AttemptScoringProfile> | null,
): observation is Readonly<PitchObservation> & { readonly midiFloat: number } {
  if (!(observation.voiced
    && !observation.discontinuity
    && observation.midiFloat !== null
    && Number.isFinite(observation.midiFloat)
    && Number.isFinite(observation.confidence)
    && observation.confidence >= (scoringProfile?.minimumConfidence ?? 0.5))) return false;
  return true;
}

function beginVoicedRun(
  elapsedSeconds: number,
  midiFloat: number,
): AttemptVoicedRunSummary {
  return {
    frameCount: 1,
    startedAtSeconds: elapsedSeconds,
    endedAtSeconds: elapsedSeconds,
    sumTimeSeconds: elapsedSeconds,
    sumMidiFloat: midiFloat,
    sumTimeMidiProduct: elapsedSeconds * midiFloat,
    sumSquaredTimeSeconds: elapsedSeconds * elapsedSeconds,
  };
}

function advanceVoicedRun(
  run: Readonly<AttemptVoicedRunSummary>,
  elapsedSeconds: number,
  midiFloat: number,
): AttemptVoicedRunSummary {
  return {
    frameCount: run.frameCount + 1,
    startedAtSeconds: run.startedAtSeconds,
    endedAtSeconds: elapsedSeconds,
    sumTimeSeconds: run.sumTimeSeconds + elapsedSeconds,
    sumMidiFloat: run.sumMidiFloat + midiFloat,
    sumTimeMidiProduct: run.sumTimeMidiProduct + elapsedSeconds * midiFloat,
    sumSquaredTimeSeconds: run.sumSquaredTimeSeconds + elapsedSeconds * elapsedSeconds,
  };
}

function runDuration(run: Readonly<AttemptVoicedRunSummary>): number {
  return run.endedAtSeconds - run.startedAtSeconds;
}

interface AppendedEvidence {
  readonly chunks: readonly Readonly<AttemptEvidenceChunk>[];
  readonly retainedFrameCount: number;
  readonly evidenceStride: number;
}

function isCanonicalEvidenceIndex(
  observedIndex: number,
  evidenceStride: number,
  firstVoicedIndex: number | null,
): boolean {
  return observedIndex < PINNED_OPENING_FRAME_COUNT
    || observedIndex === firstVoicedIndex
    || observedIndex % evidenceStride === 0;
}

function evidencePoints(chunks: readonly Readonly<AttemptEvidenceChunk>[]) {
  return chunks.flatMap((chunk) => chunk.frames.map((frame, index) => ({
    frame,
    elapsedSeconds: chunk.frameElapsedSeconds[index]!,
    observedIndex: chunk.observedIndices[index]!,
  })));
}

function chunksFromEvidencePoints(
  points: ReturnType<typeof evidencePoints>,
): readonly Readonly<AttemptEvidenceChunk>[] {
  const chunks: AttemptEvidenceChunk[] = [];
  for (let offset = 0; offset < points.length; offset += EVIDENCE_CHUNK_SIZE) {
    const slice = points.slice(offset, offset + EVIDENCE_CHUNK_SIZE);
    chunks.push({
      frames: slice.map((point) => point.frame),
      frameElapsedSeconds: slice.map((point) => point.elapsedSeconds),
      observedIndices: slice.map((point) => point.observedIndex),
    });
  }
  return chunks;
}

function withoutLastEvidence(
  chunks: readonly Readonly<AttemptEvidenceChunk>[],
): readonly Readonly<AttemptEvidenceChunk>[] {
  const last = chunks.at(-1);
  if (!last) return chunks;
  if (last.frames.length === 1) return chunks.slice(0, -1);
  return [
    ...chunks.slice(0, -1),
    {
      frames: last.frames.slice(0, -1),
      frameElapsedSeconds: last.frameElapsedSeconds.slice(0, -1),
      observedIndices: last.observedIndices.slice(0, -1),
    },
  ];
}

function withoutFirstEvidence(
  chunks: readonly Readonly<AttemptEvidenceChunk>[],
): readonly Readonly<AttemptEvidenceChunk>[] {
  const first = chunks[0];
  if (!first) return chunks;
  if (first.frames.length === 1) return chunks.slice(1);
  return [
    {
      frames: first.frames.slice(1),
      frameElapsedSeconds: first.frameElapsedSeconds.slice(1),
      observedIndices: first.observedIndices.slice(1),
    },
    ...chunks.slice(1),
  ];
}

function appendEvidencePoint(
  chunks: readonly Readonly<AttemptEvidenceChunk>[],
  observation: Readonly<PitchObservation>,
  elapsedSeconds: number,
  observedIndex: number,
): readonly Readonly<AttemptEvidenceChunk>[] {
  const last = chunks.at(-1);
  if (last && last.frames.length < EVIDENCE_CHUNK_SIZE) {
    return [
      ...chunks.slice(0, -1),
      {
        frames: [...last.frames, observation],
        frameElapsedSeconds: [...last.frameElapsedSeconds, elapsedSeconds],
        observedIndices: [...last.observedIndices, observedIndex],
      },
    ];
  }
  return [
    ...chunks,
    {
      frames: [observation],
      frameElapsedSeconds: [elapsedSeconds],
      observedIndices: [observedIndex],
    },
  ];
}

function appendEvidence(
  state: Readonly<AttemptTimeline>,
  observation: Readonly<PitchObservation>,
  elapsedSeconds: number,
  firstVoicedIndex: number | null,
): AppendedEvidence {
  const observedIndex = state.observedFrameCount;
  let evidenceStride = state.evidenceStride;
  let chunks = state.evidenceChunks;
  let retainedFrameCount = state.retainedFrameCount;

  const lastIndex = chunks.at(-1)?.observedIndices.at(-1);
  if (lastIndex !== undefined
    && !isCanonicalEvidenceIndex(lastIndex, evidenceStride, firstVoicedIndex)) {
    chunks = withoutLastEvidence(chunks);
    retainedFrameCount -= 1;
  }

  while (retainedFrameCount >= MAXIMUM_ARCHIVED_TRACE_FRAMES - 1) {
    evidenceStride *= 2;
    const compacted = evidencePoints(chunks).filter((point) => (
      isCanonicalEvidenceIndex(point.observedIndex, evidenceStride, firstVoicedIndex)
    ));
    chunks = chunksFromEvidencePoints(compacted);
    retainedFrameCount = compacted.length;
  }

  chunks = appendEvidencePoint(chunks, observation, elapsedSeconds, observedIndex);
  return { chunks, retainedFrameCount: retainedFrameCount + 1, evidenceStride };
}

export function advanceAttempt<Configuration>(
  state: Readonly<AttemptRunnerState<Configuration>>,
  observation: Readonly<PitchObservation>,
): AttemptRunnerState<Configuration> {
  if (state.status !== "tracking") return state;
  const continuity = observationContinuity(state.cursor, observation);
  if (!continuity.accepted || continuity.authority === null) return state;
  const elapsedDelta = continuity.deltaSeconds;
  const elapsedSeconds = state.elapsedSeconds + elapsedDelta;
  const contiguousWithPrevious = state.cursor === null
    || continuity.contiguous;
  const pitchAdmitted = !observation.discontinuity && contiguousWithPrevious;
  let activeVoicedRun = pitchAdmitted ? state.activeVoicedRun : null;
  if (pitchAdmitted && qualifiedVoicedObservation(observation, state.scoringProfile)) {
    const maximumGapSeconds = state.scoringProfile?.maximumVoicedGapSeconds ?? 0.1;
    activeVoicedRun = activeVoicedRun
      && elapsedSeconds - activeVoicedRun.endedAtSeconds <= maximumGapSeconds
      ? advanceVoicedRun(activeVoicedRun, elapsedSeconds, observation.midiFloat)
      : beginVoicedRun(elapsedSeconds, observation.midiFloat);
  }
  const longestVoicedRun = activeVoicedRun && (
    state.longestVoicedRun === null
    || runDuration(activeVoicedRun) > runDuration(state.longestVoicedRun)
  ) ? activeVoicedRun : state.longestVoicedRun;
  const firstVoicedIndex = state.firstVoicedIndex
    ?? (observation.voiced ? state.observedFrameCount : null);
  const evidence = appendEvidence(state, observation, elapsedSeconds, firstVoicedIndex);
  let recentEvidenceChunks = appendEvidencePoint(
    state.recentEvidenceChunks,
    observation,
    elapsedSeconds,
    state.observedFrameCount,
  );
  const recentFrameCount = Math.min(
    MAXIMUM_RECENT_TRACE_FRAMES,
    state.recentFrameCount + 1,
  );
  if (state.recentFrameCount >= MAXIMUM_RECENT_TRACE_FRAMES) {
    recentEvidenceChunks = withoutFirstEvidence(recentEvidenceChunks);
  }
  return {
    ...state,
    status: "tracking",
    elapsedSeconds,
    evidenceChunks: evidence.chunks,
    retainedFrameCount: evidence.retainedFrameCount,
    recentEvidenceChunks,
    recentFrameCount,
    observedFrameCount: state.observedFrameCount + 1,
    evidenceStride: evidence.evidenceStride,
    firstVoicedIndex,
    activeVoicedRun,
    longestVoicedRun,
    scoringAggregate: advanceAttemptScoringAggregate(
      state.scoringAggregate,
      observation,
      elapsedSeconds,
      state.scoringProfile,
      pitchAdmitted,
    ),
    cursor: continuity.authority,
  };
}

export function finishAttempt<Configuration>(
  state: Readonly<AttemptRunnerState<Configuration>>,
): AttemptRunnerState<Configuration> {
  if (state.status !== "tracking") return state;
  return { ...state, status: "complete" };
}

export function reduceAttemptRunner<Configuration>(
  state: Readonly<AttemptRunnerState<Configuration>>,
  action: Readonly<AttemptRunnerAction<Configuration>>,
): AttemptRunnerState<Configuration> {
  switch (action.type) {
    case "begin":
      return beginAttempt(action.configuration, action.startedAt, action.scoringProfile);
    case "observation":
      return advanceAttempt(state, action.observation);
    case "finish":
      return finishAttempt(state);
    case "reset":
      return createIdleAttemptRunner();
  }
}
