import { describe, expect, it } from 'vitest';
import {
  analyzeHarmonicRelationship,
  buildChord,
  buildScale,
  createHarmonicContext,
  midiToFrequency,
} from '../src';

const cMajorContext = createHarmonicContext(buildScale('C', 'major'), buildChord('C', 'major'));

describe('harmonic relationship analysis', () => {
  it('describes D over C major as a diatonic ninth, not an error', () => {
    const relationship = analyzeHarmonicRelationship('D4', cMajorContext);

    expect(relationship.interval).toMatchObject({
      name: 'major second',
      shortName: 'M2',
      harmonicName: 'ninth',
    });
    expect(relationship.semitoneDistance).toBe(2);
    expect(relationship.centDistance).toBe(200);
    expect(relationship.chordMembership).toMatchObject({ member: false, role: null });
    expect(relationship.scaleMembership).toMatchObject({ member: true, degreeLabel: '2' });
    expect(relationship.tension.category).toBe('diatonic-tension');
    expect(relationship.summary).toBe('D over C major: ninth, non-chord tone, diatonic tension.');
    expect(JSON.stringify(relationship)).not.toMatch(/wrong|incorrect|bad/i);
  });

  it('offers nearby chord tones as possible movements', () => {
    const relationship = analyzeHarmonicRelationship('D4', cMajorContext);
    expect(relationship.possibleResolutions).toHaveLength(2);
    expect(relationship.possibleResolutions[0]).toMatchObject({ noteName: 'C', direction: 'down', motionCents: -200, chordRole: 'root' });
    expect(relationship.possibleResolutions[1]).toMatchObject({ noteName: 'E', direction: 'up', motionCents: 200, chordRole: 'major third' });
  });

  it('describes chromatic color contextually', () => {
    const relationship = analyzeHarmonicRelationship('C♯4', cMajorContext);
    expect(relationship.chordMembership.member).toBe(false);
    expect(relationship.scaleMembership.member).toBe(false);
    expect(relationship.tension.category).toBe('chromatic-tension');
    expect(relationship.tension.description).toContain('depends on direction, duration, voicing, and resolution');
    expect(relationship.possibleResolutions[0]).toMatchObject({ noteName: 'C', motionCents: -100 });
  });

  it('recognizes a centered chord tone as locally settled', () => {
    const relationship = analyzeHarmonicRelationship({ midi: 64 }, cMajorContext);
    expect(relationship.chordMembership).toMatchObject({ member: true, role: 'major third' });
    expect(relationship.tension.category).toBe('chord-tone');
    expect(relationship.possibleResolutions).toEqual([]);
  });

  it('preserves a microtonal inflection instead of silently rounding it', () => {
    const relationship = analyzeHarmonicRelationship({ midi: 64.23 }, cMajorContext);
    expect(relationship.pitch.label).toBe('E4 +23¢');
    expect(relationship.pitch.pitchClass).toBe(4);
    expect(relationship.pitch.centsFromNearest).toBeCloseTo(23, 10);
    expect(relationship.semitoneDistance).toBeCloseTo(4.23, 10);
    expect(relationship.centDistance).toBeCloseTo(423, 10);
    expect(relationship.interval.deviationCents).toBeCloseTo(23, 10);
    expect(relationship.chordMembership).toMatchObject({ member: true, role: 'major third' });
    expect(relationship.tension).toMatchObject({
      category: 'inflected-chord-tone',
      microtonallyInflected: true,
    });
    expect(relationship.possibleResolutions[0].noteName).toBe('E');
    expect(relationship.possibleResolutions[0].motionCents).toBeCloseTo(-23, 10);
  });

  it('keeps continuous distance correct across a pitch-class boundary', () => {
    const relationship = analyzeHarmonicRelationship({ midi: 71.6 }, cMajorContext);
    expect(relationship.pitch).toMatchObject({ pitchClass: 0 });
    expect(relationship.pitch.continuousPitchClass).toBeCloseTo(11.6, 10);
    expect(relationship.pitch.centsFromNearest).toBeCloseTo(-40, 10);
    expect(relationship.semitoneDistance).toBeCloseTo(11.6, 10);
    expect(relationship.centDistance).toBeCloseTo(1160, 10);
    expect(relationship.possibleResolutions[0]).toMatchObject({ noteName: 'C', direction: 'up' });
    expect(relationship.possibleResolutions[0].motionCents).toBeCloseTo(40, 10);
  });

  it('accepts frequency and pitch-class inputs', () => {
    const fromFrequency = analyzeHarmonicRelationship({ frequencyHz: midiToFrequency(67) }, cMajorContext);
    expect(fromFrequency.chordMembership).toMatchObject({ member: true, role: 'perfect fifth' });

    const fromPitchClass = analyzeHarmonicRelationship({ pitchClass: 10, centsOffset: -12 }, cMajorContext);
    expect(fromPitchClass.pitch).toMatchObject({ pitchClass: 10 });
    expect(fromPitchClass.pitch.centsFromNearest).toBeCloseTo(-12, 10);
    expect(fromPitchClass.tension.category).toBe('chromatic-tension');
  });

  it('uses chord-quality-specific roles in minor harmony', () => {
    const context = createHarmonicContext(buildScale('A', 'natural minor'), buildChord('A', 'minor'));
    const relationship = analyzeHarmonicRelationship('C4', context);
    expect(relationship.interval.harmonicName).toBe('minor third / sharp ninth');
    expect(relationship.chordMembership.role).toBe('minor third');
    expect(relationship.scaleMembership.degreeLabel).toBe('♭3');
  });

  it('rejects internally contradictory harmonic contexts', () => {
    expect(() => analyzeHarmonicRelationship('C4', {
      ...cMajorContext,
      chordPitchClasses: [],
    })).toThrow(/cannot be empty/);
    expect(() => analyzeHarmonicRelationship('C4', {
      ...cMajorContext,
      chordPitchClasses: [2, 5, 9],
    })).toThrow(/chord root/);
    expect(() => analyzeHarmonicRelationship('C4', {
      ...cMajorContext,
      scalePitchClasses: [2, 4, 5, 7, 9, 11],
    })).toThrow(/tonic/);
  });
});
