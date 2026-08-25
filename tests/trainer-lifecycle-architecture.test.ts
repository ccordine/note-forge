import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const sources = {
  mirror: read("apps/web/src/features/pitch-mirror/PitchMirror.tsx"),
  control: read("apps/web/src/features/pitch-control/PitchControl.tsx"),
  hum: read("apps/web/src/features/hum-lab/HumLab.tsx"),
};
const runner = read("apps/web/src/features/training-session/use-attempt-runner.ts");
const runnerModel = read("apps/web/src/features/training-session/attempt-runner.ts");
const effectScope = read("apps/web/src/features/training-session/use-session-effect-scope.ts");
const family = read("apps/web/src/features/ear-training/NoteFamilyTrainer.tsx");
const rangeLoop = read("apps/web/src/features/range-loop/RangeLoop.tsx");
const rangeLoopSession = read("apps/web/src/features/range-loop/use-range-loop-session.ts");
const rangeSimulator = read("apps/web/src/features/range-simulator/use-range-simulator.ts");
const preferences = read("apps/web/src/state/UserPreferencesContext.tsx");
const app = read("apps/web/src/App.tsx");

describe("non-Arcade live trainer architecture", () => {
  it.each(Object.entries(sources))("keeps %s on one app-owned input with no attempt lifecycle control", (_, source) => {
    expect(source.match(/<NoteInput\b/g)).toHaveLength(1);
    expect(source.match(/useAudioInput\s*\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/input\.(?:enable|disable)\s*\(/);
    expect(source).not.toMatch(/\bsetTimeout\s*\(|\bsetInterval\s*\(|performance\.now\s*\(|requestAnimationFrame\s*\(/);
    expect(source).not.toMatch(/\bActiveVoice\b|guideVoice|promptVoice|CONNECTING|STARTING AUDIO/);
    expect(source).not.toMatch(/input\.(?:frames|liveFrame|telemetry)\b/);
    expect(source).toContain("useAttemptRunner");
    expect(source).toContain("BRIEF_REFERENCE_SECONDS");
  });

  it("keeps prompt playback independent from starting a measurement", () => {
    for (const source of Object.values(sources)) {
      expect(source).toMatch(/const (?:hearTarget|hearReference) = \(\) => attempt\.playReference/);
      expect(source).toMatch(/attempt\.begin\(/);
      const beginBody = source.match(/const begin = \(\) => \{([\s\S]*?)\n  \};/)?.[1] ?? "";
      expect(beginBody).not.toMatch(/playTone|input\.(?:enable|disable)/);
    }
  });

  it("renders one current workflow step around one stable canonical tuner", () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, name).toContain("let currentStep: ReactNode;");
      expect(source.match(/data-workflow-step=/g), name).toHaveLength(3);
      expect(source, name).toContain('data-workflow-step="idle"');
      expect(source, name).toContain('data-workflow-step="tracking"');
      expect(source, name).toContain('data-workflow-step="complete"');
      const stablePageTree = source.slice(source.lastIndexOf("\n  return ("));
      expect(stablePageTree.match(/<NoteInput\b/g), name).toHaveLength(1);
      expect(stablePageTree, name).toContain("{currentStep}");
      expect(stablePageTree, name).not.toMatch(/data-workflow-step=|mirror-results-grid|split-score|hum-workspace|envelope-stage/);
    }
  });

  it("aborts and resets attempt authority when Back or Forward changes a route mode", () => {
    expect(sources.mirror).toMatch(/useEffect\(\(\) => \{[\s\S]*?resetAttempt\(\)[\s\S]*?\}, \[mode, resetAttempt\]\);/);
    expect(sources.hum).toMatch(/useEffect\(\(\) => \{[\s\S]*?resetAttempt\(\)[\s\S]*?\}, \[mode, resetAttempt\]\);/);
    expect(sources.control).toMatch(/useEffect\(\(\) => \{[\s\S]*?resetAttempt\(\)[\s\S]*?\}, \[envelopeType, resetAttempt\]\);/);
  });

  it("renders and scores from one frozen tolerance for the whole active attempt", () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, name).toMatch(/const activeToleranceCents = attemptConfiguration\?\.toleranceCents \?\? toleranceCents;/);
      expect(source, name).toMatch(/<NoteInput[\s\S]*?toleranceCents=\{activeToleranceCents\}/);
      expect(source, name).not.toContain("toleranceCents={toleranceCents}");
    }
    expect(rangeLoopSession).toContain("const activeToleranceCents = dwell.toleranceCents;");
    expect(rangeLoopSession).toContain("toleranceCents: activeToleranceCents");
    expect(rangeSimulator).toContain("const activeToleranceCents = state.dwell.toleranceCents;");
    expect(rangeSimulator).toContain("toleranceCents: activeToleranceCents");
  });

  it("deletes the inert expert preference instead of preserving a dormant UI branch", () => {
    expect(preferences).not.toMatch(/expertMode|setExpertMode/);
    expect(app).not.toMatch(/expertMode|setExpertMode|Expert \/ debug view/);
  });

  it("uses one pure AttemptRunner and keeps detector cadence outside React", () => {
    expect(runnerModel).toContain('export type AttemptRunnerStatus = "idle" | "tracking" | "complete";');
    expect(runnerModel).toContain("reduceAttemptRunner");
    expect(runner).toContain("useRealtimeSession");
    expect(runner).not.toMatch(/\buseState\b|\buseReducer\b/);
    expect(runner).toContain('session.observe({ type: "observation", observation })');
  });

  it("makes automatic live-trace cutoff unrepresentable", () => {
    expect(runnerModel).not.toMatch(/durationSeconds|deadline|timeout|completeAfter/);
    expect(runner).not.toMatch(/durationSeconds|deadline|timeout|completeAfter/);
    expect(runnerModel).toContain('case "finish":');
    expect(runnerModel).toContain('return { ...state, status: "complete" };');
    expect(runnerModel).toContain('status: "tracking"');
    for (const [name, source] of Object.entries(sources)) {
      expect(source, name).not.toMatch(/Begin \$\{[^}]+\} s trace|TAKE_SECONDS|label="Duration"/);
      expect(source, name).toContain('data-trace-lifetime="user-owned"');
      expect(source, name).toContain("Finish trace");
    }
  });

  it("owns prompt cancellation in one shared abort scope", () => {
    expect(effectScope.match(/new AbortController\s*\(/g)).toHaveLength(1);
    expect(effectScope).not.toMatch(/\bsetTimeout\b|\bsetInterval\b|generation|mounted/);
    expect(effectScope).toContain("attachVoiceToScope");
    expect(family).toContain("useSessionEffectScope");
    expect(family).not.toContain("playSafely");
    expect(rangeLoopSession).toContain("useSessionEffectScope");
    expect(rangeSimulator).toContain("useSessionEffectScope");
    for (const source of [...Object.values(sources), family, rangeLoopSession, rangeSimulator]) {
      expect(source).not.toMatch(/\bActiveVoice\b|\bplaySafely\b|input\.(?:enable|disable)\s*\(/);
    }
  });

  it("keeps distinct session mathematics explicit instead of cloning attempt phases", () => {
    expect(family).toContain("reduceNoteFamilySession");
    expect(family).not.toContain("useAttemptRunner");
    expect(rangeLoopSession).toContain("reduceRangeDwell");
    expect(rangeLoopSession).toContain("useRealtimeSession");
    expect(rangeLoopSession).not.toContain("useAttemptRunner");
    expect(rangeSimulator).toContain("reduceRangeSimulatorController");
    expect(rangeSimulator).toContain("useRealtimeSession");
    expect(rangeSimulator).not.toContain("useAttemptRunner");
  });

  it("keeps every note family directly selectable and deletes lock authority", () => {
    const component = family;
    const model = read("apps/web/src/features/ear-training/trials.ts");
    expect(component).not.toMatch(/highestUnlocked|unlockedFamily|REGISTER LOCK|Icon name="lock"/);
    expect(component).toContain("Every family is available.");
    expect(component).toMatch(/NOTE_FAMILIES\.map/);
    expect(model).not.toMatch(/advanceHighestUnlockedFamily|unlockedFamilyIdsThrough/);
  });

  it("keeps the refactored executable surfaces below extraction thresholds", () => {
    for (const [name, source] of Object.entries({ ...sources, family: read("apps/web/src/features/ear-training/NoteFamilyTrainer.tsx") })) {
      expect(source.split("\n").length, name).toBeLessThan(300);
    }
    expect(rangeLoop.split("\n").length, "range-loop host").toBeLessThan(100);
    expect(rangeLoopSession.split("\n").length, "range-loop session").toBeLessThan(400);
  });
});
