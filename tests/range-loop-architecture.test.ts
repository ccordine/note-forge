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
    expect(RANGE_LOOP_HOOK_SOURCE).toContain("reduceRangeDwell");
    expect(RANGE_LOOP_HOOK_SOURCE).toContain('dwellSession.observe({ type: "observation", observation })');
    expect(implementationSource).not.toMatch(/\bsetDwell\b|input\.(?:enable|disable)\s*\(/);
  });

  it("uses the shared abort-scoped brief reference", () => {
    expect(RANGE_LOOP_HOOK_SOURCE).toContain("useSessionEffectScope");
    expect(RANGE_LOOP_HOOK_SOURCE).toContain("BRIEF_REFERENCE_SECONDS");
    expect(implementationSource).not.toContain("playSafely");
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
