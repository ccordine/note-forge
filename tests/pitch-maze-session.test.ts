import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  PITCH_MAZE_MAX_RETAINED_COMMANDS,
  createPitchMazeSession,
  reducePitchMazeSession,
  type PitchMazeCampaignSpec,
  type PitchMazeSessionState,
} from "../apps/web/src/features/voice-arcade/pitch-maze-session";
import {
  applyCompletedPitchMazeMove,
  getPitchMazeLegalDirections,
  getPitchMazeShortestPathLength,
  type CardinalDirection,
} from "../apps/web/src/features/voice-arcade/pitch-maze-model";

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

function nextSolutionDirection(state: Readonly<PitchMazeSessionState>): CardinalDirection {
  const level = state.level!;
  const distance = getPitchMazeShortestPathLength(level);
  const direction = getPitchMazeLegalDirections(level).find((candidate) => {
    const moved = applyCompletedPitchMazeMove(level, candidate);
    return moved.moved && getPitchMazeShortestPathLength(moved.level) === distance - 1;
  });
  if (!direction) throw new Error("Pitch Maze fixture could not find its next solution move.");
  return direction;
}

function solveCurrentLevel(
  initial: PitchMazeSessionState,
  initialObservationIndex = 0,
): Readonly<{ state: PitchMazeSessionState; nextObservationIndex: number }> {
  let state = initial;
  let index = initialObservationIndex;
  while (state.currentResult === null) {
    const direction = nextSolutionDirection(state);
    state = reducePitchMazeSession(state, { type: "observation", observation: observation(index, null) });
    index += 1;
    const midi = state.level!.directionNotes[direction];
    state = feed(state, Array.from({ length: 36 }, () => {
      const frame = observation(index, midi);
      index += 1;
      return frame;
    }));
  }
  return Object.freeze({ state, nextObservationIndex: index });
}

function issueCommand(
  initial: PitchMazeSessionState,
  direction: CardinalDirection,
  initialObservationIndex: number,
): Readonly<{ state: PitchMazeSessionState; nextObservationIndex: number }> {
  let state = initial;
  let index = initialObservationIndex;
  state = reducePitchMazeSession(state, {
    type: "observation",
    observation: observation(index, null),
  });
  index += 1;
  const midi = state.level!.directionNotes[direction];
  state = feed(state, Array.from({ length: 36 }, () => {
    const frame = observation(index, midi);
    index += 1;
    return frame;
  }));
  return Object.freeze({ state, nextObservationIndex: index });
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

  it("aggregates indefinite pre-goal wandering while retaining only a bounded recent history", () => {
    let state = reducePitchMazeSession(createPitchMazeSession(), {
      type: "start",
      campaign: CAMPAIGN,
    });
    const blockedDirection = (["north", "east", "south", "west"] as const)
      .find((direction) => !getPitchMazeLegalDirections(state.level!).includes(direction))!;
    let index = 0;
    const commandCount = PITCH_MAZE_MAX_RETAINED_COMMANDS + 180;
    for (let command = 0; command < commandCount; command += 1) {
      const update = issueCommand(state, blockedDirection, index);
      state = update.state;
      index = update.nextObservationIndex;
    }

    expect(state.phase).toBe("playing");
    expect(state.currentResult).toBeNull();
    expect(state.commands).toHaveLength(PITCH_MAZE_MAX_RETAINED_COMMANDS);
    expect(state.observedCommandCount).toBe(commandCount);
    expect(state.currentLevelMetrics.commandCount).toBe(commandCount);
    expect(state.currentLevelMetrics.blockedCommandCount).toBe(commandCount);
    expect(state.campaignMetrics.commandCount).toBe(commandCount);
    expect(state.controller!.completedCommandCount).toBe(commandCount);
  });

  it("ignores observations outside the playing phase", () => {
    const setup = createPitchMazeSession("random");
    const next = reducePitchMazeSession(setup, {
      type: "observation",
      observation: observation(0, 49),
    });
    expect(next).toBe(setup);
  });

  it("lets the user Finish an unfinished maze and freezes every later observation", () => {
    let state = reducePitchMazeSession(createPitchMazeSession(), {
      type: "start",
      campaign: CAMPAIGN,
    });
    state = reducePitchMazeSession(state, {
      type: "observation",
      observation: observation(0, null),
    });
    const direction = getPitchMazeLegalDirections(state.level!)[0]!;
    const commanded = issueCommand(state, direction, 1);
    state = commanded.state;
    expect(state.phase).toBe("playing");
    expect(state.currentResult).toBeNull();
    expect(state.campaignMetrics.commandCount).toBe(1);

    const finished = reducePitchMazeSession(state, { type: "finish" });
    expect(finished.phase).toBe("campaign-result");
    expect(finished.outcome).toMatchObject({
      mode: "maze",
      details: { commands: 1, levelsCompleted: 0 },
    });
    expect(finished.outcome!.durationMs).toBeGreaterThan(0);
    expect(reducePitchMazeSession(finished, {
      type: "observation",
      observation: observation(commanded.nextObservationIndex, state.level!.directionNotes[direction]),
    })).toBe(finished);
    expect(reducePitchMazeSession(finished, { type: "continue" })).toBe(finished);
    expect(reducePitchMazeSession(finished, { type: "reset" }).phase).toBe("setup");
  });

  it("keeps reducing voice observations after a level goal and advances only on explicit Continue", () => {
    const started = reducePitchMazeSession(createPitchMazeSession(), { type: "start", campaign: CAMPAIGN });
    const solved = solveCurrentLevel(started);
    let state = solved.state;
    expect(state).toMatchObject({ phase: "playing", levelNumber: 1, outcome: null });
    expect(state.currentResult).not.toBeNull();

    const priorEndSample = state.controller!.lastAuthority!.endSample;
    const priorPlayer = state.level!.player;
    const direction = getPitchMazeLegalDirections(state.level!)[0]!;
    let index = solved.nextObservationIndex;
    state = reducePitchMazeSession(state, { type: "observation", observation: observation(index, null) });
    index += 1;
    state = feed(state, Array.from({ length: 36 }, () => {
      const frame = observation(index, state.level!.directionNotes[direction]);
      index += 1;
      return frame;
    }));
    expect(state.phase).toBe("playing");
    expect(state.controller!.lastAuthority!.endSample).toBeGreaterThan(priorEndSample);
    expect(state.level!.player).not.toEqual(priorPlayer);
    expect(state.currentResult).toBe(solved.state.currentResult);

    const achievement = state.currentResult;
    const scoreMetrics = state.currentLevelMetrics;
    const observedBefore = state.observedCommandCount;
    for (let command = 0; command < PITCH_MAZE_MAX_RETAINED_COMMANDS + 40; command += 1) {
      const update = issueCommand(state, direction, index);
      state = update.state;
      index = update.nextObservationIndex;
    }
    expect(state.phase).toBe("playing");
    expect(state.currentResult).toBe(achievement);
    expect(state.currentLevelMetrics).not.toBe(scoreMetrics);
    expect(state.currentLevelMetrics.commandCount).toBe(
      scoreMetrics.commandCount + PITCH_MAZE_MAX_RETAINED_COMMANDS + 40,
    );
    expect(state.observedCommandCount).toBe(
      observedBefore + PITCH_MAZE_MAX_RETAINED_COMMANDS + 40,
    );
    expect(state.commands).toHaveLength(PITCH_MAZE_MAX_RETAINED_COMMANDS);

    state = reducePitchMazeSession(state, { type: "continue" });
    expect(state).toMatchObject({ phase: "playing", levelNumber: 2, currentResult: null });
  });

  it("keeps command scoring live for an hour after campaign achievement until explicit Finish", () => {
    const started = reducePitchMazeSession(createPitchMazeSession(), { type: "start", campaign: CAMPAIGN });
    const finalLevel = Object.freeze({ ...started, levelNumber: 5 });
    const solved = solveCurrentLevel(finalLevel);
    let state = solved.state;
    expect(state).toMatchObject({ phase: "playing", levelNumber: 5 });
    expect(state.achievementOutcome).not.toBeNull();
    expect(state.outcome).toBeNull();

    const priorEndSample = state.controller!.lastAuthority!.endSample;
    const achievement = state.achievementOutcome;
    const achievementMetrics = state.campaignMetrics;
    const direction = getPitchMazeLegalDirections(state.level!)[0]!;
    const hourEndIndex = solved.nextObservationIndex + 180_000;
    let index = solved.nextObservationIndex;
    while (index < hourEndIndex) {
      const update = issueCommand(state, direction, index);
      state = update.state;
      index = update.nextObservationIndex;
    }
    expect(state.phase).toBe("playing");
    expect(state.controller!.lastAuthority!.endSample).toBeGreaterThan(priorEndSample);
    expect(state.achievementOutcome).toBe(achievement);
    expect(state.outcome).toBeNull();
    expect(state.campaignMetrics.commandCount).toBeGreaterThan(
      achievementMetrics.commandCount + 4_000,
    );
    expect(state.lastObservedAtSeconds! - state.campaignStartedAtSeconds!).toBeGreaterThan(3_599);
    expect(reducePitchMazeSession(state, { type: "start", campaign: CAMPAIGN })).toBe(state);
    expect(reducePitchMazeSession(state, { type: "reset" })).toBe(state);

    state = reducePitchMazeSession(state, { type: "finish" });
    expect(state.phase).toBe("campaign-result");
    expect(state.outcome).not.toBe(achievement);
    expect(state.outcome?.details?.commands).toBe(state.campaignMetrics.commandCount);
    expect(state.outcome!.durationMs).toBeGreaterThan(3_599_000);
    const ended = state;
    state = reducePitchMazeSession(state, {
      type: "observation",
      observation: observation(index, null),
    });
    expect(state).toBe(ended);
    expect(reducePitchMazeSession(state, { type: "reset" }).phase).toBe("setup");
  }, 15_000);
});
