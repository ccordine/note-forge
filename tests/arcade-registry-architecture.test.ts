import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ARCADE_GAME_DEFINITIONS,
  ARCADE_MODES,
} from "../apps/web/src/features/voice-arcade/arcade-registry";

function source(relativePath: string): string {
  return readFileSync(new URL(`../apps/web/src/${relativePath}`, import.meta.url), "utf8");
}

describe("Arcade cabinet registration boundary", () => {
  it("derives every shared cabinet consumer from one typed registry", () => {
    expect(Object.keys(ARCADE_GAME_DEFINITIONS)).toEqual(ARCADE_MODES);
    expect(new Set(ARCADE_MODES)).toHaveLength(ARCADE_MODES.length);

    const shell = source("features/voice-arcade/VoiceArcade.tsx");
    const types = source("features/voice-arcade/types.ts");
    const curriculum = source("features/voice-arcade/curriculum.ts");
    const progress = source("features/voice-arcade/arcade-progress.ts");
    const navigation = source("navigation.ts");

    expect(shell).toContain("ARCADE_GAME_DEFINITIONS[mode]");
    expect(shell).toContain("ARCADE_MODE_ORDER.map");
    expect(shell).not.toMatch(/from "\.\/(?:PatternChallenge|PitchPong|SongRide|PitchMaze|Resonance|VoiceDraw)"/);
    expect(shell).not.toMatch(/\bid === "(?:pattern|pong|song|maze|resonance|draw)"/);
    expect(types).toContain('export { ARCADE_MODES, type ArcadeMode } from "./arcade-registry"');
    expect(curriculum).toContain("ARCADE_GAME_DEFINITIONS[mode].mastery");
    expect(curriculum).toContain("ARCADE_GAME_DEFINITIONS[mode].curriculum");
    expect(progress).toContain("ARCADE_MODES.map");
    expect(navigation).toContain("ARCADE_MODES");
    expect(navigation).not.toMatch(/type ArcadeRouteMode = "|\["pong", "maze"/);

    const hydrationGate = shell.indexOf("if (!hydrated)");
    const gameMount = shell.indexOf("if (mode && activeCopy && activeCurriculum && ActiveGame)");
    expect(hydrationGate).toBeGreaterThan(-1);
    expect(gameMount).toBeGreaterThan(hydrationGate);
    expect(shell.slice(hydrationGate, gameMount)).not.toContain("<ActiveGame");
  });

  it("keeps each lazy runtime and its feature styles inside its own definition", () => {
    for (const mode of ARCADE_MODES) {
      const definition = ARCADE_GAME_DEFINITIONS[mode];
      expect(definition.component).toBeTypeOf("object");
      expect(definition.preview).toBeTypeOf("function");
      expect(definition.skills.length).toBeGreaterThan(0);
      expect(Object.keys(definition.mastery)).toEqual(["deliberate", "reflex", "background"]);
    }
  });
});
