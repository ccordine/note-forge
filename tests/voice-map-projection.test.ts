import { describe, expect, it } from "vitest";
import { voiceMapYForMidi } from "../apps/web/src/features/harmony/VoiceLeadingActivity";

describe("Harmony voice-map projection", () => {
  it("keeps every authored pitch and node inside the SVG", () => {
    const coordinates = Array.from({ length: 33 }, (_unused, index) => (
      voiceMapYForMidi(44 + index)
    ));

    expect(coordinates[0]).toBe(336);
    expect(coordinates.at(-1)).toBe(24);
    coordinates.slice(1).forEach((coordinate, index) => {
      expect(coordinate).toBeLessThan(coordinates[index]!);
    });
    expect(Math.min(...coordinates) - 18).toBeGreaterThanOrEqual(0);
    expect(Math.max(...coordinates) + 18).toBeLessThanOrEqual(360);
  });

  it("rejects values outside the authored voicing range", () => {
    expect(() => voiceMapYForMidi(43.99)).toThrow(RangeError);
    expect(() => voiceMapYForMidi(76.01)).toThrow(RangeError);
  });
});
