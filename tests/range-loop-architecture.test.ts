import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RANGE_LOOP_URL = new URL(
  "../apps/web/src/features/range-loop/RangeLoop.tsx",
  import.meta.url,
);
const RANGE_LOOP_SOURCE = readFileSync(RANGE_LOOP_URL, "utf8");
const RANGE_LOOP_HOOK_SOURCE = readFileSync(
  new URL(
    "../apps/web/src/features/range-loop/use-range-loop-session.ts",
    import.meta.url,
  ),
  "utf8",
);
const RANGE_LOOP_CREDIT_SOURCE = readFileSync(
  new URL(
    "../apps/web/src/features/range-loop/range-loop-credit.ts",
    import.meta.url,
  ),
  "utf8",
);

const RANGE_LOOP_SOURCE_DIRECTORY = new URL(
  "../apps/web/src/features/range-loop/",
  import.meta.url,
);
const activeSources = readdirSync(RANGE_LOOP_SOURCE_DIRECTORY)
  .filter((fileName) => /\.tsx?$/.test(fileName))
  .sort()
  .map((fileName) => ({
    fileName,
    source: readFileSync(new URL(fileName, RANGE_LOOP_SOURCE_DIRECTORY), "utf8"),
  }));
const implementationSource = activeSources
  .filter(({ fileName }) => [
    "RangeLoop.tsx",
    "RangeLoopSettings.tsx",
    "RangeLoopStage.tsx",
    "use-range-loop-session.ts",
  ].includes(fileName))
  .map(({ source }) => source)
  .join("\n");

const FORBIDDEN_RANGE_LOOP_CONCEPTS = [
  ["WorkflowDialog", /\bWorkflowDialog\b/],
  ["PitchRibbon", /\bPitchRibbon\b/],
  ["LoopPhase", /\bLoopPhase\b/],
  ["guide-check", /guide-check/],
  ["guide-leak", /guide-leak/],
  ["startGuide", /\bstartGuide\b/],
  ["createSupportPlan", /\bcreateSupportPlan\b/],
  ["SupportMode", /\bSupportMode\b/],
  ["SustainTracker", /\bSustainTracker\w*\b/],
  ["setTimeout", /\bsetTimeout\s*\(/],
  ["setInterval", /\bsetInterval\s*\(/],
  ["performance.now", /\bperformance\.now\s*\(/],
  ["Date.now", /\bDate\.now\s*\(/],
] as const;

const OBSOLETE_ACTIVE_SOURCE_IDENTIFIERS = [
  ["supportMode", /\bsupportMode\b/],
  ["guideMidi", /\bguideMidi\b/],
  ["guideIntervalSemitones", /\bguideIntervalSemitones\b/],
  ["guide voice/check/leak/isolation state", /\bguide(?:Voice|Check|Leak|Isolation)\w*\b/i],
  ["headphone confirmation state", /\bheadphonesConfirmed\b/],
  ["support option table", /\bSUPPORT_OPTIONS\b/],
  ["guide/isolation CSS hooks", /range-(?:guide|isolation)/],
] as const;

describe("Range Loop architecture guard", () => {
  it("keeps the page host thin and every extracted implementation file below review limits", () => {
    const hostLineCount = RANGE_LOOP_SOURCE.trimEnd().split(/\r?\n/).length;
    expect(hostLineCount, `RangeLoop.tsx has ${hostLineCount} lines.`).toBeLessThanOrEqual(80);
    expect(RANGE_LOOP_SOURCE).toContain("useRangeLoopSession");
    expect(RANGE_LOOP_SOURCE).toContain("<RangeLoopStage session={session} />");
    expect(RANGE_LOOP_SOURCE).not.toMatch(/\buse(?:State|Effect|Ref|AudioInput|RealtimeSession)\b|\bgetSetting\b|\bsetSettings\b/);

    for (const { fileName, source } of activeSources.filter(({ fileName }) => (
      /^(?:RangeLoop|use-range-loop-session).*\.tsx?$/.test(fileName)
    ))) {
      const lineCount = source.trimEnd().split(/\r?\n/).length;
      expect(lineCount, `${fileName} has ${lineCount} lines.`).toBeLessThanOrEqual(400);
    }
  });

  it("renders exactly one canonical live NoteInput in one stable stage", () => {
    const noteInputCount = implementationSource.match(/<NoteInput(?:\s|\/|>)/g)?.length ?? 0;
    expect(
      noteInputCount,
      `Range Loop renders ${noteInputCount} <NoteInput> surfaces; exactly one must present the live stream.`,
    ).toBe(1);
  });

  it("reduces detector observations outside React and never owns capture", () => {
    expect(RANGE_LOOP_HOOK_SOURCE.match(/useAudioInput\s*\(/g)).toHaveLength(1);
    expect(RANGE_LOOP_HOOK_SOURCE).toContain("useRealtimeSession");
    expect(RANGE_LOOP_HOOK_SOURCE).toContain("reduceRangeLoopCredit");
    expect(RANGE_LOOP_HOOK_SOURCE).toContain('creditSession.observe({ type: "observation", observation })');
    expect(RANGE_LOOP_CREDIT_SOURCE).toContain("observationContinuity");
    expect(RANGE_LOOP_HOOK_SOURCE).not.toContain("reduceNoteDwell");
    expect(implementationSource).not.toMatch(/\bsetDwell\b|input\.(?:enable|disable)\s*\(/);
  });

  it("requires visible Start and Finish commands and gates scoring synchronously", () => {
    const stage = activeSources.find(({ fileName }) => fileName === "RangeLoopStage.tsx")?.source ?? "";
    expect(stage).toContain("Start Range Loop");
    expect(stage).toContain("Finish Range Loop");
    expect(stage).toContain('data-live-lifetime="user-owned"');
    expect(RANGE_LOOP_HOOK_SOURCE).toContain('liveSession.getCurrent().phase === "tracking"');
    expect(RANGE_LOOP_HOOK_SOURCE).toContain('liveSession.dispatch({ type: "start" })');
    expect(RANGE_LOOP_HOOK_SOURCE).toContain("creditSession.flushPresentation()");
    expect(RANGE_LOOP_HOOK_SOURCE).toContain('liveSession.dispatch({ type: "finish" })');
  });

  it("does not score or render a disposable default target before persistence hydration", () => {
    const stage = activeSources.find(({ fileName }) => fileName === "RangeLoopStage.tsx")?.source ?? "";
    expect(RANGE_LOOP_HOOK_SOURCE).toMatch(
      /onFrame:[\s\S]*if \(hydrated && liveSession\.getCurrent\(\)\.phase === "tracking"\)[\s\S]*creditSession\.observe/u,
    );
    expect(stage).toContain("if (!session.hydrated)");
    expect(stage.indexOf("if (!session.hydrated)")).toBeLessThan(stage.indexOf("<NoteInput"));
    expect(stage).toContain("no temporary target is scoring");
  });

  it("uses the one app-owned sustained target toggle independently of session state", () => {
    const stage = activeSources.find(({ fileName }) => fileName === "RangeLoopStage.tsx")?.source ?? "";
    expect(RANGE_LOOP_HOOK_SOURCE).toContain("useSustainedNote");
    expect(RANGE_LOOP_HOOK_SOURCE).toContain("referencePlayback");
    expect(stage).toContain("<NotePlaybackToggle");
    expect(stage).toContain("playback={session.referencePlayback}");
    expect(implementationSource).not.toMatch(/BRIEF_REFERENCE_SECONDS|useSessionEffectScope|\bplayTone\s*\(|\bDrone\b|playSafely/);
    const startAndFinish = RANGE_LOOP_HOOK_SOURCE.slice(
      RANGE_LOOP_HOOK_SOURCE.indexOf("const start ="),
      RANGE_LOOP_HOOK_SOURCE.indexOf("const changeFamily ="),
    );
    expect(startAndFinish).not.toMatch(/referencePlayback|\.toggle\s*\(|\.release\s*\(/);
  });

  it("uses fixed cumulative credit and reversible outside-range scheduling", () => {
    const stage = activeSources.find(({ fileName }) => fileName === "RangeLoopStage.tsx")?.source ?? "";
    const settings = activeSources.find(({ fileName }) => fileName === "RangeLoopSettings.tsx")?.source ?? "";
    expect(RANGE_LOOP_CREDIT_SOURCE).toContain("RANGE_LOOP_CREDIT_GOAL_SECONDS = 30");
    expect(RANGE_LOOP_CREDIT_SOURCE).toContain("none of them erase credit already collected");
    expect(stage).toContain('holdMode="collective"');
    expect(stage).toContain("I can&apos;t reach this note");
    expect(stage).toContain("recheckExcludedNotes");
    expect(settings).not.toMatch(/Hold|RANGE_LOOP_HOLD_OPTIONS|changeHold/);
    expect(implementationSource).not.toMatch(/resetHold|Reset hold/);
  });

  it("keeps all six full-depth families data-driven in the settings surface", () => {
    const settings = activeSources.find(({ fileName }) => fileName === "RangeLoopSettings.tsx")?.source ?? "";
    expect(settings).toContain("RANGE_FAMILIES.map");
    expect(settings).not.toMatch(/foundation.*deep.*low.*middle.*high.*upper/s);
  });

  it.each(FORBIDDEN_RANGE_LOOP_CONCEPTS)(
    "does not restore obsolete %s machinery",
    (label, pattern) => {
      expect(
        pattern.test(implementationSource),
        `Range Loop implementation still contains forbidden ${label} machinery.`,
      ).toBe(false);
    },
  );

  it.each(OBSOLETE_ACTIVE_SOURCE_IDENTIFIERS)(
    "removes obsolete %s identifiers from active Range Loop sources",
    (label, pattern) => {
      const offenders = activeSources
        .filter(({ source }) => pattern.test(source))
        .map(({ fileName }) => fileName);
      expect(
        offenders,
        `Obsolete ${label} identifiers remain in: ${offenders.join(", ")}.`,
      ).toEqual([]);
    },
  );
});
