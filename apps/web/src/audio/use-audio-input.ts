import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { flushSync } from "react-dom";
import {
  AudioKernel,
  type AudioCounterSnapshot,
  type AudioHistorySnapshot,
  type AudioInputController,
  type AudioPitchSnapshot,
  type AudioTelemetrySnapshot,
  type AudioTransportSnapshot,
  type UseAudioInputOptions,
} from "./audio-kernel";
import {
  AUDIO_MONITORING_STORAGE_KEY,
  normalizeAudioMonitoringSettings,
} from "./audio-monitoring-settings";
import type {
  AudioMonitoringController,
  AudioMonitoringSnapshot,
} from "./audio-monitoring";
import {
  SettingsPersistence,
  type SettingsPersistenceResult,
} from "@/storage/settings-persistence";

export {
  type AudioCounterSnapshot,
  type AudioHistorySnapshot,
  type AudioInputController,
  type AudioInputState,
  type AudioPitchSnapshot,
  type AudioTelemetrySnapshot,
  type AudioTransportSnapshot,
  type InputTelemetry,
  type UseAudioInputOptions,
} from "./audio-kernel";

const AudioKernelContext = createContext<AudioKernel | null>(null);

interface MonitoringPreferencesContextValue {
  readonly controller: AudioMonitoringController;
  readonly ready: boolean;
  readonly persistenceState: SettingsPersistenceResult | "loading";
  readonly setEnabled: (enabled: boolean) => void;
  readonly setLevel: (level: number) => void;
}

interface MonitoringPersistenceSnapshot {
  readonly ready: boolean;
  readonly state: SettingsPersistenceResult | "loading";
}

export interface AudioMonitoringPreferences extends AudioMonitoringSnapshot {
  readonly ready: boolean;
  readonly persistenceState: SettingsPersistenceResult | "loading";
  readonly setEnabled: (enabled: boolean) => void;
  readonly setLevel: (level: number) => void;
  readonly selectOutput: () => Promise<void>;
}

const MonitoringPreferencesContext = createContext<MonitoringPreferencesContextValue | null>(null);

function requiredKernel(kernel: AudioKernel | null): AudioKernel {
  if (!kernel) throw new Error("Audio input hooks must be used inside AudioInputProvider");
  return kernel;
}

function selectedController(
  provided: AudioInputController | undefined,
  kernel: AudioKernel | null,
): AudioInputController {
  if (provided) return provided;
  return requiredKernel(kernel).controller;
}

export function AudioInputProvider({ children }: PropsWithChildren) {
  const kernelRef = useRef<AudioKernel | null>(null);
  if (kernelRef.current === null) kernelRef.current = new AudioKernel();
  const kernel = kernelRef.current;
  const monitoring = kernel.monitoringController;
  const persistenceRef = useRef<SettingsPersistence<typeof AUDIO_MONITORING_STORAGE_KEY> | null>(null);
  if (persistenceRef.current === null) {
    persistenceRef.current = new SettingsPersistence([AUDIO_MONITORING_STORAGE_KEY]);
  }
  const persistence = persistenceRef.current;
  const [monitoringPersistence, publishMonitoringPersistence] = useReducer(
    (
      _current: MonitoringPersistenceSnapshot,
      next: MonitoringPersistenceSnapshot,
    ) => next,
    Object.freeze({ ready: false, state: "loading" as const }),
  );

  useEffect(() => () => kernel.destroy(), [kernel]);
  useEffect(() => monitoring.subscribePreferredOutput((settings) => {
    persistence.save(
      [{ key: AUDIO_MONITORING_STORAGE_KEY, value: settings }],
      (state) => publishMonitoringPersistence(Object.freeze({ ready: true, state })),
    );
  }), [monitoring, persistence]);
  useEffect(() => {
    void persistence.load().then((stored) => {
      if (!stored) return;
      const saved = normalizeAudioMonitoringSettings(
        stored.values[AUDIO_MONITORING_STORAGE_KEY],
      );
      // Storage can never gate microphone access. If the user enabled voice
      // before IndexedDB answered, keep monitoring safely Off for this run
      // instead of making a delayed storage callback suddenly audible.
      monitoring.configure(kernel.controller.state === "disabled"
        ? saved
        : Object.freeze({ ...saved, enabled: false }));
      publishMonitoringPersistence(Object.freeze({
        ready: true,
        state: stored.readableKeys.has(AUDIO_MONITORING_STORAGE_KEY) ? "saved" : "error",
      }));
    }).catch(() => {
      publishMonitoringPersistence(Object.freeze({ ready: true, state: "error" }));
    });
    return () => persistence.dispose();
  }, [kernel, monitoring, persistence]);

  const saveMonitoring = useCallback(() => {
    persistence.save(
      [{ key: AUDIO_MONITORING_STORAGE_KEY, value: monitoring.getSettings() }],
      (state) => publishMonitoringPersistence(Object.freeze({ ready: true, state })),
    );
  }, [monitoring, persistence]);
  const setEnabled = useCallback((enabled: boolean) => {
    monitoring.setEnabled(enabled);
    saveMonitoring();
  }, [monitoring, saveMonitoring]);
  const setLevel = useCallback((level: number) => {
    monitoring.setLevel(level);
    saveMonitoring();
  }, [monitoring, saveMonitoring]);
  const monitoringPreferences = useMemo<MonitoringPreferencesContextValue>(() => ({
    controller: monitoring,
    ready: monitoringPersistence.ready,
    persistenceState: monitoringPersistence.state,
    setEnabled,
    setLevel,
  }), [monitoring, monitoringPersistence, setEnabled, setLevel]);

  return createElement(
    AudioKernelContext.Provider,
    { value: kernel },
    createElement(
      MonitoringPreferencesContext.Provider,
      { value: monitoringPreferences },
      children,
    ),
  );
}

/** Global, persisted audio-environment settings; never detector-rate state. */
export function useAudioMonitoring(): AudioMonitoringPreferences {
  const context = useContext(MonitoringPreferencesContext);
  if (!context) {
    throw new Error("useAudioMonitoring must be used inside AudioInputProvider");
  }
  const snapshot = useSyncExternalStore(
    context.controller.subscribe,
    context.controller.getSnapshot,
    context.controller.getSnapshot,
  );
  return useMemo(() => ({
    ...snapshot,
    ready: context.ready,
    persistenceState: context.persistenceState,
    setEnabled: context.setEnabled,
    setLevel: context.setLevel,
    selectOutput: context.controller.selectOutput,
  }), [context, snapshot]);
}

/**
 * Returns one stable imperative controller and subscribes React only to slow
 * transport changes. Detector observations continue through `onFrame` outside
 * the React render clock.
 */
export function useAudioInput(options: UseAudioInputOptions = {}): AudioInputController {
  const kernel = requiredKernel(useContext(AudioKernelContext));
  const controller = kernel.controller;
  const optionsRef = useRef(options);
  const consumerIdRef = useRef<symbol | null>(null);
  optionsRef.current = options;
  if (consumerIdRef.current === null) consumerIdRef.current = Symbol("audio-input-consumer");
  useLayoutEffect(
    () => kernel.attach(consumerIdRef.current!, () => optionsRef.current),
    [kernel],
  );
  useSyncExternalStore(
    controller.subscribeTransport,
    controller.getTransportSnapshot,
    controller.getTransportSnapshot,
  );
  return controller;
}

/** Transport-only observer; live pitch changes cannot invalidate its caller. */
export function useAudioInputStatus(): AudioInputController {
  const controller = requiredKernel(useContext(AudioKernelContext)).controller;
  useSyncExternalStore(
    controller.subscribeTransport,
    controller.getTransportSnapshot,
    controller.getTransportSnapshot,
  );
  return controller;
}

export function useAudioTransportSnapshot(
  input?: AudioInputController,
): AudioTransportSnapshot {
  const controller = selectedController(input, useContext(AudioKernelContext));
  return useSyncExternalStore(
    controller.subscribeTransport,
    controller.getTransportSnapshot,
    controller.getTransportSnapshot,
  );
}

export function useAudioPitchSnapshot(
  input?: AudioInputController,
): AudioPitchSnapshot {
  const controller = selectedController(input, useContext(AudioKernelContext));
  const [snapshot, publish] = useReducer(
    (_current: AudioPitchSnapshot, next: AudioPitchSnapshot) => next,
    controller,
    (source) => source.getPitchSnapshot(),
  );
  useLayoutEffect(() => {
    publish(controller.getPitchSnapshot());
    return controller.subscribePitch((next, immediate) => {
      if (immediate) {
        flushSync(() => publish(next));
      } else {
        publish(next);
      }
    });
  }, [controller]);
  return snapshot;
}

export function useAudioCounterSnapshot(
  input?: AudioInputController,
): AudioCounterSnapshot {
  const controller = selectedController(input, useContext(AudioKernelContext));
  return useSyncExternalStore(
    controller.subscribeCounters,
    controller.getCounterSnapshot,
    controller.getCounterSnapshot,
  );
}

export function useAudioTelemetrySnapshot(
  input?: AudioInputController,
): AudioTelemetrySnapshot {
  const controller = selectedController(input, useContext(AudioKernelContext));
  return useSyncExternalStore(
    controller.subscribeTelemetry,
    controller.getTelemetrySnapshot,
    controller.getTelemetrySnapshot,
  );
}

/** Opt-in bounded history snapshot; ordinary consumers never pay for copies. */
export function useAudioHistorySnapshot(
  input?: AudioInputController,
): AudioHistorySnapshot {
  const controller = selectedController(input, useContext(AudioKernelContext));
  return useSyncExternalStore(
    controller.subscribeHistory,
    controller.getHistorySnapshot,
    controller.getHistorySnapshot,
  );
}
