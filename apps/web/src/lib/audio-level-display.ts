import { clampUnit } from "@/lib/numeric";

/**
 * Stable presentation domain shared by every raw microphone-level graph.
 *
 * This is display saturation only: it never admits or rejects pitch evidence.
 * Keeping the bounds fixed means a retained RMS sample always has the same
 * visual coordinate, regardless of which louder or quieter samples arrive
 * later.
 */
export const AUDIO_LEVEL_DISPLAY_MINIMUM_DBFS = -96;
export const AUDIO_LEVEL_DISPLAY_MAXIMUM_DBFS = 0;

export function dbfsDisplayUnit(dbfs: number): number {
  if (dbfs === Number.NEGATIVE_INFINITY) return 0;
  if (!Number.isFinite(dbfs)) {
    throw new RangeError("Displayed dBFS must be finite or negative infinity.");
  }
  return clampUnit(
    (dbfs - AUDIO_LEVEL_DISPLAY_MINIMUM_DBFS)
      / (AUDIO_LEVEL_DISPLAY_MAXIMUM_DBFS - AUDIO_LEVEL_DISPLAY_MINIMUM_DBFS),
  );
}

export function dbfsDisplayPercent(dbfs: number): number {
  return dbfsDisplayUnit(dbfs) * 100;
}

export function rmsDisplayUnit(rms: number): number {
  if (!Number.isFinite(rms) || rms < 0) {
    throw new RangeError("Displayed RMS must be finite and non-negative.");
  }
  return dbfsDisplayUnit(rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms));
}
