import type { PitchObservation } from "../../audio/note-input";
import type { AudioInputState } from "../../audio/use-audio-input";
import { noteLabel } from "../../lib/music-display";
import { isAuthoritativeVoicedPitch } from "../../realtime/authoritative-voiced-pitch";

export type VoiceCoachPhase = "idle" | "listening" | "complete";

export interface VoiceCoachHold {
  heldSeconds: number;
  requiredSeconds: number;
  status: "waiting" | "holding" | "complete";
}

export interface VoiceCoachViewInput {
  inputState: AudioInputState;
  inputError?: string;
  targetMidi: number;
  toleranceCents: number;
  phase: VoiceCoachPhase;
  frame?: Readonly<PitchObservation>;
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

function holdStatusLabel(
  inputState: AudioInputState,
  holdStatus: VoiceCoachHold["status"],
): string {
  if (inputState === "disabled") return "MICROPHONE OFF";
  if (inputState === "opening") return "OPENING MICROPHONE";
  if (inputState === "error") return "MICROPHONE ERROR";
  if (holdStatus === "complete") return "EARNED · DETECTION CONTINUES";
  if (holdStatus === "holding") return "IN LANE · HOLD CLOCK MOVING";
  return "FIND THE TARGET LANE";
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
    && frame
    && isAuthoritativeVoicedPitch(frame)
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
    title = "Voice input is off";
    detail = "Use Enable voice in the global header to start continuous note detection.";
  } else if (inputState === "opening") {
    title = "Opening microphone";
    detail = "Waiting for browser permission and the first production PCM window.";
  } else if (inputState === "error") {
    title = "Microphone unavailable";
    detail = inputError || "Review browser permission or reconnect the device, then use Retry voice in the global header.";
  } else if (phase === "complete" || hold.status === "complete") {
    title = "Note earned";
    detail = "The exercise hold completed; live note detection remains active.";
    tone = "success";
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

  const holdLabel = holdStatusLabel(inputState, hold.status);

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
