import type { ResonanceGameState } from "./resonance-physics";

export interface ResonanceRunStats {
  pathDistance: number;
  lastBallX: number;
  lastBallY: number;
  activeSeconds: number;
  coherentSeconds: number;
  currentCoherentHoldSeconds: number;
  bestCoherentHoldSeconds: number;
  /** Integrated comfortable-level field request before evidence weighting. */
  effectiveIntensityIntegral: number;
  /** Integrated canonical force-producing drive. */
  coherentDriveIntegral: number;
  /** Integrated canonical drive coupled into the currently relevant resonator. */
  tunedEnergyIntegral: number;
  peakNormalizedLevel: number;
  peakRelativeDb: number | null;
  observedFrames: number;
  reliableFrames: number;
  /** Distinct contacts, rather than 120 Hz collision-solver resolutions. */
  collisionEpisodes: number;
  collisionCooldownSeconds: number;
}

export interface ResonanceResult {
  grade: string;
  score: number;
  durationSeconds: number;
  pathEfficiencyPercent: number;
  coherentEfficiencyPercent: number;
  tunedEfficiencyPercent: number;
  collisionControlPercent: number;
  speedPercent: number;
  collisionCount: number;
  reliableFrames: number;
  bestCoherentHoldSeconds: number;
  peakNormalizedLevel: number;
  peakRelativeDb: number | null;
  resonators: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function distance(
  first: Readonly<{ x: number; y: number }>,
  second: Readonly<{ x: number; y: number }>,
): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function averageGrade(score: number): string {
  if (score >= 94) return "S";
  if (score >= 86) return "A";
  if (score >= 76) return "B";
  if (score >= 64) return "C";
  return "D";
}

/**
 * Generated chambers author an ordered route through their gate resonators.
 * Using that route avoids penalizing a perfect run for not taking a straight
 * line through solid walls.
 */
export function authoredResonanceRouteDistance(
  game: Readonly<ResonanceGameState>,
): number {
  const points = [
    game.level.ball.position,
    ...game.level.resonators.map((resonator) => resonator.position),
    game.level.goal.position,
  ];
  return Math.max(.01, points.slice(1).reduce(
    (total, point, index) => total + distance(points[index]!, point),
    0,
  ));
}

export function createResonanceRunStats(
  game: Readonly<ResonanceGameState>,
): ResonanceRunStats {
  return {
    pathDistance: 0,
    lastBallX: game.ball.position.x,
    lastBallY: game.ball.position.y,
    activeSeconds: 0,
    coherentSeconds: 0,
    currentCoherentHoldSeconds: 0,
    bestCoherentHoldSeconds: 0,
    effectiveIntensityIntegral: 0,
    coherentDriveIntegral: 0,
    tunedEnergyIntegral: 0,
    peakNormalizedLevel: 0,
    peakRelativeDb: null,
    observedFrames: 0,
    reliableFrames: 0,
    collisionEpisodes: 0,
    collisionCooldownSeconds: 0,
  };
}

/** Only the currently actionable, force-producing resonator earns tuned credit. */
export function resonanceTunedEnergyForTarget(
  game: Readonly<ResonanceGameState>,
  targetId: string | null,
): number {
  const activation = targetId === null
    ? null
    : game.resonatorActivations.find((candidate) => candidate.resonatorId === targetId);
  return Math.min(game.voice.directEnergy, activation?.effectiveEnergy ?? 0);
}

/** Collapse repeated fixed-step resolutions into distinct contact episodes. */
export function recordResonanceCollisionAdvance(
  stats: ResonanceRunStats,
  previousContactCount: number,
  nextContactCount: number,
  deltaSeconds: number,
): void {
  const collidedThisAdvance = nextContactCount > previousContactCount;
  if (collidedThisAdvance && stats.collisionCooldownSeconds <= 0) {
    stats.collisionEpisodes += 1;
  }
  stats.collisionCooldownSeconds = collidedThisAdvance
    ? .18
    : Math.max(0, stats.collisionCooldownSeconds - Math.max(0, deltaSeconds));
}

/** Grade only like-for-like physical quantities, each bounded by its denominator. */
export function summarizeResonanceRun(
  game: Readonly<ResonanceGameState>,
  stats: Readonly<ResonanceRunStats>,
): ResonanceResult {
  const routeDistance = authoredResonanceRouteDistance(game);
  const pathEfficiencyPercent = clamp(
    routeDistance / Math.max(routeDistance, stats.pathDistance) * 100,
    0,
    100,
  );
  const coherentEfficiencyPercent = stats.effectiveIntensityIntegral <= 0
    ? 0
    : clamp(stats.coherentDriveIntegral / stats.effectiveIntensityIntegral * 100, 0, 100);
  const tunedEfficiencyPercent = stats.coherentDriveIntegral <= 0
    ? 0
    : clamp(stats.tunedEnergyIntegral / stats.coherentDriveIntegral * 100, 0, 100);
  const collisionControlPercent = clamp(
    100 - stats.collisionEpisodes * 7,
    0,
    100,
  );
  const expectedSeconds = 22 + game.level.resonators.length * 18;
  const speedPercent = clamp(
    expectedSeconds / Math.max(expectedSeconds, game.elapsedSeconds) * 100,
    0,
    100,
  );
  const score = Math.round(clamp(
    pathEfficiencyPercent * .25
      + coherentEfficiencyPercent * .28
      + tunedEfficiencyPercent * .24
      + collisionControlPercent * .13
      + speedPercent * .1,
    0,
    100,
  ));
  return {
    grade: averageGrade(score),
    score,
    durationSeconds: game.elapsedSeconds,
    pathEfficiencyPercent,
    coherentEfficiencyPercent,
    tunedEfficiencyPercent,
    collisionControlPercent,
    speedPercent,
    collisionCount: stats.collisionEpisodes,
    reliableFrames: stats.reliableFrames,
    bestCoherentHoldSeconds: stats.bestCoherentHoldSeconds,
    peakNormalizedLevel: stats.peakNormalizedLevel,
    peakRelativeDb: stats.peakRelativeDb,
    resonators: game.level.resonators.length,
  };
}
