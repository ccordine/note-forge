import { decodeAudioFile } from "@/audio/audio-context";
import {
  validateDecodedLocalAudio,
  validateLocalAudioFile,
} from "@/audio/local-audio-file";
import {
  LOCAL_RECORDING_CHUNK_STORE,
  type LocalRecordingChunkSession,
  type LocalRecordingChunkStore,
} from "@/audio/local-recording-store";
import type { SongWorkspaceAction, VoiceTake } from "./song-workspace";

const WAVEFORM_BIN_COUNT = 240;
const MEDIA_RECORDER_TIMESLICE_MS = 1_000;
export const MAX_VOICE_TAKES = 4;

export interface SongWorkspaceEnvironment {
  readonly decodeAudio: (encoded: ArrayBuffer) => Promise<AudioBuffer>;
  readonly createObjectURL: (value: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly recordingStore: LocalRecordingChunkStore;
  readonly createId: () => string;
  readonly now: () => Date;
}

const BROWSER_ENVIRONMENT: SongWorkspaceEnvironment = {
  decodeAudio: decodeAudioFile,
  createObjectURL: (value) => URL.createObjectURL(value),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  recordingStore: LOCAL_RECORDING_CHUNK_STORE,
  createId: () => crypto.randomUUID(),
  now: () => new Date(),
};

export interface SongPlaybackRequest {
  readonly element: HTMLAudioElement | null;
  readonly loopEnabled: boolean;
  readonly loopStart: number;
  readonly loopEnd: number;
}

export interface SongFileRequest extends SongPlaybackRequest {
  readonly file: File;
  readonly previousAudioUrl?: string;
  readonly takes: readonly VoiceTake[];
}

export interface SongRecordingRequest extends SongPlaybackRequest {
  readonly inputRunning: boolean;
  readonly createRecorder: () => MediaRecorder;
  readonly takes: readonly VoiceTake[];
}

interface ActiveTake {
  readonly recorder: MediaRecorder;
  readonly storage: LocalRecordingChunkSession;
  readonly priorTakes: readonly VoiceTake[];
  writeQueue: Promise<void>;
  discardReason: string;
  finalized: boolean;
  stopReason: "user" | "infrastructure" | null;
}

interface OpeningTake {
  cancelled: boolean;
}

function createSessionScope(): AbortController {
  return new AbortController();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function waveformPeaks(channel: Float32Array): number[] {
  const bucket = Math.max(1, Math.floor(channel.length / WAVEFORM_BIN_COUNT));
  const peaks = Array.from({ length: WAVEFORM_BIN_COUNT }, (_, index) => {
    let peak = 0;
    const end = Math.min(channel.length, (index + 1) * bucket);
    for (let sample = index * bucket; sample < end; sample += 8) {
      peak = Math.max(peak, Math.abs(channel[sample] ?? 0));
    }
    return peak;
  });
  const maximum = Math.max(...peaks, 0.001);
  return peaks.map((peak) => peak / maximum);
}

/**
 * Owns Song Lab's bounded browser resources. React projects dispatched state;
 * this scope alone cancels async work, playback, recorder callbacks,
 * and object URLs when the workspace leaves the route.
 */
export class SongWorkspaceRuntime {
  private scope: AbortController | null = null;
  private pendingFile: File | null = null;
  private pendingPlay: Promise<void> | null = null;
  private playbackDesired = false;
  private audioElement: HTMLAudioElement | null = null;
  private activeTake: ActiveTake | null = null;
  private openingTake: OpeningTake | null = null;
  private readonly managedObjectUrls = new Set<string>();

  constructor(
    private readonly dispatch: (action: SongWorkspaceAction) => void,
    private readonly environment: SongWorkspaceEnvironment = BROWSER_ENVIRONMENT,
  ) {}

  get recordingActive(): boolean {
    return this.activeTake !== null || this.openingTake !== null;
  }

  activate(): void {
    if (!this.scope || this.scope.signal.aborted) this.scope = createSessionScope();
  }

  dispose(): void {
    const scope = this.scope;
    if (!scope) return;
    scope.abort();
    this.scope = null;
    this.pendingFile = null;
    this.pendingPlay = null;
    this.playbackDesired = false;
    this.audioElement?.pause();
    this.audioElement = null;
    if (this.openingTake) this.openingTake.cancelled = true;
    this.openingTake = null;

    const active = this.activeTake;
    this.activeTake = null;
    if (active) {
      this.detachRecorder(active.recorder);
      if (active.recorder.state !== "inactive") {
        try {
          active.recorder.stop();
        } catch {
          // The platform may finish between the state check and stop().
        }
      }
      void active.writeQueue.then(
        () => active.storage.discard(),
        () => active.storage.discard(),
      ).catch(() => {
        // Route teardown cannot surface an asynchronous browser-storage error.
      });
    }

    for (const url of this.managedObjectUrls) this.environment.revokeObjectURL(url);
    this.managedObjectUrls.clear();
  }

  async loadFile(request: Readonly<SongFileRequest>): Promise<void> {
    const signal = this.activeSignal();
    if (!signal) return;
    this.pendingFile = request.file;
    try {
      validateLocalAudioFile(request.file);
    } catch (error) {
      if (this.pendingFile === request.file) this.pendingFile = null;
      this.dispatch({
        type: "load-failed",
        message: errorMessage(error, "Choose a browser-decodable audio file."),
      });
      return;
    }
    if (this.activeTake) {
      if (this.pendingFile === request.file) this.pendingFile = null;
      this.dispatch({
        type: "load-failed",
        message: "Stop the current voice take before replacing its source track.",
      });
      return;
    }

    this.dispatch({ type: "load-started" });
    try {
      const encoded = await request.file.arrayBuffer();
      if (!this.ownsFile(request.file, signal)) return;
      const decoded = await this.environment.decodeAudio(encoded);
      if (!this.ownsFile(request.file, signal)) return;
      validateDecodedLocalAudio(decoded);
      const peaks = waveformPeaks(decoded.getChannelData(0));
      if (!this.ownsFile(request.file, signal)) return;

      const url = this.environment.createObjectURL(request.file);
      this.managedObjectUrls.add(url);
      this.revoke(request.previousAudioUrl);
      this.stopPlayback(request.element);
      this.clearTakes(request.takes, false);
      this.pendingFile = null;
      this.dispatch({
        type: "song-loaded",
        song: {
          url,
          fileName: request.file.name,
          duration: decoded.duration,
          peaks,
        },
      });
    } catch (error) {
      if (!this.ownsFile(request.file, signal)) return;
      this.pendingFile = null;
      this.dispatch({
        type: "load-failed",
        message: errorMessage(error, "The browser could not decode that audio file."),
      });
    }
  }

  async togglePlayback(request: Readonly<SongPlaybackRequest>): Promise<void> {
    const element = request.element;
    const signal = this.activeSignal();
    if (!signal || !element) return;
    this.audioElement = element;
    if (this.playbackDesired || !element.paused) {
      this.stopPlayback(element);
      return;
    }

    this.playbackDesired = true;
    if (
      request.loopEnabled
      && (element.currentTime < request.loopStart || element.currentTime >= request.loopEnd)
    ) {
      element.currentTime = request.loopStart;
    }

    let pending: Promise<void>;
    try {
      pending = Promise.resolve(element.play());
      this.pendingPlay = pending;
      await pending;
      if (!this.ownsPlay(pending, element, signal)) element.pause();
    } catch (error) {
      if (!this.ownsPlay(pending!, element, signal)) return;
      this.pendingPlay = null;
      this.playbackDesired = false;
      this.dispatch({ type: "playing-changed", playing: false });
      this.dispatch({
        type: "load-failed",
        message: errorMessage(error, "The selected audio could not play."),
      });
    }
  }

  stopPlayback(element: HTMLAudioElement | null = this.audioElement): void {
    this.pendingPlay = null;
    this.playbackDesired = false;
    element?.pause();
    this.dispatchIfActive({ type: "playing-changed", playing: false });
  }

  async startRecording(request: Readonly<SongRecordingRequest>): Promise<void> {
    if (!this.isActive() || this.activeTake || this.openingTake) return;
    if (!request.inputRunning) {
      this.dispatch({
        type: "recording-failed",
        message: "Enable voice in the header before recording a local take.",
      });
      return;
    }

    const signal = this.activeSignal();
    if (!signal) return;
    const opening: OpeningTake = { cancelled: false };
    this.openingTake = opening;
    this.dispatch({ type: "recording-starting" });
    let storage: LocalRecordingChunkSession | null = null;
    try {
      storage = await this.environment.recordingStore.create(this.environment.createId());
      if (opening.cancelled || signal.aborted || this.scope?.signal !== signal) {
        await storage.discard();
        return;
      }
      const recorder = request.createRecorder();
      const active: ActiveTake = {
        recorder,
        storage,
        priorTakes: request.takes,
        writeQueue: Promise.resolve(),
        discardReason: "",
        finalized: false,
        stopReason: null,
      };
      this.openingTake = null;
      this.activeTake = active;
      recorder.ondataavailable = (event) => this.queueRecordingData(active, event.data);
      recorder.onstop = () => { void this.recorderStopped(active); };
      recorder.onerror = () => this.failRecorder(active);
      recorder.start(MEDIA_RECORDER_TIMESLICE_MS);
      this.dispatch({ type: "recording-started" });
      if (request.element?.paused) void this.togglePlayback(request);
    } catch (error) {
      if (this.openingTake === opening) this.openingTake = null;
      const recorder = this.activeTake?.recorder;
      if (recorder) {
        this.detachRecorder(recorder);
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // A failed start may also reject stop; detached callbacks prevent leakage.
          }
        }
      }
      this.activeTake = null;
      if (storage) {
        try {
          await storage.discard();
        } catch {
          // Preserve the originating infrastructure error for the user.
        }
      }
      if (opening.cancelled || signal.aborted || this.scope?.signal !== signal) return;
      this.dispatchIfActive({
        type: "recording-failed",
        message: errorMessage(error, "Could not start recording."),
      });
    } finally {
      if (this.openingTake === opening) this.openingTake = null;
    }
  }

  stopRecording(): void {
    const opening = this.openingTake;
    if (opening) {
      opening.cancelled = true;
      this.openingTake = null;
      this.dispatchIfActive({ type: "recording-stopped" });
      this.stopPlayback();
      return;
    }
    const active = this.activeTake;
    if (!active) {
      this.dispatchIfActive({ type: "recording-stopped" });
    } else if (active.recorder.state === "inactive") {
      active.stopReason = "user";
      this.dispatchIfActive({ type: "recording-finalizing" });
      void this.finalizeRecording(active);
    } else {
      active.stopReason = "user";
      this.dispatchIfActive({ type: "recording-finalizing" });
      this.requestRecorderStop(active);
    }
    this.stopPlayback();
  }

  clearTakes(takes: readonly VoiceTake[], publish = true): void {
    for (const take of takes) this.revoke(take.url);
    if (publish) this.dispatchIfActive({ type: "takes-cleared" });
  }

  onPlay(): void {
    if (!this.playbackDesired) {
      this.audioElement?.pause();
      return;
    }
    this.dispatchIfActive({ type: "playing-changed", playing: true });
  }

  onPause(): void {
    this.pendingPlay = null;
    this.playbackDesired = false;
    this.dispatchIfActive({ type: "playing-changed", playing: false });
  }

  onEnded(): void {
    this.onPause();
  }

  onAudioError(): void {
    this.onEnded();
    this.dispatchIfActive({
      type: "load-failed",
      message: "The decoded local audio could not be played by the media element.",
    });
  }

  private isActive(): boolean {
    return this.scope !== null && !this.scope.signal.aborted;
  }

  private activeSignal(): AbortSignal | null {
    return this.isActive() ? this.scope!.signal : null;
  }

  private ownsFile(file: File, signal: AbortSignal): boolean {
    return !signal.aborted && this.scope?.signal === signal && this.pendingFile === file;
  }

  private ownsPlay(
    pending: Promise<void>,
    element: HTMLAudioElement,
    signal: AbortSignal,
  ): boolean {
    return !signal.aborted
      && this.scope?.signal === signal
      && this.pendingPlay === pending
      && this.audioElement === element
      && this.playbackDesired;
  }

  private dispatchIfActive(action: SongWorkspaceAction): void {
    if (this.isActive()) this.dispatch(action);
  }

  private revoke(url: string | undefined): void {
    if (!url || !this.managedObjectUrls.delete(url)) return;
    this.environment.revokeObjectURL(url);
  }

  private queueRecordingData(active: ActiveTake, data: Blob): void {
    if (this.activeTake !== active || !data.size || active.discardReason) return;
    active.writeQueue = active.writeQueue
      .then(() => active.storage.append(data))
      .catch((error) => {
        this.failRecordingStorage(active, error);
      });
  }

  private failRecorder(active: ActiveTake): void {
    if (this.activeTake !== active) return;
    active.discardReason = "The browser recorder failed; no take was added.";
    active.stopReason = "infrastructure";
    this.dispatchIfActive({ type: "recording-finalizing" });
    this.requestRecorderStop(active);
  }

  private failRecordingStorage(active: ActiveTake, error: unknown): void {
    if (this.activeTake !== active || active.discardReason) return;
    const reason = errorMessage(
      error,
      "Durable local recording storage failed; no take was added.",
    );
    active.discardReason = `${reason} Recording remains live until you press Stop; this take cannot be saved.`;
    // Storage is not Stop authority. Keep accepting the native recorder's
    // lifetime while dropping later chunks at the callback boundary. The user
    // still owns the only normal recorder shutdown call.
    this.dispatchIfActive({
      type: "recording-degraded",
      message: active.discardReason,
    });
  }

  private requestRecorderStop(active: ActiveTake): void {
    if (active.recorder.state === "inactive") {
      void this.finalizeRecording(active);
      return;
    }
    try {
      active.recorder.stop();
    } catch (error) {
      active.discardReason = errorMessage(error, "The recorder could not stop cleanly.");
      active.stopReason = "infrastructure";
      void this.finalizeRecording(active);
    }
  }

  private async recorderStopped(active: ActiveTake): Promise<void> {
    if (this.activeTake !== active) return;
    if (active.stopReason === null) {
      active.stopReason = "infrastructure";
      active.discardReason = "The browser recorder ended unexpectedly; no take was added.";
      this.dispatchIfActive({ type: "recording-finalizing" });
    }
    await this.finalizeRecording(active);
  }

  private async finalizeRecording(active: ActiveTake): Promise<void> {
    if (active.finalized || this.activeTake !== active) return;
    active.finalized = true;
    this.detachRecorder(active.recorder);
    await active.writeQueue;
    if (this.activeTake !== active || !this.isActive()) {
      try {
        await active.storage.discard();
      } catch {
        // No active workspace remains to receive this infrastructure failure.
      }
      return;
    }
    if (active.discardReason || active.stopReason !== "user") {
      try {
        await active.storage.discard();
      } catch (error) {
        active.discardReason ||= errorMessage(
          error,
          "Durable local recording cleanup failed.",
        );
      }
      this.activeTake = null;
      this.dispatch({
        type: "recording-failed",
        message: active.discardReason || "The local recording ended before you pressed Stop.",
      });
      return;
    }

    try {
      const blob = await active.storage.finalize(active.recorder.mimeType || "audio/webm");
      if (this.activeTake !== active || !this.isActive()) return;
      this.activeTake = null;
      if (blob.size === 0) {
        this.dispatch({
          type: "recording-failed",
          message: "The recorder produced an empty take.",
        });
        return;
      }
      const url = this.environment.createObjectURL(blob);
      this.managedObjectUrls.add(url);
      const take = { id: this.environment.createId(), url, createdAt: this.environment.now() };
      const removed = active.priorTakes.slice(MAX_VOICE_TAKES - 1);
      for (const oldTake of removed) this.revoke(oldTake.url);
      this.dispatch({ type: "take-added", take, maximum: MAX_VOICE_TAKES });
    } catch (error) {
      try {
        await active.storage.discard();
      } catch {
        // Report the original finalization failure; cleanup is best-effort here.
      }
      if (this.activeTake !== active || !this.isActive()) return;
      this.activeTake = null;
      this.dispatch({
        type: "recording-failed",
        message: errorMessage(error, "Could not finalize the locally recorded take."),
      });
    }
  }

  private detachRecorder(recorder: MediaRecorder): void {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
  }
}
