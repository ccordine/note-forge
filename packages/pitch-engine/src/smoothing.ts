import { clonePitchFrame, pitchFrameAtMidi } from "./pitch";
import type {
  MedianSmoothingOptions,
  OctaveCorrectionOptions,
  PitchFrame,
  PitchSmoothingOptions,
} from "./types";

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function validMidi(
  frame: PitchFrame,
): frame is PitchFrame & { midiFloat: number } {
  return frame.voiced && frame.midiFloat !== null &&
    Number.isFinite(frame.midiFloat);
}

/**
 * Apply a short median filter without inventing pitch across unvoiced gaps.
 */
export function medianSmoothPitchFrames(
  frames: readonly PitchFrame[],
  options: MedianSmoothingOptions = {},
): PitchFrame[] {
  const radius = options.radius ?? 1;
  const minSamples = options.minSamples ?? 2 * radius + 1;

  if (!Number.isInteger(radius) || radius < 0) {
    throw new RangeError("radius must be a non-negative integer");
  }
  if (!Number.isInteger(minSamples) || minSamples <= 0) {
    throw new RangeError("minSamples must be a positive integer");
  }

  return frames.map((frame, index) => {
    if (!validMidi(frame) || radius === 0) {
      return clonePitchFrame(frame);
    }

    const values: number[] = [frame.midiFloat];
    for (let offset = 1; offset <= radius; offset += 1) {
      const left = frames[index - offset];
      if (left === undefined || !validMidi(left)) {
        break;
      }
      values.push(left.midiFloat);
    }
    for (let offset = 1; offset <= radius; offset += 1) {
      const right = frames[index + offset];
      if (right === undefined || !validMidi(right)) {
        break;
      }
      values.push(right.midiFloat);
    }

    return values.length >= minSamples
      ? pitchFrameAtMidi(frame, median(values), options.a4Frequency)
      : clonePitchFrame(frame);
  });
}

function timestampsAreContinuous(
  previous: PitchFrame,
  next: PitchFrame,
  maxGapSeconds: number,
): boolean {
  const gap = next.timeSeconds - previous.timeSeconds;
  return gap >= 0 && gap <= maxGapSeconds;
}

interface OctaveRelation {
  shift: number;
  residualCents: number;
}

function octaveRelation(
  anchorMidi: number,
  candidateMidi: number,
  maxOctaveShift: number,
): OctaveRelation | null {
  const semitoneDifference = candidateMidi - anchorMidi;
  const shift = Math.round(semitoneDifference / 12);
  if (shift === 0 || Math.abs(shift) > maxOctaveShift) {
    return null;
  }

  return {
    shift,
    residualCents: 100 * (semitoneDifference - shift * 12),
  };
}

/**
 * Correct only brief octave-related runs that return to the prior contour.
 * Sustained octave changes are deliberately retained as musically plausible.
 */
export function correctOctaveJumps(
  frames: readonly PitchFrame[],
  options: OctaveCorrectionOptions = {},
): PitchFrame[] {
  const octaveToleranceCents = options.octaveToleranceCents ?? 80;
  const maxOutlierFrames = options.maxOutlierFrames ?? 3;
  const maxOctaveShift = options.maxOctaveShift ?? 2;
  const maxFrameGapSeconds = options.maxFrameGapSeconds ?? 0.1;
  const maxReturnDistanceCents = options.maxReturnDistanceCents ?? 350;

  for (
    const [value, name] of [
      [octaveToleranceCents, "octaveToleranceCents"],
      [maxFrameGapSeconds, "maxFrameGapSeconds"],
      [maxReturnDistanceCents, "maxReturnDistanceCents"],
    ] as const
  ) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a finite non-negative number`);
    }
  }
  if (!Number.isInteger(maxOutlierFrames) || maxOutlierFrames < 1) {
    throw new RangeError("maxOutlierFrames must be a positive integer");
  }
  if (!Number.isInteger(maxOctaveShift) || maxOctaveShift < 1) {
    throw new RangeError("maxOctaveShift must be a positive integer");
  }

  const corrected = frames.map(clonePitchFrame);
  let anchorIndex = -1;
  let index = 0;

  while (index < corrected.length) {
    const frame = corrected[index];
    if (!validMidi(frame)) {
      anchorIndex = -1;
      index += 1;
      continue;
    }
    if (anchorIndex < 0 || !validMidi(corrected[anchorIndex])) {
      anchorIndex = index;
      index += 1;
      continue;
    }

    const anchor = corrected[anchorIndex] as PitchFrame & { midiFloat: number };
    if (!timestampsAreContinuous(anchor, frame, maxFrameGapSeconds)) {
      anchorIndex = index;
      index += 1;
      continue;
    }

    const relation = octaveRelation(
      anchor.midiFloat,
      frame.midiFloat,
      maxOctaveShift,
    );
    if (
      relation === null ||
      Math.abs(relation.residualCents) > octaveToleranceCents
    ) {
      anchorIndex = index;
      index += 1;
      continue;
    }

    let runEnd = index;
    while (
      runEnd + 1 < corrected.length && runEnd - index + 1 < maxOutlierFrames
    ) {
      const currentRunFrame = corrected[runEnd];
      const nextRunFrame = corrected[runEnd + 1];
      if (
        !validMidi(currentRunFrame) ||
        !validMidi(nextRunFrame) ||
        !timestampsAreContinuous(
          currentRunFrame,
          nextRunFrame,
          maxFrameGapSeconds,
        )
      ) {
        break;
      }

      const nextRelation = octaveRelation(
        anchor.midiFloat,
        nextRunFrame.midiFloat,
        maxOctaveShift,
      );
      if (
        nextRelation === null ||
        nextRelation.shift !== relation.shift ||
        Math.abs(nextRelation.residualCents) > octaveToleranceCents
      ) {
        break;
      }
      runEnd += 1;
    }

    const returnIndex = runEnd + 1;
    const returnFrame = corrected[returnIndex];
    const lastRunFrame = corrected[runEnd];
    const returnsToAnchor = returnFrame !== undefined &&
      validMidi(returnFrame) &&
      timestampsAreContinuous(lastRunFrame, returnFrame, maxFrameGapSeconds) &&
      Math.abs(returnFrame.midiFloat - anchor.midiFloat) * 100 <=
        maxReturnDistanceCents;

    if (!returnsToAnchor) {
      anchorIndex = index;
      index += 1;
      continue;
    }

    for (let outlierIndex = index; outlierIndex <= runEnd; outlierIndex += 1) {
      const outlier = corrected[outlierIndex];
      if (validMidi(outlier)) {
        corrected[outlierIndex] = pitchFrameAtMidi(
          outlier,
          outlier.midiFloat - relation.shift * 12,
          options.a4Frequency,
        );
      }
    }

    anchorIndex = runEnd;
    index = returnIndex;
  }

  return corrected;
}

/** Conservative octave repair followed by a short median contour filter. */
export function smoothPitchFrames(
  frames: readonly PitchFrame[],
  options: PitchSmoothingOptions = {},
): PitchFrame[] {
  const octaveCorrected = options.correctOctaveJumps === false
    ? frames.map(clonePitchFrame)
    : correctOctaveJumps(frames, options);

  return medianSmoothPitchFrames(octaveCorrected, options);
}
