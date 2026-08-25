export const MICROPHONE_MONITOR_DEFAULT_LEVEL = 0.65;
export const MICROPHONE_MONITOR_RAMP_SECONDS = 0.005;

export interface MicrophoneMonitorState {
  readonly enabled: boolean;
  readonly level: number;
}

export interface MicrophoneLatencyInfo {
  readonly baseSeconds: number | null;
  readonly outputSeconds: number | null;
  readonly inputSeconds: number | null;
}

export interface AudioContextInfo {
  readonly requestedLatencyHint: "interactive";
  readonly sampleRate: number;
  readonly baseSeconds: number | null;
  readonly outputSeconds: number | null;
}

type SupportedConstraintsWithLatency = MediaTrackSupportedConstraints & {
  readonly latency?: boolean;
};

type TrackSettingsWithLatency = MediaTrackSettings & {
  readonly latency?: number;
};

/** Raw music input request; unsupported hints are omitted, never assumed. */
export function rawMicrophoneConstraints(
  mediaDevices: MediaDevices,
): MediaTrackConstraints {
  const supported = mediaDevices.getSupportedConstraints?.() as
    | SupportedConstraintsWithLatency
    | undefined;
  return {
    channelCount: { ideal: 1 },
    echoCancellation: { ideal: false },
    noiseSuppression: { ideal: false },
    autoGainControl: { ideal: false },
    ...(supported?.latency ? { latency: { ideal: 0 } } : {}),
  };
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function audioContextInfo(context: AudioContext): AudioContextInfo {
  return Object.freeze({
    requestedLatencyHint: "interactive",
    sampleRate: context.sampleRate,
    baseSeconds: finiteNonNegative(context.baseLatency),
    outputSeconds: finiteNonNegative(context.outputLatency),
  });
}

/** These are browser-reported estimates, not measured microphone-to-ear RTT. */
export function microphoneLatencyInfo(
  context: AudioContext,
  settings: MediaTrackSettings,
): MicrophoneLatencyInfo {
  const contextInfo = audioContextInfo(context);
  const input = settings as TrackSettingsWithLatency;
  return Object.freeze({
    baseSeconds: contextInfo.baseSeconds,
    outputSeconds: contextInfo.outputSeconds,
    inputSeconds: finiteNonNegative(input.latency),
  });
}

export function requireMonitorLevel(level: number): void {
  if (!Number.isFinite(level) || level < 0 || level > 1) {
    throw new RangeError("Microphone monitor level must be between 0 and 1.");
  }
}
