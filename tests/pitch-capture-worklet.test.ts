import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface PostedMessage {
  message: Record<string, unknown>;
  transfers: ArrayBuffer[];
}

interface WorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (message: Record<string, unknown>, transfers?: ArrayBuffer[]) => void;
}

interface WorkletProcessor {
  port: WorkletPort;
  process: (inputs: Float32Array[][]) => boolean;
}

function workletHarness(processorOptions?: Record<string, unknown>) {
  const source = readFileSync(new URL("../apps/web/src/audio/pitch-capture-worklet.js", import.meta.url), "utf8");
  const posted: PostedMessage[] = [];
  let processorConstructor: (new (options?: unknown) => WorkletProcessor) | null = null;
  const sandbox = {
    AudioWorkletProcessor: class {
      port: WorkletPort = {
        onmessage: null,
        postMessage: (message: Record<string, unknown>, transfers: ArrayBuffer[] = []) => {
          posted.push({ message, transfers });
        },
      };
    },
    Float32Array,
    Math,
    Number,
    RangeError,
    sampleRate: 48_000,
    registerProcessor: (name: string, constructor: new (options?: unknown) => WorkletProcessor) => {
      if (name !== "pitch-capture") throw new Error(`Unexpected processor name ${name}.`);
      processorConstructor = constructor;
    },
  };
  runInNewContext(source, sandbox, { filename: "pitch-capture-worklet.js" });
  if (!processorConstructor) throw new Error("The shipped worklet did not register pitch-capture.");
  const Processor = processorConstructor as new (options?: unknown) => WorkletProcessor;
  const processor = new Processor(processorOptions === undefined ? {} : { processorOptions });
  const send = (data: unknown) => processor.port.onmessage?.({ data });
  return { posted, processor, sandbox, send };
}

function sampleMessages(posted: PostedMessage[]): PostedMessage[] {
  return posted.filter(({ message }) => message.type === "samples");
}

describe("shipped pitch-capture AudioWorklet", () => {
  it("emits monotonic overlapping windows with exact epochs, counters, and sample coordinates", () => {
    const { posted, processor } = workletHarness({
      windowSize: 8,
      hopSize: 2,
      meterSize: 4,
      captureEpoch: 7,
      continuityEpoch: 3,
      graphGeneration: 5,
      processCount: 10,
      processedSampleCount: 100,
    });

    expect(processor.process([[new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])]])).toBe(true);
    expect(processor.process([[new Float32Array([9, 10])]])).toBe(true);
    expect(processor.process([[new Float32Array([11, 12, 13, 14])]])).toBe(true);

    const samples = sampleMessages(posted);
    expect(samples).toHaveLength(4);
    expect(samples.map(({ message }) => Array.from(message.samples as Float32Array))).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8],
      [3, 4, 5, 6, 7, 8, 9, 10],
      [5, 6, 7, 8, 9, 10, 11, 12],
      [7, 8, 9, 10, 11, 12, 13, 14],
    ]);
    expect(samples.map(({ message }) => ({
      startSample: message.startSample,
      endSample: message.endSample,
      processCount: message.processCount,
      processedSampleCount: message.processedSampleCount,
      discontinuity: message.discontinuity,
    }))).toEqual([
      { startSample: 100, endSample: 108, processCount: 11, processedSampleCount: 108, discontinuity: true },
      { startSample: 102, endSample: 110, processCount: 12, processedSampleCount: 110, discontinuity: false },
      { startSample: 104, endSample: 112, processCount: 13, processedSampleCount: 112, discontinuity: false },
      { startSample: 106, endSample: 114, processCount: 13, processedSampleCount: 114, discontinuity: false },
    ]);
    expect(samples[0]!.message).toMatchObject({
      captureEpoch: 7,
      continuityEpoch: 3,
      graphGeneration: 5,
      capturedAt: 104 / 48_000,
    });
    expect(samples[1]!.message.capturedAt).toBeCloseTo(106 / 48_000, 12);
    expect(new Set(samples.map(({ message }) => message.samples))).toHaveProperty("size", 4);
    for (const sample of samples) {
      expect(sample.transfers).toEqual([(sample.message.samples as Float32Array).buffer]);
    }
  });

  it("computes independent meter telemetry from every consumed mono sample", () => {
    const { posted, processor } = workletHarness({ windowSize: 8, hopSize: 2, meterSize: 4 });
    processor.process([[new Float32Array([0.5, -0.5, 1, -1, 0.25, -0.25, 0.75, -0.75])]]);

    const levels = posted.filter(({ message }) => message.type === "level").map(({ message }) => message);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toMatchObject({
      peak: 1,
      dcOffset: 0,
      clippedSampleCount: 2,
      clipRatio: 0.5,
      sampleCount: 4,
    });
    expect(levels[0]!.rms).toBeCloseTo(Math.sqrt(0.625), 10);
    expect(levels[0]!.rmsDbfs).toBeCloseTo(20 * Math.log10(Math.sqrt(0.625)), 10);
    expect(levels[0]!.peakDbfs).toBe(0);
    expect(levels[0]!.capturedAt).toBeCloseTo(2 / 48_000, 12);
    expect(levels[1]).toMatchObject({
      peak: 0.75,
      dcOffset: 0,
      clippedSampleCount: 0,
      clipRatio: 0,
      sampleCount: 4,
    });
    expect(levels[1]!.capturedAt).toBeCloseTo(6 / 48_000, 12);
  });

  it("keeps partial ring state across render quanta and counts missing-input process calls", () => {
    const { posted, processor } = workletHarness({ windowSize: 8, hopSize: 2, meterSize: 4 });
    processor.process([[new Float32Array([1, 2, 3])]]);
    processor.process([]);
    processor.process([[new Float32Array([4, 5, 6, 7, 8, 9, 10])]]);

    let samples = sampleMessages(posted);
    expect(samples).toHaveLength(2);
    expect(Array.from(samples[0]!.message.samples as Float32Array)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(samples[0]!.message.processCount).toBe(3);
    expect(Array.from(samples[1]!.message.samples as Float32Array)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);

    processor.process([[new Float32Array([11, 12, 13, 14, 15, 16])]]);
    samples = sampleMessages(posted);
    expect(samples.map(({ message }) => message.endSample)).toEqual([8, 10, 12, 14, 16]);
    expect(samples.map(({ message }) => Array.from(message.samples as Float32Array)).at(-1)).toEqual(
      [9, 10, 11, 12, 13, 14, 15, 16],
    );
    expect(posted.filter(({ message }) => message.type === "level")).toHaveLength(4);
  });

  it("resets only the analysis ring on a monotonic continuity epoch", () => {
    const { posted, processor, send } = workletHarness({
      windowSize: 4,
      hopSize: 2,
      meterSize: 4,
      captureEpoch: 9,
      continuityEpoch: 12,
    });
    processor.process([[new Float32Array([1, 2, 3, 4, 5])]]);
    send({ type: "discontinuity", continuityEpoch: 13 });
    send({ type: "discontinuity", continuityEpoch: 12 });
    processor.process([[new Float32Array([6, 7, 8, 9, 10, 11])]]);

    const samples = sampleMessages(posted);
    expect(samples.map(({ message }) => Array.from(message.samples as Float32Array))).toEqual([
      [1, 2, 3, 4],
      [6, 7, 8, 9],
      [8, 9, 10, 11],
    ]);
    expect(samples.map(({ message }) => ({
      startSample: message.startSample,
      endSample: message.endSample,
      continuityEpoch: message.continuityEpoch,
      discontinuity: message.discontinuity,
    }))).toEqual([
      { startSample: 0, endSample: 4, continuityEpoch: 12, discontinuity: true },
      { startSample: 5, endSample: 9, continuityEpoch: 13, discontinuity: true },
      { startSample: 7, endSample: 11, continuityEpoch: 13, discontinuity: false },
    ]);
    // Meter accumulation is independent: resetting analysis did not discard the
    // fifth pre-reset sample from the next four-sample meter window.
    const levels = posted.filter(({ message }) => message.type === "level");
    expect(levels).toHaveLength(2);
    expect(levels[1]!.message.dcOffset).toBe((5 + 6 + 7 + 8) / 4);
  });

  it("folds a negotiated stereo right-only input into both detector and meter PCM", () => {
    const { posted, processor } = workletHarness({ windowSize: 8, hopSize: 2, meterSize: 4 });
    const silentLeft = new Float32Array(8);
    const rightOnly = new Float32Array([1, -1, 0.5, -0.5, 0.25, -0.25, 0.75, -0.75]);

    processor.process([[silentLeft, rightOnly]]);

    const pitch = sampleMessages(posted)[0]!.message;
    expect(Array.from(pitch.samples as Float32Array)).toEqual(
      Array.from(rightOnly, (sample) => sample / 2),
    );
    const levels = posted.filter(({ message }) => message.type === "level");
    expect(levels).toHaveLength(2);
    expect(levels[0]!.message.peak).toBe(0.5);
    expect(levels[0]!.message.rms).toBeCloseTo(Math.sqrt(0.15625), 10);
  });

  it("rejects invalid protocol options without allocating unbounded buffers", () => {
    for (const value of [0, -1, 1.5, Number.NaN, 262_145]) {
      expect(() => workletHarness({ windowSize: value, hopSize: 1, meterSize: 4 })).toThrow(RangeError);
      expect(() => workletHarness({ windowSize: 8, hopSize: value, meterSize: 4 })).toThrow(RangeError);
      expect(() => workletHarness({ windowSize: 8, hopSize: 1, meterSize: value })).toThrow(RangeError);
    }
    expect(() => workletHarness({ windowSize: 8, hopSize: 9, meterSize: 4 })).toThrow(/hopSize/);
    for (const name of [
      "captureEpoch",
      "continuityEpoch",
      "graphGeneration",
      "processCount",
      "processedSampleCount",
    ]) {
      expect(() => workletHarness({ [name]: -1 })).toThrow(RangeError);
      expect(() => workletHarness({ [name]: Number.MAX_SAFE_INTEGER + 1 })).toThrow(RangeError);
    }
  });
});
