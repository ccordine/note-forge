import { describe, expect, it } from "vitest";

import {
  CARDINAL_DIRECTIONS,
  PITCH_MAZE_DIFFICULTY_PRESETS,
  PITCH_MAZE_MAPPING_POLICIES,
  PITCH_MAZE_MAX_SIDE,
  applyCompletedPitchMazeMove,
  assignPitchMazeDirectionNotes,
  createPitchMazeDirectionNotes,
  createPitchMazeLevel,
  getPitchMazeCell,
  getPitchMazeDimensions,
  getPitchMazeDirectionPrompt,
  getPitchMazeLegalDirections,
  getPitchMazeRequiredNote,
  getPitchMazeShortestPathLength,
  normalizePitchMazeConfig,
  type CardinalDirection,
  type PitchMazeLevel,
  type PitchMazeOptions,
  type PitchMazePosition,
} from "../apps/web/src/features/voice-arcade/pitch-maze-model";

const DEFAULT_OPTIONS = {
  seed: "pitch-maze-proof",
  voiceRange: { lowMidi: 45, highMidi: 64, baselineMidi: 52 },
  level: 1,
  mappingMode: "adjacent",
  difficulty: "easy",
} as const satisfies PitchMazeOptions;

const OPPOSITE: Readonly<Record<CardinalDirection, CardinalDirection>> = {
  north: "south",
  east: "west",
  south: "north",
  west: "east",
};

const DELTA: Readonly<Record<CardinalDirection, readonly [number, number]>> = {
  north: [-1, 0],
  east: [0, 1],
  south: [1, 0],
  west: [0, -1],
};

function key(position: PitchMazePosition): string {
  return `${position.row}:${position.column}`;
}

function destination(position: PitchMazePosition, direction: CardinalDirection): PitchMazePosition {
  return {
    row: position.row + DELTA[direction][0],
    column: position.column + DELTA[direction][1],
  };
}

function reachableKeys(level: PitchMazeLevel, origin: PitchMazePosition = level.start): Set<string> {
  const visited = new Set([key(origin)]);
  const queue = [origin];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    for (const direction of getPitchMazeLegalDirections(level, current)) {
      const next = destination(current, direction);
      if (visited.has(key(next))) continue;
      visited.add(key(next));
      queue.push(next);
    }
  }
  return visited;
}

function distancesFrom(level: PitchMazeLevel, origin: PitchMazePosition): Map<string, number> {
  const distances = new Map([[key(origin), 0]]);
  const queue = [origin];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    const distance = distances.get(key(current))!;
    for (const direction of getPitchMazeLegalDirections(level, current)) {
      const next = destination(current, direction);
      if (distances.has(key(next))) continue;
      distances.set(key(next), distance + 1);
      queue.push(next);
    }
  }
  return distances;
}

function solutionDirections(level: PitchMazeLevel): CardinalDirection[] {
  const visited = new Set([key(level.start)]);
  const queue: Array<{ position: PitchMazePosition; path: CardinalDirection[] }> = [
    { position: level.start, path: [] },
  ];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (key(current.position) === key(level.goal)) return current.path;
    for (const direction of getPitchMazeLegalDirections(level, current.position)) {
      const next = destination(current.position, direction);
      if (visited.has(key(next))) continue;
      visited.add(key(next));
      queue.push({ position: next, path: [...current.path, direction] });
    }
  }
  throw new Error("Generated maze did not contain a solution.");
}

function directionForNote(level: PitchMazeLevel, note: number): CardinalDirection | undefined {
  return CARDINAL_DIRECTIONS.find((direction) => level.directionNotes[direction] === note);
}

describe("Pitch Maze configuration and progression", () => {
  it("normalizes defaults and binds voice timing to the selected difficulty", () => {
    const normalized = normalizePitchMazeConfig({
      seed: 17,
      voiceRange: DEFAULT_OPTIONS.voiceRange,
    });

    expect(normalized).toMatchObject({
      level: 1,
      mappingMode: "adjacent",
      difficulty: "medium",
      rows: 4,
      columns: 4,
      holdDurationSeconds: PITCH_MAZE_DIFFICULTY_PRESETS.medium.holdDurationSeconds,
      toleranceCents: PITCH_MAZE_DIFFICULTY_PRESETS.medium.toleranceCents,
    });
    expect(PITCH_MAZE_DIFFICULTY_PRESETS.easy.toleranceCents)
      .toBeGreaterThan(PITCH_MAZE_DIFFICULTY_PRESETS.medium.toleranceCents);
    expect(PITCH_MAZE_DIFFICULTY_PRESETS.medium.toleranceCents)
      .toBeGreaterThan(PITCH_MAZE_DIFFICULTY_PRESETS.hard.toleranceCents);
    expect(PITCH_MAZE_DIFFICULTY_PRESETS.easy.holdDurationSeconds).toBeGreaterThanOrEqual(0.4);
    expect(PITCH_MAZE_DIFFICULTY_PRESETS.easy.holdDurationSeconds).toBeLessThanOrEqual(0.6);
    expect(Object.keys(PITCH_MAZE_MAPPING_POLICIES)).toEqual(["adjacent", "random"]);
  });

  it("grows tiny boards progressively and stops at a conservative cap", () => {
    expect(getPitchMazeDimensions(1, "easy")).toEqual({ rows: 3, columns: 3 });
    expect(getPitchMazeDimensions(4, "easy")).toEqual({ rows: 3, columns: 4 });
    expect(getPitchMazeDimensions(1, "medium")).toEqual({ rows: 4, columns: 4 });
    expect(getPitchMazeDimensions(2, "hard")).toEqual({ rows: 4, columns: 5 });
    expect(getPitchMazeDimensions(10_000, "hard")).toEqual({
      rows: PITCH_MAZE_MAX_SIDE,
      columns: PITCH_MAZE_MAX_SIDE,
    });
  });

  it("tightens the voice lane and lengthens the hold progressively without becoming unbounded", () => {
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      const first = normalizePitchMazeConfig({ ...DEFAULT_OPTIONS, difficulty, level: 1 });
      const fifth = normalizePitchMazeConfig({ ...DEFAULT_OPTIONS, difficulty, level: 5 });
      const distant = normalizePitchMazeConfig({ ...DEFAULT_OPTIONS, difficulty, level: 10_000 });
      const preset = PITCH_MAZE_DIFFICULTY_PRESETS[difficulty];
      expect(fifth.toleranceCents).toBeLessThan(first.toleranceCents);
      expect(fifth.holdDurationSeconds).toBeGreaterThan(first.holdDurationSeconds);
      expect(distant.toleranceCents).toBe(preset.minimumToleranceCents);
      expect(distant.holdDurationSeconds).toBe(preset.maximumHoldDurationSeconds);
    }
  });

  it("rejects malformed levels, seeds, mappings, difficulties, and vocal ranges", () => {
    expect(() => normalizePitchMazeConfig(null as never)).toThrow(TypeError);
    expect(() => normalizePitchMazeConfig({ ...DEFAULT_OPTIONS, seed: Number.NaN })).toThrow(RangeError);
    expect(() => normalizePitchMazeConfig({ ...DEFAULT_OPTIONS, seed: {} as never })).toThrow(TypeError);
    expect(() => normalizePitchMazeConfig({ ...DEFAULT_OPTIONS, level: 0 })).toThrow(RangeError);
    expect(() => normalizePitchMazeConfig({ ...DEFAULT_OPTIONS, level: 1.5 })).toThrow(RangeError);
    expect(() => normalizePitchMazeConfig({ ...DEFAULT_OPTIONS, mappingMode: "scale" as never })).toThrow(RangeError);
    expect(() => normalizePitchMazeConfig({ ...DEFAULT_OPTIONS, difficulty: "expert" as never })).toThrow(RangeError);
    expect(() => normalizePitchMazeConfig({ ...DEFAULT_OPTIONS, voiceRange: null as never })).toThrow(TypeError);
    expect(() => normalizePitchMazeConfig({
      ...DEFAULT_OPTIONS,
      voiceRange: { lowMidi: 48, highMidi: 47, baselineMidi: 48 },
    })).toThrow(RangeError);
    expect(() => normalizePitchMazeConfig({
      ...DEFAULT_OPTIONS,
      voiceRange: { lowMidi: 48, highMidi: 50, baselineMidi: 49 },
    })).toThrow(/four distinct notes/);
    expect(() => normalizePitchMazeConfig({
      ...DEFAULT_OPTIONS,
      voiceRange: { lowMidi: 48, highMidi: 60, baselineMidi: 61 },
    })).toThrow(/inside the vocal range/);
    expect(() => normalizePitchMazeConfig({
      ...DEFAULT_OPTIONS,
      voiceRange: { lowMidi: -1, highMidi: 60, baselineMidi: 48 },
    })).toThrow(RangeError);
    expect(() => getPitchMazeDimensions(1, "expert" as never)).toThrow(RangeError);
  });
});

describe("Pitch Maze note mapping policies", () => {
  it("slides the chromatic window one semitone and rotates note-to-direction assignments", () => {
    const levels = Array.from({ length: 5 }, (_, index) => createPitchMazeLevel({
      ...DEFAULT_OPTIONS,
      level: index + 1,
    }));

    for (const level of levels) {
      const notes = [...Object.values(level.directionNotes)].sort((first, second) => first - second);
      expect(notes).toEqual([notes[0]!, notes[0]! + 1, notes[0]! + 2, notes[0]! + 3]);
    }
    const firstMinimum = Math.min(...Object.values(levels[0]!.directionNotes));
    expect(Math.min(...Object.values(levels[1]!.directionNotes))).toBe(firstMinimum + 1);
    expect(Math.min(...Object.values(levels[2]!.directionNotes))).toBe(firstMinimum + 2);

    const sharedNote = firstMinimum + 1;
    expect(directionForNote(levels[0]!, sharedNote)).toBe("east");
    expect(directionForNote(levels[1]!, sharedNote)).toBe("west");
  });

  it("wraps chromatic windows without ever leaving the vocal range", () => {
    const options = {
      ...DEFAULT_OPTIONS,
      voiceRange: { lowMidi: 48, highMidi: 54, baselineMidi: 50 },
    } as const;
    const minima = Array.from({ length: 8 }, (_, index) => {
      const notes = createPitchMazeDirectionNotes({ ...options, level: index + 1 });
      const values = Object.values(notes);
      expect(new Set(values).size).toBe(4);
      expect(values.every((midi) => midi >= 48 && midi <= 54)).toBe(true);
      return Math.min(...values);
    });
    expect(minima).toEqual([49, 50, 51, 48, 49, 50, 51, 48]);
  });

  it("creates deterministic distinct random mappings inside the passed range across many seeds", () => {
    for (let seed = 0; seed < 100; seed += 1) {
      for (let level = 1; level <= 5; level += 1) {
        const options = { ...DEFAULT_OPTIONS, seed, level, mappingMode: "random" } as const;
        const first = createPitchMazeDirectionNotes(options);
        const second = createPitchMazeDirectionNotes(options);
        const notes = Object.values(first);
        expect(first).toEqual(second);
        expect(new Set(notes).size).toBe(4);
        expect(notes.every((midi) => midi >= 45 && midi <= 64)).toBe(true);
      }
    }
  });

  it("exposes a validated rotating assignment boundary for future mapping policies", () => {
    expect(assignPitchMazeDirectionNotes([48, 50, 52, 55], 1)).toEqual({
      north: 48,
      east: 50,
      south: 52,
      west: 55,
    });
    expect(assignPitchMazeDirectionNotes([48, 50, 52, 55], 2)).toEqual({
      north: 50,
      east: 52,
      south: 55,
      west: 48,
    });
    expect(() => assignPitchMazeDirectionNotes([48, 48, 52, 55], 1)).toThrow(/distinct/);
    expect(() => assignPitchMazeDirectionNotes([48, 50, 52, 128], 1)).toThrow(RangeError);
  });
});

describe("Pitch Maze generation properties", () => {
  it("generates deterministic, connected, acyclic mazes with symmetric bounded walls", () => {
    for (let seed = 0; seed < 80; seed += 1) {
      const options = {
        ...DEFAULT_OPTIONS,
        seed,
        level: 1 + (seed % 18),
        difficulty: (["easy", "medium", "hard"] as const)[seed % 3],
      } as const;
      const level = createPitchMazeLevel(options);
      expect(level).toEqual(createPitchMazeLevel(options));
      expect(level.cells).toHaveLength(level.config.rows * level.config.columns);
      expect(reachableKeys(level).size).toBe(level.cells.length);

      let openEdges = 0;
      for (const cell of level.cells) {
        expect(cell.row).toBeGreaterThanOrEqual(0);
        expect(cell.row).toBeLessThan(level.config.rows);
        expect(cell.column).toBeGreaterThanOrEqual(0);
        expect(cell.column).toBeLessThan(level.config.columns);
        for (const direction of CARDINAL_DIRECTIONS) {
          if (cell.walls[direction]) continue;
          openEdges += 1;
          const next = destination(cell, direction);
          expect(next.row).toBeGreaterThanOrEqual(0);
          expect(next.row).toBeLessThan(level.config.rows);
          expect(next.column).toBeGreaterThanOrEqual(0);
          expect(next.column).toBeLessThan(level.config.columns);
          expect(getPitchMazeCell(level, next).walls[OPPOSITE[direction]]).toBe(false);
        }
        if (cell.row === 0) expect(cell.walls.north).toBe(true);
        if (cell.row === level.config.rows - 1) expect(cell.walls.south).toBe(true);
        if (cell.column === 0) expect(cell.walls.west).toBe(true);
        if (cell.column === level.config.columns - 1) expect(cell.walls.east).toBe(true);
      }
      // A connected graph with exactly V-1 undirected passages is a tree: a perfect maze.
      expect(openEdges / 2).toBe(level.cells.length - 1);
    }
  });

  it("uses actual tree-diameter endpoints for maximally separated start and goal", () => {
    for (let seed = 0; seed < 16; seed += 1) {
      const level = createPitchMazeLevel({ ...DEFAULT_OPTIONS, seed, level: 9 });
      const startDistances = distancesFrom(level, level.start);
      const startToGoal = startDistances.get(key(level.goal));
      let diameter = 0;
      for (const cell of level.cells) {
        diameter = Math.max(diameter, ...distancesFrom(level, cell).values());
      }
      expect(startToGoal).toBe(diameter);
      expect(getPitchMazeShortestPathLength(level, level.start, level.goal)).toBe(diameter);
      expect(getPitchMazeShortestPathLength(level, level.goal, level.goal)).toBe(0);
      expect(level.start).not.toEqual(level.goal);
    }
  });

  it("normally changes maze structure when the seed or level changes", () => {
    const signature = (level: PitchMazeLevel) => level.cells.map((cell) => cell.walls);
    const original = signature(createPitchMazeLevel(DEFAULT_OPTIONS));
    expect(signature(createPitchMazeLevel({ ...DEFAULT_OPTIONS, seed: "another-seed" })))
      .not.toEqual(original);
    expect(signature(createPitchMazeLevel({ ...DEFAULT_OPTIONS, level: 2 })))
      .not.toEqual(original);
  });
});

describe("Pitch Maze voice-completed movement", () => {
  it("derives legal directions, note prompts, and applies only open-wall moves immutably", () => {
    const initial = createPitchMazeLevel(DEFAULT_OPTIONS);
    const legal = getPitchMazeLegalDirections(initial);
    expect(legal.length).toBeGreaterThan(0);
    const direction = legal[0]!;
    const targetMidi = getPitchMazeRequiredNote(initial, direction);
    expect(getPitchMazeDirectionPrompt(initial, direction)).toEqual({
      direction,
      targetMidi,
      legal: true,
    });

    const originalSnapshot = structuredClone(initial);
    const result = applyCompletedPitchMazeMove(initial, direction);
    expect(result.moved).toBe(true);
    expect(result.level.moves).toBe(1);
    expect(result.level.player).toEqual(destination(initial.player, direction));
    expect(initial).toEqual(originalSnapshot);
    expect(result.level).not.toBe(initial);
    expect(getPitchMazeLegalDirections(result.level)).toContain(OPPOSITE[direction]);

    const blockedDirection = CARDINAL_DIRECTIONS.find(
      (candidate) => getPitchMazeCell(initial).walls[candidate],
    )!;
    expect(getPitchMazeDirectionPrompt(initial, blockedDirection).legal).toBe(false);
    const blocked = applyCompletedPitchMazeMove(initial, blockedDirection);
    expect(blocked).toMatchObject({ moved: false, reason: "wall", levelComplete: false });
    expect(blocked.level).toBe(initial);
    expect(() => getPitchMazeCell(initial, { row: -1, column: 0 })).toThrow(RangeError);
    expect(() => getPitchMazeRequiredNote(initial, "up" as never)).toThrow(RangeError);
  });

  it("solves generated levels one completed directional hold at a time and reports completion", () => {
    for (let seed = 0; seed < 24; seed += 1) {
      let level = createPitchMazeLevel({ ...DEFAULT_OPTIONS, seed, level: 1 + seed % 8 });
      const solution = solutionDirections(level);
      expect(solution.length).toBeGreaterThan(0);
      for (const [index, direction] of solution.entries()) {
        const result = applyCompletedPitchMazeMove(level, direction);
        expect(result.moved).toBe(true);
        expect(result.levelComplete).toBe(index === solution.length - 1);
        level = result.level;
      }
      expect(level.player).toEqual(level.goal);
      expect(level.levelComplete).toBe(true);
      expect(level.moves).toBe(solution.length);
      const returnDirection = getPitchMazeLegalDirections(level)[0]!;
      const afterCompletion = applyCompletedPitchMazeMove(level, returnDirection);
      expect(afterCompletion).toMatchObject({
        moved: true,
        reason: "moved",
        levelComplete: true,
      });
      expect(afterCompletion.level.player).not.toEqual(level.player);
      expect(afterCompletion.level.moves).toBe(level.moves + 1);
    }
  });
});
