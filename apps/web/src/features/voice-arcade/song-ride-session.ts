import type { PitchObservation } from "@/audio/note-input";
import { clamp } from "@/lib/numeric";
import { isAuthoritativeVoicedPitch } from "@/realtime/authoritative-voiced-pitch";
import {
  observationContinuity,
  type ObservationSampleAuthority,
} from "@/realtime/observation-continuity";
import type { SongLaneAnalysis, SongTargetLane } from "./song-lane-types";

export interface LoadedSongTrack {
  readonly name: string;
  readonly sizeBytes: number;
  readonly url: string;
}

export interface SongLaneMetrics {
  observedSeconds: number;
  voicedSeconds: number;
  inLaneSeconds: number;
  absoluteErrorCentSeconds: number;
}

export interface SongScoreRuntime {
  readonly laneMetrics: Map<string, SongLaneMetrics>;
  readonly settledLaneIds: Set<string>;
  settledScoreTotal: number;
  settledLaneCount: number;
  hitLanes: number;
  combo: number;
  bestCombo: number;
  nextLaneToSettle: number;
  authority: ObservationSampleAuthority | null;
}

export interface SongHud {
  readonly score: number;
  readonly accuracyPercent: number;
  readonly combo: number;
  readonly bestCombo: number;
  readonly hitLanes: number;
  readonly attemptedLanes: number;
}

export interface SongRideResult extends SongHud {
  readonly grade: string;
  readonly gradeLabel: string;
  readonly completionPercent: number;
  readonly voicedCoveragePercent: number;
  readonly playedSeconds: number;
}

export type SongRidePhase =
  | "upload"
  | "analyzing"
  | "ready"
  | "playing"
  | "result";

export type SongPlaybackState = "stopped" | "playing" | "paused" | "ended";

export interface SongRideSession {
  readonly phase: SongRidePhase;
  readonly playbackState: SongPlaybackState;
  readonly track: LoadedSongTrack | null;
  readonly analysis: SongLaneAnalysis | null;
  readonly status: string;
  readonly error: string;
  readonly currentTime: number;
  /** Latest detector evidence sampled by the bounded song presentation clock. */
  readonly liveObservation: Readonly<PitchObservation> | null;
  readonly hud: SongHud;
  readonly result: SongRideResult | null;
}

export type SongRideAction =
  | Readonly<{ type: "analysis-started"; status: string }>
  | Readonly<{ type: "analysis-status"; status: string }>
  | Readonly<{ type: "analysis-ready"; track: LoadedSongTrack; analysis: SongLaneAnalysis; status: string }>
  | Readonly<{ type: "analysis-failed"; error: string }>
  | Readonly<{ type: "run-started" }>
  | Readonly<{ type: "playback-resumed" }>
  | Readonly<{ type: "playback-paused"; status: string }>
  | Readonly<{
      type: "run-progress";
      currentTime: number;
      hud: SongHud;
      liveObservation: Readonly<PitchObservation> | null;
    }>
  | Readonly<{ type: "track-completed"; result: SongRideResult; status: string }>
  | Readonly<{ type: "run-finished"; result: SongRideResult; status: string }>
  | Readonly<{ type: "ready-error"; error: string }>
  | Readonly<{ type: "session-error"; error: string }>
  | Readonly<{ type: "clear-track" }>;

export const EMPTY_SONG_HUD: SongHud = Object.freeze({
  score: 0,
  accuracyPercent: 0,
  combo: 0,
  bestCombo: 0,
  hitLanes: 0,
  attemptedLanes: 0,
});

export const INITIAL_SONG_RIDE_SESSION: SongRideSession = Object.freeze({
  phase: "upload",
  playbackState: "stopped",
  track: null,
  analysis: null,
  status: "Choose a local audio file to generate a playable pitch challenge.",
  error: "",
  currentTime: 0,
  liveObservation: null,
  hud: EMPTY_SONG_HUD,
  result: null,
});

export function reduceSongRideSession(
  state: Readonly<SongRideSession>,
  action: Readonly<SongRideAction>,
): SongRideSession {
  switch (action.type) {
    case "analysis-started":
      return {
        ...state,
        phase: "analyzing",
        playbackState: "stopped",
        status: action.status,
        error: "",
        result: null,
      };
    case "analysis-status":
      return { ...state, status: action.status };
    case "analysis-ready":
      return {
        phase: "ready",
        playbackState: "stopped",
        track: action.track,
        analysis: action.analysis,
        status: action.status,
        error: "",
        currentTime: 0,
        liveObservation: null,
        hud: EMPTY_SONG_HUD,
        result: null,
      };
    case "analysis-failed":
      return {
        ...state,
        phase: state.analysis ? "ready" : "upload",
        playbackState: "stopped",
        status: "Nothing was uploaded; processing stayed in this browser tab.",
        error: action.error,
      };
    case "run-started":
      return {
        ...state,
        phase: "playing",
        playbackState: "playing",
        status: "Rail live. Meet each block at the playhead; silent gaps are breathing space.",
        error: "",
        currentTime: 0,
        liveObservation: null,
        hud: EMPTY_SONG_HUD,
        result: null,
      };
    case "playback-resumed":
      return { ...state, playbackState: "playing", status: "Track playing. Your voice remains the live controller.", error: "" };
    case "playback-paused":
      return { ...state, playbackState: "paused", status: action.status };
    case "run-progress":
      return {
        ...state,
        currentTime: action.currentTime,
        liveObservation: action.liveObservation,
        hud: action.hud,
      };
    case "track-completed":
      return {
        ...state,
        playbackState: "ended",
        currentTime: action.result.playedSeconds,
        hud: action.result,
        result: action.result,
        status: action.status,
      };
    case "run-finished":
      return {
        ...state,
        phase: "result",
        playbackState: "stopped",
        currentTime: action.result.playedSeconds,
        hud: action.result,
        result: action.result,
        status: action.status,
      };
    case "ready-error":
      return { ...state, phase: "ready", playbackState: "stopped", error: action.error };
    case "session-error":
      return { ...state, error: action.error };
    case "clear-track":
      return INITIAL_SONG_RIDE_SESSION;
  }
}

export function createSongScoreRuntime(): SongScoreRuntime {
  return {
    laneMetrics: new Map(),
    settledLaneIds: new Set(),
    settledScoreTotal: 0,
    settledLaneCount: 0,
    hitLanes: 0,
    combo: 0,
    bestCombo: 0,
    nextLaneToSettle: 0,
    authority: null,
  };
}

export function songLaneAtTime(
  lanes: readonly SongTargetLane[],
  timeSeconds: number,
): SongTargetLane | null {
  let low = 0;
  let high = lanes.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lane = lanes[middle]!;
    if (timeSeconds < lane.startSeconds) high = middle - 1;
    else if (timeSeconds > lane.endSeconds) low = middle + 1;
    else return lane;
  }
  return null;
}

function creditedObservationSeconds(
  runtime: SongScoreRuntime,
  observation: Readonly<PitchObservation>,
): number {
  const continuity = observationContinuity(runtime.authority, observation);
  if (continuity.accepted) runtime.authority = continuity.authority;
  return continuity.deltaSeconds;
}

/**
 * Scores one authoritative detector hop. Missing/reordered PCM never creates
 * credit; unvoiced and uncertain windows remain normal observed song time.
 */
export function observeSongLane(
  runtime: SongScoreRuntime,
  lane: Readonly<SongTargetLane> | null,
  observation: Readonly<PitchObservation>,
): void {
  const seconds = creditedObservationSeconds(runtime, observation);
  if (!lane || seconds === 0) return;
  const metrics = runtime.laneMetrics.get(lane.id) ?? {
    observedSeconds: 0,
    voicedSeconds: 0,
    inLaneSeconds: 0,
    absoluteErrorCentSeconds: 0,
  };
  metrics.observedSeconds += seconds;
  const reliable = isAuthoritativeVoicedPitch(observation);
  if (reliable) {
    const errorCents = Math.abs((observation.midiFloat! - lane.targetMidi) * 100);
    metrics.voicedSeconds += seconds;
    metrics.absoluteErrorCentSeconds += errorCents * seconds;
    if (errorCents <= lane.toleranceCents) metrics.inLaneSeconds += seconds;
  }
  runtime.laneMetrics.set(lane.id, metrics);
}

export function songLaneQuality(
  lane: Readonly<SongTargetLane>,
  metrics: Readonly<SongLaneMetrics> | undefined,
): number {
  if (!metrics || metrics.observedSeconds === 0) return 0;
  const inLaneRatio = metrics.inLaneSeconds / metrics.observedSeconds;
  const voicedCoverage = metrics.voicedSeconds / metrics.observedSeconds;
  const averageError = metrics.voicedSeconds === 0
    ? lane.toleranceCents * 2
    : metrics.absoluteErrorCentSeconds / metrics.voicedSeconds;
  const pitchCenter = clamp(1 - averageError / (lane.toleranceCents * 2), 0, 1);
  return 100 * (0.55 * inLaneRatio + 0.25 * pitchCenter + 0.2 * voicedCoverage);
}

function settleLane(runtime: SongScoreRuntime, lane: Readonly<SongTargetLane>): void {
  if (runtime.settledLaneIds.has(lane.id)) return;
  const quality = songLaneQuality(lane, runtime.laneMetrics.get(lane.id));
  runtime.settledLaneIds.add(lane.id);
  runtime.settledScoreTotal += quality;
  runtime.settledLaneCount += 1;
  if (quality >= 55) {
    runtime.hitLanes += 1;
    runtime.combo += 1;
    runtime.bestCombo = Math.max(runtime.bestCombo, runtime.combo);
  } else {
    runtime.combo = 0;
  }
}

export function settleSongThrough(
  runtime: SongScoreRuntime,
  analysis: Readonly<SongLaneAnalysis>,
  timeSeconds: number,
  includeStarted = false,
): void {
  while (runtime.nextLaneToSettle < analysis.lanes.length) {
    const lane = analysis.lanes[runtime.nextLaneToSettle]!;
    const reached = includeStarted
      ? lane.startSeconds <= timeSeconds
      : lane.endSeconds <= timeSeconds;
    if (!reached) return;
    settleLane(runtime, lane);
    runtime.nextLaneToSettle += 1;
  }
}

function aggregate(runtime: Readonly<SongScoreRuntime>): SongLaneMetrics {
  const total: SongLaneMetrics = {
    observedSeconds: 0,
    voicedSeconds: 0,
    inLaneSeconds: 0,
    absoluteErrorCentSeconds: 0,
  };
  runtime.laneMetrics.forEach((metrics) => {
    total.observedSeconds += metrics.observedSeconds;
    total.voicedSeconds += metrics.voicedSeconds;
    total.inLaneSeconds += metrics.inLaneSeconds;
    total.absoluteErrorCentSeconds += metrics.absoluteErrorCentSeconds;
  });
  return total;
}

export function songHud(
  runtime: Readonly<SongScoreRuntime>,
  currentLane: Readonly<SongTargetLane> | null,
): SongHud {
  const currentIsUnsettled = currentLane !== null && !runtime.settledLaneIds.has(currentLane.id);
  const currentQuality = currentIsUnsettled
    ? songLaneQuality(currentLane, runtime.laneMetrics.get(currentLane.id))
    : 0;
  const attemptedLanes = runtime.settledLaneCount + (currentIsUnsettled ? 1 : 0);
  const totals = aggregate(runtime);
  return {
    score: attemptedLanes === 0
      ? 0
      : Math.round((runtime.settledScoreTotal + currentQuality) / attemptedLanes),
    accuracyPercent: totals.observedSeconds === 0
      ? 0
      : 100 * totals.inLaneSeconds / totals.observedSeconds,
    combo: runtime.combo,
    bestCombo: runtime.bestCombo,
    hitLanes: runtime.hitLanes,
    attemptedLanes,
  };
}

function gradeFor(score: number): Pick<SongRideResult, "grade" | "gradeLabel"> {
  if (score >= 94) return { grade: "A+", gradeLabel: "Rail perfectly centered" };
  if (score >= 87) return { grade: "A", gradeLabel: "Strong control in context" };
  if (score >= 75) return { grade: "B", gradeLabel: "The contour is taking shape" };
  if (score >= 62) return { grade: "C", gradeLabel: "Useful reps, visible weak spots" };
  return { grade: "D", gradeLabel: "Replay slowly and claim each lane" };
}

export function finishSongRide(
  runtime: SongScoreRuntime,
  analysis: Readonly<SongLaneAnalysis>,
  playedSeconds: number,
  completed: boolean,
): SongRideResult {
  const boundedSeconds = clamp(playedSeconds, 0, analysis.durationSeconds);
  settleSongThrough(runtime, analysis, boundedSeconds, true);
  const rawHud = songHud(runtime, null);
  const totals = aggregate(runtime);
  const completionFraction = analysis.durationSeconds === 0
    ? 0
    : boundedSeconds / analysis.durationSeconds;
  const score = completed
    ? rawHud.score
    : Math.round(rawHud.score * (0.6 + 0.4 * completionFraction));
  return {
    ...rawHud,
    ...gradeFor(score),
    score,
    completionPercent: completionFraction * 100,
    voicedCoveragePercent: totals.observedSeconds === 0
      ? 0
      : 100 * totals.voicedSeconds / totals.observedSeconds,
    playedSeconds: boundedSeconds,
  };
}
