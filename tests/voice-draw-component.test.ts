import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AudioInputProvider } from "../apps/web/src/audio/use-audio-input";
import { VoiceDraw } from "../apps/web/src/features/voice-arcade/VoiceDraw";
import type { ArcadeCurriculumStage } from "../apps/web/src/features/voice-arcade/types";

function renderVoiceDraw(curriculumStage: ArcadeCurriculumStage): string {
  return renderToStaticMarkup(createElement(
    AudioInputProvider,
    null,
    createElement(VoiceDraw, {
      difficulty: "medium",
      curriculumStage,
      voiceRange: { lowMidi: 43, highMidi: 55, baselineMidi: 48 },
      onExit: () => undefined,
      onComplete: () => undefined,
    }),
  ));
}

describe("Voice Draw rendered contracts", () => {
  it("renders a code-native voice cursor, all ordinary tools, and one explicit enable action", () => {
    const markup = renderVoiceDraw("deliberate");

    expect(markup).toContain("data-voice-draw");
    expect(markup).toContain('data-input-state="disabled"');
    expect(markup).toContain('data-cursor-x="0.5"');
    expect(markup).toContain('data-cursor-y="0.5"');
    expect(markup).toContain('data-observed-frame-count="0"');
    expect(markup).toContain('class="voice-draw-canvas"');
    expect(markup).toContain('aria-label="Voice drawing canvas"');
    expect(markup).not.toContain("<canvas");
    expect(markup).toContain("Free Draw");
    expect(markup).toContain("Trace");
    expect(markup).toContain("Puzzle");
    expect(markup).toContain("Brush");
    expect(markup).toContain("Eraser");
    expect(markup).toContain("Lift pen");
    expect(markup).toContain("Undo stroke");
    expect(markup).toContain("Reset cursor");
    expect(markup).toContain('type="color"');
    expect(markup).toContain('type="range"');
    expect(markup).toContain("Enable voice input");
    expect(markup.match(/class="voice-draw-direction/g)).toHaveLength(8);
    expect(markup).toContain("silence<br/>stop");
  });

  it("removes note-map and live-pitch coaching at the game-first curriculum stage", () => {
    const markup = renderVoiceDraw("background");

    expect(markup).not.toContain('class="voice-draw-compass"');
    expect(markup).not.toContain("Current command");
    expect(markup).not.toContain("from center");
    expect(markup).toContain("voice moves · silence stops");
  });
});
