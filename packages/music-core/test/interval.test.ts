import { describe, expect, it } from 'vitest';
import {
  getIntervalMetadata,
  harmonicIntervalName,
  intervalBetweenFrequencies,
  intervalBetweenMidi,
  midiToFrequency,
} from '../src';

describe('interval metadata', () => {
  it('names simple intervals and their direction', () => {
    expect(getIntervalMetadata(7)).toMatchObject({
      shortName: 'P5',
      name: 'perfect fifth',
      number: 5,
      quality: 'perfect',
      direction: 'ascending',
    });
    expect(getIntervalMetadata(-3)).toMatchObject({
      shortName: 'm3',
      name: 'minor third',
      direction: 'descending',
      directedName: 'descending minor third',
    });
  });

  it('names octaves and compound intervals', () => {
    expect(getIntervalMetadata(12)).toMatchObject({ shortName: 'P8', name: 'perfect octave', octaves: 1 });
    expect(getIntervalMetadata(14)).toMatchObject({ shortName: 'M9', name: 'major ninth', number: 9 });
    expect(getIntervalMetadata(19)).toMatchObject({ shortName: 'P12', name: 'perfect twelfth', number: 12 });
  });

  it('keeps tritone aliases visible', () => {
    const tritone = getIntervalMetadata(6);
    expect(tritone.shortName).toBe('TT');
    expect(tritone.aliases).toContain('augmented fourth');
    expect(tritone.aliases).toContain('diminished fifth');
  });
});

describe('continuous interval analysis', () => {
  it('preserves exact distance while naming the nearest interval', () => {
    const result = intervalBetweenMidi(60, 63.23);
    expect(result.exactSemitones).toBeCloseTo(3.23, 12);
    expect(result.exactCents).toBeCloseTo(323, 10);
    expect(result.nearestSemitones).toBe(3);
    expect(result.deviationCents).toBeCloseTo(23, 10);
    expect(result.interval.shortName).toBe('m3');
  });

  it('reports descending width independently from direction', () => {
    const result = intervalBetweenMidi(60, 56.8);
    expect(result.direction).toBe('descending');
    expect(result.exactCents).toBeCloseTo(-320, 10);
    expect(result.nearestSemitones).toBe(-3);
    expect(result.deviationCents).toBeCloseTo(20, 10);
  });

  it('works directly from frequencies', () => {
    const result = intervalBetweenFrequencies(midiToFrequency(48), midiToFrequency(55.1));
    expect(result.interval.shortName).toBe('P5');
    expect(result.deviationCents).toBeCloseTo(10, 9);
  });

  it('uses harmonic extension names without losing interval names', () => {
    expect(harmonicIntervalName(2)).toBe('ninth');
    expect(harmonicIntervalName(6)).toBe('tritone / sharp eleventh');
    expect(harmonicIntervalName(14)).toBe('ninth');
  });

  it('requires integer distances for direct naming', () => {
    expect(() => getIntervalMetadata(3.2)).toThrow(RangeError);
  });
});
