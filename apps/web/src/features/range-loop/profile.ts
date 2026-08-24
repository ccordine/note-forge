import { type SupportMode } from "./model";

export const DEFAULT_BASELINE_MIDI = 48;
export const VOCAL_PROFILE_STORAGE_KEY = "hum.vocal-profile";
export const RANGE_PROFILE_MIN_MIDI = 36;
export const RANGE_PROFILE_MAX_MIDI = 83;
export const MINIMUM_EDGE_OBSERVATIONS = 3;
/** Retained history for one note under one support/tolerance/hold condition. */
export const MAXIMUM_OBSERVATIONS_PER_NOTE = 12;

export type ProfileObservationKind = "clean" | "accuracy";
export type ShiftDirection = "ascending" | "descending";
export type BaselineSource = "default" | "manual" | "hum-anchor";

export interface ComfortableBaseline {
  midi: number;
  source: BaselineSource;
  updatedAt: string | null;
}

export interface RangeEvidenceObservation {
  supportMode: SupportMode;
  toleranceCents: number;
  requiredHoldMs: number;
  resetCount: number;
  timeToAcquireMs: number;
  absoluteCenterErrorCents?: number;
  stabilityCents?: number;
  observedAt: string;
}

export interface RegisterShiftMarker {
  midi: number;
  ascending: boolean;
  descending: boolean;
}

export interface PersonalRangeProfile {
  baseline: ComfortableBaseline;
  cleanStableMidis: number[];
  accuracyChallengeMidis: number[];
  registerShifts: RegisterShiftMarker[];
  evidenceByMidi: Record<string, RangeEvidenceObservation[]>;
}

export interface RangeBounds {
  lowMidi: number | null;
  highMidi: number | null;
}

export interface AccuracyEdges {
  lowMidi: number | null;
  highMidi: number | null;
}

export interface EvidenceSummary {
  observationCount: number;
  averageResets: number;
  averageAcquireMs: number;
  centerErrorSampleCount: number;
  averageAbsoluteCenterErrorCents: number | null;
  stabilitySampleCount: number;
  averageStabilityCents: number | null;
}

export interface RangeEvidenceInput {
  midi: number;
  supportMode: SupportMode;
  toleranceCents: number;
  requiredHoldMs: number;
  resetCount: number;
  timeToAcquireMs: number;
  medianErrorCents?: number;
  stabilityCents?: number;
  observedAt?: string;
}

const SUPPORT_MODES = new Set<SupportMode>(["solo", "unison", "major-third", "perfect-fifth", "octave"]);
const EVIDENCE_TOLERANCE_MATCH_CENTS = 0.5;

function isProfileMidi(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= RANGE_PROFILE_MIN_MIDI
    && (value as number) <= RANGE_PROFILE_MAX_MIDI;
}

function requireProfileMidi(value: number): void {
  if (!isProfileMidi(value)) {
    throw new RangeError(`Profile MIDI note must be an integer from ${RANGE_PROFILE_MIN_MIDI} through ${RANGE_PROFILE_MAX_MIDI}.`);
  }
}

function requireFiniteNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and nonnegative.`);
}

function isSupportMode(value: unknown): value is SupportMode {
  return typeof value === "string" && SUPPORT_MODES.has(value as SupportMode);
}

function isEvidenceTolerance(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
}

function requireEvidenceCondition(supportMode: SupportMode, toleranceCents: number): void {
  if (!isSupportMode(supportMode)) throw new RangeError(`Unknown support mode: ${String(supportMode)}`);
  if (!isEvidenceTolerance(toleranceCents)) {
    throw new RangeError("Tolerance must be greater than zero and no more than 100 cents.");
  }
}

function requireHoldDuration(requiredHoldMs: number): void {
  if (!Number.isFinite(requiredHoldMs) || requiredHoldMs <= 0) {
    throw new RangeError("Required hold duration must be finite and greater than zero.");
  }
}

function observationMatchesCondition(
  observation: Readonly<RangeEvidenceObservation>,
  supportMode: SupportMode,
  toleranceCents: number,
  requiredHoldMs: number,
): boolean {
  return observation.supportMode === supportMode
    && Math.abs(observation.toleranceCents - toleranceCents) < EVIDENCE_TOLERANCE_MATCH_CENTS
    && Math.abs(observation.requiredHoldMs - requiredHoldMs) < 1;
}

function normalizeMidiList(candidate: unknown): number[] {
  if (!Array.isArray(candidate)) return [];
  return [...new Set(candidate.filter(isProfileMidi))].sort((left, right) => left - right);
}

function normalizeObservation(candidate: unknown): RangeEvidenceObservation | null {
  if (!candidate || typeof candidate !== "object") return null;
  const source = candidate as Partial<RangeEvidenceObservation>;
  if (!isSupportMode(source.supportMode)) return null;
  if (!isEvidenceTolerance(source.toleranceCents)) return null;
  if (typeof source.resetCount !== "number" || !Number.isInteger(source.resetCount) || source.resetCount < 0) return null;
  if (typeof source.timeToAcquireMs !== "number" || !Number.isFinite(source.timeToAcquireMs) || source.timeToAcquireMs < 0) return null;
  if (typeof source.observedAt !== "string" || !Number.isFinite(Date.parse(source.observedAt))) return null;
  const absoluteCenterErrorCents = typeof source.absoluteCenterErrorCents === "number" && Number.isFinite(source.absoluteCenterErrorCents) && source.absoluteCenterErrorCents >= 0
    ? source.absoluteCenterErrorCents
    : undefined;
  const stabilityCents = typeof source.stabilityCents === "number" && Number.isFinite(source.stabilityCents) && source.stabilityCents >= 0
    ? source.stabilityCents
    : undefined;
  if (typeof source.requiredHoldMs !== "number" || !Number.isFinite(source.requiredHoldMs) || source.requiredHoldMs <= 0) return null;
  return {
    supportMode: source.supportMode,
    toleranceCents: source.toleranceCents,
    requiredHoldMs: source.requiredHoldMs,
    resetCount: source.resetCount,
    timeToAcquireMs: source.timeToAcquireMs,
    absoluteCenterErrorCents,
    stabilityCents,
    observedAt: new Date(source.observedAt).toISOString(),
  };
}

function observationConditionKey(observation: Readonly<RangeEvidenceObservation>): string {
  return `${observation.supportMode}|${observation.toleranceCents}|${observation.requiredHoldMs}`;
}

function retainRecentObservations(observations: readonly RangeEvidenceObservation[]): RangeEvidenceObservation[] {
  const byCondition = new Map<string, RangeEvidenceObservation[]>();
  for (const observation of observations) {
    const key = observationConditionKey(observation);
    byCondition.set(key, [...(byCondition.get(key) ?? []), observation]);
  }
  return [...byCondition.values()]
    .flatMap((conditionObservations) => conditionObservations
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
      .slice(-MAXIMUM_OBSERVATIONS_PER_NOTE))
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
}

function normalizeRegisterShifts(candidate: unknown): RegisterShiftMarker[] {
  if (!Array.isArray(candidate)) return [];
  const byMidi = new Map<number, RegisterShiftMarker>();
  for (const raw of candidate) {
    if (!raw || typeof raw !== "object") continue;
    const marker = raw as Partial<RegisterShiftMarker>;
    if (!isProfileMidi(marker.midi)) continue;
    const existing = byMidi.get(marker.midi) ?? { midi: marker.midi, ascending: false, descending: false };
    existing.ascending ||= marker.ascending === true;
    existing.descending ||= marker.descending === true;
    if (existing.ascending || existing.descending) byMidi.set(marker.midi, existing);
  }
  return [...byMidi.values()].sort((left, right) => left.midi - right.midi);
}

export function createDefaultRangeProfile(baselineMidi = DEFAULT_BASELINE_MIDI): PersonalRangeProfile {
  requireProfileMidi(baselineMidi);
  return {
    baseline: { midi: baselineMidi, source: "default", updatedAt: null },
    cleanStableMidis: [],
    accuracyChallengeMidis: [],
    registerShifts: [],
    evidenceByMidi: {},
  };
}

export function normalizeRangeProfile(candidate: unknown): PersonalRangeProfile {
  if (!candidate || typeof candidate !== "object") return createDefaultRangeProfile();
  const source = candidate as Partial<PersonalRangeProfile>;
  const rawBaseline = source.baseline && typeof source.baseline === "object"
    ? source.baseline as Partial<ComfortableBaseline>
    : {};
  const baselineMidi = isProfileMidi(rawBaseline.midi) ? rawBaseline.midi : DEFAULT_BASELINE_MIDI;
  const baselineSource: BaselineSource = rawBaseline.source === "manual" || rawBaseline.source === "hum-anchor"
    ? rawBaseline.source
    : "default";
  const baselineUpdatedAt = typeof rawBaseline.updatedAt === "string" && Number.isFinite(Date.parse(rawBaseline.updatedAt))
    ? new Date(rawBaseline.updatedAt).toISOString()
    : null;
  const evidenceByMidi: Record<string, RangeEvidenceObservation[]> = {};
  const observationsByMidi = new Map<number, RangeEvidenceObservation[]>();
  if (source.evidenceByMidi && typeof source.evidenceByMidi === "object" && !Array.isArray(source.evidenceByMidi)) {
    for (const [key, rawObservations] of Object.entries(source.evidenceByMidi)) {
      const midi = Number(key);
      if (key !== String(midi) || !isProfileMidi(midi) || !Array.isArray(rawObservations)) continue;
      const observations = rawObservations
        .map(normalizeObservation)
        .filter((observation): observation is RangeEvidenceObservation => observation !== null);
      if (observations.length > 0) {
        observationsByMidi.set(midi, [...(observationsByMidi.get(midi) ?? []), ...observations]);
      }
    }
    for (const [midi, rawObservations] of observationsByMidi) {
      const observations = retainRecentObservations(rawObservations);
      if (observations.length > 0) evidenceByMidi[String(midi)] = observations;
    }
  }
  return {
    baseline: { midi: baselineMidi, source: baselineSource, updatedAt: baselineUpdatedAt },
    cleanStableMidis: normalizeMidiList(source.cleanStableMidis),
    accuracyChallengeMidis: normalizeMidiList(source.accuracyChallengeMidis),
    registerShifts: normalizeRegisterShifts(source.registerShifts),
    evidenceByMidi,
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
  if (!Number.isFinite(Date.parse(updatedAt))) throw new RangeError("Baseline timestamp must be a valid date.");
  return { ...profile, baseline: { midi: baselineMidi, source, updatedAt: new Date(updatedAt).toISOString() } };
}

export function recordRangeEvidence(
  profile: Readonly<PersonalRangeProfile>,
  input: Readonly<RangeEvidenceInput>,
): PersonalRangeProfile {
  requireProfileMidi(input.midi);
  requireEvidenceCondition(input.supportMode, input.toleranceCents);
  requireHoldDuration(input.requiredHoldMs);
  if (!Number.isInteger(input.resetCount)) throw new RangeError("Reset count must be an integer.");
  requireFiniteNonnegative(input.resetCount, "Reset count");
  requireFiniteNonnegative(input.timeToAcquireMs, "Acquisition time");
  if (input.medianErrorCents !== undefined && !Number.isFinite(input.medianErrorCents)) throw new RangeError("Median pitch error must be finite.");
  if (input.stabilityCents !== undefined) requireFiniteNonnegative(input.stabilityCents, "Stability");
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) throw new RangeError("Observation timestamp must be a valid date.");
  const observation: RangeEvidenceObservation = {
    supportMode: input.supportMode,
    toleranceCents: input.toleranceCents,
    requiredHoldMs: input.requiredHoldMs,
    resetCount: input.resetCount,
    timeToAcquireMs: input.timeToAcquireMs,
    absoluteCenterErrorCents: input.medianErrorCents === undefined ? undefined : Math.abs(input.medianErrorCents),
    stabilityCents: input.stabilityCents,
    observedAt: new Date(observedAt).toISOString(),
  };
  const key = String(input.midi);
  const rawExisting = profile.evidenceByMidi?.[key];
  const existing = Array.isArray(rawExisting)
    ? rawExisting.map(normalizeObservation).filter((item): item is RangeEvidenceObservation => item !== null)
    : [];
  const observations = retainRecentObservations([...existing, observation]);
  return {
    ...profile,
    evidenceByMidi: { ...profile.evidenceByMidi, [key]: observations },
  };
}

export function toggleProfileObservation(
  profile: Readonly<PersonalRangeProfile>,
  kind: ProfileObservationKind,
  midi: number,
): PersonalRangeProfile {
  requireProfileMidi(midi);
  if (kind !== "clean" && kind !== "accuracy") {
    throw new RangeError(`Unknown profile observation kind: ${String(kind)}`);
  }
  const key = kind === "clean" ? "cleanStableMidis" : "accuracyChallengeMidis";
  const current = normalizeMidiList(profile[key]);
  const next = current.includes(midi)
    ? current.filter((candidate) => candidate !== midi)
    : [...current, midi].sort((left, right) => left - right);
  return { ...profile, [key]: next };
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

export function pitchStableBounds(profile: Readonly<PersonalRangeProfile>): RangeBounds {
  const evidenceByMidi = profile.evidenceByMidi && typeof profile.evidenceByMidi === "object"
    ? profile.evidenceByMidi
    : {};
  const evidencedMidis = Object.entries(evidenceByMidi).flatMap(([key, rawObservations]) => {
    if (!Array.isArray(rawObservations) || !rawObservations.some((observation) => normalizeObservation(observation) !== null)) return [];
    return [Number(key)];
  });
  return rangeBoundsForMidis(evidencedMidis);
}

export function cleanStableBounds(profile: Readonly<PersonalRangeProfile>): RangeBounds {
  return rangeBoundsForMidis(profile.cleanStableMidis);
}

export function manualAccuracyEdges(profile: Readonly<PersonalRangeProfile>): AccuracyEdges {
  const below = profile.accuracyChallengeMidis.filter((midi) => midi < profile.baseline.midi);
  const above = profile.accuracyChallengeMidis.filter((midi) => midi > profile.baseline.midi);
  return {
    lowMidi: below.length === 0 ? null : Math.max(...below),
    highMidi: above.length === 0 ? null : Math.min(...above),
  };
}

export function summarizeRangeEvidence(
  profile: Readonly<PersonalRangeProfile>,
  midi: number,
  supportMode: SupportMode,
  toleranceCents: number,
  requiredHoldMs: number,
): EvidenceSummary | null {
  requireProfileMidi(midi);
  requireEvidenceCondition(supportMode, toleranceCents);
  requireHoldDuration(requiredHoldMs);
  const rawObservations = profile.evidenceByMidi?.[String(midi)];
  const observations = (Array.isArray(rawObservations) ? rawObservations : [])
    .map(normalizeObservation)
    .filter((observation): observation is RangeEvidenceObservation => observation !== null)
    .filter((observation) => observationMatchesCondition(observation, supportMode, toleranceCents, requiredHoldMs));
  if (observations.length === 0) return null;
  const centerSamples = observations.flatMap((observation) => observation.absoluteCenterErrorCents === undefined ? [] : [observation.absoluteCenterErrorCents]);
  const stabilitySamples = observations.flatMap((observation) => observation.stabilityCents === undefined ? [] : [observation.stabilityCents]);
  return {
    observationCount: observations.length,
    averageResets: observations.reduce((total, observation) => total + observation.resetCount, 0) / observations.length,
    averageAcquireMs: observations.reduce((total, observation) => total + observation.timeToAcquireMs, 0) / observations.length,
    centerErrorSampleCount: centerSamples.length,
    averageAbsoluteCenterErrorCents: centerSamples.length === 0 ? null : centerSamples.reduce((total, value) => total + value, 0) / centerSamples.length,
    stabilitySampleCount: stabilitySamples.length,
    averageStabilityCents: stabilitySamples.length === 0 ? null : stabilitySamples.reduce((total, value) => total + value, 0) / stabilitySamples.length,
  };
}

function hasEmergingFriction(candidate: EvidenceSummary, baseline: EvidenceSummary): boolean {
  if (candidate.observationCount < MINIMUM_EDGE_OBSERVATIONS || baseline.observationCount < MINIMUM_EDGE_OBSERVATIONS) return false;
  const resetDelta = candidate.averageResets - baseline.averageResets;
  const acquisitionDelta = candidate.averageAcquireMs - baseline.averageAcquireMs;
  const centerDelta = candidate.centerErrorSampleCount >= MINIMUM_EDGE_OBSERVATIONS
    && baseline.centerErrorSampleCount >= MINIMUM_EDGE_OBSERVATIONS
    && candidate.averageAbsoluteCenterErrorCents !== null
    && baseline.averageAbsoluteCenterErrorCents !== null
    ? candidate.averageAbsoluteCenterErrorCents - baseline.averageAbsoluteCenterErrorCents
    : 0;
  const stabilityDelta = candidate.stabilitySampleCount >= MINIMUM_EDGE_OBSERVATIONS
    && baseline.stabilitySampleCount >= MINIMUM_EDGE_OBSERVATIONS
    && candidate.averageStabilityCents !== null
    && baseline.averageStabilityCents !== null
    ? candidate.averageStabilityCents - baseline.averageStabilityCents
    : 0;
  const hasStrongSignal = resetDelta >= 2
    || acquisitionDelta >= 2_500
    || centerDelta >= 10
    || stabilityDelta >= 10;
  const moderateSignalCount = [
    resetDelta >= 1,
    acquisitionDelta >= 1_500,
    centerDelta >= 6,
    stabilityDelta >= 6,
  ].filter(Boolean).length;
  return hasStrongSignal || moderateSignalCount >= 2;
}

/** Suggest the first repeated friction point moving outward from the baseline. */
export function suggestedAccuracyEdges(
  profile: Readonly<PersonalRangeProfile>,
  supportMode: SupportMode,
  toleranceCents: number,
  requiredHoldMs: number,
): AccuracyEdges {
  const baseline = summarizeRangeEvidence(profile, profile.baseline.midi, supportMode, toleranceCents, requiredHoldMs);
  if (!baseline || baseline.observationCount < MINIMUM_EDGE_OBSERVATIONS) return { lowMidi: null, highMidi: null };
  let lowMidi: number | null = null;
  let highMidi: number | null = null;
  for (let midi = profile.baseline.midi - 1; midi >= RANGE_PROFILE_MIN_MIDI; midi -= 1) {
    const candidate = summarizeRangeEvidence(profile, midi, supportMode, toleranceCents, requiredHoldMs);
    if (candidate && hasEmergingFriction(candidate, baseline)) {
      lowMidi = midi;
      break;
    }
  }
  for (let midi = profile.baseline.midi + 1; midi <= RANGE_PROFILE_MAX_MIDI; midi += 1) {
    const candidate = summarizeRangeEvidence(profile, midi, supportMode, toleranceCents, requiredHoldMs);
    if (candidate && hasEmergingFriction(candidate, baseline)) {
      highMidi = midi;
      break;
    }
  }
  return { lowMidi, highMidi };
}
