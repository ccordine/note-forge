import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../apps/web/src/features/song-lab/SongLab.tsx", import.meta.url),
  "utf8",
);
const hook = readFileSync(
  new URL("../apps/web/src/features/song-lab/use-song-workspace.ts", import.meta.url),
  "utf8",
);
const runtime = readFileSync(
  new URL("../apps/web/src/features/song-lab/song-workspace-runtime.ts", import.meta.url),
  "utf8",
);

describe("Song Lab architecture", () => {
  it("uses one bounded stage surface instead of stacking the whole workflow", () => {
    expect(source).toContain("SongStageNavigation");
    expect(source).toContain("stageView");
    const pageComponent = source.slice(source.indexOf("export function SongLab"));
    const pageReturn = pageComponent.slice(pageComponent.indexOf("return ("));
    expect(pageReturn).toContain("{stageView}");
    expect(pageReturn).not.toMatch(/<ConfigureSong|<PracticeSong|<ReviewSong/);
  });

  it("has one canonical voice input and no feature-owned microphone shutdown", () => {
    expect(source.match(/<NoteInput\b/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/input\.(?:disable|stop)|track\.stop|AudioContext/);
  });

  it("keeps the page component small and delegates resource ownership", () => {
    expect(source.split("\n").length).toBeLessThanOrEqual(500);
    const component = source.slice(source.indexOf("export function SongLab"));
    expect(component).not.toMatch(/useState|useRef|useEffect|setTimeout/);
  });

  it("pins recording controls to Practice and stops the recorder at route teardown", () => {
    expect(source).toContain("Finish the active take before leaving Practice");
    expect(source).toContain('disabled={recordingBusy && candidate.id !== "practice"}');
    expect(source).toContain("setStage={workspace.setStage}");
    expect(hook).toContain("runtime.recordingActive");
    expect(runtime).toContain("active.recorder.stop()");
    expect(runtime).toContain("this.detachRecorder(active.recorder)");
  });

  it("uses one bounded cancellation authority instead of lifecycle flag forests", () => {
    expect(runtime.match(/new AbortController\s*\(/g) ?? []).toHaveLength(1);
    expect(hook + runtime).not.toMatch(/\bmounted\b|\b\w*Generation\b|generationRef/);
    expect(hook).not.toMatch(/setTimeout|clearTimeout|MediaRecorder/);
    expect(runtime).not.toMatch(/input\.(?:enable|disable)|getUserMedia|AudioContext/);
  });
});
