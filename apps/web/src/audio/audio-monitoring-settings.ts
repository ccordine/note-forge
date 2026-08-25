import { MICROPHONE_MONITOR_DEFAULT_LEVEL } from "./microphone-environment";

export const AUDIO_MONITORING_STORAGE_KEY = "audio.monitoring";

export interface AudioMonitoringSettings {
  readonly version: 1;
  readonly enabled: boolean;
  readonly level: number;
}

export const DEFAULT_AUDIO_MONITORING_SETTINGS: AudioMonitoringSettings = Object.freeze({
  version: 1,
  enabled: false,
  level: MICROPHONE_MONITOR_DEFAULT_LEVEL,
});

export function normalizeAudioMonitoringSettings(
  candidate: unknown,
): AudioMonitoringSettings {
  if (candidate === undefined) return DEFAULT_AUDIO_MONITORING_SETTINGS;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return DEFAULT_AUDIO_MONITORING_SETTINGS;
  }
  const value = candidate as Partial<AudioMonitoringSettings>;
  if (
    value.version !== 1
    || typeof value.enabled !== "boolean"
    || typeof value.level !== "number"
    || !Number.isFinite(value.level)
    || value.level < 0
    || value.level > 1
  ) return DEFAULT_AUDIO_MONITORING_SETTINGS;
  return Object.freeze({ version: 1, enabled: value.enabled, level: value.level });
}
