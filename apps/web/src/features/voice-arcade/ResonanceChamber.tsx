import { useId, useMemo } from "react";
import { noteLabel } from "@/lib/music-display";
import {
  computeResonanceForce,
} from "./resonance-physics";
import type {
  ResonanceGameState,
  ResonanceVector,
} from "./resonance-types";
import { sampleResonanceField } from "./resonance-field";
import type { ResonanceLevelMetadata } from "./resonance-level";

interface ResonanceChamberProps {
  readonly state: Readonly<ResonanceGameState>;
  readonly metadata: Readonly<ResonanceLevelMetadata>;
  readonly focusResonatorId: string | null;
  readonly showLabels: boolean;
  readonly showRoute: boolean;
  readonly showForceVector: boolean;
}

const FIELD_COLUMNS = 12;
const FIELD_ROWS = 8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function pointLabel(point: Readonly<ResonanceVector>, room: Readonly<{ width: number; height: number }>): string {
  return `${Math.round(point.x / room.width * 100)}% across, ${Math.round(point.y / room.height * 100)}% down`;
}

/**
 * One accessible rendering of the pure fixed-step chamber state. The colored
 * field and expanding shells are derived visualizations of the stylized game
 * model; they are not captured PCM and are not presented as physical SPL.
 */
export function ResonanceChamber({
  state,
  metadata,
  focusResonatorId,
  showLabels,
  showRoute,
  showForceVector,
}: ResonanceChamberProps) {
  const id = useId().replaceAll(":", "");
  const room = state.level.room;
  const scaleX = 1_200 / room.width;
  const scaleY = 800 / room.height;
  const radiusScale = Math.min(scaleX, scaleY);
  const force = computeResonanceForce(state);
  const fieldCells = useMemo(() => Array.from(
      { length: FIELD_COLUMNS * FIELD_ROWS },
      (_, index) => {
        const column = index % FIELD_COLUMNS;
        const row = Math.floor(index / FIELD_COLUMNS);
        const position = {
          x: (column + .5) / FIELD_COLUMNS * room.width,
          y: (row + .5) / FIELD_ROWS * room.height,
        };
        return {
          index,
          column,
          row,
          sample: sampleResonanceField(state, position),
        };
      },
    ), [room.height, room.width, state]);
  const visiblePulses = state.wavePulses.slice(-36);
  const route = metadata.routeWaypoints
    .map((point) => `${point.x * scaleX},${point.y * scaleY}`)
    .join(" ");
  const speed = Math.hypot(state.ball.velocity.x, state.ball.velocity.y);

  return (
    <figure className={`resonance-chamber ${state.voice.active ? "voice-active" : "voice-idle"}`}>
      <svg
        viewBox="0 0 1200 800"
        role="img"
        aria-labelledby={`${id}-title ${id}-description`}
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={`${id}-title`}>Resonance pressure-field puzzle chamber</title>
        <desc id={`${id}-description`}>
          Ball at {pointLabel(state.ball.position, room)} moving at {speed.toFixed(1)} room units per second.
          Goal at {pointLabel(state.level.goal.position, room)}. {state.collisionCount} collisions so far.
          {focusResonatorId ? ` Active target is ${focusResonatorId}.` : " No resonator is currently ahead."}
        </desc>
        <defs>
          <pattern id={`${id}-grid`} width="100" height="100" patternUnits="userSpaceOnUse">
            <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(110,240,255,.07)" strokeWidth="1" />
          </pattern>
          <radialGradient id={`${id}-goal`}>
            <stop offset="0" stopColor="#d8ff3e" stopOpacity=".32" />
            <stop offset=".7" stopColor="#d8ff3e" stopOpacity=".08" />
            <stop offset="1" stopColor="#d8ff3e" stopOpacity="0" />
          </radialGradient>
          <filter id={`${id}-glow`} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="7" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <marker id={`${id}-arrow`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L7,3 z" fill="#fff4d6" />
          </marker>
        </defs>

        <rect width="1200" height="800" rx="22" className="resonance-room-base" />
        <rect width="1200" height="800" rx="22" fill={`url(#${id}-grid)`} />

        <g className="resonance-field-cells" aria-hidden="true">
          {fieldCells.map(({ index, column, row, sample }) => {
            const magnitude = clamp(sample.intensity * .58, 0, .42);
            const fill = sample.pressure >= 0 ? "#60e8ff" : "#ff7856";
            return <rect key={index} x={column * 100} y={row * 100} width="101" height="101" fill={fill} opacity={magnitude} />;
          })}
        </g>

        {showRoute && route && <polyline className="resonance-route" points={route} aria-hidden="true" />}

        <g className="resonance-wave-shells" aria-hidden="true">
          {visiblePulses.map((pulse) => (
            <circle
              key={pulse.id}
              cx={pulse.origin.x * scaleX}
              cy={pulse.origin.y * scaleY}
              r={pulse.radius * radiusScale}
              className={pulse.originKind}
              opacity={clamp(.12 + pulse.amplitude * .62, .08, .75)}
              strokeWidth={clamp(2 + pulse.coherence * 5, 2, 7)}
            />
          ))}
        </g>

        <g className="resonance-obstacles">
          {state.level.obstacles.map((obstacle) => (
            <g key={obstacle.id}>
              <rect
                x={obstacle.x * scaleX}
                y={obstacle.y * scaleY}
                width={obstacle.width * scaleX}
                height={obstacle.height * scaleY}
                rx="4"
              />
              <path
                d={`M ${obstacle.x * scaleX + 7} ${obstacle.y * scaleY + 4} v ${Math.max(0, obstacle.height * scaleY - 8)}`}
              />
            </g>
          ))}
        </g>

        <g className="resonance-goal" transform={`translate(${state.level.goal.position.x * scaleX} ${state.level.goal.position.y * scaleY})`}>
          <circle r={state.level.goal.radius * radiusScale * 1.75} fill={`url(#${id}-goal)`} />
          <circle r={state.level.goal.radius * radiusScale} />
          <circle r={Math.max(5, (state.level.goal.radius - state.ball.radius) * radiusScale)} />
          <text y="5">TARGET</text>
        </g>

        <g className="resonance-source" transform={`translate(${state.level.microphone.position.x * scaleX} ${state.level.microphone.position.y * scaleY})`}>
          <path d="M-18 -19h13a17 17 0 0 1 0 38h-13z" />
          <path d="M8 -25v50M18 -18v36" />
          <text x="-18" y="43">VOICE FIELD</text>
        </g>

        <g className="resonance-resonators">
          {state.level.resonators.map((resonator, index) => {
            const activation = state.resonatorActivations[index];
            const focused = resonator.id === focusResonatorId;
            const energy = activation?.effectiveEnergy ?? 0;
            return (
              <g
                key={resonator.id}
                className={`${focused ? "focus" : ""} ${energy >= .08 ? "active" : "idle"}`.trim()}
                transform={`translate(${resonator.position.x * scaleX} ${resonator.position.y * scaleY})`}
              >
                <circle className="resonator-field" r={36 + energy * 45} opacity={clamp(.15 + energy, .15, .85)} />
                <circle className="resonator-body" r="25" />
                <circle className="resonator-core" r={7 + energy * 8} filter={`url(#${id}-glow)`} />
                {showLabels && <text y="49">{noteLabel(resonator.targetMidi)}</text>}
              </g>
            );
          })}
        </g>

        {showForceVector && state.voice.active && (
          <line
            className="resonance-force-vector"
            x1={state.ball.position.x * scaleX}
            y1={state.ball.position.y * scaleY}
            x2={(state.ball.position.x + force.x * .16) * scaleX}
            y2={(state.ball.position.y + force.y * .16) * scaleY}
            markerEnd={`url(#${id}-arrow)`}
          />
        )}

        <g
          className={`resonance-ball ${state.status}`}
          transform={`translate(${state.ball.position.x * scaleX} ${state.ball.position.y * scaleY})`}
          filter={`url(#${id}-glow)`}
        >
          <circle r={state.ball.radius * radiusScale + 7} className="ball-aura" />
          <circle r={state.ball.radius * radiusScale} className="ball-body" />
          <circle cx={-state.ball.radius * radiusScale * .28} cy={-state.ball.radius * radiusScale * .3} r={state.ball.radius * radiusScale * .22} className="ball-highlight" />
        </g>
      </svg>
      <figcaption>
        <span><i className="source" /> Source wave</span>
        <span><i className="tuned" /> Tuned response</span>
        <span><i className="target" /> Goal field</span>
        <b>STYLIZED LOCAL FIELD · DERIVED SIGNAL ONLY</b>
      </figcaption>
    </figure>
  );
}
