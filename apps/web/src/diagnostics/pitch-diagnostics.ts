import type { YinPitchFrame } from "@noteforge/pitch-engine";
import type { PitchCandidateTelemetry, PitchTrackingDecision } from "@/audio/pitch-state-tracker";
import diagnosticSchema from "../../../../packages/diagnostic-schema/src/schema.json";
import {
  serializeLivePitchCoordinates,
  validateMicrophoneSignalContract,
  validateSerializedFrameSignalContract,
} from "./live-signal-contract";
import {
  serializePitchCandidate,
  type PitchCandidateDiagnostic,
} from "./pitch-candidate-diagnostic";

export { LIVE_DIAGNOSTIC_SIGNAL_BOUNDS } from "./live-signal-contract";

export const PITCH_DIAGNOSTIC_VERSION = diagnosticSchema.version;
export const DIAGNOSTIC_FLOW = "audio-input" as const;
export type DiagnosticFlow = typeof DIAGNOSTIC_FLOW;
export const DIAGNOSTIC_FLOWS: readonly DiagnosticFlow[] = Object.freeze([DIAGNOSTIC_FLOW]);

export type DiagnosticObservationKind = keyof typeof diagnosticSchema.observationKinds;
export const DIAGNOSTIC_OBSERVATION_KINDS = Object.freeze(
  Object.keys(diagnosticSchema.observationKinds) as DiagnosticObservationKind[],
);

/**
 * Structural boundary accepted from the app-owned observation stream. Keeping
 * this independent of the audio module prevents diagnostics from owning or
 * importing capture lifecycle state.
 */
export interface FrameDiagnosticSource {
  readonly observationKind: DiagnosticObservationKind;
  readonly timeSeconds: number;
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly processedSampleCount: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly discontinuity: boolean;
  readonly workletProcessCount: number;
  readonly periodicity: number;
  readonly voiced: boolean;
  readonly frequencyHz: number | null;
  readonly midiFloat: number | null;
  readonly nearestMidi: number | null;
  readonly centsFromNearest: number | null;
  readonly rms: number;
  readonly confidence: number;
  readonly brightness: number | null;
  readonly brightnessConfidence: number;
  readonly yinValue: number | null;
  readonly periodSamples: number | null;
  readonly reason: YinPitchFrame["reason"];
  readonly pitchCandidate?: Readonly<PitchCandidateTelemetry>;
  readonly pitchTrackingDecision?: PitchTrackingDecision;
}

export interface FrameDiagnostic {
  observationKind: DiagnosticObservationKind;
  timeSeconds: number;
  sampleRate: number;
  startSample: number;
  endSample: number;
  processedSampleCount: number;
  captureEpoch: number;
  continuityEpoch: number;
  graphGeneration: number;
  discontinuity: boolean;
  workletProcessCount: number;
  periodicity: number;
  voiced: boolean;
  frequencyHz: number | null;
  midiFloat: number | null;
  nearestMidi: number | null;
  centsFromNearest: number | null;
  rms: number;
  confidence: number;
  brightness: number | null;
  brightnessConfidence: number;
  yinValue: number | null;
  periodSamples: number | null;
  reason: YinPitchFrame["reason"];
  pitchCandidate: PitchCandidateDiagnostic | null;
  pitchTrackingDecision: PitchTrackingDecision | null;
}

export interface InputDiagnostic {
  rmsDbfs: number;
  peakDbfs: number;
  headroomDb: number;
  clipRatio: number;
  clippedSampleCount: number;
  sampleCount: number;
}

interface InputDiagnosticSource {
  rmsDbfs: number;
  peakDbfs: number;
  headroomDb: number;
  clipRatio: number;
  clippedSampleCount: number;
  sampleCount: number;
}

export interface PitchDiagnostic {
  frame: FrameDiagnostic;
  /** Synchronous production detector time for this PCM window. */
  processingMs: number;
  input?: InputDiagnostic;
}

export interface MicrophoneDiagnostic {
  state: "off" | "starting" | "ready" | "error" | "stream-ended";
  sampleRate?: number | null;
  bufferSize?: number | null;
  minFrequencyHz?: number | null;
  maxFrequencyHz?: number | null;
  yinThreshold?: number | null;
  minConfidence?: number | null;
  echoCancellation?: boolean | null;
  noiseSuppression?: boolean | null;
  autoGainControl?: boolean | null;
  errorCode?: string | null;
}

export type DiagnosticEvent =
  | { elapsedMs: number; kind: "microphone-state"; microphone: MicrophoneDiagnostic }
  | { elapsedMs: number; kind: "pitch-frame"; pitch: PitchDiagnostic };

export interface DiagnosticBatch {
  version: typeof PITCH_DIAGNOSTIC_VERSION;
  sessionId: string;
  sequence: number;
  flow: typeof DIAGNOSTIC_FLOW;
  droppedEvents?: number;
  events: DiagnosticEvent[];
}

type EventWithoutElapsed = DiagnosticEvent extends infer Event
  ? Event extends DiagnosticEvent
    ? Omit<Event, "elapsedMs">
    : never
  : never;

interface DiagnosticTransportOptions {
  enabled?: boolean;
  endpoint?: string;
  sessionId?: string;
  now?: () => number;
  fetcher?: typeof fetch;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
  batchDelayMs?: number;
  maximumBatchEvents?: number;
  maximumBufferedEvents?: number;
}

interface DiagnosticBuffer {
  events: DiagnosticEvent[];
  sequence: number;
  droppedEvents: number;
  timer: number | null;
  sending: boolean;
}

function positiveIntegerOption(name: string, value: number, maximum: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function finiteClockValue(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number.`);
  }
  return value;
}

function boundedNumber(value: number | null | undefined, digits = 4): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function diagnosticNumber(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
  digits: number,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return boundedNumber(value, digits)!;
}

function optionalDiagnosticNumber(
  value: number | null,
  label: string,
  minimum: number,
  maximum: number,
  digits: number,
): number | null {
  return value === null ? null : diagnosticNumber(value, label, minimum, maximum, digits);
}

function diagnosticInteger(
  value: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be a nonnegative safe integer no greater than ${maximum}.`);
  }
  return value;
}

export function toDiagnosticToken(value: string, fallback = "unknown"): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "")
    .slice(0, 48);
  return normalized || fallback;
}

let fallbackSessionSequence = 0;

function createSessionId(): string {
  const cryptoApi = typeof globalThis.crypto === "object" ? globalThis.crypto : undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID().replaceAll("-", "");
  if (cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  // A secure-context browser always exposes Web Crypto. This fallback exists
  // only for non-browser test/embedding runtimes and avoids a weak Math.random
  // correlation key by combining independent monotonic document coordinates.
  fallbackSessionSequence += 1;
  const timeOrigin = typeof performance === "object" && Number.isFinite(performance.timeOrigin)
    ? Math.floor(performance.timeOrigin * 1_000)
    : Date.now() * 1_000;
  const monotonic = typeof performance === "object" && typeof performance.now === "function"
    ? Math.floor(performance.now() * 1_000)
    : 0;
  return `local${timeOrigin.toString(36)}${monotonic.toString(36)}${fallbackSessionSequence.toString(36)}`
    .slice(0, 32);
}

function defaultNow(): number {
  return typeof performance === "object" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function defaultSetTimer(callback: () => void, delayMs: number): number {
  return globalThis.setTimeout(callback, delayMs) as unknown as number;
}

function defaultClearTimer(timer: number): void {
  globalThis.clearTimeout(timer);
}

export function toFrameDiagnostic(frame: Readonly<FrameDiagnosticSource>): FrameDiagnostic {
  if (!DIAGNOSTIC_OBSERVATION_KINDS.includes(frame.observationKind)) {
    throw new RangeError("Frame observationKind is not part of the diagnostic contract.");
  }
  const startSample = diagnosticInteger(frame.startSample, "Frame startSample");
  const endSample = diagnosticInteger(frame.endSample, "Frame endSample");
  const processedSampleCount = diagnosticInteger(
    frame.processedSampleCount,
    "Frame processedSampleCount",
  );
  if (startSample >= endSample) {
    throw new RangeError("Frame sample coordinates must describe a nonempty half-open window.");
  }
  if (endSample !== processedSampleCount) {
    throw new RangeError("Frame endSample must equal processedSampleCount.");
  }
  if (typeof frame.discontinuity !== "boolean") {
    throw new TypeError("Frame discontinuity must be boolean.");
  }

  const coordinates = [
    frame.frequencyHz,
    frame.midiFloat,
    frame.nearestMidi,
    frame.centsFromNearest,
  ];
  const hasEveryPitchCoordinate = coordinates.every((value) => value !== null);
  const hasAnyPitchCoordinate = coordinates.some((value) => value !== null);
  if (frame.observationKind === "voiced") {
    if (!frame.voiced || !hasEveryPitchCoordinate || frame.reason !== "detected") {
      throw new RangeError("A voiced observation must contain one complete detected pitch.");
    }
  } else if (frame.voiced || hasAnyPitchCoordinate || frame.reason === "detected") {
    throw new RangeError("An unvoiced or uncertain observation cannot admit pitch coordinates.");
  }
  if (frame.observationKind !== "voiced" && (
    frame.brightness !== null || frame.brightnessConfidence !== 0
  )) {
    throw new RangeError("An unvoiced or uncertain observation cannot admit brightness evidence.");
  }
  if (frame.brightness === null && frame.brightnessConfidence !== 0) {
    throw new RangeError("Missing brightness must carry zero brightness confidence.");
  }

  const {
    sampleRate,
    frequencyHz,
    midiFloat,
    nearestMidi,
    centsFromNearest,
  } = serializeLivePitchCoordinates(frame);

  return {
    observationKind: frame.observationKind,
    timeSeconds: diagnosticNumber(
      frame.timeSeconds,
      "Frame timeSeconds",
      0,
      Number.MAX_SAFE_INTEGER,
      6,
    ),
    sampleRate,
    startSample,
    endSample,
    processedSampleCount,
    captureEpoch: diagnosticInteger(frame.captureEpoch, "Frame captureEpoch"),
    continuityEpoch: diagnosticInteger(frame.continuityEpoch, "Frame continuityEpoch"),
    graphGeneration: diagnosticInteger(frame.graphGeneration, "Frame graphGeneration"),
    discontinuity: frame.discontinuity,
    workletProcessCount: diagnosticInteger(
      frame.workletProcessCount,
      "Frame workletProcessCount",
    ),
    periodicity: diagnosticNumber(frame.periodicity, "Frame periodicity", 0, 1, 4),
    voiced: frame.voiced,
    frequencyHz,
    midiFloat,
    nearestMidi,
    centsFromNearest,
    rms: diagnosticNumber(frame.rms, "Frame rms", 0, 4, 6),
    confidence: diagnosticNumber(frame.confidence, "Frame confidence", 0, 1, 4),
    brightness: optionalDiagnosticNumber(
      frame.brightness,
      "Frame brightness",
      0,
      1,
      5,
    ),
    brightnessConfidence: diagnosticNumber(
      frame.brightnessConfidence,
      "Frame brightnessConfidence",
      0,
      1,
      4,
    ),
    yinValue: optionalDiagnosticNumber(frame.yinValue, "Frame yinValue", 0, 10, 5),
    periodSamples: optionalDiagnosticNumber(
      frame.periodSamples,
      "Frame periodSamples",
      1,
      1_000_000,
      4,
    ),
    reason: frame.reason,
    pitchCandidate: serializePitchCandidate(frame.pitchCandidate, sampleRate),
    pitchTrackingDecision: frame.pitchTrackingDecision ?? null,
  };
}

export function toInputDiagnostic(telemetry: Readonly<InputDiagnosticSource>): InputDiagnostic {
  return {
    rmsDbfs: boundedNumber(telemetry.rmsDbfs, 2) ?? -120,
    peakDbfs: boundedNumber(telemetry.peakDbfs, 2) ?? -120,
    headroomDb: boundedNumber(telemetry.headroomDb, 2) ?? 0,
    clipRatio: boundedNumber(telemetry.clipRatio, 6) ?? 0,
    clippedSampleCount: telemetry.clippedSampleCount,
    sampleCount: telemetry.sampleCount,
  };
}

export class PitchDiagnosticTransport {
  readonly sessionId: string;
  private readonly endpoint: string;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch | null;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (timer: number) => void;
  private readonly batchDelayMs: number;
  private readonly maximumBatchEvents: number;
  private readonly maximumBufferedEvents: number;
  private startedAtMs: number;
  private enabled: boolean;
  private readonly buffer: DiagnosticBuffer = {
    events: [], sequence: 0, droppedEvents: 0, timer: null, sending: false,
  };

  constructor(options: DiagnosticTransportOptions = {}) {
    this.endpoint = options.endpoint ?? "/api/diagnostics/pitch";
    this.sessionId = options.sessionId ?? createSessionId();
    if (!/^[a-zA-Z0-9_-]{8,32}$/u.test(this.sessionId)) {
      throw new RangeError("Diagnostic sessionId must contain 8-32 URL-safe characters.");
    }
    this.now = options.now ?? defaultNow;
    this.fetcher = options.fetcher ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
    this.batchDelayMs = options.batchDelayMs ?? 1_000;
    if (!Number.isFinite(this.batchDelayMs) || this.batchDelayMs < 0 || this.batchDelayMs > 60_000) {
      throw new RangeError("batchDelayMs must be between 0 and 60000 milliseconds.");
    }
    this.maximumBatchEvents = positiveIntegerOption(
      "maximumBatchEvents",
      options.maximumBatchEvents ?? 24,
      32,
    );
    this.maximumBufferedEvents = positiveIntegerOption(
      "maximumBufferedEvents",
      options.maximumBufferedEvents ?? 4_096,
      4_096,
    );
    this.startedAtMs = finiteClockValue(this.now(), "Diagnostic clock start");
    this.enabled = options.enabled ?? false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.startedAtMs = finiteClockValue(this.now(), "Diagnostic clock start");
      return;
    }
    if (this.buffer.timer !== null) this.clearTimer(this.buffer.timer);
    this.buffer.events.length = 0;
    this.buffer.droppedEvents = 0;
    this.buffer.timer = null;
  }

  record(event: EventWithoutElapsed): void {
    if (!this.enabled) return;
    if (event.kind === "microphone-state") {
      validateMicrophoneSignalContract(event.microphone);
    } else if (event.kind === "pitch-frame") {
      validateSerializedFrameSignalContract(event.pitch.frame);
    }
    const buffer = this.buffer;
    const currentMs = finiteClockValue(this.now(), "Diagnostic clock value");
    const elapsed = currentMs - this.startedAtMs;
    const elapsedMs = Math.max(0, Math.round(finiteClockValue(elapsed, "Diagnostic elapsed time")));
    buffer.events.push({ ...event, elapsedMs } as DiagnosticEvent);
    if (buffer.events.length > this.maximumBufferedEvents) {
      const overflow = buffer.events.length - this.maximumBufferedEvents;
      buffer.events.splice(0, overflow);
      buffer.droppedEvents += overflow;
    }
    if (buffer.events.length >= this.maximumBatchEvents) {
      void this.flush();
      return;
    }
    if (!buffer.sending && buffer.timer === null) {
      buffer.timer = this.setTimer(() => {
        buffer.timer = null;
        void this.flush();
      }, this.batchDelayMs);
    }
  }

  async flush(): Promise<void> {
    const buffer = this.buffer;
    if (!this.enabled || buffer.sending || buffer.events.length === 0 || this.fetcher === null) return;
    if (buffer.timer !== null) {
      this.clearTimer(buffer.timer);
      buffer.timer = null;
    }
    const events = buffer.events.splice(0, this.maximumBatchEvents);
    const droppedEvents = buffer.droppedEvents;
    buffer.droppedEvents = 0;
    const batch: DiagnosticBatch = {
      version: PITCH_DIAGNOSTIC_VERSION,
      sessionId: this.sessionId,
      sequence: buffer.sequence,
      flow: DIAGNOSTIC_FLOW,
      ...(droppedEvents > 0 ? { droppedEvents } : {}),
      events,
    };
    buffer.sequence += 1;
    buffer.sending = true;
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        keepalive: true,
        body: JSON.stringify(batch),
      });
      if (!response.ok) throw new Error(`Diagnostic endpoint returned HTTP ${response.status}.`);
    } catch {
      // Diagnostics are deliberately lossy and must never delay audio or a
      // workflow. Account for the rejected batch in the next successful one.
      buffer.droppedEvents += droppedEvents + events.length;
    } finally {
      buffer.sending = false;
      if (buffer.events.length > 0 && buffer.timer === null) {
        // A full batch accumulated while the previous request was in flight.
        // Drain it at the server's four-request-per-second sustained cadence
        // instead of sleeping a full second while 50 Hz evidence overflows.
        const delayMs = buffer.events.length >= this.maximumBatchEvents
          ? Math.min(this.batchDelayMs, 250)
          : this.batchDelayMs;
        buffer.timer = this.setTimer(() => {
          buffer.timer = null;
          void this.flush();
        }, delayMs);
      }
    }
  }

  flushAll(): void {
    void this.flush();
  }
}

export const pitchDiagnostics = new PitchDiagnosticTransport();

if (typeof window === "object") {
  window.addEventListener("pagehide", () => {
    pitchDiagnostics.flushAll();
  });
}
