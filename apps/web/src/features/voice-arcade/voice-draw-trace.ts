import type {
  VoiceDrawPoint,
  VoiceDrawSegment,
  VoiceDrawTraceScore,
  VoiceDrawTraceTarget,
  VoiceDrawTraceTargetId,
} from "./voice-draw-types";

const TRACE_SAMPLE_SPACING = 0.0125;
const TRACE_COVERAGE_RADIUS = 0.035;
const TRACE_MAX_DEVIATION = 0.2;

function freezePoint(point: Readonly<VoiceDrawPoint>): VoiceDrawPoint {
  return Object.freeze({ x: point.x, y: point.y });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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
  const samples = pathEdges(points, closed)
    .flatMap(([from, to]) => sampleEdge(from, to, spacing));
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
