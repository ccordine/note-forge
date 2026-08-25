import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const COMPONENT_URL = new URL(
  "../apps/web/src/features/voice-arcade/PatternChallenge.tsx",
  import.meta.url,
);
const CONTROLLER_URL = new URL(
  "../apps/web/src/features/voice-arcade/pattern-challenge-controller.ts",
  import.meta.url,
);
const component = readFileSync(COMPONENT_URL, "utf8");
const controller = readFileSync(CONTROLLER_URL, "utf8");

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe("Pattern Challenge continuous-input architecture guard", () => {
  it("keeps exactly one canonical NoteInput mounted above the workflow surface", () => {
    expect(count(component, /<NoteInput(?:\s|\/|>)/g)).toBe(1);
    expect(component.indexOf("<NoteInput")).toBeLessThan(component.indexOf("<PatternSurface"));
    expect(component).not.toContain('variant="scope"');
  });

  it("has no connecting phase, headphone blocker, release gate, or feature watchdog", () => {
    for (const forbidden of [
      /\bconnecting\b/i,
      /\bheadphonesConfirmed\b/,
      /\bscoringArmed\b/,
      /\boriginFrameTime\b/,
      /\bframeAge\b/,
      /\bsetTimeout\b/,
      /\bsetInterval\b/,
      /\bperformance\.now\b/,
      /\bDate\.now\b/,
    ]) expect(component).not.toMatch(forbidden);
  });

  it("never disables, stops, reopens, or phase-hides the shared input", () => {
    expect(component).not.toMatch(/\binput\.(?:enable|disable|getStream)\b/);
    expect(component).not.toMatch(/\b(?:capture|track|stream|input)\.stop\s*\(/);
    expect(component).not.toMatch(/phase[^\n]+input\.liveFrame|input\.liveFrame[^\n]+phase/);
  });

  it("uses a pure sample-coordinate controller instead of callback or wall-clock time", () => {
    expect(controller).toContain("observationContinuity(state.clock?.authority ?? null, observation)");
    expect(controller).toContain("continuity.deltaSeconds");
    expect(controller).toContain("continuity.contiguous");
    expect(controller).not.toMatch(/observation\.timeSeconds|performance\.now|Date\.now|requestAnimationFrame|setTimeout/);
  });

  it("projects full detector depth and removes the live marker on silence with exact sample identity", () => {
    expect(component).toContain("pitchMeterPositionPercent(");
    expect(component).toContain("liveMidi !== null && liveY !== null");
    expect(component).not.toContain('echo-voice-cursor ${liveMidi === null ? "silent"');
    for (const attribute of [
      "data-start-sample",
      "data-end-sample",
      "data-processed-sample-count",
      "data-worklet-process-count",
      "data-capture-epoch",
      "data-continuity-epoch",
      "data-graph-generation",
    ]) expect(component).toContain(attribute);
  });

  it("keeps phrase achievement inside the live stage and reserves results for explicit Stop", () => {
    expect(component).toContain('data-live-lifetime="user-owned"');
    expect(component).toContain('data-phrase-achieved={phraseAchieved ? "true" : "false"}');
    expect(controller).toContain("A phrase is a repeatable milestone inside one user-owned run");
    expect(controller).toContain("scoreAggregate: foldPhraseScore(state.scoreAggregate, session)");
    expect(controller).toContain("session: nextPhraseSession(state, elapsedSeconds)");
    expect(controller).not.toMatch(/session\.status\s*===\s*["']complete["']\s*\?\s*finishPatternChallenge/);
    expect(controller).toContain('case "stop":');
    expect(controller).toContain("? finishPatternChallenge(state, state.session)");
    expect(controller).toContain('return state.phase === "preview" || state.phase === "result"');
    expect(controller).toContain('return state.phase === "result"');
  });

  it("keeps the component and mutable React ownership bounded", () => {
    expect(component.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(600);
    expect(controller.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(600);
    expect(count(component, /\buse(?:State|Ref|Effect)\s*(?:<[^;()]*>)?\s*\(/g)).toBeLessThanOrEqual(20);
    const presentation = component.slice(component.indexOf("export function PatternChallenge"));
    expect(presentation.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(150);
  });
});
