import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) => readFileSync(
  new URL(`../apps/web/src/features/${relativePath}`, import.meta.url),
  "utf8",
);

const shellSources = Object.freeze({
  ear: source("ear-training/EarLab.tsx"),
  intervals: source("intervals/IntervalLab.tsx"),
  harmony: source("harmony/HarmonyLab.tsx"),
  melody: source("melody/MelodyLab.tsx"),
});

const activitySources = [
  source("ear-training/AdvancedEarActivity.tsx"),
  source("intervals/RecognitionActivity.tsx"),
  source("intervals/ProductionActivity.tsx"),
  source("intervals/ComparisonActivity.tsx"),
  source("intervals/MutationActivity.tsx"),
  source("harmony/ScaleDegreeActivity.tsx"),
  source("harmony/ChordToneActivity.tsx"),
  source("harmony/VoiceLeadingActivity.tsx"),
  source("harmony/HarmonyFollowActivity.tsx"),
  source("melody/EchoActivity.tsx"),
  source("melody/ContourActivity.tsx"),
  source("melody/DrawActivity.tsx"),
  source("melody/TranscribeActivity.tsx"),
];

describe("Practice surface architecture", () => {
  it("keeps URL-owned page shells free of local workflow runtimes", () => {
    const allShells = Object.values(shellSources).join("\n");
    expect(allShells).not.toMatch(/useEffect|useReducer|useRef|setTimeout|setInterval|requestAnimationFrame/);
    expect(shellSources.ear.match(/const \[[^\]]+\] = useState/g)).toHaveLength(1);
    expect(shellSources.intervals.match(/const \[[^\]]+\] = useState/g)).toHaveLength(2);
    expect(shellSources.harmony).not.toMatch(/useState\s*\(/);
    expect(shellSources.melody).not.toMatch(/useState\s*\(/);
  });

  it("mounts one explicit mode activity instead of rendering all mode workspaces", () => {
    expect(shellSources.intervals).toContain("ACTIVITY_BY_MODE");
    expect(shellSources.melody).toContain("ACTIVITY_BY_MODE");
    expect(shellSources.harmony).toContain("activityFor(mode)");
    expect(shellSources.ear).toContain("AdvancedEarActivity");
    expect(shellSources.ear).toContain("NoteFamilyTrainer");
  });

  it("contains no callback-arrival timer graph in the extracted activities", () => {
    const allActivities = activitySources.join("\n");
    expect(allActivities).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
    expect(source("intervals/playback.ts")).toContain("when:");
    expect(source("harmony/playback.ts")).toContain("when:");
  });
});
