import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ToneMapKeyboard,
  type ToneMapKeyboardProps,
} from "../apps/web/src/features/ear-training/ToneMapKeyboard";
import {
  PianoKeyboardViewport,
  type PianoKeyboardViewportProps,
} from "../apps/web/src/ui/PianoKeyboard";

function keyMarkup(markup: string, midi: number): string {
  const coordinate = `data-midi="${midi}"`;
  const coordinateIndex = markup.indexOf(coordinate);
  if (coordinateIndex < 0) throw new Error(`Missing MIDI ${midi} key.`);
  const buttonStart = markup.lastIndexOf("<button", coordinateIndex);
  const buttonEnd = markup.indexOf("</button>", coordinateIndex);
  if (buttonStart < 0 || buttonEnd < 0) throw new Error(`Malformed MIDI ${midi} key.`);
  return markup.slice(buttonStart, buttonEnd + "</button>".length);
}

function viewportElement(
  element: ReactElement<{ readonly children?: ReactNode }>,
): ReactElement<PianoKeyboardViewportProps> {
  const viewport = Children.toArray(element.props.children).find(
    (child) => isValidElement(child) && child.type === PianoKeyboardViewport,
  );
  if (!isValidElement<PianoKeyboardViewportProps>(viewport)) {
    throw new Error("Tone Map keyboard did not render the canonical viewport.");
  }
  return viewport;
}

describe("ToneMapKeyboard", () => {
  it("renders the identical labeled 88-key answer surface for every hidden target", () => {
    const baseProps = {
      answerMidi: null,
      onAnswer: () => undefined,
    } satisfies Omit<ToneMapKeyboardProps, "targetMidi">;
    const lowTarget = renderToStaticMarkup(
      createElement(ToneMapKeyboard, { ...baseProps, targetMidi: 24 }),
    );
    const highTarget = renderToStaticMarkup(
      createElement(ToneMapKeyboard, { ...baseProps, targetMidi: 101 }),
    );

    expect(lowTarget).toBe(highTarget);
    expect(lowTarget.match(/data-midi=/gu)).toHaveLength(88);
    expect(lowTarget.match(/piano-keyboard__label/gu)).toHaveLength(88);
    expect(lowTarget).toContain("A0");
    expect(lowTarget).toContain("C4");
    expect(lowTarget).toContain("C8");
    expect(lowTarget).not.toContain("data-marker-role");
    expect(lowTarget).not.toContain("tone-map-keyboard__legend");
    expect(lowTarget).not.toMatch(/data-target|target-midi/iu);
  });

  it("forwards the exact selected MIDI through the canonical keyboard callback", () => {
    const onAnswer = vi.fn();
    const element = ToneMapKeyboard({
      targetMidi: 61,
      answerMidi: null,
      onAnswer,
    }) as ReactElement<{ readonly children?: ReactNode }>;
    const viewport = viewportElement(element);

    viewport.props.onKeyPress?.(21);
    viewport.props.onKeyPress?.(61);
    viewport.props.onKeyPress?.(108);
    expect(onAnswer.mock.calls).toEqual([[21], [61], [108]]);
    expect(viewport.props.startMidi).toBe(21);
    expect(viewport.props.endMidi).toBe(108);
    expect(viewport.props.showLabels).toBe(true);
    expect(viewport.props.markers).toEqual([]);
  });

  it("reveals a wrong answer and the target only after submission", () => {
    const markup = renderToStaticMarkup(
      createElement(ToneMapKeyboard, {
        targetMidi: 61,
        answerMidi: 60,
        onAnswer: () => undefined,
      }),
    );

    expect(markup).toContain("piano-keyboard__label");
    expect(keyMarkup(markup, 60)).toContain('data-marker-role="wrong"');
    expect(keyMarkup(markup, 60)).not.toContain('data-marker-role="target"');
    expect(keyMarkup(markup, 61)).toContain('data-marker-role="target"');
    expect(markup).not.toContain('data-marker-role="guess"');
    expect(markup).toContain("Your answer");
    expect(markup).toContain("Target");
    expect(markup.match(/ disabled=""/gu)).toHaveLength(88);
  });

  it("places correct-answer and target evidence on the same reviewed key", () => {
    const markup = renderToStaticMarkup(
      createElement(ToneMapKeyboard, {
        targetMidi: 61,
        answerMidi: 61,
        onAnswer: () => undefined,
      }),
    );
    const answeredKey = keyMarkup(markup, 61);

    expect(answeredKey).toContain('data-marker-role="guess"');
    expect(answeredKey).toContain('data-marker-role="target"');
    expect(answeredKey).not.toContain('data-marker-role="wrong"');
  });
});
