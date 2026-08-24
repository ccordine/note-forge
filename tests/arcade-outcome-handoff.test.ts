import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(filename: string): string {
  return readFileSync(new URL(`../apps/web/src/features/voice-arcade/${filename}`, import.meta.url), "utf8");
}

describe("Arcade outcome handoff architecture", () => {
  it("uses one report-once authority for every locally completed game", () => {
    const handoff = source("use-arcade-outcome.ts");
    expect(handoff).toContain("useArcadeOutcomeHandoff");
    expect(handoff).toContain("Object.is(reportedKeyRef.current, outcomeKey)");

    for (const filename of ["PatternChallenge.tsx", "PitchMaze.tsx", "Resonance.tsx"]) {
      const game = source(filename);
      expect(game, filename).toContain("useArcadeOutcomeHandoff(");
      expect(game, filename).not.toMatch(/(?:reported|completed)(?:Run|Outcome)Ref/);
      expect(game, filename).not.toMatch(/useEffect\([\s\S]{0,500}onComplete\(/);
    }
  });
});
