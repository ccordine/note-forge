import { normalizePitchClass } from "@noteforge/music-core";

export type FamilyNoteSet = "natural" | "chromatic";
export type TargetOrder = "ascending" | "descending" | "shuffled";
export type SupportMode = "solo" | "unison" | "major-third" | "perfect-fifth" | "octave";
export type RangeFamilyId = "deep" | "low" | "middle" | "high";
export type RandomSource = () => number;

export interface RangeFamilyDefinition {
  id: RangeFamilyId;
  label: string;
  octave: 2 | 3 | 4 | 5;
  firstMidi: number;
  lastMidi: number;
  rangeLabel: string;
}

export const RANGE_FAMILIES = Object.freeze([
  Object.freeze({ id: "deep", label: "Deep", octave: 2, firstMidi: 36, lastMidi: 47, rangeLabel: "C2–B2" }),
  Object.freeze({ id: "low", label: "Low", octave: 3, firstMidi: 48, lastMidi: 59, rangeLabel: "C3–B3" }),
  Object.freeze({ id: "middle", label: "Middle", octave: 4, firstMidi: 60, lastMidi: 71, rangeLabel: "C4–B4" }),
  Object.freeze({ id: "high", label: "High", octave: 5, firstMidi: 72, lastMidi: 83, rangeLabel: "C5–B5" }),
] as const satisfies readonly RangeFamilyDefinition[]);

const NATURAL_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11]);

export function getRangeFamily(familyId: RangeFamilyId): RangeFamilyDefinition {
  const family = RANGE_FAMILIES.find((candidate) => candidate.id === familyId);
  if (!family) throw new RangeError(`Unknown range family: ${String(familyId)}`);
  return family;
}

/** Find the octave family containing a MIDI note, clamped to the curriculum edges. */
export function rangeFamilyForMidi(midi: number): RangeFamilyId {
  requireMidi(midi, "MIDI note");
  return RANGE_FAMILIES.find((family) => midi >= family.firstMidi && midi <= family.lastMidi)?.id
    ?? (midi < RANGE_FAMILIES[0].firstMidi ? RANGE_FAMILIES[0].id : RANGE_FAMILIES.at(-1)!.id);
}

export interface FamilyTargetSequenceOptions {
  familyId: RangeFamilyId;
  noteSet?: FamilyNoteSet;
  order?: TargetOrder;
  rng?: RandomSource;
}

export interface SupportPlan {
  mode: SupportMode;
  vocalTargetMidi: number;
  guideMidi: number | null;
  intervalSemitones: number | null;
}

export interface SustainFrame {
  timeSeconds: number;
  midiFloat: number | null;
  confidence: number;
  voiced: boolean;
}

export interface SustainTrackerOptions {
  targetMidi: number;
  requiredHoldSeconds: number;
  toleranceCents: number;
  listeningStartedAtSeconds: number;
  minimumConfidence?: number;
  graceSeconds?: number;
}

export type SustainTrackerStatus = "waiting" | "holding" | "complete";

/**
 * Immutable live state for one target. `heldSeconds` contains only intervals
 * bounded by two qualifying frames; detector dropouts inside the grace window
 * preserve the run but do not add time to it.
 */
export interface SustainTrackerState {
  targetMidi: number;
  requiredHoldSeconds: number;
  toleranceCents: number;
  listeningStartedAtSeconds: number;
  minimumConfidence: number;
  graceSeconds: number;
  status: SustainTrackerStatus;
  heldSeconds: number;
  progress: number;
  runStartedAtSeconds: number | null;
  lastProcessedTimeSeconds: number | null;
  lastInToleranceTimeSeconds: number | null;
  lastFrameInTolerance: boolean;
  inGrace: boolean;
}

export interface FamilyAdvance {
  previousFamilyId: RangeFamilyId;
  familyId: RangeFamilyId;
  wrapped: boolean;
}

export const DEFAULT_SUSTAIN_GRACE_SECONDS = 0.22;
export const DEFAULT_MINIMUM_CONFIDENCE = 0.5;
export const DEFAULT_RETAINED_FRAME_LIMIT = 600;

const SUPPORT_INTERVALS: Readonly<Record<Exclude<SupportMode, "solo">, number>> = {
  unison: 0,
  "major-third": 4,
  "perfect-fifth": 7,
  octave: 12,
};

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function requireMidi(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 127) {
    throw new RangeError(`${label} must be an integer MIDI note from 0 through 127.`);
  }
}

function requireKnownNoteSet(noteSet: FamilyNoteSet): void {
  if (noteSet !== "natural" && noteSet !== "chromatic") {
    throw new RangeError(`Unknown family note set: ${String(noteSet)}`);
  }
}

function requireKnownOrder(order: TargetOrder): void {
  if (order !== "ascending" && order !== "descending" && order !== "shuffled") {
    throw new RangeError(`Unknown target order: ${String(order)}`);
  }
}

function randomIndex(maximumInclusive: number, rng: RandomSource): number {
  const sample = rng();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("Random source must return a finite number from 0 (inclusive) to 1 (exclusive).");
  }
  return Math.floor(sample * (maximumInclusive + 1));
}

/** Return the ascending targets for one fixed C-through-B family. */
export function targetsForFamily(
  familyId: RangeFamilyId,
  noteSet: FamilyNoteSet = "natural",
): number[] {
  requireKnownNoteSet(noteSet);
  const family = getRangeFamily(familyId);
  const chromatic = Array.from(
    { length: family.lastMidi - family.firstMidi + 1 },
    (_, index) => family.firstMidi + index,
  );
  return noteSet === "natural"
    ? chromatic.filter((midi) => NATURAL_PITCH_CLASSES.has(normalizePitchClass(midi)))
    : chromatic;
}

/** Copy and order targets without mutating the caller's array. */
export function orderTargets(
  targets: readonly number[],
  order: TargetOrder,
  rng: RandomSource = Math.random,
): number[] {
  requireKnownOrder(order);
  if (order === "ascending") return [...targets].sort((left, right) => left - right);
  if (order === "descending") return [...targets].sort((left, right) => right - left);
  if (typeof rng !== "function") throw new TypeError("Random source must be a function.");

  const shuffled = [...targets];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index, rng);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

export function createFamilyTargetSequence(
  options: Readonly<FamilyTargetSequenceOptions>,
): number[] {
  const noteSet = options.noteSet ?? "natural";
  const order = options.order ?? "ascending";
  return orderTargets(targetsForFamily(options.familyId, noteSet), order, options.rng);
}

/** Resolve the audible guide for a unison match or a harmony interval below the vocal target. */
export function createSupportPlan(
  vocalTargetMidi: number,
  mode: SupportMode,
): SupportPlan {
  requireMidi(vocalTargetMidi, "Vocal target");
  if (mode === "solo") {
    return { mode, vocalTargetMidi, guideMidi: null, intervalSemitones: null };
  }
  if (!(mode in SUPPORT_INTERVALS)) {
    throw new RangeError(`Unknown support mode: ${String(mode)}`);
  }

  const intervalSemitones = SUPPORT_INTERVALS[mode as Exclude<SupportMode, "solo">];
  const guideMidi = vocalTargetMidi - intervalSemitones;
  requireMidi(guideMidi, "Guide");
  return { mode, vocalTargetMidi, guideMidi, intervalSemitones };
}

export function createSustainTracker(
  options: Readonly<SustainTrackerOptions>,
): SustainTrackerState {
  requireMidi(options.targetMidi, "Target");
  requireFinite(options.requiredHoldSeconds, "Required hold duration");
  if (options.requiredHoldSeconds <= 0) {
    throw new RangeError("Required hold duration must be greater than zero.");
  }
  requireFinite(options.toleranceCents, "Tolerance");
  if (options.toleranceCents <= 0) throw new RangeError("Tolerance must be greater than zero.");
  requireFinite(options.listeningStartedAtSeconds, "Listening start timestamp");

  const minimumConfidence = options.minimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE;
  requireFinite(minimumConfidence, "Minimum confidence");
  if (minimumConfidence < 0 || minimumConfidence > 1) {
    throw new RangeError("Minimum confidence must be from 0 through 1.");
  }

  const graceSeconds = options.graceSeconds ?? DEFAULT_SUSTAIN_GRACE_SECONDS;
  requireFinite(graceSeconds, "Grace duration");
  if (graceSeconds < 0) throw new RangeError("Grace duration cannot be negative.");

  return {
    targetMidi: options.targetMidi,
    requiredHoldSeconds: options.requiredHoldSeconds,
    toleranceCents: options.toleranceCents,
    listeningStartedAtSeconds: options.listeningStartedAtSeconds,
    minimumConfidence,
    graceSeconds,
    status: "waiting",
    heldSeconds: 0,
    progress: 0,
    runStartedAtSeconds: null,
    lastProcessedTimeSeconds: null,
    lastInToleranceTimeSeconds: null,
    lastFrameInTolerance: false,
    inGrace: false,
  };
}

function frameHasReliablePitch(state: Readonly<SustainTrackerState>, frame: Readonly<SustainFrame>): boolean {
  return frame.voiced
    && Number.isFinite(frame.confidence)
    && frame.confidence >= state.minimumConfidence
    && frame.midiFloat !== null
    && Number.isFinite(frame.midiFloat);
}

function frameIsInTolerance(state: Readonly<SustainTrackerState>, frame: Readonly<SustainFrame>): boolean {
  return frameHasReliablePitch(state, frame)
    && Math.abs((frame.midiFloat! - state.targetMidi) * 100) <= state.toleranceCents + 1e-9;
}

/** Advance one tracker with a newly captured frame. */
export function updateSustainTracker(
  state: Readonly<SustainTrackerState>,
  frame: Readonly<SustainFrame>,
): SustainTrackerState {
  if (state.status === "complete") return state as SustainTrackerState;
  const timestamp = frame.timeSeconds;
  if (!Number.isFinite(timestamp) || timestamp < state.listeningStartedAtSeconds) {
    return state as SustainTrackerState;
  }
  if (state.lastProcessedTimeSeconds !== null && timestamp <= state.lastProcessedTimeSeconds) {
    return state as SustainTrackerState;
  }

  const inTolerance = frameIsInTolerance(state, frame);
  if (!inTolerance) {
    // Grace is only for detector uncertainty. A clear, confidently measured
    // wrong pitch breaks a continuous in-tune hold immediately.
    const detectorDropout = !frameHasReliablePitch(state, frame);
    const insideGrace = detectorDropout
      && state.status === "holding"
      && state.lastInToleranceTimeSeconds !== null
      && timestamp - state.lastInToleranceTimeSeconds <= state.graceSeconds + 1e-12;
    if (insideGrace) {
      return {
        ...state,
        lastProcessedTimeSeconds: timestamp,
        lastFrameInTolerance: false,
        inGrace: true,
      };
    }
    return {
      ...state,
      status: "waiting",
      heldSeconds: 0,
      progress: 0,
      runStartedAtSeconds: null,
      lastProcessedTimeSeconds: timestamp,
      lastInToleranceTimeSeconds: null,
      lastFrameInTolerance: false,
      inGrace: false,
    };
  }

  const continuesRun = state.status === "holding"
    && state.lastInToleranceTimeSeconds !== null
    && timestamp - state.lastInToleranceTimeSeconds <= state.graceSeconds + 1e-12;
  if (!continuesRun) {
    return {
      ...state,
      status: "holding",
      heldSeconds: 0,
      progress: 0,
      runStartedAtSeconds: timestamp,
      lastProcessedTimeSeconds: timestamp,
      lastInToleranceTimeSeconds: timestamp,
      lastFrameInTolerance: true,
      inGrace: false,
    };
  }

  const addedSeconds = state.lastFrameInTolerance && state.lastProcessedTimeSeconds !== null
    ? timestamp - state.lastProcessedTimeSeconds
    : 0;
  const heldSeconds = Math.min(state.requiredHoldSeconds, state.heldSeconds + addedSeconds);
  const complete = heldSeconds + 1e-12 >= state.requiredHoldSeconds;
  return {
    ...state,
    status: complete ? "complete" : "holding",
    heldSeconds,
    progress: complete ? 1 : heldSeconds / state.requiredHoldSeconds,
    lastProcessedTimeSeconds: timestamp,
    lastInToleranceTimeSeconds: timestamp,
    lastFrameInTolerance: true,
    inGrace: false,
  };
}

/** Retain the newest frame without allowing an indefinite attempt to grow forever. */
export function appendBoundedFrame<T>(
  frames: readonly T[],
  frame: T,
  maximumFrames: number = DEFAULT_RETAINED_FRAME_LIMIT,
): T[] {
  if (!Number.isInteger(maximumFrames) || maximumFrames < 1) {
    throw new RangeError("Maximum retained frames must be a positive integer.");
  }
  return [...frames.slice(-(maximumFrames - 1)), frame].slice(-maximumFrames);
}

/** Advance deep → low → middle → high → deep and report the cycle boundary. */
export function advanceFamily(currentFamilyId: RangeFamilyId): FamilyAdvance {
  const currentIndex = RANGE_FAMILIES.findIndex((family) => family.id === currentFamilyId);
  if (currentIndex < 0) throw new RangeError(`Unknown note family: ${String(currentFamilyId)}`);
  const nextIndex = (currentIndex + 1) % RANGE_FAMILIES.length;
  return {
    previousFamilyId: currentFamilyId,
    familyId: RANGE_FAMILIES[nextIndex]!.id,
    wrapped: nextIndex === 0,
  };
}
