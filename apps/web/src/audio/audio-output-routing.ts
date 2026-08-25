import { ensureAudioReady } from "./audio-context";
import { preferredAudioOutputSettings } from "./audio-monitoring-settings";
import {
  audioContextInfo,
  type AudioContextInfo,
} from "./microphone-environment";

interface MediaDevicesWithOutputSelection extends MediaDevices {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>;
}

interface AudioContextWithSink extends AudioContext {
  setSinkId?: (sinkId: string) => Promise<void>;
}

function outputMediaDevices(): MediaDevicesWithOutputSelection | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return null;
  return navigator.mediaDevices as MediaDevicesWithOutputSelection;
}

export function supportsSharedAudioOutputSelection(): boolean {
  const mediaDevices = outputMediaDevices();
  if (typeof mediaDevices?.selectAudioOutput !== "function") return false;
  if (typeof AudioContext === "undefined") return false;
  const prototype = AudioContext.prototype as AudioContextWithSink;
  return typeof prototype.setSinkId === "function";
}

export async function routeSharedAudioOutput(
  sinkId: string,
): Promise<AudioContextInfo> {
  const context = await ensureAudioReady() as AudioContextWithSink;
  if (typeof context.setSinkId !== "function") {
    throw new Error("Audio output routing is not supported in this browser.");
  }
  await context.setSinkId(sinkId);
  return audioContextInfo(context);
}

/** Selects the sink for the one shared context: monitoring and playback move together. */
export async function selectSharedAudioOutput(): Promise<Readonly<{
  deviceId: string;
  label: string;
  contextInfo: AudioContextInfo;
}>> {
  const mediaDevices = outputMediaDevices();
  if (
    typeof mediaDevices?.selectAudioOutput !== "function"
    || !supportsSharedAudioOutputSelection()
  ) {
    throw new Error("Audio output selection is not supported in this browser.");
  }
  // Invoke the permission-gated chooser before the first await so browsers
  // see the original Choose output gesture. Merely opening Settings never
  // creates or resumes audio state.
  const device = await mediaDevices.selectAudioOutput();
  const preferredOutput = preferredAudioOutputSettings(device.deviceId, device.label);
  if (!preferredOutput) {
    throw new Error("The browser returned an invalid audio output.");
  }
  const contextInfo = await routeSharedAudioOutput(preferredOutput.deviceId);
  return Object.freeze({
    ...preferredOutput,
    contextInfo,
  });
}
