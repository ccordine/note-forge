import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  PITCH_TUNNEL_CHECKPOINT_OFFSETS,
  PITCH_TUNNEL_DEFAULTS,
  createPitchTunnel,
  finishPitchTunnel,
  observePitchTunnel,
  pitchTunnelMetrics,
  reducePitchTunnel,
  resetPitchTunnel,
  startPitchTunnel,
  type PitchTunnelState,
} from "../apps/web/src/features/pitch-tunnel/pitch-tunnel-engine";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const HOP_SIZE = 960;
const ANCHOR_MIDI = 48;

interface ObservationOverrides {
  readonly kind?: PitchObservation["observationKind"];
  readonly midiFloat?: number | null;
  readonly frequencyHz?: number | null;
  readonly voiced?: boolean;
  readonly confidence?: number;
  readonly sampleRate?: number;
  readonly startSample?: number;
  readonly processedSampleCount?: number;
  readonly captureEpoch?: number;
  readonly continuityEpoch?: number;
  readonly graphGeneration?: number;
  readonly workletProcessCount?: number;
  readonly discontinuity?: boolean;
}

function observation(
  endSample: number,
  midiFloat: number | null = ANCHOR_MIDI,
  overrides: ObservationOverrides = {},
): PitchObservation {
  const kind = overrides.kind ?? (midiFloat === null ? "unvoiced" : "voiced");
  const voiced = overrides.voiced ?? kind === "voiced";
  const sampleRate = overrides.sampleRate ?? SAMPLE_RATE;
  const resolvedMidi = voiced ? midiFloat : null;
  const frequencyHz = overrides.frequencyHz === undefined
    ? resolvedMidi === null ? null : 440 * 2 ** ((resolvedMidi - 69) / 12)
    : overrides.frequencyHz;
  const nearestMidi = resolvedMidi === null ? null : Math.round(resolvedMidi);
  return Object.freeze({
    observationKind: kind,
    timeSeconds: 999_999,
    sampleRate,
    startSample: overrides.startSample ?? endSample - WINDOW_SIZE,
    endSample,
    processedSampleCount: overrides.processedSampleCount ?? endSample,
    captureEpoch: overrides.captureEpoch ?? 1,
    continuityEpoch: overrides.continuityEpoch ?? 0,
    graphGeneration: overrides.graphGeneration ?? 0,
    workletProcessCount: overrides.workletProcessCount ?? Math.floor(endSample / 128),
    discontinuity: overrides.discontinuity ?? false,
    frequencyHz,
    midiFloat: resolvedMidi,
    nearestMidi,
    centsFromNearest: resolvedMidi === null || nearestMidi === null
      ? null
      : (resolvedMidi - nearestMidi) * 100,
    rms: voiced ? 0.000_001 : 0,
    confidence: overrides.confidence ?? (voiced ? 0.97 : 0),
    voiced,
    detector: "yin",
    periodSamples: voiced ? 200 : null,
    yinValue: voiced ? 0.03 : null,
    reason: kind === "voiced"
      ? "detected"
      : kind === "unvoiced"
        ? "below-rms-threshold"
        : "below-confidence-threshold",
    periodicity: voiced ? 0.97 : 0,
  });
}

function nextObservation(
  state: Readonly<PitchTunnelState>,
  midiFloat: number | null,
  overrides: ObservationOverrides = {},
): PitchObservation {
  return observation(state.lastAuthority!.endSample + HOP_SIZE, midiFloat, overrides);
}

function anchored(options: Parameters<typeof createPitchTunnel>[0] = {}): PitchTunnelState {
  const idle = observePitchTunnel(createPitchTunnel(options), observation(WINDOW_SIZE));
  return startPitchTunnel(idle);
}

function observeNext(
  state: Readonly<PitchTunnelState>,
  midiFloat: number | null,
  overrides: ObservationOverrides = {},
): PitchTunnelState {
  return observePitchTunnel(state, nextObservation(state, midiFloat, overrides));
}

function finishCurrentCheckpoint(state: PitchTunnelState): PitchTunnelState {
  const index = state.checkpoint!.index;
  const target = state.checkpoint!.targetMidiFloat;
  for (let frame = 0; frame < 100 && state.checkpoint?.index === index; frame += 1) {
    state = observeNext(state, target);
  }
  return state;
}

describe("Pitch Tunnel sample-time engine", () => {
  it("defines the clinical 25-cent ascent and reversal with a narrow default lane", () => {
    const state = createPitchTunnel();
    expect(state.status).toBe("idle");
    expect(state.options).toEqual({
      checkpointOffsetsCents: [0, 25, 50, 75, 100, 75, 50, 25, 0],
      laneHalfWidthCents: 10,
      requiredInLaneSeconds: 1,
      overshootDeadbandCents: 3,
      maximumCreditedIntervalSeconds: 0.03,
    });
    expect(state.options.checkpointOffsetsCents).toEqual(PITCH_TUNNEL_CHECKPOINT_OFFSETS);
    expect(state.options.laneHalfWidthCents).toBe(PITCH_TUNNEL_DEFAULTS.laneHalfWidthCents);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.options)).toBe(true);
    expect(Object.isFrozen(state.options.checkpointOffsetsCents)).toBe(true);
  });

  it("retains an idle candidate but anchors only the exact currently voiced authority", () => {
    let state = observePitchTunnel(createPitchTunnel(), observation(WINDOW_SIZE, 48.125, {
      confidence: 0,
    }));
    expect(state.latestCandidate).toMatchObject({
      midiFloat: 48.125,
      confidence: 0,
      supportsTrajectory: true,
    });
    expect(state.latestCandidate?.authority).toBe(state.lastAuthority);
    expect(state.currentMidiFloat).toBe(48.125);

    state = observeNext(state, null, { kind: "unvoiced" });
    expect(state.latestCandidate?.midiFloat).toBe(48.125);
    expect(state.currentMidiFloat).toBeNull();
    expect(state.latestCandidate?.authority).not.toBe(state.lastAuthority);
    expect(startPitchTunnel(state)).toBe(state);

    state = observeNext(state, 48.25);
    const started = reducePitchTunnel(state, { type: "start" });
    expect(started).toMatchObject({
      status: "tracking",
      anchorMidiFloat: 48.25,
      currentPitchOffsetCents: 0,
      currentErrorCents: 0,
      currentInLane: true,
    });
    expect(started.lastAuthority).toBe(state.latestCandidate?.authority);
    expect(started.checkpoint).toMatchObject({
      index: 0,
      targetOffsetCents: 0,
      targetMidiFloat: 48.25,
      heldSeconds: 0,
    });
  });

  it("does not add a second confidence, detector-reason, or input-level gate", () => {
    let state = createPitchTunnel();
    state = observePitchTunnel(state, Object.freeze({
      ...observation(WINDOW_SIZE, ANCHOR_MIDI, { confidence: Number.NaN }),
      reason: "below-confidence-threshold" as const,
      rms: 1e-12,
    }));
    expect(state.currentMidiFloat).toBe(ANCHOR_MIDI);
    expect(state.latestCandidate).toMatchObject({ midiFloat: ANCHOR_MIDI, confidence: 0 });
    expect(startPitchTunnel(state).status).toBe("tracking");
  });

  it("rejects anchors whose configured trajectory exceeds the canonical detector range", () => {
    const state = observePitchTunnel(createPitchTunnel(), observation(WINDOW_SIZE, 87));
    expect(state.latestCandidate).toMatchObject({ midiFloat: 87, supportsTrajectory: false });
    expect(startPitchTunnel(state)).toBe(state);
    expect(state.status).toBe("idle");
  });

  it("credits the first checkpoint only from consecutive exact in-lane sample intervals", () => {
    let state = anchored();
    expect(state.checkpoint?.heldSeconds).toBe(0);
    for (let frame = 1; frame <= 49; frame += 1) {
      state = observeNext(state, ANCHOR_MIDI);
      expect(state.checkpoint?.index).toBe(0);
      expect(state.checkpoint?.heldSeconds).toBeCloseTo(frame * 0.02, 12);
    }
    state = observeNext(state, ANCHOR_MIDI);
    expect(state.checkpoint).toMatchObject({
      index: 1,
      targetOffsetCents: 25,
      heldSeconds: 0,
    });
    expect(state.completedCheckpoints[0]).toMatchObject({
      index: 0,
      timeInLaneSeconds: expect.closeTo(1, 12),
      correctionLatencySeconds: 0,
    });
    expect(state.currentErrorCents).toBeCloseTo(-25, 12);
    expect(state.currentInLane).toBe(false);
    expect(state.correctedCheckpointCount).toBe(0);
  });

  it("keeps adjacent 25-cent checkpoint lanes mathematically disjoint", () => {
    let state = anchored({ requiredInLaneSeconds: 0.02 });
    state = observeNext(state, ANCHOR_MIDI + 0.1);
    expect(state.checkpoint).toMatchObject({ index: 1, targetOffsetCents: 25 });
    expect(state.currentErrorCents).toBeCloseTo(-15, 12);
    expect(state.currentInLane).toBe(false);
    state = observeNext(state, ANCHOR_MIDI + 0.1);
    expect(state.checkpoint?.heldSeconds).toBe(0);
  });

  it("reconfigures the shared lane live without crossing or erasing trace evidence", () => {
    let state = anchored({ laneHalfWidthCents: 20 });
    state = observeNext(state, ANCHOR_MIDI + 0.15);
    expect(state.checkpoint?.heldSeconds).toBeCloseTo(0.02, 12);
    const checkpoint = state.checkpoint;
    const totals = state.totals;

    state = reducePitchTunnel(state, {
      type: "reconfigure-tolerance",
      toleranceCents: 10,
    });
    expect(state).toMatchObject({
      options: { laneHalfWidthCents: 10 },
      currentInLane: null,
      previousReliable: false,
      previousInLane: false,
      previousErrorCents: null,
    });
    expect(state.checkpoint).toBe(checkpoint);
    expect(state.totals).toBe(totals);

    state = observeNext(state, ANCHOR_MIDI + 0.15);
    expect(state.checkpoint).toMatchObject({
      heldSeconds: 0,
      trackedSeconds: 0.02,
      inLaneSeconds: 0.02,
    });
    expect(state.totals).toBe(totals);
    expect(state.currentInLane).toBe(false);
  });

  it("completes all nine checkpoints from exact sample-time dwell", () => {
    let state = anchored();
    while (!state.achievementReached) state = finishCurrentCheckpoint(state);
    expect(state.status).toBe("tracking");
    expect(state.achievementReached).toBe(true);
    expect(state.completedCheckpoints.map(({ targetOffsetCents }) => targetOffsetCents))
      .toEqual([0, 25, 50, 75, 100, 75, 50, 25, 0]);
    expect(state.completedCheckpoints).toHaveLength(9);
    for (const checkpoint of state.completedCheckpoints) {
      expect(checkpoint.timeInLaneSeconds).toBeCloseTo(1, 10);
      expect(checkpoint.targetMidiFloat).toBeCloseTo(
        ANCHOR_MIDI + checkpoint.targetOffsetCents / 100,
        12,
      );
    }
    expect(state.completedCheckpoints[0]?.correctionLatencySeconds).toBe(0);
    expect(state.correctedCheckpointCount).toBe(8);
    expect(pitchTunnelMetrics(state).meanCorrectionLatencySeconds).toBeCloseTo(0.02, 10);
  });

  it("pauses dwell through silence and uncertainty without backfilling either gap", () => {
    let state = anchored({ requiredInLaneSeconds: 0.1 });
    state = observeNext(state, ANCHOR_MIDI);
    state = observeNext(state, ANCHOR_MIDI);
    expect(state.checkpoint?.heldSeconds).toBeCloseTo(0.04, 12);

    state = observeNext(state, null, { kind: "unvoiced" });
    state = observeNext(state, null, { kind: "unvoiced" });
    state = observeNext(state, ANCHOR_MIDI, { kind: "uncertain", voiced: false });
    state = observeNext(state, ANCHOR_MIDI);
    expect(state.checkpoint?.heldSeconds).toBeCloseTo(0.04, 12);
    expect(state.trackingLossSeconds).toBeCloseTo(0.08, 12);
    expect(state.trackingLossEvents).toBe(1);

    state = observeNext(state, ANCHOR_MIDI);
    expect(state.checkpoint?.heldSeconds).toBeCloseTo(0.06, 12);
    expect(state.elapsedSeconds).toBeCloseTo(0.14, 12);
  });

  it("resets continuous checkpoint dwell on credible wrong pitch but keeps aggregate evidence", () => {
    let state = anchored({ requiredInLaneSeconds: 0.1 });
    state = observeNext(state, ANCHOR_MIDI);
    state = observeNext(state, ANCHOR_MIDI);
    state = observeNext(state, ANCHOR_MIDI);
    expect(state.checkpoint?.heldSeconds).toBeCloseTo(0.06, 12);
    expect(state.totals.inLaneSeconds).toBeCloseTo(0.06, 12);

    state = observeNext(state, ANCHOR_MIDI + 0.2);
    expect(state.checkpoint?.heldSeconds).toBe(0);
    expect(state.currentInLane).toBe(false);
    expect(state.totals.inLaneSeconds).toBeCloseTo(0.06, 12);
    expect(state.trackingLossSeconds).toBe(0);

    state = observeNext(state, ANCHOR_MIDI);
    expect(state.checkpoint?.heldSeconds).toBe(0);
    state = observeNext(state, ANCHOR_MIDI);
    expect(state.checkpoint?.heldSeconds).toBeCloseTo(0.02, 12);
  });

  it("rebases discontinuities, epoch changes, and missing hops with zero catch-up", () => {
    let state = anchored({ requiredInLaneSeconds: 0.1 });
    state = observeNext(state, ANCHOR_MIDI);
    state = observeNext(state, ANCHOR_MIDI);
    const held = state.checkpoint!.heldSeconds;
    const elapsed = state.elapsedSeconds;

    state = observePitchTunnel(state, observation(
      state.lastAuthority!.endSample + SAMPLE_RATE * 10,
      ANCHOR_MIDI,
      { continuityEpoch: 1, discontinuity: true },
    ));
    expect(state.checkpoint?.heldSeconds).toBe(held);
    expect(state.elapsedSeconds).toBe(elapsed);
    expect(state.authorityBreakCount).toBe(1);
    expect(state.discontinuityCount).toBe(1);

    state = observeNext(state, ANCHOR_MIDI, { continuityEpoch: 1 });
    expect(state.checkpoint?.heldSeconds).toBeCloseTo(held + 0.02, 12);
    const beforeGap = state;
    state = observePitchTunnel(state, observation(
      state.lastAuthority!.endSample + HOP_SIZE * 10,
      ANCHOR_MIDI,
      { continuityEpoch: 1 },
    ));
    expect(state.checkpoint?.heldSeconds).toBe(beforeGap.checkpoint?.heldSeconds);
    expect(state.elapsedSeconds).toBe(beforeGap.elapsedSeconds);
    expect(state.authorityBreakCount).toBe(2);
  });

  it("ignores malformed, duplicate, and reordered sample authority", () => {
    const state = anchored();
    const duplicate = observePitchTunnel(state, observation(
      state.lastAuthority!.endSample,
      ANCHOR_MIDI,
      { workletProcessCount: state.lastAuthority!.workletProcessCount },
    ));
    expect(duplicate).toBe(state);
    const reordered = observePitchTunnel(state, observation(
      state.lastAuthority!.endSample - HOP_SIZE,
      ANCHOR_MIDI,
    ));
    expect(reordered).toBe(state);
    const malformed = observePitchTunnel(state, observation(
      state.lastAuthority!.endSample + HOP_SIZE,
      ANCHOR_MIDI,
      { processedSampleCount: 17 },
    ));
    expect(malformed).toBe(state);
  });

  it("derives error, overshoot, stability, and occupancy from sample intervals", () => {
    let state = anchored({ requiredInLaneSeconds: 10 });
    state = observeNext(state, ANCHOR_MIDI + 0.1);
    state = observeNext(state, ANCHOR_MIDI - 0.1);
    const metrics = pitchTunnelMetrics(state);
    expect(metrics.elapsedSeconds).toBeCloseTo(0.04, 12);
    expect(metrics.timeInLaneSeconds).toBeCloseTo(0.04, 12);
    expect(metrics.inLaneRatio).toBe(1);
    expect(metrics.currentDistanceCents).toBeCloseTo(-10, 12);
    expect(metrics.meanSignedErrorCents).toBeCloseTo(2.5, 12);
    expect(metrics.meanAbsoluteErrorCents).toBeCloseTo(5, 12);
    expect(metrics.rmsErrorCents).toBeCloseTo(Math.sqrt(100 / 3), 12);
    expect(metrics.stabilityCents).toBeCloseTo(Math.sqrt(100 / 3 - 6.25), 12);
    expect(metrics.overshootCount).toBe(1);
  });

  it("measures correction latency from checkpoint entry and excludes the anchor", () => {
    let state = anchored({
      checkpointOffsetsCents: [0, 25],
      requiredInLaneSeconds: 0.04,
    });
    state = observeNext(state, ANCHOR_MIDI);
    state = observeNext(state, ANCHOR_MIDI);
    expect(state.checkpoint).toMatchObject({ index: 1, correctionLatencySeconds: null });
    expect(state.correctedCheckpointCount).toBe(0);

    state = observeNext(state, ANCHOR_MIDI + 0.25);
    expect(state.checkpoint?.correctionLatencySeconds).toBeCloseTo(0.02, 12);
    expect(state.correctedCheckpointCount).toBe(1);
    state = observeNext(state, ANCHOR_MIDI + 0.25);
    state = observeNext(state, ANCHOR_MIDI + 0.25);
    expect(state.status).toBe("tracking");
    expect(state.achievementReached).toBe(true);
    expect(pitchTunnelMetrics(state).meanCorrectionLatencySeconds).toBeCloseTo(0.02, 12);
  });

  it("waits for the first exact hop before correcting after a sample-authority break", () => {
    let state = anchored({
      checkpointOffsetsCents: [0, 25],
      requiredInLaneSeconds: 0.04,
    });
    state = observeNext(state, ANCHOR_MIDI);
    state = observeNext(state, ANCHOR_MIDI);
    expect(state.checkpoint).toMatchObject({ index: 1, correctionLatencySeconds: null });

    state = observePitchTunnel(state, observation(
      state.lastAuthority!.endSample + SAMPLE_RATE * 5,
      ANCHOR_MIDI + 0.25,
      { continuityEpoch: 1, discontinuity: true },
    ));
    expect(state.checkpoint?.correctionLatencySeconds).toBeNull();
    expect(state.correctedCheckpointCount).toBe(0);
    expect(state.elapsedSeconds).toBeCloseTo(0.04, 12);

    state = observeNext(state, ANCHOR_MIDI + 0.25, { continuityEpoch: 1 });
    expect(state.checkpoint?.correctionLatencySeconds).toBeCloseTo(0.02, 12);
    expect(state.correctedCheckpointCount).toBe(1);
  });

  it("latches the authored achievement while full trace scoring continues until user Finish", () => {
    let state = anchored({ checkpointOffsetsCents: [0], requiredInLaneSeconds: 0.02 });
    state = observeNext(state, ANCHOR_MIDI);
    expect(state.status).toBe("tracking");
    expect(state.achievementReached).toBe(true);
    const result = state.completedCheckpoints;
    const totalsAtAchievement = state.totals;
    const elapsedSeconds = state.elapsedSeconds;
    const frameCount = state.observedFrameCount;

    state = observeNext(state, null, { kind: "unvoiced" });
    expect(state).toMatchObject({
      status: "tracking",
      achievementReached: true,
      currentObservationKind: "unvoiced",
      currentMidiFloat: null,
      observedFrameCount: frameCount + 1,
    });
    expect(state.completedCheckpoints).toBe(result);
    expect(state.totals).toBe(totalsAtAchievement);
    expect(state.elapsedSeconds).toBeGreaterThan(elapsedSeconds);
    expect(state.trackingLossSeconds).toBeGreaterThan(0);

    state = observeNext(state, ANCHOR_MIDI + 0.5);
    state = observeNext(state, ANCHOR_MIDI + 0.5);
    expect(state.currentMidiFloat).toBeCloseTo(ANCHOR_MIDI + 0.5, 12);
    expect(state.lastAuthority).toBe(state.latestCandidate?.authority);
    expect(state.completedCheckpoints).toBe(result);
    expect(state.totals).not.toBe(totalsAtAchievement);
    expect(state.totals.trackedSeconds).toBeGreaterThan(totalsAtAchievement.trackedSeconds);
    expect(pitchTunnelMetrics(state).elapsedSeconds).toBeGreaterThan(elapsedSeconds);

    state = finishPitchTunnel(state);
    expect(state.status).toBe("complete");
    const explicitlyFinished = state;
    state = observeNext(state, ANCHOR_MIDI - 0.5);
    expect(state.status).toBe("complete");
    expect(state.currentMidiFloat).toBeCloseTo(ANCHOR_MIDI - 0.5, 12);
    expect(state.completedCheckpoints).toBe(explicitlyFinished.completedCheckpoints);
    expect(state.totals).toBe(explicitlyFinished.totals);
    expect(state.elapsedSeconds).toBe(explicitlyFinished.elapsedSeconds);
  });

  it("is cadence-independent at exact 20 ms capture hops", () => {
    let state = createPitchTunnel({ checkpointOffsetsCents: [0] });
    state = observePitchTunnel(state, observation(WINDOW_SIZE, ANCHOR_MIDI, {
      sampleRate: 44_100,
    }));
    state = startPitchTunnel(state);
    for (let frame = 1; frame <= 50; frame += 1) {
      state = observePitchTunnel(state, observation(
        WINDOW_SIZE + frame * 882,
        ANCHOR_MIDI,
        { sampleRate: 44_100 },
      ));
    }
    expect(state.status).toBe("tracking");
    expect(state.achievementReached).toBe(true);
    expect(state.completedCheckpoints[0]?.timeInLaneSeconds).toBeCloseTo(1, 12);
    expect(state.elapsedSeconds).toBeCloseTo(1, 12);
  });

  it("resets the exercise without inventing a second latest-frame authority", () => {
    let state = anchored();
    state = observeNext(state, ANCHOR_MIDI + 0.1);
    const currentAuthority = state.latestCandidate?.authority;
    state = resetPitchTunnel(state);
    expect(state.status).toBe("idle");
    expect(state.elapsedSeconds).toBe(0);
    expect(state.completedCheckpoints).toEqual([]);
    expect(state.latestCandidate?.authority).toBe(currentAuthority);
    expect(state.lastAuthority).toBe(currentAuthority);
    expect(startPitchTunnel(state).anchorMidiFloat).toBeCloseTo(ANCHOR_MIDI + 0.1, 12);
  });

  it("validates checkpoint and measurement configuration", () => {
    expect(() => createPitchTunnel({ checkpointOffsetsCents: [] })).toThrow(RangeError);
    expect(() => createPitchTunnel({ checkpointOffsetsCents: [Number.NaN] })).toThrow(RangeError);
    expect(() => createPitchTunnel({ laneHalfWidthCents: 0 })).toThrow(RangeError);
    expect(() => createPitchTunnel({ requiredInLaneSeconds: 0 })).toThrow(RangeError);
    expect(() => createPitchTunnel({ overshootDeadbandCents: -1 })).toThrow(RangeError);
    expect(() => createPitchTunnel({ overshootDeadbandCents: 10 })).toThrow(RangeError);
    expect(() => createPitchTunnel({ maximumCreditedIntervalSeconds: 0 })).toThrow(RangeError);
  });
});
