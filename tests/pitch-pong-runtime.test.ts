import { describe, expect, it, vi } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import type { PresentationScheduler } from "../apps/web/src/realtime/realtime-session-store";
import {
  PitchPongRuntime,
  type PongDelayClock,
} from "../apps/web/src/features/voice-arcade/pitch-pong-runtime";
import { createPitchPongSpec } from "../apps/web/src/features/voice-arcade/pitch-pong-session";

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

class ManualDelayClock implements PongDelayClock {
  currentTime = 0;
  nextHandle = 1;
  tasks = new Map<number, { readonly at: number; readonly callback: () => void }>();

  readonly set = (callback: () => void, delayMs: number): number => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.tasks.set(handle, { at: this.currentTime + delayMs, callback });
    return handle;
  };

  readonly clear = (handle: number): void => {
    this.tasks.delete(handle);
  };

  advance(milliseconds: number): void {
    this.currentTime += milliseconds;
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.at <= this.currentTime)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [handle, task] of due) {
      if (!this.tasks.delete(handle)) continue;
      task.callback();
    }
  }
}

const SPEC = createPitchPongSpec({
  difficulty: "medium",
  curriculumStage: "deliberate",
  voiceRange: { lowMidi: 48, highMidi: 60, baselineMidi: 54 },
});

function pitchObservation(
  index: number,
  options: Readonly<{
    midi?: number | null;
    endSample?: number;
    captureEpoch?: number;
    discontinuity?: boolean;
  }> = {},
): PitchObservation {
  const sampleRate = 48_000;
  const endSample = options.endSample ?? 4_096 + index * 960;
  const startSample = endSample - 4_096;
  const midi = options.midi === undefined ? 60 : options.midi;
  const voiced = midi !== null;
  return Object.freeze({
    observationKind: voiced ? "voiced" : "unvoiced",
    timeSeconds: (startSample + endSample) / (2 * sampleRate),
    sampleRate,
    startSample,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: options.captureEpoch ?? 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: options.discontinuity ?? index === 0,
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

async function enterPlaying(runtime: PitchPongRuntime, delay: ManualDelayClock): Promise<void> {
  runtime.start();
  expect(runtime.getCurrent()).toMatchObject({ phase: "countdown", countdown: 3 });
  for (const remaining of [2, 1, 0]) {
    delay.advance(650);
    await Promise.resolve();
    expect(runtime.getCurrent().countdown).toBe(remaining);
  }
  expect(runtime.getCurrent().phase).toBe("playing");
}

function createRuntime(onComplete = vi.fn(), spec = SPEC) {
  const presentation = new ManualPresentationScheduler();
  const delay = new ManualDelayClock();
  const runtime = new PitchPongRuntime(spec, onComplete, {
    maximumPresentationHz: 30,
    presentationScheduler: presentation,
    delayClock: delay,
  });
  return { delay, onComplete, presentation, runtime };
}

describe("sample-authoritative Pitch Pong runtime", () => {
  it("reduces every detector window outside React and publishes one bounded snapshot", async () => {
    const { delay, presentation, runtime } = createRuntime();
    await enterPlaying(runtime, delay);
    const published = vi.fn();
    runtime.subscribe(published);

    for (let index = 0; index < 51; index += 1) {
      runtime.observe(pitchObservation(index));
    }

    expect(runtime.getCurrent().stats).toMatchObject({
      observedFrames: 51,
      reliableFrames: 51,
    });
    expect(runtime.getCurrent().stats.activeSampleSeconds).toBeCloseTo(1, 12);
    expect(runtime.getCurrent().stats.voicedControlSeconds).toBeCloseTo(1, 12);
    expect(runtime.getCurrent().game.elapsedSeconds).toBeCloseTo(1, 12);
    expect(runtime.getCurrent().voiceAxis.position).toBeLessThan(0.001);
    expect(runtime.getSnapshot().stats.observedFrames).toBe(0);
    expect(presentation.callbacks).toHaveLength(1);
    expect(published).not.toHaveBeenCalled();

    presentation.frame(34);
    expect(runtime.getSnapshot()).toBe(runtime.getCurrent());
    expect(published).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("freezes immediately on silence and never catches up across missing PCM authority", async () => {
    const { delay, runtime } = createRuntime();
    await enterPlaying(runtime, delay);
    runtime.observe(pitchObservation(0));
    runtime.observe(pitchObservation(1));
    const beforeSilence = runtime.getCurrent();

    runtime.observe(pitchObservation(2, { midi: null }));
    const silence = runtime.getCurrent();
    expect(silence.voiceAxis.position).toBe(beforeSilence.voiceAxis.position);
    expect(silence.voiceAxis.status).toBe("unvoiced");
    expect(silence.stats.activeSampleSeconds - beforeSilence.stats.activeSampleSeconds)
      .toBeCloseTo(0.02, 12);

    const elapsedBeforeGap = silence.game.elapsedSeconds;
    const positionBeforeGap = silence.voiceAxis.position;
    runtime.observe(pitchObservation(3, { endSample: silence.lastAuthority!.endSample + 9_600 }));
    const afterGap = runtime.getCurrent();
    expect(afterGap.game.elapsedSeconds).toBe(elapsedBeforeGap);
    expect(afterGap.voiceAxis.position).toBe(positionBeforeGap);
    expect(afterGap.stats.activeSampleSeconds).toBe(silence.stats.activeSampleSeconds);

    runtime.observe(pitchObservation(4, {
      endSample: afterGap.lastAuthority!.endSample + 960,
      captureEpoch: 2,
      discontinuity: true,
    }));
    expect(runtime.getCurrent().game.elapsedSeconds).toBe(elapsedBeforeGap);
    runtime.dispose();
  });

  it("keeps the live court and authoritative observations running after a winning score", async () => {
    const endlessSpec = Object.freeze({
      ...SPEC,
      pongConfig: Object.freeze({ ...SPEC.pongConfig, winningScore: 1 }),
    });
    const { delay, runtime } = createRuntime(vi.fn(), endlessSpec);
    await enterPlaying(runtime, delay);
    let index = 0;
    while (runtime.getCurrent().achievementCount === 0 && index < 2_000) {
      runtime.observe(pitchObservation(index));
      index += 1;
    }
    const won = runtime.getCurrent();
    expect(won).toMatchObject({
      phase: "playing",
      achievementCount: 1,
      game: { status: "playing", playerScore: 0, opponentScore: 0 },
    });
    expect(won.latestAchievement).not.toBeNull();
    expect(won.result).toBeNull();

    const observationsAtWin = won.stats.observedFrames;
    const elapsedAtWin = won.stats.activeSampleSeconds;
    for (let offset = 0; offset < 51; offset += 1) {
      runtime.observe(pitchObservation(index + offset));
    }
    expect(runtime.getCurrent()).toMatchObject({ phase: "playing", achievementCount: 1 });
    expect(runtime.getCurrent().stats.observedFrames).toBe(observationsAtWin + 51);
    expect(runtime.getCurrent().stats.activeSampleSeconds - elapsedAtWin).toBeCloseTo(1.02, 12);
    expect(runtime.getCurrent().game.elapsedSeconds).toBeGreaterThan(0);

    runtime.finish();
    expect(runtime.getCurrent()).toMatchObject({ phase: "result", achievementCount: 1 });
    runtime.dispose();
  });

  it("keeps at most one abortable countdown scope and reports one sample-timed outcome", async () => {
    const onComplete = vi.fn();
    const { delay, runtime } = createRuntime(onComplete);
    runtime.start();
    expect(delay.tasks).toHaveLength(1);
    runtime.cancel();
    expect(delay.tasks).toHaveLength(0);
    delay.advance(10_000);
    await Promise.resolve();
    expect(runtime.getCurrent().phase).toBe("setup");

    await enterPlaying(runtime, delay);
    for (let index = 0; index < 51; index += 1) runtime.observe(pitchObservation(index));
    runtime.finish();
    runtime.finish();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      mode: "pong",
      variant: "continuous-axis",
      durationMs: 1_000,
    }));
    expect(delay.tasks).toHaveLength(0);
    runtime.dispose();
  });

  it("never publishes observation-driven UI faster than 30 Hz", async () => {
    const { delay, presentation, runtime } = createRuntime();
    await enterPlaying(runtime, delay);
    const publishTimes: number[] = [];
    runtime.subscribe(() => publishTimes.push(presentation.currentTime));

    for (let index = 0; index < 51; index += 1) {
      runtime.observe(pitchObservation(index));
      presentation.frame((index + 1) * 20);
    }
    presentation.frame(1_060);

    expect(runtime.getCurrent().stats.observedFrames).toBe(51);
    expect(publishTimes.length).toBeLessThanOrEqual(30);
    for (let index = 1; index < publishTimes.length; index += 1) {
      expect(publishTimes[index]! - publishTimes[index - 1]!).toBeGreaterThanOrEqual(33);
    }
    runtime.dispose();
  });
});
