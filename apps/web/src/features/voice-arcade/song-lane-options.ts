import type {
  ResolvedSongLaneOptions,
  SongLaneAnalysisOptions,
  SongLaneDifficulty,
  VocalMidiRange,
} from "./song-lane-types";

const DEFAULT_ANALYSIS_SAMPLE_RATE = 8_000;
const DEFAULT_MIN_FREQUENCY_HZ = 65;
const DEFAULT_MAX_FREQUENCY_HZ = 1_200;

export const SONG_LANE_TOLERANCE_CENTS: Readonly<
  Record<SongLaneDifficulty, number>
> = Object.freeze({
  easy: 45,
  medium: 30,
  hard: 18,
  expert: 10,
});

const DIFFICULTIES = new Set<SongLaneDifficulty>([
  "easy",
  "medium",
  "hard",
  "expert",
]);

function requireFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
}

function requireFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

function requireUnitInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function cloneAndValidateRange(range: VocalMidiRange | undefined): VocalMidiRange | null {
  if (range === undefined) return null;
  if (typeof range !== "object" || range === null) {
    throw new TypeError("vocalRange must be an object");
  }
  const { minMidi, maxMidi } = range;
  if (
    !Number.isInteger(minMidi)
    || !Number.isInteger(maxMidi)
    || minMidi < 0
    || maxMidi > 127
    || minMidi > maxMidi
  ) {
    throw new RangeError(
      "vocalRange must contain integer MIDI bounds from 0 to 127 with minMidi <= maxMidi",
    );
  }
  return { minMidi, maxMidi };
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(value));
}

export function resolveSongLaneOptions(
  sourceSampleRate: number,
  options: SongLaneAnalysisOptions = {},
): ResolvedSongLaneOptions {
  requireFinitePositive(sourceSampleRate, "sampleRate");
  if (typeof options !== "object" || options === null) {
    throw new TypeError("options must be an object");
  }

  const analysisSampleRate = options.analysisSampleRate
    ?? Math.min(sourceSampleRate, DEFAULT_ANALYSIS_SAMPLE_RATE);
  requireFinitePositive(analysisSampleRate, "analysisSampleRate");
  if (analysisSampleRate > sourceSampleRate) {
    throw new RangeError("analysisSampleRate cannot exceed sampleRate");
  }

  const minFrequencyHz = options.minFrequencyHz ?? DEFAULT_MIN_FREQUENCY_HZ;
  const maxFrequencyHz = options.maxFrequencyHz
    ?? Math.min(DEFAULT_MAX_FREQUENCY_HZ, analysisSampleRate * 0.45);
  requireFinitePositive(minFrequencyHz, "minFrequencyHz");
  requireFinitePositive(maxFrequencyHz, "maxFrequencyHz");
  if (minFrequencyHz >= maxFrequencyHz) {
    throw new RangeError("minFrequencyHz must be lower than maxFrequencyHz");
  }
  if (maxFrequencyHz >= analysisSampleRate / 2) {
    throw new RangeError("maxFrequencyHz must be below half of analysisSampleRate");
  }

  const defaultFrameSize = nextPowerOfTwo(Math.max(256, analysisSampleRate * 0.05));
  const frameSizeSamples = options.frameSizeSamples ?? defaultFrameSize;
  const hopSizeSamples = options.hopSizeSamples ?? Math.max(1, Math.floor(frameSizeSamples / 4));
  requirePositiveInteger(frameSizeSamples, "frameSizeSamples");
  requirePositiveInteger(hopSizeSamples, "hopSizeSamples");
  if (hopSizeSamples > frameSizeSamples) {
    throw new RangeError("hopSizeSamples cannot exceed frameSizeSamples");
  }
  const largestLag = Math.ceil(analysisSampleRate / minFrequencyHz);
  if (frameSizeSamples < 2 * (largestLag + 1)) {
    throw new RangeError("frameSizeSamples is too small for minFrequencyHz at analysisSampleRate");
  }

  const minimumConfidence = options.minimumConfidence ?? 0.78;
  const rmsThreshold = options.rmsThreshold ?? 0.008;
  const a4Frequency = options.a4Frequency ?? 440;
  requireUnitInterval(minimumConfidence, "minimumConfidence");
  requireFiniteNonNegative(rmsThreshold, "rmsThreshold");
  requireFinitePositive(a4Frequency, "a4Frequency");

  const smoothingRadius = options.smoothingRadius ?? 1;
  if (!Number.isInteger(smoothingRadius) || smoothingRadius < 0) {
    throw new RangeError("smoothingRadius must be a non-negative integer");
  }
  const quantizationHysteresisCents = options.quantizationHysteresisCents ?? 15;
  requireFiniteNonNegative(quantizationHysteresisCents, "quantizationHysteresisCents");
  if (quantizationHysteresisCents >= 50) {
    throw new RangeError("quantizationHysteresisCents must be below 50");
  }

  const minimumLaneSeconds = options.minimumLaneSeconds ?? 0.12;
  const mergeGapSeconds = options.mergeGapSeconds ?? 0.09;
  requireFiniteNonNegative(minimumLaneSeconds, "minimumLaneSeconds");
  requireFiniteNonNegative(mergeGapSeconds, "mergeGapSeconds");

  const difficulty = options.difficulty ?? "medium";
  if (!DIFFICULTIES.has(difficulty)) {
    throw new RangeError("difficulty must be easy, medium, hard, or expert");
  }
  const toleranceCents = options.toleranceCents ?? SONG_LANE_TOLERANCE_CENTS[difficulty];
  requireFinitePositive(toleranceCents, "toleranceCents");
  if (toleranceCents > 100) {
    throw new RangeError("toleranceCents cannot exceed 100");
  }

  return {
    analysisSampleRate,
    frameSizeSamples,
    hopSizeSamples,
    minFrequencyHz,
    maxFrequencyHz,
    minimumConfidence,
    rmsThreshold,
    a4Frequency,
    smoothingRadius,
    quantizationHysteresisCents,
    minimumLaneSeconds,
    mergeGapSeconds,
    vocalRange: cloneAndValidateRange(options.vocalRange),
    difficulty,
    toleranceCents,
  };
}

export function toleranceCentsForDifficulty(difficulty: SongLaneDifficulty): number {
  if (!DIFFICULTIES.has(difficulty)) {
    throw new RangeError("difficulty must be easy, medium, hard, or expert");
  }
  return SONG_LANE_TOLERANCE_CENTS[difficulty];
}
