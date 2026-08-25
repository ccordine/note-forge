import { frequencyToMidi } from "@noteforge/music-core";
import { YIN_FREQUENCY_BOUNDARY_TOLERANCE_CENTS } from "@noteforge/pitch-engine";
import { NOTE_INPUT_DEFAULTS } from "@/audio/note-input";
import { clamp } from "@/lib/numeric";

/** Literal detector boundaries, not merely the enclosed semitone labels. */
export const PITCH_METER_MINIMUM_MIDI = frequencyToMidi(
  NOTE_INPUT_DEFAULTS.minFrequency,
);
export const PITCH_METER_MAXIMUM_MIDI = frequencyToMidi(
  NOTE_INPUT_DEFAULTS.maxFrequency,
);
/**
 * YIN may interpolate one cent beyond a configured search edge. Those values
 * are still detector-admitted evidence, so the visible coordinate domain must
 * represent them distinctly instead of pinning them onto the canonical edge.
 */
export const PITCH_METER_LIVE_MINIMUM_MIDI = PITCH_METER_MINIMUM_MIDI
  - YIN_FREQUENCY_BOUNDARY_TOLERANCE_CENTS / 100;
export const PITCH_METER_LIVE_MAXIMUM_MIDI = PITCH_METER_MAXIMUM_MIDI
  + YIN_FREQUENCY_BOUNDARY_TOLERANCE_CENTS / 100;

/**
 * The central 60% is a fine-control lens. The remaining detector depth stays
 * visible in the two outer wings instead of being collapsed onto an edge.
 */
export const PITCH_METER_FOCUS_LOWER_PERCENT = 20;
export const PITCH_METER_TARGET_PERCENT = 50;
export const PITCH_METER_FOCUS_UPPER_PERCENT = 80;
export const PITCH_METER_DEFAULT_FOCUS_CENTS = 100;

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function validFocusCents(value: number | undefined): number {
  return finite(value) && value > 0
    ? value
    : PITCH_METER_DEFAULT_FOCUS_CENTS;
}

export function pitchMeterMidiIsInRange(midiFloat: number): boolean {
  return Number.isFinite(midiFloat)
    && midiFloat >= PITCH_METER_MINIMUM_MIDI
    && midiFloat <= PITCH_METER_MAXIMUM_MIDI;
}

function targetMidi(targetMidiFloat: number): number {
  if (!pitchMeterMidiIsInRange(targetMidiFloat)) {
    throw new RangeError("Pitch-meter target is outside the detector domain.");
  }
  return targetMidiFloat;
}

function liveMidi(midiFloat: number): number | null {
  if (
    midiFloat < PITCH_METER_LIVE_MINIMUM_MIDI
    || midiFloat > PITCH_METER_LIVE_MAXIMUM_MIDI
  ) return null;
  return midiFloat;
}

/**
 * Project every detector-admitted coordinate into one monotonic meter. Targets
 * remain canonical 45–1,200 Hz; the effective live domain includes YIN's
 * explicit one-cent interpolation allowance beyond those search boundaries.
 *
 * With an interior target, ±`focusHalfSpanCents` occupies the central 20–80%
 * lens so fine intonation remains readable. Near an edge the lens shifts while
 * retaining its nominal fine-control slope, eliminating impossible empty
 * wings. All remaining detector depth is compressed monotonically into the
 * outer space. Without a target, the full detector domain is linear. No
 * admitted pitch aliases an edge unless it is the literal effective boundary.
 */
export function pitchMeterPositionPercent(
  midiFloat: number | null,
  targetMidiFloat?: number,
  focusHalfSpanCents = PITCH_METER_DEFAULT_FOCUS_CENTS,
): number | null {
  const target = finite(targetMidiFloat) ? targetMidi(targetMidiFloat) : undefined;
  if (midiFloat === null || !Number.isFinite(midiFloat)) return null;
  const boundedMidi = liveMidi(midiFloat);
  if (boundedMidi === null) return null;
  if (target === undefined) {
    return (boundedMidi - PITCH_METER_LIVE_MINIMUM_MIDI)
      / (PITCH_METER_LIVE_MAXIMUM_MIDI - PITCH_METER_LIVE_MINIMUM_MIDI)
      * 100;
  }
  const focusSemitones = validFocusCents(focusHalfSpanCents) / 100;
  const lowerFocusMidi = Math.max(
    PITCH_METER_LIVE_MINIMUM_MIDI,
    target - focusSemitones,
  );
  const upperFocusMidi = Math.min(
    PITCH_METER_LIVE_MAXIMUM_MIDI,
    target + focusSemitones,
  );
  const lowerFocusClipped = lowerFocusMidi === PITCH_METER_LIVE_MINIMUM_MIDI;
  const upperFocusClipped = upperFocusMidi === PITCH_METER_LIVE_MAXIMUM_MIDI;
  const focusHalfWidthPercent = PITCH_METER_TARGET_PERCENT
    - PITCH_METER_FOCUS_LOWER_PERCENT;

  /*
   * When both halves fit, the target stays at 50% and each focus half gets the
   * nominal 30 percentage points. Near a detector boundary, shift the target
   * toward that boundary and retain the exact fine-control slope. This keeps
   * the literal detector boundaries at 0/100 without an empty, impossible
   * wing. A focus wider than the entire detector domain falls back to the
   * unique effective-domain coordinate because both nominal halves cannot fit.
   */
  if (lowerFocusClipped && upperFocusClipped) {
    return (boundedMidi - PITCH_METER_LIVE_MINIMUM_MIDI)
      / (PITCH_METER_LIVE_MAXIMUM_MIDI - PITCH_METER_LIVE_MINIMUM_MIDI)
      * 100;
  }
  let targetPercent = PITCH_METER_TARGET_PERCENT;
  if (lowerFocusClipped) {
    targetPercent = (target - PITCH_METER_LIVE_MINIMUM_MIDI)
      / focusSemitones
      * focusHalfWidthPercent;
  } else if (upperFocusClipped) {
    targetPercent = 100
      - (PITCH_METER_LIVE_MAXIMUM_MIDI - target)
        / focusSemitones
        * focusHalfWidthPercent;
  }
  const lowerFocusPercent = targetPercent
    - (target - lowerFocusMidi) / focusSemitones * focusHalfWidthPercent;
  const upperFocusPercent = targetPercent
    + (upperFocusMidi - target) / focusSemitones * focusHalfWidthPercent;

  if (boundedMidi < lowerFocusMidi) {
    const lowerDepth = lowerFocusMidi - PITCH_METER_LIVE_MINIMUM_MIDI;
    if (lowerDepth <= 0) return 0;
    return clamp(
      (boundedMidi - PITCH_METER_LIVE_MINIMUM_MIDI) / lowerDepth
        * lowerFocusPercent,
      0,
      lowerFocusPercent,
    );
  }
  if (boundedMidi > upperFocusMidi) {
    const upperDepth = PITCH_METER_LIVE_MAXIMUM_MIDI - upperFocusMidi;
    if (upperDepth <= 0) return 100;
    return clamp(
      upperFocusPercent
        + (boundedMidi - upperFocusMidi) / upperDepth
          * (100 - upperFocusPercent),
      upperFocusPercent,
      100,
    );
  }

  return clamp(
    targetPercent
      + (boundedMidi - target) / focusSemitones * focusHalfWidthPercent,
    lowerFocusPercent,
    upperFocusPercent,
  );
}

export interface PitchMeterBand {
  readonly leftPercent: number;
  readonly widthPercent: number;
}

/** Target tolerance projected through the exact same full-depth coordinate. */
export function pitchMeterBandPercent(
  targetMidiFloat: number,
  toleranceCents: number,
  focusHalfSpanCents = PITCH_METER_DEFAULT_FOCUS_CENTS,
): PitchMeterBand {
  const target = targetMidi(targetMidiFloat);
  const tolerance = Number.isFinite(toleranceCents)
    ? Math.max(0, toleranceCents)
    : 0;
  const lowerMidi = Math.max(
    PITCH_METER_LIVE_MINIMUM_MIDI,
    target - tolerance / 100,
  );
  const upperMidi = Math.min(
    PITCH_METER_LIVE_MAXIMUM_MIDI,
    target + tolerance / 100,
  );
  const leftPercent = pitchMeterPositionPercent(
    lowerMidi,
    target,
    focusHalfSpanCents,
  ) ?? PITCH_METER_TARGET_PERCENT;
  const rightPercent = pitchMeterPositionPercent(
    upperMidi,
    target,
    focusHalfSpanCents,
  ) ?? PITCH_METER_TARGET_PERCENT;
  return {
    leftPercent,
    widthPercent: Math.max(0, rightPercent - leftPercent),
  };
}
