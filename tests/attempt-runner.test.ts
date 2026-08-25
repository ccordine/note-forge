import { describe, expect, it, vi } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  advanceAttempt,
  attemptEvidence,
  attemptRecentEvidence,
  attemptScoringFrames,
  beginAttempt,
  createIdleAttemptRunner,
  finishAttempt,
  MAXIMUM_RETAINED_TRACE_FRAMES,
} from "../apps/web/src/features/training-session/attempt-runner";
import { scoreWeightedSustainedNote } from "../apps/web/src/features/training-session/attempt-scoring";
import { aggregateEnvelopeScore } from "../apps/web/src/features/training-session/attempt-scoring-aggregate";
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
  it("starts on the next observation and advances from 20 ms sample hops without completing", () => {
    let state = beginAttempt({ name: "take" }, "2026-08-24T00:00:00.000Z");
    state = advanceAttempt(state, observation(WINDOW));
    expect(state.status).toBe("tracking");
    expect(state.elapsedSeconds).toBe(0);

    state = advanceAttempt(state, observation(WINDOW + HOP));
    state = advanceAttempt(state, observation(WINDOW + HOP * 2));
    state = advanceAttempt(state, observation(WINDOW + HOP * 3));
    expect(state.status).toBe("tracking");
    expect(state.elapsedSeconds).toBeCloseTo(0.06, 8);
    expect(attemptEvidence(state).frameElapsedSeconds).toEqual([0, 0.02, 0.04, 0.06]);
  });

  it("keeps silence as measured evidence while sample time advances", () => {
    let state = beginAttempt({ name: "silence" }, "start");
    state = advanceAttempt(state, observation(WINDOW, {
      observationKind: "unvoiced", voiced: false, frequencyHz: null, midiFloat: null,
      nearestMidi: null, centsFromNearest: null, reason: "no-periodic-candidate",
    }));
    state = advanceAttempt(state, observation(WINDOW + HOP, {
      observationKind: "unvoiced", voiced: false, frequencyHz: null, midiFloat: null,
      nearestMidi: null, centsFromNearest: null, reason: "no-periodic-candidate",
    }));
    const evidence = attemptEvidence(state);
    expect(evidence.frames).toHaveLength(2);
    expect(evidence.frames.every((frame) => frame.observationKind === "unvoiced")).toBe(true);
    expect(state.elapsedSeconds).toBeCloseTo(0.02, 8);
  });

  it("never catches up across duplicate, missing, or discontinuous evidence", () => {
    let state = beginAttempt({ name: "boundaries" }, "start");
    state = advanceAttempt(state, observation(WINDOW));
    state = advanceAttempt(state, observation(WINDOW));
    state = advanceAttempt(state, observation(WINDOW + HOP * 8));
    state = advanceAttempt(state, observation(WINDOW + HOP * 9, { continuityEpoch: 1, discontinuity: true }));
    expect(state.elapsedSeconds).toBe(0);

    state = advanceAttempt(state, observation(WINDOW + HOP * 10, { continuityEpoch: 1 }));
    expect(state.elapsedSeconds).toBeCloseTo(0.02, 8);
    const scoringFrames = attemptScoringFrames(state);
    expect(scoringFrames.map((frame) => frame.timeSeconds))
      .toEqual([0, 0, 0, 0.02]);
    expect(scoringFrames.map((frame) => frame.voiced))
      .toEqual([true, false, false, true]);
    expect(state.scoringAggregate.totalFrameCount).toBe(4);
    expect(state.scoringAggregate.analyzedFrameCount).toBe(2);
  });

  it("obeys an immediate manual finish even before the first observation", () => {
    let state = beginAttempt({ name: "manual" }, "start");
    state = finishAttempt(state);
    expect(state.status).toBe("complete");
    expect(state.observedFrameCount).toBe(0);
    expect(advanceAttempt(state, observation(WINDOW + HOP))).toBe(state);
  });

  it("has one duration-free idle state", () => {
    expect(createIdleAttemptRunner()).toEqual(expect.objectContaining({
      status: "idle",
      configuration: null,
      elapsedSeconds: 0,
      startedAt: null,
      evidenceChunks: [],
      retainedFrameCount: 0,
      recentEvidenceChunks: [],
      recentFrameCount: 0,
      observedFrameCount: 0,
      evidenceStride: 1,
      firstVoicedIndex: null,
      scoringProfile: null,
      activeVoicedRun: null,
      longestVoicedRun: null,
      cursor: null,
    }));
    expect(createIdleAttemptRunner().scoringAggregate.totalFrameCount).toBe(0);
  });

  it("remains live after an hour of wall time and well beyond every former cutoff", () => {
    vi.useFakeTimers();
    try {
      let state = beginAttempt({ name: "permanent" }, "start");
      vi.advanceTimersByTime(60 * 60 * 1_000);
      expect(state.status).toBe("tracking");

      for (let index = 0; index <= 1_000; index += 1) {
        state = advanceAttempt(state, observation(WINDOW + HOP * index));
      }
      expect(state.elapsedSeconds).toBeCloseTo(20, 8);
      expect(state.status).toBe("tracking");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds retained evidence without stopping or dropping authoritative counts", () => {
    let state = beginAttempt({ name: "bounded" }, "start");
    const observationCount = MAXIMUM_RETAINED_TRACE_FRAMES + 129;
    for (let index = 0; index < observationCount; index += 1) {
      state = advanceAttempt(state, observation(WINDOW + HOP * index));
    }
    const evidence = attemptEvidence(state);
    expect(state.status).toBe("tracking");
    expect(state.observedFrameCount).toBe(observationCount);
    expect(state.retainedFrameCount + state.recentFrameCount)
      .toBeLessThanOrEqual(MAXIMUM_RETAINED_TRACE_FRAMES);
    expect(evidence.frames.length).toBeLessThanOrEqual(MAXIMUM_RETAINED_TRACE_FRAMES);
    expect(evidence.observedIndices[0]).toBe(0);
    expect(evidence.frames[0]?.endSample).toBe(WINDOW);
    expect(evidence.observedIndices).toContain(Math.floor(observationCount / 2 / state.evidenceStride) * state.evidenceStride);
    expect(evidence.observedIndices.at(-1)).toBe(observationCount - 1);
    expect(evidence.frames.at(-1)?.endSample).toBe(WINDOW + HOP * (observationCount - 1));
    const recent = attemptRecentEvidence(state);
    expect(recent.frames).toHaveLength(state.recentFrameCount);
    expect(recent.observedIndices).toEqual(Array.from(
      { length: state.recentFrameCount },
      (_, index) => observationCount - state.recentFrameCount + index,
    ));
  });

  it("pins a delayed first voiced attack while decimating the full session", () => {
    let state = beginAttempt({ name: "delayed-attack" }, "start");
    const firstVoicedIndex = 100;
    const observationCount = MAXIMUM_RETAINED_TRACE_FRAMES * 3;
    for (let index = 0; index < observationCount; index += 1) {
      const voiced = index >= firstVoicedIndex;
      state = advanceAttempt(state, observation(WINDOW + HOP * index, voiced ? {} : {
        observationKind: "unvoiced",
        voiced: false,
        frequencyHz: null,
        midiFloat: null,
        nearestMidi: null,
        centsFromNearest: null,
        reason: "no-periodic-candidate",
      }));
    }
    const evidence = attemptEvidence(state);
    expect(state.firstVoicedIndex).toBe(firstVoicedIndex);
    expect(evidence.observedIndices).toContain(firstVoicedIndex);
    expect(evidence.observedIndices[0]).toBe(0);
    expect(evidence.observedIndices.at(-1)).toBe(observationCount - 1);
    expect(state.retainedFrameCount + state.recentFrameCount)
      .toBeLessThanOrEqual(MAXIMUM_RETAINED_TRACE_FRAMES);
  });

  it("weights the whole session without letting the exact recent tail dominate scoring", () => {
    let state = beginAttempt(
      { name: "adversarial-retention" },
      "start",
      { targetMidiFloat: 48, toleranceCents: 20 },
    );
    let observationIndex = 0;
    let continuityEpoch = 0;
    const push = (overrides: Partial<PitchObservation> = {}) => {
      state = advanceAttempt(state, observation(
        WINDOW + HOP * observationIndex,
        { continuityEpoch, ...overrides },
      ));
      observationIndex += 1;
    };

    for (let index = 0; index < 3_000; index += 1) push({ rms: 0.02 });
    for (let index = 0; index < 5_000; index += 1) {
      push({
        observationKind: "unvoiced",
        voiced: false,
        frequencyHz: null,
        midiFloat: null,
        nearestMidi: null,
        centsFromNearest: null,
        confidence: 0.2,
        periodicity: 0.2,
        rms: 0.2,
        reason: "no-periodic-candidate",
      });
      push({ midiFloat: 50, nearestMidi: 50, frequencyHz: 146.832, rms: 0.2 });
      continuityEpoch += 1;
      push({ discontinuity: true, continuityEpoch, rms: 0.2 });
    }
    for (let index = 0; index < 512; index += 1) push({ rms: 1 });

    const evidence = attemptEvidence(state);
    const scoringFrames = attemptScoringFrames(state);
    const metrics = scoreWeightedSustainedNote(
      state,
      scoringFrames,
      { midi: 48, centsOffset: 0, timbre: "sine", amplitude: 0.2 },
      { toleranceCents: 20 },
    );

    expect(state.status).toBe("tracking");
    expect(state.observedFrameCount).toBe(18_512);
    expect(evidence.frames.length).toBeLessThanOrEqual(MAXIMUM_RETAINED_TRACE_FRAMES);
    expect(evidence.representedFrameCounts.reduce((sum, count) => sum + count, 0))
      .toBe(state.observedFrameCount);
    expect(scoringFrames.reduce((sum, frame) => sum + frame.scoringWeight, 0))
      .toBe(state.observedFrameCount);
    expect(metrics.totalFrameCount).toBe(state.observedFrameCount);
    expect(state.scoringAggregate.analyzedFrameCount).toBe(8_512);
    expect(state.scoringAggregate.inToleranceFrameCount).toBe(3_512);
    expect(metrics.inToleranceRatio).toBeCloseTo(3_512 / 8_512, 12);
    expect(metrics.volume?.meanRms).toBeCloseTo(
      (3_000 * 0.02 + 15_000 * 0.2 + 512) / 18_512,
      12,
    );
    expect(metrics.attackErrorCents).toBeCloseTo(0, 6);
    expect(metrics.holdDurationMs).toBeCloseTo(60_020, 6);
    expect(Math.abs(metrics.driftCentsPerSecond ?? 0)).toBeLessThan(0.1);
  });

  it("scores the accumulated envelope instead of overweighting a contrary recent tail", () => {
    let state = beginAttempt(
      { name: "envelope-retention" },
      "start",
      { targetMidiFloat: 48, toleranceCents: 20, envelopeCycleSeconds: 8 },
    );
    const cycleFrames = 400;
    const matchingFrames = cycleFrames * 20;
    for (let index = 0; index < matchingFrames + 512; index += 1) {
      const progress = (index % cycleFrames) / cycleFrames;
      state = advanceAttempt(state, observation(WINDOW + HOP * index, {
        rms: index < matchingFrames ? progress : 1 - progress,
      }));
    }
    const score = aggregateEnvelopeScore(
      state.scoringAggregate,
      [0, 1],
      (_points, progress) => progress,
    );
    expect(state.observedFrameCount).toBe(8_512);
    expect(score).toBeGreaterThan(94);
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
