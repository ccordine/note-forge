import { MICROPHONE_MONITOR_DEFAULT_LEVEL } from "./microphone-environment";

export const AUDIO_MONITORING_STORAGE_KEY = "audio.monitoring";

export interface PreferredAudioOutputSettings {
  readonly deviceId: string;
  readonly label: string;
}

export interface AudioMonitoringSettings {
  readonly version: 2;
  readonly enabled: boolean;
  readonly level: number;
  readonly preferredOutput: PreferredAudioOutputSettings | null;
}

export const DEFAULT_AUDIO_MONITORING_SETTINGS: AudioMonitoringSettings = Object.freeze({
  version: 2,
  enabled: false,
  level: MICROPHONE_MONITOR_DEFAULT_LEVEL,
  preferredOutput: null,
});

function normalizedLevel(candidate: unknown): number | null {
  return typeof candidate === "number"
    && Number.isFinite(candidate)
    && candidate >= 0
    && candidate <= 1
    ? candidate
    : null;
}

function boundedOutputDeviceId(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  if (
    candidate.trim().length === 0
    || candidate.length > 1_024
    || /[\u0000-\u001f\u007f]/u.test(candidate)
  ) return null;
  // A device id is an opaque browser token. Validate it without changing it.
  return candidate;
}

function boundedOutputLabel(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const value = candidate.trim();
  if (
    value.length === 0
    || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) return null;
  return value;
}

export function preferredAudioOutputSettings(
  deviceId: unknown,
  label: unknown,
): PreferredAudioOutputSettings | null {
  const normalizedDeviceId = boundedOutputDeviceId(deviceId);
  if (normalizedDeviceId === null) return null;
  const normalizedLabel = boundedOutputLabel(label) ?? "Selected audio output";
  return Object.freeze({ deviceId: normalizedDeviceId, label: normalizedLabel });
}

export function normalizeAudioMonitoringSettings(
  candidate: unknown,
): AudioMonitoringSettings {
  if (candidate === undefined) return DEFAULT_AUDIO_MONITORING_SETTINGS;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return DEFAULT_AUDIO_MONITORING_SETTINGS;
  }
  const value = candidate as Readonly<Record<string, unknown>>;
  const level = normalizedLevel(value.level);
  if (
    typeof value.enabled !== "boolean"
    || level === null
  ) return DEFAULT_AUDIO_MONITORING_SETTINGS;
  if (value.version === 1) {
    return Object.freeze({
      version: 2,
      enabled: value.enabled,
      level,
      preferredOutput: null,
    });
  }
  if (value.version !== 2) return DEFAULT_AUDIO_MONITORING_SETTINGS;
  if (value.preferredOutput === null) {
    return Object.freeze({ version: 2, enabled: value.enabled, level, preferredOutput: null });
  }
  if (
    value.preferredOutput === undefined
    || typeof value.preferredOutput !== "object"
    || Array.isArray(value.preferredOutput)
  ) return DEFAULT_AUDIO_MONITORING_SETTINGS;
  const preferredOutput = preferredAudioOutputSettings(
    (value.preferredOutput as Readonly<Record<string, unknown>>).deviceId,
    (value.preferredOutput as Readonly<Record<string, unknown>>).label,
  );
  if (preferredOutput === null) return DEFAULT_AUDIO_MONITORING_SETTINGS;
  return Object.freeze({ version: 2, enabled: value.enabled, level, preferredOutput });
}
