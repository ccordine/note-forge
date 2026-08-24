import { noteLabel } from "@/lib/music-display";
import { contourSvgPoints } from "./model";

export function ContourGlyph({
  notes,
  hidden = false,
}: {
  readonly notes: readonly number[];
  readonly hidden?: boolean;
}) {
  const points = contourSvgPoints(notes);
  const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <svg className="contour-glyph" viewBox="0 0 600 180" preserveAspectRatio="none">
      <line x1="0" x2="600" y1="150" y2="150" />
      <polyline points={polyline} />
      {points.map((point, index) => (
        <g key={index}>
          <circle cx={point.x} cy={point.y} r="7" />
          <text x={point.x} y={point.y - 17} textAnchor="middle">
            {hidden ? "•" : noteLabel(notes[index] ?? 60)}
          </text>
        </g>
      ))}
    </svg>
  );
}
