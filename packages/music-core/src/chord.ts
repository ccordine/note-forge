import {
  noteName,
  parseNote,
  resolvePitchClass,
  spellPitchClass,
  transposeNoteLetter,
  type AccidentalPreference,
} from './note';
import { normalizePitchClass } from './pitch';

export type ChordQuality =
  | 'major'
  | 'minor'
  | 'diminished'
  | 'augmented'
  | 'suspended-2'
  | 'suspended-4'
  | 'dominant-7'
  | 'major-7'
  | 'minor-7'
  | 'half-diminished-7'
  | 'diminished-7';

export interface ChordQualityDefinition {
  quality: ChordQuality;
  name: string;
  symbol: string;
  intervals: readonly number[];
  diatonicDegrees: readonly number[];
  roles: readonly string[];
  aliases: readonly string[];
}

export interface ChordTone {
  index: number;
  role: string;
  semitonesFromRoot: number;
  pitchClass: number;
  noteName: string;
}

export interface Chord {
  quality: ChordQuality;
  name: string;
  symbol: string;
  rootPitchClass: number;
  rootName: string;
  intervals: readonly number[];
  pitchClasses: readonly number[];
  tones: readonly ChordTone[];
}

export interface BuildChordOptions {
  accidentalPreference?: AccidentalPreference;
}

export interface ChordMembership {
  inChord: boolean;
  tone: ChordTone | null;
}

export type ChordInversion = 'root-position' | 'first-inversion' | 'second-inversion' | 'third-inversion' | 'unknown';

export interface ChordIdentification {
  chord: Chord;
  bassPitchClass: number | null;
  inversion: ChordInversion;
}

const CHORD_QUALITY_DEFINITIONS: Record<ChordQuality, ChordQualityDefinition> = {
  major: {
    quality: 'major', name: 'major', symbol: '', intervals: [0, 4, 7],
    diatonicDegrees: [1, 3, 5],
    roles: ['root', 'major third', 'perfect fifth'], aliases: ['maj'],
  },
  minor: {
    quality: 'minor', name: 'minor', symbol: 'm', intervals: [0, 3, 7],
    diatonicDegrees: [1, 3, 5],
    roles: ['root', 'minor third', 'perfect fifth'], aliases: ['min', 'm'],
  },
  diminished: {
    quality: 'diminished', name: 'diminished', symbol: 'dim', intervals: [0, 3, 6],
    diatonicDegrees: [1, 3, 5],
    roles: ['root', 'minor third', 'diminished fifth'], aliases: ['dim', '°'],
  },
  augmented: {
    quality: 'augmented', name: 'augmented', symbol: 'aug', intervals: [0, 4, 8],
    diatonicDegrees: [1, 3, 5],
    roles: ['root', 'major third', 'augmented fifth'], aliases: ['aug', '+'],
  },
  'suspended-2': {
    quality: 'suspended-2', name: 'suspended second', symbol: 'sus2', intervals: [0, 2, 7],
    diatonicDegrees: [1, 2, 5],
    roles: ['root', 'major second', 'perfect fifth'], aliases: ['sus2'],
  },
  'suspended-4': {
    quality: 'suspended-4', name: 'suspended fourth', symbol: 'sus4', intervals: [0, 5, 7],
    diatonicDegrees: [1, 4, 5],
    roles: ['root', 'perfect fourth', 'perfect fifth'], aliases: ['sus', 'sus4'],
  },
  'dominant-7': {
    quality: 'dominant-7', name: 'dominant seventh', symbol: '7', intervals: [0, 4, 7, 10],
    diatonicDegrees: [1, 3, 5, 7],
    roles: ['root', 'major third', 'perfect fifth', 'minor seventh'], aliases: ['7', 'dominant seventh'],
  },
  'major-7': {
    quality: 'major-7', name: 'major seventh', symbol: 'maj7', intervals: [0, 4, 7, 11],
    diatonicDegrees: [1, 3, 5, 7],
    roles: ['root', 'major third', 'perfect fifth', 'major seventh'], aliases: ['maj7', 'major seventh'],
  },
  'minor-7': {
    quality: 'minor-7', name: 'minor seventh', symbol: 'm7', intervals: [0, 3, 7, 10],
    diatonicDegrees: [1, 3, 5, 7],
    roles: ['root', 'minor third', 'perfect fifth', 'minor seventh'], aliases: ['min7', 'm7', 'minor seventh'],
  },
  'half-diminished-7': {
    quality: 'half-diminished-7', name: 'half-diminished seventh', symbol: 'm7♭5', intervals: [0, 3, 6, 10],
    diatonicDegrees: [1, 3, 5, 7],
    roles: ['root', 'minor third', 'diminished fifth', 'minor seventh'], aliases: ['m7b5', 'ø7', 'half diminished'],
  },
  'diminished-7': {
    quality: 'diminished-7', name: 'diminished seventh', symbol: 'dim7', intervals: [0, 3, 6, 9],
    diatonicDegrees: [1, 3, 5, 7],
    roles: ['root', 'minor third', 'diminished fifth', 'diminished seventh'], aliases: ['dim7', '°7', 'diminished seventh'],
  },
};

function freezeChordQuality(
  definition: ChordQualityDefinition,
): ChordQualityDefinition {
  return Object.freeze({
    ...definition,
    intervals: Object.freeze([...definition.intervals]),
    diatonicDegrees: Object.freeze([...definition.diatonicDegrees]),
    roles: Object.freeze([...definition.roles]),
    aliases: Object.freeze([...definition.aliases]),
  });
}

export const CHORD_QUALITIES: Readonly<Record<ChordQuality, ChordQualityDefinition>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(CHORD_QUALITY_DEFINITIONS).map(([quality, definition]) => [
        quality,
        freezeChordQuality(definition),
      ]),
    ) as Record<ChordQuality, ChordQualityDefinition>,
  );

function inferAccidentalPreference(root: number | string): AccidentalPreference {
  if (typeof root === 'string' && /[b♭]/.test(root)) return 'flat';
  return 'sharp';
}

export function resolveChordQuality(value: ChordQuality | string): ChordQuality {
  const normalized = value
    .trim()
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replaceAll('_', '-')
    .replaceAll(' ', '-');
  const compact = normalized.replaceAll('-', '');
  for (const definition of Object.values(CHORD_QUALITIES)) {
    const candidates = [definition.quality, definition.name, ...definition.aliases]
      .map((candidate) => candidate.toLowerCase().replaceAll(' ', '-'));
    if (
      candidates.includes(normalized)
      || candidates.some((candidate) => candidate.replaceAll('-', '') === compact)
      || definition.symbol.toLowerCase() === value.trim().toLowerCase()
    ) {
      return definition.quality;
    }
  }
  throw new RangeError(`Unknown chord quality: "${value}"`);
}

/** Build a chord as pitch classes plus explicit functional roles. */
export function buildChord(
  root: number | string,
  quality: ChordQuality | string,
  options: BuildChordOptions = {},
): Chord {
  const rootPitchClass = resolvePitchClass(root);
  const resolvedQuality = resolveChordQuality(quality);
  const definition = CHORD_QUALITIES[resolvedQuality];
  const accidentalPreference = options.accidentalPreference ?? inferAccidentalPreference(root);
  const preserveExplicitSpelling = typeof root === 'string' && options.accidentalPreference === undefined;
  const parsedRoot = typeof root === 'string' ? parseNote(root) : null;
  const rootName = preserveExplicitSpelling && parsedRoot
    ? `${parsedRoot.letter}${parsedRoot.accidental}`
    : noteName(rootPitchClass, accidentalPreference);
  const rootLetter = parseNote(rootName).letter;
  const pitchClasses = definition.intervals.map((interval) => normalizePitchClass(rootPitchClass + interval));
  const tones = definition.intervals.map((interval, index): ChordTone => ({
    index: index + 1,
    role: definition.roles[index],
    semitonesFromRoot: interval,
    pitchClass: pitchClasses[index],
    noteName: spellPitchClass(
      pitchClasses[index],
      transposeNoteLetter(rootLetter, definition.diatonicDegrees[index] - 1),
    ),
  }));

  return {
    quality: resolvedQuality,
    name: `${rootName} ${definition.name}`,
    symbol: `${rootName}${definition.symbol}`,
    rootPitchClass,
    rootName,
    intervals: [...definition.intervals],
    pitchClasses,
    tones,
  };
}

export function getChordMembership(pitchClass: number, chord: Chord): ChordMembership {
  if (!Number.isSafeInteger(pitchClass)) {
    throw new RangeError('pitchClass must be a safe integer');
  }
  const normalized = normalizePitchClass(pitchClass);
  const tone = chord.tones.find((candidate) => candidate.pitchClass === normalized) ?? null;
  return { inChord: tone !== null, tone };
}

function inversionForToneIndex(index: number): ChordInversion {
  if (index === 0) return 'root-position';
  if (index === 1) return 'first-inversion';
  if (index === 2) return 'second-inversion';
  if (index === 3) return 'third-inversion';
  return 'unknown';
}

/**
 * Return every exact pitch-class-set match. Symmetrical chords can deliberately
 * yield multiple roots instead of hiding their ambiguity.
 */
export function identifyChords(
  pitchClasses: readonly number[],
  bassPitchClass?: number,
  options: BuildChordOptions = {},
): ChordIdentification[] {
  if (pitchClasses.length === 0) return [];
  if (!pitchClasses.every(Number.isSafeInteger)) {
    throw new RangeError('pitchClasses must contain only safe integers');
  }
  if (bassPitchClass !== undefined && !Number.isSafeInteger(bassPitchClass)) {
    throw new RangeError('bassPitchClass must be a safe integer');
  }

  const unique = [...new Set(pitchClasses.map(normalizePitchClass))].sort((a, b) => a - b);
  const bass = bassPitchClass === undefined ? null : normalizePitchClass(bassPitchClass);
  const matches: ChordIdentification[] = [];

  for (const rootPitchClass of unique) {
    for (const quality of Object.keys(CHORD_QUALITIES) as ChordQuality[]) {
      const chord = buildChord(rootPitchClass, quality, options);
      const candidateSet = [...chord.pitchClasses].sort((a, b) => a - b);
      if (candidateSet.length !== unique.length || candidateSet.some((pitchClass, index) => pitchClass !== unique[index])) {
        continue;
      }
      const bassToneIndex = bass === null ? -1 : chord.tones.findIndex((tone) => tone.pitchClass === bass);
      matches.push({
        chord,
        bassPitchClass: bass,
        inversion: bass === null ? 'unknown' : inversionForToneIndex(bassToneIndex),
      });
    }
  }
  return matches;
}
