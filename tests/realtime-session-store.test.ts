import { describe, expect, it, vi } from "vitest";
import {
  RealtimeSessionStore,
  type PresentationScheduler,
} from "../apps/web/src/realtime/realtime-session-store";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  createVoiceDrawState,
  reduceVoiceDrawSession,
  startVoiceDraw,
} from "../apps/web/src/features/voice-arcade/voice-draw-engine";
import {
  createPitchTunnel,
  reducePitchTunnel,
} from "../apps/web/src/features/pitch-tunnel/pitch-tunnel-engine";
import { PITCH_TUNNEL_PRESENTATION_POLICY } from "../apps/web/src/features/pitch-tunnel/use-pitch-tunnel";

type Action = Readonly<{ type: "add"; value: number }>;

class ManualScheduler implements PresentationScheduler {
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

const reducer = (state: Readonly<{ total: number }>, action: Action) => ({
  total: state.total + action.value,
});

function voicedObservation(endSample: number, midiFloat = 50): PitchObservation {
  const sampleRate = 48_000;
  return Object.freeze({
    observationKind: "voiced",
    timeSeconds: endSample / sampleRate,
    sampleRate,
    startSample: endSample - 4_096,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: false,
    frequencyHz: 440 * 2 ** ((midiFloat - 69) / 12),
    midiFloat,
    nearestMidi: midiFloat,
    centsFromNearest: 0,
    confidence: 0.98,
    periodicity: 0.98,
    rms: 0.08,
    voiced: true,
    detector: "yin",
    periodSamples: 300,
    yinValue: 0.02,
    reason: "detected",
  });
}

function unvoicedObservation(endSample: number): PitchObservation {
  return Object.freeze({
    ...voicedObservation(endSample),
    observationKind: "unvoiced",
    frequencyHz: null,
    midiFloat: null,
    nearestMidi: null,
    centsFromNearest: null,
    confidence: 0,
    periodicity: 0,
    rms: 0,
    voiced: false,
    periodSamples: null,
    yinValue: null,
    reason: "below-rms-threshold",
  });
}

describe("RealtimeSessionStore", () => {
  it("reduces every sensor action immediately but coalesces presentation", () => {
    const scheduler = new ManualScheduler();
    const store = new RealtimeSessionStore(reducer, { total: 0 }, 30, scheduler);
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe({ type: "add", value: 1 });
    store.observe({ type: "add", value: 2 });
    store.observe({ type: "add", value: 3 });

    expect(store.getCurrent()).toEqual({ total: 6 });
    expect(store.getSnapshot()).toEqual({ total: 0 });
    expect(scheduler.callbacks).toHaveLength(1);
    scheduler.frame(1);
    expect(store.getSnapshot()).toEqual({ total: 6 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated sensor publication independently of detector cadence", () => {
    const scheduler = new ManualScheduler();
    const store = new RealtimeSessionStore(reducer, { total: 0 }, 30, scheduler);
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe({ type: "add", value: 1 });
    scheduler.frame(1);
    store.observe({ type: "add", value: 1 });
    scheduler.frame(17);
    expect(store.getSnapshot()).toEqual({ total: 1 });
    scheduler.frame(35);
    expect(store.getSnapshot()).toEqual({ total: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("publishes commands immediately and cancels an obsolete queued frame", () => {
    const scheduler = new ManualScheduler();
    const store = new RealtimeSessionStore(reducer, { total: 0 }, 30, scheduler);
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe({ type: "add", value: 4 });
    store.dispatch({ type: "add", value: 5 });

    expect(store.getCurrent()).toEqual({ total: 9 });
    expect(store.getSnapshot()).toEqual({ total: 9 });
    expect(scheduler.callbacks).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reduces every real voice-drawing window before one coalesced UI publication", () => {
    const scheduler = new ManualScheduler();
    const initial = startVoiceDraw(createVoiceDrawState({
      voiceRange: { lowMidi: 48, highMidi: 60, baselineMidi: 48 },
      speedNormalizedPerSecond: 0.2,
    }));
    const store = new RealtimeSessionStore(
      reduceVoiceDrawSession,
      initial,
      30,
      scheduler,
    );
    const listener = vi.fn();
    store.subscribe(listener);

    const observations = Array.from(
      { length: 51 },
      (_, index) => voicedObservation(4_096 + index * 960),
    );
    for (const observation of observations) {
      store.observe({ type: "observation", observation });
    }

    expect(store.getCurrent().observedFrameCount).toBe(51);
    expect(store.getCurrent().lastAuthority?.endSample).toBe(observations.at(-1)!.endSample);
    expect(store.getCurrent().elapsedSeconds).toBeCloseTo(1, 12);
    expect(store.getSnapshot().observedFrameCount).toBe(0);
    expect(scheduler.callbacks).toHaveLength(1);

    scheduler.frame(1);
    expect(store.getSnapshot()).toBe(store.getCurrent());
    expect(store.getSnapshot().observedFrameCount).toBe(51);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("publishes Pitch Tunnel's exact first voiced frame, then bounds steady voiced frames", () => {
    const scheduler = new ManualScheduler();
    const store = new RealtimeSessionStore(
      reducePitchTunnel,
      createPitchTunnel(),
      30,
      scheduler,
      PITCH_TUNNEL_PRESENTATION_POLICY,
    );
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe({ type: "observation", observation: unvoicedObservation(59_776) });
    expect(store.getSnapshot().currentObservationKind).toBe("unvoiced");
    store.observe({ type: "observation", observation: unvoicedObservation(60_736) });
    expect(scheduler.callbacks).toHaveLength(1);

    const firstVoiced = voicedObservation(61_696);
    store.observe({ type: "observation", observation: firstVoiced });
    expect(scheduler.callbacks).toHaveLength(0);
    expect(store.getSnapshot().currentObservationKind).toBe("voiced");
    expect(store.getSnapshot().lastAuthority?.endSample).toBe(firstVoiced.endSample);
    expect(store.getSnapshot()).toBe(store.getCurrent());
    expect(listener).toHaveBeenCalledTimes(2);

    for (let index = 1; index <= 49; index += 1) {
      store.observe({
        type: "observation",
        observation: voicedObservation(firstVoiced.endSample + index * 960),
      });
      scheduler.frame(index * 20);
    }
    scheduler.frame(1_000);

    expect(store.getCurrent().observedFrameCount).toBe(52);
    expect(store.getSnapshot()).toBe(store.getCurrent());
    expect(listener.mock.calls.length - 2).toBeLessThanOrEqual(25);
  });

  it("publishes exact checkpoint and nonterminal achievement observations without waiting for cadence", () => {
    const scheduler = new ManualScheduler();
    const store = new RealtimeSessionStore(
      reducePitchTunnel,
      createPitchTunnel({
        checkpointOffsetsCents: [0, 25],
        requiredInLaneSeconds: 0.04,
      }),
      30,
      scheduler,
      PITCH_TUNNEL_PRESENTATION_POLICY,
    );
    const listener = vi.fn();
    store.subscribe(listener);
    const anchor = voicedObservation(61_696);
    store.observe({ type: "observation", observation: anchor });
    store.dispatch({ type: "start" });
    listener.mockClear();

    store.observe({ type: "observation", observation: voicedObservation(62_656) });
    scheduler.frame(20);
    const checkpointFrame = voicedObservation(63_616);
    store.observe({ type: "observation", observation: checkpointFrame });
    expect(store.getSnapshot().checkpoint?.index).toBe(1);
    expect(store.getSnapshot().lastAuthority?.endSample).toBe(checkpointFrame.endSample);
    expect(scheduler.callbacks).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1);

    store.observe({ type: "observation", observation: voicedObservation(64_576, 50.25) });
    store.observe({ type: "observation", observation: voicedObservation(65_536, 50.25) });
    const completingFrame = voicedObservation(66_496, 50.25);
    store.observe({ type: "observation", observation: completingFrame });
    expect(store.getSnapshot().status).toBe("tracking");
    expect(store.getSnapshot().achievementReached).toBe(true);
    expect(store.getSnapshot().lastAuthority?.endSample).toBe(completingFrame.endSample);
    expect(scheduler.callbacks).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(2);

    store.dispatch({ type: "finish" });
    expect(store.getSnapshot().status).toBe("complete");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("publishes exact discontinuity and epoch authority while steady pitch remains queued", () => {
    const scheduler = new ManualScheduler();
    const store = new RealtimeSessionStore(
      reducePitchTunnel,
      createPitchTunnel(),
      30,
      scheduler,
      PITCH_TUNNEL_PRESENTATION_POLICY,
    );
    const listener = vi.fn();
    store.subscribe(listener);
    store.observe({ type: "observation", observation: voicedObservation(61_696) });
    listener.mockClear();

    store.observe({ type: "observation", observation: voicedObservation(62_656) });
    expect(scheduler.callbacks).toHaveLength(1);
    const discontinuity = Object.freeze({
      ...voicedObservation(63_616),
      discontinuity: true,
    });
    store.observe({ type: "observation", observation: discontinuity });
    expect(store.getSnapshot().lastAuthority).toMatchObject({
      endSample: discontinuity.endSample,
      continuityEpoch: 0,
    });
    expect(scheduler.callbacks).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1);

    const continuityChange = Object.freeze({
      ...voicedObservation(64_576),
      continuityEpoch: 1,
    });
    store.observe({ type: "observation", observation: continuityChange });
    expect(store.getSnapshot().lastAuthority).toMatchObject({
      endSample: continuityChange.endSample,
      continuityEpoch: 1,
    });
    expect(listener).toHaveBeenCalledTimes(2);

    const graphChange = Object.freeze({
      ...voicedObservation(65_536),
      continuityEpoch: 1,
      graphGeneration: 1,
    });
    store.observe({ type: "observation", observation: graphChange });
    expect(store.getSnapshot().lastAuthority).toMatchObject({
      endSample: graphChange.endSample,
      graphGeneration: 1,
    });
    expect(listener).toHaveBeenCalledTimes(3);

    const captureChange = Object.freeze({
      ...voicedObservation(4_096),
      captureEpoch: 2,
      continuityEpoch: 0,
      graphGeneration: 0,
    });
    store.observe({ type: "observation", observation: captureChange });
    expect(store.getSnapshot().lastAuthority).toMatchObject({
      endSample: captureChange.endSample,
      captureEpoch: 2,
    });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("rejects invalid presentation frequencies", () => {
    const scheduler = new ManualScheduler();
    for (const value of [0, -1, 121, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new RealtimeSessionStore(reducer, { total: 0 }, value, scheduler))
        .toThrow(RangeError);
    }
  });
});
