import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  VOICE_DRAW_MAX_RETAINED_SEGMENTS,
  centerVoiceDrawCursor,
  clearVoiceDraw,
  configureVoiceDrawState,
  createVoiceDrawState,
  finishVoiceDraw,
  startVoiceDraw,
  undoVoiceDrawStroke,
  updateVoiceDrawFromObservation,
} from "../apps/web/src/features/voice-arcade/voice-draw-engine";
import { createVoiceDrawNoteBank } from "../apps/web/src/features/voice-arcade/voice-draw-mapping";
import {
  VOICE_DRAW_TRACE_TARGETS,
  getVoiceDrawTraceTarget,
  scoreVoiceDrawTrace,
} from "../apps/web/src/features/voice-arcade/voice-draw-trace";
import {
  VOICE_DRAW_DIRECTIONS,
  type VoiceDrawSegment,
  type VoiceDrawState,
  type VoiceDrawTraceTarget,
} from "../apps/web/src/features/voice-arcade/voice-draw-types";

const RANGE = Object.freeze({ lowMidi: 48, highMidi: 60, baselineMidi: 54 });
const SAMPLE_RATE = 48_000;

interface ObservationOverrides {
  readonly kind?: PitchObservation["observationKind"];
  readonly nearestMidi?: number | null;
  readonly midiFloat?: number | null;
  readonly voiced?: boolean;
  readonly confidence?: number;
  readonly captureEpoch?: number;
  readonly continuityEpoch?: number;
  readonly graphGeneration?: number;
  readonly discontinuity?: boolean;
}

function observation(
  endSample: number,
  overrides: ObservationOverrides = {},
): PitchObservation {
  const kind = overrides.kind ?? "voiced";
  const nearestMidi = overrides.nearestMidi === undefined ? 51 : overrides.nearestMidi;
  const midiFloat = overrides.midiFloat === undefined ? nearestMidi : overrides.midiFloat;
  const voiced = overrides.voiced ?? kind === "voiced";
  return Object.freeze({
    observationKind: kind,
    timeSeconds: (endSample - 2_048) / SAMPLE_RATE,
    sampleRate: SAMPLE_RATE,
    startSample: Math.max(0, endSample - 4_096),
    endSample,
    processedSampleCount: endSample,
    captureEpoch: overrides.captureEpoch ?? 0,
    continuityEpoch: overrides.continuityEpoch ?? 0,
    graphGeneration: overrides.graphGeneration ?? 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: overrides.discontinuity ?? false,
    frequencyHz: voiced && midiFloat !== null
      ? 440 * 2 ** ((midiFloat - 69) / 12)
      : null,
    midiFloat: voiced ? midiFloat : null,
    nearestMidi: voiced ? nearestMidi : null,
    centsFromNearest: voiced && midiFloat !== null && nearestMidi !== null
      ? (midiFloat - nearestMidi) * 100
      : null,
    rms: voiced ? 0.1 : 0,
    confidence: overrides.confidence ?? (voiced ? 0.97 : 0),
    voiced,
    detector: "yin",
    periodSamples: voiced ? 200 : null,
    yinValue: voiced ? 0.03 : null,
    reason: voiced
      ? "detected"
      : kind === "unvoiced"
        ? "below-rms-threshold"
        : "below-confidence-threshold",
    periodicity: voiced ? 0.97 : 0,
  });
}

function feed(initial: VoiceDrawState, frames: readonly PitchObservation[]): VoiceDrawState {
  return frames.reduce(updateVoiceDrawFromObservation, initial);
}

function engineAtCenter(speed = 1): VoiceDrawState {
  return startVoiceDraw(createVoiceDrawState({
    voiceRange: RANGE,
    speedNormalizedPerSecond: speed,
    maxStepSeconds: 0.2,
  }));
}

function segmentFor(
  from: Readonly<{ x: number; y: number }>,
  to: Readonly<{ x: number; y: number }>,
  index: number,
): VoiceDrawSegment {
  return Object.freeze({
    strokeId: 0,
    from: Object.freeze({ ...from }),
    to: Object.freeze({ ...to }),
    style: Object.freeze({ color: "#fff", width: 0.01, tool: "brush" }),
    direction: "right",
    targetMidi: 53,
    confidence: 1,
    captureEpoch: 0,
    continuityEpoch: 0,
    startSample: index,
    endSample: index + 1,
    durationSeconds: 1 / SAMPLE_RATE,
  });
}

function exactTargetSegments(target: Readonly<VoiceDrawTraceTarget>): VoiceDrawSegment[] {
  const segments = target.points.slice(1).map((point, index) => (
    segmentFor(target.points[index]!, point, index)
  ));
  if (target.closed) {
    segments.push(segmentFor(target.points.at(-1)!, target.points[0]!, segments.length));
  }
  return segments;
}

describe("Voice Draw deterministic engine", () => {
  it("moves only between explicit Start and Finish commands, even after an hour of input", () => {
    const right = createVoiceDrawNoteBank(RANGE).mappings[2]!;
    let state = createVoiceDrawState({
      voiceRange: RANGE,
      speedNormalizedPerSecond: 1,
      maxStepSeconds: 0.2,
    });
    const initialCursor = state.cursor;

    state = updateVoiceDrawFromObservation(
      state,
      observation(4_800, { nearestMidi: right.midi }),
    );
    expect(state.phase).toBe("idle");
    expect(state.cursor).toBe(initialCursor);
    expect(state.observedFrameCount).toBe(1);

    state = startVoiceDraw(state);
    state = feed(state, [
      observation(5_760, { nearestMidi: right.midi }),
      observation(6_720, { nearestMidi: right.midi }),
    ]);
    expect(state.phase).toBe("drawing");
    expect(state.cursor.x).toBeGreaterThan(initialCursor.x);
    const finished = finishVoiceDraw(state);
    const finishedCursor = finished.cursor;
    const finishedSegments = finished.segments;
    const finishedElapsedSeconds = finished.elapsedSeconds;

    state = feed(finished, [
      observation(172_806_720, { nearestMidi: right.midi }),
      observation(172_807_680, { nearestMidi: right.midi }),
    ]);
    expect(state.phase).toBe("complete");
    expect(state.cursor).toBe(finishedCursor);
    expect(state.segments).toBe(finishedSegments);
    expect(state.elapsedSeconds).toBe(finishedElapsedSeconds);
    expect(state.observedFrameCount).toBe(finished.observedFrameCount + 2);

    state = startVoiceDraw(state);
    state = feed(state, [
      observation(172_808_640, { nearestMidi: right.midi }),
      observation(172_809_600, { nearestMidi: right.midi }),
    ]);
    expect(state.phase).toBe("drawing");
    expect(state.cursor.x).toBeGreaterThan(finishedCursor.x);
  });

  it("bounds adversarial alternating direction/style history without ending live drawing", () => {
    const bank = createVoiceDrawNoteBank(RANGE);
    const left = bank.mappings.find(({ direction }) => direction === "left")!;
    const right = bank.mappings.find(({ direction }) => direction === "right")!;
    let state = engineAtCenter(0.25);
    let index = 0;
    state = updateVoiceDrawFromObservation(
      state,
      observation(4_800, { nearestMidi: right.midi }),
    );

    const emittedSegments = VOICE_DRAW_MAX_RETAINED_SEGMENTS + 3_000;
    for (let command = 0; command < emittedSegments; command += 1) {
      state = configureVoiceDrawState(state, {
        style: {
          color: command % 2 === 0 ? "#fff" : "#0ff",
          width: command % 3 === 0 ? 0.01 : 0.011,
          tool: "brush",
        },
      });
      index += 1;
      const mapping = command % 2 === 0 ? right : left;
      state = updateVoiceDrawFromObservation(
        state,
        observation(4_800 + index * 960, { nearestMidi: mapping.midi }),
      );
    }

    expect(state.segments).toHaveLength(VOICE_DRAW_MAX_RETAINED_SEGMENTS);
    expect(state.retiredSegmentCount).toBe(emittedSegments - VOICE_DRAW_MAX_RETAINED_SEGMENTS);
    expect(state.observedFrameCount).toBe(emittedSegments + 1);
    expect(state.movementFrameCount).toBe(emittedSegments);
    expect(state.lastAuthority?.endSample).toBe(4_800 + emittedSegments * 960);
    expect(state.activeDirection).toBe("left");

    const continued = updateVoiceDrawFromObservation(
      state,
      observation(4_800 + (emittedSegments + 1) * 960, { nearestMidi: right.midi }),
    );
    expect(continued.observedFrameCount).toBe(state.observedFrameCount + 1);
    expect(continued.segments.length).toBeLessThanOrEqual(VOICE_DRAW_MAX_RETAINED_SEGMENTS);
  });

  it("maps eight consecutive chromatic notes clockwise through every direction", () => {
    const bank = createVoiceDrawNoteBank(RANGE);
    expect(bank.mappings.map(({ midi }) => midi)).toEqual(
      Array.from({ length: 8 }, (_, index) => bank.baseMidi + index),
    );
    expect(bank.mappings.map(({ direction }) => direction)).toEqual(VOICE_DRAW_DIRECTIONS);

    for (const mapping of bank.mappings) {
      const initial = startVoiceDraw(createVoiceDrawState({
        voiceRange: RANGE,
        cursor: { x: 0.5, y: 0.5 },
        speedNormalizedPerSecond: 1,
      }));
      const moved = feed(initial, [
        observation(4_096, { nearestMidi: mapping.midi }),
        observation(5_056, { nearestMidi: mapping.midi }),
      ]);
      expect(moved.activeDirection).toBe(mapping.direction);
      expect(moved.activeMidi).toBe(mapping.midi);
      expect(moved.cursor.x).toBeCloseTo(0.5 + mapping.dx * 0.02, 12);
      expect(moved.cursor.y).toBeCloseTo(0.5 + mapping.dy * 0.02, 12);
    }
  });

  it("keeps a short measured range truthful while deriving a usable bounded bank", () => {
    const supplied = Object.freeze({ lowMidi: 50, highMidi: 53, baselineMidi: 50 });
    const bank = createVoiceDrawNoteBank(supplied);
    expect(bank.baseMidi).toBeGreaterThanOrEqual(30);
    expect(bank.topMidi).toBeLessThanOrEqual(86);
    expect(bank.mappings).toHaveLength(8);
    expect(bank.profileLowMidi).toBe(50);
    expect(bank.profileHighMidi).toBe(53);
    expect(bank.profileNoteCount).toBe(4);
    expect(bank.outsideProfileNoteCount).toBe(4);
    expect(bank.expandedOutsideProfile).toBe(true);
    expect(bank.mappings.filter(({ inProfileRange }) => inProfileRange).map(({ midi }) => midi))
      .toEqual([50, 51, 52, 53]);
    expect(supplied).toEqual({ lowMidi: 50, highMidi: 53, baselineMidi: 50 });
  });

  it("keeps the measured baseline as the stable Up/home note", () => {
    const bank = createVoiceDrawNoteBank({ lowMidi: 43, highMidi: 55, baselineMidi: 48 });
    expect(bank.baseMidi).toBe(48);
    expect(bank.topMidi).toBe(55);
    expect(bank.mappings.every(({ inProfileRange }) => inProfileRange)).toBe(true);
  });

  it("shifts only at the detector boundaries while keeping all eight notes usable", () => {
    const lowBank = createVoiceDrawNoteBank({ lowMidi: 30, highMidi: 37, baselineMidi: 30 });
    expect(lowBank.baseMidi).toBe(30);
    expect(lowBank.topMidi).toBe(37);
    expect(lowBank.mappings.every(({ inProfileRange }) => inProfileRange)).toBe(true);

    const highBank = createVoiceDrawNoteBank({ lowMidi: 79, highMidi: 86, baselineMidi: 86 });
    expect(highBank.baseMidi).toBe(79);
    expect(highBank.topMidi).toBe(86);
    expect(highBank.mappings.every(({ inProfileRange }) => inProfileRange)).toBe(true);
  });

  it("integrates identical sample time identically at different observation cadences", () => {
    const midi = createVoiceDrawNoteBank(RANGE).mappings[2]!.midi;
    const coarse = feed(engineAtCenter(), [
      observation(4_800, { nearestMidi: midi }),
      observation(9_600, { nearestMidi: midi }),
    ]);
    const fine = feed(engineAtCenter(), [
      observation(4_800, { nearestMidi: midi }),
      ...Array.from({ length: 5 }, (_, index) => (
        observation(5_760 + index * 960, { nearestMidi: midi })
      )),
    ]);

    expect(coarse.cursor.x).toBeCloseTo(0.6, 12);
    expect(fine.cursor.x).toBeCloseTo(coarse.cursor.x, 12);
    expect(fine.cursor.y).toBeCloseTo(coarse.cursor.y, 12);
    expect(fine.activeHeldSeconds).toBeCloseTo(coarse.activeHeldSeconds, 12);
    expect(coarse.segments).toHaveLength(1);
    expect(fine.segments).toHaveLength(1);
    expect(fine.segments[0]?.durationSeconds).toBeCloseTo(0.1, 12);
  });

  it("stops on silence and resumes without moving across the silent sample gap", () => {
    const midi = createVoiceDrawNoteBank(RANGE).mappings[2]!.midi;
    let state = feed(engineAtCenter(), [
      observation(4_800, { nearestMidi: midi }),
      observation(5_760, { nearestMidi: midi }),
    ]);
    expect(state.cursor.x).toBeCloseTo(0.52, 12);
    expect(state.activeHeldSeconds).toBeCloseTo(0.02, 12);

    state = updateVoiceDrawFromObservation(state, observation(6_720, { kind: "unvoiced" }));
    expect(state).toMatchObject({
      activeDirection: null,
      activeMidi: null,
      activeHeldSeconds: 0,
      stationaryReason: "unvoiced",
      motionAnchorSample: null,
    });
    const stoppedX = state.cursor.x;

    state = updateVoiceDrawFromObservation(state, observation(246_720, { nearestMidi: midi }));
    expect(state.cursor.x).toBe(stoppedX);
    expect(state.activeHeldSeconds).toBe(0);
    expect(state.segments).toHaveLength(1);
    state = updateVoiceDrawFromObservation(state, observation(247_680, { nearestMidi: midi }));
    expect(state.cursor.x).toBeCloseTo(stoppedX + 0.02, 12);
  });

  it("stops equally for uncertain and unmapped evidence", () => {
    const bank = createVoiceDrawNoteBank(RANGE);
    let state = updateVoiceDrawFromObservation(
      engineAtCenter(),
      observation(4_800, { nearestMidi: bank.baseMidi }),
    );
    state = updateVoiceDrawFromObservation(state, observation(5_760, { kind: "uncertain" }));
    expect(state).toMatchObject({ activeDirection: null, stationaryReason: "uncertain" });
    state = updateVoiceDrawFromObservation(
      state,
      observation(6_720, { nearestMidi: bank.topMidi + 1 }),
    );
    expect(state).toMatchObject({ activeDirection: null, stationaryReason: "unmapped" });
  });

  it("counts continuous silent observation time without moving or catch-up", () => {
    const right = createVoiceDrawNoteBank(RANGE).mappings[2]!;
    let state = feed(engineAtCenter(), [
      observation(4_800, { nearestMidi: right.midi }),
      observation(5_760, { kind: "unvoiced" }),
      observation(6_720, { kind: "unvoiced" }),
      observation(7_680, { nearestMidi: right.midi }),
    ]);
    expect(state.cursor).toEqual({ x: 0.5, y: 0.5 });
    expect(state.elapsedSeconds).toBeCloseTo(0.06, 12);
    expect(state.activeHeldSeconds).toBe(0);
    state = updateVoiceDrawFromObservation(
      state,
      observation(8_640, { nearestMidi: right.midi }),
    );
    expect(state.cursor.x).toBeCloseTo(0.52, 12);
    expect(state.elapsedSeconds).toBeCloseTo(0.08, 12);
  });

  it("re-establishes authority without movement on discontinuity or epoch changes", () => {
    const midi = createVoiceDrawNoteBank(RANGE).mappings[2]!.midi;
    let state = feed(engineAtCenter(), [
      observation(4_800, { nearestMidi: midi }),
      observation(5_760, { nearestMidi: midi }),
    ]);
    const before = state.cursor;
    state = updateVoiceDrawFromObservation(state, observation(6_720, {
      nearestMidi: midi,
      continuityEpoch: 1,
      discontinuity: true,
    }));
    expect(state.cursor).toEqual(before);
    expect(state.activeHeldSeconds).toBe(0);
    expect(state.segments).toHaveLength(1);

    state = updateVoiceDrawFromObservation(state, observation(4_096, {
      nearestMidi: midi,
      captureEpoch: 1,
      continuityEpoch: 1,
    }));
    expect(state.cursor).toEqual(before);
    expect(state.activeHeldSeconds).toBe(0);
  });

  it("reports current note/direction and resets held time on every note change", () => {
    const [up, upRight] = createVoiceDrawNoteBank(RANGE).mappings;
    let state = feed(engineAtCenter(), [
      observation(4_800, { nearestMidi: up!.midi }),
      observation(5_760, { nearestMidi: up!.midi }),
      observation(6_720, { nearestMidi: up!.midi }),
    ]);
    expect(state).toMatchObject({
      activeMidi: up!.midi,
      activeDirection: "up",
      activeHeldSeconds: expect.closeTo(0.04, 12),
    });

    state = updateVoiceDrawFromObservation(
      state,
      observation(7_680, { nearestMidi: upRight!.midi }),
    );
    expect(state).toMatchObject({
      activeMidi: upRight!.midi,
      activeDirection: "up-right",
      activeHeldSeconds: 0,
    });
    state = updateVoiceDrawFromObservation(
      state,
      observation(8_640, { nearestMidi: upRight!.midi }),
    );
    expect(state.activeHeldSeconds).toBeCloseTo(0.02, 12);
  });

  it("draws no catch-up motion across impossible gaps and clamps to canvas bounds", () => {
    const right = createVoiceDrawNoteBank(RANGE).mappings[2]!;
    let state = startVoiceDraw(createVoiceDrawState({
      voiceRange: RANGE,
      speedNormalizedPerSecond: 1,
      maxStepSeconds: 0.05,
      cursor: { x: 0.99, y: 0.5 },
    }));
    state = feed(state, [
      observation(4_800, { nearestMidi: right.midi }),
      observation(484_800, { nearestMidi: right.midi }),
    ]);
    expect(state.cursor).toEqual({ x: 0.99, y: 0.5 });
    expect(state.segments).toEqual([]);
    const atEdge = updateVoiceDrawFromObservation(
      state,
      observation(485_760, { nearestMidi: right.midi }),
    );
    expect(atEdge.cursor).toEqual({ x: 1, y: 0.5 });
    expect(atEdge.segments).toHaveLength(1);
    expect(atEdge.segments[0]?.durationSeconds).toBeCloseTo(0.02, 12);
  });

  it("coalesces a long collinear hold into one render segment", () => {
    const right = createVoiceDrawNoteBank(RANGE).mappings[2]!;
    const state = feed(startVoiceDraw(createVoiceDrawState({
      voiceRange: RANGE,
      speedNormalizedPerSecond: 0.01,
      maxStepSeconds: 0.1,
    })), [
      observation(4_800, { nearestMidi: right.midi }),
      ...Array.from({ length: 1_000 }, (_, index) => (
        observation(5_760 + index * 960, { nearestMidi: right.midi })
      )),
    ]);
    expect(state.movementFrameCount).toBe(1_000);
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0]?.durationSeconds).toBeCloseTo(20, 10);
    expect(state.elapsedSeconds).toBeCloseTo(20, 10);
  });

  it("moves with the pen up and emits immutable styled segments only with it down", () => {
    const right = createVoiceDrawNoteBank(RANGE).mappings[2]!;
    let state = configureVoiceDrawState(engineAtCenter(), { penDown: false });
    state = feed(state, [
      observation(4_800, { nearestMidi: right.midi }),
      observation(5_760, { nearestMidi: right.midi }),
    ]);
    expect(state.cursor.x).toBeCloseTo(0.52, 12);
    expect(state.segments).toEqual([]);

    state = configureVoiceDrawState(state, {
      penDown: true,
      style: { color: "#ff006e", width: 0.025, tool: "brush" },
    });
    state = updateVoiceDrawFromObservation(
      state,
      observation(6_720, { nearestMidi: right.midi }),
    );
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0]?.style).toEqual({
      color: "#ff006e",
      width: 0.025,
      tool: "brush",
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.segments)).toBe(true);
    expect(Object.isFrozen(state.segments[0])).toBe(true);
    expect(Object.isFrozen(state.segments[0]?.style)).toBe(true);
  });

  it("groups segments into strokes for undo and clears without disturbing stream authority", () => {
    const right = createVoiceDrawNoteBank(RANGE).mappings[2]!;
    let state = feed(engineAtCenter(), [
      observation(4_800, { nearestMidi: right.midi }),
      observation(5_760, { nearestMidi: right.midi }),
      observation(6_720, { nearestMidi: right.midi }),
    ]);
    expect(state.segments).toHaveLength(1);
    expect(new Set(state.segments.map(({ strokeId }) => strokeId)).size).toBe(1);
    state = undoVoiceDrawStroke(state);
    expect(state.segments).toEqual([]);

    state = updateVoiceDrawFromObservation(
      state,
      observation(7_680, { nearestMidi: right.midi }),
    );
    expect(state.segments).toHaveLength(1);
    const authority = state.lastAuthority;
    state = clearVoiceDraw(state, { resetCursor: true });
    expect(state.cursor).toEqual({ x: 0.5, y: 0.5 });
    expect(state.segments).toEqual([]);
    expect(state.lastAuthority).toBe(authority);
    expect(state.motionAnchorSample).toBeNull();
    expect(state.activeDirection).toBeNull();
    state = updateVoiceDrawFromObservation(
      state,
      observation(8_640, { nearestMidi: right.midi }),
    );
    expect(state.cursor).toEqual({ x: 0.5, y: 0.5 });
    expect(state.segments).toEqual([]);
  });

  it("centers the cursor without deleting art or drawing a jump on the next held frame", () => {
    const right = createVoiceDrawNoteBank(RANGE).mappings[2]!;
    let state = feed(engineAtCenter(), [
      observation(4_800, { nearestMidi: right.midi }),
      observation(5_760, { nearestMidi: right.midi }),
    ]);
    const segments = state.segments;
    state = centerVoiceDrawCursor(state);
    expect(state.cursor).toEqual({ x: 0.5, y: 0.5 });
    expect(state.segments).toBe(segments);
    expect(state.motionAnchorSample).toBeNull();
    state = updateVoiceDrawFromObservation(
      state,
      observation(6_720, { nearestMidi: right.midi }),
    );
    expect(state.cursor).toEqual({ x: 0.5, y: 0.5 });
    expect(state.segments).toBe(segments);
  });

  it("scores exact geometry highly and penalizes distant, incomplete marks", () => {
    const square = getVoiceDrawTraceTarget("square");
    const exact = scoreVoiceDrawTrace(exactTargetSegments(square), "square");
    expect(exact).toMatchObject({
      targetId: "square",
      score: 100,
      grade: "S",
      accuracy: 100,
      pathDeviation: 0,
      targetCoverage: 1,
    });

    const distant = scoreVoiceDrawTrace([
      segmentFor({ x: 0.45, y: 0.5 }, { x: 0.55, y: 0.5 }, 0),
    ], "square");
    expect(distant.pathDeviation).toBeGreaterThan(0.25);
    expect(distant.targetCoverage).toBe(0);
    expect(distant.score).toBe(0);
    expect(distant.grade).toBe("D");
  });

  it("provides deterministic finite scoring for every trace target", () => {
    expect(VOICE_DRAW_TRACE_TARGETS.map(({ id }) => id)).toEqual([
      "square",
      "circle",
      "star",
      "spiral",
    ]);
    for (const target of VOICE_DRAW_TRACE_TARGETS) {
      const first = scoreVoiceDrawTrace(exactTargetSegments(target), target.id);
      const second = scoreVoiceDrawTrace(exactTargetSegments(target), target.id);
      expect(second).toEqual(first);
      expect(first.score).toBeGreaterThanOrEqual(99);
      expect(Number.isFinite(first.pathDeviation)).toBe(true);
      expect(first.targetCoverage).toBeGreaterThanOrEqual(0.99);
      expect(first.targetPointCount).toBeGreaterThan(0);
    }
  });

  it("removes brush evidence covered by a later eraser from trace authority", () => {
    const square = getVoiceDrawTraceTarget("square");
    const intactSegments = exactTargetSegments(square);
    const erasedTop = Object.freeze({
      ...segmentFor({ x: 0.18, y: 0.2 }, { x: 0.82, y: 0.2 }, intactSegments.length),
      style: Object.freeze({ color: "#000", width: 0.1, tool: "eraser" as const }),
    });
    const intact = scoreVoiceDrawTrace(intactSegments, "square");
    const erased = scoreVoiceDrawTrace([...intactSegments, erasedTop], "square");
    expect(intact.targetCoverage).toBe(1);
    expect(erased.targetCoverage).toBeLessThan(0.85);
    expect(erased.drawnLength).toBeLessThan(intact.drawnLength);
    expect(erased.score).toBeLessThan(intact.score);
  });
});
