import type { YinPitchFrame } from "@noteforge/pitch-engine";
import type { SongTargetLane } from "./song-lanes";

export type SongIsolationResult = "pass" | "leak" | "no-data";

export interface SongIsolationSegment {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

export interface SongIsolationEvidence {
  observedFrames: number;
  comparableFrames: number;
  matchingFrames: number;
  consecutiveMatches: number;
  maximumConsecutiveMatches: number;
}

export const SONG_ISOLATION_MATCH_TOLERANCE_CENTS = 35;
export const SONG_ISOLATION_REQUIRED_FRESH_FRAMES = 6;
export const SONG_ISOLATION_REQUIRED_COMPARABLE_FRAMES = 4;
export const SONG_ISOLATION_REQUIRED_CONSECUTIVE_MATCHES = 4;
export const SONG_ISOLATION_REQUIRED_TOTAL_MATCHES = 6;

const MAXIMUM_SEGMENT_SECONDS = 2.4;
const SOURCE_LOOKBACK_SECONDS = 0.24;
const SOURCE_LOOKAHEAD_SECONDS = 0.06;
const MINIMUM_LIVE_CONFIDENCE = 0.55;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function emptySongIsolationEvidence(): SongIsolationEvidence {
  return {
    observedFrames: 0,
    comparableFrames: 0,
    matchingFrames: 0,
    consecutiveMatches: 0,
    maximumConsecutiveMatches: 0,
  };
}

/** Pick the densest high-confidence contour window, bounded to the source. */
export function chooseSongIsolationSegment(
  lanes: readonly SongTargetLane[],
  durationSeconds: number,
): SongIsolationSegment {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError("Song isolation requires a finite positive duration");
  }
  if (lanes.length === 0) {
    throw new RangeError("Song isolation requires at least one source lane");
  }

  const segmentDuration = Math.min(MAXIMUM_SEGMENT_SECONDS, durationSeconds);
  const maximumStart = Math.max(0, durationSeconds - segmentDuration);
  const candidateStarts = new Set<number>([0, maximumStart]);
  lanes.forEach((lane) => {
    candidateStarts.add(clamp(lane.startSeconds - 0.3, 0, maximumStart));
    candidateStarts.add(clamp(
      (lane.startSeconds + lane.endSeconds - segmentDuration) / 2,
      0,
      maximumStart,
    ));
  });

  let bestStart = 0;
  let bestScore = -1;
  for (const startSeconds of candidateStarts) {
    const endSeconds = startSeconds + segmentDuration;
    const score = lanes.reduce((total, lane) => {
      const overlap = Math.max(
        0,
        Math.min(endSeconds, lane.endSeconds) - Math.max(startSeconds, lane.startSeconds),
      );
      const confidence = Number.isFinite(lane.averageConfidence)
        ? clamp(lane.averageConfidence, 0, 1)
        : 0;
      return total + overlap * (0.5 + confidence * 0.5);
    }, 0);
    if (score > bestScore || (score === bestScore && startSeconds < bestStart)) {
      bestScore = score;
      bestStart = startSeconds;
    }
  }

  return {
    startSeconds: bestStart,
    endSeconds: bestStart + segmentDuration,
    durationSeconds: segmentDuration,
  };
}

/** Include nearby source notes to cover output latency and the trailing PCM window. */
export function sourceMidisNearPlaybackTime(
  lanes: readonly SongTargetLane[],
  playbackTimeSeconds: number,
): number[] {
  if (!Number.isFinite(playbackTimeSeconds)) return [];
  const startSeconds = playbackTimeSeconds - SOURCE_LOOKBACK_SECONDS;
  const endSeconds = playbackTimeSeconds + SOURCE_LOOKAHEAD_SECONDS;
  return [...new Set(lanes
    .filter((lane) => lane.endSeconds >= startSeconds && lane.startSeconds <= endSeconds)
    .map((lane) => lane.sourceMidi)
    .filter((sourceMidi) => Number.isFinite(sourceMidi)))];
}

export function updateSongIsolationEvidence(
  evidence: Readonly<SongIsolationEvidence>,
  frame: Pick<YinPitchFrame, "voiced" | "midiFloat" | "confidence">,
  expectedSourceMidis: readonly number[],
): SongIsolationEvidence {
  const comparable = expectedSourceMidis.length > 0;
  const reliable = frame.voiced
    && frame.midiFloat !== null
    && Number.isFinite(frame.midiFloat)
    && Number.isFinite(frame.confidence)
    && frame.confidence >= MINIMUM_LIVE_CONFIDENCE;
  const matches = comparable && reliable && expectedSourceMidis.some(
    (sourceMidi) => {
      // A monophonic detector can lock to an octave harmonic of playback.
      // Treat octave-equivalent source pitches as leakage too: the user is
      // explicitly silent during this check, so none of them are valid voice.
      const semitoneDistance = Math.abs(frame.midiFloat! - sourceMidi);
      const octaveDistance = Math.abs(semitoneDistance - Math.round(semitoneDistance / 12) * 12);
      return octaveDistance * 100 <= SONG_ISOLATION_MATCH_TOLERANCE_CENTS + 1e-6;
    },
  );
  const consecutiveMatches = matches ? evidence.consecutiveMatches + 1 : 0;
  return {
    observedFrames: evidence.observedFrames + 1,
    comparableFrames: evidence.comparableFrames + (comparable ? 1 : 0),
    matchingFrames: evidence.matchingFrames + (matches ? 1 : 0),
    consecutiveMatches,
    maximumConsecutiveMatches: Math.max(evidence.maximumConsecutiveMatches, consecutiveMatches),
  };
}

export function classifySongIsolationEvidence(
  evidence: Readonly<SongIsolationEvidence>,
  playbackAdvancedSeconds: number,
  segmentDurationSeconds: number,
): SongIsolationResult {
  if (
    evidence.maximumConsecutiveMatches >= SONG_ISOLATION_REQUIRED_CONSECUTIVE_MATCHES
    || evidence.matchingFrames >= SONG_ISOLATION_REQUIRED_TOTAL_MATCHES
  ) return "leak";
  const requiredPlaybackSeconds = Math.min(0.65, segmentDurationSeconds * 0.5);
  if (
    evidence.observedFrames < SONG_ISOLATION_REQUIRED_FRESH_FRAMES
    || evidence.comparableFrames < SONG_ISOLATION_REQUIRED_COMPARABLE_FRAMES
    || !Number.isFinite(playbackAdvancedSeconds)
    || playbackAdvancedSeconds < requiredPlaybackSeconds
  ) return "no-data";
  return "pass";
}
