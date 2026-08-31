import { pitchFrameAtMidi } from "./pitch";
import type { MedianSmoothingOptions, PitchFrame } from "./types";

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function clonePitchFrame<T extends PitchFrame>(frame: T): T {
  return { ...frame };
}

function validateReferenceFrequency(value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new RangeError("a4Frequency must be a finite positive number");
  }
}

function validMidi(
  frame: PitchFrame,
): frame is PitchFrame & { midiFloat: number } {
  return frame.voiced && frame.midiFloat !== null
    && Number.isFinite(frame.midiFloat);
}

/**
 * Apply a short median presentation filter without inventing pitch across
 * unvoiced gaps or transposing octave-related evidence.
 */
export function medianSmoothPitchFrames<T extends PitchFrame>(
  frames: readonly T[],
  options: MedianSmoothingOptions = {},
): T[] {
  const radius = options.radius ?? 1;
  const minSamples = options.minSamples ?? 2 * radius + 1;

  if (!Number.isInteger(radius) || radius < 0) {
    throw new RangeError("radius must be a non-negative integer");
  }
  if (!Number.isInteger(minSamples) || minSamples <= 0) {
    throw new RangeError("minSamples must be a positive integer");
  }
  if (minSamples > 2 * radius + 1) {
    throw new RangeError("minSamples cannot exceed the smoothing window size");
  }
  validateReferenceFrequency(options.a4Frequency);

  return frames.map((frame, index) => {
    if (!validMidi(frame) || radius === 0) {
      return clonePitchFrame(frame);
    }

    const values: number[] = [frame.midiFloat];
    for (let offset = 1; offset <= radius; offset += 1) {
      const left = frames[index - offset];
      if (left === undefined || !validMidi(left)) break;
      values.push(left.midiFloat);
    }
    for (let offset = 1; offset <= radius; offset += 1) {
      const right = frames[index + offset];
      if (right === undefined || !validMidi(right)) break;
      values.push(right.midiFloat);
    }

    return values.length >= minSamples
      ? pitchFrameAtMidi(frame, median(values), options.a4Frequency)
      : clonePitchFrame(frame);
  });
}
