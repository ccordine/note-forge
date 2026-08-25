import { describe, expect, it } from "vitest";
import {
  observationAuthority,
  observationContinuity,
  type ObservationSampleCoordinates,
} from "../apps/web/src/realtime/observation-continuity";

const SAMPLE_RATE = 48_000;
const WINDOW = 4_096;
const HOP = 960;

function observation(
  endSample = WINDOW,
  overrides: Partial<ObservationSampleCoordinates> = {},
): Readonly<ObservationSampleCoordinates> {
  return Object.freeze({
    sampleRate: SAMPLE_RATE,
    startSample: endSample - WINDOW,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: Math.ceil(endSample / 128),
    discontinuity: false,
    ...overrides,
  });
}

describe("central observation continuity authority", () => {
  it("credits only the exact next overlapping production hop", () => {
    const first = observationAuthority(observation())!;
    const contiguous = observationContinuity(first, observation(WINDOW + HOP));

    expect(contiguous).toMatchObject({
      accepted: true,
      boundary: false,
      contiguous: true,
      reason: "contiguous",
      deltaSamples: HOP,
      deltaSeconds: 0.02,
    });
  });

  it.each([
    [44_100, 4_096, 882],
    [48_000, 4_096, 960],
    [96_000, 8_192, 1_920],
    [192_000, 16_384, 3_840],
  ])("recognizes the exact production overlap at %i Hz", (sampleRate, window, hop) => {
    const firstFrame = observation(window, {
      sampleRate,
      startSample: 0,
      processedSampleCount: window,
      workletProcessCount: 32,
    });
    const nextFrame = observation(window + hop, {
      sampleRate,
      startSample: hop,
      processedSampleCount: window + hop,
      workletProcessCount: 40,
    });
    const result = observationContinuity(observationAuthority(firstFrame), nextFrame);
    expect(result).toMatchObject({
      accepted: true,
      contiguous: true,
      deltaSamples: hop,
      deltaSeconds: 0.02,
    });
  });

  it.each([
    ["missing end window", observation(WINDOW + HOP * 2)],
    ["non-overlap", observation(WINDOW * 2, { startSample: WINDOW })],
  ])("turns %s into a zero-time boundary", (_label, current) => {
    const result = observationContinuity(observationAuthority(observation())!, current);
    expect(result).toMatchObject({
      accepted: true,
      boundary: true,
      contiguous: false,
      reason: "missing-window",
      deltaSamples: 0,
      deltaSeconds: 0,
    });
    expect(result.authority?.endSample).toBe(current.endSample);
  });

  it.each([
    ["shifted start", observation(WINDOW + HOP, { startSample: HOP + 1 })],
    ["changed window depth", observation(WINDOW + HOP, { startSample: HOP + 16 })],
  ])("rejects malformed %s framing without replacing authority", (_label, current) => {
    const first = observationAuthority(observation())!;
    const result = observationContinuity(first, current);
    expect(result).toMatchObject({
      accepted: false,
      boundary: false,
      contiguous: false,
      reason: "invalid",
    });
    expect(result.authority).toBe(first);
  });

  it("rejects duplicate and reordered evidence without replacing newer authority", () => {
    const first = observationAuthority(observation(WINDOW + HOP))!;
    for (const stale of [
      observation(WINDOW + HOP),
      observation(WINDOW, { workletProcessCount: 1 }),
      observation(WINDOW + HOP * 2, { workletProcessCount: first.workletProcessCount }),
    ]) {
      const result = observationContinuity(first, stale);
      expect(result).toMatchObject({
        accepted: false,
        boundary: false,
        contiguous: false,
        reason: "duplicate-or-reordered",
      });
      expect(result.authority).toBe(first);
    }
  });

  it.each([
    ["explicit discontinuity", { discontinuity: true }],
    ["capture epoch", { captureEpoch: 2 }],
    ["continuity epoch", { continuityEpoch: 1 }],
    ["processing rebuild", { continuityEpoch: 1, graphGeneration: 1 }],
    ["sample rate rebuild", { sampleRate: 44_100, continuityEpoch: 1, graphGeneration: 1 }],
  ] satisfies readonly [string, Partial<ObservationSampleCoordinates>][]) (
    "establishes fresh zero-time authority for a %s boundary",
    (_label, overrides) => {
      const first = observationAuthority(observation())!;
      const current = observation(WINDOW + HOP, overrides);
      const result = observationContinuity(first, current);
      expect(result.accepted).toBe(true);
      expect(result.boundary).toBe(true);
      expect(result.contiguous).toBe(false);
      expect(result.deltaSeconds).toBe(0);
      expect(result.authority?.endSample).toBe(current.endSample);
    },
  );

  it("rejects regressed epoch authority", () => {
    const previous = observationAuthority(observation(WINDOW, {
      captureEpoch: 4,
      continuityEpoch: 2,
      graphGeneration: 3,
    }))!;
    const result = observationContinuity(previous, observation(WINDOW + HOP, {
      captureEpoch: 4,
      continuityEpoch: 1,
      graphGeneration: 99,
    }));
    expect(result).toMatchObject({ accepted: false, reason: "authority-regression" });
    expect(result.authority).toBe(previous);
  });

  it("rejects a forward continuity epoch when its graph generation regresses", () => {
    const previous = observationAuthority(observation(WINDOW, {
      continuityEpoch: 2,
      graphGeneration: 5,
    }))!;
    const result = observationContinuity(previous, observation(WINDOW + HOP, {
      continuityEpoch: 3,
      graphGeneration: 0,
    }));
    expect(result).toMatchObject({ accepted: false, reason: "authority-regression" });
    expect(result.authority).toBe(previous);
  });

  it("rejects graph regression inside one continuity epoch", () => {
    const previous = observationAuthority(observation(WINDOW, {
      continuityEpoch: 2,
      graphGeneration: 5,
    }))!;
    const result = observationContinuity(previous, observation(WINDOW + HOP, {
      continuityEpoch: 2,
      graphGeneration: 4,
    }));
    expect(result).toMatchObject({ accepted: false, reason: "authority-regression" });
    expect(result.authority).toBe(previous);
  });

  it("rejects graph-only and sample-rate-only changes inside one continuity epoch", () => {
    const previous = observationAuthority(observation())!;
    for (const current of [
      observation(WINDOW + HOP, { graphGeneration: 1 }),
      observation(WINDOW + HOP, { sampleRate: 44_100 }),
    ]) {
      const result = observationContinuity(previous, current);
      expect(result).toMatchObject({ accepted: false, reason: "invalid" });
      expect(result.authority).toBe(previous);
    }
  });

  it("rejects a sample-rate change without a processing-graph rebuild", () => {
    const previous = observationAuthority(observation())!;
    const result = observationContinuity(previous, observation(WINDOW + HOP, {
      sampleRate: 44_100,
      continuityEpoch: 1,
    }));
    expect(result).toMatchObject({ accepted: false, reason: "invalid" });
    expect(result.authority).toBe(previous);
  });

  it("accepts a new capture with reset child epochs, samples, and worklet count", () => {
    const previous = observationAuthority(observation(WINDOW + HOP * 10, {
      captureEpoch: 3,
      continuityEpoch: 5,
      graphGeneration: 4,
      workletProcessCount: 500,
    }))!;
    const current = observation(WINDOW, {
      captureEpoch: 4,
      continuityEpoch: 0,
      graphGeneration: 0,
      workletProcessCount: 1,
    });
    const result = observationContinuity(previous, current);
    expect(result).toMatchObject({
      accepted: true,
      boundary: true,
      reason: "authority-change",
      deltaSeconds: 0,
    });
    expect(result.authority?.endSample).toBe(WINDOW);
  });

  it("accepts the first replacement window as a zero-time discontinuity boundary", () => {
    const previousEnd = WINDOW + HOP * 10;
    const previous = observationAuthority(observation(previousEnd, {
      continuityEpoch: 2,
      graphGeneration: 1,
      workletProcessCount: 500,
    }))!;
    const replacementEnd = previousEnd + WINDOW;
    const replacement = observation(replacementEnd, {
      startSample: previous.processedSampleCount,
      continuityEpoch: 3,
      graphGeneration: 2,
      workletProcessCount: 501,
      discontinuity: true,
    });
    const result = observationContinuity(previous, replacement);
    expect(result).toMatchObject({
      accepted: true,
      boundary: true,
      reason: "authority-change",
      deltaSamples: 0,
      deltaSeconds: 0,
    });
  });

  it.each([
    { sampleRate: 0 },
    { startSample: -1 },
    { endSample: WINDOW - 1, startSample: WINDOW },
    { processedSampleCount: WINDOW - 1 },
    { captureEpoch: 0.5 },
    { workletProcessCount: -1 },
  ] satisfies Partial<ObservationSampleCoordinates>[])(
    "rejects malformed sample identity %#",
    (overrides) => {
      expect(observationContinuity(null, observation(WINDOW, overrides)))
        .toMatchObject({ accepted: false, reason: "invalid", authority: null });
    },
  );
});
