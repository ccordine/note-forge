import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PianoKeyboard, buildPianoKeyLayout } from "../apps/web/src/ui/PianoKeyboard";

describe("PianoKeyboard layout", () => {
  it("lays out one C-to-B note family without adding the next octave's C", () => {
    const layout = buildPianoKeyLayout(48, 59);

    expect(layout.map((key) => key.midi)).toEqual([
      48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59
    ]);
    expect(layout.filter((key) => key.kind === "white")).toHaveLength(7);
    expect(layout.at(-1)?.midi).toBe(59);
  });

  it("positions black keys at boundaries between the seven white keys", () => {
    const blackKeys = buildPianoKeyLayout(48, 59).filter((key) => key.kind === "black");
    const expectedPositions = [
      100 / 7,
      200 / 7,
      400 / 7,
      500 / 7,
      600 / 7
    ];

    blackKeys.forEach((key, index) => {
      expect(key.leftPercent).toBeCloseTo(expectedPositions[index]!, 10);
    });
  });

  it("rejects reversed, fractional, and visually clipped black-key bounds", () => {
    expect(() => buildPianoKeyLayout(60, 59)).toThrow(RangeError);
    expect(() => buildPianoKeyLayout(48.5, 59)).toThrow(TypeError);
    expect(() => buildPianoKeyLayout(49, 49)).toThrow(RangeError);
    expect(() => buildPianoKeyLayout(49, 59)).toThrow(RangeError);
    expect(() => buildPianoKeyLayout(48, 58)).toThrow(RangeError);
  });

  it("renders overlapping caller-supplied roles without inventing a target", () => {
    const hiddenAnswer = renderToStaticMarkup(
      createElement(PianoKeyboard, {
        startMidi: 48,
        endMidi: 59,
        markers: [
          { midi: 53, role: "anchor", label: "starting tone" },
          { midi: 53, role: "guess", label: "your answer" },
        ]
      })
    );

    expect(hiddenAnswer).toContain('data-marker-role="anchor"');
    expect(hiddenAnswer).toContain('data-marker-role="guess"');
    expect(hiddenAnswer).toContain("starting tone, your answer");
    expect(hiddenAnswer).not.toContain('data-marker-role="target"');

    const revealedAnswer = renderToStaticMarkup(
      createElement(PianoKeyboard, {
        startMidi: 48,
        endMidi: 59,
        markers: [
          { midi: 53, role: "anchor" },
          { midi: 53, role: "target" },
        ]
      })
    );

    expect(revealedAnswer).toContain('data-marker-role="anchor"');
    expect(revealedAnswer).toContain('data-marker-role="target"');
  });
});
