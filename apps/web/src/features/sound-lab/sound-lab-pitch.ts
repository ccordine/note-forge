import { splitMidiPitch } from "@noteforge/music-core";
import { clamp } from "@/lib/numeric";

export const SOUND_LAB_MINIMUM_MIDI = 36;
export const SOUND_LAB_MAXIMUM_MIDI = 84;
export const SOUND_LAB_SLIDER_STEPS_PER_SEMITONE = 100;

/** One authority for every continuously editable Sound Lab pitch control. */
export function soundLabPitch(
  midi: number,
  cents: number,
): ReturnType<typeof splitMidiPitch> {
  if (!Number.isFinite(midi) || !Number.isFinite(cents)) {
    throw new TypeError("Sound Lab pitch coordinates must be finite.");
  }
  return splitMidiPitch(clamp(
    midi + cents / SOUND_LAB_SLIDER_STEPS_PER_SEMITONE,
    SOUND_LAB_MINIMUM_MIDI,
    SOUND_LAB_MAXIMUM_MIDI,
  ));
}

export function soundLabSliderValue(midi: number, cents: number): number {
  const pitch = soundLabPitch(midi, cents);
  return (
    pitch.midiFloat - SOUND_LAB_MINIMUM_MIDI
  ) * SOUND_LAB_SLIDER_STEPS_PER_SEMITONE;
}

export const SOUND_LAB_SLIDER_MAXIMUM = (
  SOUND_LAB_MAXIMUM_MIDI - SOUND_LAB_MINIMUM_MIDI
) * SOUND_LAB_SLIDER_STEPS_PER_SEMITONE;
