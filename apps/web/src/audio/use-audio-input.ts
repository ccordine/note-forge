import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
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
  useEffect(() => () => kernel.destroy(), [kernel]);
  return createElement(AudioKernelContext.Provider, { value: kernel }, children);
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
