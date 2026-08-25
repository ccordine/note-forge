import { describe, expect, it } from "vitest";
import { midiToFrequency } from "@noteforge/pitch-engine";
import {
  NoteInputEngine,
  type PitchObservation,
} from "../apps/web/src/audio/note-input";
import {
  createPitchMazeController,
  updatePitchMazeController,
  type PitchMazeControllerEvent,
  type PitchMazeControllerState,
} from "../apps/web/src/features/voice-arcade/pitch-maze-controller";
import {
  CARDINAL_DIRECTIONS,
  applyCompletedPitchMazeMove,
  createPitchMazeLevel,
  getPitchMazeCell,
  type CardinalDirection,
  type PitchMazeLevel,
  type PitchMazeMoveResult,
  type PitchMazePosition,
} from "../apps/web/src/features/voice-arcade/pitch-maze-model";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const WINDOW_SECONDS = WINDOW_SIZE / SAMPLE_RATE;
const HOP_SIZE = 960;
const HOP_SECONDS = HOP_SIZE / SAMPLE_RATE;
const LEVEL_OPTIONS = Object.freeze({
  seed: "pitch-maze-pcm-proof",
  voiceRange: Object.freeze({ lowMidi: 43, highMidi: 64, baselineMidi: 49 }),
  level: 1,
  mappingMode: "adjacent" as const,
  difficulty: "easy" as const,
});

type NoiseProfile = "none" | "white" | "room";

interface WindowRecipe {
  readonly midi?: number | null;
  readonly voiceRmsDbfs?: number;
  readonly snrDb?: number;
  readonly noiseRmsDbfs?: number;
  readonly noiseProfile?: NoiseProfile;
  readonly seed?: number;
}

interface ProcessedWindow {
  readonly frame: PitchObservation;
  readonly event: PitchMazeControllerEvent | null;
  readonly move: PitchMazeMoveResult | null;
}

function amplitudeFromDbfs(dbfs: number): number {
  return 10 ** (dbfs / 20);
}

function rms(samples: ArrayLike<number>): number {
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sumSquares += samples[index]! ** 2;
  }
  return samples.length === 0 ? 0 : Math.sqrt(sumSquares / samples.length);
}

function scaleToRms(samples: Float64Array, targetRms: number): void {
  const measuredRms = rms(samples);
  if (measuredRms === 0) return;
  const scale = targetRms / measuredRms;
  for (let index = 0; index < samples.length; index += 1) samples[index] *= scale;
}

function seededNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state / 0xffff_ffff) * 2 - 1;
  };
}

/**
 * A deterministic microphone-sized PCM observation. The source is not an
 * idealized MIDI frame: it has four vocal harmonics plus seeded white noise
 * and optional 60/120 Hz room hum, normalized to a declared SNR.
 */
function makeWindow(recipe: Readonly<WindowRecipe>, observationIndex: number): Float32Array {
  const midi = recipe.midi ?? null;
  const voiceRmsDbfs = recipe.voiceRmsDbfs ?? -24;
  const noiseProfile = recipe.noiseProfile ?? (recipe.snrDb === undefined ? "none" : "room");
  const absoluteStart = observationIndex * HOP_SIZE;
  const voice = new Float64Array(WINDOW_SIZE);
  const noise = new Float64Array(WINDOW_SIZE);

  if (midi !== null) {
    const frequency = midiToFrequency(midi);
    const multiples = [1, 2, 3, 4] as const;
    const weights = [1, 0.52, 0.27, 0.13] as const;
    const phases = [0.1, 0.7, 1.3, 0.35] as const;
    for (let index = 0; index < WINDOW_SIZE; index += 1) {
      const time = (absoluteStart + index) / SAMPLE_RATE;
      for (let harmonic = 0; harmonic < multiples.length; harmonic += 1) {
        voice[index] += weights[harmonic]!
          * Math.sin(2 * Math.PI * frequency * multiples[harmonic]! * time + phases[harmonic]!);
      }
    }
    scaleToRms(voice, amplitudeFromDbfs(voiceRmsDbfs));
  }

  const targetNoiseRms = recipe.noiseRmsDbfs !== undefined
    ? amplitudeFromDbfs(recipe.noiseRmsDbfs)
    : recipe.snrDb !== undefined && midi !== null
      ? amplitudeFromDbfs(voiceRmsDbfs - recipe.snrDb)
      : 0;
  if (noiseProfile !== "none" && targetNoiseRms > 0) {
    const random = seededNoise(
      (recipe.seed ?? 0x4e_46_47_45) ^ Math.imul(observationIndex + 1, 0x9e_37_79_b1),
    );
    for (let index = 0; index < WINDOW_SIZE; index += 1) {
      const time = (absoluteStart + index) / SAMPLE_RATE;
      const white = random();
      noise[index] = noiseProfile === "white"
        ? white
        : 0.82 * white
          + 0.34 * Math.sin(2 * Math.PI * 60 * time + 0.4)
          + 0.16 * Math.sin(2 * Math.PI * 120 * time + 1.1);
    }
    scaleToRms(noise, targetNoiseRms);
  }

  return Float32Array.from(voice, (sample, index) => sample + noise[index]!);
}

function directPitchFrame(samples: Float32Array, timeSeconds: number): PitchObservation {
  const startSample = Math.max(0, Math.round(timeSeconds * SAMPLE_RATE - samples.length / 2));
  const endSample = startSample + samples.length;
  return new NoteInputEngine().process({
    samples,
    sampleRate: SAMPLE_RATE,
    capturedAt: (startSample + endSample) / (2 * SAMPLE_RATE),
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

function samePosition(left: Readonly<PitchMazePosition>, right: Readonly<PitchMazePosition>): boolean {
  return left.row === right.row && left.column === right.column;
}

/**
 * Deterministic PCM integration version of the live callback: overlapping PCM
 * -> direct detector observation -> four-note dwell controller -> maze movement.
 */
class PitchMazePcmHarness {
  controller: PitchMazeControllerState;
  level: PitchMazeLevel;
  readonly windows: ProcessedWindow[] = [];
  private observationIndex = 0;
  private lastTimeSeconds: number | null = null;

  constructor(level: PitchMazeLevel = createPitchMazeLevel(LEVEL_OPTIONS)) {
    this.level = level;
    this.controller = createPitchMazeController({
      directionNotes: level.directionNotes,
      requiredHoldSeconds: level.config.holdDurationSeconds,
      toleranceCents: level.config.toleranceCents,
      acquisitionCorridorCents: 48,
      directionSwitchHysteresisCents: 10,
    });
  }

  get events(): PitchMazeControllerEvent[] {
    return this.windows.flatMap((window) => window.event === null ? [] : [window.event]);
  }

  get commands(): Extract<PitchMazeControllerEvent, { type: "command-complete" }>[] {
    return this.events.filter(
      (event): event is Extract<PitchMazeControllerEvent, { type: "command-complete" }> => (
        event.type === "command-complete"
      ),
    );
  }

  get moves(): PitchMazeMoveResult[] {
    return this.windows.flatMap((window) => window.move === null ? [] : [window.move]);
  }

  get timeSeconds(): number {
    return this.lastTimeSeconds ?? 0;
  }

  push(recipe: Readonly<WindowRecipe>, timeSeconds?: number): ProcessedWindow {
    const timestamp = timeSeconds ?? (
      this.lastTimeSeconds === null ? WINDOW_SECONDS / 2 : this.lastTimeSeconds + HOP_SECONDS
    );
    if (this.lastTimeSeconds !== null && timestamp <= this.lastTimeSeconds) {
      throw new RangeError("Synthetic observations must have strictly increasing timestamps.");
    }
    const samples = makeWindow(recipe, this.observationIndex);
    this.observationIndex += 1;
    this.lastTimeSeconds = timestamp;
    const frame = directPitchFrame(samples, timestamp);
    const update = updatePitchMazeController(this.controller, frame);
    this.controller = update.state;
    const move = update.event?.type === "command-complete"
      ? applyCompletedPitchMazeMove(this.level, update.event.command.direction)
      : null;
    if (move !== null) this.level = move.level;
    const processed = { frame, event: update.event, move };
    this.windows.push(processed);
    return processed;
  }

  pushMany(recipe: Readonly<WindowRecipe>, count: number): void {
    for (let index = 0; index < count; index += 1) this.push(recipe);
  }
}

function committedTone(midi: number, seed = 0xc3_18_60): WindowRecipe {
  return {
    midi,
    voiceRmsDbfs: -24,
    snrDb: 18,
    noiseProfile: "room",
    seed,
  };
}

describe("Pitch Maze PCM-to-controller integration (not browser proof)", () => {
  it("uses the expected four adjacent chromatic notes for the integration level", () => {
    const level = createPitchMazeLevel(LEVEL_OPTIONS);
    expect(level.directionNotes).toEqual({ north: 48, east: 49, south: 50, west: 51 });
  });

  it.each(CARDINAL_DIRECTIONS)(
    "turns a committed 18 dB-SNR %s tone into exactly one matching command",
    (direction) => {
      const harness = new PitchMazePcmHarness();
      const targetMidi = harness.level.directionNotes[direction];
      harness.pushMany(committedTone(targetMidi), 26);

      expect(harness.commands).toHaveLength(1);
      expect(harness.commands[0]).toMatchObject({
        command: { direction, targetMidi, inBandRatio: expect.any(Number) },
      });
      expect(harness.commands[0]!.command.inBandRatio).toBeGreaterThan(0.9);
      expect(harness.moves).toHaveLength(1);
      expect(harness.controller).toMatchObject({
        phase: "armed",
        committedDirection: direction,
        completedCommandCount: 1,
      });
    },
  );

  it("emits one command for a held note, observes silence, then accepts the adjacent note", () => {
    const harness = new PitchMazePcmHarness();
    const northMidi = harness.level.directionNotes.north;
    const eastMidi = harness.level.directionNotes.east;

    harness.pushMany(committedTone(northMidi), 26);
    expect(harness.commands.map((event) => event.command.direction)).toEqual(["north"]);

    // Continuing the same physical gesture can never turn into auto-repeat.
    harness.pushMany(committedTone(northMidi), 12);
    expect(harness.commands.map((event) => event.command.direction)).toEqual(["north"]);
    expect(harness.controller).toMatchObject({ phase: "armed", committedDirection: "north" });

    harness.pushMany({ midi: null }, 1);
    expect(harness.controller).toMatchObject({ phase: "armed", committedDirection: null });

    harness.pushMany(committedTone(eastMidi, 0xc4_18_60), 26);
    expect(harness.commands.map((event) => event.command.direction)).toEqual(["north", "east"]);
    expect(harness.commands[1]!.command.targetMidi).toBe(northMidi + 1);
    expect(harness.controller.completedCommandCount).toBe(2);
  });

  it.each([
    {
      label: "seeded room noise without a voice",
      recipe: {
        midi: null,
        noiseProfile: "room" as const,
        noiseRmsDbfs: -24,
        seed: 0x51_1e_4c_e0,
      },
    },
    {
      label: "a D3 attempt buried at -6 dB SNR",
      recipe: {
        midi: 50,
        voiceRmsDbfs: -24,
        snrDb: -6,
        noiseProfile: "room" as const,
        seed: 0xad_5e_25,
      },
    },
  ])("does not turn $label into movement", ({ recipe }) => {
    const harness = new PitchMazePcmHarness();
    harness.pushMany(recipe, 40);

    expect(harness.commands).toEqual([]);
    expect(harness.moves).toEqual([]);
    expect(harness.controller.completedCommandCount).toBe(0);
    expect(samePosition(harness.level.player, harness.level.start)).toBe(true);
  });

  it("earns a blocked direction from PCM but leaves the player in the same cell", () => {
    const level = createPitchMazeLevel(LEVEL_OPTIONS);
    const blockedDirection = CARDINAL_DIRECTIONS.find(
      (direction): direction is CardinalDirection => getPitchMazeCell(level).walls[direction],
    );
    expect(blockedDirection).toBeDefined();
    const startingPosition = level.player;
    const harness = new PitchMazePcmHarness(level);
    harness.pushMany(committedTone(level.directionNotes[blockedDirection!]), 26);

    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]!.command.direction).toBe(blockedDirection);
    expect(harness.moves).toHaveLength(1);
    expect(harness.moves[0]).toMatchObject({ moved: false, reason: "wall" });
    expect(samePosition(harness.level.player, startingPosition)).toBe(true);
    expect(harness.level.moves).toBe(0);
  });
});
