import { ensureAudioReady } from "./audio-context";
import { DirectMicrophoneMonitor } from "./direct-microphone-monitor";
import { NOTE_INPUT_DEFAULTS, NOTE_INPUT_SAMPLE_RATE_BOUNDS } from "./note-input";
import {
  microphoneLatencyInfo,
  rawMicrophoneConstraints,
  requireMonitorLevel,
  type MicrophoneLatencyInfo,
} from "./microphone-environment";

export {
  MICROPHONE_MONITOR_DEFAULT_LEVEL,
  MICROPHONE_MONITOR_RAMP_SECONDS,
  type MicrophoneMonitorState,
} from "./microphone-environment";

export interface CapturedSamples {
  readonly samples: Float32Array;
  readonly capturedAt: number;
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly processCount: number;
  readonly processedSampleCount: number;
  readonly discontinuity: boolean;
}

export interface CapturedLevel {
  readonly capturedAt: number;
  readonly rms: number;
  readonly peak: number;
  readonly rmsDbfs: number;
  readonly peakDbfs: number;
  readonly dcOffset: number;
  readonly clippedSampleCount: number;
  readonly clipRatio: number;
  readonly sampleCount: number;
}

export interface MicrophoneInfo {
  readonly label?: string;
  readonly settings: Readonly<MediaTrackSettings>;
  readonly constraints: Readonly<MediaTrackConstraints>;
  readonly sampleRate: number;
  readonly analysisWindowSize: number;
  readonly analysisHopSize: number;
  readonly meterWindowSize: number;
  readonly captureEpoch: number;
  /** Browser-reported estimates, never a measured microphone-to-ear round trip. */
  readonly latency?: Readonly<MicrophoneLatencyInfo>;
}

export interface AnalysisWindowSizes {
  readonly windowSize: number;
  readonly hopSize: number;
  readonly meterSize: number;
}

export type CaptureTransportEvent = Readonly<{
  kind: "recovering" | "recovered";
  reason: "audio-context" | "pcm-heartbeat";
  captureEpoch: number;
  continuityEpoch: number;
  graphGeneration: number;
}>;

const REFERENCE_SAMPLE_RATE = 48_000;
export const MICROPHONE_ANALYSIS_WINDOW_SIZE = 4_096;
export const MICROPHONE_ANALYSIS_HOP_SECONDS = 0.02;
export const MICROPHONE_METER_WINDOW_SIZE = 1_024;
export const MICROPHONE_MAX_WINDOW_SIZE = 262_144;
const PCM_HEARTBEAT_TIMEOUT_MS = 1_500;
const PCM_HEARTBEAT_POLL_MS = 500;

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function nearestPowerOfTwo(value: number): number {
  return 2 ** Math.round(Math.log2(value));
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(value));
}

/** A deep analysis window with a short overlapping update hop. */
export function analysisWindowSizes(
  sampleRate: number,
  requestedWindowSize = MICROPHONE_ANALYSIS_WINDOW_SIZE,
  requestedHopSeconds = MICROPHONE_ANALYSIS_HOP_SECONDS,
  requestedMeterSize = MICROPHONE_METER_WINDOW_SIZE,
  minFrequency = NOTE_INPUT_DEFAULTS.minFrequency,
): AnalysisWindowSizes {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a finite positive number.");
  }
  if (sampleRate <= NOTE_INPUT_SAMPLE_RATE_BOUNDS.capture.exclusiveMinimum) {
    throw new RangeError(
      `sampleRate must exceed ${NOTE_INPUT_SAMPLE_RATE_BOUNDS.capture.exclusiveMinimum} Hz to cover the canonical detector range.`,
    );
  }
  if (sampleRate > NOTE_INPUT_SAMPLE_RATE_BOUNDS.capture.maximum) {
    throw new RangeError(
      `sampleRate must be no greater than ${NOTE_INPUT_SAMPLE_RATE_BOUNDS.capture.maximum} Hz.`,
    );
  }
  requirePositiveInteger(requestedWindowSize, "requestedWindowSize");
  requirePositiveInteger(requestedMeterSize, "requestedMeterSize");
  if (!Number.isFinite(requestedHopSeconds) || requestedHopSeconds <= 0) {
    throw new RangeError("requestedHopSeconds must be a finite positive number.");
  }
  if (!Number.isFinite(minFrequency) || minFrequency <= 0) {
    throw new RangeError("minFrequency must be a finite positive number.");
  }

  const scaledWindowSize = nearestPowerOfTwo(
    requestedWindowSize * sampleRate / REFERENCE_SAMPLE_RATE,
  );
  const minimumPitchWindowSize = Math.ceil(sampleRate / minFrequency) + 3;
  const windowSize = scaledWindowSize >= minimumPitchWindowSize
    ? scaledWindowSize
    : nextPowerOfTwo(minimumPitchWindowSize);
  const hopSize = Math.max(1, Math.round(sampleRate * requestedHopSeconds));
  const meterSize = nearestPowerOfTwo(
    requestedMeterSize * sampleRate / REFERENCE_SAMPLE_RATE,
  );
  if (
    !Number.isSafeInteger(windowSize)
    || !Number.isSafeInteger(hopSize)
    || !Number.isSafeInteger(meterSize)
    || windowSize > MICROPHONE_MAX_WINDOW_SIZE
    || hopSize > windowSize
    || meterSize > MICROPHONE_MAX_WINDOW_SIZE
  ) {
    throw new RangeError(
      `Analysis sizes must be safe integers no greater than ${MICROPHONE_MAX_WINDOW_SIZE}, with hopSize no greater than windowSize.`,
    );
  }
  return Object.freeze({ windowSize, hopSize, meterSize });
}

const PITCH_CAPTURE_WORKLET_URL = new URL(
  "./pitch-capture-worklet.js",
  import.meta.url,
).href;

type WorkletSampleMessage = Omit<CapturedSamples, "sampleRate"> & { type: "samples" };
type WorkletLevelMessage = CapturedLevel & { type: "level" };

function nowMilliseconds(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/**
 * Application-owned continuous transport. UI consumers may appear and
 * disappear; only this object owns the MediaStream and processing graph.
 */
export class MicrophoneCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silentOutput: GainNode | null = null;
  private monitor: DirectMicrophoneMonitor | null = null;
  private info: MicrophoneInfo | null = null;
  private sizes: AnalysisWindowSizes | null = null;
  private lifecycle = 0;
  private opening: Promise<MicrophoneInfo> | null = null;
  private captureEpoch = 0;
  private continuityEpoch = 0;
  private graphGeneration = 0;
  private processCount = 0;
  private processedSampleCount = 0;
  private lastPcmProgressAt = 0;
  private recovery: Promise<void> | null = null;
  private pendingRecoveryReason: CaptureTransportEvent["reason"] | null = null;
  private recoveryAttempts = 0;
  private nextRecoveryAt = 0;
  private heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private onSamples: ((chunk: CapturedSamples) => void) | null = null;
  private onLevel: ((level: CapturedLevel) => void) | null = null;
  private onEnded: (() => void) | null = null;
  private onTransportEvent: ((event: CaptureTransportEvent) => void) | null = null;

  private readonly handleContextStateChange = () => {
    if (!this.isActive() || this.context?.state === "running") return;
    void this.repairTransport("audio-context");
  };

  private readonly handleUserInteraction = () => {
    if (!this.isActive() || this.context?.state === "running") return;
    void this.repairTransport("audio-context");
  };

  getStream(): MediaStream | null {
    return this.stream;
  }

  getInfo(): MicrophoneInfo | null {
    return this.info;
  }

  setMonitoring(enabled: boolean, level: number): void {
    requireMonitorLevel(level);
    this.monitor?.set(enabled, level);
  }

  isActive(): boolean {
    return this.stream?.active === true
      && this.stream.getAudioTracks().some((track) => track.readyState === "live");
  }

  async start(
    onSamples: (chunk: CapturedSamples) => void,
    windowSize = MICROPHONE_ANALYSIS_WINDOW_SIZE,
    onLevel?: (level: CapturedLevel) => void,
    onEnded?: () => void,
    onTransportEvent?: (event: CaptureTransportEvent) => void,
  ): Promise<MicrophoneInfo> {
    this.onSamples = onSamples;
    this.onLevel = onLevel ?? null;
    this.onEnded = onEnded ?? null;
    this.onTransportEvent = onTransportEvent ?? null;
    if (this.isActive() && this.info) return this.info;
    if (this.opening) return this.opening;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not supported in this browser.");
    }

    const lifecycle = ++this.lifecycle;
    const cancelled = () => lifecycle !== this.lifecycle;
    const operation = this.openCapture(lifecycle, cancelled, windowSize);
    this.opening = operation;
    void operation.then(
      () => {
        if (this.opening === operation) this.opening = null;
      },
      () => {
        if (this.opening === operation) this.opening = null;
      },
    );
    return operation;
  }

  private async openCapture(
    lifecycle: number,
    cancelled: () => boolean,
    windowSize: number,
  ): Promise<MicrophoneInfo> {
    let stream: MediaStream | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let worklet: AudioWorkletNode | null = null;
    let silentOutput: GainNode | null = null;
    let monitor: DirectMicrophoneMonitor | null = null;
    const cancellationError = () => new DOMException(
      "Microphone start was cancelled.",
      "AbortError",
    );
    try {
      const context = await ensureAudioReady();
      if (cancelled()) throw cancellationError();
      const sizes = analysisWindowSizes(context.sampleRate, windowSize);
      stream = await navigator.mediaDevices.getUserMedia({
        audio: rawMicrophoneConstraints(navigator.mediaDevices),
      });
      if (cancelled()) throw cancellationError();
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState !== "live") {
        throw new Error("Microphone access did not provide a live audio track.");
      }
      await context.audioWorklet.addModule(PITCH_CAPTURE_WORKLET_URL);
      if (cancelled()) throw cancellationError();
      if (track.readyState !== "live" || !stream.active) {
        throw new Error("The microphone audio track ended during setup.");
      }

      this.captureEpoch += 1;
      this.continuityEpoch = 0;
      this.graphGeneration = 0;
      this.processCount = 0;
      this.processedSampleCount = 0;
      const microphoneStream = new MediaStream([track]);
      source = context.createMediaStreamSource(microphoneStream);
      worklet = this.createWorklet(context, sizes);
      silentOutput = context.createGain();
      silentOutput.gain.value = 0;
      monitor = new DirectMicrophoneMonitor(context);
      this.attachWorkletHandler(worklet, context.sampleRate, lifecycle);
      // Monitoring is a direct Web Audio branch. It never waits for the
      // worklet, detector, callbacks, a JS PCM buffer, or React publication.
      monitor.connect(source);
      source.connect(worklet).connect(silentOutput).connect(context.destination);
      if (cancelled()) throw cancellationError();

      track.addEventListener("ended", () => {
        if (lifecycle === this.lifecycle && this.stream === stream) this.onEnded?.();
      }, { once: true });
      if (track.readyState !== "live" || !stream.active) {
        throw new Error("The microphone audio track ended during setup.");
      }

      const settings = track.getSettings();
      const info = Object.freeze({
        label: track.label,
        settings: Object.freeze({ ...settings }),
        constraints: Object.freeze({ ...track.getConstraints() }),
        sampleRate: context.sampleRate,
        analysisWindowSize: sizes.windowSize,
        analysisHopSize: sizes.hopSize,
        meterWindowSize: sizes.meterSize,
        captureEpoch: this.captureEpoch,
        latency: microphoneLatencyInfo(context, settings),
      });
      this.stream = stream;
      this.context = context;
      this.source = source;
      this.worklet = worklet;
      this.silentOutput = silentOutput;
      this.monitor = monitor;
      this.sizes = sizes;
      this.info = info;
      this.lastPcmProgressAt = nowMilliseconds();
      context.addEventListener("statechange", this.handleContextStateChange);
      this.attachInteractionRecovery();
      this.startHeartbeat();
      return info;
    } catch (error) {
      this.disposeCaptureGraph(source, worklet, silentOutput, monitor);
      stream?.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  private createWorklet(context: AudioContext, sizes: AnalysisWindowSizes): AudioWorkletNode {
    return new AudioWorkletNode(context, "pitch-capture", {
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        ...sizes,
        captureEpoch: this.captureEpoch,
        continuityEpoch: this.continuityEpoch,
        graphGeneration: this.graphGeneration,
        processCount: this.processCount,
        processedSampleCount: this.processedSampleCount,
      },
    });
  }

  private attachWorkletHandler(
    worklet: AudioWorkletNode,
    sampleRate: number,
    lifecycle: number,
  ): void {
    worklet.port.onmessage = (event: MessageEvent<WorkletSampleMessage | WorkletLevelMessage>) => {
      if (lifecycle !== this.lifecycle || (worklet !== this.worklet && this.worklet !== null)) return;
      if (event.data.type === "level") {
        this.onLevel?.(event.data);
        return;
      }
      const data = event.data;
      // A message is not a PCM heartbeat merely because it arrived. Only a
      // strictly newer sample coordinate is new capture evidence. Duplicate or
      // regressing protocol data stays out of the authoritative stream and lets
      // the existing heartbeat repair the processing attachment if necessary.
      if (data.processedSampleCount <= this.processedSampleCount) return;
      this.processCount = Math.max(this.processCount, data.processCount);
      this.processedSampleCount = data.processedSampleCount;
      this.lastPcmProgressAt = nowMilliseconds();
      this.recoveryAttempts = 0;
      this.nextRecoveryAt = 0;
      if (this.pendingRecoveryReason !== null) {
        this.onTransportEvent?.(Object.freeze({
          kind: "recovered",
          reason: this.pendingRecoveryReason,
          captureEpoch: data.captureEpoch,
          continuityEpoch: data.continuityEpoch,
          graphGeneration: data.graphGeneration,
        }));
        this.pendingRecoveryReason = null;
      }
      this.onSamples?.(Object.freeze({
        samples: data.samples,
        capturedAt: data.capturedAt,
        sampleRate,
        startSample: data.startSample,
        endSample: data.endSample,
        captureEpoch: data.captureEpoch,
        continuityEpoch: data.continuityEpoch,
        graphGeneration: data.graphGeneration,
        processCount: data.processCount,
        processedSampleCount: data.processedSampleCount,
        discontinuity: data.discontinuity,
      }));
    };
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) globalThis.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = globalThis.setInterval(() => {
      if (!this.isActive()) return;
      const now = nowMilliseconds();
      if (now < this.nextRecoveryAt) return;
      if (now - this.lastPcmProgressAt < PCM_HEARTBEAT_TIMEOUT_MS) return;
      void this.repairTransport(
        this.context?.state === "running" ? "pcm-heartbeat" : "audio-context",
      );
    }, PCM_HEARTBEAT_POLL_MS);
  }

  private async repairTransport(reason: CaptureTransportEvent["reason"]): Promise<void> {
    if (this.recovery || !this.isActive() || !this.context || !this.stream || !this.sizes) {
      return this.recovery ?? Promise.resolve();
    }
    const context = this.context;
    const sizes = this.sizes;
    const lifecycle = this.lifecycle;
    this.recoveryAttempts += 1;
    this.nextRecoveryAt = nowMilliseconds() + Math.min(
      10_000,
      PCM_HEARTBEAT_TIMEOUT_MS * 2 ** this.recoveryAttempts,
    );
    const operation = (async () => {
      this.onTransportEvent?.(Object.freeze({
        kind: "recovering",
        reason,
        captureEpoch: this.captureEpoch,
        continuityEpoch: this.continuityEpoch,
        graphGeneration: this.graphGeneration,
      }));
      if (context.state !== "running") {
        try {
          await context.resume();
        } catch {
          return;
        }
        if (
          lifecycle !== this.lifecycle
          || (context.state as AudioContextState) !== "running"
        ) return;
        this.continuityEpoch += 1;
        this.worklet?.port.postMessage({
          type: "discontinuity",
          continuityEpoch: this.continuityEpoch,
        });
        this.lastPcmProgressAt = nowMilliseconds();
        this.pendingRecoveryReason = reason;
        return;
      }

      const oldWorklet = this.worklet;
      const oldSilentOutput = this.silentOutput;
      this.continuityEpoch += 1;
      this.graphGeneration += 1;
      const nextWorklet = this.createWorklet(context, sizes);
      const nextSilentOutput = context.createGain();
      nextSilentOutput.gain.value = 0;
      this.attachWorkletHandler(nextWorklet, context.sampleRate, lifecycle);
      // PCM recovery replaces only the analysis branch. The source and direct
      // monitor branch remain attached, so infrastructure repair cannot create
      // an audible monitoring dropout.
      this.source?.connect(nextWorklet).connect(nextSilentOutput).connect(context.destination);
      if (lifecycle !== this.lifecycle) {
        this.disposeAnalysisBranch(this.source, nextWorklet, nextSilentOutput);
        return;
      }
      this.worklet = nextWorklet;
      this.silentOutput = nextSilentOutput;
      this.lastPcmProgressAt = nowMilliseconds();
      this.pendingRecoveryReason = reason;
      this.disposeAnalysisBranch(this.source, oldWorklet, oldSilentOutput);
    })();
    this.recovery = operation;
    try {
      await operation;
    } finally {
      if (this.recovery === operation) this.recovery = null;
    }
  }

  private attachInteractionRecovery(): void {
    if (typeof window === "undefined") return;
    window.addEventListener("pointerdown", this.handleUserInteraction, { capture: true });
    window.addEventListener("keydown", this.handleUserInteraction, { capture: true });
  }

  private detachInteractionRecovery(): void {
    if (typeof window === "undefined") return;
    window.removeEventListener("pointerdown", this.handleUserInteraction, { capture: true });
    window.removeEventListener("keydown", this.handleUserInteraction, { capture: true });
  }

  private disposeAnalysisBranch(
    source: MediaStreamAudioSourceNode | null,
    worklet: AudioWorkletNode | null,
    silentOutput: GainNode | null,
  ): void {
    if (source && worklet) {
      try {
        source.disconnect(worklet);
      } catch {
        // A partially constructed or already detached graph has nothing left
        // to disconnect. Teardown must remain idempotent.
      }
    }
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.close();
      worklet.disconnect();
    }
    silentOutput?.disconnect();
  }

  private disposeCaptureGraph(
    source: MediaStreamAudioSourceNode | null,
    worklet: AudioWorkletNode | null,
    silentOutput: GainNode | null,
    monitor: DirectMicrophoneMonitor | null,
  ): void {
    this.disposeAnalysisBranch(source, worklet, silentOutput);
    source?.disconnect();
    monitor?.dispose();
  }

  stop(): void {
    this.lifecycle += 1;
    if (this.heartbeatTimer !== null) {
      globalThis.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.context?.removeEventListener("statechange", this.handleContextStateChange);
    this.detachInteractionRecovery();
    this.disposeCaptureGraph(
      this.source,
      this.worklet,
      this.silentOutput,
      this.monitor,
    );
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.context = null;
    this.source = null;
    this.worklet = null;
    this.silentOutput = null;
    this.monitor = null;
    this.info = null;
    this.sizes = null;
    this.opening = null;
    this.recovery = null;
    this.pendingRecoveryReason = null;
    this.recoveryAttempts = 0;
    this.nextRecoveryAt = 0;
    this.onSamples = null;
    this.onLevel = null;
    this.onEnded = null;
    this.onTransportEvent = null;
  }
}
