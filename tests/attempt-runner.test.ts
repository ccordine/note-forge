import { describe, expect, it, vi } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  advanceAttempt,
  beginAttempt,
  createIdleAttemptRunner,
  finishAttempt,
  reduceAttemptRunner,
} from "../apps/web/src/features/training-session/attempt-runner";
import { attachVoiceToScope } from "../apps/web/src/features/training-session/use-session-effect-scope";

const SAMPLE_RATE = 48_000;
const WINDOW = 4_096;
const HOP = 960;

function observation(
  endSample: number,
  overrides: Partial<PitchObservation> = {},
): PitchObservation {
  const startSample = endSample - WINDOW;
  return {
    observationKind: "voiced",
    timeSeconds: (startSample + endSample) / (2 * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
    startSample,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: Math.round(endSample / 128),
    discontinuity: false,
    frequencyHz: 130.8128,
    midiFloat: 48,
    nearestMidi: 48,
    centsFromNearest: 0,
    confidence: 0.96,
    periodicity: 0.96,
    rms: 0.08,
    voiced: true,
    detector: "yin",
    periodSamples: SAMPLE_RATE / 130.8128,
    yinValue: 0.04,
    reason: "detected",
    ...overrides,
  };
}

describe("sample-authoritative AttemptRunner", () => {
  it("starts on the next observation and advances from 20 ms sample hops", () => {
    let state = beginAttempt({ name: "take" }, 0.06, "2026-08-24T00:00:00.000Z");
    state = advanceAttempt(state, observation(WINDOW));
    expect(state.status).toBe("tracking");
    expect(state.elapsedSeconds).toBe(0);

    state = advanceAttempt(state, observation(WINDOW + HOP));
    state = advanceAttempt(state, observation(WINDOW + HOP * 2));
    state = advanceAttempt(state, observation(WINDOW + HOP * 3));
    expect(state.status).toBe("complete");
    expect(state.elapsedSeconds).toBeCloseTo(0.06, 8);
    expect(state.frameElapsedSeconds).toEqual([0, 0.02, 0.04, 0.06]);
  });

  it("keeps silence as measured evidence while sample time advances", () => {
    let state = beginAttempt({ name: "silence" }, 1, "start");
    state = advanceAttempt(state, observation(WINDOW, {
      observationKind: "unvoiced", voiced: false, frequencyHz: null, midiFloat: null,
      nearestMidi: null, centsFromNearest: null, reason: "no-periodic-candidate",
    }));
    state = advanceAttempt(state, observation(WINDOW + HOP, {
      observationKind: "unvoiced", voiced: false, frequencyHz: null, midiFloat: null,
      nearestMidi: null, centsFromNearest: null, reason: "no-periodic-candidate",
    }));
    expect(state.frames).toHaveLength(2);
    expect(state.frames.every((frame) => frame.observationKind === "unvoiced")).toBe(true);
    expect(state.elapsedSeconds).toBeCloseTo(0.02, 8);
  });

  it("never catches up across duplicate, missing, or discontinuous evidence", () => {
    let state = beginAttempt({ name: "boundaries" }, 1, "start");
    state = advanceAttempt(state, observation(WINDOW));
    state = advanceAttempt(state, observation(WINDOW));
    state = advanceAttempt(state, observation(WINDOW + HOP * 8));
    state = advanceAttempt(state, observation(WINDOW + HOP * 9, { continuityEpoch: 1, discontinuity: true }));
    expect(state.elapsedSeconds).toBe(0);

    state = advanceAttempt(state, observation(WINDOW + HOP * 10, { continuityEpoch: 1 }));
    expect(state.elapsedSeconds).toBeCloseTo(0.02, 8);
  });

  it("only finishes manually after at least one real observation", () => {
    let state = beginAttempt({ name: "manual" }, 4, "start");
    expect(finishAttempt(state).status).toBe("tracking");
    state = reduceAttemptRunner(state, { type: "observation", observation: observation(WINDOW) });
    state = reduceAttemptRunner(state, { type: "finish" });
    expect(state.status).toBe("complete");
    expect(advanceAttempt(state, observation(WINDOW + HOP))).toBe(state);
  });

  it("rejects invalid durations and resets to one idle state", () => {
    expect(() => beginAttempt({}, 0, "start")).toThrow(RangeError);
    expect(createIdleAttemptRunner()).toEqual({
      status: "idle",
      configuration: null,
      durationSeconds: 0,
      elapsedSeconds: 0,
      startedAt: null,
      frames: [],
      frameElapsedSeconds: [],
      cursor: null,
    });
  });

  it("binds a prompt voice to one abort scope", async () => {
    const controller = new AbortController();
    const stop = vi.fn();
    await attachVoiceToScope(controller.signal, async () => ({ stop }));
    controller.abort();
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(0.03);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const lateStop = vi.fn();
    await attachVoiceToScope(alreadyAborted.signal, async () => ({ stop: lateStop }));
    expect(lateStop).toHaveBeenCalledWith(0);
  });
});
