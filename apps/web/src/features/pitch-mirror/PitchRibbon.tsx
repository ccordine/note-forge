import type { PitchFrame } from "@noteforge/pitch-engine";
import { signed } from "@/lib/music-display";

interface PitchRibbonProps {
  frames: readonly PitchFrame[];
  targetMidiFloat: number;
  toleranceCents: number;
  durationSeconds?: number;
  envelope?: readonly number[];
}

function pathSegments(frames: readonly PitchFrame[], targetMidiFloat: number, startTime: number, span: number): string[] {
  const paths: string[] = [];
  let active = "";
  let previousTime: number | null = null;
  for (const frame of frames) {
    if (!frame.voiced || frame.midiFloat === null || frame.timeSeconds < startTime) {
      if (active) paths.push(active);
      active = "";
      previousTime = null;
      continue;
    }
    if (previousTime !== null && frame.timeSeconds - previousTime > 0.16) {
      if (active) paths.push(active);
      active = "";
    }
    const x = ((frame.timeSeconds - startTime) / span) * 1000;
    const cents = (frame.midiFloat - targetMidiFloat) * 100;
    const y = 150 - Math.max(-100, Math.min(100, cents)) * 1.18;
    active += `${active ? " L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    previousTime = frame.timeSeconds;
  }
  if (active) paths.push(active);
  return paths;
}

export function PitchRibbon({ frames, targetMidiFloat, toleranceCents, durationSeconds = 8, envelope }: PitchRibbonProps) {
  const endTime = frames.at(-1)?.timeSeconds ?? durationSeconds;
  const startTime = Math.max(0, endTime - durationSeconds);
  const paths = pathSegments(frames, targetMidiFloat, startTime, durationSeconds);
  const bandHalfHeight = toleranceCents * 1.18;
  return (
    <div className="pitch-ribbon-wrap">
      <div className="ribbon-y-labels"><span>+100</span><span>+50</span><b>0</b><span>−50</span><span>−100</span></div>
      <svg className="pitch-ribbon" viewBox="0 0 1000 300" preserveAspectRatio="none" role="img" aria-label="Your pitch contour relative to target, over time">
        <defs>
          <linearGradient id="target-band" x1="0" x2="1"><stop stopColor="#d8ff3e" stopOpacity=".05" /><stop offset=".5" stopColor="#d8ff3e" stopOpacity=".2" /><stop offset="1" stopColor="#d8ff3e" stopOpacity=".05" /></linearGradient>
          <linearGradient id="trace-gradient"><stop stopColor="#ff6b45" /><stop offset=".48" stopColor="#fff7df" /><stop offset="1" stopColor="#d8ff3e" /></linearGradient>
          <filter id="trace-glow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <pattern id="micro-grid" width="50" height="29.5" patternUnits="userSpaceOnUse"><path d="M 50 0 L 0 0 0 29.5" fill="none" stroke="currentColor" strokeOpacity=".08" strokeWidth="1" /></pattern>
        </defs>
        <rect width="1000" height="300" fill="url(#micro-grid)" />
        <rect y={150 - bandHalfHeight} width="1000" height={bandHalfHeight * 2} fill="url(#target-band)" />
        {[32, 91, 150, 209, 268].map((y, index) => <line key={y} x1="0" x2="1000" y1={y} y2={y} className={index === 2 ? "target-line" : "guide-line"} />)}
        {envelope && envelope.length > 1 && <path d={`M 0 294 ${envelope.map((value, index) => `L ${(index / (envelope.length - 1)) * 1000} ${294 - value * 55}`).join(" ")} L 1000 294 Z`} className="volume-envelope" />}
        {paths.map((path, index) => <path key={index} d={path} className="pitch-trace-glow" />)}
        {paths.map((path, index) => <path key={index} d={path} className="pitch-trace" />)}
        {!paths.length && <text x="500" y="178" textAnchor="middle" className="ribbon-empty">Your voiced pitch will travel across this lane</text>}
      </svg>
      <div className="ribbon-time-labels"><span>{durationSeconds.toFixed(0)}s ago</span><span>time →</span><span>now</span></div>
      <div className="target-tag"><span /> target lane <b>±{toleranceCents}¢</b></div>
      {frames.at(-1)?.voiced && frames.at(-1)?.midiFloat != null && <div className="live-error-tag">{signed((frames.at(-1)!.midiFloat! - targetMidiFloat) * 100, 0)}¢</div>}
    </div>
  );
}
