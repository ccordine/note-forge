import { describe, expect, it } from "vitest";

import { createToneSequenceSchedule } from "../apps/web/src/audio/synth";

describe("tone sequence scheduling", () => {
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
});
