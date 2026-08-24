import type { YinPitchFrame } from "@noteforge/pitch-engine";
import type { AudioInputState } from "../../audio/use-audio-input";
import { noteLabel } from "../../lib/music-display";

export type VoiceCoachPhase = "idle" | "prompting" | "listening" | "paused" | "complete";

export interface VoiceCoachHold {
  heldSeconds: number;
  requiredSeconds: number;
  status: "waiting" | "holding" | "paused" | "complete";
}

export interface VoiceCoachViewInput {
  inputState: AudioInputState;
  inputError?: string;
  targetMidi: number;
  toleranceCents: number;
  phase: VoiceCoachPhase;
  frame?: Readonly<YinPitchFrame>;
  hold: VoiceCoachHold;
  guidanceTitle?: string;
  guidanceDetail?: string;
}

export interface VoiceCoachView {
  measuredNote: string;
  frequencyLabel: string;
  errorCents: number | null;
  guidanceTitle: string;
  guidanceDetail: string;
  guidanceTone: "waiting" | "flat" | "sharp" | "locked" | "success";
  holdLabel: string;
  inBand: boolean;
}

export function createVoiceCoachView({
  inputState,
  inputError,
  targetMidi,
  toleranceCents,
  phase,
  frame,
  hold,
  guidanceTitle,
  guidanceDetail,
}: VoiceCoachViewInput): VoiceCoachView {
  const inputRunning = inputState === "running";
  const measuredFrame = inputRunning
    && frame?.voiced === true
    && frame.midiFloat !== null
    && Number.isFinite(frame.midiFloat)
    ? frame
    : null;
  const measuredMidi = measuredFrame?.midiFloat ?? null;
  const voiced = measuredMidi !== null;
  const errorCents = measuredMidi === null ? null : (measuredMidi - targetMidi) * 100;
  const inBand = errorCents !== null && Math.abs(errorCents) <= toleranceCents;
  const measuredNote = voiced && measuredFrame?.nearestMidi !== null && measuredFrame?.nearestMidi !== undefined ? noteLabel(measuredFrame.nearestMidi) : "—";
  const frequencyLabel = voiced && measuredFrame?.frequencyHz !== null && measuredFrame?.frequencyHz !== undefined
    ? `${measuredFrame.frequencyHz.toFixed(2)} Hz`
    : "no periodic pitch in this PCM window";

  let title = "Listening continuously";
  let detail = "Every microphone window is processed immediately. Produce any note to see it here.";
  let tone: VoiceCoachView["guidanceTone"] = "waiting";
  if (inputState === "disabled") {
    title = "Microphone off";
    detail = "Enable microphone input to begin continuous note detection.";
  } else if (inputState === "opening") {
    title = "Opening microphone";
    detail = "Waiting for browser permission and the first production PCM window.";
  } else if (inputState === "error") {
    title = "Microphone unavailable";
    detail = inputError || "Review browser permission or reconnect the input, then enable it again.";
  } else if (phase === "complete" || hold.status === "complete") {
    title = "Note earned";
    detail = "The exercise hold completed; live note detection remains active.";
    tone = "success";
  } else if (phase === "prompting") {
    title = "Reference playing · detector still live";
    detail = "The exercise may exclude prompt leakage from scoring, but the live note readout never stops.";
  } else if (hold.status === "paused") {
    title = "Scoring is waiting · detector still live";
    detail = "No stale note is held. Each current PCM result remains visible while the exercise waits.";
  } else if (errorCents !== null && inBand) {
    title = "Locked · keep it steady";
    detail = "The current detector frame is inside the target lane.";
    tone = "locked";
  } else if (errorCents !== null && errorCents < 0) {
    title = "Glide upward";
    detail = `${Math.abs(errorCents).toFixed(0)} cents below ${noteLabel(targetMidi)}.`;
    tone = "flat";
  } else if (errorCents !== null) {
    title = "Ease downward";
    detail = `${Math.abs(errorCents).toFixed(0)} cents above ${noteLabel(targetMidi)}.`;
    tone = "sharp";
  }

  const holdLabel = inputState === "disabled"
    ? "MICROPHONE OFF"
    : inputState === "opening"
      ? "OPENING MICROPHONE"
      : inputState === "error"
        ? "MICROPHONE ERROR"
        : hold.status === "complete"
          ? "EARNED · DETECTION CONTINUES"
          : hold.status === "paused"
            ? "SCORING WAITING · DETECTION LIVE"
            : hold.status === "holding"
              ? "IN LANE · HOLD CLOCK MOVING"
              : phase === "prompting"
                ? "REFERENCE PLAYING · DETECTION LIVE"
                : "FIND THE TARGET LANE";

  return {
    measuredNote,
    frequencyLabel,
    errorCents,
    guidanceTitle: inputRunning ? guidanceTitle ?? title : title,
    guidanceDetail: inputRunning ? guidanceDetail ?? detail : detail,
    guidanceTone: tone,
    holdLabel,
    inBand,
  };
}
