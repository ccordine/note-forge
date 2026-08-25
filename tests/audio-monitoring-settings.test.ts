import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIO_MONITORING_SETTINGS,
  normalizeAudioMonitoringSettings,
  preferredAudioOutputSettings,
} from "../apps/web/src/audio/audio-monitoring-settings";

describe("audio monitoring settings", () => {
  it("defaults off and restores only the exact bounded persisted shape", () => {
    expect(DEFAULT_AUDIO_MONITORING_SETTINGS).toEqual({
      version: 2,
      enabled: false,
      level: 0.65,
      preferredOutput: null,
    });
    expect(normalizeAudioMonitoringSettings({
      version: 1,
      enabled: true,
      level: 0.73,
    })).toEqual({ version: 2, enabled: true, level: 0.73, preferredOutput: null });
    expect(normalizeAudioMonitoringSettings({
      version: 2,
      enabled: true,
      level: 0.73,
      preferredOutput: { deviceId: "usb-output", label: "  USB Headphones  " },
    })).toEqual({
      version: 2,
      enabled: true,
      level: 0.73,
      preferredOutput: { deviceId: "usb-output", label: "USB Headphones" },
    });
    for (const invalid of [
      null,
      {},
      { version: 3, enabled: true, level: 0.5, preferredOutput: null },
      { version: 2, enabled: true, level: 0.5 },
      { version: 2, enabled: true, level: 0.5, preferredOutput: {} },
      { version: 2, enabled: true, level: 0.5, preferredOutput: { deviceId: "", label: "USB" } },
      { version: 2, enabled: true, level: 0.5, preferredOutput: { deviceId: "bad\ndevice", label: "USB" } },
      { version: 1, enabled: "true", level: 0.5 },
      { version: 1, enabled: true, level: -0.01 },
      { version: 1, enabled: true, level: 1.01 },
      { version: 1, enabled: true, level: Number.NaN },
    ]) {
      expect(normalizeAudioMonitoringSettings(invalid))
        .toBe(DEFAULT_AUDIO_MONITORING_SETTINGS);
    }
  });

  it("preserves opaque device ids and supplies a bounded fallback label", () => {
    expect(preferredAudioOutputSettings("  opaque id  ", "  ")).toEqual({
      deviceId: "  opaque id  ",
      label: "Selected audio output",
    });
    expect(preferredAudioOutputSettings("bad\ndevice", "Speaker")).toBeNull();
  });
});
