import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import {
  PIANO_KEYBOARD_MINIMUM_WHITE_KEY_WIDTH_PX,
  PianoKeyboard,
  PianoKeyboardViewport,
  buildPianoKeyLayout,
} from "../apps/web/src/ui/PianoKeyboard";

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

  it("lays out every key on a physical 88-key piano", () => {
    const layout = buildPianoKeyLayout(21, 108);

    expect(layout).toHaveLength(88);
    expect(layout[0]).toMatchObject({ midi: 21, kind: "white" });
    expect(layout.at(-1)).toMatchObject({ midi: 108, kind: "white" });
    expect(layout.filter((key) => key.kind === "white")).toHaveLength(52);
    expect(layout.filter((key) => key.kind === "black")).toHaveLength(36);
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

  it("renders the full keyboard in a focusable width-contained scroll viewport", () => {
    const markup = renderToStaticMarkup(
      createElement(PianoKeyboardViewport, {
        startMidi: 21,
        endMidi: 108,
        onKeyPress: () => undefined,
        viewportAriaLabel: "Full-range answer keyboard",
      }),
    );
    const minimumKeyboardWidth = 52 * PIANO_KEYBOARD_MINIMUM_WHITE_KEY_WIDTH_PX + 14;

    expect(markup).toContain('class="piano-keyboard-scroll"');
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Full-range answer keyboard"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('data-piano-keyboard-viewport="true"');
    expect(markup).toContain('data-white-key-count="52"');
    expect(markup).toContain(`--piano-scroll-minimum-width:${minimumKeyboardWidth}px`);
    expect(markup.match(/data-midi=/g)).toHaveLength(88);
    expect(markup).not.toContain('piano-keyboard__label');
    expect(markup).not.toContain('data-marker-role="target"');
  });

  it("contains horizontal pan and overscroll at the shared viewport boundary", () => {
    const styles = readFileSync(
      new URL("../apps/web/src/ui/PianoKeyboard.css", import.meta.url),
      "utf8",
    );
    const viewportRule = styles.match(/\.piano-keyboard-scroll\s*\{([^}]*)\}/u)?.[1] ?? "";
    const keyboardRule = styles.match(
      /\.piano-keyboard-scroll\s*>\s*\.piano-keyboard--scrollable\s*\{([^}]*)\}/u,
    )?.[1] ?? "";

    expect(viewportRule).toMatch(/max-width:\s*100%/u);
    expect(viewportRule).toMatch(/min-width:\s*0/u);
    expect(viewportRule).toMatch(/overflow-x:\s*auto/u);
    expect(viewportRule).toMatch(/overscroll-behavior-x:\s*contain/u);
    expect(viewportRule).toMatch(/touch-action:\s*pan-x/u);
    expect(keyboardRule).toMatch(/min-width:\s*var\(--piano-scroll-minimum-width\)/u);
  });
});
