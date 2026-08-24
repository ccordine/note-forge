import {
  noteName,
  parseNote,
  resolvePitchClass,
  spellPitchClass,
  transposeNoteLetter,
  type AccidentalPreference,
} from './note';
import { normalizePitchClass } from './pitch';

export type ScaleType =
  | 'major'
  | 'natural-minor'
  | 'major-pentatonic'
  | 'minor-pentatonic'
  | 'blues';

export interface ScaleDefinition {
  type: ScaleType;
  name: string;
  intervals: readonly number[];
  degreeLabels: readonly string[];
  /** Diatonic degree numbers used to spell each member. */
  diatonicDegrees: readonly number[];
  aliases: readonly string[];
}

export interface ScaleDegree {
  /** One-based position in this particular scale. */
  index: number;
  /** Functional label relative to the tonic, for example "♭3". */
  label: string;
  semitonesFromTonic: number;
  pitchClass: number;
  noteName: string;
}

export interface Scale {
  type: ScaleType;
  name: string;
  tonicPitchClass: number;
  tonicName: string;
  intervals: readonly number[];
  pitchClasses: readonly number[];
  degrees: readonly ScaleDegree[];
}

export interface BuildScaleOptions {
  accidentalPreference?: AccidentalPreference;
}

export interface ScaleMembership {
  inScale: boolean;
  degree: ScaleDegree | null;
}

/** Chromatic scale-degree labels used by tonic-relative exercises. */
export const CHROMATIC_SCALE_DEGREES = Object.freeze([
  '1',
  '♭2',
  '2',
  '♭3',
  '3',
  '4',
  '♯4 / ♭5',
  '5',
  '♭6',
  '6',
  '♭7',
  '7',
] as const);

const SCALE_DEFINITIONS: Record<ScaleType, ScaleDefinition> = {
  major: {
    type: 'major',
    name: 'major',
    intervals: [0, 2, 4, 5, 7, 9, 11],
    degreeLabels: ['1', '2', '3', '4', '5', '6', '7'],
    diatonicDegrees: [1, 2, 3, 4, 5, 6, 7],
    aliases: ['ionian'],
  },
  'natural-minor': {
    type: 'natural-minor',
    name: 'natural minor',
    intervals: [0, 2, 3, 5, 7, 8, 10],
    degreeLabels: ['1', '2', '♭3', '4', '5', '♭6', '♭7'],
    diatonicDegrees: [1, 2, 3, 4, 5, 6, 7],
    aliases: ['minor', 'aeolian'],
  },
  'major-pentatonic': {
    type: 'major-pentatonic',
    name: 'major pentatonic',
    intervals: [0, 2, 4, 7, 9],
    degreeLabels: ['1', '2', '3', '5', '6'],
    diatonicDegrees: [1, 2, 3, 5, 6],
    aliases: [],
  },
  'minor-pentatonic': {
    type: 'minor-pentatonic',
    name: 'minor pentatonic',
    intervals: [0, 3, 5, 7, 10],
    degreeLabels: ['1', '♭3', '4', '5', '♭7'],
    diatonicDegrees: [1, 3, 4, 5, 7],
    aliases: [],
  },
  blues: {
    type: 'blues',
    name: 'blues',
    intervals: [0, 3, 5, 6, 7, 10],
    degreeLabels: ['1', '♭3', '4', '♯4 / ♭5', '5', '♭7'],
    diatonicDegrees: [1, 3, 4, 4, 5, 7],
    aliases: ['minor blues'],
  },
};

function freezeScaleDefinition(definition: ScaleDefinition): ScaleDefinition {
  return Object.freeze({
    ...definition,
    intervals: Object.freeze([...definition.intervals]),
    degreeLabels: Object.freeze([...definition.degreeLabels]),
    diatonicDegrees: Object.freeze([...definition.diatonicDegrees]),
    aliases: Object.freeze([...definition.aliases]),
  });
}

export const SCALES: Readonly<Record<ScaleType, ScaleDefinition>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SCALE_DEFINITIONS).map(([type, definition]) => [
      type,
      freezeScaleDefinition(definition),
    ]),
  ) as Record<ScaleType, ScaleDefinition>,
);

function inferAccidentalPreference(tonic: number | string): AccidentalPreference {
  if (typeof tonic === 'string') {
    if (/[b♭]/.test(tonic)) return 'flat';
    if (/[#♯x]/i.test(tonic)) return 'sharp';
    // F major-family spellings conventionally prefer B-flat.
    if (resolvePitchClass(tonic) === 5) return 'flat';
  }
  return 'sharp';
}

export function resolveScaleType(value: ScaleType | string): ScaleType {
  const normalized = value
    .trim()
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replaceAll('_', '-')
    .replaceAll(' ', '-');
  const compact = normalized.replaceAll('-', '');
  for (const definition of Object.values(SCALES)) {
    const candidates = [definition.type, definition.name, ...definition.aliases]
      .map((candidate) => candidate.replaceAll(' ', '-').toLowerCase());
    if (
      candidates.includes(normalized)
      || candidates.some((candidate) => candidate.replaceAll('-', '') === compact)
    ) {
      return definition.type;
    }
  }
  throw new RangeError(`Unknown scale type: "${value}"`);
}

/** Build one of NoteForge's foundational scales from a tonic pitch class or name. */
export function buildScale(
  tonic: number | string,
  type: ScaleType | string,
  options: BuildScaleOptions = {},
): Scale {
  const tonicPitchClass = resolvePitchClass(tonic);
  const resolvedType = resolveScaleType(type);
  const definition = SCALES[resolvedType];
  const accidentalPreference = options.accidentalPreference ?? inferAccidentalPreference(tonic);
  const preserveExplicitSpelling = typeof tonic === 'string' && options.accidentalPreference === undefined;
  const parsedTonic = typeof tonic === 'string' ? parseNote(tonic) : null;
  const tonicName = preserveExplicitSpelling && parsedTonic
    ? `${parsedTonic.letter}${parsedTonic.accidental}`
    : noteName(tonicPitchClass, accidentalPreference);
  const tonicLetter = parseNote(tonicName).letter;
  const pitchClasses = definition.intervals.map((interval) => normalizePitchClass(tonicPitchClass + interval));
  const degrees = definition.intervals.map((interval, index): ScaleDegree => ({
    index: index + 1,
    label: definition.degreeLabels[index],
    semitonesFromTonic: interval,
    pitchClass: pitchClasses[index],
    noteName: spellPitchClass(
      pitchClasses[index],
      transposeNoteLetter(tonicLetter, definition.diatonicDegrees[index] - 1),
    ),
  }));

  return {
    type: resolvedType,
    name: `${tonicName} ${definition.name}`,
    tonicPitchClass,
    tonicName,
    intervals: [...definition.intervals],
    pitchClasses,
    degrees,
  };
}

export function getScaleMembership(pitchClass: number, scale: Scale): ScaleMembership {
  if (!Number.isSafeInteger(pitchClass)) {
    throw new RangeError('pitchClass must be a safe integer');
  }
  const normalized = normalizePitchClass(pitchClass);
  const degree = scale.degrees.find((candidate) => candidate.pitchClass === normalized) ?? null;
  return { inScale: degree !== null, degree };
}

/** Return the chromatic functional label of a note against a tonic. */
export function scaleDegreeLabel(tonicPitchClass: number, pitchClass: number): string {
  if (!Number.isSafeInteger(tonicPitchClass) || !Number.isSafeInteger(pitchClass)) {
    throw new RangeError('tonicPitchClass and pitchClass must be safe integers');
  }
  const distance = normalizePitchClass(pitchClass - tonicPitchClass);
  return CHROMATIC_SCALE_DEGREES[distance];
}
