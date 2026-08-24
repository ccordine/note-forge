import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  AudioKernel,
  type AudioPresentationScheduler,
} from "../apps/web/src/audio/audio-kernel";
import type {
  CapturedLevel,
  CapturedSamples,
  CaptureTransportEvent,
  MicrophoneCapture,
  MicrophoneInfo,
} from "../apps/web/src/audio/microphone";

const SAMPLE_RATE = 48_000;
const WINDOW = 4_096;
const HOP = 960;

class ManualScheduler implements AudioPresentationScheduler {
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

interface EmitOptions {
  readonly frequencyHz?: number;
  readonly amplitude?: number;
  readonly discontinuity?: boolean;
}

class FakeCapture {
  active = false;
  onSamples: ((window: CapturedSamples) => void) | null = null;
  onLevel: ((level: CapturedLevel) => void) | null = null;
  onTransport: ((event: CaptureTransportEvent) => void) | null = null;
  readonly info: MicrophoneInfo = {
    settings: {},
    constraints: {},
    sampleRate: SAMPLE_RATE,
    analysisWindowSize: WINDOW,
    analysisHopSize: HOP,
    meterWindowSize: 1_024,
    captureEpoch: 1,
  };

  async start(
    onSamples: (window: CapturedSamples) => void,
    _windowSize: number,
    onLevel: (level: CapturedLevel) => void,
    _onEnded: () => void,
    onTransport: (event: CaptureTransportEvent) => void,
  ): Promise<MicrophoneInfo> {
    this.active = true;
    this.onSamples = onSamples;
    this.onLevel = onLevel;
    this.onTransport = onTransport;
    return this.info;
  }

  isActive(): boolean { return this.active; }
  getInfo(): MicrophoneInfo | null { return this.active ? this.info : null; }
  getStream(): MediaStream | null { return null; }
  stop(): void { this.active = false; }

  emit(endSample: number, options: EmitOptions = {}): void {
    const startSample = endSample - WINDOW;
    const frequencyHz = options.frequencyHz ?? 130.8128;
    const amplitude = options.amplitude ?? 0.15;
    const samples = new Float32Array(WINDOW);
    for (let index = 0; index < WINDOW; index += 1) {
      samples[index] = amplitude * Math.sin(
        2 * Math.PI * frequencyHz * (startSample + index) / SAMPLE_RATE,
      );
    }
    this.onSamples?.({
      samples,
      capturedAt: (startSample + endSample) / (2 * SAMPLE_RATE),
      sampleRate: SAMPLE_RATE,
      startSample,
      endSample,
      captureEpoch: 1,
      continuityEpoch: 0,
      graphGeneration: 0,
      processCount: Math.floor(endSample / 128),
      processedSampleCount: endSample,
      discontinuity: options.discontinuity ?? false,
    });
  }

  emitLevel(capturedAt: number): void {
    this.onLevel?.({
      capturedAt,
      rms: 0.1,
      peak: 0.2,
      rmsDbfs: -20,
      peakDbfs: -14,
      dcOffset: 0,
      clippedSampleCount: 0,
      clipRatio: 0,
      sampleCount: 1_024,
    });
  }
}

describe("AudioKernel external realtime store", () => {
  it("consumes every 50 Hz observation while bounding stable React publication", async () => {
    const capture = new FakeCapture();
    const scheduler = new ManualScheduler();
    const kernel = new AudioKernel(
      capture as unknown as MicrophoneCapture,
      scheduler,
    );
    const transport = vi.fn();
    const pitch = vi.fn();
    const counters = vi.fn();
    const telemetry = vi.fn();
    const history = vi.fn();
    kernel.controller.subscribeTransport(transport);
    kernel.controller.subscribePitch(pitch);
    kernel.controller.subscribeCounters(counters);
    kernel.controller.subscribeTelemetry(telemetry);
    kernel.controller.subscribeHistory(history);
    const consumed = vi.fn();
    kernel.attach(Symbol("test"), () => ({ onFrame: consumed }));

    await kernel.controller.enable();
    const transportAfterEnable = transport.mock.calls.length;
    const pitchAfterEnable = pitch.mock.calls.length;
    const countersAfterEnable = counters.mock.calls.length;
    const telemetryAfterEnable = telemetry.mock.calls.length;
    const historyAfterEnable = history.mock.calls.length;
    const endSamples = Array.from(
      { length: 50 },
      (_, index) => WINDOW + index * HOP,
    );
    for (const [index, endSample] of endSamples.entries()) {
      const elapsedMs = index * 20;
      scheduler.currentTime = elapsedMs;
      capture.emit(endSample);
      capture.emitLevel(elapsedMs / 1_000);
      scheduler.frame(elapsedMs);
    }
    scheduler.frame(1_000);

    expect(transportAfterEnable).toBe(2);
    expect(transport).toHaveBeenCalledTimes(transportAfterEnable);
    expect(pitch.mock.calls.length - pitchAfterEnable).toBe(26);
    expect(counters.mock.calls.length - countersAfterEnable).toBe(25);
    expect(telemetry.mock.calls.length - telemetryAfterEnable).toBe(25);
    expect(history.mock.calls.length - historyAfterEnable).toBe(25);
    expect(consumed).toHaveBeenCalledTimes(50);
    expect(consumed.mock.calls.map(([observation]) => observation.endSample))
      .toEqual(endSamples);
    expect(kernel.controller.liveFrame?.nearestMidi).toBe(48);
    expect(kernel.controller.processedWindowCount).toBe(50);
    expect(kernel.controller.processedSampleCount).toBe(endSamples.at(-1));
    expect(kernel.controller.getPitchSnapshot().liveFrame?.endSample)
      .toBe(endSamples.at(-1));
    expect(Object.isFrozen(kernel.controller)).toBe(true);
    kernel.destroy();
  });

  it("publishes categorical pitch transitions with their first exact sample identity", async () => {
    const capture = new FakeCapture();
    const scheduler = new ManualScheduler();
    const kernel = new AudioKernel(
      capture as unknown as MicrophoneCapture,
      scheduler,
    );
    await kernel.controller.enable();
    const published: Array<{
      observationKind: string;
      nearestMidi: number | null;
      endSample: number;
      discontinuity: boolean;
    }> = [];
    kernel.controller.subscribePitch(() => {
      const frame = kernel.controller.getPitchSnapshot().liveFrame;
      if (frame) {
        published.push({
          observationKind: frame.observationKind,
          nearestMidi: frame.nearestMidi,
          endSample: frame.endSample,
          discontinuity: frame.discontinuity,
        });
      }
    });

    scheduler.currentTime = 0;
    capture.emit(WINDOW);
    scheduler.currentTime = 20;
    capture.emit(WINDOW + HOP);
    expect(kernel.controller.liveFrame?.endSample).toBe(WINDOW + HOP);
    expect(kernel.controller.getPitchSnapshot().liveFrame?.endSample).toBe(WINDOW);

    scheduler.currentTime = 40;
    capture.emit(WINDOW + HOP * 2, { frequencyHz: 146.8324 });
    scheduler.currentTime = 60;
    capture.emit(WINDOW + HOP * 3, { frequencyHz: 146.8324 });
    expect(kernel.controller.liveFrame?.endSample).toBe(WINDOW + HOP * 3);
    expect(kernel.controller.getPitchSnapshot().liveFrame?.endSample)
      .toBe(WINDOW + HOP * 2);

    scheduler.currentTime = 80;
    capture.emit(WINDOW + HOP * 4, { amplitude: 0 });
    scheduler.currentTime = 100;
    capture.emit(WINDOW + HOP * 5, { amplitude: 0, discontinuity: true });

    expect(published).toEqual([
      { observationKind: "voiced", nearestMidi: 48, endSample: WINDOW, discontinuity: false },
      { observationKind: "voiced", nearestMidi: 50, endSample: WINDOW + HOP * 2, discontinuity: false },
      { observationKind: "unvoiced", nearestMidi: null, endSample: WINDOW + HOP * 4, discontinuity: false },
      { observationKind: "unvoiced", nearestMidi: null, endSample: WINDOW + HOP * 5, discontinuity: true },
    ]);
    kernel.destroy();
  });

  it("keeps circular history snapshots cached until new PCM is explicitly read", async () => {
    const capture = new FakeCapture();
    const scheduler = new ManualScheduler();
    const kernel = new AudioKernel(
      capture as unknown as MicrophoneCapture,
      scheduler,
    );
    await kernel.controller.enable();
    capture.emit(WINDOW);
    const first = kernel.controller.getHistorySnapshot();
    const unchanged = kernel.controller.getHistorySnapshot();
    expect(unchanged).toBe(first);
    expect(first.frames).toHaveLength(1);
    expect(Object.isFrozen(first.frames)).toBe(true);
    capture.emit(WINDOW + HOP);
    const advanced = kernel.controller.getHistorySnapshot();
    expect(advanced).not.toBe(first);
    expect(advanced.frames).toHaveLength(2);
    kernel.destroy();
  });

  it("creates opt-in recorders inside the audio owner without exposing its stream", async () => {
    const capture = new FakeCapture();
    const stream = { active: true } as MediaStream;
    capture.getStream = () => stream;
    class FakeMediaRecorder {
      constructor(readonly source: MediaStream) {}
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const kernel = new AudioKernel(capture as unknown as MicrophoneCapture);

    expect(() => kernel.controller.createRecorder()).toThrow(/must be running/i);
    await kernel.controller.enable();
    const recorder = kernel.controller.createRecorder() as unknown as FakeMediaRecorder;
    expect(recorder.source).toBe(stream);
    expect("getStream" in kernel.controller).toBe(false);

    kernel.destroy();
    vi.unstubAllGlobals();
  });
});

describe("AudioKernel architecture guard", () => {
  const kernel = readFileSync(new URL(
    "../apps/web/src/audio/audio-kernel.ts",
    import.meta.url,
  ), "utf8");
  const bridge = readFileSync(new URL(
    "../apps/web/src/audio/use-audio-input.ts",
    import.meta.url,
  ), "utf8");
  const publication = readFileSync(new URL(
    "../apps/web/src/audio/audio-react-publication.ts",
    import.meta.url,
  ), "utf8");
  const circularBuffer = readFileSync(new URL(
    "../apps/web/src/audio/circular-buffer.ts",
    import.meta.url,
  ), "utf8");

  it("keeps detector data out of React state and exposes granular subscriptions", () => {
    expect(circularBuffer).toContain("class CircularBuffer");
    expect(kernel).toContain("subscribePitch");
    expect(kernel).toContain("subscribeTransport");
    expect(kernel).toContain("subscribeHistory");
    expect(bridge).toContain("useSyncExternalStore");
    expect(bridge).not.toMatch(/\buseState\s*\(/);
    expect(bridge).not.toMatch(/setFrames|setLiveFrame|setProcessedSampleCount|setTelemetryHistory/);
    expect(kernel).not.toMatch(/get frames\(\)/);
    expect(kernel).not.toMatch(/get telemetryHistory\(\)/);
    expect(kernel).not.toMatch(/readonly getStream\s*:/);
  });

  it("separates immediate detector authority from bounded React publication", () => {
    expect(publication).toContain("AUDIO_REACT_MAXIMUM_PRESENTATION_HZ = 30");
    expect(publication).toContain("publishPitchTransition");
    expect(kernel).toContain("observationRequiresImmediatePublication");
    expect(kernel).toContain("options.onFrame?.(observation)");
    const recordObservation = kernel.match(
      /private recordObservation[\s\S]*?\n  readonly enable/,
    )?.[0] ?? "";
    expect(recordObservation).toContain("reactPublication.schedulePitch()");
    expect(recordObservation).not.toMatch(
      /notify\(this\.(?:pitch|counter|telemetry|history)Listeners\)/,
    );
  });
});
