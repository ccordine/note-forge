import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE_ROOT = resolve(ROOT, "apps/web/src");

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

interface LivePitchVisualContract {
  readonly path: string;
  /** Shared full-depth projection or a named normalized game-control adapter. */
  readonly authority: readonly string[];
  /** Source forms which prove absent pitch does not leave a current marker behind. */
  readonly markerRemoval: readonly string[];
}

const LIVE_PITCH_VISUALS: readonly LivePitchVisualContract[] = [
  {
    path: "apps/web/src/ui/InputScope.tsx",
    authority: ["pitchMeterPositionPercent", "isAuthoritativeVoicedPitch"],
    markerRemoval: ["pitchPosition !== null && <b", "data-live-pitch-marker"],
  },
  {
    path: "apps/web/src/ui/voice/VoiceCoach.tsx",
    authority: ["pitchMeterPositionPercent", "isAuthoritativeVoicedPitch"],
    markerRemoval: ["pitchPosition !== null && <b", "data-live-pitch-marker"],
  },
  {
    path: "apps/web/src/features/pitch-mirror/PitchRibbon.tsx",
    authority: ["pitchRibbonYForMidi", "isAuthoritativeVoicedPitch"],
    markerRemoval: ["if (!isAuthoritativeVoicedPitch(frame)", "flush();"],
  },
  {
    path: "apps/web/src/features/pitch-tunnel/PitchTunnelLane.tsx",
    authority: ["pitchMeterPositionPercent"],
    markerRemoval: ["pointPosition !== null && <span", "data-live-pitch-marker"],
  },
  {
    path: "apps/web/src/features/voice-arcade/PatternChallenge.tsx",
    authority: ["pitchMeterPositionPercent"],
    markerRemoval: ["liveMidi !== null && liveY !== null", "echo-voice-cursor"],
  },
  {
    path: "apps/web/src/features/voice-arcade/SongRide.tsx",
    authority: ["pitchMeterPositionPercent", "isAuthoritativeVoicedPitch"],
    markerRemoval: ["view.liveMidi !== null && view.liveTop !== null", "song-voice-cursor"],
  },
  {
    path: "apps/web/src/features/voice-arcade/vocal-flight/VocalControlReticle.tsx",
    authority: ["VocalControlVector", "pointCoordinate"],
    markerRemoval: ["vector.active && (", "vocal-control-current"],
  },
];

/*
 * This discovery deliberately does not depend on `data-live-pitch-meter`.
 * A source that consumes a live pitch/vector coordinate and draws something
 * named as a pitch/voice cursor, marker, trace, lane, needle, point, or reticle
 * must enter the explicit contract above. The data hook remains proof
 * instrumentation; omitting it cannot hide a new visualization from the gate.
 */
function looksLikeLivePitchVisualization(source: string): boolean {
  const consumesLiveCoordinate = /(?:\bliveMidi\b|\bcurrentMidi(?:Float)?\b|\bmidiFloat\b|\bPitchObservation\b|\bVocalControlVector\b|data-live-midi)/u;
  const rendersLiveGeometry = /(?:data-pitch-position|data-full-depth-pitch-ribbon|data-live-pitch-meter|pitch-trace|(?:pitch|voice)[\w-]*(?:cursor|needle|point|marker|reticle)|(?:cursor|needle|point|marker|reticle)[\w-]*(?:pitch|voice)|vocal-control-current|--(?:voice|pitch)[\w-]*(?:top|left|position|point|x|y))/iu;
  return consumesLiveCoordinate.test(source) && rendersLiveGeometry.test(source);
}

describe("full-depth live pitch meter architecture", () => {
  it("discovers live pitch geometry without trusting an opt-in data tag", () => {
    expect(looksLikeLivePitchVisualization(`
      const liveMidi = observation.midiFloat;
      return <span className="untagged-voice-cursor" style={{ "--voice-top": liveMidi }} />;
    `)).toBe(true);

    const discovered = sourceFiles(SOURCE_ROOT).filter((path) => path.endsWith(".tsx")).filter((path) => {
      const source = readFileSync(path, "utf8");
      return looksLikeLivePitchVisualization(source);
    }).map((path) => relative(ROOT, path)).sort();

    expect(discovered).toEqual(LIVE_PITCH_VISUALS.map(({ path }) => path).sort());
  });

  it("routes every live pitch visualization through named coordinate authority", () => {
    for (const contract of LIVE_PITCH_VISUALS) {
      const source = read(contract.path);
      for (const authority of contract.authority) {
        expect(source, `${contract.path} is missing ${authority}`).toContain(authority);
      }
    }
  });

  it("removes every current pitch/vector marker when evidence is absent", () => {
    for (const contract of LIVE_PITCH_VISUALS) {
      const source = read(contract.path);
      for (const policy of contract.markerRemoval) {
        expect(source, `${contract.path} is missing marker-removal policy ${policy}`).toContain(policy);
      }
    }
  });

  it("keeps the four canonical pitch visualizations on one coordinate authority", () => {
    const owners = [
      "apps/web/src/ui/InputScope.tsx",
      "apps/web/src/ui/voice/VoiceCoach.tsx",
      "apps/web/src/features/pitch-mirror/PitchRibbon.tsx",
      "apps/web/src/features/pitch-tunnel/PitchTunnelLane.tsx",
    ];
    for (const path of owners) {
      const source = read(path);
      expect(source, path).toContain("pitchMeterPositionPercent");
      expect(source, path).not.toMatch(/Math\.max\(-100|Math\.min\(100|clamp\([^\n]*errorCents/u);
    }
  });

  it("keeps the scrolling trace explicitly full-depth", () => {
    const source = read("apps/web/src/features/pitch-mirror/PitchRibbon.tsx");
    expect(source).toContain("data-full-depth-pitch-ribbon");
    expect(source).toContain("pitchRibbonYForMidi");
    expect(source).toContain("useId");
    expect(source).not.toMatch(/id="(?:target-band|trace-gradient|trace-glow|micro-grid)"/u);
    expect(read("apps/web/src/styles-pitch-mirror.css"))
      .not.toMatch(/url\(#(?:target-band|trace-gradient|trace-glow|micro-grid)\)/u);
  });

  it("keeps projected ticks and traces in the same CSS coordinate box as their evidence", () => {
    const components = read("apps/web/src/styles-components.css");
    expect(components).toMatch(/\.nf-voice-ticks\s*\{[^}]*inset:\s*auto 0 4px;/su);

    const tunnel = read("apps/web/src/styles-pitch-tunnel.css");
    expect(tunnel).toMatch(/\.pitch-tunnel-axis\s*\{[^}]*right:\s*0;[^}]*left:\s*0;/su);

    const ribbon = read("apps/web/src/styles-pitch-mirror.css");
    expect(ribbon).toMatch(/\.pitch-ribbon\s*\{[^}]*height:\s*270px;/su);
    expect(ribbon).toMatch(/\.ribbon-y-labels\s*\{[^}]*height:\s*270px;/su);
  });

  it("draws exact detector evidence without rewriting pitch under its sample identity", () => {
    const source = read("apps/web/src/features/pitch-mirror/PitchMirror.tsx");
    expect(source).toContain("attemptRecentScoringFrames(attempt.state)");
    expect(source).not.toMatch(/smoothPitchFrames|correctOctaveJumps|medianSmoothPitchFrames/u);
  });

  it("keeps indirect arcade pitch controllers behind named adapters", () => {
    const pongAdapter = read("apps/web/src/features/voice-arcade/use-pitch-pong.ts");
    const pongRenderer = read("apps/web/src/features/voice-arcade/PitchPong.tsx");
    expect(pongAdapter).toContain("mapPitchToNormalizedVertical");
    expect(pongRenderer).not.toMatch(/\bmidiFloat\b/u);

    const flightReticle = read("apps/web/src/features/voice-arcade/vocal-flight/VocalControlReticle.tsx");
    expect(flightReticle).toContain("VocalControlVector");
    expect(flightReticle).not.toMatch(/\b(?:midiFloat|frequencyHz)\b/u);
  });

  it("uses authoritative observation kind for direct live-note readouts", () => {
    const directReadouts = [
      "apps/web/src/features/home/Home.tsx",
      "apps/web/src/ui/InputScope.tsx",
      "apps/web/src/ui/voice/NoteInput.tsx",
      "apps/web/src/ui/voice/VoiceCoach.tsx",
      "apps/web/src/features/voice-arcade/SongRide.tsx",
    ];
    for (const path of directReadouts) {
      expect(read(path), path).toContain("isAuthoritativeVoicedPitch");
    }

    const rawVoicedGates = sourceFiles(SOURCE_ROOT)
      .filter((path) => path.endsWith(".tsx"))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return /(?:frame\?\.voiced|frame\.voiced|liveFrame\?\.voiced)/u.test(source)
          ? [relative(ROOT, path)]
          : [];
      });
    expect(rawVoicedGates).toEqual([]);
  });
});
