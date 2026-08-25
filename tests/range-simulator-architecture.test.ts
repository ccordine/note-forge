import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIRECTORY = new URL("../apps/web/src/features/range-simulator/", import.meta.url);
const UI_SOURCE = readFileSync(new URL("RangeSimulator.tsx", DIRECTORY), "utf8");
const CONTROLLER_SOURCE = readFileSync(new URL("controller.ts", DIRECTORY), "utf8");
const HOOK_SOURCE = readFileSync(new URL("use-range-simulator.ts", DIRECTORY), "utf8");
const MODEL_SOURCE = readFileSync(new URL("model.ts", DIRECTORY), "utf8");
const SUMMARY_SOURCE = readFileSync(new URL("summary.ts", DIRECTORY), "utf8");
const CSS_SOURCE = readFileSync(new URL("../../styles-range-simulator.css", DIRECTORY), "utf8");
const ACTIVE_SOURCE = `${UI_SOURCE}\n${CONTROLLER_SOURCE}\n${HOOK_SOURCE}`;

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe("Range Simulator continuous-input architecture guard", () => {
  it("keeps every implementation boundary below the component release limit", () => {
    for (const [name, source] of [
      ["RangeSimulator.tsx", UI_SOURCE],
      ["controller.ts", CONTROLLER_SOURCE],
      ["use-range-simulator.ts", HOOK_SOURCE],
      ["model.ts", MODEL_SOURCE],
      ["summary.ts", SUMMARY_SOURCE],
    ] as const) {
      const lines = source.trimEnd().split(/\r?\n/).length;
      expect(lines, `${name} has ${lines} lines; limit is 600.`).toBeLessThanOrEqual(600);
    }
  });

  it("has one app-stream subscription and one stable canonical tuner", () => {
    expect(count(ACTIVE_SOURCE, /\buseAudioInput\s*\(/g)).toBe(1);
    expect(count(UI_SOURCE, /<NoteInput(?:\s|\/|>)/g)).toBe(1);
    expect(HOOK_SOURCE).toContain("useRealtimeSession(");
    expect(HOOK_SOURCE).toContain('onFrame: (observation) => realtime.observe({ type: "observation", observation })');
    expect(HOOK_SOURCE).not.toMatch(/\buseReducer\s*\(/);
    expect(HOOK_SOURCE).not.toMatch(/onFrame[^}]+(?:set[A-Z]\w*|\bdispatch)\s*\(/);
    expect(ACTIVE_SOURCE).not.toMatch(/\binput\.(?:disable|getStream|liveFrame|frames)\b/);
    expect(ACTIVE_SOURCE).not.toMatch(/\b(?:capture|track|stream|input)\.stop\s*\(/);
  });

  it("deletes modal, prompt, reconnect, and mirrored attempt lifecycle machinery", () => {
    const forbidden = [
      /\bWorkflowDialog\b/,
      /\bAttemptPhase\b/,
      /\bworkflowStarted\b/,
      /\brangeProposalAccepted\b/,
      /\bautoPromptNext\w*\b/,
      /\bguideTimer\w*\b/,
      /\bdeferredAttemptTimer\w*\b/,
      /\battemptActive\w*\b/,
      /\battemptTask\w*\b/,
      /\bconnecting\b/i,
      /\breconnect/i,
      /\bsetTimeout\s*\(/,
      /\bsetInterval\s*\(/,
      /\bperformance\.now\s*\(/,
      /\bDate\.now\s*\(/,
    ] as const;
    for (const pattern of forbidden) expect(ACTIVE_SOURCE).not.toMatch(pattern);
  });

  it("uses a brief state-neutral reference and never invokes capture for playback", () => {
    expect(HOOK_SOURCE).toContain("duration: BRIEF_REFERENCE_SECONDS");
    expect(HOOK_SOURCE).toContain("playReference(\"Range Simulator reference tone\"");
    expect(HOOK_SOURCE).not.toMatch(/\bActiveVoice\b|\bpromptVoice\w*\b|\bpromptTimer\w*\b/);
    expect(HOOK_SOURCE).not.toMatch(/\binput\.(?:enable|disable|getStream)\s*\(/);
  });

  it("keeps the state model to idle, tracking, and complete", () => {
    expect(CONTROLLER_SOURCE).toContain('export type RangeSimulatorStatus = "idle" | "tracking" | "complete";');
    expect(CONTROLLER_SOURCE).not.toMatch(/["'](?:ready|prompting|rating|listening|paused)["']/);
  });

  it("makes probe achievement nonterminal and keeps the canonical tuner live until Finish", () => {
    expect(UI_SOURCE).toContain('data-live-lifetime="user-owned"');
    expect(UI_SOURCE).toContain('data-live-achievement="range-map"');
    expect(CONTROLLER_SOURCE).toContain('status: "tracking"');
    expect(CONTROLLER_SOURCE).toContain("Exhausting the probe queue records an assessment achievement");
    expect(CONTROLLER_SOURCE).not.toMatch(/status:\s*achievementReached\s*\?\s*["']complete["']/);
  });

  it("deletes the stylesheet dump and obsolete workflow selectors", () => {
    const lines = CSS_SOURCE.trimEnd().split(/\r?\n/).length;
    expect(lines, `styles-range-simulator.css has ${lines} lines; limit is 600.`).toBeLessThanOrEqual(600);
    expect(CSS_SOURCE).not.toMatch(/range-sim-(?:workflow|modal|proposal|prompt|setup-contract|listening-actions)/);
  });
});
