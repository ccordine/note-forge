import { describe, expect, it } from "vitest";
import {
  midiToFrequency,
  type YinPitchFrame,
} from "@noteforge/pitch-engine";
import { NoteInputEngine } from "../apps/web/src/audio/note-input";
import {
  VOICE_AXIS_MINIMUM_CONFIDENCE,
  advanceVoiceAxisController,
  createVoiceAxisController,
  freezeVoiceAxisController,
  isVoiceAxisFrameReliable,
  updateVoiceAxisFromFrame,
  type VoiceAxisControllerOptions,
  type VoiceAxisFrame,
} from "../apps/web/src/features/voice-arcade/voice-axis-controller";

const OPTIONS = Object.freeze({
  lowMidi: 48,
  highMidi: 60,
  centerMidi: 54,
  deadZoneCents: 20,
  responsePerSecond: 10,
}) satisfies VoiceAxisControllerOptions;

function detected(
  timeSeconds: number,
  midiFloat: number,
  confidence = 0.95,
): VoiceAxisFrame {
  return {
    timeSeconds,
    midiFloat,
    confidence,
    voiced: true,
    detector: "yin",
    reason: "detected",
  };
}

function unvoiced(
  timeSeconds: number,
  reason: VoiceAxisFrame["reason"] = "below-rms-threshold",
): VoiceAxisFrame {
  return {
    timeSeconds,
    midiFloat: null,
    confidence: 0,
    voiced: false,
    detector: "yin",
    reason,
  };
}

describe("shared continuous voice axis", () => {
  it("maps low, center, and high pitch through the canonical vertical mapper", () => {
    let state = createVoiceAxisController(OPTIONS);
    let update = updateVoiceAxisFromFrame(state, detected(0, 48));
    expect(update).toMatchObject({
      accepted: true,
      mapping: { normalizedY: 1, clampedMidi: 48, inDeadZone: false },
      state: { status: "steering", targetPosition: 1, pitchMidi: 48 },
    });

    state = update.state;
    update = updateVoiceAxisFromFrame(state, detected(0.1, 54.1));
    expect(update.mapping).toMatchObject({ normalizedY: 0.5, inDeadZone: true });

    state = update.state;
    update = updateVoiceAxisFromFrame(state, detected(0.2, 60));
    expect(update.mapping).toMatchObject({ normalizedY: 0, clampedMidi: 60 });
    expect(update.state).toMatchObject({ observedFrameCount: 3, acceptedFrameCount: 3 });
  });

  it("uses one fixed production evidence floor instead of a difficulty setting", () => {
    expect(VOICE_AXIS_MINIMUM_CONFIDENCE).toBe(0.55);
    expect(isVoiceAxisFrameReliable(detected(0, 54, VOICE_AXIS_MINIMUM_CONFIDENCE))).toBe(true);
    expect(isVoiceAxisFrameReliable(detected(0, 54, VOICE_AXIS_MINIMUM_CONFIDENCE - 0.001))).toBe(false);
    expect(isVoiceAxisFrameReliable({
      ...detected(0, 54),
      voiced: false,
      reason: "no-periodic-candidate",
    })).toBe(false);
  });

  it("freezes exactly where it is when silence arrives", () => {
    let state = createVoiceAxisController(OPTIONS);
    state = updateVoiceAxisFromFrame(state, detected(0, 60)).state;
    state = advanceVoiceAxisController(state, { deltaSeconds: 0.05 });
    const partiallyRaisedPosition = state.position;
    expect(partiallyRaisedPosition).toBeGreaterThan(0);
    expect(partiallyRaisedPosition).toBeLessThan(0.5);

    state = updateVoiceAxisFromFrame(state, unvoiced(0.1)).state;
    expect(state).toMatchObject({
      status: "unvoiced",
      targetPosition: partiallyRaisedPosition,
      pitchMidi: null,
    });
    const afterBreath = advanceVoiceAxisController(state, { deltaSeconds: 1.9 });
    expect(afterBreath.position).toBe(partiallyRaisedPosition);
  });

  it("uses PCM evidence rather than a wall-clock freshness watchdog", () => {
    let state = createVoiceAxisController(OPTIONS);
    state = updateVoiceAxisFromFrame(state, detected(0, 48)).state;
    state = advanceVoiceAxisController(state, { deltaSeconds: 0.1 });
    expect(state.status).toBe("steering");
    const firstPosition = state.position;
    state = advanceVoiceAxisController(state, { deltaSeconds: 10 });
    expect(state.status).toBe("steering");
    expect(state.position).toBeGreaterThan(firstPosition);
    expect(state.position).toBeCloseTo(1, 10);
  });

  it("applies response by elapsed time rather than render-frame count", () => {
    const observed = updateVoiceAxisFromFrame(
      createVoiceAxisController(OPTIONS),
      detected(0, 60),
    ).state;
    const oneStep = advanceVoiceAxisController(observed, {
      deltaSeconds: 0.1,
    });
    const firstHalf = advanceVoiceAxisController(observed, {
      deltaSeconds: 0.05,
    });
    const twoHalves = advanceVoiceAxisController(firstHalf, {
      deltaSeconds: 0.05,
    });
    expect(twoHalves.position).toBeCloseTo(oneStep.position, 12);
  });

  it("ignores duplicate, out-of-order, and invalid detector timestamps", () => {
    const accepted = updateVoiceAxisFromFrame(
      createVoiceAxisController(OPTIONS),
      detected(1, 48),
    ).state;
    expect(updateVoiceAxisFromFrame(accepted, detected(1, 60)).state).toBe(accepted);
    expect(updateVoiceAxisFromFrame(accepted, detected(0.9, 60)).state).toBe(accepted);
    expect(updateVoiceAxisFromFrame(accepted, detected(Number.NaN, 60)).state).toBe(accepted);
  });

  it("distinguishes uncertainty from explicit unvoiced evidence", () => {
    let state = createVoiceAxisController(OPTIONS);
    state = updateVoiceAxisFromFrame(
      state,
      unvoiced(0, "below-confidence-threshold"),
    ).state;
    expect(state.status).toBe("uncertain");
    state = updateVoiceAxisFromFrame(state, unvoiced(0.1, "no-periodic-candidate")).state;
    expect(state.status).toBe("unvoiced");
  });

  it("supports an explicit game pause without resetting the coordinate", () => {
    let state = createVoiceAxisController(OPTIONS);
    state = updateVoiceAxisFromFrame(state, detected(0, 48)).state;
    state = advanceVoiceAxisController(state, { deltaSeconds: 0.1 });
    const frozen = freezeVoiceAxisController(state);
    expect(frozen).toMatchObject({
      status: "idle",
      position: state.position,
      targetPosition: state.position,
      pitchMidi: null,
    });
  });

  it("validates controller geometry, response, and game-frame deltas", () => {
    expect(() => createVoiceAxisController({ ...OPTIONS, lowMidi: 60 })).toThrow(RangeError);
    expect(() => createVoiceAxisController({ ...OPTIONS, centerMidi: 60 })).toThrow(RangeError);
    expect(() => createVoiceAxisController({ ...OPTIONS, deadZoneCents: -1 })).toThrow(RangeError);
    expect(() => createVoiceAxisController({ ...OPTIONS, responsePerSecond: 0 })).toThrow(RangeError);
    expect(() => createVoiceAxisController({ ...OPTIONS, initialPosition: 1.01 })).toThrow(RangeError);

    const state = createVoiceAxisController(OPTIONS);
    expect(() => advanceVoiceAxisController(state, { deltaSeconds: -0.1 })).toThrow(RangeError);
  });
});

function harmonicWindow(midi: number, windowIndex: number): Float32Array {
  const sampleRate = 48_000;
  const windowSize = 4_096;
  const frequency = midiToFrequency(midi);
  return Float32Array.from({ length: windowSize }, (_, index) => {
    const time = (windowIndex * windowSize + index) / sampleRate;
    return 0.2 * Math.sin(2 * Math.PI * frequency * time)
      + 0.08 * Math.sin(4 * Math.PI * frequency * time + 0.3)
      + 0.03 * Math.sin(6 * Math.PI * frequency * time + 0.8);
  });
}

function detectProductionFrame(samples: Float32Array, timeSeconds: number): YinPitchFrame {
  const sampleRate = 48_000;
  const startSample = Math.max(0, Math.round(timeSeconds * sampleRate - samples.length / 2));
  const endSample = startSample + samples.length;
  return new NoteInputEngine().process({
    samples,
    sampleRate,
    capturedAt: (startSample + endSample) / (2 * sampleRate),
    startSample,
    endSample,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    processCount: endSample,
    processedSampleCount: endSample,
    discontinuity: startSample === 0,
  }).observation;
}

describe("continuous voice-axis PCM integration (not browser proof)", () => {
  it("turns the first direct harmonic PCM result into steering, then freezes on silence", () => {
    const windowSeconds = 4_096 / 48_000;
    let state = createVoiceAxisController(OPTIONS);
    const frame = detectProductionFrame(harmonicWindow(60, 0), 0.5 * windowSeconds);
    const update = updateVoiceAxisFromFrame(state, frame);
    state = update.state;

    expect(frame).toMatchObject({ voiced: true, nearestMidi: 60, reason: "detected" });
    expect(update.accepted).toBe(true);
    expect(state).toMatchObject({
      status: "steering",
      targetPosition: 0,
      pitchMidi: expect.closeTo(60, 2),
    });

    const silence = detectProductionFrame(
      new Float32Array(4_096),
      1.5 * windowSeconds,
    );
    state = updateVoiceAxisFromFrame(state, silence).state;
    expect(state.status).not.toBe("steering");
    const position = state.position;
    expect(advanceVoiceAxisController(state, { deltaSeconds: 0.5 }).position).toBe(position);
  });
});
