export const DEFAULT_BASELINE_MIDI = 48;
export const VOCAL_PROFILE_STORAGE_KEY = "hum.vocal-profile";
export const RANGE_PROFILE_MIN_MIDI = 30;
export const RANGE_PROFILE_MAX_MIDI = 86;

export type ShiftDirection = "ascending" | "descending";
export type BaselineSource = "default" | "manual" | "hum-anchor";

export interface ComfortableBaseline {
  midi: number;
  source: BaselineSource;
  updatedAt: string | null;
}

export interface RegisterShiftMarker {
  midi: number;
  ascending: boolean;
  descending: boolean;
}

/**
 * The current persisted voice-map authority. `usableMidis` is replaced only
 * by a naturally completed Range Simulator summary; an explicitly stopped
 * partial assessment cannot erase untested established range evidence.
 */
export interface PersonalRangeProfile {
  baseline: ComfortableBaseline;
  usableMidis: number[];
  registerShifts: RegisterShiftMarker[];
}

export interface RangeBounds {
  lowMidi: number | null;
  highMidi: number | null;
}

function isProfileMidi(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= RANGE_PROFILE_MIN_MIDI
    && (value as number) <= RANGE_PROFILE_MAX_MIDI;
}

function requireProfileMidi(value: number): void {
  if (!isProfileMidi(value)) {
    throw new RangeError(
      `Profile MIDI note must be an integer from ${RANGE_PROFILE_MIN_MIDI} through ${RANGE_PROFILE_MAX_MIDI}.`,
    );
  }
}

function normalizeMidiList(candidate: unknown): number[] {
  if (!Array.isArray(candidate)) return [];
  return [...new Set(candidate.filter(isProfileMidi))].sort((left, right) => left - right);
}

function normalizeRegisterShifts(candidate: unknown): RegisterShiftMarker[] {
  if (!Array.isArray(candidate)) return [];
  const byMidi = new Map<number, RegisterShiftMarker>();
  for (const raw of candidate) {
    if (!raw || typeof raw !== "object") continue;
    const marker = raw as Partial<RegisterShiftMarker>;
    if (!isProfileMidi(marker.midi)) continue;
    const existing = byMidi.get(marker.midi) ?? {
      midi: marker.midi,
      ascending: false,
      descending: false,
    };
    existing.ascending ||= marker.ascending === true;
    existing.descending ||= marker.descending === true;
    if (existing.ascending || existing.descending) byMidi.set(marker.midi, existing);
  }
  return [...byMidi.values()].sort((left, right) => left.midi - right.midi);
}

export function createDefaultRangeProfile(
  baselineMidi = DEFAULT_BASELINE_MIDI,
): PersonalRangeProfile {
  requireProfileMidi(baselineMidi);
  return {
    baseline: { midi: baselineMidi, source: "default", updatedAt: null },
    usableMidis: [],
    registerShifts: [],
  };
}

/** Normalize only the current schema; obsolete stored fields are ignored. */
export function normalizeRangeProfile(candidate: unknown): PersonalRangeProfile {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return createDefaultRangeProfile();
  }
  const source = candidate as Partial<PersonalRangeProfile>;
  const rawBaseline = source.baseline && typeof source.baseline === "object"
    ? source.baseline as Partial<ComfortableBaseline>
    : {};
  const baselineMidi = isProfileMidi(rawBaseline.midi)
    ? rawBaseline.midi
    : DEFAULT_BASELINE_MIDI;
  const baselineSource: BaselineSource = rawBaseline.source === "manual"
    || rawBaseline.source === "hum-anchor"
    ? rawBaseline.source
    : "default";
  const baselineUpdatedAt = typeof rawBaseline.updatedAt === "string"
    && Number.isFinite(Date.parse(rawBaseline.updatedAt))
    ? new Date(rawBaseline.updatedAt).toISOString()
    : null;
  return {
    baseline: {
      midi: baselineMidi,
      source: baselineSource,
      updatedAt: baselineUpdatedAt,
    },
    usableMidis: normalizeMidiList(source.usableMidis),
    registerShifts: normalizeRegisterShifts(source.registerShifts),
  };
}

export function setRangeProfileBaseline(
  profile: Readonly<PersonalRangeProfile>,
  baselineMidi: number,
  source: BaselineSource = "manual",
  updatedAt: string = new Date().toISOString(),
): PersonalRangeProfile {
  requireProfileMidi(baselineMidi);
  if (source !== "default" && source !== "manual" && source !== "hum-anchor") {
    throw new RangeError(`Unknown baseline source: ${String(source)}`);
  }
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new RangeError("Baseline timestamp must be a valid date.");
  }
  return {
    ...profile,
    baseline: {
      midi: baselineMidi,
      source,
      updatedAt: new Date(updatedAt).toISOString(),
    },
  };
}

export function toggleRegisterShift(
  profile: Readonly<PersonalRangeProfile>,
  midi: number,
  direction: ShiftDirection,
): PersonalRangeProfile {
  requireProfileMidi(midi);
  if (direction !== "ascending" && direction !== "descending") {
    throw new RangeError(`Unknown register-shift direction: ${String(direction)}`);
  }
  const normalizedShifts = normalizeRegisterShifts(profile.registerShifts);
  const existing = normalizedShifts.find((marker) => marker.midi === midi)
    ?? { midi, ascending: false, descending: false };
  const nextMarker = { ...existing, [direction]: !existing[direction] };
  const remaining = normalizedShifts.filter((marker) => marker.midi !== midi);
  const registerShifts = nextMarker.ascending || nextMarker.descending
    ? [...remaining, nextMarker].sort((left, right) => left.midi - right.midi)
    : remaining;
  return { ...profile, registerShifts };
}

export function rangeBoundsForMidis(midis: readonly number[]): RangeBounds {
  const valid = midis.filter(isProfileMidi);
  return valid.length === 0
    ? { lowMidi: null, highMidi: null }
    : { lowMidi: Math.min(...valid), highMidi: Math.max(...valid) };
}

export function usableRangeBounds(
  profile: Readonly<PersonalRangeProfile>,
): RangeBounds {
  return rangeBoundsForMidis(profile.usableMidis);
}
