import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(resolve(ROOT, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = `${directory}/${entry.name}`;
      return entry.isDirectory()
        ? sourceFiles(relative)
        : /\.[cm]?[jt]sx?$/u.test(entry.name) ? [relative] : [];
    });
}

const sustainedStore = read("apps/web/src/audio/sustained-note-playback.ts");
const sustainedHook = read("apps/web/src/audio/use-sustained-note.ts");
const canonicalToggle = read("apps/web/src/ui/NotePlaybackToggle.tsx");
const main = read("apps/web/src/main.tsx");
const applicationSources = sourceFiles("apps/web/src");
const featureComponents = sourceFiles("apps/web/src/features")
  .filter((path) => path.endsWith(".tsx"));

const isolatedNoteSurfaces: Readonly<Record<string, readonly string[]>> = Object.freeze({
  home: ["apps/web/src/features/home/Home.tsx"],
  pitchMatch: ["apps/web/src/features/pitch-mirror/PitchMirror.tsx"],
  hum: ["apps/web/src/features/hum-lab/HumLab.tsx"],
  pitchControl: ["apps/web/src/features/pitch-control/PitchControl.tsx"],
  rangeLoop: [
    "apps/web/src/features/range-loop/use-range-loop-session.ts",
    "apps/web/src/features/range-loop/RangeLoopStage.tsx",
  ],
  rangeSimulator: [
    "apps/web/src/features/range-simulator/use-range-simulator.ts",
    "apps/web/src/features/range-simulator/RangeSimulator.tsx",
  ],
  soundLab: ["apps/web/src/features/sound-lab/SoundLab.tsx"],
  noteFamily: ["apps/web/src/features/ear-training/NoteFamilyTrainer.tsx"],
  advancedEar: ["apps/web/src/features/ear-training/AdvancedEarActivity.tsx"],
  intervalProduction: ["apps/web/src/features/intervals/ProductionActivity.tsx"],
  scaleDegree: ["apps/web/src/features/harmony/ScaleDegreeActivity.tsx"],
  chordTone: ["apps/web/src/features/harmony/ChordToneActivity.tsx"],
  patternChallenge: ["apps/web/src/features/voice-arcade/PatternChallenge.tsx"],
  pitchMaze: ["apps/web/src/features/voice-arcade/PitchMaze.tsx"],
  resonance: ["apps/web/src/features/voice-arcade/Resonance.tsx"],
});

describe("central isolated-note playback authority", () => {
  it("makes duration, scheduling, decay, and automatic cutoff absent from the public lane", () => {
    const spec = sustainedStore.match(/export interface SustainedNoteSpec\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";
    const store = sustainedStore.slice(sustainedStore.indexOf("export class SustainedNotePlaybackStore"));

    expect(spec).toMatch(/frequencyHz[\s\S]*timbre[\s\S]*amplitude/u);
    expect(spec).not.toMatch(/duration|deadline|timeout|release|attack|decay|sustain|\bwhen\b/u);
    expect(store).not.toMatch(/setTimeout|setInterval|Date\.now|performance\.now/u);
    expect(sustainedHook).toContain("useEffect(() => () => store.release(owner)");
    expect(main).toContain("<SustainedNotePlaybackProvider>");
  });

  it("uses one canonical accessible Play/Stop toggle on every isolated-note surface", () => {
    for (const [name, paths] of Object.entries(isolatedNoteSurfaces)) {
      const source = paths.map(read).join("\n");
      expect(source, name).toContain("useSustainedNote");
      expect(source, name).toContain("<NotePlaybackToggle");
    }
    expect(canonicalToggle).toContain('const action = playback.playing ? "Stop" : "Play";');
    expect(canonicalToggle).toContain("aria-pressed={playback.playing}");
    expect(canonicalToggle).toContain('data-note-playback-toggle="true"');
  });

  it("rejects the deleted brief-reference contract everywhere in application source", () => {
    const offenders = applicationSources.filter((path) => (
      /BRIEF_REFERENCE_SECONDS|short-reference|brief reference|0\.5-second reference/iu.test(read(path))
    ));
    expect(offenders).toEqual([]);
  });

  it("rejects feature-owned single-tone synthesis without banning authored gestures", () => {
    const offenders = featureComponents.filter((path) => /\bplayTone\s*\(/u.test(read(path)));
    expect(offenders).toEqual([]);

    // Multi-note/chord/phrase transports deliberately remain authored-time
    // gestures and are not forced through the isolated-note lane.
    expect(read("apps/web/src/features/voice-arcade/PitchMaze.tsx")).toContain("playToneSequence");
    expect(read("apps/web/src/features/harmony/playback.ts")).toContain("playFrequencies");
    expect(read("apps/web/src/features/song-lab/use-song-workspace.ts")).toContain("SongWorkspaceRuntime");
  });
});
