import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

interface ControlSurfaceContract {
  readonly name: string;
  readonly paths: readonly string[];
  readonly start: RegExp;
  readonly finish: RegExp;
  readonly lifetime: RegExp;
}

const LIVE_CONTROL_SURFACES: readonly ControlSurfaceContract[] = Object.freeze([
  {
    name: "Pitch Match",
    paths: ["apps/web/src/features/pitch-mirror/PitchMirror.tsx"],
    start: /Start trace/,
    finish: /Finish trace/,
    lifetime: /data-trace-lifetime="user-owned"/,
  },
  {
    name: "Hum Lab",
    paths: ["apps/web/src/features/hum-lab/HumLab.tsx"],
    start: /Start trace/,
    finish: /Finish trace/,
    lifetime: /data-trace-lifetime="user-owned"/,
  },
  {
    name: "Pitch Control",
    paths: ["apps/web/src/features/pitch-control/PitchControl.tsx"],
    start: /Start trace/,
    finish: /Finish trace/,
    lifetime: /data-trace-lifetime="user-owned"/,
  },
  {
    name: "Pitch Tunnel",
    paths: [
      "apps/web/src/features/pitch-tunnel/PitchTunnel.tsx",
      "apps/web/src/features/pitch-tunnel/PitchTunnelLane.tsx",
    ],
    start: /Start trace here/,
    finish: /Finish trace/,
    lifetime: /data-trace-lifetime=/,
  },
  {
    name: "Range Loop",
    paths: ["apps/web/src/features/range-loop/RangeLoopStage.tsx"],
    start: /Start Range Loop/,
    finish: /Finish Range Loop/,
    lifetime: /data-live-lifetime="user-owned"/,
  },
  {
    name: "Range Simulator",
    paths: ["apps/web/src/features/range-simulator/RangeSimulator.tsx"],
    start: /Start (?:saved )?assessment/,
    finish: /Finish today/,
    lifetime: /data-live-lifetime="user-owned"/,
  },
  {
    name: "Echo Run",
    paths: ["apps/web/src/features/voice-arcade/PatternChallenge.tsx"],
    start: /Start voice run/,
    finish: /Stop & grade/,
    lifetime: /data-live-lifetime="user-owned"/,
  },
  {
    name: "Pitch Pong",
    paths: ["apps/web/src/features/voice-arcade/PitchPong.tsx"],
    start: /Start pitch match/,
    finish: /Stop & grade/,
    lifetime: /data-live-lifetime="user-owned"/,
  },
  {
    name: "Pitch Maze",
    paths: ["apps/web/src/features/voice-arcade/PitchMaze.tsx"],
    start: /Start Pitch Maze/,
    finish: /Finish campaign/,
    lifetime: /data-live-lifetime="user-owned"/,
  },
  {
    name: "Resonance",
    paths: ["apps/web/src/features/voice-arcade/Resonance.tsx"],
    start: /Start chamber/,
    finish: /Finish chamber/,
    lifetime: /data-live-lifetime="user-owned"/,
  },
  {
    name: "Song Rail",
    paths: ["apps/web/src/features/voice-arcade/SongRide.tsx"],
    start: /Start Song Rail/,
    finish: /Stop & grade/,
    lifetime: /data-live-lifetime="user-owned"/,
  },
  {
    name: "Vocal Canvas",
    paths: ["apps/web/src/features/voice-arcade/VoiceDraw.tsx"],
    start: /Start drawing/,
    finish: /Finish (?:drawing|trace)/,
    lifetime: /data-live-lifetime="user-owned"/,
  },
  {
    name: "Vocal Flight",
    paths: [
      "apps/web/src/features/voice-arcade/vocal-flight/VocalFlight.tsx",
      "apps/web/src/features/voice-arcade/vocal-flight/VocalFlightHud.tsx",
      "apps/web/src/features/voice-arcade/vocal-flight/VocalFlightLoadout.tsx",
    ],
    start: /Start flight/,
    finish: /Finish (?:flight|& grade)/,
    lifetime: /data-live-lifetime="user-owned"/,
  },
]);

const AUDIO_LIFETIME_OWNERS = Object.freeze({
  "apps/web/src/features/hum-lab/HumLab.tsx": "Hum Lab",
  "apps/web/src/features/pitch-control/PitchControl.tsx": "Pitch Control",
  "apps/web/src/features/pitch-mirror/PitchMirror.tsx": "Pitch Match",
  "apps/web/src/features/pitch-tunnel/use-pitch-tunnel.ts": "Pitch Tunnel",
  "apps/web/src/features/range-loop/use-range-loop-session.ts": "Range Loop",
  "apps/web/src/features/range-simulator/use-range-simulator.ts": "Range Simulator",
  "apps/web/src/features/song-lab/use-song-workspace.ts": "Song Lab",
  "apps/web/src/features/voice-arcade/PatternChallenge.tsx": "Echo Run",
  "apps/web/src/features/voice-arcade/PitchMaze.tsx": "Pitch Maze",
  "apps/web/src/features/voice-arcade/Resonance.tsx": "Resonance",
  "apps/web/src/features/voice-arcade/VoiceDraw.tsx": "Vocal Canvas",
  "apps/web/src/features/voice-arcade/use-pitch-pong.ts": "Pitch Pong",
  "apps/web/src/features/voice-arcade/use-song-ride.ts": "Song Rail",
  "apps/web/src/features/voice-arcade/vocal-flight/use-vocal-flight.ts": "Vocal Flight",
} as const);

describe("visible user-owned live-session controls", () => {
  it("inventories every feature that consumes the shared audio controller", () => {
    const featureRoot = resolve(ROOT, "apps/web/src/features");
    const consumers = sourceFiles(featureRoot)
      .filter((path) => /\buseAudioInput\s*\(/u.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path))
      .sort();
    expect(consumers).toEqual(Object.keys(AUDIO_LIFETIME_OWNERS).sort());

    const auditedNames = new Set([
      ...LIVE_CONTROL_SURFACES.map(({ name }) => name),
      "Song Lab",
    ]);
    expect(new Set(Object.values(AUDIO_LIFETIME_OWNERS))).toEqual(auditedNames);
  });

  it.each(LIVE_CONTROL_SURFACES)(
    "$name exposes real Start and Finish/Stop controls on its stable live surface",
    ({ paths, start, finish, lifetime }) => {
      const source = paths.map(read).join("\n");
      expect(source).toMatch(start);
      expect(source).toMatch(finish);
      expect(source).toMatch(lifetime);
    },
  );

  it("labels other user-owned long-running operations as Start and Stop", () => {
    const soundLab = read("apps/web/src/features/sound-lab/SoundLab.tsx");
    expect(soundLab).toContain('droneActionLabel = "Start drone"');
    expect(soundLab).toContain('droneActionLabel = "Stop drone"');
    expect(soundLab).not.toContain('droneActionLabel = "Starting drone…"');

    const songLab = read("apps/web/src/features/song-lab/SongLab.tsx");
    expect(songLab).toContain('return "Start voice take"');
    expect(songLab).toContain('return "Stop opening take"');
    expect(songLab).toContain('return "Stop & review take"');
    expect(songLab).toContain('return "Stop unsaved take"');
  });

  it("keeps nonterminal achievements inside the still-live control surface", () => {
    const pattern = read("apps/web/src/features/voice-arcade/PatternChallenge.tsx");
    expect(pattern).toContain("The next phrase is live. Keep playing or choose Stop & grade.");

    const pong = read("apps/web/src/features/voice-arcade/pitch-pong-session.ts");
    expect(pong).toContain("Match won. The court stays live until you stop.");

    const maze = read("apps/web/src/features/voice-arcade/PitchMaze.tsx");
    expect(maze.indexOf("<MazeBoard")).toBeLessThan(maze.indexOf("session.currentResult"));

    const resonance = read("apps/web/src/features/voice-arcade/Resonance.tsx");
    expect(resonance.indexOf("<ResonanceChamber")).toBeLessThan(
      resonance.indexOf("<ResonanceResultPanel"),
    );

    const songRide = read("apps/web/src/features/voice-arcade/SongRide.tsx");
    expect(songRide).toContain("Track complete");
    expect(songRide).toContain("your live voice control is still active");
  });

  it("does not let persisted progress or drawing settings impersonate Start/Finish", () => {
    const home = read("apps/web/src/features/home/Home.tsx");
    expect(home).toContain("Open cold attacks");
    expect(home).not.toContain("Start cold attacks");

    const rangeSimulator = read("apps/web/src/features/range-simulator/controller.ts");
    expect(rangeSimulator).toContain('status: explicitlyFinished ? "complete" : "idle"');
    expect(rangeSimulator).toContain("Press Start saved assessment");

    const voiceDraw = read("apps/web/src/features/voice-arcade/VoiceDraw.tsx");
    expect(voiceDraw).toContain('realtime.dispatch({ type: "clean" })');
    expect(voiceDraw).toContain('drawingActionLabel = "Start drawing again"');
    expect(voiceDraw).not.toContain('realtime.dispatch({ type: "reset" })');
    expect(voiceDraw).not.toContain('drawingActionLabel = "Resume drawing"');

    const pitchMaze = read("apps/web/src/features/voice-arcade/PitchMaze.tsx");
    expect(pitchMaze).toContain("onStartAnother={startAnotherCampaign}");
    expect(pitchMaze).toContain('realtime.dispatch({ type: "reset" });');
    expect(pitchMaze).toContain("startCampaign();");
  });
});
