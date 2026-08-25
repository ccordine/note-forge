import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const component = readFileSync(new URL(
  "../apps/web/src/features/voice-arcade/SongRide.tsx",
  import.meta.url,
), "utf8");
const hook = readFileSync(new URL(
  "../apps/web/src/features/voice-arcade/use-song-ride.ts",
  import.meta.url,
), "utf8");
const session = readFileSync(new URL(
  "../apps/web/src/features/voice-arcade/song-ride-session.ts",
  import.meta.url,
), "utf8");
const runtime = readFileSync(new URL(
  "../apps/web/src/features/voice-arcade/song-ride-runtime.ts",
  import.meta.url,
), "utf8");

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe("Song Ride continuous-input architecture guard", () => {
  it("mounts one stable canonical live-note surface outside the stage switch", () => {
    expect(count(component, /<NoteInput(?:\s|\/|>)/g)).toBe(1);
    expect(component.indexOf("<SongRideHud")).toBeLessThan(component.indexOf('phase === "upload"'));
  });

  it("deletes playback-isolation, headphone confirmation, connecting, and workflow gates", () => {
    const source = `${component}\n${hook}`;
    for (const forbidden of [
      /song-isolation/i,
      /isolation(?:Check|Verified|Blocked|Issue)/,
      /headphonesConfirmed/,
      /WorkflowDialog/,
      /\bconnecting\b/i,
      /scoring stayed locked/i,
      /input\.disable/,
      /getStream\(\)/,
    ]) expect(source).not.toMatch(forbidden);
  });

  it("keeps app-owned input alive while game transport pauses and stages change", () => {
    expect(hook).toContain("useAudioInput({ onFrame: runtime.observe })");
    expect(count(hook, /useAudioInput\s*\(/g)).toBe(1);
    expect(hook).not.toMatch(/(?:input|capture|stream|track)\.stop\s*\(/);
    expect(hook).not.toMatch(/(?:input|inputRef\.current)\.(?:enable|disable)\s*\(/);
    expect(hook).not.toMatch(/input\.state\s*!==\s*"running"/);
  });

  it("keeps visibility and track completion from ending or replacing the live rail", () => {
    expect(hook).not.toContain("visibilitychange");
    expect(session).toContain('export type SongPlaybackState = "stopped" | "playing" | "paused" | "ended";');
    expect(session).not.toMatch(/\|\s*["']paused["']\s*\n\s*\|\s*["']result["']/);
    expect(component).toContain("onEnded={controller.completeTrack}");
    expect(component).not.toMatch(/onEnded=.*finish/);
    expect(component).toContain('data-live-lifetime="user-owned"');
    expect(runtime).toContain('type: "track-completed"');
    const trackCompletion = session.slice(
      session.indexOf('case "track-completed"'),
      session.indexOf('case "run-finished"'),
    );
    expect(trackCompletion).not.toContain('phase: "result"');
  });

  it("uses sample-coordinate authority and bounded source ownership", () => {
    expect(session).toContain("observation.endSample - previous.endSample");
    expect(session).toContain("observation.sampleRate");
    expect(session).toContain("observation.discontinuity");
    expect(session).not.toMatch(/performance\.now|Date\.now|setTimeout|requestAnimationFrame/);
    expect(runtime).not.toMatch(/performance\.now|Date\.now|setTimeout|requestAnimationFrame/);
    expect(component.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(600);
    expect(hook.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(600);
    expect(session.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(600);
    expect(runtime.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(600);
  });

  it("uses one external session authority and a coalesced detector bridge", () => {
    expect(hook).toContain("useSyncExternalStore(");
    expect(hook).not.toMatch(/\buse(?:Reducer|State|Ref)\s*\(/);
    expect(hook).not.toMatch(/\b(?:sessionRef|generationRef|animationFrameRef|mountedRef)\b/);
    expect(runtime).toContain("new RealtimeSessionStore(");
    expect(runtime).toContain("options.maximumPresentationHz ?? 30");
    expect(runtime.match(/AbortController \| null/g)).toHaveLength(1);
    const detectorCallback = runtime.slice(
      runtime.indexOf("readonly observe ="),
      runtime.indexOf("readonly syncProgress ="),
    );
    expect(detectorCallback).toContain("this.store.observe(");
    expect(detectorCallback).not.toMatch(/\bset[A-Z]\w*\s*\(|\.dispatch\s*\(/);
  });
});
