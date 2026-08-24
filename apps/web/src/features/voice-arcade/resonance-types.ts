export interface ResonanceVector {
  readonly x: number;
  readonly y: number;
}

export interface ResonanceRoom {
  readonly width: number;
  readonly height: number;
}

export interface ResonanceObstacle {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly acousticTransmission?: number;
}

export interface ResonanceBallDefinition {
  readonly position: ResonanceVector;
  readonly velocity?: ResonanceVector;
  readonly radius: number;
  readonly mass?: number;
  readonly restitution?: number;
  readonly linearDamping?: number;
}

export interface ResonanceGoal {
  readonly position: ResonanceVector;
  readonly radius: number;
}

export interface ResonanceMicrophoneSource {
  readonly position: ResonanceVector;
  readonly gain: number;
  readonly falloffRadius: number;
  readonly direction?: ResonanceVector;
  readonly directivity?: number;
}

export type ResonanceForceMode = "repel" | "attract" | "directional";

export interface FrequencyTunedResonator {
  readonly id: string;
  readonly position: ResonanceVector;
  readonly targetMidi: number;
  readonly bandwidthCents: number;
  readonly gain: number;
  readonly influenceRadius: number;
  readonly mode: ResonanceForceMode;
  readonly direction?: ResonanceVector;
}

export interface ResonanceLevelDefinition {
  readonly id: string;
  readonly room: ResonanceRoom;
  readonly obstacles: readonly ResonanceObstacle[];
  readonly ball: ResonanceBallDefinition;
  readonly goal: ResonanceGoal;
  readonly microphone: ResonanceMicrophoneSource;
  readonly resonators: readonly FrequencyTunedResonator[];
}

export interface ResonancePhysicsOptions {
  readonly fixedStepSeconds?: number;
  readonly maximumFrameDeltaSeconds?: number;
  readonly maximumSpeed?: number;
  readonly maximumForce?: number;
  readonly waveSpeed?: number;
  readonly waveIntervalSeconds?: number;
  readonly waveShellWidth?: number;
  readonly maximumWavePulses?: number;
}

export interface ResolvedResonancePhysicsOptions {
  readonly fixedStepSeconds: number;
  readonly maximumFrameDeltaSeconds: number;
  readonly maximumSpeed: number;
  readonly maximumForce: number;
  readonly waveSpeed: number;
  readonly waveIntervalSeconds: number;
  readonly waveShellWidth: number;
  readonly maximumWavePulses: number;
}

export interface ResonanceVoiceInput {
  readonly voiced: boolean;
  readonly midiFloat: number | null;
  readonly frequencyHz: number | null;
  readonly normalizedLevel: number;
  readonly coherentDrive: number;
  readonly confidence: number;
  readonly stability: number;
}

export interface ResonanceVoiceEvaluation {
  readonly active: boolean;
  readonly midiFloat: number | null;
  readonly frequencyHz: number | null;
  readonly normalizedLevel: number;
  readonly coherentDrive: number;
  readonly effectiveIntensity: number;
  readonly confidence: number;
  readonly stability: number;
  readonly evidenceCoherence: number;
  readonly directEnergy: number;
}

export interface ResonatorActivation {
  readonly resonatorId: string;
  readonly targetMidi: number;
  readonly centsError: number | null;
  readonly pitchAccuracy: number;
  readonly coherence: number;
  readonly effectiveEnergy: number;
}

export type ResonanceWaveOriginKind = "microphone" | "resonator";

export interface ResonanceWavePulse {
  readonly id: number;
  readonly originKind: ResonanceWaveOriginKind;
  readonly originId: string;
  readonly origin: ResonanceVector;
  readonly radius: number;
  readonly ageSeconds: number;
  readonly amplitude: number;
  readonly pitchMidi: number | null;
  readonly targetMidi: number | null;
  readonly coherence: number;
}

export interface ResonanceBallState {
  readonly position: ResonanceVector;
  readonly velocity: ResonanceVector;
  readonly radius: number;
  readonly mass: number;
  readonly restitution: number;
  readonly linearDamping: number;
}

export type ResonanceGameStatus = "playing" | "won";

export interface ResonanceGameState {
  readonly level: ResonanceLevelDefinition;
  readonly options: ResolvedResonancePhysicsOptions;
  readonly status: ResonanceGameStatus;
  readonly ball: ResonanceBallState;
  readonly voice: ResonanceVoiceEvaluation;
  readonly resonatorActivations: readonly ResonatorActivation[];
  readonly wavePulses: readonly ResonanceWavePulse[];
  readonly elapsedSeconds: number;
  readonly accumulatorSeconds: number;
  readonly droppedSeconds: number;
  readonly fixedStepCount: number;
  readonly collisionCount: number;
  readonly nextWaveId: number;
  readonly waveClockSeconds: number;
}

export interface ResonanceAdvanceResult {
  readonly state: ResonanceGameState;
  readonly simulatedSteps: number;
  readonly collisions: number;
  readonly wonThisAdvance: boolean;
}

export interface ResonanceFieldSample {
  readonly pressure: number;
  readonly intensity: number;
  readonly gradient: ResonanceVector;
  readonly contributingPulses: number;
}
