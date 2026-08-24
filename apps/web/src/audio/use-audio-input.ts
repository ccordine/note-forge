import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { reduceLiveNote, type LiveNote } from "./live-note";
import {
  MICROPHONE_ANALYSIS_WINDOW_SIZE,
  MicrophoneCapture,
  type CapturedLevel,
  type CaptureTransportEvent,
  type MicrophoneInfo,
} from "./microphone";
import {
  NOTE_INPUT_DEFAULTS,
  NoteInputEngine,
  type PitchObservation,
} from "./note-input";
import {
  pitchDiagnostics,
  toDiagnosticToken,
  toFrameDiagnostic,
  toInputDiagnostic,
  type DiagnosticFlow,
  type TrackingDiagnostic,
} from "@/diagnostics/pitch-diagnostics";

export type AudioInputState = "disabled" | "opening" | "running" | "error";

/** Raw level telemetry. It describes PCM but never admits or rejects pitch. */
export type InputTelemetry = Readonly<CapturedLevel> & {
  readonly headroomDb: number;
};

export interface AudioInputDiagnosticContext {
  flow: DiagnosticFlow;
  phase: string;
  targetMidi?: number | null;
  toleranceCents?: number | null;
  stableMs?: number | null;
  requiredHoldMs?: number | null;
  resetReason?: string | null;
}

export interface UseAudioInputOptions {
  readonly onFrame?: (observation: Readonly<PitchObservation>) => void;
  readonly diagnostics?: AudioInputDiagnosticContext;
}

export interface AudioInputController {
  readonly state: AudioInputState;
  readonly error: string;
  readonly microphoneInfo: MicrophoneInfo | null;
  /** One observation for every overlapping detector window, including silence. */
  readonly frames: readonly Readonly<PitchObservation>[];
  readonly liveFrame: Readonly<PitchObservation> | undefined;
  /** Current musical note and continuous same-note occupancy, derived downstream. */
  readonly liveNote: Readonly<LiveNote> | null;
  readonly processedWindowCount: number;
  readonly processedSampleCount: number;
  readonly workletProcessCount: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly transportRepairCount: number;
  readonly telemetry: InputTelemetry | null;
  readonly telemetryHistory: readonly InputTelemetry[];
  readonly enable: () => Promise<MicrophoneInfo | null>;
  readonly disable: () => void;
  readonly getStream: () => MediaStream | null;
}

type OptionsReader = () => UseAudioInputOptions;

interface ConsumerRegistry {
  readers: Map<symbol, OptionsReader>;
  attach: (id: symbol, reader: OptionsReader) => () => void;
  current: () => UseAudioInputOptions;
}

function createConsumerRegistry(): ConsumerRegistry {
  const readers = new Map<symbol, OptionsReader>();
  return {
    readers,
    attach(id, reader) {
      readers.delete(id);
      readers.set(id, reader);
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        readers.delete(id);
      };
    },
    current() {
      const options = [...readers.values()].map((reader) => reader());
      const diagnostics = options.slice().reverse().find((option) => option.diagnostics)?.diagnostics;
      const frameConsumers = options
        .map((option) => option.onFrame)
        .filter((consumer): consumer is NonNullable<typeof consumer> => Boolean(consumer));
      return {
        ...(diagnostics ? { diagnostics } : {}),
        ...(frameConsumers.length > 0
          ? {
              onFrame: (observation) => {
                for (const consume of frameConsumers) {
                  try {
                    consume(observation);
                  } catch (error) {
                    console.error("NoteForge audio-input observation consumer failed.", error);
                  }
                }
              },
            }
          : {}),
      };
    },
  };
}

const FRAME_HISTORY_LIMIT = 720;
const EMPTY_FRAMES = Object.freeze([]) as readonly Readonly<PitchObservation>[];
const EMPTY_TELEMETRY = Object.freeze([]) as readonly InputTelemetry[];

function diagnosticErrorCode(error: unknown): string {
  if (error instanceof DOMException) return toDiagnosticToken(error.name);
  if (error instanceof Error && error.name) return toDiagnosticToken(error.name);
  return "unknown";
}

function booleanSetting(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function useAudioInputController(
  capture: MicrophoneCapture,
  readOptions: () => UseAudioInputOptions,
): AudioInputController {
  const engineRef = useRef(new NoteInputEngine());
  const stateRef = useRef<AudioInputState>("disabled");
  const microphoneInfoRef = useRef<MicrophoneInfo | null>(null);
  const enableGenerationRef = useRef(0);
  const enablePromiseRef = useRef<Promise<MicrophoneInfo | null> | null>(null);
  const levelSequenceRef = useRef(0);
  const lastTelemetryRef = useRef<InputTelemetry | null>(null);

  const [state, setState] = useState<AudioInputState>("disabled");
  const [error, setError] = useState("");
  const [microphoneInfo, setMicrophoneInfo] = useState<MicrophoneInfo | null>(null);
  const [frames, setFrames] = useState<readonly Readonly<PitchObservation>[]>(EMPTY_FRAMES);
  const [liveFrame, setLiveFrame] = useState<Readonly<PitchObservation>>();
  const [liveNote, setLiveNote] = useState<Readonly<LiveNote> | null>(null);
  const [processedWindowCount, setProcessedWindowCount] = useState(0);
  const [processedSampleCount, setProcessedSampleCount] = useState(0);
  const [workletProcessCount, setWorkletProcessCount] = useState(0);
  const [captureEpoch, setCaptureEpoch] = useState(0);
  const [continuityEpoch, setContinuityEpoch] = useState(0);
  const [graphGeneration, setGraphGeneration] = useState(0);
  const [transportRepairCount, setTransportRepairCount] = useState(0);
  const [telemetry, setTelemetry] = useState<InputTelemetry | null>(null);
  const [telemetryHistory, setTelemetryHistory] = useState<readonly InputTelemetry[]>(EMPTY_TELEMETRY);

  const clearObservations = useCallback(() => {
    setLiveFrame(undefined);
    setLiveNote(null);
    setFrames(EMPTY_FRAMES);
    setProcessedWindowCount(0);
    setProcessedSampleCount(0);
    setWorkletProcessCount(0);
    setCaptureEpoch(0);
    setContinuityEpoch(0);
    setGraphGeneration(0);
  }, []);

  const handleLevel = useCallback((level: CapturedLevel) => {
    const next: InputTelemetry = Object.freeze({
      ...level,
      headroomDb: Math.max(0, -level.peakDbfs),
    });
    lastTelemetryRef.current = next;
    levelSequenceRef.current += 1;
    if (levelSequenceRef.current % 2 === 0) {
      setTelemetry(next);
      setTelemetryHistory((current) => Object.freeze([...current.slice(-191), next]));
    }
  }, []);

  const handleTransportEvent = useCallback((event: CaptureTransportEvent) => {
    if (event.kind !== "recovering") return;
    setTransportRepairCount((current) => current + 1);
    setLiveFrame(undefined);
    setLiveNote(null);
  }, []);

  const disable = useCallback(() => {
    pitchDiagnostics.record(readOptions().diagnostics?.flow ?? "audio-input", {
      kind: "microphone-state",
      microphone: { state: "off" },
    });
    enableGenerationRef.current += 1;
    enablePromiseRef.current = null;
    capture.stop();
    lastTelemetryRef.current = null;
    levelSequenceRef.current = 0;
    stateRef.current = "disabled";
    microphoneInfoRef.current = null;
    setState("disabled");
    setError("");
    setMicrophoneInfo(null);
    clearObservations();
    setTransportRepairCount(0);
    setTelemetry(null);
    setTelemetryHistory(EMPTY_TELEMETRY);
  }, [capture, clearObservations, readOptions]);

  const handleStreamEnded = useCallback(() => {
    if (stateRef.current === "disabled") return;
    pitchDiagnostics.record(readOptions().diagnostics?.flow ?? "audio-input", {
      kind: "microphone-state",
      microphone: { state: "stream-ended", errorCode: "media-track-ended" },
    });
    enableGenerationRef.current += 1;
    enablePromiseRef.current = null;
    capture.stop();
    lastTelemetryRef.current = null;
    levelSequenceRef.current = 0;
    stateRef.current = "error";
    microphoneInfoRef.current = null;
    setState("error");
    setMicrophoneInfo(null);
    clearObservations();
    setTelemetry(null);
    setTelemetryHistory(EMPTY_TELEMETRY);
    setError("The microphone disconnected. Enable input to reconnect.");
  }, [capture, clearObservations, readOptions]);

  const enable = useCallback((): Promise<MicrophoneInfo | null> => {
    if (capture.isActive()) {
      stateRef.current = "running";
      setState("running");
      setError("");
      return Promise.resolve(capture.getInfo());
    }
    if (stateRef.current === "opening" && enablePromiseRef.current) {
      return enablePromiseRef.current;
    }

    const generation = ++enableGenerationRef.current;
    lastTelemetryRef.current = null;
    levelSequenceRef.current = 0;
    stateRef.current = "opening";
    setState("opening");
    setError("");
    microphoneInfoRef.current = null;
    setMicrophoneInfo(null);
    clearObservations();
    setTransportRepairCount(0);
    setTelemetry(null);
    setTelemetryHistory(EMPTY_TELEMETRY);
    pitchDiagnostics.record(readOptions().diagnostics?.flow ?? "audio-input", {
      kind: "microphone-state",
      microphone: {
        state: "starting",
        bufferSize: MICROPHONE_ANALYSIS_WINDOW_SIZE,
        minFrequencyHz: NOTE_INPUT_DEFAULTS.minFrequency,
        maxFrequencyHz: NOTE_INPUT_DEFAULTS.maxFrequency,
        yinThreshold: NOTE_INPUT_DEFAULTS.yinThreshold,
        minConfidence: NOTE_INPUT_DEFAULTS.minConfidence,
      },
    });

    const operation = (async (): Promise<MicrophoneInfo | null> => {
      try {
        const info = await capture.start(
          (window) => {
            const detectionStartedAt = performance.now();
            const { observation } = engineRef.current.process(window);
            const processingMs = Number(
              Math.max(0, performance.now() - detectionStartedAt).toFixed(3),
            );
            setError("");
            setLiveFrame(observation);
            setLiveNote((current) => reduceLiveNote(current, observation));
            setProcessedWindowCount((current) => current + 1);
            setProcessedSampleCount(observation.processedSampleCount);
            setWorkletProcessCount(observation.workletProcessCount);
            setCaptureEpoch(observation.captureEpoch);
            setContinuityEpoch(observation.continuityEpoch);
            setGraphGeneration(observation.graphGeneration);
            setFrames((current) => Object.freeze([
              ...current.slice(-(FRAME_HISTORY_LIMIT - 1)),
              observation,
            ]));

            const options = readOptions();
            const context = options.diagnostics;
            const targetMidi = context?.targetMidi;
            const toleranceCents = context?.toleranceCents;
            const errorCents = observation.voiced
              && observation.midiFloat !== null
              && targetMidi != null
              && Number.isFinite(targetMidi)
              ? (observation.midiFloat - targetMidi) * 100
              : null;
            const tracking: TrackingDiagnostic | undefined = context
              ? {
                  phase: context.phase,
                  targetMidi: targetMidi ?? null,
                  toleranceCents: toleranceCents ?? null,
                  errorCents,
                  inBand: errorCents === null || toleranceCents == null
                    ? null
                    : Math.abs(errorCents) <= toleranceCents,
                  stableMs: context.stableMs ?? null,
                  requiredHoldMs: context.requiredHoldMs ?? null,
                  resetReason: context.resetReason ?? null,
                }
              : undefined;
            pitchDiagnostics.record(context?.flow ?? "audio-input", {
              kind: "pitch-frame",
              pitch: {
                frame: toFrameDiagnostic(observation),
                processingMs,
                ...(lastTelemetryRef.current
                  ? { input: toInputDiagnostic(lastTelemetryRef.current) }
                  : {}),
                ...(tracking ? { tracking } : {}),
              },
            });
            options.onFrame?.(observation);
          },
          MICROPHONE_ANALYSIS_WINDOW_SIZE,
          handleLevel,
          handleStreamEnded,
          handleTransportEvent,
        );

        if (generation !== enableGenerationRef.current || stateRef.current !== "opening") {
          return null;
        }
        microphoneInfoRef.current = info;
        setMicrophoneInfo(info);
        setCaptureEpoch(info.captureEpoch);
        stateRef.current = "running";
        setState("running");
        pitchDiagnostics.record(readOptions().diagnostics?.flow ?? "audio-input", {
          kind: "microphone-state",
          microphone: {
            state: "ready",
            sampleRate: info.sampleRate,
            bufferSize: info.analysisWindowSize,
            minFrequencyHz: NOTE_INPUT_DEFAULTS.minFrequency,
            maxFrequencyHz: NOTE_INPUT_DEFAULTS.maxFrequency,
            echoCancellation: booleanSetting(info.settings.echoCancellation),
            noiseSuppression: booleanSetting(info.settings.noiseSuppression),
            autoGainControl: booleanSetting(info.settings.autoGainControl),
          },
        });
        return info;
      } catch (caught) {
        if (generation !== enableGenerationRef.current || stateRef.current !== "opening") {
          return null;
        }
        const message = caught instanceof Error ? caught.message : "Microphone access failed.";
        stateRef.current = "error";
        setState("error");
        setError(message);
        pitchDiagnostics.record(readOptions().diagnostics?.flow ?? "audio-input", {
          kind: "microphone-state",
          microphone: { state: "error", errorCode: diagnosticErrorCode(caught) },
        });
        return null;
      }
    })();
    enablePromiseRef.current = operation;
    void operation.then(
      () => {
        if (enablePromiseRef.current === operation) enablePromiseRef.current = null;
      },
      () => {
        if (enablePromiseRef.current === operation) enablePromiseRef.current = null;
      },
    );
    return operation;
  }, [
    capture,
    clearObservations,
    handleLevel,
    handleStreamEnded,
    handleTransportEvent,
    readOptions,
  ]);

  const getStream = useCallback(() => capture.getStream(), [capture]);

  useEffect(() => () => {
    enableGenerationRef.current += 1;
    enablePromiseRef.current = null;
    capture.stop();
  }, [capture]);

  return Object.freeze({
    state,
    error,
    microphoneInfo,
    frames,
    liveFrame,
    liveNote,
    processedWindowCount,
    processedSampleCount,
    workletProcessCount,
    captureEpoch,
    continuityEpoch,
    graphGeneration,
    transportRepairCount,
    telemetry,
    telemetryHistory,
    enable,
    disable,
    getStream,
  });
}

interface SharedAudioInputContextValue {
  controller: AudioInputController;
  attach: (id: symbol, reader: OptionsReader) => () => void;
}

const SharedAudioInputContext = createContext<SharedAudioInputContextValue | null>(null);

export function AudioInputProvider({ children }: PropsWithChildren) {
  const captureRef = useRef<MicrophoneCapture | null>(null);
  if (captureRef.current === null) captureRef.current = new MicrophoneCapture();
  const registryRef = useRef<ConsumerRegistry | null>(null);
  if (registryRef.current === null) registryRef.current = createConsumerRegistry();
  const registry = registryRef.current;
  const readOptions = useCallback(() => registry.current(), [registry]);
  const controller = useAudioInputController(captureRef.current, readOptions);
  const attach = useCallback(
    (id: symbol, reader: OptionsReader) => registry.attach(id, reader),
    [registry],
  );
  const value = useMemo(() => ({ controller, attach }), [attach, controller]);
  return createElement(SharedAudioInputContext.Provider, { value }, children);
}

export function useAudioInput(options: UseAudioInputOptions = {}): AudioInputController {
  const shared = useContext(SharedAudioInputContext);
  if (!shared) throw new Error("useAudioInput must be used inside AudioInputProvider");
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const consumerIdRef = useRef<symbol | null>(null);
  if (consumerIdRef.current === null) consumerIdRef.current = Symbol("audio-input-consumer");

  useLayoutEffect(
    () => shared.attach(consumerIdRef.current!, () => optionsRef.current),
    [shared.attach],
  );
  return shared.controller;
}

/** Observe app-scoped capture without registering a frame consumer. */
export function useAudioInputStatus(): AudioInputController {
  const shared = useContext(SharedAudioInputContext);
  if (!shared) throw new Error("useAudioInputStatus must be used inside AudioInputProvider");
  return shared.controller;
}
