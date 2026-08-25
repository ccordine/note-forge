import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  canRateRangeProbe,
  createRangeSimulatorController,
  reduceRangeSimulatorController,
} from "../apps/web/src/features/range-simulator/controller";
import {
  currentRangeSimulatorProbe,
  rateRangeSimulatorProbe,
} from "../apps/web/src/features/range-simulator/model";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const HOP_SIZE = 960;
const STARTED_AT = "2026-08-24T12:00:00.000Z";

function observation(
  index: number,
  options: {
    kind?: PitchObservation["observationKind"];
    midiFloat?: number | null;
    confidence?: number;
    discontinuity?: boolean;
    continuityEpoch?: number;
  } = {},
): PitchObservation {
  const endSample = WINDOW_SIZE + HOP_SIZE * index;
  const kind = options.kind ?? "voiced";
  const voiced = kind === "voiced";
  const midiFloat = options.midiFloat === undefined ? (voiced ? 48 : null) : options.midiFloat;
  const nearestMidi = midiFloat === null ? null : Math.round(midiFloat);
  return {
    observationKind: kind,
    timeSeconds: (endSample - WINDOW_SIZE / 2) / SAMPLE_RATE,
    sampleRate: SAMPLE_RATE,
    startSample: endSample - WINDOW_SIZE,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: options.continuityEpoch ?? 0,
    graphGeneration: 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: options.discontinuity ?? false,
    frequencyHz: midiFloat === null ? null : 440 * 2 ** ((midiFloat - 69) / 12),
    midiFloat,
    nearestMidi,
    centsFromNearest: midiFloat === null || nearestMidi === null ? null : (midiFloat - nearestMidi) * 100,
    rms: voiced ? 0.02 : 0,
    confidence: options.confidence ?? (voiced ? 0.96 : 0),
    voiced,
    detector: "yin",
    periodSamples: voiced ? 367 : null,
    yinValue: voiced ? 0.04 : null,
    reason: voiced ? "detected" : kind === "unvoiced" ? "below-rms-threshold" : "below-confidence-threshold",
    periodicity: voiced ? 0.96 : 0,
  };
}

function controller() {
  return createRangeSimulatorController({
    startedAt: STARTED_AT,
    toleranceCents: 20,
    anchorMidi: 48,
    preparation: "unwarmed",
  });
}

describe("Range Simulator sample-coordinate controller", () => {
  it("uses only idle, tracking, and complete workflow status", () => {
    const initial = controller();
    const tracking = reduceRangeSimulatorController(initial, { type: "begin", toleranceCents: 20 });
    const complete = reduceRangeSimulatorController(tracking, {
      type: "finish",
      stoppedAt: "2026-08-24T12:01:00.000Z",
    });

    expect(initial.status).toBe("idle");
    expect(tracking.status).toBe("tracking");
    expect(complete.status).toBe("complete");
  });

  it("freezes earned samples through silence, uncertainty, and discontinuity", () => {
    let state = reduceRangeSimulatorController(controller(), { type: "begin", toleranceCents: 20 });
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(0) });
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(1) });
    expect(state.dwell.heldSamples).toBe(HOP_SIZE);

    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(2, { kind: "unvoiced" }) });
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(3, { kind: "uncertain", midiFloat: 48.02, confidence: 0.2 }) });
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(4, { discontinuity: true, continuityEpoch: 1 }) });
    expect(state.dwell.heldSamples).toBe(HOP_SIZE);

    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(5, { continuityEpoch: 1 }) });
    expect(state.dwell.heldSamples).toBe(HOP_SIZE * 2);
  });

  it("resets dwell for every detector-admitted voiced pitch outside the target", () => {
    let state = reduceRangeSimulatorController(controller(), { type: "begin", toleranceCents: 20 });
    for (let index = 0; index < 5; index += 1) {
      state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(index) });
    }
    expect(state.dwell.heldSamples).toBe(HOP_SIZE * 4);

    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(5, { midiFloat: 49, confidence: 0.2 }) });
    expect(state.dwell.heldSamples).toBe(0);
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(6, { midiFloat: 49, confidence: 0.96 }) });
    expect(state.dwell.heldSamples).toBe(0);
  });

  it("advances the adaptive model only after sample-authoritative dwell and a user rating", () => {
    let state = reduceRangeSimulatorController(controller(), { type: "begin", toleranceCents: 20 });
    for (let index = 0; index <= 75; index += 1) {
      state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(index) });
    }
    expect(state.dwell.achievementReached).toBe(true);
    expect(state.dwell.heldSamples).toBe(HOP_SIZE * 75);
    expect(canRateRangeProbe(state)).toBe(true);

    state = reduceRangeSimulatorController(state, { type: "select-rating", rating: 1 });
    state = reduceRangeSimulatorController(state, {
      type: "save-rating",
      ratedAt: "2026-08-24T12:00:10.000Z",
      toleranceCents: 20,
    });
    expect(state.session.ratedProbeCount).toBe(1);
    expect(currentRangeSimulatorProbe(state.session)?.midi).toBe(46);
    expect(state.dwell).toMatchObject({
      targetMidi: 46,
      achievementReached: false,
      heldSamples: 0,
    });
    expect(state.persistenceRevision).toBe(1);
  });

  it("allows honest unstable or unable ratings without fabricating a hold", () => {
    let state = reduceRangeSimulatorController(controller(), { type: "begin", toleranceCents: 20 });
    state = reduceRangeSimulatorController(state, { type: "select-rating", rating: 3 });
    expect(state.rating).toBeNull();
    state = reduceRangeSimulatorController(state, { type: "select-rating", rating: 5 });
    expect(state.rating).toBe(5);
    expect(canRateRangeProbe(state)).toBe(true);
  });

  it("keeps the live controller authoritative after the probe queue is exhausted until explicit Finish", () => {
    let state = reduceRangeSimulatorController(controller(), { type: "begin", toleranceCents: 20 });
    for (let ratingIndex = 0; ratingIndex < 5; ratingIndex += 1) {
      state = reduceRangeSimulatorController(state, { type: "select-rating", rating: 5 });
      state = reduceRangeSimulatorController(state, {
        type: "save-rating",
        ratedAt: `2026-08-24T12:00:0${ratingIndex + 1}.000Z`,
        toleranceCents: 20,
      });
    }

    expect(state).toMatchObject({ status: "tracking", session: { phase: "complete", completionStatus: "no-usable-baseline" } });
    expect(canRateRangeProbe(state)).toBe(false);
    expect(state.notice).toContain("live pitch surface remains active");

    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(100) });
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(101, { midiFloat: 49 }) });
    expect(state).toMatchObject({
      status: "tracking",
      dwell: {
        observedFrameCount: 2,
        currentMidiFloat: 49,
        lastAuthority: { endSample: WINDOW_SIZE + HOP_SIZE * 101 },
      },
    });
    const stillLive = state;
    state = reduceRangeSimulatorController(state, {
      type: "fresh",
      anchorMidi: 52,
      preparation: "warmed",
      startedAt: "2026-08-24T12:00:30.000Z",
      toleranceCents: 20,
    });
    expect(state).toBe(stillLive);

    state = reduceRangeSimulatorController(state, {
      type: "finish",
      stoppedAt: "2026-08-24T12:01:00.000Z",
    });
    expect(state).toMatchObject({
      status: "complete",
      session: { completionStatus: "stopped" },
    });
  });

  it("reloads a persisted queue achievement idle until explicit Continue, then requires explicit Finish", () => {
    let state = reduceRangeSimulatorController(controller(), { type: "begin", toleranceCents: 20 });
    for (let ratingIndex = 0; ratingIndex < 5; ratingIndex += 1) {
      state = reduceRangeSimulatorController(state, { type: "select-rating", rating: 5 });
      state = reduceRangeSimulatorController(state, {
        type: "save-rating",
        ratedAt: `2026-08-24T12:00:0${ratingIndex + 1}.000Z`,
        toleranceCents: 20,
      });
    }
    const achievedSession = state.session;
    const freshController = controller();
    let reloaded = reduceRangeSimulatorController(freshController, {
      type: "hydrate",
      session: achievedSession,
      profile: state.profile,
      toleranceCents: 20,
    });
    expect(reloaded).toMatchObject({
      status: "idle",
      session: { phase: "complete", completionStatus: "no-usable-baseline" },
    });
    expect(reloaded.notice).toContain("Press Start saved assessment");
    reloaded = reduceRangeSimulatorController(reloaded, {
      type: "observation",
      observation: observation(100),
    });
    expect(reloaded.dwell.observedFrameCount).toBe(0);

    reloaded = reduceRangeSimulatorController(reloaded, {
      type: "begin",
      toleranceCents: 20,
    });
    expect(reloaded.status).toBe("tracking");
    reloaded = reduceRangeSimulatorController(reloaded, {
      type: "observation",
      observation: observation(100),
    });
    expect(reloaded.dwell.observedFrameCount).toBe(1);

    const explicitlyFinished = reduceRangeSimulatorController(reloaded, {
      type: "finish",
      stoppedAt: "2026-08-24T12:01:00.000Z",
    });
    expect(explicitlyFinished.session.completionStatus).toBe("stopped");
    const finishedReload = reduceRangeSimulatorController(freshController, {
      type: "hydrate",
      session: explicitlyFinished.session,
      profile: explicitlyFinished.profile,
      toleranceCents: 20,
    });
    expect(finishedReload.status).toBe("complete");
  });

  it("latches full-depth boundary achievement while observations and explicit recheck remain live until Finish", () => {
    let state = reduceRangeSimulatorController(controller(), { type: "begin", toleranceCents: 20 });
    let session = state.session;
    let finalRatingTime = "";
    while (true) {
      const probe = currentRangeSimulatorProbe(session);
      if (!probe) throw new Error("Full-depth fixture exhausted its queue unexpectedly.");
      finalRatingTime = new Date(
        Date.parse(STARTED_AT) + (session.ratedProbeCount + 1) * 1_000,
      ).toISOString();
      const candidate = rateRangeSimulatorProbe(session, {
        taskId: probe.id,
        rating: 1,
        ratedAt: finalRatingTime,
      });
      if (candidate.phase === "complete") break;
      session = candidate;
    }
    state = {
      ...state,
      session,
      dwell: {
        ...state.dwell,
        achievementReached: true,
        heldSamples: Math.round(state.dwell.requiredHoldSeconds * SAMPLE_RATE),
        heldSeconds: state.dwell.requiredHoldSeconds,
        peakHeldSamples: Math.round(state.dwell.requiredHoldSeconds * SAMPLE_RATE),
        peakHeldSeconds: state.dwell.requiredHoldSeconds,
        progress: 1,
      },
    };
    state = reduceRangeSimulatorController(state, { type: "select-rating", rating: 1 });
    state = reduceRangeSimulatorController(state, {
      type: "save-rating",
      ratedAt: finalRatingTime,
      toleranceCents: 20,
    });

    expect(state).toMatchObject({
      status: "tracking",
      session: {
        phase: "complete",
        completionStatus: "complete",
      },
    });
    expect(state.session.ratedProbeCount).toBeGreaterThan(24);
    const priorCount = state.dwell.observedFrameCount;
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(200) });
    expect(state.status).toBe("tracking");
    expect(state.dwell.observedFrameCount).toBe(priorCount + 1);

    state = reduceRangeSimulatorController(state, {
      type: "recheck",
      startedAt: new Date(Date.parse(finalRatingTime) + 1_000).toISOString(),
      toleranceCents: 20,
    });
    expect(state).toMatchObject({
      status: "tracking",
      session: { phase: "baseline", ratedProbeCount: 0 },
      dwell: { observedFrameCount: 0 },
    });
    state = reduceRangeSimulatorController(state, { type: "observation", observation: observation(201) });
    expect(state.dwell.observedFrameCount).toBe(1);

    state = reduceRangeSimulatorController(state, {
      type: "finish",
      stoppedAt: new Date(Date.parse(finalRatingTime) + 2_000).toISOString(),
    });
    expect(state.status).toBe("complete");
  });
});
