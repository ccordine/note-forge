import { describe, expect, it } from 'vitest';
import {
  buildChord,
  buildScale,
  CHORD_QUALITIES,
  getChordMembership,
  getScaleMembership,
  identifyChords,
  resolveChordQuality,
  resolveScaleType,
  scaleDegreeLabel,
  SCALES,
} from '../src';

describe('foundational scales', () => {
  it('publishes the five initial scale families', () => {
    expect(Object.keys(SCALES)).toEqual([
      'major',
      'natural-minor',
      'major-pentatonic',
      'minor-pentatonic',
      'blues',
    ]);
    expect(SCALES.blues.intervals).toEqual([0, 3, 5, 6, 7, 10]);
    expect(Object.isFrozen(SCALES)).toBe(true);
    expect(Object.isFrozen(SCALES.major)).toBe(true);
    expect(Object.isFrozen(SCALES.major.intervals)).toBe(true);
  });

  it('builds pitch classes and functional degrees', () => {
    const cMajor = buildScale('C', 'major');
    expect(cMajor.pitchClasses).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(cMajor.degrees.map((degree) => degree.label)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(cMajor.degrees.map((degree) => degree.noteName)).toEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B']);
  });

  it('supports aliases and practical flat spellings', () => {
    expect(resolveScaleType('minor')).toBe('natural-minor');
    expect(resolveScaleType('majorPentatonic')).toBe('major-pentatonic');
    const fMajor = buildScale('F', 'major');
    expect(fMajor.degrees.map((degree) => degree.noteName)).toEqual(['F', 'G', 'A', 'B♭', 'C', 'D', 'E']);
    expect(buildScale('C♯', 'major').degrees.map((degree) => degree.noteName))
      .toEqual(['C♯', 'D♯', 'E♯', 'F♯', 'G♯', 'A♯', 'B♯']);
  });

  it('reports scale membership and chromatic scale degree separately', () => {
    const aMinorPentatonic = buildScale('A', 'minor pentatonic');
    expect(getScaleMembership(0, aMinorPentatonic)).toMatchObject({ inScale: true, degree: { label: '♭3' } });
    expect(getScaleMembership(1, aMinorPentatonic)).toEqual({ inScale: false, degree: null });
    expect(scaleDegreeLabel(0, 6)).toBe('♯4 / ♭5');
  });
});

describe('chords', () => {
  it('publishes triad, suspended, and seventh quality metadata', () => {
    expect(CHORD_QUALITIES.major.intervals).toEqual([0, 4, 7]);
    expect(CHORD_QUALITIES['half-diminished-7'].intervals).toEqual([0, 3, 6, 10]);
    expect(resolveChordQuality('sus')).toBe('suspended-4');
    expect(resolveChordQuality('m7b5')).toBe('half-diminished-7');
    expect(resolveChordQuality('major7')).toBe('major-7');
    expect(resolveChordQuality('dominant7')).toBe('dominant-7');
    expect(Object.isFrozen(CHORD_QUALITIES)).toBe(true);
    expect(Object.isFrozen(CHORD_QUALITIES.major)).toBe(true);
    expect(Object.isFrozen(CHORD_QUALITIES.major.aliases)).toBe(true);
  });

  it('builds pitch classes with explicit chord-tone roles', () => {
    const chord = buildChord('C', 'major');
    expect(chord.name).toBe('C major');
    expect(chord.symbol).toBe('C');
    expect(chord.pitchClasses).toEqual([0, 4, 7]);
    expect(chord.tones.map((tone) => tone.role)).toEqual(['root', 'major third', 'perfect fifth']);
    expect(getChordMembership(4, chord)).toMatchObject({ inChord: true, tone: { role: 'major third' } });
    expect(getChordMembership(2, chord)).toEqual({ inChord: false, tone: null });
    expect(buildChord('C', 'diminished').tones.map((tone) => tone.noteName)).toEqual(['C', 'E♭', 'G♭']);
    expect(buildChord('C♯', 'major').tones.map((tone) => tone.noteName)).toEqual(['C♯', 'E♯', 'G♯']);
  });

  it('identifies inversion from a pitch-class set and supplied bass', () => {
    const matches = identifyChords([7, 0, 4], 4);
    const cMajor = matches.find((match) => match.chord.rootPitchClass === 0 && match.chord.quality === 'major');
    expect(cMajor?.inversion).toBe('first-inversion');
  });

  it('retains ambiguity for symmetrical pitch-class sets', () => {
    const diminished = identifyChords([0, 3, 6, 9]);
      expect(diminished.filter((match) => match.chord.quality === 'diminished-7')).toHaveLength(4);
  });

  it('rejects unsafe integer pitch-class inputs', () => {
    expect(() => getScaleMembership(Number.MAX_VALUE, buildScale('C', 'major')))
      .toThrow(/safe integer/);
    expect(() => identifyChords([0, Number.MAX_VALUE])).toThrow(/safe integers/);
  });
});
