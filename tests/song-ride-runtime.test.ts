import { describe, expect, it, vi } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import type { PresentationScheduler } from "../apps/web/src/realtime/realtime-session-store";
import type { PreparedSongAnalysis } from "../apps/web/src/features/voice-arcade/song-ride-analysis";
import type { SongLaneAnalysis } from "../apps/web/src/features/voice-arcade/song-lane-types";
import { SongRideRuntime } from "../apps/web/src/features/voice-arcade/song-ride-runtime";

class ManualPresentationScheduler implements PresentationScheduler {
  currentTime = 0;
  nextHandle = 1;
  callbacks = new Map<number, (timestampMs: number) => void>();
  readonly request = (callback: (timestampMs: number) => void): number => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle;
  };
  readonly cancel = (handle: number): void => {
    this.callbacks.delete(handle);
  };
  readonly now = (): number => this.currentTime;
  frame(timestampMs: number): void {
    this.currentTime = timestampMs;
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of pending) callback(timestampMs);
  }
}

class FakeAudioElement {
  paused = true;
  currentTime = 0;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
}

const ANALYSIS: SongLaneAnalysis = {
  durationSeconds: 1,
  sourceSampleRate: 48_000,
  analysisSampleRate: 6_000,
  frames: [],
  lanes: [{
    id: "lane-1",
    startSeconds: 0,
    endSeconds: 1,
    durationSeconds: 1,
    sourceMidi: 60,
    targetMidi: 60,
    lowerMidi: 59.8,
    upperMidi: 60.2,
    toleranceCents: 20,
    averageConfidence: 0.95,
    voicedFrameCount: 50,
    voicedSeconds: 1,
    wasClippedToRange: false,
  }],
  difficulty: "medium",
  toleranceCents: 20,
  vocalRange: { minMidi: 48, maxMidi: 60 },
  transposeSemitones: 0,
  clippedLaneCount: 0,
  sourceMidiRange: { minMidi: 60, maxMidi: 60 },
  targetMidiRange: { minMidi: 60, maxMidi: 60 },
  voicedFrameCount: 50,
  voicedCoverage: 1,
};

function observation(index: number, midi: number | null = 60): PitchObservation {
  const sampleRate = 48_000;
  const endSample = 4_096 + index * 960;
  const startSample = endSample - 4_096;
  const voiced = midi !== null;
  return Object.freeze({
    observationKind: voiced ? "voiced" : "unvoiced",
    timeSeconds: (startSample + endSample) / (2 * sampleRate),
    sampleRate,
    startSample,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: index === 0,
    frequencyHz: voiced ? 440 * 2 ** ((midi - 69) / 12) : null,
    midiFloat: midi,
    nearestMidi: midi,
    centsFromNearest: voiced ? 0 : null,
    confidence: voiced ? 0.98 : 0,
    periodicity: voiced ? 0.98 : 0,
    rms: voiced ? 0.08 : 0,
    voiced,
    detector: "yin",
    periodSamples: voiced ? 300 : null,
    yinValue: voiced ? 0.02 : null,
    reason: voiced ? "detected" : "no-periodic-candidate",
  });
}

function prepared(analysis = ANALYSIS, cancel = vi.fn()): PreparedSongAnalysis {
  return {
    task: { promise: Promise.resolve(analysis), cancel },
    workUnits: 1,
    analysisRate: 6_000,
  };
}

function createRuntime(prepareAnalysis = vi.fn(async () => prepared())) {
  const presentation = new ManualPresentationScheduler();
  const onComplete = vi.fn();
  const createObjectUrl = vi.fn((file: File) => `blob:${file.name}`);
  const revokeObjectUrl = vi.fn();
  const runtime = new SongRideRuntime({
    difficulty: "medium",
    curriculumStage: "deliberate",
    voiceRange: { lowMidi: 48, highMidi: 60, baselineMidi: 54 },
  }, onComplete, {
    maximumPresentationHz: 30,
    presentationScheduler: presentation,
    prepareAnalysis,
    createObjectUrl,
    revokeObjectUrl,
  });
  return { createObjectUrl, onComplete, presentation, revokeObjectUrl, runtime };
}

async function readyRuntime(runtime: SongRideRuntime): Promise<FakeAudioElement> {
  await runtime.loadFile(new File([new Uint8Array([1])], "voice.wav", { type: "audio/wav" }));
  expect(runtime.getCurrent().phase).toBe("ready");
  const audio = new FakeAudioElement();
  runtime.attachAudio(audio as unknown as HTMLAudioElement);
  await runtime.start();
  expect(runtime.getCurrent().phase).toBe("playing");
  return audio;
}

describe("external Song Ride runtime", () => {
  it("enters the user-started live run before browser media readiness resolves", async () => {
    const { runtime } = createRuntime();
    await runtime.loadFile(new File([new Uint8Array([1])], "voice.wav", { type: "audio/wav" }));
    let releasePlayback: () => void = () => {};
    const playbackReady = new Promise<void>((resolve) => {
      releasePlayback = resolve;
    });
    const audio = new FakeAudioElement();
    audio.play.mockImplementation(async () => {
      await playbackReady;
      audio.paused = false;
    });
    runtime.attachAudio(audio as unknown as HTMLAudioElement);

    const pendingStart = runtime.start();
    expect(runtime.getCurrent()).toMatchObject({ phase: "playing", playbackState: "playing" });
    releasePlayback();
    await pendingStart;
    runtime.dispose();
  });

  it("reduces all PCM observations immediately and coalesces React presentation", async () => {
    const { presentation, runtime } = createRuntime();
    const audio = await readyRuntime(runtime);
    const published = vi.fn();
    runtime.subscribe(published);

    for (let index = 0; index < 51; index += 1) {
      audio.currentTime = index * 0.02;
      runtime.observe(observation(index));
    }

    expect(runtime.getCurrent()).toMatchObject({
      phase: "playing",
      currentTime: 1,
      hud: { score: 100, accuracyPercent: 100 },
    });
    expect(runtime.getSnapshot().currentTime).toBe(0);
    expect(presentation.callbacks).toHaveLength(1);
    expect(published).not.toHaveBeenCalled();
    presentation.frame(34);
    expect(runtime.getSnapshot()).toBe(runtime.getCurrent());
    expect(published).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("bounds observation-driven publication to 30 Hz without dropping score evidence", async () => {
    const { presentation, runtime } = createRuntime();
    const audio = await readyRuntime(runtime);
    const publishTimes: number[] = [];
    runtime.subscribe(() => publishTimes.push(presentation.currentTime));

    for (let index = 0; index < 51; index += 1) {
      audio.currentTime = index * 0.02;
      runtime.observe(observation(index));
      presentation.frame((index + 1) * 20);
    }
    presentation.frame(1_060);

    expect(runtime.getCurrent().hud).toMatchObject({ score: 100, accuracyPercent: 100 });
    expect(publishTimes.length).toBeLessThanOrEqual(30);
    for (let index = 1; index < publishTimes.length; index += 1) {
      expect(publishTimes[index]! - publishTimes[index - 1]!).toBeGreaterThanOrEqual(33);
    }
    runtime.dispose();
  });

  it("uses one abort scope to cancel replaced analysis work", async () => {
    let rejectFirst: (reason: unknown) => void = () => undefined;
    const cancelFirst = vi.fn(() => rejectFirst(new DOMException("cancelled", "AbortError")));
    const firstTask = new Promise<SongLaneAnalysis>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const prepareAnalysis = vi.fn()
      .mockResolvedValueOnce({
        task: { promise: firstTask, cancel: cancelFirst },
        workUnits: 1,
        analysisRate: 6_000,
      })
      .mockResolvedValueOnce(prepared());
    const { createObjectUrl, runtime } = createRuntime(prepareAnalysis);

    const firstLoad = runtime.loadFile(new File(["a"], "first.wav"));
    await Promise.resolve();
    const secondLoad = runtime.loadFile(new File(["b"], "second.wav"));
    await Promise.all([firstLoad, secondLoad]);

    expect(cancelFirst).toHaveBeenCalledTimes(1);
    expect(runtime.getCurrent()).toMatchObject({ phase: "ready", track: { name: "second.wav" } });
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("reports one result and releases media resources without touching capture", async () => {
    const { onComplete, revokeObjectUrl, runtime } = createRuntime();
    const audio = await readyRuntime(runtime);
    for (let index = 0; index < 26; index += 1) {
      audio.currentTime = index * 0.02;
      runtime.observe(observation(index));
    }
    runtime.finish();
    runtime.finish();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      mode: "song",
      durationMs: 500,
    }));
    runtime.dispose();
    expect(audio.pause).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:voice.wav");
  });

  it("keeps live telemetry advancing after track completion until the user explicitly stops", async () => {
    const { onComplete, runtime } = createRuntime();
    const audio = await readyRuntime(runtime);
    for (let index = 0; index < 51; index += 1) {
      audio.currentTime = index * 0.02;
      runtime.observe(observation(index));
    }
    audio.currentTime = ANALYSIS.durationSeconds;
    audio.paused = true;
    runtime.completeTrack();
    const completed = runtime.getCurrent();
    expect(completed).toMatchObject({
      phase: "playing",
      playbackState: "ended",
      currentTime: 1,
    });
    expect(completed.result).not.toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(1);

    runtime.observe(observation(51, null));
    runtime.observe(observation(52));
    const stillLive = runtime.getCurrent();
    expect(stillLive).toMatchObject({ phase: "playing", playbackState: "ended" });
    expect(stillLive.liveObservation?.endSample).toBe(observation(52).endSample);
    expect(stillLive.result).toBe(completed.result);
    runtime.completeTrack();
    expect(onComplete).toHaveBeenCalledTimes(1);

    runtime.finish();
    expect(runtime.getCurrent().phase).toBe("result");
    expect(onComplete).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("keeps the user-owned vocal surface live while track playback is explicitly paused", async () => {
    const { runtime } = createRuntime();
    const audio = await readyRuntime(runtime);
    audio.currentTime = 0.4;
    runtime.observe(observation(0));
    runtime.pausePlayback();
    expect(runtime.getCurrent()).toMatchObject({ phase: "playing", playbackState: "paused" });

    runtime.observe(observation(1));
    expect(runtime.getCurrent()).toMatchObject({
      phase: "playing",
      playbackState: "paused",
      currentTime: 0.4,
    });
    expect(runtime.getCurrent().liveObservation?.endSample).toBe(observation(1).endSample);
    runtime.dispose();
  });

  it("keeps telemetry live when the browser pauses media without a feature state transition", async () => {
    const { runtime } = createRuntime();
    const audio = await readyRuntime(runtime);
    audio.currentTime = 0.24;
    runtime.observe(observation(0));
    audio.paused = true;

    runtime.observe(observation(1));
    runtime.observe(observation(2, null));
    expect(runtime.getCurrent()).toMatchObject({
      phase: "playing",
      playbackState: "playing",
      currentTime: 0.24,
    });
    expect(runtime.getCurrent().liveObservation?.endSample).toBe(observation(2).endSample);
    runtime.dispose();
  });
});
