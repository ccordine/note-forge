import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIO_MONITORING_SETTINGS,
  normalizeAudioMonitoringSettings,
} from "../apps/web/src/audio/audio-monitoring-settings";

describe("audio monitoring settings", () => {
  it("defaults off and restores only the exact bounded persisted shape", () => {
    expect(DEFAULT_AUDIO_MONITORING_SETTINGS).toEqual({
      version: 1,
      enabled: false,
      level: 0.65,
    });
    expect(normalizeAudioMonitoringSettings({
      version: 1,
      enabled: true,
      level: 0.73,
    })).toEqual({ version: 1, enabled: true, level: 0.73 });
    for (const invalid of [
      null,
      {},
      { version: 2, enabled: true, level: 0.5 },
      { version: 1, enabled: "true", level: 0.5 },
      { version: 1, enabled: true, level: -0.01 },
      { version: 1, enabled: true, level: 1.01 },
      { version: 1, enabled: true, level: Number.NaN },
    ]) {
      expect(normalizeAudioMonitoringSettings(invalid))
        .toBe(DEFAULT_AUDIO_MONITORING_SETTINGS);
    }
  });
});
