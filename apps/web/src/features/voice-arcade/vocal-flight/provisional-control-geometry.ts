import type { VocalCalibrationState } from "./calibration";
import type { VocalControlGeometry } from "./VocalControlReticle";

interface OnlineMoment {
  readonly count: number;
  readonly mean: number;
  readonly sumSquaredDeviation: number;
}

function measuredOr(moment: Readonly<OnlineMoment>, fallback: number): number {
  return moment.count > 0 && Number.isFinite(moment.mean) && moment.mean > 0
    ? moment.mean
    : fallback;
}

function deviation(moment: Readonly<OnlineMoment>): number {
  return moment.count < 2 ? 0 : Math.sqrt(
    moment.sumSquaredDeviation / (moment.count - 1),
  );
}

/** Live, online-only geometry so calibration visibly discovers its asymmetric surface. */
export function provisionalVocalControlGeometry(
  state: Readonly<VocalCalibrationState>,
): VocalControlGeometry {
  const measures = state.measurements;
  const measuredUpper = measuredOr(measures.upperPitchCents, 0);
  const measuredLower = measuredOr(measures.lowerPitchCents, 0);
  const pitchFallback = Math.max(180, measuredUpper, measuredLower);
  const measuredBrighter = measuredOr(measures.brighterBrightnessDelta, 0);
  const measuredDarker = measuredOr(measures.darkerBrightnessDelta, 0);
  const brightnessFallback = Math.max(0.08, measuredBrighter, measuredDarker);
  return Object.freeze({
    pitchLowerCents: measuredLower || pitchFallback,
    pitchUpperCents: measuredUpper || pitchFallback,
    brightnessDarkerDelta: measuredDarker || brightnessFallback,
    brightnessBrighterDelta: measuredBrighter || brightnessFallback,
    pitchDeadZoneCents: Math.max(12, deviation(measures.neutralPitch) * 200),
    brightnessDeadZone: Math.max(0.008, deviation(measures.neutralBrightness) * 2),
    brightnessAvailable: state.brightnessCapability === "available"
      ? true
      : state.brightnessCapability === "limited" ? false : undefined,
  });
}
