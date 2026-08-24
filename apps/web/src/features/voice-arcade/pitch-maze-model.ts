import {
  createSeededRandom,
  type SeedValue,
  type VoiceArcadeDifficulty,
} from "./model";
import type { ArcadeVoiceRange } from "./types";

export const CARDINAL_DIRECTIONS = Object.freeze(["north", "east", "south", "west"] as const);
export type CardinalDirection = (typeof CARDINAL_DIRECTIONS)[number];
export type PitchMazeMappingMode = "adjacent" | "random";

export const PITCH_MAZE_MAX_SIDE = 9;
export const PITCH_MAZE_MAX_LEVEL = 10_000;

export interface PitchMazeDifficultyPreset {
  readonly id: VoiceArcadeDifficulty;
  readonly toleranceCents: number;
  readonly holdDurationSeconds: number;
  readonly toleranceTighteningPerLevel: number;
  readonly minimumToleranceCents: number;
  readonly holdGrowthPerLevel: number;
  readonly maximumHoldDurationSeconds: number;
  readonly initialSide: number;
  readonly levelsPerGrowthStep: number;
}

/** Voice-control and board progression are tuned as one game difficulty. */
export const PITCH_MAZE_DIFFICULTY_PRESETS = Object.freeze({
  easy: Object.freeze({
    id: "easy",
    toleranceCents: 35,
    holdDurationSeconds: 0.45,
    toleranceTighteningPerLevel: 2,
    minimumToleranceCents: 20,
    holdGrowthPerLevel: 0.04,
    maximumHoldDurationSeconds: 0.75,
    initialSide: 3,
    levelsPerGrowthStep: 3,
  }),
  medium: Object.freeze({
    id: "medium",
    toleranceCents: 24,
    holdDurationSeconds: 0.6,
    toleranceTighteningPerLevel: 1.5,
    minimumToleranceCents: 14,
    holdGrowthPerLevel: 0.04,
    maximumHoldDurationSeconds: 0.9,
    initialSide: 4,
    levelsPerGrowthStep: 2,
  }),
  hard: Object.freeze({
    id: "hard",
    toleranceCents: 15,
    holdDurationSeconds: 0.8,
    toleranceTighteningPerLevel: 1,
    minimumToleranceCents: 8,
    holdGrowthPerLevel: 0.04,
    maximumHoldDurationSeconds: 1.05,
    initialSide: 4,
    levelsPerGrowthStep: 1,
  }),
} satisfies Readonly<Record<VoiceArcadeDifficulty, PitchMazeDifficultyPreset>>);

export interface PitchMazePosition {
  readonly row: number;
  readonly column: number;
}

export type PitchMazeWalls = Readonly<Record<CardinalDirection, boolean>>;
export type PitchMazeDirectionNotes = Readonly<Record<CardinalDirection, number>>;
export type PitchMazeNoteSet = readonly [number, number, number, number];

export interface PitchMazeCell extends PitchMazePosition {
  /** `true` means movement is blocked by a wall on that edge. */
  readonly walls: PitchMazeWalls;
}

export interface PitchMazeOptions {
  readonly seed: SeedValue;
  readonly voiceRange: Readonly<ArcadeVoiceRange>;
  readonly level?: number;
  readonly mappingMode?: PitchMazeMappingMode;
  readonly difficulty?: VoiceArcadeDifficulty;
}

export interface NormalizedPitchMazeConfig {
  readonly seed: SeedValue;
  readonly level: number;
  readonly mappingMode: PitchMazeMappingMode;
  readonly difficulty: VoiceArcadeDifficulty;
  readonly lowMidi: number;
  readonly highMidi: number;
  readonly baselineMidi: number;
  readonly rows: number;
  readonly columns: number;
  readonly holdDurationSeconds: number;
  readonly toleranceCents: number;
}

export interface PitchMazeLevel {
  readonly config: NormalizedPitchMazeConfig;
  readonly cells: readonly PitchMazeCell[];
  readonly start: PitchMazePosition;
  readonly goal: PitchMazePosition;
  readonly player: PitchMazePosition;
  readonly directionNotes: PitchMazeDirectionNotes;
  readonly moves: number;
  readonly levelComplete: boolean;
}

export interface PitchMazeDirectionPrompt {
  readonly direction: CardinalDirection;
  readonly targetMidi: number;
  readonly legal: boolean;
}

/** A small policy boundary so scale/memory/interval mappings can be added later. */
export interface PitchMazeMappingPolicy {
  readonly id: PitchMazeMappingMode;
  readonly label: string;
  readonly description: string;
}

export const PITCH_MAZE_MAPPING_POLICIES = Object.freeze({
  adjacent: Object.freeze({
    id: "adjacent",
    label: "Chromatic",
    description: "Four adjacent chromatic notes; the window and direction assignments rotate each level.",
  }),
  random: Object.freeze({
    id: "random",
    label: "Random",
    description: "Four deterministic, distinct notes sampled from the selected vocal range each level.",
  }),
} satisfies Readonly<Record<PitchMazeMappingMode, PitchMazeMappingPolicy>>);

export type PitchMazeMoveReason = "moved" | "wall" | "level-complete";

export interface PitchMazeMoveResult {
  readonly level: PitchMazeLevel;
  readonly moved: boolean;
  readonly reason: PitchMazeMoveReason;
  readonly levelComplete: boolean;
}

interface DirectionDefinition {
  readonly rowDelta: number;
  readonly columnDelta: number;
  readonly opposite: CardinalDirection;
  readonly bit: number;
}

const DIRECTION_DEFINITIONS: Readonly<Record<CardinalDirection, DirectionDefinition>> = {
  north: { rowDelta: -1, columnDelta: 0, opposite: "south", bit: 1 },
  east: { rowDelta: 0, columnDelta: 1, opposite: "west", bit: 2 },
  south: { rowDelta: 1, columnDelta: 0, opposite: "north", bit: 4 },
  west: { rowDelta: 0, columnDelta: -1, opposite: "east", bit: 8 },
};

const ALL_WALLS = CARDINAL_DIRECTIONS.reduce(
  (mask, direction) => mask | DIRECTION_DEFINITIONS[direction].bit,
  0,
);

function assertMidi(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 127) {
    throw new RangeError(`${label} must be an integer MIDI note from 0 through 127.`);
  }
}

function assertSeed(seed: SeedValue): void {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) throw new RangeError("Seed must be finite.");
    return;
  }
  if (typeof seed !== "string") throw new TypeError("Seed must be a finite number or a string.");
}

function assertDirection(direction: CardinalDirection): void {
  if (!(CARDINAL_DIRECTIONS as readonly unknown[]).includes(direction)) {
    throw new RangeError(`Unknown cardinal direction: ${String(direction)}`);
  }
}

function freezePosition(row: number, column: number): PitchMazePosition {
  return Object.freeze({ row, column });
}

function samePosition(first: PitchMazePosition, second: PitchMazePosition): boolean {
  return first.row === second.row && first.column === second.column;
}

function indexFor(position: PitchMazePosition, columns: number): number {
  return position.row * columns + position.column;
}

function positionFor(index: number, columns: number): PitchMazePosition {
  return freezePosition(Math.floor(index / columns), index % columns);
}

function scopedSeed(seed: SeedValue, scope: string): string {
  return `${typeof seed}:${String(seed)}|pitch-maze|${scope}`;
}

/**
 * Boards begin at the difficulty's 3x3 or 4x4 starting point, then alternate
 * growing width and height until reaching the deliberately conservative cap.
 */
export function getPitchMazeDimensions(
  level: number,
  difficulty: VoiceArcadeDifficulty = "medium",
): Readonly<{ rows: number; columns: number }> {
  if (!Number.isInteger(level) || level < 1 || level > PITCH_MAZE_MAX_LEVEL) {
    throw new RangeError(`Pitch Maze level must be an integer from 1 through ${PITCH_MAZE_MAX_LEVEL}.`);
  }
  const preset = PITCH_MAZE_DIFFICULTY_PRESETS[difficulty];
  if (!preset) throw new RangeError(`Unknown Voice Arcade difficulty: ${String(difficulty)}`);
  const growth = Math.floor((level - 1) / preset.levelsPerGrowthStep);
  return Object.freeze({
    rows: Math.min(PITCH_MAZE_MAX_SIDE, preset.initialSide + Math.floor(growth / 2)),
    columns: Math.min(PITCH_MAZE_MAX_SIDE, preset.initialSide + Math.ceil(growth / 2)),
  });
}

export function normalizePitchMazeConfig(
  options: Readonly<PitchMazeOptions>,
): NormalizedPitchMazeConfig {
  if (!options || typeof options !== "object") {
    throw new TypeError("Pitch Maze options are required.");
  }
  assertSeed(options.seed);
  if (!options.voiceRange || typeof options.voiceRange !== "object") {
    throw new TypeError("A vocal range is required.");
  }

  const { lowMidi, highMidi, baselineMidi } = options.voiceRange;
  assertMidi(lowMidi, "Low range edge");
  assertMidi(highMidi, "High range edge");
  assertMidi(baselineMidi, "Baseline");
  if (lowMidi > highMidi) throw new RangeError("Low range edge cannot be above the high range edge.");
  if (highMidi - lowMidi + 1 < CARDINAL_DIRECTIONS.length) {
    throw new RangeError("Pitch Maze needs at least four distinct notes in the vocal range.");
  }
  if (baselineMidi < lowMidi || baselineMidi > highMidi) {
    throw new RangeError("Baseline must be inside the vocal range.");
  }

  const level = options.level ?? 1;
  const mappingMode = options.mappingMode ?? "adjacent";
  if (mappingMode !== "adjacent" && mappingMode !== "random") {
    throw new RangeError(`Unknown Pitch Maze mapping mode: ${String(mappingMode)}`);
  }
  const difficulty = options.difficulty ?? "medium";
  const preset = PITCH_MAZE_DIFFICULTY_PRESETS[difficulty];
  if (!preset) throw new RangeError(`Unknown Voice Arcade difficulty: ${String(difficulty)}`);
  const dimensions = getPitchMazeDimensions(level, difficulty);
  const progression = level - 1;
  const toleranceCents = Math.max(
    preset.minimumToleranceCents,
    Math.round(preset.toleranceCents - progression * preset.toleranceTighteningPerLevel),
  );
  const holdDurationSeconds = Math.min(
    preset.maximumHoldDurationSeconds,
    Number((preset.holdDurationSeconds + progression * preset.holdGrowthPerLevel).toFixed(2)),
  );

  return Object.freeze({
    seed: options.seed,
    level,
    mappingMode,
    difficulty,
    lowMidi,
    highMidi,
    baselineMidi,
    rows: dimensions.rows,
    columns: dimensions.columns,
    holdDurationSeconds,
    toleranceCents,
  });
}

/**
 * Shared assignment step for future scale, interval, memory, and register
 * policies: provide four distinct notes and it handles per-level rotation.
 */
export function assignPitchMazeDirectionNotes(
  notes: PitchMazeNoteSet,
  level: number,
): PitchMazeDirectionNotes {
  if (!Number.isInteger(level) || level < 1 || level > PITCH_MAZE_MAX_LEVEL) {
    throw new RangeError(`Pitch Maze level must be an integer from 1 through ${PITCH_MAZE_MAX_LEVEL}.`);
  }
  notes.forEach((midi, index) => assertMidi(midi, `Direction note ${index + 1}`));
  if (new Set(notes).size !== CARDINAL_DIRECTIONS.length) {
    throw new RangeError("Pitch Maze direction notes must be distinct.");
  }
  const rotation = (level - 1) % CARDINAL_DIRECTIONS.length;
  return Object.freeze({
    north: notes[(0 + rotation) % notes.length]!,
    east: notes[(1 + rotation) % notes.length]!,
    south: notes[(2 + rotation) % notes.length]!,
    west: notes[(3 + rotation) % notes.length]!,
  });
}

/** Produce four distinct in-range notes for the requested level. */
export function createPitchMazeDirectionNotes(
  configOrOptions: Readonly<NormalizedPitchMazeConfig | PitchMazeOptions>,
): PitchMazeDirectionNotes {
  const config = "rows" in configOrOptions
    ? configOrOptions as Readonly<NormalizedPitchMazeConfig>
    : normalizePitchMazeConfig(configOrOptions as Readonly<PitchMazeOptions>);

  if (config.mappingMode === "adjacent") {
    const finalStart = config.highMidi - (CARDINAL_DIRECTIONS.length - 1);
    const baselineStart = Math.min(finalStart, Math.max(config.lowMidi, config.baselineMidi - 1));
    const numberOfWindows = finalStart - config.lowMidi + 1;
    const start = config.lowMidi
      + ((baselineStart - config.lowMidi + config.level - 1) % numberOfWindows);
    return assignPitchMazeDirectionNotes(
      [start, start + 1, start + 2, start + 3],
      config.level,
    );
  }

  const notes = Array.from(
    { length: config.highMidi - config.lowMidi + 1 },
    (_, index) => config.lowMidi + index,
  );
  const random = createSeededRandom(scopedSeed(config.seed, `notes:${config.level}`));
  for (let index = notes.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [notes[index], notes[swapIndex]] = [notes[swapIndex]!, notes[index]!];
  }
  return assignPitchMazeDirectionNotes(
    [notes[0]!, notes[1]!, notes[2]!, notes[3]!],
    config.level,
  );
}

function neighborIndex(
  index: number,
  direction: CardinalDirection,
  rows: number,
  columns: number,
): number | null {
  const row = Math.floor(index / columns);
  const column = index % columns;
  const definition = DIRECTION_DEFINITIONS[direction];
  const nextRow = row + definition.rowDelta;
  const nextColumn = column + definition.columnDelta;
  if (nextRow < 0 || nextRow >= rows || nextColumn < 0 || nextColumn >= columns) return null;
  return nextRow * columns + nextColumn;
}

function generateWallMasks(config: NormalizedPitchMazeConfig): number[] {
  const total = config.rows * config.columns;
  const walls = Array<number>(total).fill(ALL_WALLS);
  const visited = new Uint8Array(total);
  const stack = [0];
  visited[0] = 1;
  const random = createSeededRandom(scopedSeed(config.seed, `maze:${config.level}`));

  while (stack.length > 0) {
    const current = stack.at(-1)!;
    const candidates = CARDINAL_DIRECTIONS.flatMap((direction) => {
      const next = neighborIndex(current, direction, config.rows, config.columns);
      return next !== null && visited[next] === 0 ? [{ direction, next }] : [];
    });
    if (candidates.length === 0) {
      stack.pop();
      continue;
    }
    const selected = candidates[Math.floor(random() * candidates.length)]!;
    const definition = DIRECTION_DEFINITIONS[selected.direction];
    walls[current] = walls[current]! & ~definition.bit;
    walls[selected.next] = walls[selected.next]!
      & ~DIRECTION_DEFINITIONS[definition.opposite].bit;
    visited[selected.next] = 1;
    stack.push(selected.next);
  }
  return walls;
}

function openNeighbors(index: number, walls: readonly number[], rows: number, columns: number): number[] {
  return CARDINAL_DIRECTIONS.flatMap((direction) => {
    if ((walls[index]! & DIRECTION_DEFINITIONS[direction].bit) !== 0) return [];
    const next = neighborIndex(index, direction, rows, columns);
    return next === null ? [] : [next];
  });
}

function farthestCell(
  origin: number,
  walls: readonly number[],
  rows: number,
  columns: number,
): number {
  const distances = Array<number>(walls.length).fill(-1);
  const queue = [origin];
  distances[origin] = 0;
  let farthest = origin;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (distances[current]! > distances[farthest]!) farthest = current;
    for (const next of openNeighbors(current, walls, rows, columns)) {
      if (distances[next] !== -1) continue;
      distances[next] = distances[current]! + 1;
      queue.push(next);
    }
  }
  return farthest;
}

function cellsFromWallMasks(
  walls: readonly number[],
  columns: number,
): readonly PitchMazeCell[] {
  return Object.freeze(walls.map((mask, index) => {
    const position = positionFor(index, columns);
    return Object.freeze({
      ...position,
      walls: Object.freeze({
        north: (mask & DIRECTION_DEFINITIONS.north.bit) !== 0,
        east: (mask & DIRECTION_DEFINITIONS.east.bit) !== 0,
        south: (mask & DIRECTION_DEFINITIONS.south.bit) !== 0,
        west: (mask & DIRECTION_DEFINITIONS.west.bit) !== 0,
      }),
    });
  }));
}

/** Generate a deterministic perfect maze and place start/goal at its diameter endpoints. */
export function createPitchMazeLevel(options: Readonly<PitchMazeOptions>): PitchMazeLevel {
  const config = normalizePitchMazeConfig(options);
  const wallMasks = generateWallMasks(config);
  const firstEndpoint = farthestCell(0, wallMasks, config.rows, config.columns);
  const secondEndpoint = farthestCell(
    firstEndpoint,
    wallMasks,
    config.rows,
    config.columns,
  );
  const start = positionFor(firstEndpoint, config.columns);
  const goal = positionFor(secondEndpoint, config.columns);
  return Object.freeze({
    config,
    cells: cellsFromWallMasks(wallMasks, config.columns),
    start,
    goal,
    player: start,
    directionNotes: createPitchMazeDirectionNotes(config),
    moves: 0,
    levelComplete: false,
  });
}

export function getPitchMazeCell(
  level: Readonly<PitchMazeLevel>,
  position: Readonly<PitchMazePosition> = level.player,
): PitchMazeCell {
  if (
    !Number.isInteger(position.row)
    || !Number.isInteger(position.column)
    || position.row < 0
    || position.row >= level.config.rows
    || position.column < 0
    || position.column >= level.config.columns
  ) {
    throw new RangeError("Pitch Maze position is outside the maze.");
  }
  return level.cells[indexFor(position, level.config.columns)]!;
}

/** Directions that can actually move from the supplied position. */
export function getPitchMazeLegalDirections(
  level: Readonly<PitchMazeLevel>,
  position: Readonly<PitchMazePosition> = level.player,
): readonly CardinalDirection[] {
  const cell = getPitchMazeCell(level, position);
  return Object.freeze(CARDINAL_DIRECTIONS.filter((direction) => !cell.walls[direction]));
}

/** Shortest remaining route in cells; useful for efficiency scoring and hints. */
export function getPitchMazeShortestPathLength(
  level: Readonly<PitchMazeLevel>,
  origin: Readonly<PitchMazePosition> = level.player,
  goal: Readonly<PitchMazePosition> = level.goal,
): number {
  getPitchMazeCell(level, origin);
  getPitchMazeCell(level, goal);
  const distances = Array<number>(level.cells.length).fill(-1);
  const originIndex = indexFor(origin, level.config.columns);
  const goalIndex = indexFor(goal, level.config.columns);
  const queue = [originIndex];
  distances[originIndex] = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentIndex = queue[cursor]!;
    if (currentIndex === goalIndex) return distances[currentIndex]!;
    const current = positionFor(currentIndex, level.config.columns);
    for (const direction of getPitchMazeLegalDirections(level, current)) {
      const next = neighborIndex(currentIndex, direction, level.config.rows, level.config.columns)!;
      if (distances[next] !== -1) continue;
      distances[next] = distances[currentIndex]! + 1;
      queue.push(next);
    }
  }
  throw new Error("Pitch Maze goal is unreachable.");
}

export function getPitchMazeRequiredNote(
  level: Readonly<PitchMazeLevel>,
  direction: CardinalDirection,
): number {
  assertDirection(direction);
  return level.directionNotes[direction];
}

export function getPitchMazeDirectionPrompt(
  level: Readonly<PitchMazeLevel>,
  direction: CardinalDirection,
): PitchMazeDirectionPrompt {
  assertDirection(direction);
  return Object.freeze({
    direction,
    targetMidi: level.directionNotes[direction],
    legal: !getPitchMazeCell(level).walls[direction],
  });
}

/**
 * Apply one direction only after the voice controller has completed its hold.
 * This layer intentionally knows nothing about raw pitch frames.
 */
export function applyCompletedPitchMazeMove(
  level: Readonly<PitchMazeLevel>,
  direction: CardinalDirection,
): PitchMazeMoveResult {
  assertDirection(direction);
  if (level.levelComplete) {
    return Object.freeze({ level, moved: false, reason: "level-complete", levelComplete: true });
  }
  const currentCell = getPitchMazeCell(level);
  if (currentCell.walls[direction]) {
    return Object.freeze({ level, moved: false, reason: "wall", levelComplete: false });
  }

  const definition = DIRECTION_DEFINITIONS[direction];
  const player = freezePosition(
    level.player.row + definition.rowDelta,
    level.player.column + definition.columnDelta,
  );
  const levelComplete = samePosition(player, level.goal);
  const nextLevel: PitchMazeLevel = Object.freeze({
    ...level,
    player,
    moves: level.moves + 1,
    levelComplete,
  });
  return Object.freeze({
    level: nextLevel,
    moved: true,
    reason: levelComplete ? "level-complete" : "moved",
    levelComplete,
  });
}
