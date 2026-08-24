import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import type { YinPitchFrame } from "@noteforge/pitch-engine";
import { decodeAudioFile, renderAudioBufferToMono } from "@/audio/audio-context";
import {
  MAX_LOCAL_AUDIO_DURATION_SECONDS,
  MAX_LOCAL_AUDIO_FILE_BYTES,
  MIN_LOCAL_AUDIO_DURATION_SECONDS,
  formatFileSize,
  validateDecodedLocalAudio,
  validateLocalAudioFile,
} from "@/audio/local-audio-file";
import { useAudioInput } from "@/audio/use-audio-input";
import { noteLabel, signed } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { resolveArcadeCurriculum } from "./curriculum";
import {
  createSongAnalysisChunks,
  type SongLaneAnalysis,
  type SongLaneAnalysisOptions,
  type SongTargetLane,
} from "./song-lanes";
import {
  chooseSongIsolationSegment,
  classifySongIsolationEvidence,
  emptySongIsolationEvidence,
  sourceMidisNearPlaybackTime,
  updateSongIsolationEvidence,
  type SongIsolationEvidence,
  type SongIsolationSegment,
} from "./song-isolation";
import type { ArcadeGameProps } from "./types";

type SongRidePhase =
  | "upload"
  | "analyzing"
  | "ready"
  | "connecting"
  | "isolation-check"
  | "isolation-blocked"
  | "playing"
  | "paused"
  | "result";

type SongIsolationIssue = "leak" | "no-data" | null;

interface ActiveSongIsolationCheck {
  active: boolean;
  generation: number;
  verificationKey: string;
  segment: SongIsolationSegment;
  startedAtMs: number;
  playbackStartedAtSeconds: number;
  furthestPlaybackSeconds: number;
  evidence: SongIsolationEvidence;
}

interface LoadedTrack {
  name: string;
  sizeBytes: number;
  url: string;
}

interface SongAnalysisTask {
  promise: Promise<SongLaneAnalysis>;
  cancel: () => void;
}

function beginSongAnalysis(
  samples: Float32Array,
  sampleRate: number,
  options: SongLaneAnalysisOptions,
): SongAnalysisTask {
  const worker = new Worker(
    new URL("./song-analysis.worker.ts", import.meta.url),
    { type: "module", name: "noteforge-song-analysis" },
  );
  let settled = false;
  let rejectTask: (reason: unknown) => void = () => undefined;
  const finish = () => {
    if (settled) return false;
    settled = true;
    worker.terminate();
    return true;
  };
  const promise = new Promise<SongLaneAnalysis>((resolve, reject) => {
    rejectTask = reject;
    worker.onmessage = (event: MessageEvent<
      | { ok: true; analysis: SongLaneAnalysis }
      | { ok: false; error: string }
    >) => {
      if (!finish()) return;
      if (event.data.ok) resolve(event.data.analysis);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      if (!finish()) return;
      reject(new Error(event.message || "The song-analysis worker failed."));
    };
    worker.onmessageerror = () => {
      if (!finish()) return;
      reject(new Error("The song-analysis worker returned an unreadable result."));
    };
    try {
      worker.postMessage({ samples, sampleRate, options }, [samples.buffer]);
    } catch (error) {
      finish();
      reject(error);
    }
  });
  return {
    promise,
    cancel: () => {
      if (!finish()) return;
      rejectTask(new DOMException("Song analysis was cancelled.", "AbortError"));
    },
  };
}

interface LaneMetrics {
  samples: number;
  voicedSamples: number;
  inLaneSamples: number;
  absoluteErrorCents: number;
}

interface ScoreRuntime {
  laneMetrics: Map<string, LaneMetrics>;
  settledLaneIds: Set<string>;
  settledScoreTotal: number;
  settledLaneCount: number;
  hitLanes: number;
  combo: number;
  bestCombo: number;
  nextLaneToSettle: number;
}

interface SongHud {
  score: number;
  accuracyPercent: number;
  combo: number;
  bestCombo: number;
  hitLanes: number;
  attemptedLanes: number;
}

interface SongRideResult extends SongHud {
  grade: string;
  gradeLabel: string;
  completionPercent: number;
  voicedCoveragePercent: number;
  playedSeconds: number;
}

const MINIMUM_LIVE_CONFIDENCE = 0.55;
const SONG_ISOLATION_SETTLE_MS = 240;
const SONG_ISOLATION_RELEASE_MS = 360;
const SONG_ISOLATION_TIMEOUT_PADDING_MS = 750;
const EMPTY_HUD: SongHud = {
  score: 0,
  accuracyPercent: 0,
  combo: 0,
  bestCombo: 0,
  hitLanes: 0,
  attemptedLanes: 0,
};

function freshRuntime(): ScoreRuntime {
  return {
    laneMetrics: new Map(),
    settledLaneIds: new Set(),
    settledScoreTotal: 0,
    settledLaneCount: 0,
    hitLanes: 0,
    combo: 0,
    bestCombo: 0,
    nextLaneToSettle: 0,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${Math.floor(safe % 60).toString().padStart(2, "0")}`;
}

function laneAtTime(
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

function laneQuality(lane: SongTargetLane, metrics: LaneMetrics | undefined): number {
  if (!metrics || metrics.samples === 0) return 0;
  const inLaneRatio = metrics.inLaneSamples / metrics.samples;
  const voicedCoverage = metrics.voicedSamples / metrics.samples;
  const averageError = metrics.voicedSamples === 0
    ? lane.toleranceCents * 2
    : metrics.absoluteErrorCents / metrics.voicedSamples;
  const pitchCenter = clamp(1 - averageError / (lane.toleranceCents * 2), 0, 1);
  return 100 * (0.55 * inLaneRatio + 0.25 * pitchCenter + 0.2 * voicedCoverage);
}

function settleLane(
  runtime: ScoreRuntime,
  lane: SongTargetLane,
): void {
  if (runtime.settledLaneIds.has(lane.id)) return;
  const quality = laneQuality(lane, runtime.laneMetrics.get(lane.id));
  const hit = quality >= 55;
  runtime.settledLaneIds.add(lane.id);
  runtime.settledScoreTotal += quality;
  runtime.settledLaneCount += 1;
  if (hit) {
    runtime.hitLanes += 1;
    runtime.combo += 1;
    runtime.bestCombo = Math.max(runtime.bestCombo, runtime.combo);
  } else {
    runtime.combo = 0;
  }
}

function aggregateFrameMetrics(runtime: ScoreRuntime): {
  samples: number;
  voicedSamples: number;
  inLaneSamples: number;
} {
  let samples = 0;
  let voicedSamples = 0;
  let inLaneSamples = 0;
  runtime.laneMetrics.forEach((metrics) => {
    samples += metrics.samples;
    voicedSamples += metrics.voicedSamples;
    inLaneSamples += metrics.inLaneSamples;
  });
  return { samples, voicedSamples, inLaneSamples };
}

function hudFromRuntime(
  runtime: ScoreRuntime,
  currentLane: SongTargetLane | null,
): SongHud {
  const currentIsUnsettled = currentLane !== null &&
    !runtime.settledLaneIds.has(currentLane.id);
  const currentQuality = currentIsUnsettled
    ? laneQuality(currentLane, runtime.laneMetrics.get(currentLane.id))
    : 0;
  const attemptedLanes = runtime.settledLaneCount + (currentIsUnsettled ? 1 : 0);
  const score = attemptedLanes === 0
    ? 0
    : (runtime.settledScoreTotal + currentQuality) / attemptedLanes;
  const totals = aggregateFrameMetrics(runtime);
  return {
    score: Math.round(score),
    accuracyPercent: totals.samples === 0
      ? 0
      : 100 * totals.inLaneSamples / totals.samples,
    combo: runtime.combo,
    bestCombo: runtime.bestCombo,
    hitLanes: runtime.hitLanes,
    attemptedLanes,
  };
}

function gradeFor(score: number): { grade: string; label: string } {
  if (score >= 94) return { grade: "A+", label: "Rail perfectly centered" };
  if (score >= 87) return { grade: "A", label: "Strong control in context" };
  if (score >= 75) return { grade: "B", label: "The contour is taking shape" };
  if (score >= 62) return { grade: "C", label: "Useful reps, visible weak spots" };
  return { grade: "D", label: "Replay slowly and claim each lane" };
}

function difficultyMultiplier(difficulty: ArcadeGameProps["difficulty"]): number {
  if (difficulty === "hard") return 1.75;
  if (difficulty === "medium") return 1.35;
  return 1;
}

export function SongRide({
  difficulty,
  curriculumStage,
  voiceRange,
  onExit,
  onComplete,
}: ArcadeGameProps) {
  const curriculum = resolveArcadeCurriculum("song", curriculumStage);
  const feedback = curriculum.feedback;
  const [phase, setPhase] = useState<SongRidePhase>("upload");
  const [track, setTrack] = useState<LoadedTrack | null>(null);
  const [analysis, setAnalysis] = useState<SongLaneAnalysis | null>(null);
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false);
  const [status, setStatus] = useState(
    "Choose a local audio file to generate a playable pitch challenge.",
  );
  const [error, setError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [hud, setHud] = useState<SongHud>(EMPTY_HUD);
  const [result, setResult] = useState<SongRideResult | null>(null);
  const [isolationVerified, setIsolationVerified] = useState(false);
  const [isolationIssue, setIsolationIssue] = useState<SongIsolationIssue>(null);
  const [isolationEvidence, setIsolationEvidence] = useState<SongIsolationEvidence>(
    emptySongIsolationEvidence,
  );
  const [isolationSegment, setIsolationSegment] = useState<SongIsolationSegment | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const analysisTaskRef = useRef<SongAnalysisTask | null>(null);
  const analysisRef = useRef<SongLaneAnalysis | null>(null);
  const phaseRef = useRef<SongRidePhase>(phase);
  const currentTimeRef = useRef(0);
  const runtimeRef = useRef<ScoreRuntime>(freshRuntime());
  const generationRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const lastPaintedTimeRef = useRef(-1);
  const mountedRef = useRef(true);
  const completedRef = useRef(false);
  const onFrameRef = useRef<(frame: YinPitchFrame) => void>(() => undefined);
  const finishRunRef = useRef<(completed: boolean) => void>(() => undefined);
  const finishIsolationCheckRef = useRef<(forcedIssue?: Exclude<SongIsolationIssue, null>) => void>(() => undefined);
  const startScoredPlaybackRef = useRef<(generation: number) => void>(() => undefined);
  const isolationTimerRef = useRef<number | null>(null);
  const isolationCheckRef = useRef<ActiveSongIsolationCheck | null>(null);
  const isolationVerificationKeyRef = useRef<string | null>(null);

  phaseRef.current = phase;

  const input = useAudioInput({
    onFrame: (frame) => onFrameRef.current(frame),
  });
  const inputRef = useRef(input);
  inputRef.current = input;

  const clearIsolationTimer = useCallback(() => {
    if (isolationTimerRef.current === null) return;
    window.clearTimeout(isolationTimerRef.current);
    isolationTimerRef.current = null;
  }, []);

  const resetIsolationVerification = useCallback(() => {
    clearIsolationTimer();
    isolationCheckRef.current = null;
    isolationVerificationKeyRef.current = null;
    setIsolationVerified(false);
    setIsolationIssue(null);
    setIsolationEvidence(emptySongIsolationEvidence());
    setIsolationSegment(null);
  }, [clearIsolationTimer]);

  const verificationKeyFor = useCallback((loadedTrack: LoadedTrack): string => {
    const activeTrack = inputRef.current.getStream()?.getAudioTracks()
      .find((candidate) => candidate.readyState === "live");
    return `${loadedTrack.url}:${activeTrack?.id ?? "no-live-track"}`;
  }, []);

  const releaseObjectUrl = useCallback(() => {
    if (!objectUrlRef.current) return;
    URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }, []);

  const resetRuntime = useCallback(() => {
    runtimeRef.current = freshRuntime();
    completedRef.current = false;
    currentTimeRef.current = 0;
    lastPaintedTimeRef.current = -1;
    setCurrentTime(0);
    setHud(EMPTY_HUD);
    setResult(null);
  }, []);

  const settleThrough = useCallback((timeSeconds: number, includeStarted: boolean) => {
    const chart = analysisRef.current;
    if (!chart) return;
    const runtime = runtimeRef.current;
    while (runtime.nextLaneToSettle < chart.lanes.length) {
      const lane = chart.lanes[runtime.nextLaneToSettle]!;
      const shouldSettle = includeStarted
        ? lane.startSeconds <= timeSeconds
        : lane.endSeconds <= timeSeconds;
      if (!shouldSettle) break;
      settleLane(runtime, lane);
      runtime.nextLaneToSettle += 1;
    }
    setHud(hudFromRuntime(runtime, laneAtTime(chart.lanes, timeSeconds)));
  }, []);

  const finishRun = useCallback((completed: boolean) => {
    if (completedRef.current) return;
    const chart = analysisRef.current;
    if (!chart) return;
    completedRef.current = true;
    generationRef.current += 1;
    audioRef.current?.pause();
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const playedSeconds = completed
      ? chart.durationSeconds
      : clamp(audioRef.current?.currentTime ?? currentTimeRef.current, 0, chart.durationSeconds);
    currentTimeRef.current = playedSeconds;
    setCurrentTime(playedSeconds);
    settleThrough(playedSeconds, true);

    const runtime = runtimeRef.current;
    const rawHud = hudFromRuntime(runtime, null);
    const totals = aggregateFrameMetrics(runtime);
    const completionFraction = chart.durationSeconds === 0
      ? 0
      : clamp(playedSeconds / chart.durationSeconds, 0, 1);
    const adjustedScore = completed
      ? rawHud.score
      : Math.round(rawHud.score * (0.6 + 0.4 * completionFraction));
    const grade = gradeFor(adjustedScore);
    const nextResult: SongRideResult = {
      ...rawHud,
      score: adjustedScore,
      grade: grade.grade,
      gradeLabel: grade.label,
      completionPercent: completionFraction * 100,
      voicedCoveragePercent: totals.samples === 0
        ? 0
        : 100 * totals.voicedSamples / totals.samples,
      playedSeconds,
    };
    setHud(nextResult);
    setResult(nextResult);
    setPhase("result");
    setStatus(completed
      ? `${nextResult.hitLanes} of ${nextResult.attemptedLanes} target lanes earned.`
      : `Stopped at ${formatTime(playedSeconds)} and graded over the section you attempted.`);
    onComplete({
      mode: "song",
      curriculumStage,
      variant: "generated-rail",
      score: nextResult.score,
      grade: nextResult.grade,
      xp: Math.round(nextResult.score * difficultyMultiplier(difficulty)),
      accuracy: nextResult.accuracyPercent,
      bestCombo: nextResult.bestCombo,
      durationMs: Math.round(playedSeconds * 1_000),
      details: {
        completionPercent: nextResult.completionPercent,
        voicedCoveragePercent: nextResult.voicedCoveragePercent,
        targetLanes: chart.lanes.length,
        attemptedLanes: nextResult.attemptedLanes,
        hitLanes: nextResult.hitLanes,
        transposeSemitones: chart.transposeSemitones,
      },
    });
  }, [curriculumStage, difficulty, onComplete, settleThrough]);

  finishRunRef.current = finishRun;

  const startScoredPlayback = useCallback(async (generation: number) => {
    const audio = audioRef.current;
    if (!audio || !mountedRef.current || generation !== generationRef.current) return;
    isolationCheckRef.current = null;
    clearIsolationTimer();
    try {
      audio.pause();
      audio.currentTime = 0;
      currentTimeRef.current = 0;
      setCurrentTime(0);
      await audio.play();
      if (!mountedRef.current || generation !== generationRef.current) {
        audio.pause();
        return;
      }
      phaseRef.current = "playing";
      setPhase("playing");
      setError("");
      setStatus("Rail live. Meet each block at the playhead; silent gaps are safe breathing space.");
    } catch (caught) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      audio.pause();
      phaseRef.current = "ready";
      setPhase("ready");
      setError(caught instanceof Error
        ? caught.message
        : "Playback could not start. Try the start button again.");
    }
  }, [clearIsolationTimer]);
  startScoredPlaybackRef.current = (generation) => { void startScoredPlayback(generation); };

  const finishIsolationCheck = useCallback((forcedIssue?: Exclude<SongIsolationIssue, null>) => {
    const check = isolationCheckRef.current;
    if (!check?.active || check.generation !== generationRef.current) return;
    check.active = false;
    clearIsolationTimer();
    const audio = audioRef.current;
    audio?.pause();
    const playbackAdvancedSeconds = Math.max(
      0,
      check.furthestPlaybackSeconds - check.playbackStartedAtSeconds,
    );
    const result = forcedIssue ?? classifySongIsolationEvidence(
      check.evidence,
      playbackAdvancedSeconds,
      check.segment.durationSeconds,
    );
    try {
      if (audio) audio.currentTime = 0;
    } catch {
      // A just-detached media element may reject seeking; the next start will
      // establish its position again before scoring is armed.
    }

    if (result !== "pass") {
      isolationVerificationKeyRef.current = null;
      setIsolationVerified(false);
      setIsolationIssue(result);
      phaseRef.current = "isolation-blocked";
      setPhase("isolation-blocked");
      setStatus(result === "leak"
        ? "Playback repeatedly matched the microphone. Scoring stayed locked."
        : "The isolation check did not establish enough comparable playback evidence. Scoring stayed locked.");
      return;
    }

    isolationVerificationKeyRef.current = check.verificationKey;
    setIsolationVerified(true);
    setIsolationIssue(null);
    setStatus("Headphone isolation passed. Rewinding the track; scoring starts after the playback tail clears.");
    isolationTimerRef.current = window.setTimeout(() => {
      isolationTimerRef.current = null;
      startScoredPlaybackRef.current(check.generation);
    }, SONG_ISOLATION_RELEASE_MS);
  }, [clearIsolationTimer]);
  finishIsolationCheckRef.current = finishIsolationCheck;

  const beginIsolationCheck = useCallback(async (
    generation: number,
    verificationKey: string,
  ) => {
    const chart = analysisRef.current;
    const audio = audioRef.current;
    if (!chart || !audio || !mountedRef.current || generation !== generationRef.current) return;
    const segment = chooseSongIsolationSegment(chart.lanes, chart.durationSeconds);
    clearIsolationTimer();
    isolationCheckRef.current = null;
    setIsolationSegment(segment);
    setIsolationEvidence(emptySongIsolationEvidence());
    setIsolationIssue(null);
    audio.pause();
    try {
      audio.currentTime = segment.startSeconds;
      phaseRef.current = "isolation-check";
      setPhase("isolation-check");
      setStatus(
        `Stay silent while ${formatTime(segment.startSeconds)}–${formatTime(segment.endSeconds)} plays. NoteForge is checking that the source stays out of the microphone.`,
      );
      await audio.play();
      if (!mountedRef.current || generation !== generationRef.current) {
        audio.pause();
        return;
      }
      const playbackStartedAtSeconds = audio.currentTime;
      isolationCheckRef.current = {
        active: true,
        generation,
        verificationKey,
        segment,
        startedAtMs: performance.now(),
        playbackStartedAtSeconds,
        furthestPlaybackSeconds: playbackStartedAtSeconds,
        evidence: emptySongIsolationEvidence(),
      };
      isolationTimerRef.current = window.setTimeout(
        () => finishIsolationCheckRef.current(),
        segment.durationSeconds * 1_000 + SONG_ISOLATION_TIMEOUT_PADDING_MS,
      );
    } catch (caught) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      audio.pause();
      isolationVerificationKeyRef.current = null;
      setIsolationVerified(false);
      setIsolationIssue("no-data");
      phaseRef.current = "isolation-blocked";
      setPhase("isolation-blocked");
      setStatus("The representative source segment could not play, so scoring stayed locked.");
      setError(caught instanceof Error ? caught.message : "Playback could not start for the isolation check.");
    }
  }, [clearIsolationTimer]);

  onFrameRef.current = (frame) => {
    if (phaseRef.current === "isolation-check") {
      const check = isolationCheckRef.current;
      const chart = analysisRef.current;
      const audio = audioRef.current;
      if (!check?.active || !chart || !audio || audio.paused) return;
      const playbackTimeSeconds = audio.currentTime;
      check.furthestPlaybackSeconds = Math.max(check.furthestPlaybackSeconds, playbackTimeSeconds);
      if (performance.now() - check.startedAtMs < SONG_ISOLATION_SETTLE_MS) return;
      const expectedSourceMidis = sourceMidisNearPlaybackTime(chart.lanes, playbackTimeSeconds);
      const nextEvidence = updateSongIsolationEvidence(check.evidence, frame, expectedSourceMidis);
      check.evidence = nextEvidence;
      setIsolationEvidence(nextEvidence);
      const playbackAdvancedSeconds = Math.max(
        0,
        check.furthestPlaybackSeconds - check.playbackStartedAtSeconds,
      );
      if (classifySongIsolationEvidence(
        nextEvidence,
        playbackAdvancedSeconds,
        check.segment.durationSeconds,
      ) === "leak") {
        finishIsolationCheckRef.current("leak");
        return;
      }
      if (playbackTimeSeconds >= check.segment.endSeconds) finishIsolationCheckRef.current();
      return;
    }
    if (phaseRef.current !== "playing") return;
    const chart = analysisRef.current;
    const audio = audioRef.current;
    if (!chart || !audio || audio.paused) return;
    const timeSeconds = audio.currentTime;
    const lane = laneAtTime(chart.lanes, timeSeconds);
    if (!lane) return;

    const runtime = runtimeRef.current;
    const metrics = runtime.laneMetrics.get(lane.id) ?? {
      samples: 0,
      voicedSamples: 0,
      inLaneSamples: 0,
      absoluteErrorCents: 0,
    };
    metrics.samples += 1;
    const reliable = frame.voiced && frame.midiFloat !== null &&
      Number.isFinite(frame.midiFloat) &&
      frame.confidence >= MINIMUM_LIVE_CONFIDENCE;
    if (reliable) {
      const errorCents = Math.abs((frame.midiFloat! - lane.targetMidi) * 100);
      metrics.voicedSamples += 1;
      metrics.absoluteErrorCents += errorCents;
      if (errorCents <= lane.toleranceCents) metrics.inLaneSamples += 1;
    }
    runtime.laneMetrics.set(lane.id, metrics);
    setHud(hudFromRuntime(runtime, lane));
  };

  const clearLoadedTrack = useCallback(() => {
    generationRef.current += 1;
    analysisTaskRef.current?.cancel();
    analysisTaskRef.current = null;
    audioRef.current?.pause();
    resetIsolationVerification();
    releaseObjectUrl();
    analysisRef.current = null;
    setTrack(null);
    setAnalysis(null);
    setPhase("upload");
    setError("");
    setStatus("Choose a local audio file to generate a playable pitch challenge.");
    setHeadphonesConfirmed(false);
    resetRuntime();
  }, [releaseObjectUrl, resetIsolationVerification, resetRuntime]);

  const loadFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      validateLocalAudioFile(file);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Choose a browser-decodable audio file.");
      return;
    }

    const generation = ++generationRef.current;
    completedRef.current = false;
    setPhase("analyzing");
    setError("");
    setStatus("Reading and decoding the track locally…");
    audioRef.current?.pause();

    analysisTaskRef.current?.cancel();
    analysisTaskRef.current = null;
    try {
      const encoded = await file.arrayBuffer();
      if (!mountedRef.current || generation !== generationRef.current) return;
      const decoded = await decodeAudioFile(encoded);
      if (!mountedRef.current || generation !== generationRef.current) return;
      validateDecodedLocalAudio(decoded);

      const analysisRate = Math.min(decoded.sampleRate, 6_000);
      setStatus("Downmixing and resampling through the browser audio renderer…");
      const mono = await renderAudioBufferToMono(decoded, analysisRate);
      if (!mountedRef.current || generation !== generationRef.current) return;
      const workUnits = createSongAnalysisChunks(mono.length, analysisRate, {
        analysisSampleRate: analysisRate,
        frameSizeSamples: 512,
        hopSizeSamples: 256,
        minFrequencyHz: 55,
        maxFrequencyHz: Math.min(1_200, analysisRate * 0.45),
      }).length;
      setStatus(
        `Generating ${workUnits.toLocaleString()} local pitch windows and fitting them to ${noteLabel(voiceRange.lowMidi)}–${noteLabel(voiceRange.highMidi)}…`,
      );
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (!mountedRef.current || generation !== generationRef.current) return;

      const minimumLaneSeconds = difficulty === "easy"
        ? 0.24
        : difficulty === "medium"
          ? 0.15
          : 0.09;
      const mergeGapSeconds = difficulty === "easy"
        ? 0.16
        : difficulty === "medium"
          ? 0.1
          : 0.06;
      const analysisOptions: SongLaneAnalysisOptions = {
        analysisSampleRate: analysisRate,
        frameSizeSamples: 512,
        hopSizeSamples: 256,
        minFrequencyHz: 55,
        maxFrequencyHz: Math.min(1_200, analysisRate * 0.45),
        minimumConfidence: 0.72,
        rmsThreshold: 0.008,
        minimumLaneSeconds,
        mergeGapSeconds,
        difficulty,
        vocalRange: {
          minMidi: voiceRange.lowMidi,
          maxMidi: voiceRange.highMidi,
        },
      };
      const task = beginSongAnalysis(mono, analysisRate, analysisOptions);
      analysisTaskRef.current = task;
      let nextAnalysis: SongLaneAnalysis;
      try {
        nextAnalysis = await task.promise;
      } finally {
        if (analysisTaskRef.current === task) analysisTaskRef.current = null;
      }
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (nextAnalysis.lanes.length === 0) {
        throw new Error(
          "No stable periodic contour was found. Try a clearer passage with a prominent voice or single-note instrument.",
        );
      }

      releaseObjectUrl();
      const nextUrl = URL.createObjectURL(file);
      objectUrlRef.current = nextUrl;
      const nextTrack: LoadedTrack = {
        name: file.name,
        sizeBytes: file.size,
        url: nextUrl,
      };
      analysisRef.current = nextAnalysis;
      setAnalysis(nextAnalysis);
      setTrack(nextTrack);
      resetRuntime();
      resetIsolationVerification();
      setHeadphonesConfirmed(false);
      setPhase("ready");
      setStatus(
        `${nextAnalysis.lanes.length.toLocaleString()} challenge lanes ready. This follows dominant periodic pitch—not guaranteed lead-vocal transcription.`,
      );
    } catch (caught) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setPhase(analysisRef.current ? "ready" : "upload");
      setError(caught instanceof Error
        ? caught.message
        : "The browser could not decode or analyze that audio file.");
      setStatus("Nothing was uploaded; processing stayed in this browser tab.");
    }
  }, [difficulty, releaseObjectUrl, resetIsolationVerification, resetRuntime, voiceRange.highMidi, voiceRange.lowMidi]);

  const startRun = useCallback(async () => {
    const chart = analysisRef.current;
    const audio = audioRef.current;
    const loadedTrack = track;
    if (!chart || !audio || !loadedTrack || !headphonesConfirmed) return;
    if (
      phaseRef.current === "connecting"
      || phaseRef.current === "isolation-check"
      || phaseRef.current === "playing"
    ) return;
    const generation = ++generationRef.current;
    audio.pause();
    audio.currentTime = 0;
    resetRuntime();
    setPhase("connecting");
    setError("");
    setStatus("Opening the retained local microphone controller…");
    const microphone = await input.enable();
    if (!mountedRef.current || generation !== generationRef.current) return;
    if (!microphone) {
      setPhase("ready");
      setError(input.error || "Microphone access is required to control Song Rail.");
      return;
    }
    const verificationKey = verificationKeyFor(loadedTrack);
    if (isolationVerificationKeyRef.current === verificationKey) {
      setIsolationVerified(true);
      startScoredPlaybackRef.current(generation);
      return;
    }
    isolationVerificationKeyRef.current = null;
    setIsolationVerified(false);
    await beginIsolationCheck(generation, verificationKey);
  }, [beginIsolationCheck, headphonesConfirmed, input, resetRuntime, track, verificationKeyFor]);

  const pauseRun = useCallback((hidden = false) => {
    if (phaseRef.current !== "playing") return;
    audioRef.current?.pause();
    setPhase("paused");
    setStatus(hidden
      ? "Paused because the page was hidden. Resume when you are ready."
      : "Paused. Your score and position are preserved.");
  }, []);

  const resumeRun = useCallback(async () => {
    if (phaseRef.current !== "paused" || !audioRef.current) return;
    if (inputRef.current?.state !== "running") {
      setError(inputRef.current?.error || "Microphone input is unavailable. End and grade this section or enable input from the shared input control.");
      return;
    }
    const generation = ++generationRef.current;
    try {
      setStatus("Resuming the rail…");
      if (
        !mountedRef.current ||
        generation !== generationRef.current ||
        phaseRef.current !== "paused"
      ) return;
      await audioRef.current.play();
      if (
        !mountedRef.current ||
        generation !== generationRef.current ||
        phaseRef.current !== "paused"
      ) {
        audioRef.current.pause();
        return;
      }
      setPhase("playing");
      setStatus("Rail live. Your voice is the controller.");
    } catch (caught) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setError(caught instanceof Error ? caught.message : "Playback could not resume.");
    }
  }, []);

  const returnFromIsolation = useCallback((message: string) => {
    generationRef.current += 1;
    const check = isolationCheckRef.current;
    if (check) check.active = false;
    audioRef.current?.pause();
    try {
      if (audioRef.current) audioRef.current.currentTime = 0;
    } catch {
      // The source can be between ready states while its object URL changes.
    }
    resetIsolationVerification();
    phaseRef.current = "ready";
    setPhase("ready");
    setError("");
    setStatus(message);
  }, [resetIsolationVerification]);

  const stopOrExit = useCallback(() => {
    if (
      phaseRef.current === "playing" ||
      phaseRef.current === "paused"
    ) {
      finishRunRef.current(false);
      return;
    }
    if (
      phaseRef.current === "isolation-check"
      || phaseRef.current === "isolation-blocked"
    ) {
      returnFromIsolation("Isolation setup stopped. Confirm the playback route, then check and start again.");
      return;
    }
    if (phaseRef.current === "connecting") {
      generationRef.current += 1;
      analysisTaskRef.current?.cancel();
      analysisTaskRef.current = null;
      audioRef.current?.pause();
      setPhase("ready");
      setStatus("Start cancelled. The decoded chart is still ready.");
      return;
    }
    onExit();
  }, [onExit, returnFromIsolation]);

  useEffect(() => {
    if (phase !== "playing") return undefined;
    const tick = () => {
      const audio = audioRef.current;
      if (phaseRef.current !== "playing" || !audio) return;
      const timeSeconds = audio.currentTime;
      currentTimeRef.current = timeSeconds;
      settleThrough(timeSeconds, false);
      if (
        lastPaintedTimeRef.current < 0 ||
        Math.abs(timeSeconds - lastPaintedTimeRef.current) >= 1 / 30
      ) {
        lastPaintedTimeRef.current = timeSeconds;
        setCurrentTime(timeSeconds);
      }
      animationFrameRef.current = requestAnimationFrame(tick);
    };
    animationFrameRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [phase, settleThrough]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      if (phaseRef.current === "isolation-check") {
        const check = isolationCheckRef.current;
        if (check?.active) finishIsolationCheckRef.current("no-data");
        else returnFromIsolation("Isolation setup stopped because the page was hidden. Retry when the track can stay audible.");
        return;
      }
      pauseRun(true);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [pauseRun, returnFromIsolation]);

  useEffect(() => {
    if (input.state !== "error") return;
    if (phase === "isolation-check") {
      const check = isolationCheckRef.current;
      if (check?.active) finishIsolationCheckRef.current("no-data");
      else returnFromIsolation("The microphone disconnected before isolation could be verified. Reconnect and retry.");
      setError(input.error || "The microphone disconnected during the isolation check.");
      return;
    }
    if (phase !== "playing") return;
    pauseRun(false);
    setError(input.error || "The microphone disconnected. Reconnect before resuming.");
    setStatus("Playback paused because the voice controller disconnected.");
  }, [input.error, input.state, pauseRun, phase, returnFromIsolation]);

  useEffect(() => {
    if (!track || isolationVerificationKeyRef.current === null) return;
    const currentKey = verificationKeyFor(track);
    if (isolationVerificationKeyRef.current === currentKey) return;
    resetIsolationVerification();
    setStatus("The active microphone changed. Run the headphone isolation check again before scoring.");
  }, [input.microphoneInfo, input.state, resetIsolationVerification, track, verificationKeyFor]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      analysisTaskRef.current?.cancel();
      analysisTaskRef.current = null;
      clearIsolationTimer();
      if (isolationCheckRef.current) isolationCheckRef.current.active = false;
      audioRef.current?.pause();
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      releaseObjectUrl();
      // The app-scoped permission and retained stream belong to
      // AudioInputProvider, not to this game.
    };
  }, [clearIsolationTimer, releaseObjectUrl]);

  const duration = analysis?.durationSeconds ?? 0;
  const activeLane = useMemo(
    () => analysis ? laneAtTime(analysis.lanes, currentTime) : null,
    [analysis, currentTime],
  );
  const nextLane = useMemo(() => {
    if (!analysis) return null;
    if (activeLane) {
      const activeLaneIndex = analysis.lanes.indexOf(activeLane);
      return analysis.lanes[activeLaneIndex + 1] ?? null;
    }
    return analysis.lanes.find((lane) => lane.startSeconds > currentTime) ?? null;
  }, [activeLane, analysis, currentTime]);
  const liveFrame = phase === "playing" ? input.liveFrame : undefined;
  const reliableLive = liveFrame?.voiced === true
    && liveFrame.midiFloat !== null;
  const liveMidi = reliableLive ? liveFrame.midiFloat! : null;
  const liveErrorCents = liveMidi === null || !activeLane
    ? null
    : (liveMidi - activeLane.targetMidi) * 100;
  const voiceLocked = liveErrorCents !== null &&
    Math.abs(liveErrorCents) <= activeLane!.toleranceCents;
  const rangeSpan = Math.max(1, voiceRange.highMidi - voiceRange.lowMidi);
  const liveTop = liveMidi === null
    ? 50
    : 8 + (1 - clamp((liveMidi - voiceRange.lowMidi) / rangeSpan, 0, 1)) * 84;
  const lookAheadSeconds = difficulty === "hard" ? 6 : difficulty === "medium" ? 7.5 : 9;
  const visibleLanes = useMemo(() => analysis?.lanes
    .filter((lane) =>
      lane.endSeconds >= currentTime - 0.5 &&
      lane.startSeconds <= currentTime + lookAheadSeconds
    )
    .map((lane) => ({
      lane,
      left: 14 + (lane.startSeconds - currentTime) / lookAheadSeconds * 82,
      width: Math.max(1.5, lane.durationSeconds / lookAheadSeconds * 82),
      top: 8 + (1 - clamp(
        (lane.targetMidi - voiceRange.lowMidi) / rangeSpan,
        0,
        1,
      )) * 84,
    })) ?? [], [analysis?.lanes, currentTime, lookAheadSeconds, rangeSpan, voiceRange.lowMidi]);
  const progressPercent = duration === 0 ? 0 : clamp(currentTime / duration * 100, 0, 100);
  const remainingSeconds = Math.max(0, duration - currentTime);
  const inputRmsDbfs = input.telemetry?.rmsDbfs ?? null;
  const inputLevelPercent = inputRmsDbfs === null ? 0 : clamp((inputRmsDbfs + 96) / 96 * 100, 0, 100);
  const currentIsolationKey = track ? verificationKeyFor(track) : null;
  const isolationReady = isolationVerified
    && currentIsolationKey !== null
    && isolationVerificationKeyRef.current === currentIsolationKey;
  const activeIsolationCheck = isolationCheckRef.current;
  const isolationPlaybackProgress = isolationSegment === null
    ? 0
    : clamp(
      ((activeIsolationCheck?.furthestPlaybackSeconds ?? isolationSegment.startSeconds) - isolationSegment.startSeconds)
        / Math.max(0.001, isolationSegment.durationSeconds),
      0,
      1,
    );
  const isolationPhaseActive = phase === "isolation-check" || phase === "isolation-blocked";
  const liveVoiceLabel = !feedback.showLiveNote
    ? reliableLive ? "TRACKING" : "—"
    : liveMidi === null ? "—" : noteLabel(liveMidi);
  const liveVoiceDetail = liveErrorCents === null
    ? "waiting for pitch"
    : !feedback.showCents
      ? liveErrorCents < 0 ? "move up" : liveErrorCents > 0 ? "move down" : "centered"
      : `${signed(liveErrorCents, 0)}¢ · ${liveErrorCents < 0 ? "move up" : liveErrorCents > 0 ? "move down" : "centered"}`;

  return (
    <section className={`arcade-game-shell song-ride-shell curriculum-${curriculum.stage}`}>
      {track && (
        <audio
          ref={audioRef}
          src={track.url}
          preload="auto"
          onEnded={() => {
            if (phaseRef.current === "isolation-check") {
              finishIsolationCheckRef.current();
              return;
            }
            if (phaseRef.current === "playing") finishRunRef.current(true);
          }}
          onPause={() => {
            if (phaseRef.current !== "playing" || completedRef.current) return;
            setPhase("paused");
            setStatus("Playback paused. Your score and position are preserved.");
          }}
          onTimeUpdate={(event) => {
            if (phaseRef.current === "isolation-check") {
              const check = isolationCheckRef.current;
              if (!check?.active) return;
              check.furthestPlaybackSeconds = Math.max(
                check.furthestPlaybackSeconds,
                event.currentTarget.currentTime,
              );
              if (event.currentTarget.currentTime >= check.segment.endSeconds) {
                finishIsolationCheckRef.current();
              }
              return;
            }
            if (phaseRef.current === "playing") {
              currentTimeRef.current = event.currentTarget.currentTime;
            }
          }}
        />
      )}

      <div className="arcade-game-hud">
        <div><span>TRACK</span><strong>{track ? formatTime(duration) : "LOCAL"}</strong></div>
        <div><span>SCORE</span><strong>{hud.score}</strong></div>
        <div className="combo"><span>COMBO</span><strong>{hud.combo}<small>×</small></strong></div>
        <div><span>IN LANE</span><strong>{hud.accuracyPercent.toFixed(0)}%</strong></div>
        <ActionButton
          className={phase === "playing" || phase === "paused" ? "coral" : ""}
          onClick={stopOrExit}
        >
          <Icon name={phase === "playing" || phase === "paused" ? "pause" : "arrow"} size={16} />
          {phase === "playing" || phase === "paused"
            ? "Stop & grade"
            : phase === "connecting"
              ? "Cancel start"
              : isolationPhaseActive
                ? phase === "isolation-check" ? "Cancel safety check" : "Back to setup"
              : "Exit game"}
        </ActionButton>
      </div>

      {phase === "upload" && (
        <Panel className="arcade-game-loadout song-ride-upload">
          <div>
            <Eyebrow>Song Rail · {curriculum.stageLabel}</Eyebrow>
            <h1>Turn a track into a voice-controlled rail.</h1>
            <p>NoteForge finds stable periodic pitch locally, converts it into timed target lanes, then transposes the whole contour into your current voice map. {curriculum.stageSummary}</p>
          </div>
          <label className="song-upload-drop">
            <Icon name="song" size={34} />
            <span><b>Choose MP3 or audio</b><small>Decoded and analyzed in memory · never uploaded</small></span>
            <input type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac" onChange={(event) => { void loadFile(event); }} />
          </label>
          <div className="song-analysis-contract">
            <span><b>≤ {formatFileSize(MAX_LOCAL_AUDIO_FILE_BYTES)}</b><small>file guard</small></span>
            <span><b>{formatTime(MIN_LOCAL_AUDIO_DURATION_SECONDS)}–{formatTime(MAX_LOCAL_AUDIO_DURATION_SECONDS)}</b><small>duration guard</small></span>
            <span><b>{noteLabel(voiceRange.lowMidi)}–{noteLabel(voiceRange.highMidi)}</b><small>fitted targets</small></span>
          </div>
          <p className="song-chart-disclosure"><Icon name="spark" size={18} /><span><b>A challenge chart, not stem separation.</b> In a dense mix, the contour can follow bass, accompaniment, or harmonics instead of the lead vocal. Clear passages generate the best rails.</span></p>
          {error && <div className="error-banner" role="alert">{error}</div>}
        </Panel>
      )}

      {phase === "analyzing" && (
        <Panel className="arcade-countdown-stage song-analyzing-stage" aria-live="polite">
          <span className="arcade-countdown-orb"><Icon name="song" size={34} /></span>
          <Eyebrow>On-device chart generation</Eyebrow>
          <h2>Listening through the track…</h2>
          <p>{status}</p>
          <small>The file and decoded samples remain inside this browser tab.</small>
        </Panel>
      )}

      {phase === "ready" && analysis && track && (
        <Panel className="arcade-game-loadout song-ready-stage">
          <div className="song-file-meta">
            <span className="song-file-icon"><Icon name="song" size={28} /></span>
            <div><small>LOCAL CHALLENGE READY</small><h2>{track.name}</h2><p>{formatTime(duration)} · {formatFileSize(track.sizeBytes)} · {analysis.lanes.length.toLocaleString()} lanes</p></div>
          </div>
          <div className="arcade-contract-grid song-ready-contract">
            <span><b>{feedback.showCents ? `±${analysis.toleranceCents}¢` : "SET"}</b><small>lane width</small></span>
            <span><b>{signed(analysis.transposeSemitones)}</b><small>semitones fitted</small></span>
            <span><b>{feedback.showPreviewLabels
              ? analysis.sourceMidiRange ? `${noteLabel(analysis.sourceMidiRange.minMidi)}–${noteLabel(analysis.sourceMidiRange.maxMidi)}` : "—"
              : "HIDDEN"}</b><small>source contour</small></span>
            <span><b>{analysis.clippedLaneCount}</b><small>range-clipped lanes</small></span>
          </div>
          <p className="song-chart-disclosure"><Icon name="spark" size={18} /><span><b>Generated target challenge.</b> These lanes follow the detector’s dominant periodic contour. They are not a claim about the song’s official melody or lyrics.</span></p>
          <button
            type="button"
            className={`arcade-headphone-confirm ${headphonesConfirmed ? "confirmed" : ""}`}
            aria-pressed={headphonesConfirmed}
            onClick={() => {
              if (headphonesConfirmed) resetIsolationVerification();
              setHeadphonesConfirmed((current) => !current);
            }}
          >
            <Icon name="headphones" size={21} />
            <span><b>{headphonesConfirmed ? "Headphones confirmed" : "I’m wearing headphones"}</b><small>{isolationReady ? "Playback isolation was verified for this track and microphone." : "Speaker playback can be mistaken for your sung pitch; the first run includes a quiet safety check."}</small></span>
          </button>
          <div className={`song-isolation-readiness ${isolationReady ? "ready" : "needed"}`}>
            <Icon name={isolationReady ? "lock" : "headphones"} size={21} />
            <span><b>{isolationReady ? "Playback isolation verified" : "Playback isolation check required"}</b><small>{isolationReady ? "Replays can begin immediately while this source, microphone, and headphone setup stay unchanged." : "Before the first scored run, a short representative segment plays while you stay silent. Matching source pitch or an incomplete source comparison keeps scoring locked."}</small></span>
          </div>
          <div className={`song-input-check ${input.state === "running" ? "running" : "optional"}`}>
            <Icon name="mic" size={21} />
            <span>
              <b>{input.state === "running" ? "Continuous note detection active" : "Microphone opens when the rail starts"}</b>
              <small>{input.state === "running"
                ? "Every canonical pitch frame remains available; Song Rail applies lane confidence and timing rules locally."
                : "Scoring begins as soon as the canonical input is ready."}</small>
            </span>
          </div>
          <div className="song-input-metrics" aria-label="Song Rail microphone diagnostics">
            <span className="song-input-live"><small>LIVE INPUT</small><b>{inputRmsDbfs === null ? "—" : `${inputRmsDbfs.toFixed(1)} dBFS`}</b><i role="meter" aria-label="Live microphone input level" aria-valuemin={-96} aria-valuemax={0} aria-valuenow={inputRmsDbfs === null ? undefined : Math.round(clamp(inputRmsDbfs, -96, 0))} aria-valuetext={inputRmsDbfs === null ? "No input" : `${inputRmsDbfs.toFixed(1)} dBFS`}><em style={{ width: `${inputLevelPercent}%` }} /></i></span>
            <span><small>DETECTED NOTE</small><b>{input.liveFrame?.voiced && input.liveFrame.nearestMidi !== null ? noteLabel(input.liveFrame.nearestMidi) : "—"}</b></span>
            <span><small>CAPTURE</small><b>{input.state === "running" ? "CONTINUOUS" : input.state.toUpperCase()}</b></span>
            <span><small>HEADROOM</small><b>{input.telemetry ? `${input.telemetry.headroomDb.toFixed(1)} dB` : "—"}</b></span>
          </div>
          {(error || input.error) && <div className="error-banner" role="alert">{error || input.error}</div>}
          <div className="arcade-start-row">
            <label className="action-button song-replace-file"><Icon name="song" size={17} /> Replace track<input type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac" onChange={(event) => { void loadFile(event); }} /></label>
            <span>{status}</span>
            <ActionButton className="primary" disabled={!headphonesConfirmed || input.state === "opening"} onClick={() => { void startRun(); }}><Icon name="mic" size={18} /> {input.state === "opening" ? "Opening microphone…" : isolationReady ? "Start Song Rail" : "Check isolation & start"}</ActionButton>
          </div>
        </Panel>
      )}

      {phase === "connecting" && (
        <Panel className="arcade-countdown-stage" aria-live="polite">
          <span className="arcade-countdown-orb"><Icon name="mic" size={34} /></span>
          <Eyebrow>Connecting local pitch controller</Eyebrow>
          <h2>Opening the microphone…</h2>
          <p>{status}</p>
          <ActionButton onClick={stopOrExit}>Cancel start</ActionButton>
        </Panel>
      )}

      {isolationPhaseActive && analysis && track && (
        <Panel className={`song-isolation-stage ${phase === "isolation-blocked" ? `blocked ${isolationIssue ?? "no-data"}` : "checking"}`} aria-live="polite">
          <div className="song-isolation-copy">
            <span className="arcade-countdown-orb"><Icon name="headphones" size={34} /></span>
            <div>
              <Eyebrow>Scoring safeguard · this source and microphone</Eyebrow>
              <h2>{phase === "isolation-check"
                ? "Stay silent while the source sample plays."
                : isolationIssue === "leak"
                  ? "The microphone heard the track."
                  : "Isolation could not be verified."}</h2>
              <p>{phase === "isolation-check"
                ? "Do not hum yet. Song Rail is comparing fresh microphone pitch with the source contour; no lane, score, or XP can move during this check."
                : isolationIssue === "leak"
                  ? "Repeated source-note matches were detected. Route playback fully into headphones, check for open speakers, reseat the earcups, and move the microphone farther away before retrying."
                  : "The source playback or comparison window was incomplete. Keep the track routed through headphones and retry the check."}</p>
            </div>
          </div>

          <div className="song-isolation-progress">
            <div>
              <span>REPRESENTATIVE SOURCE WINDOW</span>
              <b>{isolationSegment ? `${formatTime(isolationSegment.startSeconds)}–${formatTime(isolationSegment.endSeconds)}` : "Preparing…"}</b>
            </div>
            <div
              role="progressbar"
              aria-label="Playback isolation check progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(isolationPlaybackProgress * 100)}
              aria-valuetext={`${Math.round(isolationPlaybackProgress * 100)} percent of source check played`}
            ><i style={{ width: `${isolationPlaybackProgress * 100}%` }} /></div>
          </div>

          <div className="song-isolation-evidence" aria-label="Isolation check evidence">
            <span><small>MIC OBSERVATIONS</small><b>{isolationEvidence.observedFrames}</b></span>
            <span><small>SOURCE-COMPARABLE</small><b>{isolationEvidence.comparableFrames}</b></span>
            <span className={isolationEvidence.matchingFrames > 0 ? "danger" : ""}><small>SOURCE MATCHES</small><b>{isolationEvidence.matchingFrames}</b></span>
            <span><small>SCORING</small><b>LOCKED</b></span>
          </div>

          <NoteInput
            variant="scope"
            input={input}
            title="Song Rail isolation monitor"
          />

          {phase === "isolation-blocked" && (
            <div className="song-isolation-alert" role="alert">
              <b>{isolationIssue === "leak" ? "Source leakage detected" : "Comparison incomplete"}</b>
              <span>{status} No score was recorded.</span>
            </div>
          )}
          {error && <div className="error-banner" role="alert">{error}</div>}

          <div className="song-isolation-actions">
            {phase === "isolation-blocked" && <ActionButton className="primary" onClick={() => { void startRun(); }}><Icon name="headphones" size={17} /> Retry safety check</ActionButton>}
            <ActionButton onClick={() => returnFromIsolation(phase === "isolation-check"
              ? "Isolation check cancelled. Confirm the playback route, then try again."
              : "Safety check remains required. Fix the playback or microphone route, then retry.")}>{phase === "isolation-check" ? "Cancel check" : "Back to track setup"}</ActionButton>
          </div>
        </Panel>
      )}

      {(phase === "playing" || phase === "paused") && analysis && (
        <div className={`song-ride-stage ${phase === "paused" ? "paused" : ""}`}>
          <NoteInput variant="compact" input={input} compact />
          <div className="song-ride-readout">
            <div><span>NOW</span><strong>{activeLane ? noteLabel(activeLane.targetMidi) : "BREATHE"}</strong><small>{activeLane ? feedback.showCents ? `±${activeLane.toleranceCents}¢ lane` : "target lane" : "next target incoming"}</small></div>
            <div className={voiceLocked ? "locked" : ""}><span>YOUR VOICE</span><strong>{liveVoiceLabel}</strong><small>{liveVoiceDetail}</small></div>
            <div><span>NEXT</span><strong>{nextLane ? feedback.showUpcomingCue ? noteLabel(nextLane.targetMidi) : "HIDDEN" : "END"}</strong><small>{formatTime(remainingSeconds)} remaining</small></div>
          </div>

          <div className="song-rail" role="img" aria-label={`Moving song rail. ${activeLane ? `Current target ${noteLabel(activeLane.targetMidi)}.` : "Breathing gap."}`}>
            <div className="song-rail-grid">{Array.from({ length: 7 }, (_, index) => <i key={index} />)}</div>
            <i className="song-rail-playhead"><span>NOW</span></i>
            {visibleLanes.map(({ lane, left, width, top }) => (
              <span
                key={lane.id}
                className={`song-rail-lane ${lane.id === activeLane?.id ? "active" : lane.endSeconds < currentTime ? "past" : "future"}`}
                style={{
                  "--lane-left": `${left}%`,
                  "--lane-width": `${width}%`,
                  "--lane-top": `${top}%`,
                } as CSSProperties}
              ><b>{feedback.showUpcomingCue || lane.id === activeLane?.id || lane.endSeconds < currentTime ? noteLabel(lane.targetMidi) : "•"}</b></span>
            ))}
            <span
              className={`song-voice-cursor ${liveMidi === null ? "silent" : ""} ${voiceLocked ? "locked" : ""}`}
              style={{ "--voice-top": `${liveTop}%` } as CSSProperties}
              role="meter"
              aria-label="Live voice pitch position"
              aria-valuemin={voiceRange.lowMidi}
              aria-valuemax={voiceRange.highMidi}
              aria-valuenow={liveMidi === null ? undefined : clamp(liveMidi, voiceRange.lowMidi, voiceRange.highMidi)}
              aria-valuetext={liveMidi === null
                ? "No reliable pitch"
                : feedback.showLiveNote ? noteLabel(liveMidi) : "Reliable pitch detected"}
            ><i />{feedback.showLiveNote && <b>{liveMidi === null ? "VOICE" : noteLabel(liveMidi)}</b>}</span>
          </div>

          <div className="song-transport">
            <button type="button" onClick={phase === "paused" ? () => { void resumeRun(); } : () => pauseRun(false)}><Icon name={phase === "paused" ? "play" : "pause"} size={18} /> {phase === "paused" ? "Resume" : "Pause"}</button>
            <div><span>{formatTime(currentTime)}</span><div className="song-progress-track" role="progressbar" aria-label="Song progress" aria-valuemin={0} aria-valuemax={Math.max(1, duration)} aria-valuenow={currentTime} aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}><i style={{ width: `${progressPercent}%` }} /></div><span>−{formatTime(remainingSeconds)}</span></div>
            <button type="button" className="coral" onClick={() => finishRunRef.current(false)}>Stop & grade</button>
          </div>

          <div className="song-ride-status" role="status" aria-live="polite"><span>{status}</span><b>{activeLane ? `${hud.hitLanes}/${hud.attemptedLanes} lanes earned` : "Breathe · stay ready"}</b></div>

          {phase === "paused" && (
            <div className="song-pause-card" role="dialog" aria-modal="false" aria-labelledby="song-pause-title">
              <Eyebrow>Transport paused</Eyebrow>
              <h2 id="song-pause-title">Position and score preserved.</h2>
              <p>Take a breath, then resume from {formatTime(currentTime)} or grade the section you attempted.</p>
              <div><ActionButton onClick={() => finishRunRef.current(false)}>Stop & grade</ActionButton><ActionButton className="primary" onClick={() => { void resumeRun(); }}><Icon name="play" size={17} /> Resume rail</ActionButton></div>
            </div>
          )}
        </div>
      )}

      {phase === "result" && result && analysis && (
        <Panel className="arcade-result-stage song-result-stage">
          <div className="arcade-result-grade"><span>SONG RAIL GRADE</span><strong>{result.grade}</strong><b>{result.score}<small>/100</small></b></div>
          <div className="arcade-result-copy">
            <Eyebrow>{result.completionPercent >= 99.5 ? "Track complete" : "Section graded"}</Eyebrow>
            <h2>{result.gradeLabel}</h2>
            <p>{status}</p>
            <div className="arcade-result-metrics">
              <span><small>Lanes earned</small><b>{result.hitLanes}/{result.attemptedLanes}</b></span>
              <span><small>Time in lane</small><b>{result.accuracyPercent.toFixed(0)}%</b></span>
              <span><small>Best combo</small><b>{result.bestCombo}×</b></span>
              <span><small>Voiced coverage</small><b>{result.voicedCoveragePercent.toFixed(0)}%</b></span>
            </div>
            <div className="arcade-result-actions">
              <ActionButton onClick={onExit}>Back to cabinet</ActionButton>
              <ActionButton onClick={clearLoadedTrack}>Choose another track</ActionButton>
              <ActionButton className="primary" onClick={() => { void startRun(); }}>Replay rail <Icon name="arrow" size={16} /></ActionButton>
            </div>
          </div>
        </Panel>
      )}
    </section>
  );
}
