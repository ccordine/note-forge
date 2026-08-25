import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { InputTelemetry } from "../apps/web/src/audio/audio-kernel";
import {
  DIAGNOSTIC_FLOW,
  DIAGNOSTIC_FLOWS,
  LIVE_DIAGNOSTIC_SIGNAL_BOUNDS,
  PITCH_DIAGNOSTIC_VERSION,
  PitchDiagnosticTransport,
  toDiagnosticToken,
  toFrameDiagnostic,
  toInputDiagnostic,
  type DiagnosticBatch,
  type FrameDiagnosticSource,
} from "../apps/web/src/diagnostics/pitch-diagnostics";

type TransportEvent = Parameters<PitchDiagnosticTransport["record"]>[0];
interface FetchCall { input: RequestInfo | URL; init?: RequestInit }

function createClock(initial = 1_000) {
  let value = initial;
  return { now: () => value, set: (next: number) => { value = next; } };
}

function createManualTimers() {
  let sequence = 0;
  const callbacks = new Map<number, { callback: () => void; delayMs: number }>();
  const cleared: number[] = [];
  return {
    cleared,
    setTimer(callback: () => void, delayMs: number) {
      sequence += 1;
      callbacks.set(sequence, { callback, delayMs });
      return sequence;
    },
    clearTimer(timer: number) {
      cleared.push(timer);
      callbacks.delete(timer);
    },
    fireNext() {
      const entry = callbacks.entries().next().value as [number, { callback: () => void }] | undefined;
      if (!entry) throw new Error("No diagnostic timer is pending.");
      callbacks.delete(entry[0]);
      entry[1].callback();
    },
    pending() {
      return [...callbacks].map(([id, value]) => ({ id, delayMs: value.delayMs }));
    },
  };
}

function successfulFetcher(calls: FetchCall[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return { ok: true, status: 204 } as Response;
  }) as typeof fetch;
}

function batchFrom(call: FetchCall): DiagnosticBatch {
  if (typeof call.init?.body !== "string") throw new Error("Expected a serialized diagnostic body.");
  return JSON.parse(call.init.body) as DiagnosticBatch;
}

function microphoneEvent(state: "off" | "stream-ended" = "off"): TransportEvent {
  return { kind: "microphone-state", microphone: { state } };
}

function voicedFrame(): FrameDiagnosticSource {
  return {
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
    periodSamples: 366.928123,
    yinValue: 0.01234567,
    reason: "detected",
  };
}

function pitchEvent(): TransportEvent {
  return {
    kind: "pitch-frame",
    pitch: { frame: toFrameDiagnostic(voicedFrame()), processingMs: 2.375 },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("derived pitch diagnostic transport", () => {
  it("has one sensor-owned wire flow and no workflow diagnostic model", async () => {
    expect(PITCH_DIAGNOSTIC_VERSION).toBe(4);
    expect(DIAGNOSTIC_FLOW).toBe("audio-input");
    expect(DIAGNOSTIC_FLOWS).toEqual(["audio-input"]);

    const [kernel, diagnosticSource] = await Promise.all([
      readFile(new URL("../apps/web/src/audio/audio-kernel.ts", import.meta.url), "utf8"),
      readFile(new URL("../apps/web/src/diagnostics/pitch-diagnostics.ts", import.meta.url), "utf8"),
    ]);
    for (const forbidden of [
      "AudioInputDiagnosticContext",
      "targetMidi",
      "toleranceCents",
      "requiredHoldMs",
      "resetReason",
      "TrackingDiagnostic",
    ]) expect(kernel).not.toContain(forbidden);
    expect(diagnosticSource).not.toMatch(/TrackingDiagnostic|WorkflowDiagnostic|kind:\s*"workflow"/u);
  });

  it("is off by default and sends only after explicit opt-in", async () => {
    const calls: FetchCall[] = [];
    const timers = createManualTimers();
    const transport = new PitchDiagnosticTransport({
      sessionId: "explicit-consent",
      fetcher: successfulFetcher(calls),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      maximumBatchEvents: 1,
    });

    expect(transport.isEnabled()).toBe(false);
    transport.record(pitchEvent());
    await transport.flush();
    expect(calls).toHaveLength(0);
    expect(timers.pending()).toEqual([]);

    transport.setEnabled(true);
    expect(transport.isEnabled()).toBe(true);
    transport.record(pitchEvent());
    await settle();
    expect(calls).toHaveLength(1);
    expect(batchFrom(calls[0]!)).toMatchObject({
      version: 4,
      flow: "audio-input",
      events: [{ kind: "pitch-frame" }],
    });
  });

  it("clears queued events immediately when the user opts out", async () => {
    const calls: FetchCall[] = [];
    const timers = createManualTimers();
    const transport = new PitchDiagnosticTransport({
      enabled: true,
      sessionId: "explicit-disable",
      fetcher: successfulFetcher(calls),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      batchDelayMs: 500,
    });
    transport.record(microphoneEvent());
    expect(timers.pending()).toHaveLength(1);
    transport.setEnabled(false);
    expect(timers.pending()).toEqual([]);
    await transport.flush();
    expect(calls).toHaveLength(0);
  });

  it("flushes explicitly enabled events in insertion order at the batch boundary", async () => {
    const calls: FetchCall[] = [];
    const clock = createClock();
    const timers = createManualTimers();
    const transport = new PitchDiagnosticTransport({
      enabled: true,
      endpoint: "/diagnostic-test",
      sessionId: "contract-batch",
      now: clock.now,
      fetcher: successfulFetcher(calls),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      maximumBatchEvents: 3,
    });
    clock.set(1_005); transport.record(microphoneEvent("off"));
    clock.set(1_010); transport.record(microphoneEvent("stream-ended"));
    clock.set(1_015); transport.record(pitchEvent());
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe("/diagnostic-test");
    const batch = batchFrom(calls[0]!);
    expect(batch.events.map((event) => event.elapsedMs)).toEqual([5, 10, 15]);
    expect(batch.events.map((event) => event.kind)).toEqual([
      "microphone-state", "microphone-state", "pitch-frame",
    ]);
  });

  it("flushes a partial batch when its timer fires", async () => {
    const calls: FetchCall[] = [];
    const timers = createManualTimers();
    const transport = new PitchDiagnosticTransport({
      enabled: true,
      sessionId: "contract-timer",
      fetcher: successfulFetcher(calls),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      batchDelayMs: 750,
    });
    transport.record(microphoneEvent());
    expect(timers.pending()).toEqual([{ id: 1, delayMs: 750 }]);
    timers.fireNext();
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("bounds the optional queue without affecting realtime consumers", async () => {
    const calls: FetchCall[] = [];
    const timers = createManualTimers();
    const transport = new PitchDiagnosticTransport({
      enabled: true,
      sessionId: "contract-bounded",
      fetcher: successfulFetcher(calls),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      maximumBatchEvents: 10,
      maximumBufferedEvents: 3,
    });
    for (let index = 0; index < 5; index += 1) transport.record(microphoneEvent());
    await transport.flush();
    expect(batchFrom(calls[0]!).droppedEvents).toBe(2);
    expect(batchFrom(calls[0]!).events).toHaveLength(3);
  });

  it("serializes only bounded sensor facts, never PCM, identity, or activity semantics", async () => {
    const calls: FetchCall[] = [];
    const transport = new PitchDiagnosticTransport({
      enabled: true,
      sessionId: "contract-derived",
      fetcher: successfulFetcher(calls),
      maximumBatchEvents: 1,
    });
    const source = voicedFrame() as FrameDiagnosticSource & {
      pcm: Float32Array; samples: Float32Array; deviceId: string; targetMidi: number;
    };
    source.pcm = new Float32Array([0.1]);
    source.samples = new Float32Array([0.2]);
    source.deviceId = "secret-device";
    source.targetMidi = 48;
    const telemetry: InputTelemetry & { pcm: Float32Array; label: string } = {
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
      pcm: new Float32Array([0.3]),
      label: "secret microphone",
    };
    transport.record({
      kind: "pitch-frame",
      pitch: {
        frame: toFrameDiagnostic(source),
        input: toInputDiagnostic(telemetry),
        processingMs: 2.375,
      },
    });
    await settle();
    const serialized = calls[0]!.init!.body as string;
    for (const forbidden of [
      "pcm", "samples", "deviceId", "label", "targetMidi", "toleranceCents",
      "phase", "holdMs", "tracking", "workflow", "secret-device", "secret microphone",
    ]) expect(serialized).not.toContain(forbidden);
  });

  it("validates exact observation identity and the canonical detector boundaries", () => {
    const source = voicedFrame();
    expect(() => toFrameDiagnostic({ ...source, startSample: source.endSample })).toThrow(RangeError);
    expect(() => toFrameDiagnostic({ ...source, processedSampleCount: source.endSample + 1 }))
      .toThrow(RangeError);
    expect(() => toFrameDiagnostic({ ...source, workletProcessCount: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow(RangeError);
    expect(() => toFrameDiagnostic({ ...source, sampleRate: 2_400 })).toThrow(RangeError);

    const atFrequency = (frequencyHz: number): FrameDiagnosticSource => {
      const midiFloat = 69 + 12 * Math.log2(frequencyHz / 440);
      const nearestMidi = Math.floor(midiFloat + 0.5);
      return {
        ...source,
        frequencyHz,
        midiFloat,
        nearestMidi,
        centsFromNearest: (midiFloat - nearestMidi) * 100,
        periodSamples: source.sampleRate / frequencyHz,
      };
    };
    for (const frequency of [45, 1_200]) expect(toFrameDiagnostic(atFrequency(frequency)).frequencyHz)
      .toBeCloseTo(frequency, 3);
    expect(() => toFrameDiagnostic(atFrequency(
      LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.detectorFrequencyHz.minimum - 0.001,
    ))).toThrow(RangeError);
    expect(() => toFrameDiagnostic(atFrequency(
      LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.detectorFrequencyHz.maximum + 0.001,
    ))).toThrow(RangeError);
  });

  it("preserves detector note identity on both sides of a rounded half-semitone", () => {
    const atMidi = (midiFloat: number, nearestMidi: number): FrameDiagnosticSource => ({
      ...voicedFrame(),
      frequencyHz: 440 * 2 ** ((midiFloat - 69) / 12),
      midiFloat,
      nearestMidi,
      centsFromNearest: (midiFloat - nearestMidi) * 100,
      periodSamples: 48_000 / (440 * 2 ** ((midiFloat - 69) / 12)),
    });
    expect(toFrameDiagnostic(atMidi(48.49996, 48))).toMatchObject({
      midiFloat: 48.5,
      nearestMidi: 48,
      centsFromNearest: 49.996,
    });
    expect(toFrameDiagnostic(atMidi(48.50004, 49))).toMatchObject({
      midiFloat: 48.5,
      nearestMidi: 49,
      centsFromNearest: -49.996,
    });
  });

  it("accounts for failed delivery without retrying the rejected batch", async () => {
    const calls: FetchCall[] = [];
    let invocation = 0;
    const transport = new PitchDiagnosticTransport({
      enabled: true,
      sessionId: "contract-lossy",
      maximumBatchEvents: 1,
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        invocation += 1;
        return invocation === 1
          ? Promise.reject(new Error("offline"))
          : { ok: true, status: 204 } as Response;
      }) as typeof fetch,
    });
    transport.record(microphoneEvent());
    await settle();
    transport.record(microphoneEvent("stream-ended"));
    await settle();
    expect(calls).toHaveLength(2);
    expect(batchFrom(calls[1]!).droppedEvents).toBe(1);
  });

  it("normalizes browser error names into server-accepted tokens", () => {
    expect(toDiagnosticToken("NotAllowedError")).toBe("not-allowed-error");
    expect(toDiagnosticToken("  Media device / gone  ")).toBe("media-device-gone");
    expect(toDiagnosticToken("***")).toBe("unknown");
  });
});
