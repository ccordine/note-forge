import { describe, expect, it } from "vitest";
import type { PitchObservation, PitchObservationKind } from "../apps/web/src/audio/note-input";
import type { GeneratedResonanceLevel } from "../apps/web/src/features/voice-arcade/resonance-level";
import {
  createResonanceSession,
  reduceResonanceSession,
  resonanceHeldSeconds,
} from "../apps/web/src/features/voice-arcade/resonance-session";
import type { ResonanceLevelDefinition } from "../apps/web/src/features/voice-arcade/resonance-types";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const HOP_SIZE = 960;
const TARGET_MIDI = 48;

const SIMPLE_LEVEL = {
  id: "resonance-session-proof",
  room: { width: 8, height: 5 },
  obstacles: [],
  ball: { position: { x: 2, y: 2.5 }, radius: 0.3, linearDamping: 0.6 },
  goal: { position: { x: 7, y: 2.5 }, radius: 0.7 },
  microphone: {
    position: { x: 1, y: 2.5 },
    gain: 20,
    falloffRadius: 8,
    direction: { x: 1, y: 0 },
    directivity: 1,
  },
  resonators: [{
    id: "c3-field",
    position: { x: 3, y: 2.5 },
    targetMidi: TARGET_MIDI,
    bandwidthCents: 30,
    gain: 8,
    influenceRadius: 4,
    mode: "directional",
    direction: { x: 1, y: 0 },
  }],
} as const satisfies ResonanceLevelDefinition;

const GENERATED = {
  definition: SIMPLE_LEVEL,
  metadata: {
    seed: "resonance-session-proof",
    level: 1,
    difficulty: "easy",
    targetMidis: [TARGET_MIDI],
    routeWaypoints: [SIMPLE_LEVEL.ball.position, SIMPLE_LEVEL.goal.position],
  },
} as const satisfies GeneratedResonanceLevel;

function observation(
  index: number,
  midiFloat: number | null = TARGET_MIDI,
  kind: PitchObservationKind = midiFloat === null ? "unvoiced" : "voiced",
  overrides: Partial<PitchObservation> = {},
): PitchObservation {
  const startSample = index * HOP_SIZE;
  const endSample = startSample + WINDOW_SIZE;
  const voiced = kind === "voiced" && midiFloat !== null;
  const nearestMidi = midiFloat === null ? null : Math.round(midiFloat);
  const confidence = voiced ? 0.96 : kind === "unvoiced" ? 0.1 : 0.4;
  return {
    observationKind: kind,
    timeSeconds: (startSample + endSample) / (2 * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
    startSample,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: index + 1,
    discontinuity: false,
    frequencyHz: midiFloat === null ? null : 440 * 2 ** ((midiFloat - 69) / 12),
    midiFloat,
    nearestMidi,
    centsFromNearest: midiFloat === null ? null : (midiFloat - nearestMidi!) * 100,
    confidence,
    periodicity: confidence,
    rms: voiced ? 10 ** (-72 / 20) : 0,
    voiced,
    detector: "yin",
    reason: voiced ? "detected" : kind === "unvoiced" ? "no-periodic-candidate" : "below-confidence-threshold",
    periodSamples: voiced ? SAMPLE_RATE / (440 * 2 ** ((midiFloat! - 69) / 12)) : null,
    yinValue: voiced ? 1 - confidence : null,
    ...overrides,
  };
}

function trackingSession() {
  const idle = createResonanceSession({
    seed: "preview",
    level: 1,
    difficulty: "easy",
    lowMidi: 43,
    highMidi: 55,
    baselineMidi: TARGET_MIDI,
  });
  return reduceResonanceSession(idle, {
    type: "install",
    chamberNumber: 1,
    generated: GENERATED,
  });
}

describe("Resonance continuous observation session", () => {
  it("makes a generated chamber available in idle without tutorial proof", () => {
    const state = createResonanceSession({
      seed: "immediate-generated-room",
      level: 3,
      difficulty: "hard",
      lowMidi: 42,
      highMidi: 65,
      baselineMidi: 50,
    });
    expect(state.phase).toBe("idle");
    expect(state.chamberNumber).toBe(3);
    expect(state.generated.definition.resonators.length).toBeGreaterThan(0);
    expect(state.game.status).toBe("playing");
  });

  it("uses the first observation only as fresh authority, then moves by exact hops", () => {
    let state = trackingSession();
    const initialX = state.game.ball.position.x;
    state = reduceResonanceSession(state, { type: "observation", observation: observation(0) });
    expect(state.game.ball.position.x).toBe(initialX);
    expect(state.game.elapsedSeconds).toBe(0);

    state = reduceResonanceSession(state, { type: "observation", observation: observation(1) });
    expect(state.game.ball.position.x).toBeGreaterThan(initialX);
    expect(state.game.elapsedSeconds + state.game.accumulatorSeconds)
      .toBeCloseTo(HOP_SIZE / SAMPLE_RATE, 10);
    expect(state.game.fixedStepCount).toBeGreaterThan(0);
    expect(resonanceHeldSeconds(state)).toBeCloseTo(HOP_SIZE / SAMPLE_RATE, 12);
  });

  it("freezes occupancy for silence and uncertainty, but resets it for a credible wrong pitch", () => {
    let state = trackingSession();
    state = reduceResonanceSession(state, { type: "observation", observation: observation(0) });
    state = reduceResonanceSession(state, { type: "observation", observation: observation(1) });
    const held = state.targetDwell.heldSamples;

    state = reduceResonanceSession(state, {
      type: "observation",
      observation: observation(2, null, "unvoiced"),
    });
    expect(state.targetDwell.heldSamples).toBe(held);
    expect(state.game.voice.active).toBe(false);

    state = reduceResonanceSession(state, {
      type: "observation",
      observation: observation(3, null, "uncertain"),
    });
    expect(state.targetDwell.heldSamples).toBe(held);

    state = reduceResonanceSession(state, {
      type: "observation",
      observation: observation(4, TARGET_MIDI + 2),
    });
    expect(state.targetDwell.heldSamples).toBe(0);
  });

  it("never catches up across a missing observation or continuity boundary", () => {
    let state = trackingSession();
    state = reduceResonanceSession(state, { type: "observation", observation: observation(0) });
    state = reduceResonanceSession(state, { type: "observation", observation: observation(1) });
    const beforeGap = state.game.ball.position;
    const elapsedBeforeGap = state.game.elapsedSeconds + state.game.accumulatorSeconds;

    state = reduceResonanceSession(state, { type: "observation", observation: observation(4) });
    expect(state.game.ball.position).toEqual(beforeGap);
    expect(state.game.elapsedSeconds + state.game.accumulatorSeconds).toBe(elapsedBeforeGap);

    state = reduceResonanceSession(state, { type: "observation", observation: observation(5) });
    expect(state.game.elapsedSeconds + state.game.accumulatorSeconds)
      .toBeCloseTo(elapsedBeforeGap + HOP_SIZE / SAMPLE_RATE, 10);

    const beforeBoundary = state.game.ball.position;
    state = reduceResonanceSession(state, {
      type: "observation",
      observation: observation(0, TARGET_MIDI, "voiced", {
        continuityEpoch: 1,
        graphGeneration: 1,
        discontinuity: true,
      }),
    });
    expect(state.game.ball.position).toEqual(beforeBoundary);
  });

  it("ignores duplicate frames and keeps the microphone-independent run model restartable", () => {
    let state = trackingSession();
    state = reduceResonanceSession(state, { type: "observation", observation: observation(0) });
    const duplicate = reduceResonanceSession(state, {
      type: "observation",
      observation: observation(0, 55),
    });
    expect(duplicate).toBe(state);

    const restarted = reduceResonanceSession(state, { type: "restart" });
    expect(restarted.phase).toBe("tracking");
    expect(restarted.runSerial).toBe(state.runSerial + 1);
    expect(restarted.controller.authority).toBeNull();
    expect(restarted.game.elapsedSeconds).toBe(0);
  });
});
