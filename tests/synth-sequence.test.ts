import { describe, expect, it } from "vitest";

import { generateAdaptiveSession, type SkillDefinition } from "@noteforge/trainer-core";

import {
  createToneSequenceSchedule,
  playFrequencies,
  playPitchContour,
  playTone,
  playToneSequence,
  SYNTH_LIMITS,
  TIMBRES,
  type ToneSequenceItem,
  type ToneSpec,
} from "../apps/web/src/audio/synth";
import {
  CHORD_PRESETS,
  INTERVAL_LONG,
  INTERVAL_SHORT,
  SCALE_PRESETS,
} from "../apps/web/src/lib/music-display";

describe("tone sequence scheduling", () => {
  it("keeps every default trainer timbre inside the production synth vocabulary", () => {
    const definition: SkillDefinition = {
      skillId: "pitch.test",
      label: "Pitch test",
      description: "Cross-package timbre vocabulary authority",
      domain: "production",
      representations: ["heard-sound"],
      prerequisites: [],
      difficulty: 0.5,
      tags: [],
    };
    const scheduledTimbres = TIMBRES.map((_timbre, timbreIndex) => {
      let randomCall = 0;
      const rng = () => {
        randomCall += 1;
        return randomCall === 4 ? (timbreIndex + 0.25) / TIMBRES.length : 0;
      };
      return generateAdaptiveSession([definition], {}, { sessionSize: 1, rng })[0]
        ?.variation.timbre;
    });

    expect(scheduledTimbres).toEqual([...TIMBRES]);
  });

  it("preserves each tone's timbre while applying shared defaults", () => {
    const schedule = createToneSequenceSchedule([
      { frequencyHz: 220, timbre: "guitar" },
      { frequencyHz: 329.63, timbre: "flute", amplitude: 0.16 }
    ], 12, {
      timbre: "sine",
      duration: 0.7,
      amplitude: 0.24,
      gap: 0.1
    });

    expect(schedule).toEqual([
      {
        frequencyHz: 220,
        timbre: "guitar",
        duration: 0.7,
        amplitude: 0.24,
        when: 12
      },
      {
        frequencyHz: 329.63,
        timbre: "flute",
        duration: 0.7,
        amplitude: 0.16,
        when: 12.8
      }
    ]);
  });

  it("uses each item's duration and following gap to place the next tone", () => {
    const schedule = createToneSequenceSchedule([
      { frequencyHz: 261.63, duration: 0.4, gapAfter: 0.25 },
      { frequencyHz: 293.66, duration: 0.8, gapAfter: 0.05 },
      { frequencyHz: 329.63 }
    ], 4.5, { duration: 0.6, gap: 0.15 });

    expect(schedule.map(({ duration, when }) => ({ duration, when }))).toEqual([
      { duration: 0.4, when: 4.5 },
      { duration: 0.8, when: 5.15 },
      { duration: 0.6, when: 6 }
    ]);
  });

  it("returns an empty schedule for an empty gesture", () => {
    expect(createToneSequenceSchedule([], 2)).toEqual([]);
  });

  it("accepts exact production boundaries without silently narrowing them", () => {
    expect(createToneSequenceSchedule([
      {
        frequencyHz: SYNTH_LIMITS.minimumFrequencyHz,
        duration: SYNTH_LIMITS.maximumSequenceDurationSeconds,
        amplitude: SYNTH_LIMITS.maximumAmplitude,
        attack: SYNTH_LIMITS.maximumEnvelopeSeconds,
        release: SYNTH_LIMITS.maximumEnvelopeSeconds,
        gapAfter: 0,
      },
    ], 0)).toEqual([
      {
        frequencyHz: SYNTH_LIMITS.minimumFrequencyHz,
        duration: SYNTH_LIMITS.maximumSequenceDurationSeconds,
        amplitude: SYNTH_LIMITS.maximumAmplitude,
        attack: SYNTH_LIMITS.maximumEnvelopeSeconds,
        release: SYNTH_LIMITS.maximumEnvelopeSeconds,
        when: 0,
      },
    ]);

    expect(createToneSequenceSchedule([
      { frequencyHz: SYNTH_LIMITS.maximumFrequencyHz, duration: Number.EPSILON, gapAfter: 0 },
    ], Number.MAX_SAFE_INTEGER - SYNTH_LIMITS.maximumSequenceDurationSeconds))
      .toHaveLength(1);
  });

  it("rejects malformed or out-of-domain sequence inputs", () => {
    const validTone: ToneSequenceItem = { frequencyHz: 220, duration: 0.5, gapAfter: 0 };
    const invalidTones: readonly ToneSequenceItem[] = [
      { ...validTone, frequencyHz: SYNTH_LIMITS.minimumFrequencyHz - 0.01 },
      { ...validTone, frequencyHz: SYNTH_LIMITS.maximumFrequencyHz + 0.01 },
      { ...validTone, frequencyHz: Number.NaN },
      { ...validTone, duration: 0 },
      { ...validTone, duration: SYNTH_LIMITS.maximumToneDurationSeconds + 0.01 },
      { ...validTone, amplitude: 0 },
      { ...validTone, amplitude: SYNTH_LIMITS.maximumAmplitude + Number.EPSILON },
      { ...validTone, attack: -Number.EPSILON },
      { ...validTone, attack: SYNTH_LIMITS.maximumEnvelopeSeconds + 0.01 },
      { ...validTone, release: Number.NaN },
      { ...validTone, gapAfter: -Number.EPSILON },
      { ...validTone, gapAfter: SYNTH_LIMITS.maximumEnvelopeSeconds + 0.01 },
      { ...validTone, timbre: "noise" as never },
      {} as ToneSequenceItem,
    ];

    for (const tone of invalidTones) {
      expect(() => createToneSequenceSchedule([tone], 0)).toThrow(RangeError);
    }

    for (const startAt of [-Number.EPSILON, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      expect(() => createToneSequenceSchedule([validTone], startAt)).toThrow(RangeError);
    }

    for (const options of [
      { duration: Number.NaN },
      { amplitude: Number.NaN },
      { attack: -1 },
      { release: SYNTH_LIMITS.maximumEnvelopeSeconds + 1 },
      { gap: -1 },
      { gap: SYNTH_LIMITS.maximumEnvelopeSeconds + 1 },
      { startDelay: -1 },
      { startDelay: SYNTH_LIMITS.maximumEnvelopeSeconds + 1 },
      { timbre: "noise" as never },
    ]) {
      expect(() => createToneSequenceSchedule([validTone], 0, options)).toThrow(RangeError);
    }
  });

  it("bounds sequence allocation and total scheduled work", () => {
    const tooManyTones = Array.from(
      { length: SYNTH_LIMITS.maximumToneCount + 1 },
      () => ({ frequencyHz: 220 }),
    );
    expect(() => createToneSequenceSchedule(tooManyTones, 0)).toThrow(RangeError);
    expect(() => createToneSequenceSchedule([
      { frequencyHz: 220, duration: SYNTH_LIMITS.maximumSequenceDurationSeconds, gapAfter: 0.01 },
    ], 0)).toThrow(RangeError);
  });
});

describe("synth public input validation", () => {
  it("rejects bad tone and collection inputs before audio context creation", async () => {
    await expect(playTone({} as ToneSpec)).rejects.toBeInstanceOf(RangeError);
    await expect(playTone({ frequencyHz: Number.NaN })).rejects.toBeInstanceOf(RangeError);
    await expect(playFrequencies([220], "parallel" as never)).rejects.toBeInstanceOf(RangeError);
    await expect(playFrequencies(
      Array.from({ length: SYNTH_LIMITS.maximumToneCount + 1 }, () => 220),
      "simultaneous",
    )).rejects.toBeInstanceOf(RangeError);
    await expect(playFrequencies([220], "simultaneous", { amplitude: 0 }))
      .rejects.toBeInstanceOf(RangeError);
    await expect(playToneSequence([], { amplitude: 0 })).rejects.toBeInstanceOf(RangeError);
  });

  it("validates even empty and single-point pitch contours", async () => {
    await expect(playPitchContour([], 0, 0.2)).rejects.toBeInstanceOf(RangeError);
    await expect(playPitchContour([], 2, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(playPitchContour([Number.NaN], 2, 0.2)).rejects.toBeInstanceOf(RangeError);
    await expect(playPitchContour(
      Array.from({ length: SYNTH_LIMITS.maximumContourPointCount + 1 }, () => 60),
      2,
      0.2,
    )).rejects.toBeInstanceOf(RangeError);
  });
});

describe("music display authority", () => {
  it("cannot be mutated at runtime by consumers", () => {
    expect(Object.isFrozen(TIMBRES)).toBe(true);
    expect(Object.isFrozen(SYNTH_LIMITS)).toBe(true);
    expect(Object.isFrozen(INTERVAL_SHORT)).toBe(true);
    expect(Object.isFrozen(INTERVAL_LONG)).toBe(true);
    expect(Object.isFrozen(SCALE_PRESETS)).toBe(true);
    expect(Object.isFrozen(CHORD_PRESETS)).toBe(true);

    for (const preset of [...Object.values(SCALE_PRESETS), ...Object.values(CHORD_PRESETS)]) {
      expect(Object.isFrozen(preset)).toBe(true);
      expect(Object.isFrozen(preset.intervals)).toBe(true);
    }

    expect(() => (TIMBRES as unknown as string[]).push("noise")).toThrow(TypeError);
    expect(() => (INTERVAL_SHORT as string[])[0] = "corrupted").toThrow(TypeError);
  });
});
