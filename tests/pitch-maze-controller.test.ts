import { describe, expect, it } from "vitest";
import {
  createPitchMazeController,
  selectPitchMazeDirection,
  updatePitchMazeController,
  type PitchMazeControllerEvent,
  type PitchMazeControllerOptions,
  type PitchMazeControllerState,
  type PitchMazeVoiceFrame,
} from "../apps/web/src/features/voice-arcade/pitch-maze-controller";
import type { PitchMazeDirectionNotes } from "../apps/web/src/features/voice-arcade/pitch-maze-model";

const NOTES = Object.freeze({
  north: 60,
  east: 61,
  south: 62,
  west: 63,
}) satisfies PitchMazeDirectionNotes;

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const HOP_SECONDS = 0.02;

const OPTIONS = Object.freeze({
  directionNotes: NOTES,
  requiredHoldSeconds: 0.08,
  toleranceCents: 35,
}) satisfies PitchMazeControllerOptions;

function observation(
  offsetSeconds: number,
  kind: PitchMazeVoiceFrame["observationKind"],
  midiFloat: number | null,
  confidence: number,
): PitchMazeVoiceFrame {
  const endSample = WINDOW_SIZE + Math.round(offsetSeconds * SAMPLE_RATE);
  const startSample = endSample - WINDOW_SIZE;
  const voiced = kind === "voiced";
  const nearestMidi = midiFloat === null ? null : Math.round(midiFloat);
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
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: false,
    frequencyHz: midiFloat === null ? null : 440 * 2 ** ((midiFloat - 69) / 12),
    midiFloat,
    nearestMidi,
    centsFromNearest: midiFloat === null || nearestMidi === null
      ? null
      : (midiFloat - nearestMidi) * 100,
    rms: voiced ? 0.02 : 0,
    confidence,
    voiced,
    detector: "yin",
    periodSamples: voiced ? 184 : null,
    yinValue: voiced ? 1 - confidence : null,
    reason: kind === "voiced"
      ? "detected"
      : kind === "unvoiced"
        ? "below-rms-threshold"
        : "below-confidence-threshold",
    periodicity: voiced ? confidence : 0,
  };
}

function detected(
  timeSeconds: number,
  midiFloat: number,
  confidence = 0.95,
): PitchMazeVoiceFrame {
  return observation(timeSeconds, "voiced", midiFloat, confidence);
}

function silence(timeSeconds: number): PitchMazeVoiceFrame {
  return observation(timeSeconds, "unvoiced", null, 0);
}

function uncertain(timeSeconds: number, midiFloat: number | null = null): PitchMazeVoiceFrame {
  return observation(timeSeconds, "uncertain", midiFloat, 0.2);
}

function feed(
  initial: PitchMazeControllerState,
  frames: readonly PitchMazeVoiceFrame[],
): { state: PitchMazeControllerState; events: PitchMazeControllerEvent[] } {
  let state = initial;
  const events: PitchMazeControllerEvent[] = [];
  for (const frame of frames) {
    const update = updatePitchMazeController(state, frame);
    state = update.state;
    if (update.event !== null) events.push(update.event);
  }
  return { state, events };
}

function completedTrace(errorsCents: readonly number[]): {
  state: PitchMazeControllerState;
  command: Extract<PitchMazeControllerEvent, { type: "command-complete" }>["command"];
} {
  const frames = errorsCents.map((error, index) => detected(index * HOP_SECONDS, 60 + error / 100));
  const result = feed(createPitchMazeController(OPTIONS), frames);
  const complete = result.events.find((event) => event.type === "command-complete");
  if (!complete || complete.type !== "command-complete") {
    throw new Error("Synthetic trace did not complete a command.");
  }
  return { state: result.state, command: complete.command };
}

describe("Pitch Maze voice controller", () => {
  it("rejects noise, uncertain interpretations, and unrelated pitch while admitting detector-voiced low confidence", () => {
    const lowConfidence = updatePitchMazeController(
      createPitchMazeController(OPTIONS),
      detected(0, 60, 0.01),
    );
    expect(lowConfidence.state).toMatchObject({
      phase: "tracking",
      activeDirection: "north",
    });

    const result = feed(createPitchMazeController(OPTIONS), [
      silence(0),
      uncertain(0.02, 60),
      detected(0.04, 55),
      silence(0.06),
    ]);

    expect(result.events).toEqual([]);
    expect(result.state).toMatchObject({
      phase: "armed",
      activeDirection: null,
      completedCommandCount: 0,
    });
  });

  it("distinguishes adjacent semitones and rejects the exact boundary", () => {
    expect(selectPitchMazeDirection(NOTES, 60.47)).toMatchObject({
      direction: "north",
      targetMidi: 60,
      errorCents: expect.closeTo(47, 8),
    });
    expect(selectPitchMazeDirection(NOTES, 60.5)).toBeNull();
    expect(selectPitchMazeDirection(NOTES, 60.53)).toMatchObject({
      direction: "east",
      targetMidi: 61,
      errorCents: expect.closeTo(-47, 8),
    });

    const update = updatePitchMazeController(
      createPitchMazeController(OPTIONS),
      detected(0, 61.02),
    );
    expect(update.state).toMatchObject({
      phase: "tracking",
      activeDirection: "east",
      activeTargetMidi: 61,
    });
  });

  it("uses hysteresis to hold intent near a boundary without conflating the notes", () => {
    let state = updatePitchMazeController(
      createPitchMazeController(OPTIONS),
      detected(0, 60.45),
    ).state;
    expect(state.activeDirection).toBe("north");

    state = updatePitchMazeController(state, detected(0.02, 60.52)).state;
    expect(state.activeDirection).toBe("north");

    state = updatePitchMazeController(state, detected(0.04, 60.56)).state;
    expect(state.activeDirection).toBe("east");
    expect(state.dwell?.heldSeconds).toBe(0);
  });

  it("never completes an unstable trace that jumps between mapped notes", () => {
    const frames = Array.from({ length: 14 }, (_, index) => (
      detected(index * HOP_SECONDS, index % 2 === 0 ? 60.02 : 60.98)
    ));
    const result = feed(createPitchMazeController(OPTIONS), frames);

    expect(result.events).toEqual([]);
    expect(result.state.completedCommandCount).toBe(0);
    expect(result.state.phase).toBe("tracking");
    expect(result.state.dwell?.heldSeconds).toBe(0);
  });

  it("pauses exact earned dwell through silence and uncertainty, then resumes without catch-up", () => {
    let state = createPitchMazeController(OPTIONS);
    for (const frame of [detected(0, 60), detected(0.02, 60), detected(0.04, 60)]) {
      state = updatePitchMazeController(state, frame).state;
    }
    expect(state.dwell).toMatchObject({
      heldSamples: 1_920,
      heldSeconds: 0.04,
      previousFrameQualified: true,
    });

    state = updatePitchMazeController(state, silence(0.06)).state;
    expect(state.dwell).toMatchObject({
      heldSamples: 1_920,
      heldSeconds: 0.04,
      previousFrameQualified: false,
      currentObservationKind: "unvoiced",
    });
    state = updatePitchMazeController(state, uncertain(0.08, 61)).state;
    expect(state.dwell).toMatchObject({
      heldSamples: 1_920,
      heldSeconds: 0.04,
      previousFrameQualified: false,
      currentObservationKind: "uncertain",
    });

    state = updatePitchMazeController(state, detected(0.1, 60)).state;
    expect(state.dwell?.heldSamples).toBe(1_920);
    state = updatePitchMazeController(state, detected(0.12, 60)).state;
    expect(state.dwell?.heldSamples).toBe(2_880);
    const completed = updatePitchMazeController(state, detected(0.14, 60));
    expect(completed.event).toMatchObject({
      type: "command-complete",
      command: { direction: "north" },
    });
    expect(completed.state.completedCommandCount).toBe(1);
  });

  it("resets partial dwell only for credible voiced evidence outside tolerance", () => {
    let state = createPitchMazeController(OPTIONS);
    for (const frame of [detected(0, 60), detected(0.02, 60), detected(0.04, 60)]) {
      state = updatePitchMazeController(state, frame).state;
    }
    expect(state.dwell?.heldSamples).toBe(1_920);

    state = updatePitchMazeController(state, detected(0.06, 60.4)).state;
    expect(state).toMatchObject({ phase: "tracking", activeDirection: "north" });
    expect(state.dwell).toMatchObject({
      heldSamples: 0,
      heldSeconds: 0,
      currentInTolerance: false,
      previousFrameQualified: false,
    });
  });

  it("captures signed attack, settling, overshoot, spread, and a deterministic grade", () => {
    const { state, command } = completedTrace([-30, -12, 8, 4, 2]);

    expect(state.phase).toBe("armed");
    expect(state.committedDirection).toBe("north");
    expect(state.completedCommandCount).toBe(1);
    expect(command).toMatchObject({
      direction: "north",
      targetMidi: 60,
      attackErrorCents: expect.closeTo(-30, 8),
      settleTimeSeconds: expect.closeTo(0.02, 8),
      overshootCount: 1,
      sampleCount: 5,
      inBandSampleCount: 5,
      inBandRatio: 1,
      meanAbsoluteErrorCents: expect.closeTo(11.2, 8),
      meanSignedErrorCents: expect.closeTo(-5.6, 8),
      qualityScore: expect.any(Number),
    });
    expect(command.spreadCents).toBeGreaterThan(0);
    expect(command.qualityScore).toBeGreaterThanOrEqual(0);
    expect(command.qualityScore).toBeLessThanOrEqual(100);
    expect(state.lastCommand).toEqual(command);
  });

  it("emits only one movement while the same note remains continuously held", () => {
    const result = feed(createPitchMazeController(OPTIONS), [
      ...Array.from({ length: 5 }, (_, index) => detected(index * HOP_SECONDS, 60)),
      ...Array.from({ length: 12 }, (_, index) => detected((index + 5) * HOP_SECONDS, 60)),
    ]);

    expect(result.events.filter((event) => event.type === "command-complete")).toHaveLength(1);
    expect(result.state).toMatchObject({
      phase: "armed",
      committedDirection: "north",
      completedCommandCount: 1,
    });
  });

  it("does not mistake uncertain evidence for departure or auto-repeat", () => {
    const completed = completedTrace([0, 0, 0, 0, 0]).state;
    const result = feed(completed, [
      uncertain(0.1, 60),
      uncertain(0.12, 60),
      uncertain(0.14, 60),
      detected(0.16, 60),
      detected(0.18, 60),
      detected(0.2, 60),
      detected(0.22, 60),
      detected(0.24, 60),
    ]);

    expect(result.events).toEqual([]);
    expect(result.state.phase).toBe("armed");
    expect(result.state.committedDirection).toBe("north");
  });

  it("accepts a new direction immediately after one unvoiced observation", () => {
    let state = completedTrace([0, 0, 0, 0, 0]).state;

    state = updatePitchMazeController(state, silence(0.1)).state;
    expect(state.phase).toBe("armed");
    expect(state.committedDirection).toBeNull();

    const second = feed(state, [
      detected(0.12, 61),
      detected(0.14, 61),
      detected(0.16, 61),
      detected(0.18, 61),
      detected(0.2, 61),
    ]);
    const movement = second.events.find((event) => event.type === "command-complete");
    expect(movement).toMatchObject({
      type: "command-complete",
      command: { direction: "east", targetMidi: 61 },
    });
    expect(second.state.completedCommandCount).toBe(2);
  });

  it("can begin an adjacent direction without a silence ceremony", () => {
    const completed = completedTrace([0, 0, 0, 0, 0]).state;
    const switched = feed(completed, [
      detected(0.1, 61),
      detected(0.12, 61),
      detected(0.14, 61),
      detected(0.16, 61),
      detected(0.18, 61),
    ]);

    expect(switched.events).toHaveLength(1);
    expect(switched.events[0]).toMatchObject({
      type: "command-complete",
      command: { direction: "east" },
    });
  });

  it("grades precise movement substantially above coarse movement", () => {
    const precise = completedTrace([3, 2, -1, 1, 0]).command;
    const coarse = completedTrace([34, -32, 30, -28, 26]).command;

    expect(precise.meanAbsoluteErrorCents).toBeLessThan(coarse.meanAbsoluteErrorCents);
    expect(precise.spreadCents).toBeLessThan(coarse.spreadCents);
    expect(precise.overshootCount).toBeLessThan(coarse.overshootCount);
    expect(precise.qualityScore).toBeGreaterThan(coarse.qualityScore + 25);
  });

  it("validates ambiguous mappings and controller options", () => {
    expect(() => createPitchMazeController({
      ...OPTIONS,
      directionNotes: { ...NOTES, east: 60 },
    })).toThrow(/distinct note/i);
    expect(() => createPitchMazeController({ ...OPTIONS, requiredHoldSeconds: 0 })).toThrow(RangeError);
  });
});
