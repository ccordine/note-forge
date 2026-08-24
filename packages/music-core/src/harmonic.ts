import { CHORD_QUALITIES, type Chord, type ChordQuality } from './chord';
import { getIntervalMetadata, harmonicIntervalName, type IntervalMetadata } from './interval';
import { midiToNote, noteName, parseNote, type AccidentalPreference } from './note';
import { frequencyToMidi, normalizePitchClass, splitMidiPitch } from './pitch';
import { CHROMATIC_SCALE_DEGREES, type Scale } from './scale';

export interface HarmonicContext {
  tonicPitchClass: number;
  scalePitchClasses: readonly number[];
  chordPitchClasses: readonly number[];
  chordRoot: number;
  chordQuality: ChordQuality | string;
  scaleName?: string;
  chordName?: string;
}

export type HarmonicPitchInput =
  | number
  | string
  | { midi: number }
  | { frequencyHz: number }
  | { pitchClass: number; centsOffset?: number };

export interface AnalyzedPitch {
  midi: number | null;
  nearestMidi: number | null;
  /** Continuous pitch-class coordinate in [0, 12). */
  continuousPitchClass: number;
  pitchClass: number;
  pitchClassName: string;
  centsFromNearest: number;
  label: string;
}

export interface HarmonicInterval extends IntervalMetadata {
  harmonicName: string;
  deviationCents: number;
}

export interface HarmonicChordMembership {
  member: boolean;
  role: string | null;
  description: string;
}

export interface HarmonicScaleMembership {
  member: boolean;
  degreeLabel: string;
  degreeIndex: number | null;
  description: string;
}

export type TensionCategory =
  | 'chord-tone'
  | 'inflected-chord-tone'
  | 'diatonic-tension'
  | 'chromatic-tension';

export interface TensionAnalysis {
  category: TensionCategory;
  label: string;
  microtonallyInflected: boolean;
  description: string;
}

export interface ResolutionSuggestion {
  pitchClass: number;
  noteName: string;
  chordRole: string;
  direction: 'up' | 'down' | 'hold';
  motionSemitones: number;
  motionCents: number;
  description: string;
}

export interface HarmonicRelationship {
  pitch: AnalyzedPitch;
  rootPitchClass: number;
  rootName: string;
  tonicPitchClass: number;
  tonicName: string;
  interval: HarmonicInterval;
  /** Continuous upward pitch-class distance from the chord root. */
  semitoneDistance: number;
  /** Continuous distance from the chord root; never snapped before reporting. */
  centDistance: number;
  chordMembership: HarmonicChordMembership;
  scaleMembership: HarmonicScaleMembership;
  tension: TensionAnalysis;
  possibleResolutions: readonly ResolutionSuggestion[];
  /** A concise, non-prescriptive relationship statement for the UI. */
  summary: string;
}

export interface AnalyzeHarmonicOptions {
  accidentalPreference?: AccidentalPreference;
  maxResolutions?: number;
}

interface NormalizedPitch {
  midi: number | null;
  nearestMidi: number | null;
  continuousPitchClass: number;
  pitchClass: number;
  centsFromNearest: number;
}

const MICROTONAL_EPSILON_CENTS = 1e-6;

function requireInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
}

function normalizePitchClassAndCents(pitchClass: number, centsOffset: number): NormalizedPitch {
  requireInteger(pitchClass, 'pitchClass');
  if (!Number.isFinite(centsOffset)) {
    throw new RangeError('centsOffset must be a finite number');
  }
  const continuous = pitchClass + centsOffset / 100;
  const nearestChromatic = Math.floor(continuous + 0.5);
  return {
    midi: null,
    nearestMidi: null,
    continuousPitchClass: normalizePitchClass(continuous),
    pitchClass: normalizePitchClass(nearestChromatic),
    centsFromNearest: (continuous - nearestChromatic) * 100,
  };
}

function fromMidi(midi: number): NormalizedPitch {
  const split = splitMidiPitch(midi);
  return {
    midi,
    nearestMidi: split.nearestMidi,
    continuousPitchClass: normalizePitchClass(midi),
    pitchClass: split.pitchClass,
    centsFromNearest: split.centsFromNearest,
  };
}

function normalizePitchInput(input: HarmonicPitchInput): NormalizedPitch {
  if (typeof input === 'number') {
    return fromMidi(input);
  }
  if (typeof input === 'string') {
    const parsed = parseNote(input);
    return parsed.midi === null
      ? normalizePitchClassAndCents(parsed.pitchClass, parsed.centsOffset)
      : fromMidi(parsed.midi);
  }
  if ('midi' in input) {
    return fromMidi(input.midi);
  }
  if ('frequencyHz' in input) {
    return fromMidi(frequencyToMidi(input.frequencyHz));
  }
  return normalizePitchClassAndCents(input.pitchClass, input.centsOffset ?? 0);
}

function validateContext(context: HarmonicContext): void {
  requireInteger(context.tonicPitchClass, 'context.tonicPitchClass');
  requireInteger(context.chordRoot, 'context.chordRoot');
  if (!context.scalePitchClasses.every(Number.isSafeInteger)) {
    throw new RangeError('context.scalePitchClasses must contain only safe integers');
  }
  if (!context.chordPitchClasses.every(Number.isSafeInteger)) {
    throw new RangeError('context.chordPitchClasses must contain only safe integers');
  }
  if (context.scalePitchClasses.length === 0) {
    throw new RangeError('context.scalePitchClasses cannot be empty');
  }
  if (context.chordPitchClasses.length === 0) {
    throw new RangeError('context.chordPitchClasses cannot be empty');
  }
  const tonic = normalizePitchClass(context.tonicPitchClass);
  const root = normalizePitchClass(context.chordRoot);
  if (!context.scalePitchClasses.map(normalizePitchClass).includes(tonic)) {
    throw new RangeError('context.scalePitchClasses must contain the tonic');
  }
  if (!context.chordPitchClasses.map(normalizePitchClass).includes(root)) {
    throw new RangeError('context.chordPitchClasses must contain the chord root');
  }
}

function normalizedSet(values: readonly number[]): Set<number> {
  return new Set(values.map(normalizePitchClass));
}

function roleForInterval(interval: number, quality: ChordQuality | string): string {
  const definition = CHORD_QUALITIES[quality as ChordQuality];
  if (definition) {
    const toneIndex = definition.intervals.indexOf(interval);
    if (toneIndex >= 0) return definition.roles[toneIndex];
  }
  return harmonicIntervalName(interval);
}

function signedShortestDistance(from: number, to: number): number {
  const upward = normalizePitchClass(to - from);
  const downward = upward - 12;
  // When the tritone is exactly tied, prefer upward motion for determinism.
  return Math.abs(upward) <= Math.abs(downward) ? upward : downward;
}

function centsLabel(cents: number): string {
  const rounded = Number(cents.toFixed(1));
  if (rounded === 0) return '';
  return `${rounded > 0 ? '+' : ''}${rounded}¢`;
}

function buildResolutionSuggestions(
  pitch: NormalizedPitch,
  chordPitchClasses: readonly number[],
  chordRoot: number,
  chordQuality: ChordQuality | string,
  accidentalPreference: AccidentalPreference,
  maxResolutions: number,
  centeredChordTone: boolean,
): ResolutionSuggestion[] {
  if (centeredChordTone || maxResolutions === 0) return [];

  const continuousPitchClass = pitch.pitchClass + pitch.centsFromNearest / 100;
  const uniqueChordTones = [...normalizedSet(chordPitchClasses)];
  const suggestions = uniqueChordTones.map((destination): ResolutionSuggestion => {
    const motionSemitones = signedShortestDistance(continuousPitchClass, destination);
    const intervalFromRoot = normalizePitchClass(destination - chordRoot);
    const chordRole = roleForInterval(intervalFromRoot, chordQuality);
    const direction = motionSemitones > MICROTONAL_EPSILON_CENTS / 100
      ? 'up'
      : motionSemitones < -MICROTONAL_EPSILON_CENTS / 100
        ? 'down'
        : 'hold';
    const motionCents = motionSemitones * 100;
    const destinationName = noteName(destination, accidentalPreference);
    const movement = direction === 'hold'
      ? 'settle on'
      : `move ${direction} ${Math.abs(Number(motionCents.toFixed(1)))} cents to`;
    return {
      pitchClass: destination,
      noteName: destinationName,
      chordRole,
      direction,
      motionSemitones,
      motionCents,
      description: `${movement} ${destinationName}, the ${chordRole}`,
    };
  });

  return suggestions
    .sort((a, b) => Math.abs(a.motionCents) - Math.abs(b.motionCents) || a.pitchClass - b.pitchClass)
    .slice(0, maxResolutions);
}

/** Convert built Scale and Chord objects into the light-weight shared context shape. */
export function createHarmonicContext(scale: Scale, chord: Chord): HarmonicContext {
  return {
    tonicPitchClass: scale.tonicPitchClass,
    scalePitchClasses: [...scale.pitchClasses],
    chordPitchClasses: [...chord.pitchClasses],
    chordRoot: chord.rootPitchClass,
    chordQuality: chord.quality,
    scaleName: scale.name,
    chordName: chord.name,
  };
}

/**
 * Describe a pitch inside a scale/chord context. Membership is based on the
 * nearest 12-TET pitch class, while the original cents displacement remains
 * explicit in the distance, tension, and resolution fields.
 */
export function analyzeHarmonicRelationship(
  input: HarmonicPitchInput,
  context: HarmonicContext,
  options: AnalyzeHarmonicOptions = {},
): HarmonicRelationship {
  validateContext(context);
  const accidentalPreference = options.accidentalPreference ?? 'sharp';
  const maxResolutions = options.maxResolutions ?? 2;
  if (!Number.isInteger(maxResolutions) || maxResolutions < 0) {
    throw new RangeError('maxResolutions must be a non-negative integer');
  }

  const pitch = normalizePitchInput(input);
  const chordRoot = normalizePitchClass(context.chordRoot);
  const tonicPitchClass = normalizePitchClass(context.tonicPitchClass);
  const chordPitchClasses = [...normalizedSet(context.chordPitchClasses)];
  const scalePitchClasses = [...normalizedSet(context.scalePitchClasses)];
  const chordSet = new Set(chordPitchClasses);
  const scaleSet = new Set(scalePitchClasses);
  const intervalSemitones = normalizePitchClass(pitch.pitchClass - chordRoot);
  const semitoneDistance = normalizePitchClass(pitch.continuousPitchClass - chordRoot);
  const centDistance = semitoneDistance * 100;
  const intervalMetadata = getIntervalMetadata(intervalSemitones);
  const harmonicName = harmonicIntervalName(intervalSemitones);
  const inChord = chordSet.has(pitch.pitchClass);
  const inScale = scaleSet.has(pitch.pitchClass);
  const chordRole = inChord ? roleForInterval(intervalSemitones, context.chordQuality) : null;
  const scaleDegreeDistance = normalizePitchClass(pitch.pitchClass - tonicPitchClass);
  const degreeLabel = CHROMATIC_SCALE_DEGREES[scaleDegreeDistance];
  const degreeIndexRaw = scalePitchClasses.indexOf(pitch.pitchClass);
  const degreeIndex = degreeIndexRaw < 0 ? null : degreeIndexRaw + 1;
  const microtonallyInflected = Math.abs(pitch.centsFromNearest) > MICROTONAL_EPSILON_CENTS;
  const centeredChordTone = inChord && !microtonallyInflected;

  let category: TensionCategory;
  let tensionLabel: string;
  let tensionDescription: string;
  if (centeredChordTone) {
    category = 'chord-tone';
    tensionLabel = 'chord tone';
    tensionDescription = `${chordRole} in the current chord; locally settled while the harmony remains here.`;
  } else if (inChord) {
    category = 'inflected-chord-tone';
    tensionLabel = 'microtonally inflected chord tone';
    const direction = pitch.centsFromNearest > 0 ? 'sharp' : 'flat';
    tensionDescription = `${Math.abs(Number(pitch.centsFromNearest.toFixed(1)))} cents ${direction} of the ${chordRole}; an intentional inflection can color or lead away from that chord tone.`;
  } else if (inScale) {
    category = 'diatonic-tension';
    tensionLabel = 'diatonic tension';
    tensionDescription = `${harmonicName}, outside the current chord but inside the active scale${microtonallyInflected ? ` with a ${centsLabel(pitch.centsFromNearest)} inflection` : ''}.`;
  } else {
    category = 'chromatic-tension';
    tensionLabel = 'chromatic tension';
    tensionDescription = `${harmonicName}, outside both the current chord and active scale${microtonallyInflected ? ` with a ${centsLabel(pitch.centsFromNearest)} inflection` : ''}; its effect depends on direction, duration, voicing, and resolution.`;
  }

  const pitchClassName = noteName(pitch.pitchClass, accidentalPreference);
  const pitchLabel = pitch.midi === null
    ? `${pitchClassName}${centsLabel(pitch.centsFromNearest)}`
    : midiToNote(pitch.midi, { accidentalPreference, centsPrecision: 1 });
  const rootName = noteName(chordRoot, accidentalPreference);
  const tonicName = noteName(tonicPitchClass, accidentalPreference);
  const chordContextName = context.chordName ?? `${rootName} ${String(context.chordQuality).replaceAll('-', ' ')}`;
  const membershipPhrase = inChord ? `chord tone (${chordRole})` : 'non-chord tone';

  return {
    pitch: {
      midi: pitch.midi,
      nearestMidi: pitch.nearestMidi,
      continuousPitchClass: pitch.continuousPitchClass,
      pitchClass: pitch.pitchClass,
      pitchClassName,
      centsFromNearest: pitch.centsFromNearest,
      label: pitchLabel,
    },
    rootPitchClass: chordRoot,
    rootName,
    tonicPitchClass,
    tonicName,
    interval: {
      ...intervalMetadata,
      harmonicName,
      deviationCents: pitch.centsFromNearest,
    },
    semitoneDistance,
    centDistance,
    chordMembership: {
      member: inChord,
      role: chordRole,
      description: inChord ? `${chordRole} of ${chordContextName}` : `not contained in ${chordContextName}`,
    },
    scaleMembership: {
      member: inScale,
      degreeLabel,
      degreeIndex,
      description: inScale
        ? `${degreeLabel} of the ${context.scaleName ?? `${tonicName} active scale`}`
        : `chromatic to the ${context.scaleName ?? `${tonicName} active scale`}`,
    },
    tension: {
      category,
      label: tensionLabel,
      microtonallyInflected,
      description: tensionDescription,
    },
    possibleResolutions: buildResolutionSuggestions(
      pitch,
      chordPitchClasses,
      chordRoot,
      context.chordQuality,
      accidentalPreference,
      maxResolutions,
      centeredChordTone,
    ),
    summary: `${pitchClassName} over ${chordContextName}: ${harmonicName}, ${membershipPhrase}, ${tensionLabel}.`,
  };
}
