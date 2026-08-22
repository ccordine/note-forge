import { frequencyToMidi } from './pitch';

export type IntervalDirection = 'ascending' | 'descending' | 'unison';
export type IntervalQuality = 'perfect' | 'major' | 'minor' | 'augmented' | 'diminished';

export interface SimpleIntervalDefinition {
  semitones: number;
  number: number;
  quality: IntervalQuality;
  shortName: string;
  name: string;
  aliases: readonly string[];
}

export interface IntervalMetadata {
  /** Absolute, equal-tempered size used to name this interval. */
  semitones: number;
  /** Signed equal-tempered size supplied by the caller. */
  signedSemitones: number;
  simpleSemitones: number;
  octaves: number;
  number: number;
  quality: IntervalQuality;
  shortName: string;
  name: string;
  aliases: readonly string[];
  direction: IntervalDirection;
  directedName: string;
}

export interface IntervalAnalysis {
  /** Exact signed distance; fractional semitones are preserved. */
  exactSemitones: number;
  exactCents: number;
  /** Closest named 12-TET interval, retaining direction. */
  nearestSemitones: number;
  /** Difference in width from the named interval. Positive means wider. */
  deviationCents: number;
  direction: IntervalDirection;
  interval: IntervalMetadata;
}

export const SIMPLE_INTERVALS: readonly SimpleIntervalDefinition[] = [
  { semitones: 0, number: 1, quality: 'perfect', shortName: 'P1', name: 'perfect unison', aliases: ['unison'] },
  { semitones: 1, number: 2, quality: 'minor', shortName: 'm2', name: 'minor second', aliases: ['semitone', 'half step'] },
  { semitones: 2, number: 2, quality: 'major', shortName: 'M2', name: 'major second', aliases: ['whole tone', 'whole step'] },
  { semitones: 3, number: 3, quality: 'minor', shortName: 'm3', name: 'minor third', aliases: [] },
  { semitones: 4, number: 3, quality: 'major', shortName: 'M3', name: 'major third', aliases: [] },
  { semitones: 5, number: 4, quality: 'perfect', shortName: 'P4', name: 'perfect fourth', aliases: [] },
  { semitones: 6, number: 4, quality: 'augmented', shortName: 'TT', name: 'tritone', aliases: ['augmented fourth', 'diminished fifth'] },
  { semitones: 7, number: 5, quality: 'perfect', shortName: 'P5', name: 'perfect fifth', aliases: [] },
  { semitones: 8, number: 6, quality: 'minor', shortName: 'm6', name: 'minor sixth', aliases: [] },
  { semitones: 9, number: 6, quality: 'major', shortName: 'M6', name: 'major sixth', aliases: [] },
  { semitones: 10, number: 7, quality: 'minor', shortName: 'm7', name: 'minor seventh', aliases: [] },
  { semitones: 11, number: 7, quality: 'major', shortName: 'M7', name: 'major seventh', aliases: [] },
] as const;

/** Harmonic-role names use extensions where that is the conventional useful label. */
export const HARMONIC_INTERVAL_NAMES = [
  'root',
  'minor ninth',
  'ninth',
  'minor third / sharp ninth',
  'major third',
  'eleventh',
  'tritone / sharp eleventh',
  'perfect fifth',
  'minor sixth / flat thirteenth',
  'sixth / thirteenth',
  'minor seventh',
  'major seventh',
] as const;

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number`);
  }
}

function intervalDirection(value: number): IntervalDirection {
  return value > 0 ? 'ascending' : value < 0 ? 'descending' : 'unison';
}

function ordinal(value: number): string {
  const remainder100 = value % 100;
  const remainder10 = value % 10;
  const suffix = remainder100 >= 11 && remainder100 <= 13
    ? 'th'
    : remainder10 === 1
      ? 'st'
      : remainder10 === 2
        ? 'nd'
        : remainder10 === 3
          ? 'rd'
          : 'th';
  return `${value}${suffix}`;
}

function qualityPrefix(quality: IntervalQuality): string {
  switch (quality) {
    case 'perfect': return 'P';
    case 'major': return 'M';
    case 'minor': return 'm';
    case 'augmented': return 'A';
    case 'diminished': return 'd';
  }
}

function compoundName(quality: IntervalQuality, number: number): string {
  const intervalNumberNames: Partial<Record<number, string>> = {
    8: 'octave',
    9: 'ninth',
    10: 'tenth',
    11: 'eleventh',
    12: 'twelfth',
    13: 'thirteenth',
    14: 'fourteenth',
    15: 'fifteenth',
  };
  return `${quality} ${intervalNumberNames[number] ?? ordinal(number)}`;
}

/** Name an integer equal-tempered interval. Negative values describe descent. */
export function getIntervalMetadata(signedSemitones: number): IntervalMetadata {
  requireFinite(signedSemitones, 'semitones');
  if (!Number.isInteger(signedSemitones)) {
    throw new RangeError('semitones must be an integer when naming an interval');
  }

  const direction = intervalDirection(signedSemitones);
  const semitones = Math.abs(signedSemitones);
  const simpleSemitones = semitones % 12;
  const octaves = Math.floor(semitones / 12);
  const simple = SIMPLE_INTERVALS[simpleSemitones];

  let number: number;
  let quality: IntervalQuality;
  let shortName: string;
  let name: string;
  let aliases: readonly string[];

  if (semitones === 0) {
    ({ number, quality, shortName, name, aliases } = simple);
  } else if (simpleSemitones === 0) {
    number = octaves * 7 + 1;
    quality = 'perfect';
    shortName = `P${number}`;
    name = compoundName(quality, number);
    aliases = number === 8 ? ['octave'] : [];
  } else {
    number = octaves * 7 + simple.number;
    quality = simple.quality;
    const isSimpleTritone = semitones === 6;
    shortName = isSimpleTritone ? simple.shortName : `${qualityPrefix(quality)}${number}`;
    name = octaves === 0 ? simple.name : compoundName(quality, number);
    aliases = octaves === 0 ? simple.aliases : [];
  }

  return {
    semitones,
    signedSemitones,
    simpleSemitones,
    octaves,
    number,
    quality,
    shortName,
    name,
    aliases,
    direction,
    directedName: direction === 'unison' ? name : `${direction} ${name}`,
  };
}

/** Compare two continuous MIDI coordinates and name the closest 12-TET interval. */
export function intervalBetweenMidi(fromMidi: number, toMidi: number): IntervalAnalysis {
  requireFinite(fromMidi, 'fromMidi');
  requireFinite(toMidi, 'toMidi');

  const exactSemitones = toMidi - fromMidi;
  const direction = intervalDirection(exactSemitones);
  const absoluteSemitones = Math.abs(exactSemitones);
  const nearestAbsolute = Math.floor(absoluteSemitones + 0.5);
  const nearestSemitones = nearestAbsolute === 0
    ? 0
    : direction === 'descending'
      ? -nearestAbsolute
      : nearestAbsolute;

  return {
    exactSemitones,
    exactCents: exactSemitones * 100,
    nearestSemitones,
    deviationCents: (absoluteSemitones - nearestAbsolute) * 100,
    direction,
    interval: getIntervalMetadata(nearestSemitones),
  };
}

/** Compare two frequencies and name their closest 12-TET interval. */
export function intervalBetweenFrequencies(fromHz: number, toHz: number): IntervalAnalysis {
  return intervalBetweenMidi(frequencyToMidi(fromHz), frequencyToMidi(toHz));
}

/** Harmonic extension/role name for a pitch-class distance above a chord root. */
export function harmonicIntervalName(semitonesAboveRoot: number): string {
  requireFinite(semitonesAboveRoot, 'semitonesAboveRoot');
  const normalized = ((Math.round(semitonesAboveRoot) % 12) + 12) % 12;
  return HARMONIC_INTERVAL_NAMES[normalized];
}
