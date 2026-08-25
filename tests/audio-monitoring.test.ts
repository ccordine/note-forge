import { describe, expect, it, vi } from "vitest";
import { AudioMonitoring } from "../apps/web/src/audio/audio-monitoring";
import { DirectMicrophoneMonitor } from "../apps/web/src/audio/direct-microphone-monitor";
import type { MicrophoneCapture } from "../apps/web/src/audio/microphone";

describe("global audio monitoring authority", () => {
  it("keeps saved desire separate from effective microphone output", () => {
    const setMonitoring = vi.fn();
    const monitoring = new AudioMonitoring({
      setMonitoring,
      getInfo: () => ({
        sampleRate: 48_000,
        latency: { baseSeconds: 0.005, outputSeconds: 0.008 },
      }),
    } as unknown as MicrophoneCapture);
    const published = vi.fn();
    monitoring.controller.subscribe(published);

    monitoring.controller.configure({ version: 1, enabled: true, level: 0.73 });
    expect(monitoring.controller.getSnapshot()).toMatchObject({
      enabled: true,
      level: 0.73,
      effective: false,
    });
    expect(setMonitoring).toHaveBeenLastCalledWith(false, 0.73);

    monitoring.setInputRunning(true);
    expect(monitoring.controller.getSnapshot().effective).toBe(true);
    expect(monitoring.controller.getSnapshot().contextInfo).toEqual({
      requestedLatencyHint: "interactive",
      sampleRate: 48_000,
      baseSeconds: 0.005,
      outputSeconds: 0.008,
    });
    expect(setMonitoring).toHaveBeenLastCalledWith(true, 0.73);

    monitoring.setInputRunning(false);
    expect(monitoring.controller.getSnapshot()).toMatchObject({
      enabled: true,
      level: 0.73,
      effective: false,
    });
    expect(setMonitoring).toHaveBeenLastCalledWith(false, 0.73);
    expect(published).toHaveBeenCalledTimes(3);
  });

  it("has no automatic monitoring cutoff", () => {
    vi.useFakeTimers();
    try {
      const setMonitoring = vi.fn();
      const monitoring = new AudioMonitoring({
        setMonitoring,
        getInfo: () => null,
      } as unknown as MicrophoneCapture);
      monitoring.setInputRunning(true);
      monitoring.controller.setEnabled(true);
      const before = monitoring.controller.getSnapshot();

      vi.advanceTimersByTime(60 * 60 * 1_000);

      expect(monitoring.controller.getSnapshot()).toBe(before);
      expect(monitoring.controller.getSnapshot()).toMatchObject({
        enabled: true,
        effective: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("direct Web Audio monitor branch", () => {
  it("uses cancel-and-hold when available and the explicit fallback otherwise", () => {
    const destination = {};
    const source = { connect: vi.fn() };
    const primaryParam = {
      value: 0,
      cancelAndHoldAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    };
    const primaryGain = {
      gain: primaryParam,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const primary = new DirectMicrophoneMonitor({
      currentTime: 4,
      destination,
      createGain: () => primaryGain,
    } as unknown as AudioContext);
    primary.connect(source as unknown as MediaStreamAudioSourceNode);
    primary.set(true, 0.5);
    expect(source.connect).toHaveBeenCalledWith(primaryGain);
    expect(primaryGain.connect).toHaveBeenCalledWith(destination);
    expect(primaryParam.cancelAndHoldAtTime).toHaveBeenCalledWith(4);
    expect(primaryParam.cancelScheduledValues).not.toHaveBeenCalled();
    expect(primaryParam.linearRampToValueAtTime).toHaveBeenCalledWith(0.5, 4.005);

    const fallbackParam = {
      value: 0.2,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    };
    const fallback = new DirectMicrophoneMonitor({
      currentTime: 8,
      destination,
      createGain: () => ({
        gain: fallbackParam,
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
    } as unknown as AudioContext);
    fallback.set(false, 0.5);
    expect(fallbackParam.cancelScheduledValues).toHaveBeenCalledWith(8);
    expect(fallbackParam.setValueAtTime).toHaveBeenCalledWith(0, 8);
    expect(fallbackParam.linearRampToValueAtTime).toHaveBeenCalledWith(0, 8.005);
    expect(() => fallback.set(true, Number.NaN)).toThrow(RangeError);
  });
});
