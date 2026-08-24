import { frequencyToMidi } from "@noteforge/music-core";
import { NOTE_INPUT_DEFAULTS, type PitchObservation } from "../../audio/note-input";
import type { ArcadeVoiceRange } from "./types";

export const VOICE_DRAW_DIRECTIONS = Object.freeze([
  "up",
  "up-right",
  "right",
  "down-right",
  "down",
  "down-left",
  "left",
  "up-left",
] as const);

export type VoiceDrawDirection = (typeof VOICE_DRAW_DIRECTIONS)[number];
export type VoiceDrawTool = "brush" | "eraser";
export type VoiceDrawStopReason = "unvoiced" | "uncertain" | "unmapped" | null;
export type VoiceDrawTraceTargetId = "square" | "circle" | "star" | "spiral";

export interface VoiceDrawPoint {
  readonly x: number;
  readonly y: number;
}

export interface VoiceDrawDirectionVector {
  readonly dx: number;
  readonly dy: number;
}

export interface VoiceDrawNoteMapping extends VoiceDrawDirectionVector {
  readonly index: number;
  readonly midi: number;
  readonly direction: VoiceDrawDirection;
  /** Truth about the supplied profile, not a claim that the profile was expanded. */
  readonly inProfileRange: boolean;
}

export interface VoiceDrawNoteBank {
  readonly baseMidi: number;
  readonly topMidi: number;
  readonly profileLowMidi: number;
  readonly profileHighMidi: number;
  readonly profileBaselineMidi: number;
  readonly mappings: readonly VoiceDrawNoteMapping[];
  readonly profileNoteCount: number;
  readonly outsideProfileNoteCount: number;
  readonly expandedOutsideProfile: boolean;
}

export interface VoiceDrawBrushStyle {
  readonly color: string;
  /** Normalized canvas width, from 0.001 through 0.1. */
  readonly width: number;
  readonly tool: VoiceDrawTool;
}

export interface VoiceDrawSegment {
  readonly strokeId: number;
  readonly from: VoiceDrawPoint;
  readonly to: VoiceDrawPoint;
  readonly style: VoiceDrawBrushStyle;
  readonly direction: VoiceDrawDirection;
  readonly targetMidi: number;
  readonly confidence: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly durationSeconds: number;
}

interface VoiceDrawSampleAuthority {
  readonly sampleRate: number;
  readonly endSample: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
}

export interface VoiceDrawState {
  readonly cursor: VoiceDrawPoint;
  readonly segments: readonly VoiceDrawSegment[];
  readonly noteBank: VoiceDrawNoteBank;
  readonly speedNormalizedPerSecond: number;
  readonly maxStepSeconds: number;
  readonly penDown: boolean;
  readonly style: VoiceDrawBrushStyle;
  readonly activeDirection: VoiceDrawDirection | null;
  readonly activeMidi: number | null;
  readonly activeHeldSeconds: number;
  readonly stopReason: VoiceDrawStopReason;
  readonly observedFrameCount: number;
  readonly movementFrameCount: number;
  /** Authoritative same-epoch observation time, excluding discontinuities and impossible gaps. */
  readonly elapsedSeconds: number;
  readonly totalDistance: number;
  readonly nextStrokeId: number;
  readonly activeStrokeId: number | null;
  readonly lastAuthority: VoiceDrawSampleAuthority | null;
  readonly motionAnchorSample: number | null;
}

export interface CreateVoiceDrawStateOptions {
  readonly voiceRange: Readonly<ArcadeVoiceRange>;
  readonly speedNormalizedPerSecond?: number;
  readonly maxStepSeconds?: number;
  readonly cursor?: Readonly<VoiceDrawPoint>;
  readonly style?: Readonly<VoiceDrawBrushStyle>;
  readonly penDown?: boolean;
}

export interface ConfigureVoiceDrawStateOptions {
  readonly penDown?: boolean;
  readonly style?: Readonly<VoiceDrawBrushStyle>;
}

export interface ClearVoiceDrawOptions {
  readonly resetCursor?: boolean;
}

export interface VoiceDrawTraceTarget {
  readonly id: VoiceDrawTraceTargetId;
  readonly label: string;
  readonly points: readonly VoiceDrawPoint[];
  readonly closed: boolean;
}

export interface VoiceDrawTraceScore {
  readonly targetId: VoiceDrawTraceTargetId;
  /** Combined 0–100 result from path accuracy and target coverage. */
  readonly score: number;
  readonly grade: "S" | "A" | "B" | "C" | "D";
  /** 0–100 inverse path-deviation score. */
  readonly accuracy: number;
  /** Mean distance to the target in normalized canvas coordinates. */
  readonly pathDeviation: number;
  /** Fraction from 0–1 of target samples reached by visible brush evidence. */
  readonly targetCoverage: number;
  readonly drawnLength: number;
  readonly evaluatedPointCount: number;
  readonly targetPointCount: number;
}

// Derive from the one detector authority: Arcade profile selectors are
// guidance, never a narrower admission boundary.
const DRAW_MIN_MIDI = Math.ceil(frequencyToMidi(
  NOTE_INPUT_DEFAULTS.minFrequency,
  NOTE_INPUT_DEFAULTS.a4Frequency,
));
const DRAW_MAX_MIDI = Math.floor(frequencyToMidi(
  NOTE_INPUT_DEFAULTS.maxFrequency,
  NOTE_INPUT_DEFAULTS.a4Frequency,
));
const DRAW_NOTE_COUNT = VOICE_DRAW_DIRECTIONS.length;
const DRAW_MAX_BASE_MIDI = DRAW_MAX_MIDI - DRAW_NOTE_COUNT + 1;
const DIAGONAL_COMPONENT = Math.SQRT1_2;
const DEFAULT_SPEED = 0.24;
const DEFAULT_MAX_STEP_SECONDS = 0.1;
const DEFAULT_STYLE = Object.freeze({
  color: "#f5f2df",
  width: 0.012,
  tool: "brush",
}) satisfies VoiceDrawBrushStyle;
const CENTER = Object.freeze({ x: 0.5, y: 0.5 }) satisfies VoiceDrawPoint;
const TRACE_SAMPLE_SPACING = 0.0125;
const TRACE_COVERAGE_RADIUS = 0.035;
const TRACE_MAX_DEVIATION = 0.2;

export const VOICE_DRAW_DIRECTION_VECTORS = Object.freeze({
  up: Object.freeze({ dx: 0, dy: -1 }),
  "up-right": Object.freeze({ dx: DIAGONAL_COMPONENT, dy: -DIAGONAL_COMPONENT }),
  right: Object.freeze({ dx: 1, dy: 0 }),
  "down-right": Object.freeze({ dx: DIAGONAL_COMPONENT, dy: DIAGONAL_COMPONENT }),
  down: Object.freeze({ dx: 0, dy: 1 }),
  "down-left": Object.freeze({ dx: -DIAGONAL_COMPONENT, dy: DIAGONAL_COMPONENT }),
  left: Object.freeze({ dx: -1, dy: 0 }),
  "up-left": Object.freeze({ dx: -DIAGONAL_COMPONENT, dy: -DIAGONAL_COMPONENT }),
}) satisfies Readonly<Record<VoiceDrawDirection, VoiceDrawDirectionVector>>;

function freezePoint(point: Readonly<VoiceDrawPoint>): VoiceDrawPoint {
  return Object.freeze({ x: point.x, y: point.y });
}

function freezeStyle(style: Readonly<VoiceDrawBrushStyle>): VoiceDrawBrushStyle {
  return Object.freeze({ color: style.color, width: style.width, tool: style.tool });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function requireMidi(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 127) {
    throw new RangeError(`${label} must be an integer MIDI note from 0 through 127.`);
  }
}

function validateVoiceRange(range: Readonly<ArcadeVoiceRange>): void {
  requireMidi(range.lowMidi, "Low range edge");
  requireMidi(range.highMidi, "High range edge");
  requireMidi(range.baselineMidi, "Range baseline");
  if (range.lowMidi > range.highMidi) {
    throw new RangeError("Low range edge cannot be above the high range edge.");
  }
  if (range.baselineMidi < range.lowMidi || range.baselineMidi > range.highMidi) {
    throw new RangeError("Range baseline must remain inside the supplied profile.");
  }
}

function validatePoint(point: Readonly<VoiceDrawPoint>, label = "Cursor"): void {
  if (
    !Number.isFinite(point.x)
    || !Number.isFinite(point.y)
    || point.x < 0
    || point.x > 1
    || point.y < 0
    || point.y > 1
  ) {
    throw new RangeError(`${label} coordinates must be finite values from zero through one.`);
  }
}

function validateStyle(style: Readonly<VoiceDrawBrushStyle>): void {
  if (typeof style.color !== "string" || style.color.trim().length === 0) {
    throw new TypeError("Brush color must be a non-empty string.");
  }
  if (!Number.isFinite(style.width) || style.width < 0.001 || style.width > 0.1) {
    throw new RangeError("Brush width must be from 0.001 through 0.1 normalized canvas units.");
  }
  if (style.tool !== "brush" && style.tool !== "eraser") {
    throw new RangeError(`Unknown Voice Draw tool: ${String(style.tool)}`);
  }
}

function finitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and greater than zero.`);
  }
}

/**
 * Anchor Up to the singer's baseline and assign the next seven chromatic notes
 * clockwise. That keeps the direction instrument stable (the default C3 home
 * note always produces Up) instead of silently rotating it when a saved range
 * edge changes. Near supported boundaries the whole bank shifts only far
 * enough to keep all eight notes usable. Notes outside a short measured profile
 * remain explicitly marked rather than mutating or widening that profile.
 */
export function createVoiceDrawNoteBank(
  voiceRange: Readonly<ArcadeVoiceRange>,
): VoiceDrawNoteBank {
  validateVoiceRange(voiceRange);
  const baseMidi = clamp(voiceRange.baselineMidi, DRAW_MIN_MIDI, DRAW_MAX_BASE_MIDI);

  const mappings = VOICE_DRAW_DIRECTIONS.map((direction, index) => {
    const midi = baseMidi + index;
    const vector = VOICE_DRAW_DIRECTION_VECTORS[direction];
    return Object.freeze({
      index,
      midi,
      direction,
      dx: vector.dx,
      dy: vector.dy,
      inProfileRange: midi >= voiceRange.lowMidi && midi <= voiceRange.highMidi,
    });
  });
  const profileNoteCount = mappings.filter(({ inProfileRange }) => inProfileRange).length;
  const outsideProfileNoteCount = DRAW_NOTE_COUNT - profileNoteCount;
  return Object.freeze({
    baseMidi,
    topMidi: baseMidi + DRAW_NOTE_COUNT - 1,
    profileLowMidi: voiceRange.lowMidi,
    profileHighMidi: voiceRange.highMidi,
    profileBaselineMidi: voiceRange.baselineMidi,
    mappings: Object.freeze(mappings),
    profileNoteCount,
    outsideProfileNoteCount,
    expandedOutsideProfile: outsideProfileNoteCount > 0,
  });
}

export function getVoiceDrawMapping(
  noteBank: Readonly<VoiceDrawNoteBank>,
  nearestMidi: number | null,
): VoiceDrawNoteMapping | null {
  if (!Number.isInteger(nearestMidi)) return null;
  return noteBank.mappings.find((mapping) => mapping.midi === nearestMidi) ?? null;
}

function freezeState(state: VoiceDrawState): VoiceDrawState {
  return Object.freeze(state);
}

export function createVoiceDrawState(
  options: Readonly<CreateVoiceDrawStateOptions>,
): VoiceDrawState {
  const speedNormalizedPerSecond = options.speedNormalizedPerSecond ?? DEFAULT_SPEED;
  const maxStepSeconds = options.maxStepSeconds ?? DEFAULT_MAX_STEP_SECONDS;
  const cursor = options.cursor ?? CENTER;
  const style = options.style ?? DEFAULT_STYLE;
  finitePositive(speedNormalizedPerSecond, "Cursor speed");
  finitePositive(maxStepSeconds, "Maximum movement step");
  validatePoint(cursor);
  validateStyle(style);
  return freezeState({
    cursor: freezePoint(cursor),
    segments: Object.freeze([]),
    noteBank: createVoiceDrawNoteBank(options.voiceRange),
    speedNormalizedPerSecond,
    maxStepSeconds,
    penDown: options.penDown ?? true,
    style: freezeStyle(style),
    activeDirection: null,
    activeMidi: null,
    activeHeldSeconds: 0,
    stopReason: null,
    observedFrameCount: 0,
    movementFrameCount: 0,
    elapsedSeconds: 0,
    totalDistance: 0,
    nextStrokeId: 0,
    activeStrokeId: null,
    lastAuthority: null,
    motionAnchorSample: null,
  });
}

function authorityFromObservation(
  observation: Readonly<PitchObservation>,
): VoiceDrawSampleAuthority {
  return Object.freeze({
    sampleRate: observation.sampleRate,
    endSample: observation.endSample,
    captureEpoch: observation.captureEpoch,
    continuityEpoch: observation.continuityEpoch,
    graphGeneration: observation.graphGeneration,
  });
}

function sameAuthority(
  previous: Readonly<VoiceDrawSampleAuthority>,
  observation: Readonly<PitchObservation>,
): boolean {
  return previous.sampleRate === observation.sampleRate
    && previous.captureEpoch === observation.captureEpoch
    && previous.continuityEpoch === observation.continuityEpoch
    && previous.graphGeneration === observation.graphGeneration;
}

function reliableMapping(
  state: Readonly<VoiceDrawState>,
  observation: Readonly<PitchObservation>,
): VoiceDrawNoteMapping | null {
  if (
    observation.observationKind !== "voiced"
    || !observation.voiced
    || !Number.isFinite(observation.midiFloat)
  ) {
    return null;
  }
  return getVoiceDrawMapping(state.noteBank, observation.nearestMidi);
}

function stopReasonFor(observation: Readonly<PitchObservation>): Exclude<VoiceDrawStopReason, null> {
  if (observation.observationKind === "unvoiced") return "unvoiced";
  if (observation.observationKind === "uncertain" || !observation.voiced) return "uncertain";
  return "unmapped";
}

function authorityIsValid(observation: Readonly<PitchObservation>): boolean {
  return Number.isFinite(observation.sampleRate)
    && observation.sampleRate > 0
    && Number.isSafeInteger(observation.endSample)
    && observation.endSample >= 0
    && Number.isSafeInteger(observation.captureEpoch)
    && observation.captureEpoch >= 0
    && Number.isSafeInteger(observation.continuityEpoch)
    && observation.continuityEpoch >= 0
    && Number.isSafeInteger(observation.graphGeneration)
    && observation.graphGeneration >= 0;
}

function establishObservation(
  state: Readonly<VoiceDrawState>,
  observation: Readonly<PitchObservation>,
  mapping: Readonly<VoiceDrawNoteMapping> | null,
  elapsedDeltaSeconds = 0,
): VoiceDrawState {
  return freezeState({
    ...state,
    activeDirection: mapping?.direction ?? null,
    activeMidi: mapping?.midi ?? null,
    activeHeldSeconds: 0,
    stopReason: mapping === null ? stopReasonFor(observation) : null,
    observedFrameCount: state.observedFrameCount + 1,
    elapsedSeconds: state.elapsedSeconds + elapsedDeltaSeconds,
    activeStrokeId: null,
    lastAuthority: authorityFromObservation(observation),
    motionAnchorSample: mapping === null ? null : observation.endSample,
  });
}

/**
 * Integrate one canonical detector observation in capture-sample time. No wall
 * clock or render cadence participates in movement.
 */
export function updateVoiceDrawFromObservation(
  state: Readonly<VoiceDrawState>,
  observation: Readonly<PitchObservation>,
): VoiceDrawState {
  if (!authorityIsValid(observation)) return state;
  const mapping = reliableMapping(state, observation);
  const previous = state.lastAuthority;

  if (
    previous === null
    || observation.discontinuity
    || !sameAuthority(previous, observation)
  ) {
    return establishObservation(state, observation, mapping);
  }

  // The canonical stream is monotonic. A duplicate or reordered frame has no
  // authority to change cursor state or fabricate elapsed time.
  if (observation.endSample <= previous.endSample) return state;

  const rawDeltaSeconds = (observation.endSample - previous.endSample)
    / observation.sampleRate;
  // Missing analysis evidence has no authority to move the cursor. Establish a
  // fresh anchor at the new observation instead of drawing a capped catch-up.
  if (rawDeltaSeconds > state.maxStepSeconds) {
    return establishObservation(state, observation, mapping);
  }

  if (mapping === null) {
    return freezeState({
      ...state,
      activeDirection: null,
      activeMidi: null,
      activeHeldSeconds: 0,
      stopReason: stopReasonFor(observation),
      observedFrameCount: state.observedFrameCount + 1,
      elapsedSeconds: state.elapsedSeconds + rawDeltaSeconds,
      activeStrokeId: null,
      lastAuthority: authorityFromObservation(observation),
      motionAnchorSample: null,
    });
  }

  // The first credible frame after silence/uncertainty/unmapped evidence only
  // re-establishes a movement anchor. It can never catch up across the gap.
  if (state.motionAnchorSample === null) {
    return establishObservation(state, observation, mapping, rawDeltaSeconds);
  }

  const anchoredDeltaSeconds = (observation.endSample - state.motionAnchorSample)
    / observation.sampleRate;
  const deltaSeconds = Math.max(0, anchoredDeltaSeconds);
  const stepDistance = state.speedNormalizedPerSecond * deltaSeconds;
  const cursor = freezePoint({
    x: clamp(state.cursor.x + mapping.dx * stepDistance, 0, 1),
    y: clamp(state.cursor.y + mapping.dy * stepDistance, 0, 1),
  });
  const moved = cursor.x !== state.cursor.x || cursor.y !== state.cursor.y;
  let segments = state.segments;
  let nextStrokeId = state.nextStrokeId;
  let activeStrokeId = state.activeStrokeId;

  if (moved && state.penDown) {
    if (activeStrokeId === null) {
      activeStrokeId = nextStrokeId;
      nextStrokeId += 1;
    }
    const segment = Object.freeze({
      strokeId: activeStrokeId,
      from: state.cursor,
      to: cursor,
      style: state.style,
      direction: mapping.direction,
      targetMidi: mapping.midi,
      confidence: observation.confidence,
      captureEpoch: observation.captureEpoch,
      continuityEpoch: observation.continuityEpoch,
      startSample: previous.endSample,
      endSample: observation.endSample,
      durationSeconds: deltaSeconds,
    }) satisfies VoiceDrawSegment;
    const priorSegment = state.segments.at(-1);
    const canCoalesce = priorSegment !== undefined
      && priorSegment.strokeId === activeStrokeId
      && priorSegment.direction === mapping.direction
      && priorSegment.targetMidi === mapping.midi
      && priorSegment.style === state.style
      && priorSegment.captureEpoch === observation.captureEpoch
      && priorSegment.continuityEpoch === observation.continuityEpoch
      && priorSegment.endSample === previous.endSample
      && priorSegment.to.x === state.cursor.x
      && priorSegment.to.y === state.cursor.y;
    if (canCoalesce) {
      const extended = Object.freeze({
        ...priorSegment,
        to: cursor,
        confidence: observation.confidence,
        endSample: observation.endSample,
        durationSeconds: priorSegment.durationSeconds + deltaSeconds,
      }) satisfies VoiceDrawSegment;
      segments = Object.freeze([...state.segments.slice(0, -1), extended]);
    } else {
      segments = Object.freeze([...state.segments, segment]);
    }
  } else if (!state.penDown) {
    activeStrokeId = null;
  }

  const sameNote = state.activeMidi === mapping.midi;
  return freezeState({
    ...state,
    cursor,
    segments,
    activeDirection: mapping.direction,
    activeMidi: mapping.midi,
    activeHeldSeconds: sameNote ? state.activeHeldSeconds + deltaSeconds : 0,
    stopReason: null,
    observedFrameCount: state.observedFrameCount + 1,
    movementFrameCount: state.movementFrameCount + (moved ? 1 : 0),
    elapsedSeconds: state.elapsedSeconds + rawDeltaSeconds,
    totalDistance: state.totalDistance + distance(state.cursor, cursor),
    nextStrokeId,
    activeStrokeId,
    lastAuthority: authorityFromObservation(observation),
    motionAnchorSample: observation.endSample,
  });
}

export function configureVoiceDrawState(
  state: Readonly<VoiceDrawState>,
  options: Readonly<ConfigureVoiceDrawStateOptions>,
): VoiceDrawState {
  const penDown = options.penDown ?? state.penDown;
  const style = options.style ?? state.style;
  validateStyle(style);
  const frozenStyle = style === state.style ? state.style : freezeStyle(style);
  if (penDown === state.penDown && frozenStyle === state.style) return state;
  return freezeState({
    ...state,
    penDown,
    style: frozenStyle,
    activeStrokeId: null,
  });
}

export function clearVoiceDraw(
  state: Readonly<VoiceDrawState>,
  options: Readonly<ClearVoiceDrawOptions> = {},
): VoiceDrawState {
  return freezeState({
    ...state,
    cursor: options.resetCursor ? CENTER : state.cursor,
    segments: Object.freeze([]),
    activeStrokeId: null,
    elapsedSeconds: 0,
    totalDistance: 0,
  });
}

/** Center the voice cursor without deleting art or connecting a catch-up line. */
export function centerVoiceDrawCursor(state: Readonly<VoiceDrawState>): VoiceDrawState {
  return freezeState({
    ...state,
    cursor: CENTER,
    activeDirection: null,
    activeMidi: null,
    activeHeldSeconds: 0,
    stopReason: null,
    activeStrokeId: null,
    motionAnchorSample: null,
  });
}

export function undoVoiceDrawStroke(state: Readonly<VoiceDrawState>): VoiceDrawState {
  const last = state.segments.at(-1);
  if (last === undefined) return state;
  const segments = Object.freeze(
    state.segments.filter((segment) => segment.strokeId !== last.strokeId),
  );
  return freezeState({ ...state, segments, activeStrokeId: null });
}

function circlePoints(): VoiceDrawPoint[] {
  return Array.from({ length: 64 }, (_, index) => {
    const angle = -Math.PI / 2 + (index / 64) * Math.PI * 2;
    return freezePoint({
      x: 0.5 + Math.cos(angle) * 0.3,
      y: 0.5 + Math.sin(angle) * 0.3,
    });
  });
}

function starPoints(): VoiceDrawPoint[] {
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + (index / 10) * Math.PI * 2;
    const radius = index % 2 === 0 ? 0.32 : 0.14;
    return freezePoint({
      x: 0.5 + Math.cos(angle) * radius,
      y: 0.5 + Math.sin(angle) * radius,
    });
  });
}

function spiralPoints(): VoiceDrawPoint[] {
  return Array.from({ length: 97 }, (_, index) => {
    const progress = index / 96;
    const angle = -Math.PI / 2 + progress * Math.PI * 5;
    const radius = 0.02 + progress * 0.33;
    return freezePoint({
      x: 0.5 + Math.cos(angle) * radius,
      y: 0.5 + Math.sin(angle) * radius,
    });
  });
}

const TRACE_TARGETS = Object.freeze({
  square: Object.freeze({
    id: "square",
    label: "Square",
    points: Object.freeze([
      freezePoint({ x: 0.2, y: 0.2 }),
      freezePoint({ x: 0.8, y: 0.2 }),
      freezePoint({ x: 0.8, y: 0.8 }),
      freezePoint({ x: 0.2, y: 0.8 }),
    ]),
    closed: true,
  }),
  circle: Object.freeze({
    id: "circle",
    label: "Circle",
    points: Object.freeze(circlePoints()),
    closed: true,
  }),
  star: Object.freeze({
    id: "star",
    label: "Star",
    points: Object.freeze(starPoints()),
    closed: true,
  }),
  spiral: Object.freeze({
    id: "spiral",
    label: "Spiral",
    points: Object.freeze(spiralPoints()),
    closed: false,
  }),
}) satisfies Readonly<Record<VoiceDrawTraceTargetId, VoiceDrawTraceTarget>>;

export const VOICE_DRAW_TRACE_TARGETS = Object.freeze(
  (["square", "circle", "star", "spiral"] as const).map((id) => TRACE_TARGETS[id]),
);

export function getVoiceDrawTraceTarget(
  targetId: VoiceDrawTraceTargetId,
): VoiceDrawTraceTarget {
  const target = TRACE_TARGETS[targetId];
  if (target === undefined) {
    throw new RangeError(`Unknown Voice Draw trace target: ${String(targetId)}`);
  }
  return target;
}

function distance(first: Readonly<VoiceDrawPoint>, second: Readonly<VoiceDrawPoint>): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function pathEdges(
  points: readonly VoiceDrawPoint[],
  closed: boolean,
): readonly (readonly [VoiceDrawPoint, VoiceDrawPoint])[] {
  const edges: [VoiceDrawPoint, VoiceDrawPoint][] = [];
  for (let index = 1; index < points.length; index += 1) {
    edges.push([points[index - 1]!, points[index]!]);
  }
  if (closed && points.length > 1) edges.push([points.at(-1)!, points[0]!]);
  return edges;
}

function sampleEdge(
  from: Readonly<VoiceDrawPoint>,
  to: Readonly<VoiceDrawPoint>,
  spacing: number,
): VoiceDrawPoint[] {
  const length = distance(from, to);
  const steps = Math.max(1, Math.ceil(length / spacing));
  return Array.from({ length: steps }, (_, index) => {
    const progress = index / steps;
    return {
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
    };
  });
}

function samplePath(
  points: readonly VoiceDrawPoint[],
  closed: boolean,
  spacing: number,
): VoiceDrawPoint[] {
  const edges = pathEdges(points, closed);
  const samples = edges.flatMap(([from, to]) => sampleEdge(from, to, spacing));
  if (!closed && points.length > 0) samples.push(points.at(-1)!);
  return samples;
}

function pointToSegmentDistance(
  point: Readonly<VoiceDrawPoint>,
  from: Readonly<VoiceDrawPoint>,
  to: Readonly<VoiceDrawPoint>,
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const squaredLength = dx * dx + dy * dy;
  if (squaredLength === 0) return distance(point, from);
  const projection = clamp(
    ((point.x - from.x) * dx + (point.y - from.y) * dy) / squaredLength,
    0,
    1,
  );
  return Math.hypot(
    point.x - (from.x + dx * projection),
    point.y - (from.y + dy * projection),
  );
}

function nearestEdgeDistance(
  point: Readonly<VoiceDrawPoint>,
  edges: readonly (readonly [VoiceDrawPoint, VoiceDrawPoint])[],
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const [from, to] of edges) {
    nearest = Math.min(nearest, pointToSegmentDistance(point, from, to));
  }
  return nearest;
}

function rounded(value: number, places = 6): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function scoreGrade(score: number): VoiceDrawTraceScore["grade"] {
  if (score >= 92) return "S";
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 45) return "C";
  return "D";
}

/** Score final brush evidence against a target; eraser passes are not evidence. */
export function scoreVoiceDrawTrace(
  segments: readonly VoiceDrawSegment[],
  targetId: VoiceDrawTraceTargetId,
): VoiceDrawTraceScore {
  const target = getVoiceDrawTraceTarget(targetId);
  const targetEdges = pathEdges(target.points, target.closed);
  const brushEvidence = segments.flatMap((segment, segmentIndex) => {
    if (segment.style.tool !== "brush") return [];
    const points = sampleEdge(segment.from, segment.to, TRACE_SAMPLE_SPACING);
    const edgeLength = distance(segment.from, segment.to);
    const sampleWeight = points.length === 0 ? 0 : edgeLength / points.length;
    return points.map((point) => ({
      point,
      segmentIndex,
      brushWidth: segment.style.width,
      sampleWeight,
    }));
  });
  const visibleEvidence = brushEvidence.filter((evidence) => (
    !segments.some((segment, segmentIndex) => (
      segmentIndex > evidence.segmentIndex
      && segment.style.tool === "eraser"
      && pointToSegmentDistance(evidence.point, segment.from, segment.to)
        <= (evidence.brushWidth + segment.style.width) / 2
    ))
  ));
  const drawnPoints = visibleEvidence.map(({ point }) => point);
  const targetPoints = samplePath(target.points, target.closed, TRACE_SAMPLE_SPACING);
  const drawnLength = visibleEvidence.reduce(
    (sum, evidence) => sum + evidence.sampleWeight,
    0,
  );
  const deviationTotal = drawnPoints.reduce(
    (sum, point) => sum + nearestEdgeDistance(point, targetEdges),
    0,
  );
  const pathDeviation = drawnPoints.length === 0
    ? TRACE_MAX_DEVIATION
    : deviationTotal / drawnPoints.length;
  const reachedTargetPoints = visibleEvidence.length === 0
    ? 0
    : targetPoints.filter((point) => (
      visibleEvidence.some((evidence) => (
        distance(point, evidence.point)
          <= TRACE_COVERAGE_RADIUS + evidence.brushWidth / 2
      ))
    )).length;
  const targetCoverage = targetPoints.length === 0 ? 0 : reachedTargetPoints / targetPoints.length;
  const accuracy = clamp(1 - pathDeviation / TRACE_MAX_DEVIATION, 0, 1) * 100;
  const score = clamp(accuracy * 0.55 + targetCoverage * 100 * 0.45, 0, 100);
  const roundedScore = rounded(score, 2);
  return Object.freeze({
    targetId,
    score: roundedScore,
    grade: scoreGrade(roundedScore),
    accuracy: rounded(accuracy, 2),
    pathDeviation: rounded(pathDeviation),
    targetCoverage: rounded(targetCoverage),
    drawnLength: rounded(drawnLength),
    evaluatedPointCount: drawnPoints.length,
    targetPointCount: targetPoints.length,
  });
}
