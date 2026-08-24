import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  createPitchMazeSession,
  reducePitchMazeSession,
  type PitchMazeCampaignSpec,
  type PitchMazeSessionState,
} from "../apps/web/src/features/voice-arcade/pitch-maze-session";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const HOP_SIZE = 960;
const CAMPAIGN = Object.freeze({
  seed: "pitch-maze-session-proof",
  difficulty: "easy",
  curriculumStage: "deliberate",
  voiceRange: Object.freeze({ lowMidi: 43, highMidi: 64, baselineMidi: 49 }),
  mappingMode: "adjacent",
}) satisfies PitchMazeCampaignSpec;

function observation(index: number, midiFloat: number | null): PitchObservation {
  const endSample = WINDOW_SIZE + index * HOP_SIZE;
  const startSample = endSample - WINDOW_SIZE;
  const voiced = midiFloat !== null;
  const nearestMidi = voiced ? Math.round(midiFloat) : null;
  return Object.freeze({
    observationKind: voiced ? "voiced" : "unvoiced",
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
    frequencyHz: voiced ? 440 * 2 ** ((midiFloat - 69) / 12) : null,
    midiFloat,
    nearestMidi,
    centsFromNearest: voiced ? (midiFloat - nearestMidi!) * 100 : null,
    rms: voiced ? 0.02 : 0,
    confidence: voiced ? 0.96 : 0,
    voiced,
    detector: "yin",
    periodSamples: voiced ? 184 : null,
    yinValue: voiced ? 0.04 : null,
    reason: voiced ? "detected" : "below-rms-threshold",
    periodicity: voiced ? 0.96 : 0,
  });
}

function feed(
  initial: PitchMazeSessionState,
  frames: readonly PitchObservation[],
): PitchMazeSessionState {
  return frames.reduce(
    (state, frame) => reducePitchMazeSession(state, { type: "observation", observation: frame }),
    initial,
  );
}

describe("Pitch Maze pure campaign session", () => {
  it("uses only user-commanded setup and campaign progression phases", () => {
    const setup = createPitchMazeSession();
    expect(setup).toMatchObject({ phase: "setup", level: null, outcome: null });

    const playing = reducePitchMazeSession(setup, { type: "start", campaign: CAMPAIGN });
    expect(playing).toMatchObject({
      phase: "playing",
      levelNumber: 1,
      campaignStartedAtSeconds: null,
      levelStartedAtSeconds: null,
    });
    expect(playing.level).not.toBeNull();
    expect(playing.controller).not.toBeNull();
  });

  it("derives one command from note occupancy and never auto-repeats a held note", () => {
    let state = reducePitchMazeSession(createPitchMazeSession(), {
      type: "start",
      campaign: CAMPAIGN,
    });
    const northMidi = state.level!.directionNotes.north;
    state = feed(state, Array.from({ length: 32 }, (_, index) => observation(index, northMidi)));

    expect(state.commands).toHaveLength(1);
    expect(state.commands[0]).toMatchObject({ direction: "north", level: 1 });
    expect(state.controller).toMatchObject({
      phase: "armed",
      committedDirection: "north",
      completedCommandCount: 1,
    });
    expect(state.campaignStartedAtSeconds).toBe(observation(0, northMidi).timeSeconds);
  });

  it("accepts an adjacent note directly with no release countdown", () => {
    let state = reducePitchMazeSession(createPitchMazeSession(), {
      type: "start",
      campaign: CAMPAIGN,
    });
    const northMidi = state.level!.directionNotes.north;
    const eastMidi = state.level!.directionNotes.east;
    state = feed(state, Array.from({ length: 32 }, (_, index) => observation(index, northMidi)));
    state = feed(state, Array.from({ length: 32 }, (_, index) => observation(index + 32, eastMidi)));

    expect(state.commands.map((command) => command.direction)).toEqual(["north", "east"]);
  });

  it("ignores observations outside the playing phase", () => {
    const setup = createPitchMazeSession("random");
    const next = reducePitchMazeSession(setup, {
      type: "observation",
      observation: observation(0, 49),
    });
    expect(next).toBe(setup);
  });
});
