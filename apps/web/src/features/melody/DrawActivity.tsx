import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useState } from "react";
import { splitMidiPitch } from "@noteforge/music-core";
import { playPitchContour, playSafely } from "@/audio/synth";
import { noteLabel } from "@/lib/music-display";
import { clamp } from "@/lib/numeric";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import type { MelodyActivityProps } from "./activity-types";
import {
  appendDrawPoint,
  drawPath,
  drawPointsToMidi,
  type DrawPoint,
} from "./model";

function DrawingStroke({ path }: { readonly path: string }) {
  if (path.length === 0) {
    return <text x="300" y="118" textAnchor="middle">press · draw · hear · embody</text>;
  }
  return (
    <>
      <path d={path} className="drawn-glow" />
      <path d={path} className="drawn-line" />
    </>
  );
}

export function DrawActivity({ onMeasureMidi }: MelodyActivityProps) {
  const [points, setPoints] = useState<readonly DrawPoint[]>([]);
  const canvasRef = useRef<SVGSVGElement>(null);
  const midi = useMemo(() => drawPointsToMidi(points), [points]);
  const path = useMemo(() => drawPath(points), [points]);
  const firstMidi = midi[0];
  const range = midi.length === 0 ? undefined : Math.max(...midi) - Math.min(...midi);

  const addPoint = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const point = {
      x: clamp(((event.clientX - rect.left) / rect.width) * 600, 0, 600),
      y: clamp(((event.clientY - rect.top) / rect.height) * 220, 0, 220),
    };
    setPoints((current) => appendDrawPoint(current, point));
  };

  const beginDrawing = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    setPoints([]);
    event.currentTarget.setPointerCapture(event.pointerId);
    addPoint(event);
  };

  const endDrawing = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="draw-workspace">
      <Panel className="draw-stage">
        <div className="panel-heading">
          <div><Eyebrow>Voice is continuous</Eyebrow><h2>Draw a vocal gesture.</h2></div>
          <button className="text-button" onClick={() => setPoints([])}>Clear</button>
        </div>
        <div className="pitch-canvas">
          <div className="draw-labels"><span>high</span><span>center</span><span>low</span></div>
          <svg
            ref={canvasRef}
            viewBox="0 0 600 220"
            preserveAspectRatio="none"
            onPointerDown={beginDrawing}
            onPointerMove={addPoint}
            onPointerUp={endDrawing}
            onPointerCancel={endDrawing}
          >
            <defs>
              <pattern id="draw-grid" width="50" height="36.6" patternUnits="userSpaceOnUse">
                <path d="M50 0H0V36.6" />
              </pattern>
              <linearGradient id="draw-line">
                <stop stopColor="#63d7ff" />
                <stop offset=".5" stopColor="#d8ff3e" />
                <stop offset="1" stopColor="#ff6b45" />
              </linearGradient>
            </defs>
            <rect width="600" height="220" fill="url(#draw-grid)" />
            <line x1="0" x2="600" y1="110" y2="110" />
            <DrawingStroke path={path} />
          </svg>
        </div>
        <div className="draw-actions">
          <ActionButton
            disabled={midi.length < 2}
            onClick={() => playSafely(playPitchContour(midi, 2.8), "Drawn pitch contour")}
          >
            <Icon name="play" size={17} /> Synthesize drawing
          </ActionButton>
          <ActionButton
            className="primary"
            disabled={firstMidi === undefined}
            onClick={() => onMeasureMidi(splitMidiPitch(firstMidi ?? 60).nearestMidi, "glide")}
          >
            <Icon name="mic" size={17} /> Reproduce it
          </ActionButton>
        </div>
      </Panel>
      <Panel className="manifest-note">
        <span className="manifest-symbol">∿</span>
        <Eyebrow>Visual → auditory → motor</Eyebrow>
        <h2>A contour is a plan for motion.</h2>
        <p>The synthesizer keeps this drawing continuous. It is not rounded to piano keys before you hear it.</p>
        <dl>
          <div><dt>Start</dt><dd>{firstMidi === undefined ? "—" : noteLabel(splitMidiPitch(firstMidi).nearestMidi)}</dd></div>
          <div><dt>Range</dt><dd>{range === undefined ? "—" : `${range.toFixed(1)} st`}</dd></div>
          <div><dt>Samples</dt><dd>{midi.length}</dd></div>
        </dl>
      </Panel>
    </div>
  );
}
