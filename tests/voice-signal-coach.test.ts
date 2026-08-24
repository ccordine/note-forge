import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  VoiceSignalCoach,
  type VoiceSignalCoachProps,
} from "../apps/web/src/ui/voice/VoiceSignalCoach";

function render(props: VoiceSignalCoachProps): string {
  return renderToStaticMarkup(createElement(VoiceSignalCoach, props));
}

describe("target-free voice signal coach", () => {
  it("reports the detected note and scalar evidence without inventing a pitch target", () => {
    const markup = render({
      inputState: "running",
      midiFloat: 48.12,
      frequencyHz: 131.73,
      reliable: true,
      relativeLevel: .58,
      stability: .73,
      coherence: .64,
      emphasis: "stability",
      state: "responding",
      guidanceTitle: "Make the beam steadier",
      guidanceDetail: "Pitch location is visible for orientation, but it is not graded in this lesson.",
    });

    expect(markup).toContain("MEASURED VOICE · NO PITCH TARGET");
    expect(markup).toContain(">C3<");
    expect(markup).toContain("131.73 Hz");
    expect(markup.match(/role="meter"/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="pitch stability"');
    expect(markup).not.toContain("CURRENT TARGET");
    expect(markup).not.toContain("nf-voice-lane");
  });

  it("does not retain a stale note when evidence is unreliable", () => {
    const markup = render({
      inputState: "running",
      midiFloat: 48,
      frequencyHz: 130.81,
      reliable: false,
      relativeLevel: 0,
      stability: 0,
      coherence: 0,
      emphasis: "level",
      state: "waiting",
      guidanceTitle: "Make a comfortable voiced sound",
      guidanceDetail: "The room begins responding when fresh reliable evidence arrives.",
    });

    expect(markup).not.toContain(">C3<");
    expect(markup).toContain("waiting for periodic voice evidence");
    expect(markup).toContain('aria-valuenow="0"');
  });

  it("can expose only the causal axis selected by an isolated lesson", () => {
    const markup = render({
      inputState: "running",
      midiFloat: 48,
      frequencyHz: 130.81,
      reliable: true,
      relativeLevel: .52,
      stability: .91,
      coherence: .86,
      emphasis: "level",
      visibleAxes: ["level"],
      state: "responding",
      guidanceTitle: "Relative energy 52%",
      guidanceDetail: "Only force changes in this puzzle.",
    });

    expect(markup.match(/role="meter"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="relative energy"');
    expect(markup).not.toContain('aria-label="pitch stability"');
    expect(markup).not.toContain('aria-label="coherence"');
  });

  it("shows the real microphone error and blanks stale signal evidence", () => {
    const markup = render({
      inputState: "error",
      inputError: "No capture device",
      midiFloat: 48,
      frequencyHz: 130.81,
      reliable: true,
      relativeLevel: .9,
      stability: .9,
      coherence: .9,
      emphasis: "level",
      state: "responding",
      guidanceTitle: "Stale exercise guidance",
      guidanceDetail: "This must not mask input failure.",
    });

    expect(markup).toContain("MICROPHONE ERROR");
    expect(markup).toContain("Microphone unavailable");
    expect(markup).toContain("No capture device");
    expect(markup).not.toContain(">C3<");
    expect(markup).not.toContain("Stale exercise guidance");
    expect(markup).not.toContain('role="meter"');
  });
});
