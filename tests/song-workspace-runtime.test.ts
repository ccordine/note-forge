import { describe, expect, it, vi } from "vitest";
import {
  INITIAL_SONG_WORKSPACE,
  reduceSongWorkspace,
  type SongWorkspaceAction,
  type SongWorkspaceState,
} from "../apps/web/src/features/song-lab/song-workspace";
import {
  SongWorkspaceRuntime,
  type SongPlaybackRequest,
  type SongWorkspaceEnvironment,
} from "../apps/web/src/features/song-lab/song-workspace-runtime";
import type {
  LocalRecordingChunkSession,
  LocalRecordingChunkStore,
} from "../apps/web/src/audio/local-recording-store";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function decodedAudio(value = 0.5): AudioBuffer {
  const channel = new Float32Array(480).fill(value);
  return {
    duration: 2,
    numberOfChannels: 1,
    length: channel.length,
    sampleRate: 48_000,
    getChannelData: () => channel,
  } as unknown as AudioBuffer;
}

class FakeRecorder {
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((this: MediaRecorder, event: BlobEvent) => unknown) | null = null;
  onstop: ((this: MediaRecorder, event: Event) => unknown) | null = null;
  onerror: ((this: MediaRecorder, event: Event) => unknown) | null = null;
  startCalls = 0;
  stopCalls = 0;

  start(): void {
    this.startCalls += 1;
    this.state = "recording";
  }

  stop(): void {
    this.stopCalls += 1;
    this.state = "inactive";
    this.onstop?.call(this as unknown as MediaRecorder, new Event("stop"));
  }

  emitData(value: string): void {
    this.emitBlob(new Blob([value], { type: this.mimeType }));
  }

  emitBlob(data: Blob): void {
    this.ondataavailable?.call(this as unknown as MediaRecorder, {
      data,
    } as BlobEvent);
  }
}

class FakeRecordingChunkSession implements LocalRecordingChunkSession {
  readonly chunks: Blob[] = [];
  discarded = false;
  finalized = false;

  constructor(private readonly appendFailure: Error | null = null) {}

  readonly append = async (chunk: Blob): Promise<void> => {
    if (this.appendFailure) throw this.appendFailure;
    this.chunks.push(chunk);
  };

  readonly finalize = async (mimeType: string): Promise<Blob> => {
    this.finalized = true;
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks.length = 0;
    return blob;
  };

  readonly discard = async (): Promise<void> => {
    this.discarded = true;
    this.chunks.length = 0;
  };
}

class FakeRecordingChunkStore implements LocalRecordingChunkStore {
  readonly sessions: FakeRecordingChunkSession[] = [];

  constructor(private readonly appendFailure: Error | null = null) {}

  readonly create = async (): Promise<LocalRecordingChunkSession> => {
    const session = new FakeRecordingChunkSession(this.appendFailure);
    this.sessions.push(session);
    return session;
  };
}

function audioElement(playResult: Promise<void> = Promise.resolve()): HTMLAudioElement {
  return {
    paused: true,
    currentTime: 0,
    play: vi.fn(() => playResult),
    pause: vi.fn(),
  } as unknown as HTMLAudioElement;
}

function playback(element: HTMLAudioElement | null = null): SongPlaybackRequest {
  return { element, loopEnabled: true, loopStart: 0, loopEnd: 2 };
}

function createHarness(overrides: Partial<SongWorkspaceEnvironment> = {}) {
  let state: SongWorkspaceState = INITIAL_SONG_WORKSPACE;
  const actions: SongWorkspaceAction[] = [];
  const revoked: string[] = [];
  let urlSequence = 0;
  const defaultRecordingStore = new FakeRecordingChunkStore();
  const environment: SongWorkspaceEnvironment = {
    decodeAudio: async () => decodedAudio(),
    createObjectURL: () => `blob:managed-${++urlSequence}`,
    revokeObjectURL: (url) => revoked.push(url),
    recordingStore: defaultRecordingStore,
    createId: () => `take-${urlSequence}`,
    now: () => new Date("2026-08-24T12:00:00.000Z"),
    ...overrides,
  };
  const runtime = new SongWorkspaceRuntime((action) => {
    actions.push(action);
    state = reduceSongWorkspace(state, action);
  }, environment);
  runtime.activate();
  return {
    runtime,
    actions,
    recordingStore: environment.recordingStore,
    revoked,
    state: () => state,
  };
}

describe("SongWorkspaceRuntime", () => {
  it("ignores superseded file decoding instead of publishing stale song state", async () => {
    const firstDecode = deferred<AudioBuffer>();
    const secondDecode = deferred<AudioBuffer>();
    const decodeAudio = vi.fn((encoded: ArrayBuffer) => (
      new Uint8Array(encoded)[0] === 1 ? firstDecode.promise : secondDecode.promise
    ));
    const harness = createHarness({ decodeAudio });
    const first = new File([Uint8Array.of(1)], "first.wav", { type: "audio/wav" });
    const second = new File([Uint8Array.of(2)], "second.wav", { type: "audio/wav" });

    const firstLoad = harness.runtime.loadFile({ ...playback(), file: first, takes: [] });
    await vi.waitFor(() => expect(decodeAudio).toHaveBeenCalledTimes(1));
    const secondLoad = harness.runtime.loadFile({ ...playback(), file: second, takes: [] });
    await vi.waitFor(() => expect(decodeAudio).toHaveBeenCalledTimes(2));
    secondDecode.resolve(decodedAudio(0.75));
    await secondLoad;
    firstDecode.resolve(decodedAudio(0.25));
    await firstLoad;

    const loaded = harness.actions.filter((action) => action.type === "song-loaded");
    expect(loaded).toHaveLength(1);
    expect(harness.state().fileName).toBe("second.wav");
    expect(harness.state().audioUrl).toBe("blob:managed-1");
  });

  it("discards stale decode completion after route unmount", async () => {
    const decode = deferred<AudioBuffer>();
    const createObjectURL = vi.fn(() => "blob:late");
    const harness = createHarness({ decodeAudio: () => decode.promise, createObjectURL });
    const file = new File([Uint8Array.of(1)], "late.wav", { type: "audio/wav" });
    const loading = harness.runtime.loadFile({ ...playback(), file, takes: [] });
    await vi.waitFor(() => expect(harness.actions).toContainEqual({ type: "load-started" }));

    harness.runtime.dispose();
    decode.resolve(decodedAudio());
    await loading;

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(harness.actions.some((action) => action.type === "song-loaded")).toBe(false);
  });

  it("stops, detaches, and discards durable chunks on explicit route leave", async () => {
    const harness = createHarness();
    const recorder = new FakeRecorder();
    await harness.runtime.startRecording({
      ...playback(),
      inputRunning: true,
      createRecorder: () => recorder as unknown as MediaRecorder,
    });
    recorder.emitData("temporary voice data");
    await vi.waitFor(() => expect(
      (harness.recordingStore as FakeRecordingChunkStore).sessions[0]?.chunks,
    ).toHaveLength(1));
    const staleStop = recorder.onstop;

    expect(harness.runtime.recordingActive).toBe(true);
    harness.runtime.dispose();

    expect(recorder.stopCalls).toBe(1);
    expect(recorder.ondataavailable).toBeNull();
    expect(recorder.onstop).toBeNull();
    expect(recorder.onerror).toBeNull();
    expect(harness.runtime.recordingActive).toBe(false);
    await vi.waitFor(() => expect(
      (harness.recordingStore as FakeRecordingChunkStore).sessions[0]?.discarded,
    ).toBe(true));
    staleStop?.call(recorder as unknown as MediaRecorder, new Event("late-stop"));
    expect(harness.actions.some((action) => action.type === "take-added")).toBe(false);
  });

  it("keeps recording indefinitely until the user explicitly presses Stop", async () => {
    const harness = createHarness();
    const recorder = new FakeRecorder();
    await harness.runtime.startRecording({
      ...playback(),
      inputRunning: true,
      createRecorder: () => recorder as unknown as MediaRecorder,
    });
    for (let index = 0; index < 400; index += 1) recorder.emitData(`chunk-${index}`);
    await vi.waitFor(() => expect(
      (harness.recordingStore as FakeRecordingChunkStore).sessions[0]?.chunks,
    ).toHaveLength(400));

    expect(recorder.stopCalls).toBe(0);
    expect(harness.state().recordingStatus).toBe("active");
    expect(harness.state().recordError).toBe("");
    expect(harness.state().takes).toHaveLength(0);

    harness.runtime.stopRecording();
    expect(recorder.stopCalls).toBe(1);
    await vi.waitFor(() => expect(harness.state().takes).toHaveLength(1));
    expect(harness.state().recordingStatus).toBe("idle");
    expect((harness.recordingStore as FakeRecordingChunkStore).sessions[0]?.finalized).toBe(true);
  });

  it("reports durable-storage failure without stealing the user's Stop authority", async () => {
    const recordingStore = new FakeRecordingChunkStore(new DOMException(
      "Local recording quota exhausted.",
      "QuotaExceededError",
    ));
    const harness = createHarness({ recordingStore });
    const recorder = new FakeRecorder();
    await harness.runtime.startRecording({
      ...playback(),
      inputRunning: true,
      createRecorder: () => recorder as unknown as MediaRecorder,
    });

    recorder.emitData("cannot persist");
    await vi.waitFor(() => expect(harness.state().recordError).toContain(
      "Local recording quota exhausted",
    ));

    expect(recorder.stopCalls).toBe(0);
    expect(harness.runtime.recordingActive).toBe(true);
    expect(harness.state().recordingStatus).toBe("active");
    expect(harness.state().recordError).toContain("remains live until you press Stop");
    expect(harness.state().takes).toHaveLength(0);
    expect(recordingStore.sessions[0]?.discarded).toBe(false);

    recorder.emitData("also discarded without growing memory");
    await Promise.resolve();
    expect(recorder.stopCalls).toBe(0);

    harness.runtime.stopRecording();
    expect(recorder.stopCalls).toBe(1);
    await vi.waitFor(() => expect(harness.state().recordingStatus).toBe("idle"));
    expect(recordingStore.sessions[0]?.discarded).toBe(true);
  });

  it("tears down a recorder that partially activates before start throws", async () => {
    const harness = createHarness();
    const recorder = new FakeRecorder();
    recorder.start = () => {
      recorder.startCalls += 1;
      recorder.state = "recording";
      throw new Error("encoder initialization failed");
    };

    await harness.runtime.startRecording({
      ...playback(),
      inputRunning: true,
      createRecorder: () => recorder as unknown as MediaRecorder,
    });

    expect(recorder.stopCalls).toBe(1);
    expect(recorder.ondataavailable).toBeNull();
    expect(recorder.onstop).toBeNull();
    expect(recorder.onerror).toBeNull();
    expect(harness.runtime.recordingActive).toBe(false);
    expect(harness.state().recordingStatus).toBe("idle");
    expect(harness.state().recordError).toContain("encoder initialization failed");
  });

  it("reclaims replaced tracks, cleared takes, and remaining route-owned URLs", async () => {
    const harness = createHarness();
    const firstFile = new File([Uint8Array.of(1)], "first.wav", { type: "audio/wav" });
    await harness.runtime.loadFile({ ...playback(), file: firstFile, takes: [] });
    const firstUrl = harness.state().audioUrl!;

    const recorder = new FakeRecorder();
    await harness.runtime.startRecording({
      ...playback(),
      inputRunning: true,
      createRecorder: () => recorder as unknown as MediaRecorder,
    });
    recorder.emitData("voice data");
    harness.runtime.stopRecording();
    await vi.waitFor(() => expect(harness.state().takes).toHaveLength(1));
    const takeUrl = harness.state().takes[0]!.url;
    harness.runtime.clearTakes(harness.state().takes);
    expect(harness.revoked).toEqual([takeUrl]);

    const secondFile = new File([Uint8Array.of(2)], "second.wav", { type: "audio/wav" });
    await harness.runtime.loadFile({
      ...playback(),
      file: secondFile,
      previousAudioUrl: firstUrl,
      takes: harness.state().takes,
    });
    expect(harness.revoked).toEqual([takeUrl, firstUrl]);

    const secondUrl = harness.state().audioUrl!;
    harness.runtime.dispose();
    expect(harness.revoked).toEqual([takeUrl, firstUrl, secondUrl]);
  });

  it("ignores a rejected play promise after playback was explicitly stopped", async () => {
    const playResult = deferred<void>();
    const element = audioElement(playResult.promise);
    const harness = createHarness();
    const playing = harness.runtime.togglePlayback(playback(element));
    harness.runtime.stopPlayback(element);
    playResult.reject(new Error("late rejection"));
    await playing;

    expect(element.pause).toHaveBeenCalled();
    expect(harness.actions.some((action) => action.type === "load-failed")).toBe(false);
    expect(harness.state().playing).toBe(false);
  });

  it("can reactivate after a StrictMode cleanup without reviving the prior session", async () => {
    const decode = deferred<AudioBuffer>();
    const harness = createHarness({ decodeAudio: () => decode.promise });
    const staleFile = new File([Uint8Array.of(1)], "stale.wav", { type: "audio/wav" });
    const staleLoad = harness.runtime.loadFile({ ...playback(), file: staleFile, takes: [] });
    await vi.waitFor(() => expect(harness.actions.at(-1)).toEqual({ type: "load-started" }));
    harness.runtime.dispose();
    harness.runtime.activate();
    decode.resolve(decodedAudio());
    await staleLoad;

    const freshFile = new File([Uint8Array.of(2)], "fresh.wav", { type: "audio/wav" });
    await harness.runtime.loadFile({ ...playback(), file: freshFile, takes: [] });
    expect(harness.state().fileName).toBe("fresh.wav");
    expect(harness.actions.filter((action) => action.type === "song-loaded")).toHaveLength(1);
  });
});
