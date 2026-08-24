import { frequencyToMidi } from "@noteforge/music-core";
import { NOTE_INPUT_DEFAULTS } from "../../audio/note-input";
import type { ArcadeVoiceRange } from "./types";
import {
  VOICE_DRAW_DIRECTIONS,
  type VoiceDrawDirection,
  type VoiceDrawDirectionVector,
  type VoiceDrawNoteBank,
  type VoiceDrawNoteMapping,
} from "./voice-draw-types";

const DRAW_MIN_MIDI = Math.ceil(frequencyToMidi(
  NOTE_INPUT_DEFAULTS.minFrequency,
  NOTE_INPUT_DEFAULTS.a4Frequency,
));
const DRAW_MAX_MIDI = Math.floor(frequencyToMidi(
  NOTE_INPUT_DEFAULTS.maxFrequency,
  NOTE_INPUT_DEFAULTS.a4Frequency,
));
const DRAW_NOTE_COUNT = VOICE_DRAW_DIRECTIONS.length;
const DRAW_MAX_BASE_MIDI = DRAW_MAX_MIDI - DRAW_NOTE_COUNT + 1;
const DIAGONAL_COMPONENT = Math.SQRT1_2;

export const VOICE_DRAW_DIRECTION_VECTORS = Object.freeze({
  up: Object.freeze({ dx: 0, dy: -1 }),
  "up-right": Object.freeze({ dx: DIAGONAL_COMPONENT, dy: -DIAGONAL_COMPONENT }),
  right: Object.freeze({ dx: 1, dy: 0 }),
  "down-right": Object.freeze({ dx: DIAGONAL_COMPONENT, dy: DIAGONAL_COMPONENT }),
  down: Object.freeze({ dx: 0, dy: 1 }),
  "down-left": Object.freeze({ dx: -DIAGONAL_COMPONENT, dy: DIAGONAL_COMPONENT }),
  left: Object.freeze({ dx: -1, dy: 0 }),
  "up-left": Object.freeze({ dx: -DIAGONAL_COMPONENT, dy: -DIAGONAL_COMPONENT }),
}) satisfies Readonly<Record<VoiceDrawDirection, VoiceDrawDirectionVector>>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function requireMidi(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 127) {
    throw new RangeError(`${label} must be an integer MIDI note from 0 through 127.`);
  }
}

function validateVoiceRange(range: Readonly<ArcadeVoiceRange>): void {
  requireMidi(range.lowMidi, "Low range edge");
  requireMidi(range.highMidi, "High range edge");
  requireMidi(range.baselineMidi, "Range baseline");
  if (range.lowMidi > range.highMidi) {
    throw new RangeError("Low range edge cannot be above the high range edge.");
  }
  if (range.baselineMidi < range.lowMidi || range.baselineMidi > range.highMidi) {
    throw new RangeError("Range baseline must remain inside the supplied profile.");
  }
}

/** Anchor Up to the baseline and assign the next seven chromatic directions clockwise. */
export function createVoiceDrawNoteBank(
  voiceRange: Readonly<ArcadeVoiceRange>,
): VoiceDrawNoteBank {
  validateVoiceRange(voiceRange);
  const baseMidi = clamp(voiceRange.baselineMidi, DRAW_MIN_MIDI, DRAW_MAX_BASE_MIDI);
  const mappings = VOICE_DRAW_DIRECTIONS.map((direction, index) => {
    const midi = baseMidi + index;
    const vector = VOICE_DRAW_DIRECTION_VECTORS[direction];
    return Object.freeze({
      index,
      midi,
      direction,
      dx: vector.dx,
      dy: vector.dy,
      inProfileRange: midi >= voiceRange.lowMidi && midi <= voiceRange.highMidi,
    });
  });
  const profileNoteCount = mappings.filter(({ inProfileRange }) => inProfileRange).length;
  const outsideProfileNoteCount = DRAW_NOTE_COUNT - profileNoteCount;
  return Object.freeze({
    baseMidi,
    topMidi: baseMidi + DRAW_NOTE_COUNT - 1,
    profileLowMidi: voiceRange.lowMidi,
    profileHighMidi: voiceRange.highMidi,
    profileBaselineMidi: voiceRange.baselineMidi,
    mappings: Object.freeze(mappings),
    profileNoteCount,
    outsideProfileNoteCount,
    expandedOutsideProfile: outsideProfileNoteCount > 0,
  });
}

export function getVoiceDrawMapping(
  noteBank: Readonly<VoiceDrawNoteBank>,
  nearestMidi: number | null,
): VoiceDrawNoteMapping | null {
  if (!Number.isInteger(nearestMidi)) return null;
  return noteBank.mappings.find((mapping) => mapping.midi === nearestMidi) ?? null;
}
