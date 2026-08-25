import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(
  new URL(`../apps/web/src/${path}`, import.meta.url),
  "utf8",
);

describe("vocal monitoring architecture", () => {
  const context = source("audio/audio-context.ts");
  const capture = source("audio/microphone.ts");
  const direct = source("audio/direct-microphone-monitor.ts");
  const monitoring = source("audio/audio-monitoring.ts");
  const bridge = source("audio/use-audio-input.ts");
  const globalControl = source("ui/GlobalAudioControl.tsx");
  const settings = source("ui/AudioSettings.tsx");

  it("uses the one existing interactive realtime context without forcing sample rate", () => {
    expect(context).toContain('new AudioContext({ latencyHint: "interactive" })');
    expect(context.match(/new AudioContext\(/gu)).toHaveLength(1);
    expect(context).not.toMatch(/new AudioContext\(\{[^}]*sampleRate/su);
    expect(capture).toContain("ensureAudioReady()");
    expect(capture).not.toContain("new AudioContext");
  });

  it("keeps the direct monitor free of analysis, React, timers, and lifecycle ownership", () => {
    expect(direct).toContain("source.connect(this.output)");
    expect(direct).toContain("this.output.connect(context.destination)");
    expect(direct).toContain("linearRampToValueAtTime");
    expect(direct).not.toMatch(/AudioWorklet|Pitch|PCM|React|use[A-Z]|getUserMedia|setTimeout|setInterval|MediaStream\(/u);
  });

  it("replaces only the worklet branch during PCM repair", () => {
    expect(capture.match(/createMediaStreamSource\(/gu)).toHaveLength(1);
    expect(capture).toContain("this.source?.connect(nextWorklet)");
    expect(capture).toContain("source.disconnect(worklet)");
    expect(capture).not.toContain("const nextSource");
  });

  it("models saved desire separately from effective running output", () => {
    expect(monitoring).toContain("effective: this.running && enabled");
    expect(monitoring).toContain("this.capture.setMonitoring(this.running && enabled, level)");
    expect(monitoring).not.toMatch(/setTimeout|setInterval|duration|cutoff/u);
  });

  it("keeps user control global and exposes honest headphone/latency guidance", () => {
    expect(globalControl).toContain("data-global-monitor-toggle");
    expect(globalControl).toContain("useAudioMonitoring");
    expect(globalControl).toContain("Headphones only");
    expect(globalControl).not.toContain("Loading audio");
    expect(settings).toContain("Use wired headphones");
    expect(settings).toContain("not measured microphone-to-ear round-trip latency");
    expect(settings).not.toMatch(/measured round-trip latency(?!\.)/u);
  });

  it("never lets monitoring storage gate microphone access or become audible late", () => {
    expect(globalControl).toContain("<MicrophoneAction input={input} />");
    expect(globalControl).not.toContain("Loading audio");
    expect(globalControl).not.toMatch(/MicrophoneAction[^}]*ready/su);
    expect(bridge).toContain('kernel.controller.state === "disabled"');
    expect(bridge).toContain('Object.freeze({ ...saved, enabled: false })');
  });
});
