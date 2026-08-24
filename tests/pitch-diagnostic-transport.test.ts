import { describe, expect, it } from "vitest";

import type { InputTelemetry } from "../apps/web/src/audio/use-audio-input";
import {
  DIAGNOSTIC_FLOWS,
  PitchDiagnosticTransport,
  toFrameDiagnostic,
  toInputDiagnostic,
  toDiagnosticToken,
  type DiagnosticBatch,
  type DiagnosticEvent,
  type FrameDiagnosticSource,
} from "../apps/web/src/diagnostics/pitch-diagnostics";

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

type WorkflowEventWithoutElapsed = Omit<
  Extract<DiagnosticEvent, { kind: "workflow" }>,
  "elapsedMs"
>;

interface ManualTimers {
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timer: number) => void;
  cleared: number[];
  pending: () => Array<{ id: number; delayMs: number }>;
  fireNext: () => void;
  fireAll: () => void;
}

function createClock(start = 1_000): {
  now: () => number;
  set: (value: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    set: (value) => { current = value; },
  };
}

function createManualTimers(): ManualTimers {
  let nextID = 1;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  const cleared: number[] = [];
  return {
    setTimer: (callback, delayMs) => {
      const id = nextID;
      nextID += 1;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimer: (timer) => {
      cleared.push(timer);
      timers.delete(timer);
    },
    cleared,
    pending: () => [...timers.entries()].map(([id, timer]) => ({ id, delayMs: timer.delayMs })),
    fireNext: () => {
      const entry = timers.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
      if (!entry) throw new Error("No diagnostic timer is pending.");
      timers.delete(entry[0]);
      entry[1].callback();
    },
    fireAll: () => {
      while (timers.size > 0) {
        const entry = timers.entries().next().value as [number, { callback: () => void; delayMs: number }];
        timers.delete(entry[0]);
        entry[1].callback();
      }
    },
  };
}

function createSuccessfulFetcher(calls: FetchCall[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve({ ok: true, status: 204 } as Response);
  }) as typeof fetch;
}

function workflowEvent(attemptID: number): WorkflowEventWithoutElapsed {
  return {
    kind: "workflow",
    workflow: {
      phase: "sustain",
      state: `attempt-${attemptID}`,
      targetMidi: 48,
      attemptId: attemptID,
      holdMs: attemptID * 100,
      requiredHoldMs: 1_500,
    },
  };
}

function batchFrom(call: FetchCall): DiagnosticBatch {
  const body = call.init?.body;
  if (typeof body !== "string") throw new Error("Expected a serialized JSON diagnostic body.");
  return JSON.parse(body) as DiagnosticBatch;
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("pitch diagnostic transport contract", () => {
  it("uses one shared flow allowlist and collision-resistant session identities", () => {
    expect(DIAGNOSTIC_FLOWS).toEqual([
      "audio-input",
      "range-simulator",
      "range-loop",
      "voice-arcade",
      "pitch-mirror",
      "pitch-tunnel",
      "hum-lab",
      "pitch-control",
    ]);
    const first = new PitchDiagnosticTransport({ fetcher: createSuccessfulFetcher([]) });
    const second = new PitchDiagnosticTransport({ fetcher: createSuccessfulFetcher([]) });
    expect(first.sessionId).toMatch(/^[a-zA-Z0-9_-]{8,32}$/u);
    expect(second.sessionId).toMatch(/^[a-zA-Z0-9_-]{8,32}$/u);
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it("rejects transport settings that the server cannot accept", () => {
    expect(() => new PitchDiagnosticTransport({ sessionId: "short" })).toThrow(RangeError);
    expect(() => new PitchDiagnosticTransport({ sessionId: "invalid/session" })).toThrow(RangeError);
    expect(() => new PitchDiagnosticTransport({ maximumBatchEvents: 0 })).toThrow(RangeError);
    expect(() => new PitchDiagnosticTransport({ maximumBatchEvents: 33 })).toThrow(RangeError);
    expect(() => new PitchDiagnosticTransport({ maximumBufferedEvents: 0 })).toThrow(RangeError);
    expect(() => new PitchDiagnosticTransport({ batchDelayMs: Number.NaN })).toThrow(RangeError);
    expect(() => new PitchDiagnosticTransport({ now: () => Number.NaN })).toThrow(RangeError);

    let clockValue = 1;
    const transport = new PitchDiagnosticTransport({
      now: () => clockValue,
      fetcher: createSuccessfulFetcher([]),
    });
    clockValue = Number.POSITIVE_INFINITY;
    expect(() => transport.record("audio-input", workflowEvent(1))).toThrow(RangeError);
  });

  it("normalizes browser error names into server-accepted diagnostic tokens", () => {
    expect(toDiagnosticToken("NotAllowedError")).toBe("not-allowed-error");
    expect(toDiagnosticToken("  Media device / gone  ")).toBe("media-device-gone");
    expect(toDiagnosticToken("***")).toBe("unknown");
  });

  it("flushes immediately at the maximum event count in insertion order", async () => {
    const calls: FetchCall[] = [];
    const clock = createClock();
    const timers = createManualTimers();
    const transport = new PitchDiagnosticTransport({
      endpoint: "/diagnostic-test",
      sessionId: "contract-max-events",
      now: clock.now,
      fetcher: createSuccessfulFetcher(calls),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      batchDelayMs: 900,
      maximumBatchEvents: 3,
      maximumBufferedEvents: 8,
    });

    clock.set(1_005);
    transport.record("range-simulator", workflowEvent(1));
    clock.set(1_010);
    transport.record("range-simulator", workflowEvent(2));
    expect(calls).toHaveLength(0);
    expect(timers.pending()).toEqual([{ id: 1, delayMs: 900 }]);

    clock.set(1_015);
    transport.record("range-simulator", workflowEvent(3));
    await settleAsyncWork();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/diagnostic-test");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: true,
    });
    expect(timers.cleared).toEqual([1]);
    expect(timers.pending()).toEqual([]);

    const batch = batchFrom(calls[0]!);
    expect(batch).toMatchObject({
      version: 3,
      sessionId: "contract-max-events",
      sequence: 0,
      flow: "range-simulator",
    });
    expect(batch.events.map((event) => event.elapsedMs)).toEqual([5, 10, 15]);
    expect(batch.events.map((event) => event.kind === "workflow" ? event.workflow.attemptId : null)).toEqual([1, 2, 3]);
  });

  it("flushes a partial batch when its injected timer fires", async () => {
    const calls: FetchCall[] = [];
    const clock = createClock(5_000);
    const timers = createManualTimers();
    const transport = new PitchDiagnosticTransport({
      sessionId: "contract-timer",
      now: clock.now,
      fetcher: createSuccessfulFetcher(calls),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      batchDelayMs: 750,
      maximumBatchEvents: 5,
    });

    clock.set(5_123);
    transport.record("audio-input", workflowEvent(8));
    expect(calls).toHaveLength(0);
    expect(timers.pending()).toEqual([{ id: 1, delayMs: 750 }]);

    timers.fireNext();
    await settleAsyncWork();

    expect(calls).toHaveLength(1);
    expect(batchFrom(calls[0]!)).toMatchObject({
      sequence: 0,
      flow: "audio-input",
      events: [{ elapsedMs: 123, kind: "workflow" }],
    });
    expect(timers.pending()).toEqual([]);
  });

  it("bounds the queue, drops oldest events, and reports the loss once", async () => {
    const calls: FetchCall[] = [];
    const clock = createClock();
    const timers = createManualTimers();
    const transport = new PitchDiagnosticTransport({
      sessionId: "contract-bounded",
      now: clock.now,
      fetcher: createSuccessfulFetcher(calls),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      maximumBatchEvents: 10,
      maximumBufferedEvents: 3,
    });

    for (let attemptID = 1; attemptID <= 5; attemptID += 1) {
      clock.set(1_000 + attemptID);
      transport.record("range-loop", workflowEvent(attemptID));
    }
    await transport.flush("range-loop");

    expect(calls).toHaveLength(1);
    const first = batchFrom(calls[0]!);
    expect(first.droppedEvents).toBe(2);
    expect(first.events.map((event) => event.kind === "workflow" ? event.workflow.attemptId : null)).toEqual([3, 4, 5]);

    transport.record("range-loop", workflowEvent(6));
    await transport.flush("range-loop");
    const second = batchFrom(calls[1]!);
    expect(second.sequence).toBe(1);
    expect(second).not.toHaveProperty("droppedEvents");
  });

  it("keeps ordering and sequence counters independent for every flow", async () => {
    const calls: FetchCall[] = [];
    const timers = createManualTimers();
    const transport = new PitchDiagnosticTransport({
      sessionId: "contract-per-flow",
      now: () => 100,
      fetcher: createSuccessfulFetcher(calls),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      maximumBatchEvents: 10,
    });

    transport.record("range-simulator", workflowEvent(1));
    transport.record("range-loop", workflowEvent(10));
    transport.record("range-simulator", workflowEvent(2));
    await transport.flush("range-simulator");
    await transport.flush("range-loop");
    transport.record("range-loop", workflowEvent(11));
    transport.record("range-simulator", workflowEvent(3));
    await transport.flush("range-loop");
    await transport.flush("range-simulator");

    const batches = calls.map(batchFrom);
    expect(batches.map(({ flow, sequence }) => [flow, sequence])).toEqual([
      ["range-simulator", 0],
      ["range-loop", 0],
      ["range-loop", 1],
      ["range-simulator", 1],
    ]);
    expect(batches[0]!.events.map((event) => event.kind === "workflow" ? event.workflow.attemptId : null)).toEqual([1, 2]);
    expect(batches[1]!.events.map((event) => event.kind === "workflow" ? event.workflow.attemptId : null)).toEqual([10]);
    expect(batches[2]!.events.map((event) => event.kind === "workflow" ? event.workflow.attemptId : null)).toEqual([11]);
    expect(batches[3]!.events.map((event) => event.kind === "workflow" ? event.workflow.attemptId : null)).toEqual([3]);
  });

  it("serializes only bounded derived pitch fields, never PCM or device identity", async () => {
    const calls: FetchCall[] = [];
    const timers = createManualTimers();
    const transport = new PitchDiagnosticTransport({
      sessionId: "contract-derived",
      now: () => 250,
      fetcher: createSuccessfulFetcher(calls),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      maximumBatchEvents: 1,
    });
    const sourceFrame: FrameDiagnosticSource & {
      samples: Float32Array;
      pcm: Float32Array;
      deviceId: string;
      label: string;
      detector: "yin";
    } = {
      observationKind: "voiced",
      timeSeconds: 0.25,
      sampleRate: 48_000,
      startSample: 8_192,
      endSample: 12_288,
      processedSampleCount: 12_288,
      captureEpoch: 2,
      continuityEpoch: 3,
      graphGeneration: 1,
      discontinuity: false,
      workletProcessCount: 96,
      periodicity: 0.987654,
      frequencyHz: 130.81278265,
      midiFloat: 48.00043821,
      nearestMidi: 48,
      centsFromNearest: 0.043821,
      rms: 0.0812345678,
      confidence: 0.987654,
      brightness: 0.284765,
      brightnessConfidence: 0.93456,
      voiced: true,
      detector: "yin",
      periodSamples: 366.928123,
      yinValue: 0.01234567,
      reason: "detected",
      samples: new Float32Array([0.1, -0.1]),
      pcm: new Float32Array([0.2, -0.2]),
      deviceId: "secret-device-id",
      label: "Secret microphone label",
    };
    const sourceTelemetry: InputTelemetry & {
      samples: Float32Array;
      pcm: Float32Array;
      deviceId: string;
      label: string;
    } = {
      capturedAt: 0.25,
      rms: 0.08,
      peak: 0.25,
      rmsDbfs: -21.9382,
      peakDbfs: -12.0411,
      dcOffset: 0.00012,
      clippedSampleCount: 0,
      clipRatio: 0,
      sampleCount: 4_096,
      headroomDb: 12.0411,
      samples: new Float32Array([0.3, -0.3]),
      pcm: new Float32Array([0.4, -0.4]),
      deviceId: "secret-device-id",
      label: "Secret microphone label",
    };
    const frame = toFrameDiagnostic(sourceFrame);
    const input = toInputDiagnostic(sourceTelemetry);

    transport.record("audio-input", {
      kind: "pitch-frame",
      pitch: {
        frame,
        processingMs: 2.375,
        input,
        tracking: {
          phase: "sustain",
          targetMidi: 48,
          toleranceCents: 25,
          errorCents: 0.0438,
          inBand: true,
          stableMs: 200,
          requiredHoldMs: 1_500,
          resetReason: "stable",
        },
      },
    });
    await settleAsyncWork();

    const call = calls[0]!;
    const serialized = call.init?.body;
    expect(typeof serialized).toBe("string");
    const batch = batchFrom(call);
    const event = batch.events[0];
    if (event?.kind !== "pitch-frame") throw new Error("Expected a pitch-frame event.");

    expect(event.pitch.processingMs).toBe(2.375);
    expect(Object.keys(event.pitch.frame).sort()).toEqual([
      "brightness",
      "brightnessConfidence",
      "captureEpoch",
      "centsFromNearest",
      "confidence",
      "continuityEpoch",
      "discontinuity",
      "endSample",
      "frequencyHz",
      "graphGeneration",
      "midiFloat",
      "nearestMidi",
      "observationKind",
      "periodSamples",
      "periodicity",
      "processedSampleCount",
      "reason",
      "rms",
      "sampleRate",
      "startSample",
      "timeSeconds",
      "voiced",
      "workletProcessCount",
      "yinValue",
    ]);
    expect(Object.keys(event.pitch.input ?? {}).sort()).toEqual([
      "clipRatio",
      "clippedSampleCount",
      "headroomDb",
      "peakDbfs",
      "rmsDbfs",
      "sampleCount",
    ]);
    expect(event.pitch.frame).toMatchObject({
      frequencyHz: 130.8128,
      midiFloat: 48.0004,
      centsFromNearest: 0.0438,
      rms: 0.081235,
      confidence: 0.9877,
      brightness: 0.28477,
      brightnessConfidence: 0.9346,
      periodicity: 0.9877,
      yinValue: 0.01235,
      periodSamples: 366.9281,
      startSample: 8_192,
      endSample: 12_288,
      processedSampleCount: 12_288,
    });
    for (const forbidden of ["\"samples\"", "\"pcm\"", "\"deviceId\"", "\"groupId\"", "\"label\"", "secret-device-id", "Secret microphone label"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects contradictory or unsafe observation coordinates before transport", () => {
    const source: FrameDiagnosticSource = {
      observationKind: "voiced",
      timeSeconds: 1,
      sampleRate: 48_000,
      startSample: 4_096,
      endSample: 8_192,
      processedSampleCount: 8_192,
      captureEpoch: 1,
      continuityEpoch: 0,
      graphGeneration: 1,
      discontinuity: false,
      workletProcessCount: 64,
      periodicity: 0.98,
      voiced: true,
      frequencyHz: 440,
      midiFloat: 69,
      nearestMidi: 69,
      centsFromNearest: 0,
      rms: 0.1,
      confidence: 0.98,
      brightness: 0.25,
      brightnessConfidence: 0.9,
      yinValue: 0.02,
      periodSamples: 109.09,
      reason: "detected",
    };

    expect(() => toFrameDiagnostic({ ...source, startSample: source.endSample })).toThrow(RangeError);
    expect(() => toFrameDiagnostic({ ...source, processedSampleCount: source.endSample + 1 })).toThrow(RangeError);
    expect(() => toFrameDiagnostic({ ...source, workletProcessCount: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow(RangeError);
    expect(() => toFrameDiagnostic({ ...source, timeSeconds: Number.NaN })).toThrow(RangeError);
    expect(() => toFrameDiagnostic({ ...source, sampleRate: 7_999 })).toThrow(RangeError);
    expect(() => toFrameDiagnostic({ ...source, periodicity: 1.001 })).toThrow(RangeError);
    expect(() => toFrameDiagnostic({ ...source, observationKind: "unvoiced" })).toThrow(RangeError);
    expect(toFrameDiagnostic({
      ...source,
      observationKind: "uncertain",
      voiced: false,
      frequencyHz: null,
      midiFloat: null,
      nearestMidi: null,
      centsFromNearest: null,
      brightness: null,
      brightnessConfidence: 0,
      reason: "below-confidence-threshold",
    })).toMatchObject({
      observationKind: "uncertain",
      voiced: false,
      frequencyHz: null,
      periodicity: 0.98,
    });
  });

  it("never retries a failed batch but reports its loss in the next batch", async () => {
    const calls: FetchCall[] = [];
    let invocation = 0;
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      invocation += 1;
      return invocation === 1
        ? Promise.reject(new Error("network unavailable"))
        : Promise.resolve({ ok: true, status: 204 } as Response);
    }) as typeof fetch;
    const timers = createManualTimers();
    const transport = new PitchDiagnosticTransport({
      sessionId: "contract-lossy",
      now: () => 10,
      fetcher,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      maximumBatchEvents: 1,
    });

    let continuedSynchronously = false;
    expect(() => {
      transport.record("range-loop", workflowEvent(1));
      continuedSynchronously = true;
    }).not.toThrow();
    expect(continuedSynchronously).toBe(true);
    await settleAsyncWork();

    await expect(transport.flush("range-loop")).resolves.toBeUndefined();
    timers.fireAll();
    await settleAsyncWork();
    expect(calls).toHaveLength(1);

    transport.record("range-loop", workflowEvent(2));
    await settleAsyncWork();
    expect(calls).toHaveLength(2);
    const batches = calls.map(batchFrom);
    expect(batches.map(({ sequence }) => sequence)).toEqual([0, 1]);
    expect(batches[0]!.events[0]).toMatchObject({ kind: "workflow", workflow: { attemptId: 1 } });
    expect(batches[1]!.events[0]).toMatchObject({ kind: "workflow", workflow: { attemptId: 2 } });
    expect(batches[1]!.droppedEvents).toBe(1);
  });

  it("counts an HTTP rejection as diagnostic loss instead of claiming delivery", async () => {
    const calls: FetchCall[] = [];
    let invocation = 0;
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      invocation += 1;
      return Promise.resolve(invocation === 1
        ? { ok: false, status: 429 } as Response
        : { ok: true, status: 204 } as Response);
    }) as typeof fetch;
    const transport = new PitchDiagnosticTransport({
      sessionId: "contract-http-loss",
      fetcher,
      maximumBatchEvents: 1,
    });

    transport.record("audio-input", workflowEvent(1));
    await settleAsyncWork();
    transport.record("audio-input", workflowEvent(2));
    await settleAsyncWork();

    expect(calls).toHaveLength(2);
    expect(batchFrom(calls[1]!).droppedEvents).toBe(1);
  });

  it("keeps one tracked timer when an event arrives during an in-flight send", async () => {
    const calls: FetchCall[] = [];
    const timers = createManualTimers();
    let finishFirstSend: (() => void) | undefined;
    const firstSend = new Promise<void>((resolve) => { finishFirstSend = resolve; });
    let invocation = 0;
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      invocation += 1;
      if (invocation === 1) {
        return firstSend.then(() => ({ ok: true, status: 204 } as Response));
      }
      return Promise.resolve({ ok: true, status: 204 } as Response);
    }) as typeof fetch;
    const transport = new PitchDiagnosticTransport({
      sessionId: "contract-inflight",
      fetcher,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      batchDelayMs: 250,
      maximumBatchEvents: 2,
    });

    transport.record("audio-input", workflowEvent(1));
    transport.record("audio-input", workflowEvent(2));
    expect(calls).toHaveLength(1);
    expect(timers.pending()).toEqual([]);

    transport.record("audio-input", workflowEvent(3));
    expect(timers.pending()).toEqual([{ id: 2, delayMs: 250 }]);

    finishFirstSend?.();
    await settleAsyncWork();
    expect(timers.pending()).toEqual([{ id: 2, delayMs: 250 }]);

    timers.fireNext();
    await settleAsyncWork();
    expect(calls).toHaveLength(2);
    expect(batchFrom(calls[1]!).events).toMatchObject([
      { kind: "workflow", workflow: { attemptId: 3 } },
    ]);
    expect(timers.pending()).toEqual([]);
  });
});
