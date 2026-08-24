import type { PitchObservation } from "@/audio/note-input";
import { MICROPHONE_ANALYSIS_HOP_SECONDS } from "@/audio/microphone";

export type AttemptRunnerStatus = "idle" | "tracking" | "complete";

interface SampleCursor {
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly endSample: number;
}

interface AttemptTimeline {
  readonly durationSeconds: number;
  readonly elapsedSeconds: number;
  readonly startedAt: string | null;
  readonly frames: readonly Readonly<PitchObservation>[];
  /** Sample-authoritative elapsed time paired by index with `frames`. */
  readonly frameElapsedSeconds: readonly number[];
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

export type AttemptRunnerAction<Configuration> =
  | {
    readonly type: "begin";
    readonly configuration: Readonly<Configuration>;
    readonly durationSeconds: number;
    readonly startedAt: string;
  }
  | { readonly type: "observation"; readonly observation: Readonly<PitchObservation> }
  | { readonly type: "finish" }
  | { readonly type: "reset" };

const MAXIMUM_HOP_SECONDS = MICROPHONE_ANALYSIS_HOP_SECONDS * 1.05;

export function createIdleAttemptRunner<Configuration>(): AttemptRunnerState<Configuration> {
  return {
    status: "idle",
    configuration: null,
    durationSeconds: 0,
    elapsedSeconds: 0,
    startedAt: null,
    frames: [],
    frameElapsedSeconds: [],
    cursor: null,
  };
}

export function beginAttempt<Configuration>(
  configuration: Readonly<Configuration>,
  durationSeconds: number,
  startedAt: string,
): AttemptRunnerState<Configuration> {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError("Attempt duration must be finite and positive.");
  }
  return {
    status: "tracking",
    configuration,
    durationSeconds,
    elapsedSeconds: 0,
    startedAt,
    frames: [],
    frameElapsedSeconds: [],
    cursor: null,
  };
}

function cursorFor(observation: Readonly<PitchObservation>): SampleCursor {
  return {
    captureEpoch: observation.captureEpoch,
    continuityEpoch: observation.continuityEpoch,
    graphGeneration: observation.graphGeneration,
    endSample: observation.endSample,
  };
}

function elapsedDeltaSeconds(
  cursor: Readonly<SampleCursor> | null,
  observation: Readonly<PitchObservation>,
): number {
  if (!cursor || observation.discontinuity) return 0;
  if (
    cursor.captureEpoch !== observation.captureEpoch
    || cursor.continuityEpoch !== observation.continuityEpoch
    || cursor.graphGeneration !== observation.graphGeneration
  ) return 0;

  const deltaSamples = observation.endSample - cursor.endSample;
  const maximumHopSamples = Math.ceil(observation.sampleRate * MAXIMUM_HOP_SECONDS);
  if (deltaSamples <= 0 || deltaSamples > maximumHopSamples) return 0;
  return deltaSamples / observation.sampleRate;
}

export function advanceAttempt<Configuration>(
  state: Readonly<AttemptRunnerState<Configuration>>,
  observation: Readonly<PitchObservation>,
): AttemptRunnerState<Configuration> {
  if (state.status !== "tracking") return state;
  const elapsedSeconds = Math.min(
    state.durationSeconds,
    state.elapsedSeconds + elapsedDeltaSeconds(state.cursor, observation),
  );
  return {
    ...state,
    status: elapsedSeconds >= state.durationSeconds ? "complete" : "tracking",
    elapsedSeconds,
    frames: [...state.frames, observation],
    frameElapsedSeconds: [...state.frameElapsedSeconds, elapsedSeconds],
    cursor: cursorFor(observation),
  };
}

export function finishAttempt<Configuration>(
  state: Readonly<AttemptRunnerState<Configuration>>,
): AttemptRunnerState<Configuration> {
  if (state.status !== "tracking" || state.frames.length === 0) return state;
  return { ...state, status: "complete" };
}

export function reduceAttemptRunner<Configuration>(
  state: Readonly<AttemptRunnerState<Configuration>>,
  action: Readonly<AttemptRunnerAction<Configuration>>,
): AttemptRunnerState<Configuration> {
  switch (action.type) {
    case "begin":
      return beginAttempt(action.configuration, action.durationSeconds, action.startedAt);
    case "observation":
      return advanceAttempt(state, action.observation);
    case "finish":
      return finishAttempt(state);
    case "reset":
      return createIdleAttemptRunner();
  }
}
