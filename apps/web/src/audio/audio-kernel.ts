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
  type VocalObservation,
} from "./note-input";
import {
  AudioReactPublication,
  type AudioPresentationScheduler,
} from "./audio-react-publication";
import { CircularBuffer } from "./circular-buffer";
import {
  pitchDiagnostics,
  toDiagnosticToken,
  toFrameDiagnostic,
  toInputDiagnostic,
  type DiagnosticFlow,
  type TrackingDiagnostic,
} from "@/diagnostics/pitch-diagnostics";

export type AudioInputState = "disabled" | "opening" | "running" | "error";
export type { AudioPresentationScheduler } from "./audio-react-publication";

/** Raw level telemetry. It describes PCM but never admits or rejects pitch. */
export type InputTelemetry = Readonly<CapturedLevel> & {
  readonly headroomDb: number;
};

export interface AudioInputDiagnosticContext {
  readonly flow: DiagnosticFlow;
  readonly phase: string;
  readonly targetMidi?: number | null;
  readonly toleranceCents?: number | null;
  readonly stableMs?: number | null;
  readonly requiredHoldMs?: number | null;
  readonly resetReason?: string | null;
}

export interface UseAudioInputOptions {
  readonly onFrame?: (observation: Readonly<VocalObservation>) => void;
  readonly diagnostics?: AudioInputDiagnosticContext;
}

export interface AudioTransportSnapshot {
  readonly state: AudioInputState;
  readonly error: string;
  readonly microphoneInfo: MicrophoneInfo | null;
  readonly transportRepairCount: number;
}

export interface AudioPitchSnapshot {
  readonly liveFrame: Readonly<VocalObservation> | undefined;
  readonly liveNote: Readonly<LiveNote> | null;
}

export interface AudioCounterSnapshot {
  readonly processedWindowCount: number;
  readonly processedSampleCount: number;
  readonly workletProcessCount: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
}

export interface AudioTelemetrySnapshot {
  readonly telemetry: InputTelemetry | null;
}

export interface AudioHistorySnapshot {
  readonly frames: readonly Readonly<VocalObservation>[];
  readonly telemetryHistory: readonly InputTelemetry[];
}

type StoreListener = () => void;
type OptionsReader = () => UseAudioInputOptions;

export interface AudioInputController {
  readonly state: AudioInputState;
  readonly error: string;
  readonly microphoneInfo: MicrophoneInfo | null;
  readonly liveFrame: Readonly<VocalObservation> | undefined;
  readonly liveNote: Readonly<LiveNote> | null;
  readonly processedWindowCount: number;
  readonly processedSampleCount: number;
  readonly workletProcessCount: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly transportRepairCount: number;
  readonly telemetry: InputTelemetry | null;
  readonly enable: () => Promise<MicrophoneInfo | null>;
  readonly disable: () => void;
  readonly createRecorder: (options?: MediaRecorderOptions) => MediaRecorder;
  readonly subscribeTransport: (listener: StoreListener) => () => void;
  readonly subscribePitch: (listener: StoreListener) => () => void;
  readonly subscribeCounters: (listener: StoreListener) => () => void;
  readonly subscribeTelemetry: (listener: StoreListener) => () => void;
  readonly subscribeHistory: (listener: StoreListener) => () => void;
  readonly getTransportSnapshot: () => AudioTransportSnapshot;
  readonly getPitchSnapshot: () => AudioPitchSnapshot;
  readonly getCounterSnapshot: () => AudioCounterSnapshot;
  readonly getTelemetrySnapshot: () => AudioTelemetrySnapshot;
  readonly getHistorySnapshot: () => AudioHistorySnapshot;
}

const EMPTY_TRANSPORT: AudioTransportSnapshot = Object.freeze({
  state: "disabled",
  error: "",
  microphoneInfo: null,
  transportRepairCount: 0,
});
const EMPTY_PITCH: AudioPitchSnapshot = Object.freeze({
  liveFrame: undefined,
  liveNote: null,
});
const EMPTY_COUNTERS: AudioCounterSnapshot = Object.freeze({
  processedWindowCount: 0,
  processedSampleCount: 0,
  workletProcessCount: 0,
  captureEpoch: 0,
  continuityEpoch: 0,
  graphGeneration: 0,
});
const EMPTY_TELEMETRY: AudioTelemetrySnapshot = Object.freeze({ telemetry: null });
const FRAME_HISTORY_LIMIT = 720;
const TELEMETRY_HISTORY_LIMIT = 192;

function diagnosticErrorCode(error: unknown): string {
  if (error instanceof DOMException) return toDiagnosticToken(error.name);
  if (error instanceof Error && error.name) return toDiagnosticToken(error.name);
  return "unknown";
}

function booleanSetting(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function subscribeTo(set: Set<StoreListener>, listener: StoreListener): () => void {
  set.add(listener);
  return () => set.delete(listener);
}

function notify(set: ReadonlySet<StoreListener>): void {
  for (const listener of set) listener();
}

function observationRequiresImmediatePublication(
  previous: Readonly<PitchObservation> | undefined,
  next: Readonly<PitchObservation>,
): boolean {
  return previous === undefined
    || previous.observationKind !== next.observationKind
    || previous.nearestMidi !== next.nearestMidi
    || previous.discontinuity !== next.discontinuity;
}

/**
 * App-lifetime realtime sensor. No detector callback writes React state and no
 * frame-history array is copied until an explicit history subscriber reads it.
 */
export class AudioKernel {
  private readonly capture: MicrophoneCapture;
  private readonly engine = new NoteInputEngine();
  private readonly reactPublication: AudioReactPublication;
  private readonly optionReaders = new Map<symbol, OptionsReader>();
  private readonly transportListeners = new Set<StoreListener>();
  private readonly pitchListeners = new Set<StoreListener>();
  private readonly counterListeners = new Set<StoreListener>();
  private readonly telemetryListeners = new Set<StoreListener>();
  private readonly historyListeners = new Set<StoreListener>();
  private readonly frameHistory = new CircularBuffer<Readonly<VocalObservation>>(FRAME_HISTORY_LIMIT);
  private readonly levelHistory = new CircularBuffer<InputTelemetry>(TELEMETRY_HISTORY_LIMIT);
  private transport: AudioTransportSnapshot = EMPTY_TRANSPORT;
  private pitch: AudioPitchSnapshot = EMPTY_PITCH;
  private publishedPitch: AudioPitchSnapshot = EMPTY_PITCH;
  private counters: AudioCounterSnapshot = EMPTY_COUNTERS;
  private publishedCounters: AudioCounterSnapshot = EMPTY_COUNTERS;
  private level: AudioTelemetrySnapshot = EMPTY_TELEMETRY;
  private publishedLevel: AudioTelemetrySnapshot = EMPTY_TELEMETRY;
  private historySnapshot: AudioHistorySnapshot = Object.freeze({
    frames: Object.freeze([]),
    telemetryHistory: Object.freeze([]),
  });
  private historyDirty = false;
  private countersNeedPublication = false;
  private telemetryNeedsPublication = false;
  private historyNeedsPublication = false;
  private enableGeneration = 0;
  private enablePromise: Promise<MicrophoneInfo | null> | null = null;
  private levelSequence = 0;
  private lastTelemetry: InputTelemetry | null = null;
  readonly controller: AudioInputController;

  constructor(
    capture = new MicrophoneCapture(),
    presentationScheduler?: AudioPresentationScheduler,
  ) {
    this.capture = capture;
    this.reactPublication = new AudioReactPublication({
      publishPitch: this.publishPitch,
      publishAuxiliary: this.publishAuxiliary,
    }, presentationScheduler);
    const kernel = this;
    this.controller = Object.freeze({
      get state() { return kernel.transport.state; },
      get error() { return kernel.transport.error; },
      get microphoneInfo() { return kernel.transport.microphoneInfo; },
      get liveFrame() { return kernel.pitch.liveFrame; },
      get liveNote() { return kernel.pitch.liveNote; },
      get processedWindowCount() { return kernel.counters.processedWindowCount; },
      get processedSampleCount() { return kernel.counters.processedSampleCount; },
      get workletProcessCount() { return kernel.counters.workletProcessCount; },
      get captureEpoch() { return kernel.counters.captureEpoch; },
      get continuityEpoch() { return kernel.counters.continuityEpoch; },
      get graphGeneration() { return kernel.counters.graphGeneration; },
      get transportRepairCount() { return kernel.transport.transportRepairCount; },
      get telemetry() { return kernel.level.telemetry; },
      enable: kernel.enable,
      disable: kernel.disable,
      createRecorder: kernel.createRecorder,
      subscribeTransport: kernel.subscribeTransport,
      subscribePitch: kernel.subscribePitch,
      subscribeCounters: kernel.subscribeCounters,
      subscribeTelemetry: kernel.subscribeTelemetry,
      subscribeHistory: kernel.subscribeHistory,
      getTransportSnapshot: kernel.getTransportSnapshot,
      getPitchSnapshot: kernel.getPitchSnapshot,
      getCounterSnapshot: kernel.getCounterSnapshot,
      getTelemetrySnapshot: kernel.getTelemetrySnapshot,
      getHistorySnapshot: kernel.getHistorySnapshot,
    });
  }

  attach(id: symbol, reader: OptionsReader): () => void {
    this.optionReaders.delete(id);
    this.optionReaders.set(id, reader);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.optionReaders.delete(id);
    };
  }

  private currentOptions(): UseAudioInputOptions {
    const options = [...this.optionReaders.values()].map((reader) => reader());
    const diagnostics = options.slice().reverse().find((value) => value.diagnostics)?.diagnostics;
    const consumers = options.flatMap((value) => value.onFrame ? [value.onFrame] : []);
    return {
      ...(diagnostics ? { diagnostics } : {}),
      ...(consumers.length > 0 ? {
        onFrame: (observation) => {
          for (const consume of consumers) {
            try {
              consume(observation);
            } catch (error) {
              console.error("NoteForge AudioKernel observation consumer failed.", error);
            }
          }
        },
      } : {}),
    };
  }

  readonly subscribeTransport = (listener: StoreListener) => subscribeTo(this.transportListeners, listener);
  readonly subscribePitch = (listener: StoreListener) => subscribeTo(this.pitchListeners, listener);
  readonly subscribeCounters = (listener: StoreListener) => subscribeTo(this.counterListeners, listener);
  readonly subscribeTelemetry = (listener: StoreListener) => subscribeTo(this.telemetryListeners, listener);
  readonly subscribeHistory = (listener: StoreListener) => subscribeTo(this.historyListeners, listener);
  readonly getTransportSnapshot = () => this.transport;
  readonly getPitchSnapshot = () => this.publishedPitch;
  readonly getCounterSnapshot = () => this.publishedCounters;
  readonly getTelemetrySnapshot = () => this.publishedLevel;
  readonly getHistorySnapshot = (): AudioHistorySnapshot => {
    if (!this.historyDirty) return this.historySnapshot;
    this.historySnapshot = Object.freeze({
      frames: this.frameHistory.snapshot(),
      telemetryHistory: this.levelHistory.snapshot(),
    });
    this.historyDirty = false;
    return this.historySnapshot;
  };

  private readonly publishPitch = (): void => {
    this.publishedPitch = this.pitch;
    notify(this.pitchListeners);
  };

  private readonly publishAuxiliary = (): void => {
    if (this.countersNeedPublication) {
      this.countersNeedPublication = false;
      this.publishedCounters = this.counters;
      notify(this.counterListeners);
    }
    if (this.telemetryNeedsPublication) {
      this.telemetryNeedsPublication = false;
      this.publishedLevel = this.level;
      notify(this.telemetryListeners);
    }
    if (this.historyNeedsPublication) {
      this.historyNeedsPublication = false;
      notify(this.historyListeners);
    }
  };

  private publishTransport(next: AudioTransportSnapshot): void {
    this.transport = Object.freeze(next);
    notify(this.transportListeners);
  }

  private clearRealtime(): void {
    this.reactPublication.reset();
    this.pitch = EMPTY_PITCH;
    this.publishedPitch = EMPTY_PITCH;
    this.counters = EMPTY_COUNTERS;
    this.publishedCounters = EMPTY_COUNTERS;
    this.level = EMPTY_TELEMETRY;
    this.publishedLevel = EMPTY_TELEMETRY;
    this.frameHistory.clear();
    this.levelHistory.clear();
    this.historyDirty = true;
    this.countersNeedPublication = false;
    this.telemetryNeedsPublication = false;
    this.historyNeedsPublication = false;
    this.lastTelemetry = null;
    this.levelSequence = 0;
    notify(this.pitchListeners);
    notify(this.counterListeners);
    notify(this.telemetryListeners);
    notify(this.historyListeners);
  }

  private handleLevel = (captured: CapturedLevel): void => {
    const telemetry: InputTelemetry = Object.freeze({
      ...captured,
      headroomDb: Math.max(0, -captured.peakDbfs),
    });
    this.lastTelemetry = telemetry;
    this.levelSequence += 1;
    if (this.levelSequence % 2 !== 0) return;
    this.level = Object.freeze({ telemetry });
    this.levelHistory.push(telemetry);
    this.historyDirty = true;
    this.telemetryNeedsPublication = true;
    this.historyNeedsPublication = true;
    this.reactPublication.scheduleAuxiliary();
  };

  private handleTransportEvent = (event: CaptureTransportEvent): void => {
    if (event.kind !== "recovering") return;
    this.pitch = EMPTY_PITCH;
    this.publishTransport({
      ...this.transport,
      transportRepairCount: this.transport.transportRepairCount + 1,
    });
    this.reactPublication.publishPitchTransition();
  };

  private handleStreamEnded = (): void => {
    if (this.transport.state === "disabled") return;
    const options = this.currentOptions();
    pitchDiagnostics.record(options.diagnostics?.flow ?? "audio-input", {
      kind: "microphone-state",
      microphone: { state: "stream-ended", errorCode: "media-track-ended" },
    });
    this.enableGeneration += 1;
    this.enablePromise = null;
    this.capture.stop();
    this.clearRealtime();
    this.publishTransport({
      state: "error",
      error: "The microphone disconnected. Use Retry voice in the global header to reconnect.",
      microphoneInfo: null,
      transportRepairCount: 0,
    });
  };

  private recordObservation(observation: Readonly<VocalObservation>, processingMs: number): void {
    const previousObservation = this.pitch.liveFrame;
    this.pitch = Object.freeze({
      liveFrame: observation,
      liveNote: reduceLiveNote(this.pitch.liveNote, observation),
    });
    this.counters = Object.freeze({
      processedWindowCount: this.counters.processedWindowCount + 1,
      processedSampleCount: observation.processedSampleCount,
      workletProcessCount: observation.workletProcessCount,
      captureEpoch: observation.captureEpoch,
      continuityEpoch: observation.continuityEpoch,
      graphGeneration: observation.graphGeneration,
    });
    this.frameHistory.push(observation);
    this.historyDirty = true;
    this.countersNeedPublication = true;
    if (this.counters.processedWindowCount % 4 === 0) {
      this.historyNeedsPublication = true;
    }
    this.reactPublication.scheduleAuxiliary();
    if (observationRequiresImmediatePublication(previousObservation, observation)) {
      this.reactPublication.publishPitchTransition();
    } else {
      this.reactPublication.schedulePitch();
    }

    const options = this.currentOptions();
    const context = options.diagnostics;
    const targetMidi = context?.targetMidi;
    const toleranceCents = context?.toleranceCents;
    const errorCents = observation.voiced
      && observation.midiFloat !== null
      && targetMidi != null
      && Number.isFinite(targetMidi)
      ? (observation.midiFloat - targetMidi) * 100
      : null;
    const tracking: TrackingDiagnostic | undefined = context ? {
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
    } : undefined;
    pitchDiagnostics.record(context?.flow ?? "audio-input", {
      kind: "pitch-frame",
      pitch: {
        frame: toFrameDiagnostic(observation),
        processingMs,
        ...(this.lastTelemetry ? { input: toInputDiagnostic(this.lastTelemetry) } : {}),
        ...(tracking ? { tracking } : {}),
      },
    });
    options.onFrame?.(observation);
  }

  readonly enable = (): Promise<MicrophoneInfo | null> => {
    if (this.capture.isActive()) {
      this.publishTransport({
        ...this.transport,
        state: "running",
        error: "",
        microphoneInfo: this.capture.getInfo(),
      });
      return Promise.resolve(this.capture.getInfo());
    }
    if (this.transport.state === "opening" && this.enablePromise) return this.enablePromise;
    const generation = ++this.enableGeneration;
    this.clearRealtime();
    this.publishTransport({
      state: "opening",
      error: "",
      microphoneInfo: null,
      transportRepairCount: 0,
    });
    const diagnostics = this.currentOptions().diagnostics;
    pitchDiagnostics.record(diagnostics?.flow ?? "audio-input", {
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
        const info = await this.capture.start(
          (window) => {
            const startedAt = performance.now();
            const { observation } = this.engine.process(window);
            const processingMs = Number(Math.max(0, performance.now() - startedAt).toFixed(3));
            this.recordObservation(observation, processingMs);
          },
          MICROPHONE_ANALYSIS_WINDOW_SIZE,
          this.handleLevel,
          this.handleStreamEnded,
          this.handleTransportEvent,
        );
        if (generation !== this.enableGeneration || this.transport.state !== "opening") return null;
        this.counters = Object.freeze({ ...this.counters, captureEpoch: info.captureEpoch });
        this.publishedCounters = this.counters;
        this.countersNeedPublication = false;
        notify(this.counterListeners);
        this.publishTransport({
          state: "running",
          error: "",
          microphoneInfo: info,
          transportRepairCount: 0,
        });
        pitchDiagnostics.record(this.currentOptions().diagnostics?.flow ?? "audio-input", {
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
      } catch (error) {
        if (generation !== this.enableGeneration || this.transport.state !== "opening") return null;
        const message = error instanceof Error ? error.message : "Microphone access failed.";
        this.publishTransport({
          state: "error",
          error: message,
          microphoneInfo: null,
          transportRepairCount: 0,
        });
        pitchDiagnostics.record(this.currentOptions().diagnostics?.flow ?? "audio-input", {
          kind: "microphone-state",
          microphone: { state: "error", errorCode: diagnosticErrorCode(error) },
        });
        return null;
      }
    })();
    this.enablePromise = operation;
    void operation.finally(() => {
      if (this.enablePromise === operation) this.enablePromise = null;
    });
    return operation;
  };

  readonly disable = (): void => {
    pitchDiagnostics.record(this.currentOptions().diagnostics?.flow ?? "audio-input", {
      kind: "microphone-state",
      microphone: { state: "off" },
    });
    this.enableGeneration += 1;
    this.enablePromise = null;
    this.capture.stop();
    this.clearRealtime();
    this.publishTransport(EMPTY_TRANSPORT);
  };

  /** Create an opt-in local recorder without exposing capture ownership. */
  readonly createRecorder = (options?: MediaRecorderOptions): MediaRecorder => {
    const stream = this.capture.getStream();
    if (this.transport.state !== "running" || !stream?.active) {
      throw new Error("Voice input must be running before recording a local take.");
    }
    if (typeof MediaRecorder !== "function") {
      throw new Error("Local voice recording is not supported in this browser.");
    }
    return new MediaRecorder(stream, options);
  };

  destroy(): void {
    this.enableGeneration += 1;
    this.enablePromise = null;
    this.capture.stop();
    this.clearRealtime();
    this.publishTransport(EMPTY_TRANSPORT);
    this.optionReaders.clear();
  }
}
