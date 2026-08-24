export interface RangeAttemptGradeInput {
  medianErrorCents?: number;
  stabilityCents?: number;
  timeToAcquireMs: number;
  resetCount: number;
  toleranceCents: number;
  requiredHoldMs: number;
}

export interface RangeAttemptGrade {
  score: number;
  letter: "A+" | "A" | "B" | "C" | "D";
  label: string;
  centerScore: number;
  stabilityScore: number;
  acquisitionScore: number;
  continuityScore: number;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function requireNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and nonnegative.`);
}

/**
 * Grade one earned hold without pretending it is a voice-quality judgment.
 * Center and stability dominate; acquisition time and broken runs only refine
 * the score after the singer has already completed the required hold.
 */
export function gradeRangeAttempt(input: Readonly<RangeAttemptGradeInput>): RangeAttemptGrade {
  requireNonnegative(input.timeToAcquireMs, "Acquisition time");
  requireNonnegative(input.resetCount, "Reset count");
  if (!Number.isInteger(input.resetCount)) throw new RangeError("Reset count must be an integer.");
  requireNonnegative(input.requiredHoldMs, "Required hold duration");
  if (input.requiredHoldMs === 0) throw new RangeError("Required hold duration must be greater than zero.");
  if (!Number.isFinite(input.toleranceCents) || input.toleranceCents <= 0) {
    throw new RangeError("Tolerance must be finite and greater than zero.");
  }
  if (input.medianErrorCents !== undefined && !Number.isFinite(input.medianErrorCents)) {
    throw new RangeError("Pitch center must be finite when provided.");
  }
  requireNonnegative(input.stabilityCents ?? 0, "Stability");

  const centerScore = input.medianErrorCents === undefined
    ? 0
    : 100 * clamp(1 - Math.abs(input.medianErrorCents) / (input.toleranceCents * 1.35));
  const stabilityScore = input.stabilityCents === undefined
    ? 0
    : 100 * clamp(1 - input.stabilityCents / (input.toleranceCents * 1.35));
  const acquisitionWindowMs = Math.max(4_000, input.requiredHoldMs * 2);
  const acquisitionScore = 100 * clamp(1 - input.timeToAcquireMs / acquisitionWindowMs);
  const continuityScore = 100 / (1 + input.resetCount * 0.45);
  const score = Math.round(
    centerScore * 0.42
    + stabilityScore * 0.33
    + acquisitionScore * 0.10
    + continuityScore * 0.15,
  );

  if (score >= 93) return { score, letter: "A+", label: "Centered and steady", centerScore, stabilityScore, acquisitionScore, continuityScore };
  if (score >= 85) return { score, letter: "A", label: "Strong pitch control", centerScore, stabilityScore, acquisitionScore, continuityScore };
  if (score >= 75) return { score, letter: "B", label: "Solid hold", centerScore, stabilityScore, acquisitionScore, continuityScore };
  if (score >= 65) return { score, letter: "C", label: "Held with movement", centerScore, stabilityScore, acquisitionScore, continuityScore };
  return { score, letter: "D", label: "Earned · keep shaping", centerScore, stabilityScore, acquisitionScore, continuityScore };
}
