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

const OPTIONS = Object.freeze({
  directionNotes: NOTES,
  requiredHoldSeconds: 0.4,
  toleranceCents: 35,
}) satisfies PitchMazeControllerOptions;

function detected(
  timeSeconds: number,
  midiFloat: number,
  confidence = 0.95,
): PitchMazeVoiceFrame {
  return {
    timeSeconds,
    midiFloat,
    confidence,
    voiced: true,
    detector: "yin",
    reason: "detected",
  };
}

function silence(timeSeconds: number): PitchMazeVoiceFrame {
  return {
    timeSeconds,
    midiFloat: null,
    confidence: 0,
    voiced: false,
    detector: "yin",
    reason: "below-rms-threshold",
  };
}

function uncertain(timeSeconds: number, midiFloat: number | null = null): PitchMazeVoiceFrame {
  return {
    timeSeconds,
    midiFloat,
    confidence: 0.2,
    voiced: false,
    detector: "yin",
    reason: "below-confidence-threshold",
  };
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
  const frames = errorsCents.map((error, index) => detected(index * 0.1, 60 + error / 100));
  const result = feed(createPitchMazeController(OPTIONS), frames);
  const complete = result.events.find((event) => event.type === "command-complete");
  if (!complete || complete.type !== "command-complete") {
    throw new Error("Synthetic trace did not complete a command.");
  }
  return { state: result.state, command: complete.command };
}

describe("Pitch Maze voice controller", () => {
  it("rejects noise, uncertain interpretations, low confidence, and unrelated pitch", () => {
    const result = feed(createPitchMazeController(OPTIONS), [
      silence(0),
      uncertain(0.1, 60),
      detected(0.2, 60, 0.4),
      detected(0.3, 55),
      silence(0.4),
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

    state = updatePitchMazeController(state, detected(0.1, 60.52)).state;
    expect(state.activeDirection).toBe("north");

    state = updatePitchMazeController(state, detected(0.2, 60.56)).state;
    expect(state.activeDirection).toBe("east");
    expect(state.sustain?.heldSeconds).toBe(0);
  });

  it("never completes an unstable trace that jumps between mapped notes", () => {
    const frames = Array.from({ length: 14 }, (_, index) => (
      detected(index * 0.1, index % 2 === 0 ? 60.02 : 60.98)
    ));
    const result = feed(createPitchMazeController(OPTIONS), frames);

    expect(result.events).toEqual([]);
    expect(result.state.completedCommandCount).toBe(0);
    expect(result.state.phase).toBe("tracking");
    expect(result.state.sustain?.heldSeconds).toBe(0);
  });

  it("captures signed attack, settling, overshoot, spread, and a deterministic grade", () => {
    const { state, command } = completedTrace([-30, -12, 8, 4, 2]);

    expect(state.phase).toBe("awaiting-release");
    expect(state.completedCommandCount).toBe(1);
    expect(command).toMatchObject({
      direction: "north",
      targetMidi: 60,
      attackErrorCents: expect.closeTo(-30, 8),
      settleTimeSeconds: expect.closeTo(0.1, 8),
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
      ...Array.from({ length: 5 }, (_, index) => detected(index * 0.1, 60)),
      ...Array.from({ length: 12 }, (_, index) => detected(0.5 + index * 0.1, 60)),
    ]);

    expect(result.events.filter((event) => event.type === "command-complete")).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "rearmed")).toHaveLength(0);
    expect(result.state).toMatchObject({
      phase: "awaiting-release",
      releaseProgress: 0,
      completedCommandCount: 1,
    });
  });

  it("does not mistake a low-confidence detector frame for a release", () => {
    const completed = completedTrace([0, 0, 0, 0, 0]).state;
    const result = feed(completed, [
      uncertain(0.5, 60),
      uncertain(0.8, 60),
      uncertain(1.2, 60),
    ]);

    expect(result.events).toEqual([]);
    expect(result.state.phase).toBe("awaiting-release");
    expect(result.state.releaseProgress).toBe(0);
  });

  it("re-arms after a continuous 275 ms release and accepts a new direction", () => {
    let state = completedTrace([0, 0, 0, 0, 0]).state;

    const release = feed(state, [silence(0.5), silence(0.7), silence(0.775)]);
    state = release.state;
    expect(release.events).toEqual([{ type: "rearmed" }]);
    expect(state.phase).toBe("armed");

    const second = feed(state, [
      detected(0.8, 61),
      detected(0.9, 61),
      detected(1, 61),
      detected(1.1, 61),
      detected(1.2, 61),
    ]);
    const movement = second.events.find((event) => event.type === "command-complete");
    expect(movement).toMatchObject({
      type: "command-complete",
      command: { direction: "east", targetMidi: 61 },
    });
    expect(second.state.completedCommandCount).toBe(2);
  });

  it("grades precise movement substantially above coarse movement", () => {
    const precise = completedTrace([3, 2, -1, 1, 0]).command;
    const coarse = completedTrace([34, -32, 30, -28, 26]).command;

    expect(precise.meanAbsoluteErrorCents).toBeLessThan(coarse.meanAbsoluteErrorCents);
    expect(precise.spreadCents).toBeLessThan(coarse.spreadCents);
    expect(precise.overshootCount).toBeLessThan(coarse.overshootCount);
    expect(precise.qualityScore).toBeGreaterThan(coarse.qualityScore + 25);
  });

  it("validates ambiguous mappings and controller timing options", () => {
    expect(() => createPitchMazeController({
      ...OPTIONS,
      directionNotes: { ...NOTES, east: 60 },
    })).toThrow(/distinct note/i);
    expect(() => createPitchMazeController({ ...OPTIONS, requiredHoldSeconds: 0 })).toThrow(RangeError);
    expect(() => createPitchMazeController({ ...OPTIONS, minimumConfidence: 1.1 })).toThrow(RangeError);
    expect(() => createPitchMazeController({ ...OPTIONS, releaseDurationSeconds: 0 })).toThrow(RangeError);
  });
});
