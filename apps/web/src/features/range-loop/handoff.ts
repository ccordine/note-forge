const RANGE_LOOP_HANDOFF_KEY = "hum.range-loop.handoff";
const MINIMUM_HANDOFF_MIDI = 30;
const MAXIMUM_HANDOFF_MIDI = 86;
let cachedHandoffMidi: number | null | undefined;

function isHandoffMidi(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= MINIMUM_HANDOFF_MIDI
    && (value as number) <= MAXIMUM_HANDOFF_MIDI;
}

/** Queue a one-use, same-tab request for Range Loop to start at this baseline. */
export function queueRangeLoopHandoff(midi: number): boolean {
  if (!isHandoffMidi(midi)) throw new RangeError("Range Loop handoff MIDI must be an integer from 30 through 86.");
  cachedHandoffMidi = midi;
  try {
    window.sessionStorage.setItem(RANGE_LOOP_HANDOFF_KEY, String(midi));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the handoff. A module cache keeps it stable across React Strict Mode's
 * throwaway effect pass; clear it only after the active hydration applies it.
 */
export function consumeRangeLoopHandoff(): number | null {
  if (cachedHandoffMidi !== undefined) return cachedHandoffMidi;
  try {
    const raw = window.sessionStorage.getItem(RANGE_LOOP_HANDOFF_KEY);
    window.sessionStorage.removeItem(RANGE_LOOP_HANDOFF_KEY);
    const midi = raw === null ? null : Number(raw);
    cachedHandoffMidi = isHandoffMidi(midi) ? midi : null;
    return cachedHandoffMidi;
  } catch {
    cachedHandoffMidi = null;
    return null;
  }
}

export function clearRangeLoopHandoff(): void {
  cachedHandoffMidi = undefined;
  try {
    window.sessionStorage.removeItem(RANGE_LOOP_HANDOFF_KEY);
  } catch {
    // A same-tab in-memory handoff can still be cleared when storage is locked.
  }
}
