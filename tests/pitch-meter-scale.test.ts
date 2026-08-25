import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { frequencyToMidi } from "@noteforge/music-core";
import { describe, expect, it } from "vitest";
import { NOTE_INPUT_DEFAULTS, type VocalObservation } from "../apps/web/src/audio/note-input";
import type { AudioInputController } from "../apps/web/src/audio/use-audio-input";
import { InputScope } from "../apps/web/src/ui/InputScope";
import {
  PitchRibbon,
  pitchRibbonYForMidi,
} from "../apps/web/src/features/pitch-mirror/PitchRibbon";
import { PitchTunnelLane } from "../apps/web/src/features/pitch-tunnel/PitchTunnelLane";
import {
  createPitchTunnel,
  pitchTunnelMetrics,
  type PitchTunnelState,
} from "../apps/web/src/features/pitch-tunnel/pitch-tunnel-engine";
import { VoiceCoach } from "../apps/web/src/ui/voice/VoiceCoach";
import { NoteInput } from "../apps/web/src/ui/voice/NoteInput";
import {
  PITCH_METER_FOCUS_LOWER_PERCENT,
  PITCH_METER_FOCUS_UPPER_PERCENT,
  PITCH_METER_LIVE_MAXIMUM_MIDI,
  PITCH_METER_LIVE_MINIMUM_MIDI,
  PITCH_METER_MAXIMUM_MIDI,
  PITCH_METER_MINIMUM_MIDI,
  PITCH_METER_TARGET_PERCENT,
  pitchMeterBandPercent,
  pitchMeterPositionPercent,
} from "../apps/web/src/ui/voice/pitch-meter-scale";

const C4_MIDI = 60;

function requirePosition(value: number | null): number {
  expect(value).not.toBeNull();
  return value!;
}

function frame(midiFloat: number, endSample = 4_096): VocalObservation {
  const nearestMidi = Math.round(midiFloat);
  return {
    timeSeconds: endSample / 48_000,
    frequencyHz: 440 * 2 ** ((midiFloat - 69) / 12),
    midiFloat,
    nearestMidi,
    centsFromNearest: (midiFloat - nearestMidi) * 100,
    rms: 0.1,
    confidence: 0.95,
    voiced: true,
    detector: "yin",
    periodSamples: 48_000 / (440 * 2 ** ((midiFloat - 69) / 12)),
    yinValue: 0.05,
    reason: "detected",
    observationKind: "voiced",
    sampleRate: 48_000,
    startSample: endSample - 4_096,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: Math.ceil(endSample / 128),
    discontinuity: false,
    periodicity: 0.95,
    brightness: 0.3,
    brightnessConfidence: 0.9,
  };
}

/** Deliberately contradictory evidence proves observation kind owns visibility. */
function uncertainCoordinateFrame(midiFloat: number): VocalObservation {
  return {
    ...frame(midiFloat),
    observationKind: "uncertain",
  };
}

function controllerFor(liveFrame: VocalObservation): AudioInputController {
  const subscribe = () => () => undefined;
  let controller: AudioInputController;
  controller = {
    state: "running",
    error: "",
    microphoneInfo: null,
    liveFrame,
    liveNote: null,
    processedWindowCount: 1,
    processedSampleCount: liveFrame.processedSampleCount,
    workletProcessCount: liveFrame.workletProcessCount,
    captureEpoch: liveFrame.captureEpoch,
    continuityEpoch: liveFrame.continuityEpoch,
    graphGeneration: liveFrame.graphGeneration,
    transportRepairCount: 0,
    telemetry: null,
    enable: async () => null,
    disable: () => undefined,
    createRecorder: () => { throw new Error("Recorder unavailable in meter render test."); },
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
    getPitchSnapshot: () => ({ liveFrame: controller.liveFrame, liveNote: controller.liveNote }),
    getCounterSnapshot: () => ({
      processedWindowCount: controller.processedWindowCount,
      processedSampleCount: controller.processedSampleCount,
      workletProcessCount: controller.workletProcessCount,
      captureEpoch: controller.captureEpoch,
      continuityEpoch: controller.continuityEpoch,
      graphGeneration: controller.graphGeneration,
    }),
    getTelemetrySnapshot: () => ({ telemetry: controller.telemetry }),
    getHistorySnapshot: () => ({ frames: [liveFrame], telemetryHistory: [] }),
  };
  return controller;
}

function renderedScopePosition(midiFloat: number): number {
  const markup = renderToStaticMarkup(createElement(InputScope, {
    input: controllerFor(frame(midiFloat)),
    targetMidiFloat: C4_MIDI,
    toleranceCents: 20,
  }));
  const match = markup.match(/<b[^>]*data-live-pitch-marker[^>]*style="[^"]*left:([\d.]+)%/u)
    ?? markup.match(/<b class="[^"]*" style="left:([\d.]+)%"/u);
  if (!match) throw new Error(`Rendered InputScope omitted its pitch cursor coordinate: ${markup}`);
  return Number(match[1]);
}

function renderedTickPositions(markup: string): readonly number[] {
  return [...markup.matchAll(/data-pitch-tick-position="([\d.]+)"/gu)]
    .map((match) => Number(match[1]));
}

function voiceCoachTickPositions(targetMidi: number): readonly number[] {
  return renderedTickPositions(renderToStaticMarkup(createElement(VoiceCoach, {
    inputState: "running",
    targetMidi,
    toleranceCents: 20,
    phase: "idle",
    hold: { heldSeconds: 0, requiredSeconds: 1, status: "waiting" },
  })));
}

function pitchTunnelStateAt(targetMidi: number): PitchTunnelState {
  const idle = createPitchTunnel({ checkpointOffsetsCents: [0] });
  return {
    ...idle,
    status: "tracking",
    anchorMidiFloat: targetMidi,
    currentObservationKind: "voiced",
    currentMidiFloat: targetMidi,
    currentPitchOffsetCents: 0,
    currentErrorCents: 0,
    currentAbsoluteErrorCents: 0,
    currentInLane: true,
    checkpoint: {
      index: 0,
      targetOffsetCents: 0,
      targetMidiFloat: targetMidi,
      enteredAtElapsedSeconds: 0,
      heldSeconds: 0,
      correctionLatencySeconds: 0,
      overshootCount: 0,
      lastErrorSide: 0,
      trackedSeconds: 0,
      inLaneSeconds: 0,
      signedErrorCentsSeconds: 0,
      absoluteErrorCentsSeconds: 0,
      squaredErrorCentsSeconds: 0,
    },
  };
}

function pitchTunnelTickPositions(targetMidi: number): readonly number[] {
  const state = pitchTunnelStateAt(targetMidi);
  return renderedTickPositions(renderToStaticMarkup(createElement(PitchTunnelLane, {
    inputState: "running",
    state,
    metrics: pitchTunnelMetrics(state),
  })));
}

describe("full-depth pitch meter scale", () => {
  it("gives detector interpolation allowance its own unique edge coordinates", () => {
    const minimumMidi = frequencyToMidi(NOTE_INPUT_DEFAULTS.minFrequency);
    const maximumMidi = frequencyToMidi(NOTE_INPUT_DEFAULTS.maxFrequency);

    expect(PITCH_METER_MINIMUM_MIDI).toBeCloseTo(minimumMidi, 12);
    expect(PITCH_METER_MAXIMUM_MIDI).toBeCloseTo(maximumMidi, 12);
    for (const target of [undefined, C4_MIDI]) {
      const positions = [
        PITCH_METER_LIVE_MINIMUM_MIDI,
        minimumMidi,
        maximumMidi,
        PITCH_METER_LIVE_MAXIMUM_MIDI,
      ].map((midi) => requirePosition(pitchMeterPositionPercent(midi, target)));
      expect(positions[0]).toBeCloseTo(0, 12);
      expect(positions.at(-1)).toBeCloseTo(100, 12);
      positions.slice(1).forEach((position, index) => {
        expect(position).toBeGreaterThan(positions[index]!);
      });
    }
  });

  it("keeps every supported semitone MIDI 30 through 86 strictly ordered", () => {
    const midis = Array.from({ length: 57 }, (_unused, index) => 30 + index);
    const absolute = midis.map((midi) => requirePosition(pitchMeterPositionPercent(midi)));
    const targetRelative = midis.map((midi) => requirePosition(
      pitchMeterPositionPercent(midi, C4_MIDI),
    ));

    for (const positions of [absolute, targetRelative]) {
      positions.slice(1).forEach((position, index) => {
        expect(position).toBeGreaterThan(positions[index]!);
      });
      expect(new Set(positions).size).toBe(midis.length);
    }
  });

  it("keeps the complete detector domain edge-to-edge for every edge-case target", () => {
    const targets = [
      PITCH_METER_MINIMUM_MIDI,
      30,
      C4_MIDI,
      86,
      PITCH_METER_MAXIMUM_MIDI,
    ];
    const supportedCoordinates = [
      PITCH_METER_LIVE_MINIMUM_MIDI,
      PITCH_METER_MINIMUM_MIDI,
      ...Array.from({ length: 57 }, (_unused, index) => 30 + index),
      PITCH_METER_MAXIMUM_MIDI,
      PITCH_METER_LIVE_MAXIMUM_MIDI,
    ];

    for (const target of targets) {
      const positions = supportedCoordinates.map((midi) => requirePosition(
        pitchMeterPositionPercent(midi, target),
      ));
      expect(positions[0], `minimum at target ${target}`).toBeCloseTo(0, 12);
      expect(positions.at(-1), `maximum at target ${target}`).toBeCloseTo(100, 12);
      positions.slice(1).forEach((position, index) => {
        expect(position, `coordinate ${index + 1} at target ${target}`)
          .toBeGreaterThan(positions[index]!);
      });
    }
  });

  it("shifts an edge target without changing the nominal fine-control slope", () => {
    const halfFocusWidth = PITCH_METER_TARGET_PERCENT
      - PITCH_METER_FOCUS_LOWER_PERCENT;
    const lowTargetPosition = requirePosition(pitchMeterPositionPercent(30, 30));
    const highTargetPosition = requirePosition(pitchMeterPositionPercent(86, 86));

    expect(lowTargetPosition).toBeCloseTo(
      (30 - PITCH_METER_LIVE_MINIMUM_MIDI) * halfFocusWidth,
      12,
    );
    expect(highTargetPosition).toBeCloseTo(
      100 - (PITCH_METER_LIVE_MAXIMUM_MIDI - 86) * halfFocusWidth,
      12,
    );
    expect(pitchMeterPositionPercent(30.25, 30)).toBeCloseTo(
      lowTargetPosition + halfFocusWidth / 4,
      12,
    );
    expect(pitchMeterPositionPercent(85.75, 86)).toBeCloseTo(
      highTargetPosition - halfFocusWidth / 4,
      12,
    );
    expect(pitchMeterPositionPercent(
      PITCH_METER_MINIMUM_MIDI,
      PITCH_METER_MINIMUM_MIDI,
    )).toBeGreaterThan(0);
    expect(pitchMeterPositionPercent(
      PITCH_METER_MAXIMUM_MIDI,
      PITCH_METER_MAXIMUM_MIDI,
    )).toBeLessThan(100);
    expect(pitchMeterPositionPercent(
      PITCH_METER_LIVE_MINIMUM_MIDI,
      PITCH_METER_MINIMUM_MIDI,
    )).toBeCloseTo(0, 12);
    expect(pitchMeterPositionPercent(
      PITCH_METER_LIVE_MAXIMUM_MIDI,
      PITCH_METER_MAXIMUM_MIDI,
    )).toBeCloseTo(100, 12);
  });

  it("renders unique in-domain axis ticks at edge and literal-boundary targets", () => {
    const targets = [
      PITCH_METER_MINIMUM_MIDI,
      30,
      86,
      PITCH_METER_MAXIMUM_MIDI,
    ];
    for (const target of targets) {
      for (const positions of [
        voiceCoachTickPositions(target),
        pitchTunnelTickPositions(target),
      ]) {
        expect(positions.length).toBeGreaterThanOrEqual(2);
        expect(positions[0]).toBeGreaterThan(0);
        expect(positions.at(-1)).toBeLessThan(100);
        expect(new Set(positions).size).toBe(positions.length);
        positions.slice(1).forEach((position, index) => {
          expect(position).toBeGreaterThan(positions[index]!);
        });
        expect(positions.every((position) => position >= 0 && position <= 100))
          .toBe(true);
      }
    }
  });

  it("rejects invalid targets and does not alias arbitrary live MIDI to an edge", () => {
    expect(() => pitchMeterPositionPercent(
      60,
      PITCH_METER_MINIMUM_MIDI - 0.001,
    )).toThrow(RangeError);
    expect(() => pitchMeterPositionPercent(
      null,
      PITCH_METER_MAXIMUM_MIDI + 0.001,
    )).toThrow(RangeError);
    expect(pitchMeterPositionPercent(PITCH_METER_LIVE_MINIMUM_MIDI - 0.001))
      .toBeNull();
    expect(pitchMeterPositionPercent(PITCH_METER_LIVE_MAXIMUM_MIDI + 0.001))
      .toBeNull();
    expect(pitchMeterPositionPercent(PITCH_METER_LIVE_MINIMUM_MIDI))
      .toBe(0);
    expect(pitchMeterPositionPercent(PITCH_METER_LIVE_MAXIMUM_MIDI))
      .toBe(100);
    expect(pitchMeterPositionPercent(PITCH_METER_MINIMUM_MIDI)).toBeGreaterThan(0);
    expect(pitchMeterPositionPercent(PITCH_METER_MAXIMUM_MIDI)).toBeLessThan(100);
  });

  it("reserves the central lens for exact target-relative fine control", () => {
    expect(pitchMeterPositionPercent(C4_MIDI, C4_MIDI))
      .toBe(PITCH_METER_TARGET_PERCENT);
    expect(pitchMeterPositionPercent(C4_MIDI - 1, C4_MIDI))
      .toBe(PITCH_METER_FOCUS_LOWER_PERCENT);
    expect(pitchMeterPositionPercent(C4_MIDI + 1, C4_MIDI))
      .toBe(PITCH_METER_FOCUS_UPPER_PERCENT);
    expect(pitchMeterPositionPercent(C4_MIDI - 0.5, C4_MIDI, 50))
      .toBe(PITCH_METER_FOCUS_LOWER_PERCENT);
    expect(pitchMeterPositionPercent(C4_MIDI + 0.5, C4_MIDI, 50))
      .toBe(PITCH_METER_FOCUS_UPPER_PERCENT);
  });

  it("does not collapse F-sharp1, C3, E3, and G3 against a C4 target", () => {
    const positions = [30, 48, 52, 55].map((midi) => requirePosition(
      pitchMeterPositionPercent(midi, C4_MIDI),
    ));

    positions.slice(1).forEach((position, index) => {
      expect(position).toBeGreaterThan(positions[index]!);
    });
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions.every((position) => position > 0)).toBe(true);
  });

  it("uses a linear full-detector coordinate when no target is supplied", () => {
    const span = PITCH_METER_LIVE_MAXIMUM_MIDI - PITCH_METER_LIVE_MINIMUM_MIDI;
    for (const midi of [30, 48, 52, 55, 60, 69, 86]) {
      expect(pitchMeterPositionPercent(midi)).toBeCloseTo(
        (midi - PITCH_METER_LIVE_MINIMUM_MIDI) / span * 100,
        12,
      );
    }
  });

  it("projects the tolerance band through the same fine-control lens", () => {
    const standardBand = pitchMeterBandPercent(C4_MIDI, 20);
    expect(standardBand.leftPercent).toBeCloseTo(44, 12);
    expect(standardBand.widthPercent).toBeCloseTo(12, 12);

    const narrowFocusBand = pitchMeterBandPercent(C4_MIDI, 10, 50);
    expect(narrowFocusBand.leftPercent).toBeCloseTo(44, 12);
    expect(narrowFocusBand.widthPercent).toBeCloseTo(12, 12);

    const lowerBoundaryBand = pitchMeterBandPercent(
      PITCH_METER_MINIMUM_MIDI,
      20,
    );
    const upperBoundaryBand = pitchMeterBandPercent(
      PITCH_METER_MAXIMUM_MIDI,
      20,
    );
    expect(lowerBoundaryBand.leftPercent).toBe(0);
    expect(lowerBoundaryBand.widthPercent).toBeGreaterThan(6);
    expect(upperBoundaryBand.leftPercent).toBeGreaterThan(0);
    expect(upperBoundaryBand.leftPercent + upperBoundaryBand.widthPercent).toBeCloseTo(
      100,
      12,
    );
  });

  it("renders distinct InputScope cursor coordinates from the same authoritative frames", () => {
    const positions = [30, 48, 52, 55].map(renderedScopePosition);
    positions.slice(1).forEach((position, index) => {
      expect(position).toBeGreaterThan(positions[index]!);
    });
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("removes current markers for non-authoritative evidence even if it carries a coordinate", () => {
    const uncertain = uncertainCoordinateFrame(C4_MIDI);
    const scope = renderToStaticMarkup(createElement(InputScope, {
      input: controllerFor(uncertain),
      targetMidiFloat: C4_MIDI,
      toleranceCents: 20,
    }));
    const coach = renderToStaticMarkup(createElement(VoiceCoach, {
      inputState: "running",
      targetMidi: C4_MIDI,
      toleranceCents: 20,
      phase: "listening",
      frame: uncertain,
      hold: { heldSeconds: 0, requiredSeconds: 1, status: "waiting" },
    }));
    const compact = renderToStaticMarkup(createElement(NoteInput, {
      variant: "compact",
      input: controllerFor(uncertain),
      compact: true,
    }));
    const ribbon = renderToStaticMarkup(createElement(PitchRibbon, {
      frames: [uncertain],
      targetMidiFloat: C4_MIDI,
      toleranceCents: 20,
    }));
    const tunnelState: PitchTunnelState = {
      ...pitchTunnelStateAt(C4_MIDI),
      currentObservationKind: "uncertain",
      currentMidiFloat: null,
      currentPitchOffsetCents: null,
      currentErrorCents: null,
      currentAbsoluteErrorCents: null,
      currentInLane: null,
    };
    const tunnel = renderToStaticMarkup(createElement(PitchTunnelLane, {
      inputState: "running",
      state: tunnelState,
      metrics: pitchTunnelMetrics(tunnelState),
    }));

    expect(scope).not.toContain("data-live-pitch-marker");
    expect(scope).toContain('data-live-midi=""');
    expect(coach).not.toContain("data-live-pitch-marker");
    expect(coach).toContain('data-live-midi=""');
    expect(compact).toContain('data-detected-note=""');
    expect(compact).not.toContain(">C4<");
    expect(ribbon).not.toContain("data-pitch-trace-segment");
    expect(ribbon).not.toContain("live-error-tag");
    expect(tunnel).not.toContain("data-live-pitch-marker");
    expect(tunnel).toContain('data-live-midi=""');
  });

  it("draws far-below notes at distinct heights in the scrolling pitch ribbon", () => {
    const yCoordinates = [30, 48, 52, 55].map((midi) => (
      pitchRibbonYForMidi(midi, C4_MIDI)
    ));
    yCoordinates.slice(1).forEach((coordinate, index) => {
      expect(coordinate).toBeLessThan(yCoordinates[index]!);
    });
    expect(new Set(yCoordinates).size).toBe(yCoordinates.length);
  });

  it("segments the scrolling trace on every sample-authority boundary", () => {
    const first = frame(C4_MIDI);
    const next = frame(C4_MIDI + 0.1, first.endSample + 960);
    const render = (last: VocalObservation) => renderToStaticMarkup(createElement(PitchRibbon, {
      frames: [first, last],
      targetMidiFloat: C4_MIDI,
      toleranceCents: 20,
    }));
    const segmentCount = (markup: string) => (
      [...markup.matchAll(/data-pitch-trace-segment/gu)].length
    );

    expect(segmentCount(render(next))).toBe(1);
    const boundaries: readonly VocalObservation[] = [
      { ...next, discontinuity: true },
      { ...next, captureEpoch: 2 },
      { ...next, continuityEpoch: 1 },
      { ...next, continuityEpoch: 1, graphGeneration: 1 },
      { ...next, sampleRate: 44_100, continuityEpoch: 1, graphGeneration: 1 },
      frame(C4_MIDI + 0.1, first.endSample + 1_920),
    ];
    for (const boundary of boundaries) {
      expect(segmentCount(render(boundary))).toBe(2);
    }
  });

  it("does not let duplicate or reordered trace evidence replace a newer point", () => {
    const first = frame(C4_MIDI);
    const duplicate = { ...first, midiFloat: C4_MIDI + 0.4 };
    const next = frame(C4_MIDI + 0.1, first.endSample + 960);
    const markup = renderToStaticMarkup(createElement(PitchRibbon, {
      frames: [first, duplicate, next],
      targetMidiFloat: C4_MIDI,
      toleranceCents: 20,
    }));

    expect([...markup.matchAll(/data-pitch-trace-segment/gu)]).toHaveLength(1);
    expect(markup).toContain(`data-end-sample="${next.endSample}"`);
    expect(markup).toContain(`data-live-midi="${next.midiFloat}"`);
    expect(markup.match(/<path d="([^"]+)" class="pitch-trace"/u)?.[1]).toContain(" L ");
    expect(markup).not.toContain(`data-live-midi="${duplicate.midiFloat}"`);
  });

  it("breaks the scrolling trace around malformed sample identity", () => {
    const first = frame(C4_MIDI);
    const malformed = { ...frame(C4_MIDI + 0.2, first.endSample + 960), startSample: -1 };
    const next = frame(C4_MIDI + 0.1, first.endSample + 1_920);
    const markup = renderToStaticMarkup(createElement(PitchRibbon, {
      frames: [first, malformed, next],
      targetMidiFloat: C4_MIDI,
      toleranceCents: 20,
    }));

    expect([...markup.matchAll(/data-pitch-trace-segment/gu)]).toHaveLength(2);
  });

  it("retains nonvoiced sample authority so reordered pitch cannot re-enter the trace", () => {
    const first = frame(C4_MIDI);
    const nonvoiced = {
      ...frame(C4_MIDI, first.endSample + 960),
      observationKind: "unvoiced" as const,
      voiced: false,
      frequencyHz: null,
      midiFloat: null,
      nearestMidi: null,
      centsFromNearest: null,
    };
    const stale = { ...first, midiFloat: C4_MIDI + 0.4 };
    const next = frame(C4_MIDI + 0.1, first.endSample + 1_920);
    const markup = renderToStaticMarkup(createElement(PitchRibbon, {
      frames: [first, nonvoiced, stale, next],
      targetMidiFloat: C4_MIDI,
      toleranceCents: 20,
    }));

    expect([...markup.matchAll(/data-pitch-trace-segment/gu)]).toHaveLength(2);
    expect(markup).not.toContain(`data-live-midi="${stale.midiFloat}"`);
    expect(markup).toContain(`data-end-sample="${next.endSample}"`);
  });
});
