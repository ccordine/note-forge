/** Exact derived telemetry consumed by Vocal Flight. Raw PCM never crosses this boundary. */
export interface VocalTelemetrySample {
  readonly observationKind: "voiced" | "unvoiced" | "uncertain";
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
  readonly discontinuity: boolean;
  readonly frequencyHz: number | null;
  readonly midiFloat: number | null;
  readonly confidence: number;
  /** Shared pitch-relative harmonic spectral-shape coordinate, bounded to 0..1. */
  readonly brightness: number | null;
  readonly brightnessConfidence: number;
  /** Diagnostic only. Loudness never controls or admits flight input. */
  readonly rms: number;
}

export interface VocalControlVector {
  readonly pitchAxis: number;
  readonly brightnessAxis: number;
  readonly pitchConfidence: number;
  readonly brightnessConfidence: number;
  readonly voiced: boolean;
  readonly active: boolean;
}

export interface VocalControlCalibration {
  readonly centerFrequencyHz: number;
  readonly centerMidi: number;
  readonly centerBrightness: number;
  readonly centerRms: number;
  /** Positive magnitudes measured away from center. */
  readonly pitchLowerCents: number;
  readonly pitchUpperCents: number;
  readonly brightnessDarkerDelta: number;
  readonly brightnessBrighterDelta: number;
  readonly neutralPitchDeviationCents: number;
  readonly neutralBrightnessDeviation: number;
  readonly pitchDeadZoneCents: number;
  readonly brightnessDeadZone: number;
  readonly brightnessTaskPitchDriftCents: number | null;
  /** False preserves a valid pitch-only calibration without inventing a roll axis. */
  readonly brightnessAvailable: boolean;
  readonly brightnessIndependent: boolean;
  readonly completedRecoveryCount: number;
}

export interface SampleAuthority {
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly captureEpoch: number;
  readonly continuityEpoch: number;
  readonly graphGeneration: number;
}

export interface Vector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type VocalFlightControlMode = "neutral" | "pitch" | "brightness" | "combined";
export type VocalFlightChapterId =
  | "neutral"
  | "pitch"
  | "brightness"
  | "combined"
  | "precision"
  | "automaticity";

export interface VocalFlightGate {
  readonly id: string;
  readonly center: Vector3;
  readonly radius: number;
  /** Gates sharing a group are alternate routes at one course plane. */
  readonly choiceGroup?: string;
  /** Deterministic sample-time motion around the authored center. */
  readonly motion?: Readonly<{
    xAmplitude: number;
    yAmplitude: number;
    cyclesPerSecond: number;
    phaseRadians: number;
  }>;
}

export interface VocalFlightDisturbance {
  readonly startZ: number;
  readonly endZ: number;
  readonly pitchTorque: number;
  readonly rollTorque: number;
}

export interface VocalFlightCourseDefinition {
  readonly id: string;
  readonly chapter: VocalFlightChapterId;
  readonly order: number;
  readonly title: string;
  readonly objective: string;
  readonly discovery: "discovery" | "control" | "application";
  readonly controlMode: VocalFlightControlMode;
  readonly selfLevelStrength: number;
  readonly gates: readonly VocalFlightGate[];
  readonly disturbances: readonly VocalFlightDisturbance[];
  readonly requiredNeutralRecoveries: number;
  readonly requiredNeutralHoldSeconds?: number;
  readonly visual?: "rings" | "tunnel";
  /** Optional sample-time target for explicitly timed courses. */
  readonly parSeconds?: number;
}

export interface VocalFlightCourseState {
  readonly definition: VocalFlightCourseDefinition;
  readonly status: "flying" | "complete";
  readonly nextGateIndex: number;
  /** Dynamic center of the branch actually crossed at its exact course time. */
  readonly lastPassedCenter: Vector3 | null;
  readonly gatesPassed: number;
  readonly gatesMissed: number;
  readonly centerRecoveries: number;
  readonly neutralWasReleased: boolean;
  readonly neutralHoldSeconds: number;
  readonly neutralSteadySeconds: number;
  readonly pathErrorIntegral: number;
  readonly sampleSeconds: number;
}

export interface VocalFlightConfig {
  readonly fixedStepSeconds: number;
  readonly maximumAdvanceSeconds: number;
  readonly forwardSpeed: number;
  readonly pitchTorque: number;
  readonly rollTorque: number;
  readonly pitchRateDamping: number;
  readonly rollRateDamping: number;
  readonly pitchSelfLevel: number;
  readonly rollSelfLevel: number;
  readonly coordinatedTurnRate: number;
  readonly maximumPitchRadians: number;
  readonly maximumRollRadians: number;
}

export interface VocalFlightState {
  readonly config: VocalFlightConfig;
  readonly position: Vector3;
  readonly pitchRadians: number;
  readonly rollRadians: number;
  readonly headingRadians: number;
  readonly pitchRate: number;
  readonly rollRate: number;
  readonly yawRate: number;
  readonly elapsedSeconds: number;
  readonly distanceTraveled: number;
  readonly accumulatorSeconds: number;
  readonly fixedStepCount: number;
}

export interface VocalFlightInput {
  readonly control: VocalControlVector;
  readonly controlMode?: VocalFlightControlMode;
  readonly selfLevelStrength?: number;
  readonly disturbancePitchTorque?: number;
  readonly disturbanceRollTorque?: number;
}

export interface VocalFlightScoreResult {
  readonly score: number;
  readonly grade: "S" | "A" | "B" | "C" | "D";
  readonly courseAccuracyPercent: number;
  readonly smoothnessPercent: number;
  readonly overshootCount: number;
  readonly centerRecoveryPercent: number | null;
  readonly averageCenterRecoverySeconds: number | null;
  readonly axisIndependencePercent: number | null;
  readonly pitchTaskBrightnessLeak: number | null;
  readonly brightnessTaskPitchDriftCents: number | null;
  readonly controlEfficiencyPercent: number;
  readonly timeEfficiencyPercent: number | null;
  readonly scoredSeconds: number;
}
