import { describe, expect, it } from 'vitest';
import {
  centsBetweenFrequencies,
  describeMidiPitch,
  frequencyToMidi,
  midiToFrequency,
  midiToNote,
  normalizePitchClass,
  noteName,
  noteToMidi,
  parseNote,
  splitMidiPitch,
  transposeFrequency,
  transposeMidi,
} from '../src';

describe('continuous pitch conversion', () => {
  it('converts the A4 reference in both directions', () => {
    expect(frequencyToMidi(440)).toBe(69);
    expect(midiToFrequency(69)).toBe(440);
    expect(frequencyToMidi(midiToFrequency(60))).toBeCloseTo(60, 12);
  });

  it('round-trips fractional MIDI coordinates without snapping', () => {
    const original = 57.237;
    const frequency = midiToFrequency(original);
    expect(frequencyToMidi(frequency)).toBeCloseTo(original, 12);
    expect(splitMidiPitch(original)).toMatchObject({
      nearestMidi: 57,
      pitchClass: 9,
      octave: 3,
    });
    expect(splitMidiPitch(original).centsFromNearest).toBeCloseTo(23.7, 10);
    expect(Object.is(splitMidiPitch(-0.5).nearestMidi, -0)).toBe(false);
    expect(splitMidiPitch(Number.MAX_SAFE_INTEGER)).toMatchObject({
      nearestMidi: Number.MAX_SAFE_INTEGER,
      centsFromNearest: 0,
    });
    expect(splitMidiPitch(-Number.MAX_SAFE_INTEGER)).toMatchObject({
      nearestMidi: -Number.MAX_SAFE_INTEGER,
      centsFromNearest: 0,
    });
    expect(() => splitMidiPitch(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe-integer/);
    expect(() => splitMidiPitch(Number.MAX_VALUE)).toThrow(/safe-integer/);
  });

  it('measures and applies cents as a continuous ratio', () => {
    const raised = transposeFrequency(440, 25);
    expect(centsBetweenFrequencies(440, raised)).toBeCloseTo(25, 10);
    expect(frequencyToMidi(raised)).toBeCloseTo(69.25, 10);
  });

  it('normalizes pitch classes in either direction', () => {
    expect(normalizePitchClass(-1)).toBe(11);
    expect(normalizePitchClass(25)).toBe(1);
    expect(normalizePitchClass(-0.25)).toBe(11.75);
    expect(() => normalizePitchClass(Number.MAX_VALUE)).toThrow(/safely representable/);
  });

  it('rejects physically invalid frequencies', () => {
    expect(() => frequencyToMidi(0)).toThrow(RangeError);
    expect(() => centsBetweenFrequencies(-1, 440)).toThrow(RangeError);
  });

  it('avoids ratio underflow and rejects non-representable conversion results', () => {
    expect(frequencyToMidi(Number.MIN_VALUE, Number.MAX_VALUE)).toBeTypeOf('number');
    expect(centsBetweenFrequencies(Number.MIN_VALUE, Number.MAX_VALUE)).toBeTypeOf('number');
    expect(() => midiToFrequency(Number.MAX_VALUE)).toThrow(/finite positive/);
    expect(() => midiToFrequency(-Number.MAX_VALUE)).toThrow(/finite positive/);
    expect(() => transposeFrequency(Number.MAX_VALUE, 1_200)).toThrow(/finite positive/);
    expect(() => transposeFrequency(Number.MIN_VALUE, -1_200)).toThrow(/finite positive/);
    expect(() => transposeMidi(Number.MAX_VALUE, Number.MAX_VALUE)).toThrow(/finite/);
  });
});

describe('note naming and parsing', () => {
  it('names sharp and flat pitch classes', () => {
    expect(noteName(1)).toBe('C♯');
    expect(noteName(1, 'flat')).toBe('D♭');
    expect(noteName(-2, 'flat')).toBe('B♭');
  });

  it('parses ASCII and Unicode accidentals with or without octave', () => {
    expect(parseNote('C#4')).toMatchObject({ pitchClass: 1, octave: 4, midi: 61, name: 'C♯4' });
    expect(parseNote('D♭3')).toMatchObject({ pitchClass: 1, octave: 3, midi: 49, name: 'D♭3' });
    expect(parseNote('Bb')).toMatchObject({ pitchClass: 10, octave: null, midi: null, name: 'B♭' });
  });

  it('respects spelled octave boundaries and double sharps', () => {
    expect(noteToMidi('B#3')).toBe(60);
    expect(noteToMidi('Cb4')).toBe(59);
    expect(parseNote('Fx5')).toMatchObject({ pitchClass: 7, accidentalOffset: 2, name: 'F𝄪5' });
    expect(noteToMidi('F𝄪5')).toBe(79);
  });

  it('parses and renders continuous cent offsets', () => {
    expect(noteToMidi('A4 -23c')).toBeCloseTo(68.77, 10);
    expect(midiToNote(69.23)).toBe('A4 +23¢');
    expect(midiToNote(69.234, { centsPrecision: 2 })).toBe('A4 +23.4¢');
    expect(midiToNote(69.23, { includeCents: false })).toBe('A4');
  });

  it('exposes both named and continuous fields in a description', () => {
    const pitch = describeMidiPitch(61.125, 'flat');
    expect(pitch).toMatchObject({
      name: 'D♭4 +12.5¢',
      pitchClassName: 'D♭',
      nearestMidi: 61,
      centsFromNearest: 12.5,
    });
    expect(pitch.frequencyHz).toBeCloseTo(midiToFrequency(61.125), 12);
  });

  it('rejects malformed or register-free MIDI conversion requests', () => {
    expect(() => parseNote('H4')).toThrow(SyntaxError);
    expect(() => noteToMidi('F♯')).toThrow(SyntaxError);
    expect(() => noteName(1.2)).toThrow(RangeError);
    expect(() => noteName(Number.MAX_VALUE)).toThrow(/safe integer/);
    expect(() => parseNote(`C${'9'.repeat(400)}`)).toThrow(/octave/);
    expect(() => parseNote(`C4 +${'9'.repeat(400)}c`)).toThrow(/cents/);
    expect(() => parseNote(`C${Number.MAX_SAFE_INTEGER}`)).toThrow(/safe-integer/);
  });
});
