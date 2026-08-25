import { useId } from "react";
import type { PitchObservation } from "@/audio/note-input";
import { noteLabel, signed } from "@/lib/music-display";
import { isAuthoritativeVoicedPitch } from "@/realtime/authoritative-voiced-pitch";
import {
  observationContinuity,
  type ObservationSampleAuthority,
} from "@/realtime/observation-continuity";
import {
  PITCH_METER_MAXIMUM_MIDI,
  PITCH_METER_MINIMUM_MIDI,
  pitchMeterBandPercent,
  pitchMeterMidiIsInRange,
  pitchMeterPositionPercent,
} from "@/ui/voice/pitch-meter-scale";

interface PitchRibbonProps {
  frames: readonly PitchRibbonFrame[];
  targetMidiFloat: number;
  toleranceCents: number;
  windowSeconds?: number;
  envelope?: readonly number[];
}

type PitchRibbonFrame = Readonly<PitchObservation>;

interface PitchRibbonPathSegment {
  readonly path: string;
  readonly lastFrame: Readonly<PitchRibbonFrame>;
}

const RIBBON_HEIGHT = 300;

export function pitchRibbonYForMidi(
  midiFloat: number,
  targetMidiFloat: number,
): number {
  const position = pitchMeterPositionPercent(midiFloat, targetMidiFloat) ?? 50;
  return (100 - position) / 100 * RIBBON_HEIGHT;
}

function pathSegments(frames: readonly PitchRibbonFrame[], targetMidiFloat: number, startTime: number, span: number): PitchRibbonPathSegment[] {
  const paths: PitchRibbonPathSegment[] = [];
  let active = "";
  let lastFrame: Readonly<PitchRibbonFrame> | null = null;
  let previousAuthority: Readonly<ObservationSampleAuthority> | null = null;
  const flush = () => {
    if (active && lastFrame) paths.push({ path: active, lastFrame });
    active = "";
    lastFrame = null;
  };
  for (const frame of frames) {
    const continuity = observationContinuity(previousAuthority, frame);
    if (!continuity.accepted) {
      if (continuity.reason === "invalid") {
        flush();
      }
      continue;
    }
    previousAuthority = continuity.authority;
    if (
      !isAuthoritativeVoicedPitch(frame)
      || frame.timeSeconds < startTime
      || continuity.boundary
    ) {
      flush();
      if (!isAuthoritativeVoicedPitch(frame) || frame.timeSeconds < startTime) continue;
    }
    const x = ((frame.timeSeconds - startTime) / span) * 1000;
    const y = pitchRibbonYForMidi(frame.midiFloat, targetMidiFloat);
    active += `${active ? " L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    lastFrame = frame;
  }
  flush();
  return paths;
}

export function PitchRibbon({ frames, targetMidiFloat, toleranceCents, windowSeconds = 8, envelope }: PitchRibbonProps) {
  const id = useId().replaceAll(":", "");
  const targetBandId = `${id}-target-band`;
  const traceGradientId = `${id}-trace-gradient`;
  const traceGlowId = `${id}-trace-glow`;
  const gridId = `${id}-micro-grid`;
  const endTime = frames.at(-1)?.timeSeconds ?? windowSeconds;
  const startTime = Math.max(0, endTime - windowSeconds);
  const paths = pathSegments(frames, targetMidiFloat, startTime, windowSeconds);
  const targetBand = pitchMeterBandPercent(targetMidiFloat, toleranceCents);
  const targetBandTop = RIBBON_HEIGHT
    - (targetBand.leftPercent + targetBand.widthPercent) / 100 * RIBBON_HEIGHT;
  const targetBandHeight = targetBand.widthPercent / 100 * RIBBON_HEIGHT;
  const guides = [-100, -50, 0, 50, 100]
    .map((cents) => ({ cents, midi: targetMidiFloat + cents / 100 }))
    .filter(({ midi }) => pitchMeterMidiIsInRange(midi))
    .map(({ cents, midi }) => ({
      cents,
      y: pitchRibbonYForMidi(midi, targetMidiFloat),
    }));
  const focusLabels = [
    { key: "sharp", label: "+100¢", midi: targetMidiFloat + 1, kind: "focus" },
    { key: "target", label: noteLabel(Math.round(targetMidiFloat)), midi: targetMidiFloat, kind: "target" },
    { key: "flat", label: "−100¢", midi: targetMidiFloat - 1, kind: "focus" },
  ].filter(({ midi }) => (
    pitchMeterMidiIsInRange(midi)
    && midi > PITCH_METER_MINIMUM_MIDI
    && midi < PITCH_METER_MAXIMUM_MIDI
  )).map((label) => ({
    ...label,
    y: pitchRibbonYForMidi(label.midi, targetMidiFloat),
  }));
  const labels = [
    {
      key: "maximum",
      label: noteLabel(Math.round(PITCH_METER_MAXIMUM_MIDI)),
      y: pitchRibbonYForMidi(PITCH_METER_MAXIMUM_MIDI, targetMidiFloat),
      kind: "range",
    },
    ...focusLabels,
    {
      key: "minimum",
      label: noteLabel(Math.round(PITCH_METER_MINIMUM_MIDI)),
      y: pitchRibbonYForMidi(PITCH_METER_MINIMUM_MIDI, targetMidiFloat),
      kind: "range",
    },
  ];
  return (
    <div className="pitch-ribbon-wrap">
      <div className="ribbon-y-labels" aria-hidden="true">{labels.map((label) => (
        <span
          className={label.kind}
          data-pitch-tick-position={label.y / RIBBON_HEIGHT * 100}
          key={label.key}
          style={{ top: `${label.y / RIBBON_HEIGHT * 100}%` }}
        >{label.label}</span>
      ))}</div>
      <svg
        className="pitch-ribbon"
        data-full-depth-pitch-ribbon
        viewBox="0 0 1000 300"
        preserveAspectRatio="none"
        role="img"
        aria-label="Your full-depth detected pitch contour relative to target, over time"
      >
        <defs>
          <linearGradient id={targetBandId} x1="0" x2="1"><stop stopColor="#d8ff3e" stopOpacity=".05" /><stop offset=".5" stopColor="#d8ff3e" stopOpacity=".2" /><stop offset="1" stopColor="#d8ff3e" stopOpacity=".05" /></linearGradient>
          <linearGradient id={traceGradientId}><stop stopColor="#ff6b45" /><stop offset=".48" stopColor="#fff7df" /><stop offset="1" stopColor="#d8ff3e" /></linearGradient>
          <filter id={traceGlowId}><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <pattern id={gridId} width="50" height="29.5" patternUnits="userSpaceOnUse"><path d="M 50 0 L 0 0 0 29.5" fill="none" stroke="currentColor" strokeOpacity=".08" strokeWidth="1" /></pattern>
        </defs>
        <rect width="1000" height="300" fill={`url(#${gridId})`} />
        <rect y={targetBandTop} width="1000" height={targetBandHeight} fill={`url(#${targetBandId})`} />
        {guides.map(({ cents, y }) => <line key={cents} x1="0" x2="1000" y1={y} y2={y} className={cents === 0 ? "target-line" : "guide-line"} />)}
        {envelope && envelope.length > 1 && <path d={`M 0 294 ${envelope.map((value, index) => `L ${(index / (envelope.length - 1)) * 1000} ${294 - value * 55}`).join(" ")} L 1000 294 Z`} className="volume-envelope" />}
        {paths.map((segment, index) => <path key={index} d={segment.path} className="pitch-trace-glow" stroke={`url(#${traceGradientId})`} filter={`url(#${traceGlowId})`} />)}
        {paths.map((segment, index) => <path
          key={index}
          d={segment.path}
          className="pitch-trace"
          stroke={`url(#${traceGradientId})`}
          data-pitch-trace-segment
          data-capture-epoch={segment.lastFrame.captureEpoch}
          data-continuity-epoch={segment.lastFrame.continuityEpoch}
          data-graph-generation={segment.lastFrame.graphGeneration}
          data-start-sample={segment.lastFrame.startSample}
          data-end-sample={segment.lastFrame.endSample}
          data-live-midi={segment.lastFrame.midiFloat ?? ""}
        />)}
        {!paths.length && <text x="500" y="178" textAnchor="middle" className="ribbon-empty">Your voiced pitch will travel across this lane</text>}
      </svg>
      <div className="ribbon-time-labels"><span>recent</span><span>continuous trace →</span><span>now</span></div>
      <div className="target-tag"><span /> target lane <b>±{toleranceCents}¢</b></div>
      {frames.at(-1) && isAuthoritativeVoicedPitch(frames.at(-1)!) && <div className="live-error-tag">{signed((frames.at(-1)!.midiFloat! - targetMidiFloat) * 100, 0)}¢</div>}
    </div>
  );
}
