import type { VocalControlVector } from "./types";
import { clampSignedUnit, clampUnit } from "@/lib/numeric";

export interface VocalControlGeometry {
  readonly pitchLowerCents: number;
  readonly pitchUpperCents: number;
  readonly brightnessDarkerDelta: number;
  readonly brightnessBrighterDelta: number;
  readonly pitchDeadZoneCents: number;
  readonly brightnessDeadZone: number;
  readonly brightnessAvailable?: boolean;
}

interface VocalControlReticleProps {
  readonly vector: Readonly<VocalControlVector>;
  readonly calibration: Readonly<VocalControlGeometry> | null;
  readonly expanded?: boolean;
  readonly showValues?: boolean;
}

interface ReticleGeometry {
  readonly left: number;
  readonly right: number;
  readonly up: number;
  readonly down: number;
  readonly deadLeft: number;
  readonly deadRight: number;
  readonly deadUp: number;
  readonly deadDown: number;
}

const DEFAULT_GEOMETRY: ReticleGeometry = Object.freeze({
  left: 76,
  right: 76,
  up: 76,
  down: 76,
  deadLeft: 11,
  deadRight: 11,
  deadUp: 11,
  deadDown: 11,
});

function scaledExtent(value: number, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(maximum) || maximum <= 0) return 0;
  return 78 * clampUnit(value / maximum);
}

function geometryFor(
  calibration: Readonly<VocalControlGeometry> | null,
): ReticleGeometry {
  if (calibration === null) return DEFAULT_GEOMETRY;
  const maximumPitch = Math.max(calibration.pitchLowerCents, calibration.pitchUpperCents);
  const maximumBrightness = Math.max(
    calibration.brightnessDarkerDelta,
    calibration.brightnessBrighterDelta,
  );
  return {
    left: scaledExtent(calibration.brightnessDarkerDelta, maximumBrightness),
    right: scaledExtent(calibration.brightnessBrighterDelta, maximumBrightness),
    up: scaledExtent(calibration.pitchUpperCents, maximumPitch),
    down: scaledExtent(calibration.pitchLowerCents, maximumPitch),
    deadLeft: scaledExtent(calibration.brightnessDeadZone, maximumBrightness),
    deadRight: scaledExtent(calibration.brightnessDeadZone, maximumBrightness),
    deadUp: scaledExtent(calibration.pitchDeadZoneCents, maximumPitch),
    deadDown: scaledExtent(calibration.pitchDeadZoneCents, maximumPitch),
  };
}

function boundaryPath(geometry: Readonly<ReticleGeometry>): string {
  return [
    `M 100 ${100 - geometry.up}`,
    `Q ${100 + geometry.right} ${100 - geometry.up} ${100 + geometry.right} 100`,
    `Q ${100 + geometry.right} ${100 + geometry.down} 100 ${100 + geometry.down}`,
    `Q ${100 - geometry.left} ${100 + geometry.down} ${100 - geometry.left} 100`,
    `Q ${100 - geometry.left} ${100 - geometry.up} 100 ${100 - geometry.up}`,
    "Z",
  ].join(" ");
}

function pointCoordinate(axis: number, negativeExtent: number, positiveExtent: number): number {
  const boundedAxis = Number.isFinite(axis) ? clampSignedUnit(axis) : 0;
  return 100 + boundedAxis * (boundedAxis < 0 ? negativeExtent : positiveExtent);
}

function brightnessAvailability(calibration: Readonly<VocalControlGeometry> | null): string {
  if (calibration?.brightnessAvailable === undefined) return "unknown";
  return calibration.brightnessAvailable ? "true" : "false";
}

export function VocalControlReticle({
  vector,
  calibration,
  expanded = false,
  showValues = true,
}: VocalControlReticleProps) {
  const geometry = geometryFor(calibration);
  const pointX = pointCoordinate(vector.brightnessAxis, geometry.left, geometry.right);
  const pointY = pointCoordinate(-vector.pitchAxis, geometry.up, geometry.down);
  const deadZonePath = boundaryPath({
    left: geometry.deadLeft,
    right: geometry.deadRight,
    up: geometry.deadUp,
    down: geometry.deadDown,
    deadLeft: 0,
    deadRight: 0,
    deadUp: 0,
    deadDown: 0,
  });
  const className = `vocal-control-reticle ${expanded ? "is-expanded" : "is-compact"}`;
  return (
    <figure
      className={className}
      data-active={vector.active ? "true" : "false"}
      data-brightness-available={brightnessAvailability(calibration)}
      data-pitch-axis={vector.pitchAxis.toFixed(4)}
      data-brightness-axis={vector.brightnessAxis.toFixed(4)}
      aria-label={`Vocal control: pitch ${vector.pitchAxis.toFixed(2)}, brightness ${vector.brightnessAxis.toFixed(2)}`}
    >
      <svg viewBox="0 0 200 200" role="img" aria-hidden="true">
        <path className="vocal-control-boundary" d={boundaryPath(geometry)} />
        <path className="vocal-control-dead-zone" d={deadZonePath} />
        <line x1="14" y1="100" x2="186" y2="100" />
        <line x1="100" y1="14" x2="100" y2="186" />
        <circle className="vocal-control-neutral" cx="100" cy="100" r="3" />
        {vector.active && (
          <circle
            className="vocal-control-current"
            cx={pointX}
            cy={pointY}
            r={expanded ? 7 : 6}
          />
        )}
      </svg>
      <span className="vocal-control-label label-up">higher</span>
      <span className="vocal-control-label label-down">lower</span>
      <span className="vocal-control-label label-left">darker</span>
      <span className="vocal-control-label label-right">brighter</span>
      {showValues && (
        <figcaption>
          <span><b>{vector.pitchAxis >= 0 ? "+" : ""}{vector.pitchAxis.toFixed(2)}</b> pitch</span>
          <span><b>{vector.brightnessAxis >= 0 ? "+" : ""}{vector.brightnessAxis.toFixed(2)}</b> brightness</span>
        </figcaption>
      )}
    </figure>
  );
}
