import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const UI_URL = new URL("../apps/web/src/features/voice-arcade/Resonance.tsx", import.meta.url);
const SESSION_URL = new URL("../apps/web/src/features/voice-arcade/resonance-session.ts", import.meta.url);
const CONTROLLER_URL = new URL("../apps/web/src/features/voice-arcade/resonance-controller.ts", import.meta.url);
const PHYSICS_URL = new URL("../apps/web/src/features/voice-arcade/resonance-physics.ts", import.meta.url);
const TYPES_URL = new URL("../apps/web/src/features/voice-arcade/resonance-types.ts", import.meta.url);
const VOICE_URL = new URL("../apps/web/src/features/voice-arcade/resonance-voice.ts", import.meta.url);
const WORLD_URL = new URL("../apps/web/src/features/voice-arcade/resonance-world.ts", import.meta.url);
const FIELD_URL = new URL("../apps/web/src/features/voice-arcade/resonance-field.ts", import.meta.url);
const CSS_URL = new URL("../apps/web/src/styles-resonance.css", import.meta.url);
const CABINET_URL = new URL("../apps/web/src/features/voice-arcade/VoiceArcade.tsx", import.meta.url);

const UI_SOURCE = readFileSync(UI_URL, "utf8");
const SESSION_SOURCE = readFileSync(SESSION_URL, "utf8");
const CONTROLLER_SOURCE = readFileSync(CONTROLLER_URL, "utf8");
const PHYSICS_SOURCE = readFileSync(PHYSICS_URL, "utf8");
const TYPES_SOURCE = readFileSync(TYPES_URL, "utf8");
const VOICE_SOURCE = readFileSync(VOICE_URL, "utf8");
const WORLD_SOURCE = readFileSync(WORLD_URL, "utf8");
const FIELD_SOURCE = readFileSync(FIELD_URL, "utf8");
const CSS_SOURCE = readFileSync(CSS_URL, "utf8");
const CABINET_SOURCE = readFileSync(CABINET_URL, "utf8");
const ACTIVE_SOURCE = `${UI_SOURCE}\n${SESSION_SOURCE}\n${CONTROLLER_SOURCE}`;

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function lineCount(source: string): number {
  return source.trimEnd().split(/\r?\n/).length;
}

describe("Resonance continuous-input architecture guard", () => {
  it("keeps presentation and executable modules below release limits", () => {
    expect(lineCount(UI_SOURCE)).toBeLessThanOrEqual(600);
    for (const source of [PHYSICS_SOURCE, TYPES_SOURCE, VOICE_SOURCE, WORLD_SOURCE]) {
      expect(lineCount(source)).toBeLessThanOrEqual(600);
    }
    expect(lineCount(FIELD_SOURCE)).toBeLessThanOrEqual(600);
    expect(count(UI_SOURCE, /\buse[A-Z]\w*\s*(?:<[^;()]*>)?\s*\(/g)).toBeLessThanOrEqual(20);
  });

  it("mounts exactly one shared-input consumer and one stable tuner", () => {
    expect(count(UI_SOURCE, /\buseAudioInput\s*\(/g)).toBe(1);
    expect(count(UI_SOURCE, /<NoteInput(?:\s|\/|>)/g)).toBe(1);
    expect(UI_SOURCE.indexOf("<NoteInput")).toBeLessThan(UI_SOURCE.indexOf("<ResonanceResultPanel"));
    expect(UI_SOURCE).not.toMatch(/\b(?:getUserMedia|AudioContext|createMediaStreamSource)\b/);
    expect(UI_SOURCE).not.toMatch(/\binput\.(?:disable|getStream|liveFrame)\b/);
    expect(UI_SOURCE).not.toMatch(/\b(?:capture|track|stream|input)\.stop\s*\(/);
  });

  it("deletes the old workflow, hard gate, prompt exclusion, and wall-clock controller", () => {
    const forbidden = [
      /\bWorkflowDialog\b/,
      /\bWorkflowStage\b/,
      /\bconnecting\b/i,
      /\bscoringExcluded\w*\b/,
      /\breferenceRelease\w*\b/,
      /\bvisibilityPaused\w*\b/,
      /\bconnectionSlow\w*\b/,
      /\bActiveVoice\b/,
      /\bsetTimeout\s*\(/,
      /\bsetInterval\s*\(/,
      /\brequestAnimationFrame\s*\(/,
      /\bperformance\.now\s*\(/,
      /\bDate\.now\s*\(/,
      /\bstale\b/i,
      /\breleasing\b/i,
      /\breferenceLocked\b/,
      /\bminimumConfidence\b/i,
    ] as const;
    for (const pattern of forbidden) expect(ACTIVE_SOURCE).not.toMatch(pattern);
  });

  it("makes the chamber primary and the tutorial an optional native disclosure", () => {
    expect(UI_SOURCE).toContain("Start chamber");
    expect(UI_SOURCE).toContain("Optional guide · how the field works");
    expect(UI_SOURCE).toContain("<details className=\"resonance-guide\">");
    expect(UI_SOURCE.indexOf("Start chamber")).toBeLessThan(UI_SOURCE.indexOf("<ResonanceGuide"));
    expect(CABINET_SOURCE).not.toMatch(/Field School|12 FIELD|resonanceTutorial|tutorialProgress/);
  });

  it("advances only from exact PCM hops and treats gaps as fresh authority", () => {
    expect(SESSION_SOURCE).toContain("frame.endSample - previous.endSample");
    expect(SESSION_SOURCE).toContain("Math.round(frame.sampleRate * ANALYSIS_HOP_SECONDS)");
    expect(SESSION_SOURCE).toContain("if (delta !== expectedHop) return { samples: 0, boundary: true }");
    expect(SESSION_SOURCE).toContain("delta.samples / observation.sampleRate");
    expect(SESSION_SOURCE).not.toMatch(/performance|Date\.now|requestAnimationFrame/);
  });

  it("keeps references brief and state-neutral", () => {
    expect(UI_SOURCE).toContain("const REFERENCE_SECONDS = 0.32");
    expect(UI_SOURCE).toContain("useSessionEffectScope");
    expect(UI_SOURCE).toContain("reference.playReference(");
    expect(UI_SOURCE).not.toContain("playSafely");
    expect(UI_SOURCE).not.toMatch(/prompt|exclude|releaseRequired|previewing/i);
  });

  it("removes obsolete tutorial-only product modules and selectors", () => {
    for (const filename of [
      "ResonanceTutorialUI.tsx",
      "resonance-tutorial.ts",
      "resonance-tutorial-progress.ts",
      "resonance-tutorial-view.ts",
    ]) {
      expect(existsSync(new URL(`../apps/web/src/features/voice-arcade/${filename}`, import.meta.url)))
        .toBe(false);
    }
    expect(CSS_SOURCE).not.toMatch(/resonance-(?:tutorial|connecting|combined-lock|microphone-retained)/);
  });
});
