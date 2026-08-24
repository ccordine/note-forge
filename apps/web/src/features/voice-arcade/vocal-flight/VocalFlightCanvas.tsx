import { useEffect, useRef } from "react";
import {
  renderVocalFlight,
  type VocalFlightRenderScene,
} from "./vocal-flight-renderer";

interface VocalFlightCanvasProps {
  readonly getScene: () => Readonly<VocalFlightRenderScene>;
}

/** rAF owns presentation only; authoritative simulation advances on audio sample time. */
export function VocalFlightCanvas({ getScene }: VocalFlightCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneReaderRef = useRef(getScene);
  sceneReaderRef.current = getScene;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) return undefined;
    let animationHandle = 0;
    let renderCount = 0;
    const render = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * ratio));
      const height = Math.max(1, Math.round(bounds.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      renderVocalFlight(context, sceneReaderRef.current(), bounds.width, bounds.height);
      renderCount += 1;
      canvas.dataset.renderFrames = String(renderCount);
      animationHandle = window.requestAnimationFrame(render);
    };
    animationHandle = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(animationHandle);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="vocal-flight-canvas"
      data-vocal-flight-canvas
      data-testid="vocal-flight-canvas"
      aria-label="Forward flight view with horizon, course gates, and aircraft attitude reference"
    />
  );
}
