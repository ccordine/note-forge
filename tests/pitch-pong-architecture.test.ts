import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PITCH_PONG_URL = new URL(
  "../apps/web/src/features/voice-arcade/PitchPong.tsx",
  import.meta.url,
);
const PITCH_PONG_SOURCE = readFileSync(PITCH_PONG_URL, "utf8");
const PITCH_PONG_HOOK = readFileSync(new URL(
  "../apps/web/src/features/voice-arcade/use-pitch-pong.ts",
  import.meta.url,
), "utf8");
const PITCH_PONG_RUNTIME = readFileSync(new URL(
  "../apps/web/src/features/voice-arcade/pitch-pong-runtime.ts",
  import.meta.url,
), "utf8");
const PITCH_PONG_SESSION = readFileSync(new URL(
  "../apps/web/src/features/voice-arcade/pitch-pong-session.ts",
  import.meta.url,
), "utf8");
const PONG_IMPLEMENTATION = [
  PITCH_PONG_SOURCE,
  PITCH_PONG_HOOK,
  PITCH_PONG_RUNTIME,
  PITCH_PONG_SESSION,
].join("\n");

function count(pattern: RegExp): number {
  return PITCH_PONG_SOURCE.match(pattern)?.length ?? 0;
}

describe("Pitch Pong continuous-input architecture guard", () => {
  it("renders exactly one canonical NoteInput before every phase-specific surface", () => {
    expect(count(/<NoteInput(?:\s|\/|>)/g)).toBe(1);
    const noteInputAt = PITCH_PONG_SOURCE.indexOf("<NoteInput");
    const firstPhaseSurfaceAt = PITCH_PONG_SOURCE.indexOf('{phase === "setup"');
    expect(noteInputAt).toBeGreaterThan(-1);
    expect(firstPhaseSurfaceAt).toBeGreaterThan(noteInputAt);
  });

  it("has no microphone-opening or connecting game phase", () => {
    expect(PONG_IMPLEMENTATION).not.toContain('input.state === "opening"');
    expect(PONG_IMPLEMENTATION).not.toMatch(/\bconnecting\b/i);
    expect(PONG_IMPLEMENTATION).not.toMatch(/phase\s*===\s*["']opening["']/);
  });

  it("never owns, disables, stops, or phase-hides the shared capture", () => {
    expect(PONG_IMPLEMENTATION).not.toMatch(/\binput\.(?:enable|disable|getStream|liveFrame)\b/);
    expect(PONG_IMPLEMENTATION).not.toMatch(/\b(?:getUserMedia|AudioContext|createMediaStreamSource)\b/);
    expect(PONG_IMPLEMENTATION).not.toMatch(/\b(?:capture|track|stream|input)\.stop\s*\(/);
  });

  it("has no wall-clock freshness or stale-input state", () => {
    const axis = readFileSync(new URL(
      "../apps/web/src/features/voice-arcade/voice-axis-controller.ts",
      import.meta.url,
    ), "utf8");
    expect(axis).not.toMatch(/\bstale\b|freshnessSeconds|lastReliableReceivedAt|frameAge|lastPitchAge/i);
    expect(axis).not.toContain("performance.now");
    expect(PONG_IMPLEMENTATION).not.toMatch(/\b(?:Date\.now|performance\.now|requestAnimationFrame)\b/);
  });

  it("does not duplicate microphone telemetry or pitch presentation", () => {
    expect(PITCH_PONG_SOURCE).not.toMatch(/pong-(?:mic-meter|voice-readout|detected-note|input-scope)/);
    expect(PITCH_PONG_SOURCE).not.toContain('variant="scope"');
  });

  it("keeps runtime ownership out of the compact presentation component", () => {
    const presentationAt = PITCH_PONG_SOURCE.indexOf("export function PitchPong");
    expect(presentationAt).toBeGreaterThan(-1);
    const presentationLines = PITCH_PONG_SOURCE.slice(presentationAt).trimEnd().split(/\r?\n/).length;
    const mutableHookCount = count(/\buse(?:State|Ref|Effect)\s*(?:<[^;()]*>)?\s*\(/g);
    expect(presentationLines).toBeLessThanOrEqual(200);
    expect(mutableHookCount).toBeLessThanOrEqual(20);
    expect(PITCH_PONG_SOURCE.slice(presentationAt)).not.toMatch(/\buse(?:State|Ref|Effect)\s*\(/);
  });

  it("uses one external runtime authority with no mirrored React game state", () => {
    expect(PITCH_PONG_HOOK).toContain("useSyncExternalStore(");
    expect(PITCH_PONG_HOOK).toContain("onFrame: runtime.observe");
    expect(PITCH_PONG_HOOK).not.toMatch(/\buse(?:State|Ref)\s*\(/);
    expect(PITCH_PONG_HOOK).not.toMatch(/\b(?:phaseRef|gameRef|timersRef|generationRef|setGame)\b/);
    expect(PITCH_PONG_RUNTIME).toContain("new RealtimeSessionStore(");
    expect(PITCH_PONG_RUNTIME).toContain("options.maximumPresentationHz ?? 30");
    expect(PITCH_PONG_RUNTIME.match(/AbortController \| null/g)).toHaveLength(1);
    expect(PITCH_PONG_RUNTIME).not.toMatch(/\b(?:timers|generation)Ref\b|\[\]\s*as\s*number\[\]/);
  });

  it("reduces detector callbacks and physics from sample coordinates outside React", () => {
    expect(PITCH_PONG_SESSION).toContain("observation.endSample - previous.endSample");
    expect(PITCH_PONG_SESSION).toContain("hop / observation.sampleRate");
    expect(PITCH_PONG_SESSION).toContain("updatePongState(previousGame");
    expect(PITCH_PONG_SESSION).not.toMatch(/\bset[A-Z]\w*\s*\(|\bdispatch\s*\(/);
  });

  it("gives visibility and winning scores no authority to pause or replace the live court", () => {
    expect(PITCH_PONG_HOOK).not.toMatch(/visibilitychange|runtime\.pause|runtime\.resume/);
    expect(PITCH_PONG_SESSION).toContain('export type PongPhase = "setup" | "countdown" | "playing" | "result";');
    expect(PITCH_PONG_SESSION).not.toMatch(/phase:\s*["']paused["']/);
    expect(PITCH_PONG_SESSION).toContain("latestAchievement = scoreRound(nextGame");
    expect(PITCH_PONG_SESSION).toContain("The court stays live until you stop.");
    expect(PITCH_PONG_SOURCE).toContain('data-live-lifetime="user-owned"');
  });
});
