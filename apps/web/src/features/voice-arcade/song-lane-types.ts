import type { PitchFrame } from "@noteforge/pitch-engine";

export type SongLaneDifficulty = "easy" | "medium" | "hard" | "expert";

export interface VocalMidiRange {
  minMidi: number;
  maxMidi: number;
}

export interface SongLaneAnalysisOptions {
  analysisSampleRate?: number;
  frameSizeSamples?: number;
  hopSizeSamples?: number;
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  minimumConfidence?: number;
  rmsThreshold?: number;
  a4Frequency?: number;
  smoothingRadius?: number;
  quantizationHysteresisCents?: number;
  minimumLaneSeconds?: number;
  mergeGapSeconds?: number;
  vocalRange?: VocalMidiRange;
  difficulty?: SongLaneDifficulty;
  toleranceCents?: number;
}

export interface SongAnalysisChunk {
  index: number;
  total: number;
  startSample: number;
  endSample: number;
  centerSample: number;
  timeSeconds: number;
  progress: number;
}

export interface SongPitchFrame extends PitchFrame {
  frameIndex: number;
  startSeconds: number;
  endSeconds: number;
  quantizedMidi: number | null;
}

export interface SongTargetLane {
  id: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  sourceMidi: number;
  targetMidi: number;
  lowerMidi: number;
  upperMidi: number;
  toleranceCents: number;
  averageConfidence: number;
  voicedFrameCount: number;
  voicedSeconds: number;
  wasClippedToRange: boolean;
}

export interface SongLaneAnalysis {
  durationSeconds: number;
  sourceSampleRate: number;
  analysisSampleRate: number;
  frames: SongPitchFrame[];
  lanes: SongTargetLane[];
  difficulty: SongLaneDifficulty;
  toleranceCents: number;
  vocalRange: VocalMidiRange | null;
  transposeSemitones: number;
  clippedLaneCount: number;
  sourceMidiRange: VocalMidiRange | null;
  targetMidiRange: VocalMidiRange | null;
  voicedFrameCount: number;
  voicedCoverage: number;
}

export interface ResolvedSongLaneOptions {
  analysisSampleRate: number;
  frameSizeSamples: number;
  hopSizeSamples: number;
  minFrequencyHz: number;
  maxFrequencyHz: number;
  minimumConfidence: number;
  rmsThreshold: number;
  a4Frequency: number;
  smoothingRadius: number;
  quantizationHysteresisCents: number;
  minimumLaneSeconds: number;
  mergeGapSeconds: number;
  vocalRange: VocalMidiRange | null;
  difficulty: SongLaneDifficulty;
  toleranceCents: number;
}
