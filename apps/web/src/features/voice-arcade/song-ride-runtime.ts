import type { PitchObservation } from "@/audio/note-input";
import {
  RealtimeSessionStore,
  type PresentationScheduler,
} from "@/realtime/realtime-session-store";
import {
  prepareSongAnalysis,
  type PreparedSongAnalysis,
} from "./song-ride-analysis";
import {
  createSongScoreRuntime,
  finishSongRide,
  INITIAL_SONG_RIDE_SESSION,
  observeSongLane,
  reduceSongRideSession,
  settleSongThrough,
  songHud,
  songLaneAtTime,
  type SongRideAction,
  type SongRideSession,
  type SongScoreRuntime,
} from "./song-ride-session";
import type {
  ArcadeCurriculumStage,
  ArcadeDifficultyId,
  ArcadeOutcome,
  ArcadeVoiceRange,
} from "./types";

export interface SongRideRuntimeSpec {
  readonly difficulty: ArcadeDifficultyId;
  readonly curriculumStage: ArcadeCurriculumStage;
  readonly voiceRange: ArcadeVoiceRange;
}

export interface SongRideRuntimeOptions {
  readonly maximumPresentationHz?: number;
  readonly presentationScheduler?: PresentationScheduler;
  readonly prepareAnalysis?: typeof prepareSongAnalysis;
  readonly createObjectUrl?: (file: File) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

function difficultyMultiplier(difficulty: ArcadeDifficultyId): number {
  switch (difficulty) {
    case "easy": return 1;
    case "medium": return 1.35;
    case "hard": return 1.75;
  }
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${Math.floor(safe % 60).toString().padStart(2, "0")}`;
}

function stoppedStatus(
  completed: boolean,
  hitLanes: number,
  attemptedLanes: number,
  playedSeconds: number,
): string {
  return completed
    ? `${hitLanes} of ${attemptedLanes} target lanes earned.`
    : `Stopped at ${formatTime(playedSeconds)} and graded over the section you attempted.`;
}

/** External Song Ride authority; audio observations never dispatch React state. */
export class SongRideRuntime {
  private readonly store: RealtimeSessionStore<SongRideSession, SongRideAction>;
  private readonly prepareAnalysis: typeof prepareSongAnalysis;
  private readonly createObjectUrl: (file: File) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private scoreRuntime: SongScoreRuntime = createSongScoreRuntime();
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private activeScope: AbortController | null = null;
  private outcomeReported = false;
  private disposed = false;

  constructor(
    private readonly spec: Readonly<SongRideRuntimeSpec>,
    private readonly onComplete: (outcome: ArcadeOutcome) => void,
    options: Readonly<SongRideRuntimeOptions> = {},
  ) {
    this.prepareAnalysis = options.prepareAnalysis ?? prepareSongAnalysis;
    this.createObjectUrl = options.createObjectUrl ?? ((file) => URL.createObjectURL(file));
    this.revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.store = new RealtimeSessionStore(
      reduceSongRideSession,
      INITIAL_SONG_RIDE_SESSION,
      options.maximumPresentationHz ?? 30,
      options.presentationScheduler,
    );
  }

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);
  readonly getSnapshot = (): SongRideSession => this.store.getSnapshot();
  readonly getCurrent = (): SongRideSession => this.store.getCurrent();

  readonly attachAudio = (element: HTMLAudioElement | null): void => {
    this.audio = element;
  };

  readonly observe = (observation: Readonly<PitchObservation>): void => {
    if (this.disposed) return;
    const session = this.store.getCurrent();
    const audio = this.audio;
    if (session.phase !== "playing" || session.analysis === null || audio === null) return;
    const playbackAdvancing = session.playbackState === "playing" && !audio.paused;
    const currentTime = playbackAdvancing
      ? Math.min(audio.currentTime, session.analysis.durationSeconds)
      : session.currentTime;
    const lane = playbackAdvancing ? songLaneAtTime(session.analysis.lanes, currentTime) : null;
    if (playbackAdvancing) {
      observeSongLane(this.scoreRuntime, lane, observation);
      settleSongThrough(this.scoreRuntime, session.analysis, currentTime);
    }
    this.store.observe({
      type: "run-progress",
      currentTime,
      liveObservation: observation,
      hud: playbackAdvancing ? songHud(this.scoreRuntime, lane) : session.hud,
    });
  };

  /** Low-rate media events keep the playhead visible when voice input is disabled. */
  readonly syncProgress = (): void => {
    if (this.disposed) return;
    const session = this.store.getCurrent();
    const audio = this.audio;
    if (session.phase !== "playing"
      || session.playbackState !== "playing"
      || session.analysis === null
      || audio === null
      || audio.paused) return;
    const currentTime = Math.min(audio.currentTime, session.analysis.durationSeconds);
    settleSongThrough(this.scoreRuntime, session.analysis, currentTime);
    this.store.observe({
      type: "run-progress",
      currentTime,
      liveObservation: session.liveObservation,
      hud: songHud(this.scoreRuntime, songLaneAtTime(session.analysis.lanes, currentTime)),
    });
  };

  readonly loadFile = async (file: File): Promise<void> => {
    if (this.disposed) return;
    const signal = this.replaceScope();
    this.audio?.pause();
    this.store.dispatch({ type: "analysis-started", status: "Reading and decoding the track locally…" });
    let prepared: PreparedSongAnalysis | null = null;
    try {
      prepared = await this.prepareAnalysis(
        file,
        this.spec.difficulty,
        this.spec.voiceRange,
        (status) => {
          if (!signal.aborted) this.store.dispatch({ type: "analysis-status", status });
        },
      );
      if (signal.aborted || this.disposed) {
        prepared.task.cancel();
        return;
      }
      const cancelTask = () => prepared?.task.cancel();
      signal.addEventListener("abort", cancelTask, { once: true });
      let analysis;
      try {
        analysis = await prepared.task.promise;
      } finally {
        signal.removeEventListener("abort", cancelTask);
      }
      if (signal.aborted || this.disposed) return;
      if (analysis.lanes.length === 0) {
        throw new Error(
          "No stable periodic contour was found. Try a clearer passage with a prominent voice or single-note instrument.",
        );
      }
      this.releaseObjectUrl();
      const url = this.createObjectUrl(file);
      this.objectUrl = url;
      this.resetScore();
      this.store.dispatch({
        type: "analysis-ready",
        track: { name: file.name, sizeBytes: file.size, url },
        analysis,
        status: `${analysis.lanes.length.toLocaleString()} challenge lanes ready. The chart follows dominant periodic pitch, not an asserted official melody.`,
      });
    } catch (error) {
      if (signal.aborted || this.disposed) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.store.dispatch({
        type: "analysis-failed",
        error: error instanceof Error
          ? error.message
          : "The browser could not decode or analyze that audio file.",
      });
    }
  };

  readonly clearTrack = (): void => {
    this.abortActive();
    this.audio?.pause();
    this.releaseObjectUrl();
    this.resetScore();
    this.store.dispatch({ type: "clear-track" });
  };

  readonly start = async (): Promise<void> => {
    const session = this.store.getCurrent();
    if (session.phase !== "ready" && session.phase !== "result") return;
    await this.playFromBeginning();
  };

  readonly replay = async (): Promise<void> => {
    const session = this.store.getCurrent();
    if (session.phase !== "playing" || session.playbackState !== "ended") return;
    await this.playFromBeginning();
  };

  readonly pausePlayback = (): void => {
    const session = this.store.getCurrent();
    if (session.phase !== "playing" || session.playbackState !== "playing") return;
    this.abortActive();
    this.audio?.pause();
    this.scoreRuntime.authority = null;
    this.store.dispatch({
      type: "playback-paused",
      status: "Track paused. Live voice telemetry remains active until you stop.",
    });
  };

  readonly resumePlayback = async (): Promise<void> => {
    const audio = this.audio;
    const session = this.store.getCurrent();
    if (this.disposed
      || session.phase !== "playing"
      || session.playbackState !== "paused"
      || audio === null) return;
    const signal = this.replaceScope();
    this.scoreRuntime.authority = null;
    try {
      await audio.play();
      if (signal.aborted || this.disposed) {
        audio.pause();
        return;
      }
      this.store.dispatch({ type: "playback-resumed" });
      this.syncProgress();
    } catch (error) {
      if (signal.aborted || this.disposed) return;
      this.store.dispatch({
        type: "playback-paused",
        status: error instanceof Error ? error.message : "Track playback could not continue.",
      });
    }
  };

  readonly completeTrack = (): void => {
    const session = this.store.getCurrent();
    if (this.disposed
      || session.phase !== "playing"
      || session.playbackState === "ended"
      || session.analysis === null) return;
    this.scoreRuntime.authority = null;
    const result = finishSongRide(
      this.scoreRuntime,
      session.analysis,
      session.analysis.durationSeconds,
      true,
    );
    this.store.dispatch({
      type: "track-completed",
      result,
      status: `${result.hitLanes} of ${result.attemptedLanes} target lanes earned. The live rail remains active until you stop.`,
    });
    this.reportOutcome(result, session.analysis);
  };

  readonly finish = (): void => {
    const session = this.store.getCurrent();
    if (this.disposed || session.analysis === null || session.phase !== "playing") return;
    this.abortActive();
    this.audio?.pause();
    const playedSeconds = Math.max(
      0,
      Math.min(this.audio?.currentTime ?? session.currentTime, session.analysis.durationSeconds),
    );
    const completed = session.playbackState === "ended"
      || playedSeconds >= session.analysis.durationSeconds;
    const result = completed && session.result !== null
      ? session.result
      : finishSongRide(this.scoreRuntime, session.analysis, playedSeconds, completed);
    this.store.dispatch({
      type: "run-finished",
      result,
      status: stoppedStatus(completed, result.hitLanes, result.attemptedLanes, result.playedSeconds),
    });
    this.reportOutcome(result, session.analysis);
  };

  private async playFromBeginning(): Promise<void> {
    const session = this.store.getCurrent();
    const audio = this.audio;
    if (this.disposed || session.analysis === null || session.track === null || audio === null) return;
    const signal = this.replaceScope();
    this.resetScore();
    this.outcomeReported = false;
    audio.pause();
    audio.currentTime = 0;
    // The visible Start/Replay command owns the run transition synchronously.
    // Browser media permission/readiness may affect playback, never whether the
    // user's live vocal session has started.
    this.store.dispatch({ type: "run-started" });
    try {
      await audio.play();
      if (signal.aborted || this.disposed) {
        audio.pause();
        return;
      }
    } catch (error) {
      if (signal.aborted || this.disposed) return;
      this.store.dispatch({
        type: "playback-paused",
        status: error instanceof Error ? error.message : "Playback could not start. The live rail remains under your Stop control.",
      });
    }
  }

  private reportOutcome(
    result: Readonly<ReturnType<typeof finishSongRide>>,
    analysis: Readonly<NonNullable<SongRideSession["analysis"]>>,
  ): void {
    if (this.outcomeReported) return;
    this.outcomeReported = true;
    this.onComplete({
      mode: "song",
      curriculumStage: this.spec.curriculumStage,
      variant: "generated-rail",
      score: result.score,
      grade: result.grade,
      xp: Math.round(result.score * difficultyMultiplier(this.spec.difficulty)),
      accuracy: result.accuracyPercent,
      bestCombo: result.bestCombo,
      durationMs: Math.round(result.playedSeconds * 1_000),
      details: {
        completionPercent: result.completionPercent,
        voicedCoveragePercent: result.voicedCoveragePercent,
        targetLanes: analysis.lanes.length,
        attemptedLanes: result.attemptedLanes,
        hitLanes: result.hitLanes,
        transposeSemitones: analysis.transposeSemitones,
      },
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortActive();
    this.audio?.pause();
    this.audio = null;
    this.releaseObjectUrl();
    this.store.cancelPending();
  }

  private replaceScope(): AbortSignal {
    this.abortActive();
    this.activeScope = new AbortController();
    return this.activeScope.signal;
  }

  private abortActive(): void {
    this.activeScope?.abort();
    this.activeScope = null;
  }

  private resetScore(): void {
    this.scoreRuntime = createSongScoreRuntime();
  }

  private releaseObjectUrl(): void {
    if (this.objectUrl === null) return;
    this.revokeObjectUrl(this.objectUrl);
    this.objectUrl = null;
  }
}
