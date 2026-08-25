import { describe, expect, it } from "vitest";
import {
  createToneMapCourse,
  setToneMapProductionEligibility,
} from "../apps/web/src/features/ear-training/tone-map-model";
import {
  applyToneMapProductionProfile,
} from "../apps/web/src/features/ear-training/tone-map-production-profile";
import { isToneMapProductionMidiSupported } from "../apps/web/src/features/ear-training/tone-map-production-range";

describe("tone-map production profile", () => {
  it("keeps all 88 keys recognizable while hard-excluding unsupported vocal MIDI", () => {
    const course = applyToneMapProductionProfile(createToneMapCourse("bounds"), undefined);

    expect(isToneMapProductionMidiSupported(29)).toBe(false);
    expect(isToneMapProductionMidiSupported(30)).toBe(true);
    expect(isToneMapProductionMidiSupported(86)).toBe(true);
    expect(isToneMapProductionMidiSupported(87)).toBe(false);
    expect(course.tones[21]!.productionEligibility).toBe("unreachable");
    expect(course.tones[29]!.productionEligibility).toBe("unreachable");
    expect(course.tones[30]!.productionEligibility).toBe("unassessed");
    expect(course.tones[86]!.productionEligibility).toBe("unassessed");
    expect(course.tones[87]!.productionEligibility).toBe("unreachable");
    expect(course.tones[108]!.productionEligibility).toBe("unreachable");
    expect(course.tones[21]!.identification.attempts).toBe(0);
    expect(Object.keys(course.tones)).toHaveLength(88);
  });

  it("uses demonstrated bounds only for unassessed in-detector notes", () => {
    let course = createToneMapCourse("profile");
    course = setToneMapProductionEligibility(course, 55, "unreachable");
    const profiled = applyToneMapProductionProfile(course, {
      baseline: { midi: 54, source: "manual", updatedAt: "2026-08-25T12:00:00.000Z" },
      usableMidis: [48, 60],
      registerShifts: [],
    });

    expect(profiled.tones[47]!.productionEligibility).toBe("unreachable");
    expect(profiled.tones[48]!.productionEligibility).toBe("reachable");
    expect(profiled.tones[55]!.productionEligibility).toBe("unreachable");
    expect(profiled.tones[60]!.productionEligibility).toBe("reachable");
    expect(profiled.tones[61]!.productionEligibility).toBe("unreachable");
  });
});
