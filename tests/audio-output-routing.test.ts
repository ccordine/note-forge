import { afterEach, describe, expect, it, vi } from "vitest";

const { ensureAudioReady } = vi.hoisted(() => ({ ensureAudioReady: vi.fn() }));

vi.mock("../apps/web/src/audio/audio-context", () => ({ ensureAudioReady }));

import {
  selectSharedAudioOutput,
  supportsSharedAudioOutputSelection,
} from "../apps/web/src/audio/audio-output-routing";

describe("progressive shared audio output routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("truthfully reports unsupported browsers without creating audio", async () => {
    vi.stubGlobal("navigator", { mediaDevices: {} });
    vi.stubGlobal("AudioContext", class {});
    expect(supportsSharedAudioOutputSelection()).toBe(false);
    await expect(selectSharedAudioOutput()).rejects.toThrow("not supported");
    expect(ensureAudioReady).not.toHaveBeenCalled();
  });

  it("routes the one shared context only after the user-mediated chooser", async () => {
    const setSinkId = vi.fn(async () => undefined);
    class SupportedAudioContext {}
    Object.defineProperty(SupportedAudioContext.prototype, "setSinkId", {
      configurable: true,
      value: setSinkId,
    });
    const selectAudioOutput = vi.fn(async () => ({
      deviceId: "chosen-output",
      label: "USB Headphones",
    }));
    vi.stubGlobal("AudioContext", SupportedAudioContext);
    vi.stubGlobal("navigator", { mediaDevices: { selectAudioOutput } });
    ensureAudioReady.mockResolvedValue({
      setSinkId,
      sampleRate: 48_000,
      baseLatency: 0.005,
      outputLatency: 0.008,
    });

    expect(supportsSharedAudioOutputSelection()).toBe(true);
    await expect(selectSharedAudioOutput()).resolves.toEqual({
      label: "USB Headphones",
      contextInfo: {
        requestedLatencyHint: "interactive",
        sampleRate: 48_000,
        baseSeconds: 0.005,
        outputSeconds: 0.008,
      },
    });
    expect(ensureAudioReady).toHaveBeenCalledOnce();
    expect(selectAudioOutput).toHaveBeenCalledOnce();
    expect(selectAudioOutput.mock.invocationCallOrder[0]).toBeLessThan(
      ensureAudioReady.mock.invocationCallOrder[0]!,
    );
    expect(setSinkId).toHaveBeenCalledWith("chosen-output");
  });
});
