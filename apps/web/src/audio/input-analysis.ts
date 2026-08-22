/** The quietest level represented by the input meters. */
export const DEFAULT_DBFS_FLOOR = -120;

/** Slightly below full scale so a meter can warn before hard clipping is sustained. */
export const DEFAULT_CLIPPING_THRESHOLD = 0.999;

export interface InputAnalysisOptions {
  /** Display floor used when a measurement has no energy. */
  dbFloor?: number;
  /** Linear sample magnitude counted as clipping. */
  clippingThreshold?: number;
}

export interface InputBufferDiagnostics {
  sampleCount: number;
  validSampleCount: number;
  invalidSampleCount: number;
  rms: number;
  rmsDbfs: number;
  peak: number;
  peakDbfs: number;
  dcOffset: number;
  dcOffsetDbfs: number;
  clippedSampleCount: number;
  clippingRatio: number;
  isClipping: boolean;
  crestFactor: number | null;
  crestFactorDb: number | null;
}

export interface NoiseFloorEstimateOptions {
  /** Quantile of the calibration readings to use. The median is robust to brief sounds. */
  quantile?: number;
  minimumDbfs?: number;
  maximumDbfs?: number;
}

export interface GateLevelOptions {
  /** Amount the opening threshold should sit above the measured room noise. */
  marginDb?: number;
  /** Quietest permitted opening threshold. */
  minimumDbfs?: number;
  /** Loudest permitted opening threshold. */
  maximumDbfs?: number;
}

export interface NoiseGateOptions extends GateLevelOptions {
  /** Distance below the opening threshold at which an open gate closes. */
  hysteresisDb?: number;
}

export interface NoiseGateThresholds {
  noiseFloorDbfs: number;
  openThresholdDbfs: number;
  closeThresholdDbfs: number;
  marginDb: number;
  hysteresisDb: number;
}

function assertDbFloor(dbFloor: number): void {
  if (!Number.isFinite(dbFloor) || dbFloor > 0) {
    throw new RangeError("dbFloor must be a finite value at or below 0 dBFS.");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Converts a linear amplitude magnitude to dBFS without hiding over-scale values. */
export function amplitudeToDbfs(
  amplitude: number,
  dbFloor = DEFAULT_DBFS_FLOOR,
): number {
  assertDbFloor(dbFloor);
  if (!Number.isFinite(amplitude) || amplitude === 0) {
    return dbFloor;
  }

  return Math.max(dbFloor, 20 * Math.log10(Math.abs(amplitude)));
}

/** Converts dBFS to a positive linear amplitude. */
export function dbfsToAmplitude(dbfs: number): number {
  if (dbfs === Number.NEGATIVE_INFINITY) {
    return 0;
  }
  if (!Number.isFinite(dbfs)) {
    throw new RangeError("dbfs must be finite or negative infinity.");
  }

  return 10 ** (dbfs / 20);
}

/**
 * Measures one raw PCM buffer. Non-finite samples are reported and excluded from
 * the aggregates so a broken sample cannot turn every meter value into NaN.
 */
export function analyzeInputBuffer(
  samples: ArrayLike<number>,
  options: InputAnalysisOptions = {},
): InputBufferDiagnostics {
  const dbFloor = options.dbFloor ?? DEFAULT_DBFS_FLOOR;
  const clippingThreshold =
    options.clippingThreshold ?? DEFAULT_CLIPPING_THRESHOLD;
  assertDbFloor(dbFloor);
  if (!Number.isFinite(clippingThreshold) || clippingThreshold <= 0) {
    throw new RangeError("clippingThreshold must be a positive finite value.");
  }

  let validSampleCount = 0;
  let sum = 0;
  let sumOfSquares = 0;
  let peak = 0;
  let clippedSampleCount = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!Number.isFinite(sample)) {
      continue;
    }

    const magnitude = Math.abs(sample);
    validSampleCount += 1;
    sum += sample;
    sumOfSquares += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude >= clippingThreshold) {
      clippedSampleCount += 1;
    }
  }

  const rms = validSampleCount > 0
    ? Math.sqrt(sumOfSquares / validSampleCount)
    : 0;
  const dcOffset = validSampleCount > 0 ? sum / validSampleCount : 0;
  const crestFactor = rms > 0 ? peak / rms : null;

  return {
    sampleCount: samples.length,
    validSampleCount,
    invalidSampleCount: samples.length - validSampleCount,
    rms,
    rmsDbfs: amplitudeToDbfs(rms, dbFloor),
    peak,
    peakDbfs: amplitudeToDbfs(peak, dbFloor),
    dcOffset,
    dcOffsetDbfs: amplitudeToDbfs(dcOffset, dbFloor),
    clippedSampleCount,
    clippingRatio: validSampleCount > 0
      ? clippedSampleCount / validSampleCount
      : 0,
    isClipping: clippedSampleCount > 0,
    crestFactor,
    crestFactorDb: crestFactor === null
      ? null
      : 20 * Math.log10(crestFactor),
  };
}

/**
 * Estimates the ambient level from a sequence of per-buffer dB readings.
 * Median-by-default estimation resists speech, coughs, and other short transients
 * during a quiet-room calibration.
 */
export function estimateNoiseFloorDbfs(
  readingsDbfs: readonly number[],
  options: NoiseFloorEstimateOptions = {},
): number | null {
  const quantile = options.quantile ?? 0.5;
  const minimumDbfs = options.minimumDbfs ?? DEFAULT_DBFS_FLOOR;
  const maximumDbfs = options.maximumDbfs ?? 0;
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new RangeError("quantile must be between 0 and 1.");
  }
  if (
    !Number.isFinite(minimumDbfs)
    || !Number.isFinite(maximumDbfs)
    || minimumDbfs > maximumDbfs
  ) {
    throw new RangeError("minimumDbfs must not exceed maximumDbfs.");
  }

  const sorted = readingsDbfs
    .filter((reading) => Number.isFinite(reading))
    .map((reading) => clamp(reading, minimumDbfs, maximumDbfs))
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }

  const position = (sorted.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const fraction = position - lowerIndex;
  return sorted[lowerIndex]
    + fraction * (sorted[upperIndex] - sorted[lowerIndex]);
}

/** Derives a usable gate-opening level from the room noise, clamped for safety. */
export function deriveGateLevelDbfs(
  noiseFloorDbfs: number,
  options: GateLevelOptions = {},
): number {
  const marginDb = options.marginDb ?? 12;
  const minimumDbfs = options.minimumDbfs ?? -72;
  const maximumDbfs = options.maximumDbfs ?? -18;
  if (!Number.isFinite(noiseFloorDbfs)) {
    throw new RangeError("noiseFloorDbfs must be finite.");
  }
  if (!Number.isFinite(marginDb) || marginDb < 0) {
    throw new RangeError("marginDb must be a non-negative finite value.");
  }
  if (
    !Number.isFinite(minimumDbfs)
    || !Number.isFinite(maximumDbfs)
    || minimumDbfs > maximumDbfs
  ) {
    throw new RangeError("minimumDbfs must not exceed maximumDbfs.");
  }

  return clamp(noiseFloorDbfs + marginDb, minimumDbfs, maximumDbfs);
}

/** Creates separate open/close levels so borderline input does not chatter. */
export function deriveNoiseGateThresholds(
  noiseFloorDbfs: number,
  options: NoiseGateOptions = {},
): NoiseGateThresholds {
  const marginDb = options.marginDb ?? 12;
  const hysteresisDb = options.hysteresisDb ?? 4;
  if (!Number.isFinite(hysteresisDb) || hysteresisDb < 0) {
    throw new RangeError("hysteresisDb must be a non-negative finite value.");
  }

  const openThresholdDbfs = deriveGateLevelDbfs(noiseFloorDbfs, options);
  return {
    noiseFloorDbfs,
    openThresholdDbfs,
    closeThresholdDbfs: openThresholdDbfs - hysteresisDb,
    marginDb,
    hysteresisDb,
  };
}

/**
 * Advances a gate one frame. A closed gate opens at the upper threshold; an
 * open gate remains open until the signal reaches the lower threshold.
 */
export function applyGateHysteresis(
  wasOpen: boolean,
  levelDbfs: number | null,
  thresholds: Pick<
    NoiseGateThresholds,
    "openThresholdDbfs" | "closeThresholdDbfs"
  >,
): boolean {
  const { openThresholdDbfs, closeThresholdDbfs } = thresholds;
  if (
    !Number.isFinite(openThresholdDbfs)
    || !Number.isFinite(closeThresholdDbfs)
    || closeThresholdDbfs > openThresholdDbfs
  ) {
    throw new RangeError(
      "Gate thresholds must be finite and closeThresholdDbfs must not exceed openThresholdDbfs.",
    );
  }
  if (levelDbfs === null || !Number.isFinite(levelDbfs)) {
    return false;
  }

  return wasOpen
    ? levelDbfs > closeThresholdDbfs
    : levelDbfs >= openThresholdDbfs;
}
