import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FEATURE_ROOT = join(
  process.cwd(),
  "apps/web/src/features/voice-arcade/vocal-flight",
);

function productionSource(): string {
  return readdirSync(FEATURE_ROOT)
    .filter((file) => /\.(?:ts|tsx)$/u.test(file))
    .map((file) => readFileSync(join(FEATURE_ROOT, file), "utf8"))
    .join("\n");
}

describe("Vocal Flight architecture boundary", () => {
  it("owns no capture, detector, raw audio, playback, or feature persistence", () => {
    const source = productionSource();
    expect(source).not.toMatch(/getUserMedia|MicrophoneCapture|AudioContext|webkitAudioContext/u);
    expect(source).not.toMatch(/MediaStream|AudioWorklet|detectPitch|Yin|\.samples\b/u);
    expect(source).not.toMatch(/input\.(?:enable|disable)|track\.stop|\.suspend\(|\.resume\(/u);
    expect(source).not.toMatch(/OscillatorNode|createOscillator|createBufferSource|MediaRecorder/u);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|SettingsPersistence/u);
  });

  it("keeps audio and simulation clocks outside React", () => {
    const hook = readFileSync(join(FEATURE_ROOT, "use-vocal-flight.ts"), "utf8");
    const session = readFileSync(join(FEATURE_ROOT, "vocal-flight-session.ts"), "utf8");
    const canvas = readFileSync(join(FEATURE_ROOT, "VocalFlightCanvas.tsx"), "utf8");
    expect(hook).toContain("useAudioInput");
    expect(hook).toContain("realtime.observe");
    expect(hook).not.toMatch(/useState|setState/u);
    expect(session).not.toMatch(/Date\.now|performance\.now|requestAnimationFrame|setTimeout|setInterval/u);
    expect(canvas).toContain("requestAnimationFrame");
    expect(canvas).toContain("sceneReaderRef.current()");
    expect(canvas).not.toMatch(/\badvanceVocalFlight\b|\breduceVocalFlight\b|\bonFrame\b/u);
  });

  it("keeps course achievement separate from the whole-session Finish score", () => {
    const session = readFileSync(join(FEATURE_ROOT, "vocal-flight-session.ts"), "utf8");
    expect(session).toContain("readonly achievementResult: VocalFlightScoreResult | null");
    expect(session).toContain("const scoring = advanceVocalFlightScore(state.scoring");
    expect(session).toContain("result: summarizeVocalFlightScore(scoring)");
    expect(session).not.toContain("achievementAlreadyLatched");
    expect(session).not.toContain("result: state.result ??");
  });

  it("is one registry entry whose removal requires no shell or route branch", () => {
    const registry = readFileSync(
      join(process.cwd(), "apps/web/src/features/voice-arcade/arcade-registry.tsx"),
      "utf8",
    );
    const shell = readFileSync(
      join(process.cwd(), "apps/web/src/features/voice-arcade/VoiceArcade.tsx"),
      "utf8",
    );
    const navigation = readFileSync(join(process.cwd(), "apps/web/src/navigation.ts"), "utf8");
    expect(registry.match(/\bflight:\s*\{/gu)).toHaveLength(1);
    expect(registry).toContain('import("./vocal-flight/VocalFlight")');
    expect(shell).not.toMatch(/VocalFlight|mode\s*===\s*["']flight/u);
    expect(navigation).not.toMatch(/VocalFlight|activity:\s*["']flight/u);
  });

  it("mounts one stable canvas and one vocal reticle outside phase overlays", () => {
    const component = readFileSync(join(FEATURE_ROOT, "VocalFlight.tsx"), "utf8");
    expect(component.match(/<VocalFlightCanvas\b/gu)).toHaveLength(1);
    expect(component.match(/<VocalControlReticle\b/gu)).toHaveLength(1);
    expect(component).not.toMatch(/<NoteInput\b|INPUT LEVEL|level meter/iu);
    expect(component.indexOf("<VocalFlightCanvas")).toBeLessThan(component.indexOf("{overlay("));
    expect(component.indexOf("<VocalControlReticle")).toBeLessThan(component.indexOf("{overlay("));
  });
});
