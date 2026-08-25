import { describe, expect, it } from "vitest";
import {
  SOUND_LAB_MAXIMUM_MIDI,
  SOUND_LAB_MINIMUM_MIDI,
  SOUND_LAB_SLIDER_MAXIMUM,
  soundLabPitch,
  soundLabSliderValue,
} from "../apps/web/src/features/sound-lab/sound-lab-pitch";
import { nearestNoteCentsPositionPercent } from "../apps/web/src/lib/music-display";

describe("Sound Lab pitch coordinates", () => {
  it("moves the nearest-note marker across the complete cents track", () => {
    const cents = Array.from({ length: 101 }, (_unused, index) => index - 50);
    const positions = cents.map(nearestNoteCentsPositionPercent);

    expect(positions[0]).toBe(0);
    expect(positions[50]).toBe(50);
    expect(positions[100]).toBe(100);
    positions.slice(1).forEach((position, index) => {
      expect(position).toBeGreaterThan(positions[index]!);
    });
    expect(new Set(positions).size).toBe(101);
  });

  it("rejects out-of-domain cents instead of aliasing them onto an edge", () => {
    expect(() => nearestNoteCentsPositionPercent(Number.NaN)).toThrow(TypeError);
    expect(() => nearestNoteCentsPositionPercent(-50.01)).toThrow(RangeError);
    expect(() => nearestNoteCentsPositionPercent(50.01)).toThrow(RangeError);
  });

  it("keeps every editor action and slider on one C2-through-C6 authority", () => {
    expect(soundLabPitch(SOUND_LAB_MINIMUM_MIDI, -1).midiFloat)
      .toBe(SOUND_LAB_MINIMUM_MIDI);
    expect(soundLabPitch(SOUND_LAB_MAXIMUM_MIDI, 1).midiFloat)
      .toBe(SOUND_LAB_MAXIMUM_MIDI);
    expect(soundLabSliderValue(SOUND_LAB_MINIMUM_MIDI, 0)).toBe(0);
    expect(soundLabSliderValue(SOUND_LAB_MAXIMUM_MIDI, 0))
      .toBe(SOUND_LAB_SLIDER_MAXIMUM);
    expect(soundLabPitch(60, 25)).toMatchObject({
      nearestMidi: 60,
      centsFromNearest: 25,
      midiFloat: 60.25,
    });
  });
});
