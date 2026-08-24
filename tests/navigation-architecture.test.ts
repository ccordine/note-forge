import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) => readFileSync(
  new URL(`../apps/web/src/${relativePath}`, import.meta.url),
  "utf8",
);

const app = source("App.tsx");
const main = source("main.tsx");
const navigation = source("navigation.ts");
const router = source("routing/use-app-navigation.ts");
const controls = source("ui/Controls.tsx");
const musical = source("state/MusicalContext.tsx");
const preferences = source("state/UserPreferencesContext.tsx");
const practice = source("features/practice/Practice.tsx");
const home = source("features/home/Home.tsx");

describe("navigation architecture", () => {
  it("delegates hash/history ownership to the maintained router", () => {
    expect(main).toContain('import { HashRouter } from "react-router"');
    expect(main).toContain("<HashRouter>");
    expect(router).toContain("matchRoutes");
    expect(router).toContain("useLocation");
    expect(router).toContain("useNavigate");
    expect(controls).toContain('import { Link, type LinkProps } from "react-router"');
    expect(controls).toContain("<Link");
    expect(app + router + controls).not.toMatch(/hashchange|popstate|pushState|replaceState|location\.hash/);
  });

  it("deletes the aggregate LabContext authority", () => {
    expect(existsSync(new URL("../apps/web/src/state/LabContext.tsx", import.meta.url))).toBe(false);
    expect(musical).not.toMatch(/route|navigate|toleranceCents|expertMode|labelsHidden/);
    expect(preferences).not.toMatch(/selectedMidi|tonicPitchClass|scaleId|chordQuality|timbre|route|navigate/);
    expect(main).toContain("<MusicalProvider><UserPreferencesProvider>");
  });

  it("gives App only Home plus five product-surface render authorities", () => {
    expect(app).toContain("const SURFACES = {");
    expect(app).toContain("practice: lazy(");
    expect(app).toContain("arcade: lazy(");
    expect(app).toContain("explore: lazy(");
    expect(app).toContain("songs: lazy(");
    expect(app).toContain("progress: lazy(");
    expect(app).not.toMatch(/const SCREENS|PitchMirror|HumLab|RangeLoop|PitchControl|EarLab|IntervalLab|HarmonyLab|MelodyLab/);
    expect(navigation).toContain('"Practice"');
    expect(navigation).toContain('"Arcade"');
    expect(navigation).toContain('"Explore"');
    expect(navigation).toContain('"Songs"');
    expect(navigation).toContain('"Progress"');
  });

  it("makes Practice own its selector and activity dispatch", () => {
    expect(practice).toContain("const ACTIVITIES = {");
    expect(practice).toContain('aria-label="Practice activity"');
    expect(practice).toContain("ACTIVITIES[route.activity]");
    expect(app).not.toContain("PRACTICE_ACTIVITIES");
  });

  it("uses native dialogs instead of hand-written focus traps", () => {
    expect(app.match(/<dialog/g) ?? []).toHaveLength(2);
    expect(app).toContain("showModal()");
    expect(app).not.toMatch(/FOCUSABLE|querySelectorAll<HTMLElement>|addEventListener\("keydown"|event\.key === "Tab"/);
  });

  it("keeps global voice enable/stop/retry in the shell", () => {
    expect(app).toContain("data-global-mic-enable");
    expect(app).toContain("data-global-mic-disable");
    expect(app).toContain("Enable voice");
    expect(app).toContain("Retry voice");
  });

  it("routes Home work directly into product-owned activities", () => {
    expect(home).toContain('route={{ surface: "practice", activity: "pitch-match", mode: "cold" }}');
    expect(home).toContain('route={{ surface: "practice", activity: "intervals", mode: "production" }}');
    expect(home).not.toMatch(/page:\s*"(?:mirror|intervals|sound|loop|song)"/);
  });

  it.each([
    ["features/sound-lab/SoundLab.tsx", "explore", "sound"],
    ["features/pitch-mirror/PitchMirror.tsx", "practice", "pitch-match"],
    ["features/hum-lab/HumLab.tsx", "practice", "hum"],
    ["features/pitch-control/PitchControl.tsx", "practice", "pitch-control"],
    ["features/ear-training/EarLab.tsx", "practice", "note-recognition"],
    ["features/intervals/IntervalLab.tsx", "practice", "intervals"],
    ["features/harmony/HarmonyLab.tsx", "practice", "harmony"],
    ["features/melody/MelodyLab.tsx", "practice", "melody"],
  ] as const)("keeps %s mode in the exact typed activity URL", (file, surface, activity) => {
    const feature = source(file);
    expect(feature).toContain(`route.surface === "${surface}"`);
    expect(feature).toContain(`route.activity === "${activity}"`);
    expect(feature).toContain(`navigate({ surface: "${surface}", activity: "${activity}", mode:`);
  });

  it("makes every Arcade cabinet and return path a deep link", () => {
    const arcade = source("features/voice-arcade/VoiceArcade.tsx");
    expect(arcade).toContain('route={{ surface: "arcade", activity: id }}');
    expect(arcade).toContain('route={{ surface: "arcade", activity: "cabinet" }}');
    expect(arcade).toContain('route={{ surface: "arcade", activity: ARCADE_FEATURED_GAME.mode }}');
  });
});
