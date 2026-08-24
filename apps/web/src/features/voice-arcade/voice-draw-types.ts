import type { PitchObservation } from "../../audio/note-input";
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

export interface VoiceDrawSampleAuthority {
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
  readonly activeCentsFromNearest: number | null;
  readonly activeHeldSeconds: number;
  readonly stopReason: VoiceDrawStopReason;
  readonly observedFrameCount: number;
  readonly movementFrameCount: number;
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
  readonly score: number;
  readonly grade: "S" | "A" | "B" | "C" | "D";
  readonly accuracy: number;
  readonly pathDeviation: number;
  readonly targetCoverage: number;
  readonly drawnLength: number;
  readonly evaluatedPointCount: number;
  readonly targetPointCount: number;
}

export type VoiceDrawSessionAction =
  | Readonly<{ type: "observation"; observation: Readonly<PitchObservation> }>
  | Readonly<{ type: "configure"; changes: Partial<VoiceDrawBrushStyle> }>
  | Readonly<{ type: "toggle-pen" }>
  | Readonly<{ type: "clear" }>
  | Readonly<{ type: "center" }>
  | Readonly<{ type: "undo" }>
  | Readonly<{ type: "clean" }>
  | Readonly<{ type: "finish-trace" }>
  | Readonly<{ type: "reset"; options: Readonly<CreateVoiceDrawStateOptions> }>;
