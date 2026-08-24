import type { CSSProperties } from "react";
import { splitMidiPitch } from "@noteforge/music-core";
import type { AudioInputState } from "../../audio/use-audio-input";
import { noteLabel, signed } from "../../lib/music-display";

export type VoiceSignalAxis = "level" | "stability" | "coherence";
export type VoiceSignalState = "waiting" | "responding" | "paused" | "complete";

export interface VoiceSignalCoachProps {
  inputState: AudioInputState;
  inputError?: string;
  /** Canonical visible detector output. This is observed evidence, never a target. */
  midiFloat: number | null;
  frequencyHz: number | null;
  reliable: boolean;
  /** Session-relative bounded energy used by the exercise, from zero through one. */
  relativeLevel: number;
  /** Recent pitch stability used by the exercise, from zero through one. */
  stability: number;
  /** Periodicity × stability control quality, from zero through one. */
  coherence: number;
  /** Null keeps every scalar contextual when the observed note is the axis under study. */
  emphasis: VoiceSignalAxis | null;
  /** Restrict the surface to the causal axes this exercise actually teaches. */
  visibleAxes?: readonly VoiceSignalAxis[];
  state: VoiceSignalState;
  guidanceTitle: string;
  guidanceDetail: string;
  title?: string;
  levelText?: string;
  stabilityText?: string;
  coherenceText?: string;
  /** Disable when the parent owns one debounced accessible-status channel. */
  guidanceLive?: boolean;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function percent(value: number): number {
  return Math.round(clamp01(value) * 100);
}

/**
 * Target-free voice feedback for exercises where pitch location is deliberately
 * normalized. It shows the note the detector observed for orientation, but it
 * never draws a target lane or tells the singer to move up/down.
 */
export function VoiceSignalCoach({
  inputState,
  inputError,
  midiFloat,
  frequencyHz,
  reliable,
  relativeLevel,
  stability,
  coherence,
  emphasis,
  visibleAxes = ["level", "stability", "coherence"],
  state,
  guidanceTitle,
  guidanceDetail,
  title = "Voice signal",
  levelText,
  stabilityText,
  coherenceText,
  guidanceLive = false,
}: VoiceSignalCoachProps) {
  const inputRunning = inputState === "running";
  const measuredMidi = inputRunning && reliable && midiFloat !== null && Number.isFinite(midiFloat)
    ? midiFloat
    : null;
  const measuredPitch = measuredMidi === null ? null : splitMidiPitch(measuredMidi);
  const measuredFrequency = inputRunning && reliable && frequencyHz !== null && Number.isFinite(frequencyHz)
    ? frequencyHz
    : null;
  const levelPercent = inputRunning ? percent(relativeLevel) : 0;
  const stabilityPercent = inputRunning ? percent(stability) : 0;
  const coherencePercent = inputRunning ? percent(coherence) : 0;
  const inputLabel = inputState === "disabled"
    ? "MICROPHONE OFF"
    : inputState === "opening"
      ? "OPENING MICROPHONE"
      : inputState === "error"
        ? "MICROPHONE ERROR"
        : "MEASURED VOICE · NO PITCH TARGET";
  const inputDetail = inputState === "disabled"
    ? "enable input to begin continuous note detection"
    : inputState === "opening"
      ? "waiting for browser permission and production PCM"
      : inputState === "error"
        ? inputError || "microphone unavailable"
        : measuredFrequency === null || measuredPitch === null
          ? "waiting for periodic voice evidence"
          : `${measuredFrequency.toFixed(2)} Hz · ${signed(measuredPitch.centsFromNearest, 0)}¢ from nearest note`;
  const stateLabel = inputState === "disabled"
    ? "MICROPHONE OFF"
    : inputState === "opening"
      ? "OPENING MICROPHONE"
      : inputState === "error"
        ? "MICROPHONE ERROR"
        : state === "complete"
          ? "OBJECTIVE PROVEN · DETECTOR LIVE"
          : state === "paused"
            ? "GAME PAUSED · DETECTOR LIVE"
            : state === "responding"
              ? "SIGNAL RESPONDING"
              : "LISTENING CONTINUOUSLY";
  const effectiveGuidanceTitle = inputRunning
    ? guidanceTitle
    : inputState === "disabled"
      ? "Enable microphone input"
      : inputState === "opening"
        ? "Opening microphone"
        : inputState === "error"
          ? "Microphone unavailable"
          : guidanceTitle;
  const effectiveGuidanceDetail = inputRunning ? guidanceDetail : inputDetail;
  const style = {
    "--nf-signal-level": `${levelPercent}%`,
    "--nf-signal-stability": `${stabilityPercent}%`,
    "--nf-signal-coherence": `${coherencePercent}%`,
  } as CSSProperties;
  const axes = [
    {
      id: "level" as const,
      label: "RELATIVE ENERGY",
      value: levelPercent,
      valueText: levelText ?? `${levelPercent} percent of bounded session-relative energy`,
      detail: "Comfort-relative and capped; this is not an absolute microphone-volume reading.",
    },
    {
      id: "stability" as const,
      label: "PITCH STABILITY",
      value: stabilityPercent,
      valueText: stabilityText ?? `${stabilityPercent} percent pitch stability`,
      detail: "Recent canonical pitch spread; note location is not being graded here.",
    },
    {
      id: "coherence" as const,
      label: "COHERENCE",
      value: coherencePercent,
      valueText: coherenceText ?? `${coherencePercent} percent coherent periodic control`,
      detail: "Periodic evidence combined with stability; louder is not automatically better.",
    },
  ].filter((axis) => visibleAxes.includes(axis.id));

  return (
    <section className={`nf-voice-signal-coach ${state} input-${inputState}`} style={style} aria-label={title}>
      <div className="nf-voice-signal-observed">
        <span>{inputLabel}</span>
        <strong>{measuredPitch === null ? "—" : noteLabel(measuredPitch.nearestMidi)}</strong>
        <small>{inputDetail}</small>
      </div>

      <div
        className="nf-voice-signal-guidance"
        role={guidanceLive ? "status" : undefined}
        aria-live={guidanceLive ? "polite" : undefined}
        aria-atomic={guidanceLive ? "true" : undefined}
      >
        <span>{stateLabel}</span>
        <h2>{effectiveGuidanceTitle}</h2>
        <p>{effectiveGuidanceDetail}</p>
      </div>

      {inputRunning && axes.length > 0 && (
        <div className="nf-voice-signal-axes" aria-label="Derived voice control signals">
          {axes.map((axis) => (
            <div key={axis.id} className={axis.id === emphasis ? "emphasis" : "context"}>
              <header><span>{axis.label}</span><b>{axis.value}%</b></header>
              <div
                className={`nf-voice-signal-meter axis-${axis.id}`}
                role="meter"
                aria-label={axis.label.toLowerCase()}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={axis.value}
                aria-valuetext={axis.valueText}
              ><i /></div>
              <small>{axis.detail}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
