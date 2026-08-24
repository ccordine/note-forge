import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { YinPitchFrame } from "@noteforge/pitch-engine";
import type { VocalObservation } from "../apps/web/src/audio/note-input";
import type {
  AudioInputController,
  InputTelemetry,
} from "../apps/web/src/audio/use-audio-input";
import {
  AudioInputProvider,
  useAudioInputStatus,
} from "../apps/web/src/audio/use-audio-input";
import { NoteInput } from "../apps/web/src/ui/voice/NoteInput";
import { createVoiceCoachView } from "../apps/web/src/ui/voice/view";

function frame(midiFloat: number, reason: YinPitchFrame["reason"] = "detected"): VocalObservation {
  const voiced = reason === "detected";
  const nearestMidi = voiced ? Math.round(midiFloat) : null;
  return {
    timeSeconds: 1,
    frequencyHz: voiced ? 130.8128 : null,
    midiFloat: voiced ? midiFloat : null,
    nearestMidi,
    centsFromNearest: voiced ? (midiFloat - nearestMidi!) * 100 : null,
    rms: 0.1,
    confidence: voiced ? 0.9 : 0.7,
    voiced,
    detector: "yin",
    periodSamples: voiced ? 366.9 : null,
    yinValue: voiced ? 0.1 : null,
    reason,
    observationKind: voiced ? "voiced" : reason === "below-rms-threshold" || reason === "no-periodic-candidate" ? "unvoiced" : "uncertain",
    sampleRate: 48_000,
    startSample: 0,
    endSample: 4_096,
    processedSampleCount: 4_096,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: 32,
    discontinuity: false,
    periodicity: voiced ? 0.9 : 0,
    brightness: voiced ? 0.24 : null,
    brightnessConfidence: voiced ? 0.82 : 0,
  };
}

const waitingHold = {
  heldSeconds: 0,
  requiredSeconds: 1.5,
  status: "waiting" as const,
};

function inputController(
  overrides: Partial<AudioInputController> = {},
): AudioInputController {
  let controller: AudioInputController;
  const subscribe = () => () => undefined;
  controller = {
    state: "disabled",
    error: "",
    microphoneInfo: null,
    liveFrame: undefined,
    liveNote: null,
    processedWindowCount: 0,
    processedSampleCount: 0,
    workletProcessCount: 0,
    captureEpoch: 0,
    continuityEpoch: 0,
    graphGeneration: 0,
    transportRepairCount: 0,
    telemetry: null,
    enable: async () => null,
    disable: () => undefined,
    createRecorder: () => { throw new Error("Recorder unavailable in render test."); },
    subscribeTransport: subscribe,
    subscribePitch: subscribe,
    subscribeCounters: subscribe,
    subscribeTelemetry: subscribe,
    subscribeHistory: subscribe,
    getTransportSnapshot: () => ({
      state: controller.state,
      error: controller.error,
      microphoneInfo: controller.microphoneInfo,
      transportRepairCount: controller.transportRepairCount,
    }),
    getPitchSnapshot: () => ({
      liveFrame: controller.liveFrame,
      liveNote: controller.liveNote,
    }),
    getCounterSnapshot: () => ({
      processedWindowCount: controller.processedWindowCount,
      processedSampleCount: controller.processedSampleCount,
      workletProcessCount: controller.workletProcessCount,
      captureEpoch: controller.captureEpoch,
      continuityEpoch: controller.continuityEpoch,
      graphGeneration: controller.graphGeneration,
    }),
    getTelemetrySnapshot: () => ({ telemetry: controller.telemetry }),
    getHistorySnapshot: () => ({
      frames: [],
      telemetryHistory: [],
    }),
    ...overrides,
  };
  return controller;
}

function telemetry(capturedAt: number, rmsDbfs: number, peakDbfs: number): InputTelemetry {
  return {
    capturedAt,
    rms: 10 ** (rmsDbfs / 20),
    peak: 10 ** (peakDbfs / 20),
    rmsDbfs,
    peakDbfs,
    dcOffset: 0,
    clippedSampleCount: 0,
    clipRatio: 0,
    sampleCount: 1_024,
    headroomDb: -peakDbfs,
  };
}

describe("first-party coached-workflow component contracts", () => {
  it("publishes immutable shared input evidence to every consumer", () => {
    const observed: { current?: AudioInputController } = {};
    function Observer() {
      observed.current = useAudioInputStatus();
      return null;
    }

    renderToStaticMarkup(createElement(
      AudioInputProvider,
      null,
      createElement(Observer),
    ));

    expect(Object.isFrozen(observed.current)).toBe(true);
    expect(observed.current?.getHistorySnapshot().frames).toEqual([]);
  });

  it("derives meter direction and lock from the exact frame supplied to scoring", () => {
    const flat = createVoiceCoachView({
      inputState: "running",
      targetMidi: 48,
      toleranceCents: 20,
      phase: "listening",
      frame: frame(47.7),
      hold: waitingHold,
    });
    const locked = createVoiceCoachView({
      inputState: "running",
      targetMidi: 48,
      toleranceCents: 20,
      phase: "listening",
      frame: frame(48.08),
      hold: { ...waitingHold, heldSeconds: 0.5, status: "holding" },
    });
    const sharp = createVoiceCoachView({
      inputState: "running",
      targetMidi: 48,
      toleranceCents: 20,
      phase: "listening",
      frame: frame(48.35),
      hold: waitingHold,
    });

    expect(flat).toMatchObject({ guidanceTone: "flat", errorCents: expect.closeTo(-30, 6), inBand: false });
    expect(locked).toMatchObject({ guidanceTone: "locked", errorCents: expect.closeTo(8, 6), inBand: true });
    expect(sharp).toMatchObject({ guidanceTone: "sharp", errorCents: expect.closeTo(35, 6), inBand: false });
  });

  it("does not present a fabricated live measurement while input is off or unavailable", () => {
    const off = createVoiceCoachView({
      inputState: "disabled",
      targetMidi: 48,
      toleranceCents: 20,
      phase: "listening",
      frame: frame(48),
      hold: waitingHold,
    });
    const unavailable = createVoiceCoachView({
      inputState: "error",
      inputError: "Permission denied",
      targetMidi: 48,
      toleranceCents: 20,
      phase: "listening",
      frame: frame(48),
      hold: waitingHold,
    });

    expect(off).toMatchObject({
      measuredNote: "—",
      guidanceTitle: "Voice input is off",
      holdLabel: "MICROPHONE OFF",
      errorCents: null,
      inBand: false,
    });
    expect(unavailable).toMatchObject({
      measuredNote: "—",
      guidanceTitle: "Microphone unavailable",
      guidanceDetail: "Permission denied",
      holdLabel: "MICROPHONE ERROR",
      errorCents: null,
      inBand: false,
    });
  });

  it("renders the current live scope structure and truthful disabled versus running state", () => {
    const disabledMarkup = renderToStaticMarkup(createElement(NoteInput, {
      variant: "scope",
      input: inputController(),
    }));
    const liveFrame = frame(48);
    const levelHistory = [telemetry(1, -60, -48), telemetry(2, -54, -42)];
    const runningMarkup = renderToStaticMarkup(createElement(NoteInput, {
      variant: "scope",
      input: inputController({
        state: "running",
        microphoneInfo: {
          label: "Deterministic microphone",
          settings: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          constraints: {},
          sampleRate: 48_000,
          analysisWindowSize: 4_096,
          analysisHopSize: 960,
          meterWindowSize: 1_024,
          captureEpoch: 1,
        },
        liveFrame,
        processedWindowCount: 1,
        telemetry: levelHistory[1]!,
      }),
    }));

    expect(disabledMarkup).toContain("data-note-input");
    expect(disabledMarkup).toContain('data-input-state="disabled"');
    expect(disabledMarkup).toContain("MICROPHONE OFF");
    expect(disabledMarkup).toContain("Input is off");
    expect(disabledMarkup).not.toContain("Enable input");
    expect(disabledMarkup).not.toContain('data-detected-note="C3"');

    for (const className of [
      "scope-module pitch-module scope-primary-result locked",
      "scope-pitch-lane",
    ]) {
      expect(runningMarkup).toContain(`class="${className}`);
    }
    expect(runningMarkup).toContain('data-note-input');
    expect(runningMarkup).toContain('data-input-state="running"');
    expect(runningMarkup).toContain('data-detected-note="C3"');
    expect(runningMarkup).toContain('data-end-sample="4096"');
    expect(runningMarkup).toContain('data-capture-epoch="1"');
    expect(runningMarkup).toContain('data-continuity-epoch="0"');
    expect(runningMarkup).toContain('data-graph-generation="0"');
    expect(runningMarkup).toContain("LIVE PCM → NOTE · CONTINUOUS");
    expect(runningMarkup).toContain('<details class="scope-advanced">');
    expect(runningMarkup).toContain("Advanced PCM diagnostics");
    expect(runningMarkup).not.toContain("Stop input");
    expect(runningMarkup).not.toContain("scope-history-line");
    expect(runningMarkup).not.toContain("INPUT RMS");
    expect(runningMarkup).not.toContain("48,000 Hz");
  });

  it("does not leak a stale target-coach frame while microphone input is off or failed", () => {
    const staleFrame = frame(48);
    const staleTelemetry = telemetry(1, -54, -42);
    const renderTarget = (input: AudioInputController) => renderToStaticMarkup(
      createElement(NoteInput, {
        variant: "target",
        input,
        targetMidi: 48,
        toleranceCents: 20,
        phase: "listening",
        hold: waitingHold,
      }),
    );
    const disabledMarkup = renderTarget(inputController({
      liveFrame: staleFrame,
      telemetry: staleTelemetry,
    }));
    const errorMarkup = renderTarget(inputController({
      state: "error",
      error: "Permission denied",
      liveFrame: staleFrame,
      telemetry: staleTelemetry,
    }));
    const runningMarkup = renderTarget(inputController({
      state: "running",
      liveFrame: staleFrame,
      telemetry: staleTelemetry,
    }));

    for (const markup of [disabledMarkup, errorMarkup]) {
      expect(markup).toContain('data-detected-note=""');
      expect(markup).not.toContain("130.81 Hz");
      expect(markup).not.toContain("90% CONFIDENCE");
      expect(markup).not.toContain("-54 dBFS");
      expect(markup).not.toContain("DIRECT FRAME <b>48.000</b>");
    }
    expect(disabledMarkup).toContain("MICROPHONE OFF");
    expect(errorMarkup).toContain("MICROPHONE ERROR");
    expect(errorMarkup).toContain("Permission denied");
    expect(runningMarkup).toContain('data-detected-note="C3"');
    expect(runningMarkup).toContain("130.81 Hz");
    expect(runningMarkup).not.toContain("90% CONFIDENCE");
    expect(runningMarkup).not.toContain("-54 dBFS");
    expect(runningMarkup).not.toContain("MIC LEVEL");
    expect(runningMarkup).toContain("DIRECT FRAME <b>48.000</b>");
  });

  it("renders the latest unvoiced observation instead of an older voiced frame", () => {
    const currentFrame = frame(48, "below-rms-threshold");
    const currentTelemetry = telemetry(2, -96, -96);
    const input = inputController({
      state: "running",
      liveFrame: currentFrame,
      telemetry: currentTelemetry,
    });
    const scopeMarkup = renderToStaticMarkup(createElement(NoteInput, {
      variant: "scope",
      input,
    }));
    const targetMarkup = renderToStaticMarkup(createElement(NoteInput, {
      variant: "target",
      input,
      targetMidi: 48,
      toleranceCents: 20,
      phase: "listening",
      hold: waitingHold,
    }));

    for (const markup of [scopeMarkup, targetMarkup]) {
      expect(markup).not.toContain('data-detected-note="C3"');
      expect(markup).not.toContain("130.81 Hz");
      expect(markup).not.toContain("DIRECT FRAME <b>48.000</b>");
    }
    expect(scopeMarkup).not.toContain("below-rms-threshold");
    expect(targetMarkup).toContain("below-rms-threshold");
  });

});
