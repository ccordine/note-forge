import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const UI_SOURCE = readFileSync(new URL(
  "../apps/web/src/features/voice-arcade/PitchMaze.tsx",
  import.meta.url,
), "utf8");
const CONTROLLER_SOURCE = readFileSync(new URL(
  "../apps/web/src/features/voice-arcade/pitch-maze-controller.ts",
  import.meta.url,
), "utf8");
const SESSION_SOURCE = readFileSync(new URL(
  "../apps/web/src/features/voice-arcade/pitch-maze-session.ts",
  import.meta.url,
), "utf8");
const MODEL_SOURCE = readFileSync(new URL(
  "../apps/web/src/features/voice-arcade/pitch-maze-model.ts",
  import.meta.url,
), "utf8");
const CSS_SOURCE = readFileSync(new URL(
  "../apps/web/src/styles-pitch-maze.css",
  import.meta.url,
), "utf8");
const CABINET_SOURCE = readFileSync(new URL(
  "../apps/web/src/features/voice-arcade/VoiceArcade.tsx",
  import.meta.url,
), "utf8");
const ACTIVE_SOURCE = `${UI_SOURCE}\n${CONTROLLER_SOURCE}\n${SESSION_SOURCE}`;

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe("Pitch Maze continuous-input architecture guard", () => {
  it("keeps one readable cabinet with bounded React ownership", () => {
    const lineCount = UI_SOURCE.trimEnd().split(/\r?\n/).length;
    const aggregateHooks = count(UI_SOURCE, /\buse[A-Z]\w*\s*(?:<[^;()]*>)?\s*\(/g);
    expect(lineCount, `PitchMaze.tsx has ${lineCount} lines; limit is 600.`).toBeLessThanOrEqual(600);
    expect(aggregateHooks, `PitchMaze.tsx owns ${aggregateHooks} aggregate hooks; limit is 20.`).toBeLessThanOrEqual(20);
  });

  it("mounts one shared-input consumer and one canonical tuner", () => {
    expect(count(UI_SOURCE, /\buseAudioInput\s*\(/g)).toBe(1);
    expect(count(UI_SOURCE, /<NoteInput(?:\s|\/|>)/g)).toBe(1);
    expect(UI_SOURCE).toContain("useRealtimeSession(");
    expect(UI_SOURCE).toContain('onFrame: (observation) => realtime.observe({ type: "observation", observation })');
    expect(UI_SOURCE).not.toMatch(/\buseReducer\s*\(/);
    expect(UI_SOURCE).not.toMatch(/onFrame[^}]+(?:set[A-Z]\w*|\bdispatch)\s*\(/);
    expect(UI_SOURCE).not.toMatch(/\b(?:getUserMedia|AudioContext|createMediaStreamSource)\b/);
    expect(UI_SOURCE).not.toMatch(/\binput\.(?:disable|getStream|liveFrame)\b/);
    expect(UI_SOURCE).not.toMatch(/\b(?:capture|track|stream|input)\.stop\s*\(/);
  });

  it("derives availability from shared lifecycle without inventing a connecting phase", () => {
    expect(UI_SOURCE).toContain('input.state !== "running"');
    expect(SESSION_SOURCE).toContain('| "setup"');
    expect(SESSION_SOURCE).toContain('| "playing"');
    expect(SESSION_SOURCE).toContain('| "campaign-result"');
    expect(SESSION_SOURCE).not.toContain('| "level-result"');
    expect(ACTIVE_SOURCE).not.toMatch(/\bconnecting\b/i);
    expect(UI_SOURCE).not.toMatch(/await\s+input\.enable\s*\(/);
  });

  it("deletes workflow, preview gates, recovery pauses, and wall-clock scoring", () => {
    const forbidden = [
      /\bWorkflowDialog\b/,
      /\bWorkflowStage\b/,
      /\bworkflowOpen\b/,
      /\bscoringExcluded\w*\b/,
      /\bpreviewing\b/,
      /\bconnectionSlow\b/,
      /\bawaiting-release\b/,
      /\breleaseProgress\b/,
      /\breleaseDurationSeconds\b/,
      /\brearmed\b/,
      /\brequireRelease\w*\b/,
      /["']paused["']/,
      /\bsetTimeout\s*\(/,
      /\bsetInterval\s*\(/,
      /\bperformance\.now\s*\(/,
      /\bDate\.now\s*\(/,
    ] as const;
    for (const pattern of forbidden) expect(ACTIVE_SOURCE).not.toMatch(pattern);
  });

  it("keeps reference playback brief and state-neutral", () => {
    expect(UI_SOURCE).toContain("duration: 0.24");
    expect(UI_SOURCE).toContain("duration: 0.32");
    expect(UI_SOURCE).toContain("useSessionEffectScope");
    expect(UI_SOURCE).toContain("reference.playReference(");
    expect(UI_SOURCE).not.toContain("playSafely");
    expect(UI_SOURCE).not.toMatch(/\bActiveVoice\b|\bpromptVoice\w*\b|\bpromptTimer\w*\b/);
  });

  it("removes obsolete dialog and recovery selectors from the cabinet stylesheet", () => {
    expect(CSS_SOURCE).not.toMatch(/\.nf-workflow|pitch-maze-(?:workflow|connecting|connection-help)/);
    expect(CSS_SOURCE).not.toMatch(/pitch-maze-(?:breathe|releasing)/);
  });

  it("does not advertise the deleted re-arm workflow on the arcade cabinet", () => {
    expect(CABINET_SOURCE).not.toMatch(/\bre-?arm\b/i);
  });

  it("keeps Exit wired into both the stable shell and result surface", () => {
    expect(count(UI_SOURCE, /onClick=\{onExit\}/g)).toBe(2);
    expect(UI_SOURCE).toContain("onClick={exitGame}");
    expect(UI_SOURCE).toContain("onExit={exitGame}");
    expect(UI_SOURCE).toContain("reference.abort();");
  });

  it("latches maze achievements without ending the live campaign", () => {
    expect(UI_SOURCE).toContain('data-live-lifetime="user-owned"');
    expect(UI_SOURCE).toContain('data-live-achievement="pitch-maze"');
    expect(SESSION_SOURCE).toContain('phase: "playing"');
    expect(SESSION_SOURCE).toContain("A cleared maze is a latched achievement inside the still-live campaign");
    expect(SESSION_SOURCE).toContain("achievementOutcome: ArcadeOutcome | null");
    expect(SESSION_SOURCE.indexOf("const campaignMetrics = recordCommandMetrics"))
      .toBeLessThan(SESSION_SOURCE.indexOf("if (state.currentResult !== null)"));
    expect(SESSION_SOURCE).not.toContain("outcome: state.outcome ?? campaignOutcome");
    expect(SESSION_SOURCE).toContain('case "finish":');
    expect(SESSION_SOURCE).not.toMatch(/phase:\s*campaignComplete\s*\?/);
    expect(MODEL_SOURCE).not.toContain("if (level.levelComplete)");
    expect(UI_SOURCE).toContain('session.phase === "campaign-result" ? session.outcome : null');
  });

  it("offers Finish throughout play and freezes motion until a new explicit Start", () => {
    expect(UI_SOURCE).toContain("Finish campaign");
    expect(UI_SOURCE).toContain("Start another campaign");
    expect(UI_SOURCE).toContain('session.phase === "campaign-result" ? "complete" : "listening"');
    expect(SESSION_SOURCE).toContain('if (state.phase !== "playing" || state.campaign === null)');
    expect(SESSION_SOURCE).toContain('phase: "campaign-result"');
    expect(SESSION_SOURCE).toContain("lastObservedAtSeconds");
  });
});
