import type { MicrophoneCapture } from "./microphone";
import {
  DEFAULT_AUDIO_MONITORING_SETTINGS,
  preferredAudioOutputSettings,
  type AudioMonitoringSettings,
  type PreferredAudioOutputSettings,
} from "./audio-monitoring-settings";
import {
  routeSharedAudioOutput,
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
  readonly preferredOutput: PreferredAudioOutputSettings | null;
  readonly outputLabel: string;
  readonly outputSelectionSupported: boolean;
  readonly outputState: "idle" | "selecting" | "error";
  readonly outputError: string;
}

type Listener = () => void;
type PreferredOutputListener = (settings: AudioMonitoringSettings) => void;

export interface AudioMonitoringController {
  readonly getSnapshot: () => AudioMonitoringSnapshot;
  readonly getSettings: () => AudioMonitoringSettings;
  readonly subscribe: (listener: Listener) => () => void;
  readonly subscribePreferredOutput: (listener: PreferredOutputListener) => () => void;
  readonly configure: (settings: AudioMonitoringSettings) => void;
  readonly setEnabled: (enabled: boolean) => void;
  readonly setLevel: (level: number) => void;
  readonly selectOutput: () => Promise<void>;
}

/** Slow global audio-environment authority; never runs on detector cadence. */
export class AudioMonitoring {
  private readonly listeners = new Set<Listener>();
  private readonly preferredOutputListeners = new Set<PreferredOutputListener>();
  private running = false;
  private outputOperationRevision = 0;
  private snapshot: AudioMonitoringSnapshot = Object.freeze({
    enabled: DEFAULT_AUDIO_MONITORING_SETTINGS.enabled,
    level: DEFAULT_AUDIO_MONITORING_SETTINGS.level,
    effective: false,
    contextInfo: null,
    preferredOutput: DEFAULT_AUDIO_MONITORING_SETTINGS.preferredOutput,
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
      getSettings: monitoring.getSettings,
      subscribe: monitoring.subscribe,
      subscribePreferredOutput: monitoring.subscribePreferredOutput,
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

  private publishPreferredOutput(): void {
    const settings = this.getSettings();
    for (const listener of this.preferredOutputListeners) listener(settings);
  }

  private apply(
    enabled: boolean,
    level: number,
    output: Partial<Pick<
      AudioMonitoringSnapshot,
      "preferredOutput" | "outputLabel" | "outputState" | "outputError"
    >> = {},
  ): void {
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
      ...output,
    });
  }

  readonly getSnapshot = () => this.snapshot;
  readonly getSettings = (): AudioMonitoringSettings => Object.freeze({
    version: 2,
    enabled: this.snapshot.enabled,
    level: this.snapshot.level,
    preferredOutput: this.snapshot.preferredOutput,
  });
  readonly subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly subscribePreferredOutput = (listener: PreferredOutputListener) => {
    this.preferredOutputListeners.add(listener);
    return () => this.preferredOutputListeners.delete(listener);
  };

  readonly configure = (settings: AudioMonitoringSettings): void => {
    this.outputOperationRevision += 1;
    const preferredOutput = this.snapshot.outputSelectionSupported
      ? settings.preferredOutput
      : null;
    const unsupportedSavedOutput = settings.preferredOutput !== null
      && preferredOutput === null;
    this.apply(settings.enabled, settings.level, {
      preferredOutput,
      outputLabel: preferredOutput?.label ?? "System default",
      outputState: unsupportedSavedOutput ? "error" : "idle",
      outputError: unsupportedSavedOutput
        ? "The saved audio output is unavailable in this browser. Using System default."
        : "",
    });
    if (unsupportedSavedOutput) this.publishPreferredOutput();
    if (this.running && preferredOutput) void this.restorePreferredOutput(preferredOutput);
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
    if (running && this.snapshot.preferredOutput) {
      void this.restorePreferredOutput(this.snapshot.preferredOutput);
    }
  }

  private async restorePreferredOutput(
    preferredOutput: PreferredAudioOutputSettings,
  ): Promise<void> {
    const revision = ++this.outputOperationRevision;
    try {
      const contextInfo = await routeSharedAudioOutput(preferredOutput.deviceId);
      if (
        revision !== this.outputOperationRevision
        || this.snapshot.preferredOutput?.deviceId !== preferredOutput.deviceId
      ) return;
      this.publish({
        ...this.snapshot,
        outputLabel: preferredOutput.label,
        contextInfo,
        outputState: "idle",
        outputError: "",
      });
    } catch {
      if (revision !== this.outputOperationRevision) return;
      this.publish({
        ...this.snapshot,
        preferredOutput: null,
        outputLabel: "System default",
        outputState: "error",
        outputError: "The saved audio output is no longer available. Using System default.",
      });
      this.publishPreferredOutput();
    }
  }

  readonly selectOutput = async (): Promise<void> => {
    if (!this.snapshot.outputSelectionSupported) return;
    const revision = ++this.outputOperationRevision;
    this.publish({ ...this.snapshot, outputState: "selecting", outputError: "" });
    try {
      const output = await selectSharedAudioOutput();
      if (revision !== this.outputOperationRevision) return;
      const preferredOutput = preferredAudioOutputSettings(output.deviceId, output.label);
      this.publish({
        ...this.snapshot,
        preferredOutput,
        outputLabel: preferredOutput?.label ?? "System default",
        contextInfo: output.contextInfo,
        outputState: "idle",
        outputError: "",
      });
      this.publishPreferredOutput();
    } catch (error) {
      if (revision !== this.outputOperationRevision) return;
      this.publish({
        ...this.snapshot,
        outputState: "error",
        outputError: error instanceof Error ? error.message : "Could not select audio output.",
      });
    }
  };
}
