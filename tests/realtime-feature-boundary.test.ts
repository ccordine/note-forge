import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../apps/web/src/${relativePath}`, import.meta.url), "utf8");
}

const REALTIME_FEATURES = Object.freeze([
  "features/voice-arcade/PatternChallenge.tsx",
  "features/voice-arcade/PitchMaze.tsx",
  "features/voice-arcade/Resonance.tsx",
  "features/voice-arcade/VoiceDraw.tsx",
  "features/range-simulator/use-range-simulator.ts",
]);

describe("realtime feature-to-React boundary", () => {
  it("reduces detector observations outside React and publishes only bounded snapshots", () => {
    for (const filename of REALTIME_FEATURES) {
      const contents = source(filename);
      expect(contents, filename).toContain("useRealtimeSession(");
      expect(contents, filename).toMatch(
        /onFrame:\s*\(observation\)\s*=>\s*\w+\.observe\(\{ type: "observation", observation \}\)/,
      );
      expect(contents, filename).not.toMatch(/\buseReducer\s*\(/);
      expect(contents, filename).not.toMatch(
        /onFrame:\s*\([^)]*\)\s*=>\s*(?:set[A-Z]\w*|dispatch)\s*\(/,
      );
      expect(contents, filename).not.toMatch(/\binput\.liveFrame\b/);
    }
  });

  it("keeps Song Ride and Pong detector callbacks imperative and React-free", () => {
    const songHook = source("features/voice-arcade/use-song-ride.ts");
    const songRuntime = source("features/voice-arcade/song-ride-runtime.ts");
    const songView = source("features/voice-arcade/SongRide.tsx");
    const pongHook = source("features/voice-arcade/use-pitch-pong.ts");
    const pongSession = source("features/voice-arcade/pitch-pong-session.ts");
    const songCallback = songRuntime.slice(
      songRuntime.indexOf("readonly observe ="),
      songRuntime.indexOf("readonly syncProgress ="),
    );

    expect(songHook).toContain("onFrame: runtime.observe");
    expect(songCallback).not.toMatch(/\bset[A-Z]\w*\s*\(|\.dispatch\s*\(/);
    expect(pongHook).toContain("onFrame: runtime.observe");
    expect(pongHook).not.toMatch(/onFrame:\s*\([^)]*\)\s*=>\s*(?:set[A-Z]\w*|dispatch)\s*\(/);
    expect(pongSession).not.toMatch(/\b(?:set[A-Z]\w*|dispatch)\s*\(/);
    expect(songView).not.toMatch(/\binput\.liveFrame\b/);
    expect(songView).toContain("session.liveObservation");
  });

  it("keeps feature code out of microphone lifecycle ownership", () => {
    const activeSources = [
      ...REALTIME_FEATURES.map(source),
      source("features/voice-arcade/use-song-ride.ts"),
      source("features/voice-arcade/song-ride-runtime.ts"),
      source("features/voice-arcade/use-pitch-pong.ts"),
      source("features/voice-arcade/pitch-pong-runtime.ts"),
      source("features/voice-arcade/pitch-pong-session.ts"),
    ].join("\n");
    expect(activeSources).not.toMatch(/\binput\.(?:enable|disable|getStream)\s*\(/);
    expect(activeSources).not.toMatch(/\b(?:track|stream|capture)\.stop\s*\(/);
  });
});
