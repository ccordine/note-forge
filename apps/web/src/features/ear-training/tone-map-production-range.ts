import {
  RANGE_PROFILE_MAX_MIDI,
  RANGE_PROFILE_MIN_MIDI,
} from "@/features/range-loop/profile";

/** The full piano remains available for identification; production uses the detector's enclosed semitones. */
export function isToneMapProductionMidiSupported(midi: number): boolean {
  return Number.isInteger(midi)
    && midi >= RANGE_PROFILE_MIN_MIDI
    && midi <= RANGE_PROFILE_MAX_MIDI;
}
