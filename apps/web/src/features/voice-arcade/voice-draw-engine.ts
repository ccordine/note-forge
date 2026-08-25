import type { PitchObservation } from "../../audio/note-input";
import { clampUnit } from "@/lib/numeric";
import { isAuthoritativeVoicedPitch } from "@/realtime/authoritative-voiced-pitch";
import {
  observationContinuity,
  type ObservationSampleAuthority,
} from "@/realtime/observation-continuity";
import { createVoiceDrawNoteBank, getVoiceDrawMapping } from "./voice-draw-mapping";
import type {
  ClearVoiceDrawOptions,
  ConfigureVoiceDrawStateOptions,
  CreateVoiceDrawStateOptions,
  VoiceDrawBrushStyle,
  VoiceDrawNoteMapping,
  VoiceDrawPoint,
  VoiceDrawSegment,
  VoiceDrawSessionAction,
  VoiceDrawState,
  VoiceDrawStationaryReason,
} from "./voice-draw-types";

const DEFAULT_SPEED = 0.24;
const DEFAULT_MAX_STEP_SECONDS = 0.1;
const DEFAULT_STYLE = Object.freeze({
  color: "#f5f2df",
  width: 0.012,
  tool: "brush",
}) satisfies VoiceDrawBrushStyle;
const CENTER = Object.freeze({ x: 0.5, y: 0.5 }) satisfies VoiceDrawPoint;

function freezePoint(point: Readonly<VoiceDrawPoint>): VoiceDrawPoint {
  return Object.freeze({ x: point.x, y: point.y });
}

function freezeStyle(style: Readonly<VoiceDrawBrushStyle>): VoiceDrawBrushStyle {
  return Object.freeze({ color: style.color, width: style.width, tool: style.tool });
}

function freezeState(state: VoiceDrawState): VoiceDrawState {
  return Object.freeze(state);
}

function pointDistance(first: Readonly<VoiceDrawPoint>, second: Readonly<VoiceDrawPoint>): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
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
    phase: "idle",
    cursor: freezePoint(cursor),
    segments: Object.freeze([]),
    noteBank: createVoiceDrawNoteBank(options.voiceRange),
    speedNormalizedPerSecond,
    maxStepSeconds,
    penDown: options.penDown ?? true,
    style: freezeStyle(style),
    activeDirection: null,
    activeMidi: null,
    activeCentsFromNearest: null,
    activeHeldSeconds: 0,
    stationaryReason: null,
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

function observeStationary(
  state: Readonly<VoiceDrawState>,
  observation: Readonly<PitchObservation>,
): VoiceDrawState {
  const continuity = observationContinuity(state.lastAuthority, observation);
  if (!continuity.accepted || continuity.authority === null) return state as VoiceDrawState;
  const mapping = reliableMapping(state, observation);
  const continuous = continuity.contiguous
    && continuity.deltaSeconds <= state.maxStepSeconds;
  const heldSeconds = mapping !== null
    && continuous
    && state.activeMidi === mapping.midi
      ? state.activeHeldSeconds
        + continuity.deltaSeconds
      : 0;
  return freezeState({
    ...state,
    activeDirection: mapping?.direction ?? null,
    activeMidi: mapping?.midi ?? null,
    activeCentsFromNearest: mapping !== null
      && observation.centsFromNearest !== null
      && Number.isFinite(observation.centsFromNearest)
      ? observation.centsFromNearest
      : null,
    activeHeldSeconds: heldSeconds,
    stationaryReason: mapping === null ? stationaryReasonFor(observation) : null,
    observedFrameCount: state.observedFrameCount + 1,
    activeStrokeId: null,
    lastAuthority: continuity.authority,
    motionAnchorSample: null,
  });
}

function reliableMapping(
  state: Readonly<VoiceDrawState>,
  observation: Readonly<PitchObservation>,
): VoiceDrawNoteMapping | null {
  if (!isAuthoritativeVoicedPitch(observation)) return null;
  return getVoiceDrawMapping(state.noteBank, observation.nearestMidi);
}

function stationaryReasonFor(
  observation: Readonly<PitchObservation>,
): Exclude<VoiceDrawStationaryReason, null> {
  if (observation.observationKind === "unvoiced") return "unvoiced";
  if (observation.observationKind === "uncertain" || !observation.voiced) return "uncertain";
  return "unmapped";
}

function establishObservation(
  state: Readonly<VoiceDrawState>,
  observation: Readonly<PitchObservation>,
  mapping: Readonly<VoiceDrawNoteMapping> | null,
  authority: Readonly<ObservationSampleAuthority>,
  elapsedDeltaSeconds = 0,
): VoiceDrawState {
  return freezeState({
    ...state,
    activeDirection: mapping?.direction ?? null,
    activeMidi: mapping?.midi ?? null,
    activeCentsFromNearest: mapping !== null
      && observation.centsFromNearest !== null
      && Number.isFinite(observation.centsFromNearest)
      ? observation.centsFromNearest
      : null,
    activeHeldSeconds: 0,
    stationaryReason: mapping === null ? stationaryReasonFor(observation) : null,
    observedFrameCount: state.observedFrameCount + 1,
    elapsedSeconds: state.elapsedSeconds + elapsedDeltaSeconds,
    activeStrokeId: null,
    lastAuthority: authority,
    motionAnchorSample: mapping === null ? null : observation.endSample,
  });
}

/** Integrate one canonical detector observation in capture-sample time. */
export function updateVoiceDrawFromObservation(
  state: Readonly<VoiceDrawState>,
  observation: Readonly<PitchObservation>,
): VoiceDrawState {
  if (state.phase !== "drawing") return observeStationary(state, observation);
  const continuity = observationContinuity(state.lastAuthority, observation);
  if (!continuity.accepted || continuity.authority === null) return state;
  const mapping = reliableMapping(state, observation);
  const authority = continuity.authority;
  if (continuity.boundary) return establishObservation(state, observation, mapping, authority);
  const previousAuthority = state.lastAuthority!;

  const rawDeltaSeconds = continuity.deltaSeconds;
  if (rawDeltaSeconds > state.maxStepSeconds) {
    return establishObservation(state, observation, mapping, authority);
  }
  if (mapping === null) {
    return freezeState({
      ...state,
      activeDirection: null,
      activeMidi: null,
      activeCentsFromNearest: null,
      activeHeldSeconds: 0,
      stationaryReason: stationaryReasonFor(observation),
      observedFrameCount: state.observedFrameCount + 1,
      elapsedSeconds: state.elapsedSeconds + rawDeltaSeconds,
      activeStrokeId: null,
      lastAuthority: authority,
      motionAnchorSample: null,
    });
  }
  if (state.motionAnchorSample === null) {
    return establishObservation(state, observation, mapping, authority, rawDeltaSeconds);
  }

  const anchoredDeltaSeconds = (observation.endSample - state.motionAnchorSample)
    / observation.sampleRate;
  const deltaSeconds = Math.max(0, anchoredDeltaSeconds);
  const stepDistance = state.speedNormalizedPerSecond * deltaSeconds;
  const cursor = freezePoint({
    x: clampUnit(state.cursor.x + mapping.dx * stepDistance),
    y: clampUnit(state.cursor.y + mapping.dy * stepDistance),
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
      startSample: previousAuthority.endSample,
      endSample: observation.endSample,
      durationSeconds: deltaSeconds,
    }) satisfies VoiceDrawSegment;
    const priorSegment = state.segments.at(-1);
    const canCoalesce = priorSegment !== undefined
      && priorSegment.strokeId === activeStrokeId
      && priorSegment.direction === mapping.direction
      && priorSegment.targetMidi === mapping.midi
      && priorSegment.style === state.style
      && priorSegment.endSample === previousAuthority.endSample
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
      // Every stroke is user-created artwork and trace-scoring authority.
      // Retain it until explicit Clear/Undo; a presentation budget may not
      // erase the beginning of a long drawing or score only its tail.
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
    activeCentsFromNearest: observation.centsFromNearest !== null
      && Number.isFinite(observation.centsFromNearest)
      ? observation.centsFromNearest
      : null,
    activeHeldSeconds: sameNote ? state.activeHeldSeconds + deltaSeconds : 0,
    stationaryReason: null,
    observedFrameCount: state.observedFrameCount + 1,
    movementFrameCount: state.movementFrameCount + (moved ? 1 : 0),
    elapsedSeconds: state.elapsedSeconds + rawDeltaSeconds,
    totalDistance: state.totalDistance + pointDistance(state.cursor, cursor),
    nextStrokeId,
    activeStrokeId,
    lastAuthority: authority,
    motionAnchorSample: observation.endSample,
  });
}

/** Start or resume only from a direct user command. */
export function startVoiceDraw(state: Readonly<VoiceDrawState>): VoiceDrawState {
  if (state.phase === "drawing") return state as VoiceDrawState;
  return freezeState({
    ...state,
    phase: "drawing",
    activeHeldSeconds: 0,
    activeStrokeId: null,
    motionAnchorSample: null,
  });
}

/** Finish only from a direct user command; observations remain live telemetry. */
export function finishVoiceDraw(state: Readonly<VoiceDrawState>): VoiceDrawState {
  if (state.phase !== "drawing") return state as VoiceDrawState;
  return freezeState({
    ...state,
    phase: "complete",
    activeHeldSeconds: 0,
    activeStrokeId: null,
    motionAnchorSample: null,
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
  return freezeState({ ...state, penDown, style: frozenStyle, activeStrokeId: null });
}

export function clearVoiceDraw(
  state: Readonly<VoiceDrawState>,
  options: Readonly<ClearVoiceDrawOptions> = {},
): VoiceDrawState {
  const resetCursor = options.resetCursor ?? false;
  return freezeState({
    ...state,
    cursor: resetCursor ? CENTER : state.cursor,
    segments: Object.freeze([]),
    activeStrokeId: null,
    activeDirection: resetCursor ? null : state.activeDirection,
    activeMidi: resetCursor ? null : state.activeMidi,
    activeCentsFromNearest: resetCursor ? null : state.activeCentsFromNearest,
    activeHeldSeconds: resetCursor ? 0 : state.activeHeldSeconds,
    stationaryReason: resetCursor ? null : state.stationaryReason,
    motionAnchorSample: resetCursor ? null : state.motionAnchorSample,
    elapsedSeconds: 0,
    totalDistance: 0,
  });
}

export function centerVoiceDrawCursor(state: Readonly<VoiceDrawState>): VoiceDrawState {
  return freezeState({
    ...state,
    cursor: CENTER,
    activeDirection: null,
    activeMidi: null,
    activeCentsFromNearest: null,
    activeHeldSeconds: 0,
    stationaryReason: null,
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

function styleWithChanges(
  state: Readonly<VoiceDrawState>,
  changes: Partial<VoiceDrawBrushStyle>,
): VoiceDrawBrushStyle {
  return {
    color: changes.color ?? state.style.color,
    width: changes.width ?? state.style.width,
    tool: changes.tool ?? state.style.tool,
  };
}

export function reduceVoiceDrawSession(
  state: Readonly<VoiceDrawState>,
  action: Readonly<VoiceDrawSessionAction>,
): VoiceDrawState {
  switch (action.type) {
    case "observation":
      return updateVoiceDrawFromObservation(state, action.observation);
    case "start":
      return startVoiceDraw(state);
    case "configure":
      return configureVoiceDrawState(state, { style: styleWithChanges(state, action.changes) });
    case "toggle-pen":
      return configureVoiceDrawState(state, { penDown: !state.penDown });
    case "clear":
      return clearVoiceDraw(state);
    case "center":
      return centerVoiceDrawCursor(state);
    case "undo":
      return undoVoiceDrawStroke(state);
    case "clean":
      return centerVoiceDrawCursor(clearVoiceDraw(state));
    case "finish":
      return finishVoiceDraw(state);
  }
}
