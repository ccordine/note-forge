import type { MicrophoneCapture } from "./microphone";
import {
  DEFAULT_AUDIO_MONITORING_SETTINGS,
  type AudioMonitoringSettings,
} from "./audio-monitoring-settings";
import {
  selectSharedAudioOutput,
  supportsSharedAudioOutputSelection,
} from "./audio-output-routing";
import { requireMonitorLevel } from "./microphone-environment";
import type { AudioContextInfo } from "./microphone-environment";

export interface AudioMonitoringSnapshot {
  readonly enabled: boolean;
  readonly level: number;
  readonly effective: boolean;
  readonly contextInfo: AudioContextInfo | null;
  readonly outputLabel: string;
  readonly outputSelectionSupported: boolean;
  readonly outputState: "idle" | "selecting" | "error";
  readonly outputError: string;
}

type Listener = () => void;

export interface AudioMonitoringController {
  readonly getSnapshot: () => AudioMonitoringSnapshot;
  readonly subscribe: (listener: Listener) => () => void;
  readonly configure: (settings: AudioMonitoringSettings) => void;
  readonly setEnabled: (enabled: boolean) => void;
  readonly setLevel: (level: number) => void;
  readonly selectOutput: () => Promise<void>;
}

/** Slow global audio-environment authority; never runs on detector cadence. */
export class AudioMonitoring {
  private readonly listeners = new Set<Listener>();
  private running = false;
  private snapshot: AudioMonitoringSnapshot = Object.freeze({
    enabled: DEFAULT_AUDIO_MONITORING_SETTINGS.enabled,
    level: DEFAULT_AUDIO_MONITORING_SETTINGS.level,
    effective: false,
    contextInfo: null,
    outputLabel: "System default",
    outputSelectionSupported: supportsSharedAudioOutputSelection(),
    outputState: "idle",
    outputError: "",
  });
  readonly controller: AudioMonitoringController;

  constructor(private readonly capture: MicrophoneCapture) {
    const monitoring = this;
    this.controller = Object.freeze({
      getSnapshot: monitoring.getSnapshot,
      subscribe: monitoring.subscribe,
      configure: monitoring.configure,
      setEnabled: monitoring.setEnabled,
      setLevel: monitoring.setLevel,
      selectOutput: monitoring.selectOutput,
    });
  }

  private publish(next: AudioMonitoringSnapshot): void {
    this.snapshot = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }

  private apply(enabled: boolean, level: number): void {
    this.capture.setMonitoring(this.running && enabled, level);
    const captureInfo = this.capture.getInfo();
    const contextInfo = captureInfo
      ? Object.freeze({
          requestedLatencyHint: "interactive" as const,
          sampleRate: captureInfo.sampleRate,
          baseSeconds: captureInfo.latency?.baseSeconds ?? null,
          outputSeconds: captureInfo.latency?.outputSeconds ?? null,
        })
      : this.snapshot.contextInfo;
    this.publish({
      ...this.snapshot,
      enabled,
      level,
      effective: this.running && enabled,
      contextInfo,
    });
  }

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly configure = (settings: AudioMonitoringSettings): void => {
    this.apply(settings.enabled, settings.level);
  };

  readonly setEnabled = (enabled: boolean): void => {
    this.apply(enabled, this.snapshot.level);
  };

  readonly setLevel = (level: number): void => {
    requireMonitorLevel(level);
    this.apply(this.snapshot.enabled, level);
  };

  setInputRunning(running: boolean): void {
    this.running = running;
    this.apply(this.snapshot.enabled, this.snapshot.level);
  }

  readonly selectOutput = async (): Promise<void> => {
    if (!this.snapshot.outputSelectionSupported) return;
    this.publish({ ...this.snapshot, outputState: "selecting", outputError: "" });
    try {
      const output = await selectSharedAudioOutput();
      this.publish({
        ...this.snapshot,
        outputLabel: output.label,
        contextInfo: output.contextInfo,
        outputState: "idle",
        outputError: "",
      });
    } catch (error) {
      this.publish({
        ...this.snapshot,
        outputState: "error",
        outputError: error instanceof Error ? error.message : "Could not select audio output.",
      });
    }
  };
}
