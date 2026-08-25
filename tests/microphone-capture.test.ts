import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ensureAudioReady } = vi.hoisted(() => ({
  ensureAudioReady: vi.fn(),
}));

vi.mock("../apps/web/src/audio/audio-context", () => ({
  ensureAudioReady,
}));

import {
  MicrophoneCapture,
  analysisWindowSizes,
} from "../apps/web/src/audio/microphone";

function captureHarness() {
  const track = {
    label: "Selected microphone",
    readyState: "live",
    enabled: true,
    addEventListener: vi.fn(),
    getSettings: vi.fn(() => ({ deviceId: "usb-interface" })),
    getConstraints: vi.fn(() => ({})),
    stop: vi.fn(),
  };
  const stream = {
    active: true,
    getAudioTracks: vi.fn(() => [track]),
    getTracks: vi.fn(() => [track]),
  };
  const source = {
    connect: vi.fn((target: unknown) => target),
    disconnect: vi.fn(),
  };
  const gain = {
    gain: { value: 1 },
    connect: vi.fn((target: unknown) => target),
    disconnect: vi.fn(),
  };
  const context = {
    state: "running",
    sampleRate: 48_000,
    destination: {},
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
    resume: vi.fn(async () => {
      context.state = "running";
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { context, stream, track };
}

class FakeAudioWorkletNode {
  static readonly options: AudioWorkletNodeOptions[] = [];
  static readonly instances: FakeAudioWorkletNode[] = [];
  readonly port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  readonly connect = vi.fn((target: unknown) => target);
  readonly disconnect = vi.fn();

  constructor(
    _context: BaseAudioContext,
    _name: string,
    options?: AudioWorkletNodeOptions,
  ) {
    if (options) FakeAudioWorkletNode.options.push(options);
    FakeAudioWorkletNode.instances.push(this);
  }
}

describe("canonical microphone capture", () => {
  beforeEach(() => {
    FakeAudioWorkletNode.options.length = 0;
    FakeAudioWorkletNode.instances.length = 0;
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("always requests the single canonical raw-input constraint set", async () => {
    const { context, stream } = captureHarness();
    const getUserMedia = vi.fn(async () => stream);
    ensureAudioReady.mockResolvedValue(context);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const capture = new MicrophoneCapture();

    await capture.start(() => undefined);

    expect(FakeAudioWorkletNode.options.at(-1)).toMatchObject({
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
      },
    });
    capture.stop();
  });

  it.each([
    { sampleRate: 44_100, windowSize: 4_096, hopSize: 882, meterSize: 1_024 },
    { sampleRate: 48_000, windowSize: 4_096, hopSize: 960, meterSize: 1_024 },
    { sampleRate: 96_000, windowSize: 8_192, hopSize: 1_920, meterSize: 2_048 },
    { sampleRate: 192_000, windowSize: 16_384, hopSize: 3_840, meterSize: 4_096 },
  ])(
    "preserves window depth and a 20 ms hop at $sampleRate Hz",
    ({ sampleRate, windowSize, hopSize, meterSize }) => {
      expect(analysisWindowSizes(sampleRate)).toEqual({ windowSize, hopSize, meterSize });
    },
  );

  it("keeps 100 deterministic sample-rate boundaries power-of-two, time-stable, and 45 Hz capable", () => {
    const referenceBufferSeconds = 4_096 / 48_000;
    const referenceMeterSeconds = 1_024 / 48_000;
    const maximumPowerOfTwoDurationRatio = Math.SQRT2 + 1e-12;

    for (let index = 0; index < 100; index += 1) {
      const sampleRate = 8_000 + index * 3_799;
      const windows = analysisWindowSizes(sampleRate);
      const bufferDurationRatio = windows.windowSize / sampleRate / referenceBufferSeconds;
      const meterDurationRatio = windows.meterSize / sampleRate / referenceMeterSeconds;

      expect(Number.isInteger(Math.log2(windows.windowSize))).toBe(true);
      expect(Number.isInteger(Math.log2(windows.meterSize))).toBe(true);
      expect(windows.hopSize / sampleRate).toBeCloseTo(0.02, 4);
      expect(windows.hopSize).toBeLessThan(windows.windowSize);
      expect(bufferDurationRatio).toBeGreaterThanOrEqual(1 / maximumPowerOfTwoDurationRatio);
      expect(bufferDurationRatio).toBeLessThanOrEqual(maximumPowerOfTwoDurationRatio);
      expect(meterDurationRatio).toBeGreaterThanOrEqual(1 / maximumPowerOfTwoDurationRatio);
      expect(meterDurationRatio).toBeLessThanOrEqual(maximumPowerOfTwoDurationRatio);
      expect(windows.windowSize - Math.ceil(sampleRate / 45) - 1).toBeGreaterThanOrEqual(2);
    }
  });

  it("passes sample-rate-scaled window sizes to the worklet", async () => {
    const { context, stream } = captureHarness();
    context.sampleRate = 192_000;
    const getUserMedia = vi.fn(async () => stream);
    ensureAudioReady.mockResolvedValue(context);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const capture = new MicrophoneCapture();

    await capture.start(() => undefined);

    expect(FakeAudioWorkletNode.options.at(-1)?.processorOptions).toEqual({
      windowSize: 16_384,
      hopSize: 3_840,
      meterSize: 4_096,
      captureEpoch: 1,
      continuityEpoch: 0,
      graphGeneration: 0,
      processCount: 0,
      processedSampleCount: 0,
    });
    capture.stop();
  });

  it("delivers every worklet sample and level message while active", async () => {
    const { context, stream } = captureHarness();
    const getUserMedia = vi.fn(async () => stream);
    const onSamples = vi.fn();
    const onLevel = vi.fn();
    ensureAudioReady.mockResolvedValue(context);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const capture = new MicrophoneCapture();

    await capture.start(onSamples, 4_096, onLevel);
    const handler = FakeAudioWorkletNode.instances[0]?.port.onmessage;
    const samples = new Float32Array([0.25, -0.5]);
    const level = {
      type: "level" as const,
      capturedAt: 124,
      rms: 0.3,
      peak: 0.5,
      rmsDbfs: -10.46,
      peakDbfs: -6.02,
      dcOffset: -0.125,
      clippedSampleCount: 0,
      clipRatio: 0,
      sampleCount: 2,
    };

    const sampleMessage = {
      type: "samples" as const,
      samples,
      capturedAt: 3 / 48_000,
      startSample: 2,
      endSample: 4,
      captureEpoch: 1,
      continuityEpoch: 0,
      graphGeneration: 0,
      processCount: 7,
      processedSampleCount: 4,
      discontinuity: true,
    };
    handler?.({ data: sampleMessage } as MessageEvent);
    handler?.({ data: level } as MessageEvent);

    expect(onSamples).toHaveBeenCalledOnce();
    expect(onSamples).toHaveBeenCalledWith(expect.objectContaining({
      samples,
      capturedAt: sampleMessage.capturedAt,
      startSample: 2,
      endSample: 4,
      captureEpoch: 1,
      processCount: 7,
      processedSampleCount: 4,
      discontinuity: true,
      sampleRate: 48_000,
    }));
    expect(onLevel).toHaveBeenCalledOnce();
    expect(onLevel).toHaveBeenCalledWith(level);
    capture.stop();
  });

  it("owns stream teardown and makes repeated stops harmless", async () => {
    const { context, stream, track } = captureHarness();
    const getUserMedia = vi.fn(async () => stream);
    ensureAudioReady.mockResolvedValue(context);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const capture = new MicrophoneCapture();

    expect(capture.isActive()).toBe(false);
    await capture.start(() => undefined);
    expect(capture.getStream()).toBe(stream);
    expect(capture.isActive()).toBe(true);

    capture.stop();
    capture.stop();

    expect(track.stop).toHaveBeenCalledOnce();
    expect(FakeAudioWorkletNode.instances[0]?.port.close).toHaveBeenCalledOnce();
    expect(capture.getStream()).toBeNull();
    expect(capture.isActive()).toBe(false);
  });

  it("treats repeated starts as idempotent access to one persistent stream", async () => {
    const { context, stream, track } = captureHarness();
    const getUserMedia = vi.fn(async () => stream);
    ensureAudioReady.mockResolvedValue(context);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const capture = new MicrophoneCapture();

    const first = await capture.start(() => undefined);
    const second = await capture.start(() => undefined);

    expect(second).toBe(first);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(context.audioWorklet.addModule).toHaveBeenCalledOnce();
    expect(FakeAudioWorkletNode.instances).toHaveLength(1);
    expect(track.stop).not.toHaveBeenCalled();
    capture.stop();
  });

  it("repairs a missing PCM heartbeat by replacing only the processing graph", async () => {
    vi.useFakeTimers();
    try {
      const { context, stream, track } = captureHarness();
      const getUserMedia = vi.fn(async () => stream);
      const transportEvents = vi.fn();
      const onSamples = vi.fn();
      ensureAudioReady.mockResolvedValue(context);
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
      const capture = new MicrophoneCapture();
      await capture.start(
        onSamples,
        4_096,
        undefined,
        undefined,
        transportEvents,
      );
      const firstHandler = FakeAudioWorkletNode.instances[0]!.port.onmessage;
      const firstMessage = {
        type: "samples",
        samples: new Float32Array(4_096),
        capturedAt: 2_048 / 48_000,
        startSample: 0,
        endSample: 4_096,
        captureEpoch: 1,
        continuityEpoch: 0,
        graphGeneration: 0,
        processCount: 32,
        processedSampleCount: 4_096,
        discontinuity: true,
      } as const;
      firstHandler?.({ data: firstMessage } as MessageEvent);

      await vi.advanceTimersByTimeAsync(1_000);
      // Re-delivery is not new PCM and therefore cannot keep the heartbeat
      // alive or create another authoritative sample window.
      firstHandler?.({ data: firstMessage } as MessageEvent);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(onSamples).toHaveBeenCalledOnce();
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(track.stop).not.toHaveBeenCalled();
      expect(FakeAudioWorkletNode.instances).toHaveLength(2);
      expect(FakeAudioWorkletNode.options[1]?.processorOptions).toMatchObject({
        captureEpoch: 1,
        continuityEpoch: 1,
        graphGeneration: 1,
        processCount: 32,
        processedSampleCount: 4_096,
      });
      expect(transportEvents).toHaveBeenCalledWith(expect.objectContaining({
        kind: "recovering",
        reason: "pcm-heartbeat",
      }));
      capture.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes a suspended context internally and marks a discontinuity", async () => {
    const { context, stream, track } = captureHarness();
    const getUserMedia = vi.fn(async () => stream);
    const transportEvents = vi.fn();
    ensureAudioReady.mockResolvedValue(context);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const capture = new MicrophoneCapture();
    await capture.start(
      () => undefined,
      4_096,
      undefined,
      undefined,
      transportEvents,
    );

    context.state = "suspended";
    const stateChange = context.addEventListener.mock.calls.find(
      ([name]) => name === "statechange",
    )?.[1] as EventListener | undefined;
    stateChange?.(new Event("statechange"));
    await Promise.resolve();
    await Promise.resolve();

    expect(context.resume).toHaveBeenCalledOnce();
    expect(FakeAudioWorkletNode.instances).toHaveLength(1);
    expect(FakeAudioWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: "discontinuity",
      continuityEpoch: 1,
    });
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
    capture.stop();
  });

  it("stops an acquired stream if worklet setup fails", async () => {
    const { context, stream, track } = captureHarness();
    context.audioWorklet.addModule.mockRejectedValueOnce(new Error("worklet failed"));
    const getUserMedia = vi.fn(async () => stream);
    ensureAudioReady.mockResolvedValue(context);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const capture = new MicrophoneCapture();

    await expect(capture.start(() => undefined)).rejects.toThrow("worklet failed");

    expect(track.stop).toHaveBeenCalledOnce();
    expect(capture.getStream()).toBeNull();
    expect(capture.isActive()).toBe(false);
  });

  it("rejects a stream that has no live audio track", async () => {
    const { context, stream } = captureHarness();
    stream.getAudioTracks.mockReturnValue([]);
    const getUserMedia = vi.fn(async () => stream);
    ensureAudioReady.mockResolvedValue(context);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const capture = new MicrophoneCapture();

    await expect(capture.start(() => undefined)).rejects.toThrow(
      "did not provide a live audio track",
    );

    expect(context.audioWorklet.addModule).not.toHaveBeenCalled();
    expect(capture.getStream()).toBeNull();
    expect(capture.isActive()).toBe(false);
  });

  it("rejects a microphone track that ends while the worklet loads", async () => {
    const { context, stream, track } = captureHarness();
    context.audioWorklet.addModule.mockImplementationOnce(async () => {
      track.readyState = "ended";
      stream.active = false;
    });
    const getUserMedia = vi.fn(async () => stream);
    ensureAudioReady.mockResolvedValue(context);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const capture = new MicrophoneCapture();

    await expect(capture.start(() => undefined)).rejects.toThrow(
      "ended during setup",
    );

    expect(track.stop).toHaveBeenCalledOnce();
    expect(capture.getStream()).toBeNull();
    expect(capture.isActive()).toBe(false);
  });

  it("ignores a previous stream's ended callback after teardown", async () => {
    const { context, stream, track } = captureHarness();
    const getUserMedia = vi.fn(async () => stream);
    const onEnded = vi.fn();
    ensureAudioReady.mockResolvedValue(context);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const capture = new MicrophoneCapture();

    await capture.start(() => undefined, 4_096, undefined, onEnded);
    const ended = track.addEventListener.mock.calls[0]?.[1] as EventListener | undefined;
    ended?.(new Event("ended"));
    expect(onEnded).toHaveBeenCalledOnce();

    capture.stop();
    ended?.(new Event("ended"));
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it("rejects unsupported environments before creating audio state", async () => {
    vi.stubGlobal("navigator", {});
    const capture = new MicrophoneCapture();

    await expect(capture.start(() => undefined)).rejects.toThrow(
      "Microphone capture is not supported",
    );
    expect(ensureAudioReady).not.toHaveBeenCalled();
  });

  it("validates window scaling inputs before allocating worklet buffers", () => {
    expect(() => analysisWindowSizes(0)).toThrow(RangeError);
    expect(() => analysisWindowSizes(Number.NaN)).toThrow(RangeError);
    expect(() => analysisWindowSizes(2_400)).toThrow(/canonical detector range/);
    expect(() => analysisWindowSizes(768_001)).toThrow(/no greater than 768000/);
    expect(() => analysisWindowSizes(2_401)).not.toThrow();
    expect(() => analysisWindowSizes(20_000_000)).toThrow(/no greater than/);
    expect(() => analysisWindowSizes(48_000, 0)).toThrow(RangeError);
    expect(() => analysisWindowSizes(48_000, 4_096, 1.5)).toThrow(RangeError);
  });
});
