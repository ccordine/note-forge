import { useCallback, useEffect, useRef, useState } from "react";
import { detectPitch, type YinPitchFrame } from "@noteforge/pitch-engine";
import {
  applyGateHysteresis,
  dbfsToAmplitude,
  deriveNoiseGateThresholds,
  estimateNoiseFloorDbfs,
  type NoiseGateThresholds
} from "./input-analysis";
import { MicrophoneCapture, type CapturedLevel, type MicrophoneInfo } from "./microphone";
import { getSetting, setSetting } from "@/storage/database";

export type AudioInputState = "off" | "starting" | "ready" | "error";

export interface InputTelemetry extends CapturedLevel {
  noiseFloorDbfs: number | null;
  noiseCeilingDbfs: number | null;
  gateThresholdDbfs: number;
  gateCloseThresholdDbfs: number;
  gateOpen: boolean;
  signalMarginDb: number | null;
  headroomDb: number;
}

export interface NoiseCalibrationState {
  status: "idle" | "calibrating" | "complete" | "warning";
  progress: number;
  frameCount: number;
  quality?: "good" | "variable-noise" | "clipped" | "too-loud";
  message?: string;
}

export interface DetectorProfile {
  minFrequency?: number;
  maxFrequency?: number;
  analysisWindowSize?: number | "maximum";
  yinThreshold?: number;
  minConfidence?: number;
  a4Frequency?: number;
}

export interface UseAudioInputOptions {
  detector?: DetectorProfile;
  fallbackRmsThreshold?: number;
  bufferSize?: number;
  maxFrames?: number;
  onFrame?: (frame: YinPitchFrame) => void;
}

interface StoredInputCalibration {
  version: 1;
  noiseFloorDbfs: number | null;
  noiseCeilingDbfs: number | null;
  gateMarginDb: number;
  measuredAt?: string;
}

export interface AudioInputController {
  state: AudioInputState;
  error: string;
  microphoneInfo: MicrophoneInfo | null;
  frames: YinPitchFrame[];
  liveFrame: YinPitchFrame | undefined;
  telemetry: InputTelemetry | null;
  telemetryHistory: InputTelemetry[];
  noiseFloorDbfs: number | null;
  noiseCeilingDbfs: number | null;
  gateMarginDb: number;
  gateThresholdDbfs: number;
  gateRmsThreshold: number;
  calibration: NoiseCalibrationState;
  start: () => Promise<MicrophoneInfo | null>;
  stop: () => void;
  clearFrames: () => void;
  beginCalibration: () => void;
  cancelCalibration: () => void;
  resetCalibration: () => void;
  setGateMarginDb: (marginDb: number) => void;
  getRmsThreshold: (fallback?: number) => number;
  getStream: () => MediaStream | null;
}

const CALIBRATION_DURATION_MS = 3_000;
const FALLBACK_OPEN_DBFS = -48;
const FALLBACK_CLOSE_DBFS = -52;
const DEFAULT_GATE_MARGIN_DB = 12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function deviceCalibrationKey(info: MicrophoneInfo): string {
  return `input-calibration.v1:${info.settings.deviceId || "default"}`;
}

function thresholdsFor(
  floorDbfs: number | null,
  ceilingDbfs: number | null,
  marginDb: number
): NoiseGateThresholds {
  if (floorDbfs === null) {
    return {
      noiseFloorDbfs: FALLBACK_CLOSE_DBFS,
      openThresholdDbfs: FALLBACK_OPEN_DBFS,
      closeThresholdDbfs: FALLBACK_CLOSE_DBFS,
      marginDb: FALLBACK_OPEN_DBFS - FALLBACK_CLOSE_DBFS,
      hysteresisDb: FALLBACK_OPEN_DBFS - FALLBACK_CLOSE_DBFS
    };
  }

  // A median floor ignores short intrusions; the upper calibration percentile
  // keeps an intermittently noisy room from opening the detector by accident.
  const effectiveFloor = ceilingDbfs === null
    ? floorDbfs
    : Math.max(floorDbfs, ceilingDbfs + 6 - marginDb);
  return deriveNoiseGateThresholds(effectiveFloor, {
    marginDb,
    hysteresisDb: 4,
    minimumDbfs: -72,
    maximumDbfs: -18
  });
}

export function useAudioInput(options: UseAudioInputOptions = {}): AudioInputController {
  const captureRef = useRef(new MicrophoneCapture());
  const optionsRef = useRef(options);
  const stateRef = useRef<AudioInputState>("off");
  const microphoneInfoRef = useRef<MicrophoneInfo | null>(null);
  const calibrationKeyRef = useRef("input-calibration.v1:default");
  const calibrationLoadRef = useRef(0);
  const calibrationStartedAtRef = useRef(0);
  const calibrationReadingsRef = useRef<number[]>([]);
  const calibrationClippedFramesRef = useRef(0);
  const calibrationActiveRef = useRef(false);
  const noiseFloorRef = useRef<number | null>(null);
  const noiseCeilingRef = useRef<number | null>(null);
  const gateMarginRef = useRef(DEFAULT_GATE_MARGIN_DB);
  const gateOpenRef = useRef(false);
  const lastTelemetryRef = useRef<InputTelemetry | null>(null);
  const levelSequenceRef = useRef(0);

  const [state, setState] = useState<AudioInputState>("off");
  const [error, setError] = useState("");
  const [microphoneInfo, setMicrophoneInfo] = useState<MicrophoneInfo | null>(null);
  const [frames, setFrames] = useState<YinPitchFrame[]>([]);
  const [telemetry, setTelemetry] = useState<InputTelemetry | null>(null);
  const [telemetryHistory, setTelemetryHistory] = useState<InputTelemetry[]>([]);
  const [noiseFloorDbfs, setNoiseFloorDbfs] = useState<number | null>(null);
  const [noiseCeilingDbfs, setNoiseCeilingDbfs] = useState<number | null>(null);
  const [gateMarginDb, setGateMarginState] = useState(DEFAULT_GATE_MARGIN_DB);
  const [calibration, setCalibration] = useState<NoiseCalibrationState>({
    status: "idle",
    progress: 0,
    frameCount: 0
  });

  optionsRef.current = options;

  const persistCalibration = useCallback((record?: Partial<StoredInputCalibration>) => {
    const value: StoredInputCalibration = {
      version: 1,
      noiseFloorDbfs: noiseFloorRef.current,
      noiseCeilingDbfs: noiseCeilingRef.current,
      gateMarginDb: gateMarginRef.current,
      ...record
    };
    void setSetting(calibrationKeyRef.current, value).catch(() => undefined);
  }, []);

  const applyStoredCalibration = useCallback(async (info: MicrophoneInfo) => {
    const key = deviceCalibrationKey(info);
    calibrationKeyRef.current = key;
    const loadSequence = ++calibrationLoadRef.current;
    try {
      const stored = await getSetting<StoredInputCalibration>(key);
      if (loadSequence !== calibrationLoadRef.current || !stored || stored.version !== 1) return;
      const margin = clamp(stored.gateMarginDb, 6, 24);
      noiseFloorRef.current = stored.noiseFloorDbfs;
      noiseCeilingRef.current = stored.noiseCeilingDbfs;
      gateMarginRef.current = margin;
      gateOpenRef.current = false;
      setNoiseFloorDbfs(stored.noiseFloorDbfs);
      setNoiseCeilingDbfs(stored.noiseCeilingDbfs);
      setGateMarginState(margin);
      if (stored.noiseFloorDbfs !== null) {
        setCalibration({ status: "complete", progress: 1, frameCount: 0, quality: "good", message: "Saved room calibration loaded." });
      }
    } catch {
      // IndexedDB may be unavailable in a locked-down context; live metering
      // and session calibration still work without persistence.
    }
  }, []);

  const finishCalibration = useCallback(() => {
    const readings = calibrationReadingsRef.current;
    const floor = estimateNoiseFloorDbfs(readings, { quantile: 0.5, minimumDbfs: -96, maximumDbfs: 0 });
    const ceiling = estimateNoiseFloorDbfs(readings, { quantile: 0.9, minimumDbfs: -96, maximumDbfs: 0 });
    calibrationActiveRef.current = false;

    if (floor === null || ceiling === null || readings.length < 20) {
      setCalibration({ status: "warning", progress: 1, frameCount: readings.length, message: "Not enough input arrived. Check the selected microphone and try again." });
      return;
    }

    noiseFloorRef.current = floor;
    noiseCeilingRef.current = ceiling;
    gateOpenRef.current = false;
    setNoiseFloorDbfs(floor);
    setNoiseCeilingDbfs(ceiling);
    const variability = ceiling - floor;
    const clipped = calibrationClippedFramesRef.current > 0;
    const tooLoud = floor > -28;
    const quality = clipped ? "clipped" : tooLoud ? "too-loud" : variability > 12 ? "variable-noise" : "good";
    const message = clipped
      ? "Clipping occurred while the room should have been quiet. Reduce input gain and recalibrate."
      : tooLoud
        ? "The room floor is very high. Move closer, lower the source noise, or raise the gate margin."
        : variability > 12
          ? "The background changed during calibration. The upper noise band is being guarded."
          : "Room floor captured. The detector gate now follows this microphone.";
    setCalibration({ status: quality === "good" ? "complete" : "warning", progress: 1, frameCount: readings.length, quality, message });
    persistCalibration({ measuredAt: new Date().toISOString() });
  }, [persistCalibration]);

  const handleLevel = useCallback((level: CapturedLevel) => {
    const thresholds = thresholdsFor(noiseFloorRef.current, noiseCeilingRef.current, gateMarginRef.current);
    gateOpenRef.current = applyGateHysteresis(gateOpenRef.current, level.rmsDbfs, thresholds);
    const next: InputTelemetry = {
      ...level,
      noiseFloorDbfs: noiseFloorRef.current,
      noiseCeilingDbfs: noiseCeilingRef.current,
      gateThresholdDbfs: thresholds.openThresholdDbfs,
      gateCloseThresholdDbfs: thresholds.closeThresholdDbfs,
      gateOpen: gateOpenRef.current,
      signalMarginDb: noiseFloorRef.current === null ? null : level.rmsDbfs - noiseFloorRef.current,
      headroomDb: Math.max(0, -level.peakDbfs)
    };
    lastTelemetryRef.current = next;

    if (calibrationActiveRef.current) {
      calibrationReadingsRef.current.push(level.rmsDbfs);
      if (level.clippedSampleCount > 0) calibrationClippedFramesRef.current += 1;
      const elapsed = performance.now() - calibrationStartedAtRef.current;
      if (elapsed >= CALIBRATION_DURATION_MS) finishCalibration();
      else if (levelSequenceRef.current % 2 === 0) {
        setCalibration({
          status: "calibrating",
          progress: clamp(elapsed / CALIBRATION_DURATION_MS, 0, 1),
          frameCount: calibrationReadingsRef.current.length,
          message: "Stay quiet while NoteForge measures the room."
        });
      }
    }

    // The worklet meters at roughly 47 Hz. Paint at half that cadence so the
    // scope feels continuous without forcing every laboratory to rerender 47×/s.
    levelSequenceRef.current += 1;
    if (levelSequenceRef.current % 2 === 0) {
      setTelemetry(next);
      setTelemetryHistory((current) => [...current.slice(-191), next]);
    }
  }, [finishCalibration]);

  const getRmsThreshold = useCallback((fallback?: number): number => {
    if (noiseFloorRef.current === null) {
      if (fallback !== undefined) return fallback;
      return dbfsToAmplitude(gateOpenRef.current ? FALLBACK_CLOSE_DBFS : FALLBACK_OPEN_DBFS);
    }
    const thresholds = thresholdsFor(noiseFloorRef.current, noiseCeilingRef.current, gateMarginRef.current);
    return dbfsToAmplitude(gateOpenRef.current ? thresholds.closeThresholdDbfs : thresholds.openThresholdDbfs);
  }, []);

  const start = useCallback(async (): Promise<MicrophoneInfo | null> => {
    if (stateRef.current === "ready") return microphoneInfoRef.current;
    if (stateRef.current === "starting") return null;
    stateRef.current = "starting";
    setState("starting");
    setError("");

    try {
      const info = await captureRef.current.start(({ samples, capturedAt, sampleRate }) => {
        const profile = optionsRef.current.detector ?? {};
        const minFrequency = profile.minFrequency ?? 65;
        const maximumAnalysisWindow = samples.length - Math.ceil(sampleRate / minFrequency) - 2;
        const requestedWindow = profile.analysisWindowSize === "maximum"
          ? maximumAnalysisWindow
          : profile.analysisWindowSize;
        const analysisWindowSize = requestedWindow === undefined
          ? undefined
          : Math.max(2, Math.min(requestedWindow, maximumAnalysisWindow));
        const frame = detectPitch(samples, {
          sampleRate,
          minFrequency,
          maxFrequency: profile.maxFrequency,
          analysisWindowSize,
          yinThreshold: profile.yinThreshold,
          minConfidence: profile.minConfidence,
          a4Frequency: profile.a4Frequency,
          rmsThreshold: getRmsThreshold(optionsRef.current.fallbackRmsThreshold),
          timeSeconds: capturedAt
        });
        const maxFrames = optionsRef.current.maxFrames ?? 280;
        setFrames((current) => [...current.slice(-(maxFrames - 1)), frame]);
        optionsRef.current.onFrame?.(frame);
      }, optionsRef.current.bufferSize ?? 4096, handleLevel);

      microphoneInfoRef.current = info;
      setMicrophoneInfo(info);
      void applyStoredCalibration(info);
      stateRef.current = "ready";
      setState("ready");
      return info;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Microphone access failed.";
      stateRef.current = "error";
      setState("error");
      setError(message);
      return null;
    }
  }, [applyStoredCalibration, getRmsThreshold, handleLevel]);

  const cancelCalibration = useCallback(() => {
    calibrationActiveRef.current = false;
    calibrationReadingsRef.current = [];
    calibrationClippedFramesRef.current = 0;
    setCalibration(noiseFloorRef.current === null
      ? { status: "idle", progress: 0, frameCount: 0 }
      : { status: "complete", progress: 1, frameCount: 0, quality: "good", message: "Previous room calibration retained." });
  }, []);

  const stop = useCallback(() => {
    captureRef.current.stop();
    calibrationActiveRef.current = false;
    calibrationReadingsRef.current = [];
    gateOpenRef.current = false;
    stateRef.current = "off";
    setState("off");
    setTelemetry(null);
    setTelemetryHistory([]);
    setCalibration((current) => current.status === "calibrating"
      ? noiseFloorRef.current === null
        ? { status: "idle", progress: 0, frameCount: 0 }
        : { status: "complete", progress: 1, frameCount: 0, quality: "good", message: "Room calibration retained." }
      : current);
  }, []);

  const beginCalibration = useCallback(() => {
    if (stateRef.current !== "ready") return;
    calibrationReadingsRef.current = [];
    calibrationClippedFramesRef.current = 0;
    calibrationStartedAtRef.current = performance.now();
    calibrationActiveRef.current = true;
    gateOpenRef.current = false;
    setCalibration({ status: "calibrating", progress: 0, frameCount: 0, message: "Stay quiet while NoteForge measures the room." });
  }, []);

  const resetCalibration = useCallback(() => {
    calibrationActiveRef.current = false;
    noiseFloorRef.current = null;
    noiseCeilingRef.current = null;
    gateOpenRef.current = false;
    setNoiseFloorDbfs(null);
    setNoiseCeilingDbfs(null);
    setCalibration({ status: "idle", progress: 0, frameCount: 0 });
    persistCalibration({ noiseFloorDbfs: null, noiseCeilingDbfs: null, measuredAt: undefined });
  }, [persistCalibration]);

  const setGateMarginDb = useCallback((marginDb: number) => {
    const next = clamp(marginDb, 6, 24);
    gateMarginRef.current = next;
    gateOpenRef.current = false;
    setGateMarginState(next);
    persistCalibration({ gateMarginDb: next });
  }, [persistCalibration]);

  const clearFrames = useCallback(() => setFrames([]), []);
  const getStream = useCallback(() => captureRef.current.getStream(), []);

  useEffect(() => () => {
    captureRef.current.stop();
    calibrationActiveRef.current = false;
  }, []);

  const gateThresholdDbfs = thresholdsFor(noiseFloorDbfs, noiseCeilingDbfs, gateMarginDb).openThresholdDbfs;
  const gateRmsThreshold = dbfsToAmplitude(gateThresholdDbfs);

  return {
    state,
    error,
    microphoneInfo,
    frames,
    liveFrame: frames.at(-1),
    telemetry,
    telemetryHistory,
    noiseFloorDbfs,
    noiseCeilingDbfs,
    gateMarginDb,
    gateThresholdDbfs,
    gateRmsThreshold,
    calibration,
    start,
    stop,
    clearFrames,
    beginCalibration,
    cancelCalibration,
    resetCalibration,
    setGateMarginDb,
    getRmsThreshold,
    getStream
  };
}
