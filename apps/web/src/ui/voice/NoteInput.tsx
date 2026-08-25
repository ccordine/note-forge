import "../../styles-components.css";
import {
  useAudioPitchSnapshot,
  useAudioTransportSnapshot,
  type AudioInputController,
} from "../../audio/use-audio-input";
import { noteLabel } from "../../lib/music-display";
import { isAuthoritativeVoicedPitch } from "../../realtime/authoritative-voiced-pitch";
import { InputScope, type InputScopeProps } from "../InputScope";
import { VoiceCoach, type VoiceCoachProps } from "./VoiceCoach";

export type NoteInputScopeProps = Omit<InputScopeProps, "input"> & {
  variant: "scope";
  input: AudioInputController;
};

export type NoteInputTargetProps = Omit<VoiceCoachProps, "frame" | "inputState" | "inputError"> & {
  variant: "target";
  input: AudioInputController;
};

export interface NoteInputCompactProps {
  variant: "compact";
  input: AudioInputController;
  compact?: boolean;
}

export type NoteInputProps =
  | NoteInputScopeProps
  | NoteInputTargetProps
  | NoteInputCompactProps;

function TargetNoteInput({ input, ...target }: Omit<NoteInputTargetProps, "variant">) {
  const transport = useAudioTransportSnapshot(input);
  const pitch = useAudioPitchSnapshot(input);
  return (
    <VoiceCoach
      {...target}
      inputState={transport.state}
      inputError={transport.error}
      frame={transport.state === "running" ? pitch.liveFrame : undefined}
    />
  );
}

function CompactNoteInput({ input, compact }: Omit<NoteInputCompactProps, "variant">) {
  const transport = useAudioTransportSnapshot(input);
  const pitch = useAudioPitchSnapshot(input);
  const state = transport.state;
  const frame = state === "running" ? pitch.liveFrame : undefined;
  const detectedFrame = frame && isAuthoritativeVoicedPitch(frame) ? frame : null;
  const detectedMidi = detectedFrame?.nearestMidi ?? null;
  const detected = detectedMidi !== null;
  const statusLabel = state === "disabled"
    ? "MICROPHONE OFF"
    : state === "opening"
      ? "OPENING MICROPHONE"
      : state === "error"
        ? "MICROPHONE ERROR"
        : "LIVE NOTE";
  const statusDetail = state === "disabled"
    ? "use Enable voice above"
    : state === "opening"
      ? "waiting for browser input"
      : state === "error"
        ? transport.error || "microphone unavailable"
        : detectedFrame === null
          ? frame?.reason ?? "no observation yet"
          : `${detectedFrame.frequencyHz.toFixed(2)} Hz · ${Math.round(detectedFrame.confidence * 100)}%`;
  return (
    <div
      className={`nf-note-input-compact ${compact ? "compact" : ""} state-${state} ${detected ? "voiced" : "unvoiced"}`}
      data-note-input
      data-input-state={state}
      data-detected-note={detectedMidi === null ? "" : noteLabel(detectedMidi)}
      data-frame-time={frame?.timeSeconds ?? ""}
      aria-live="polite"
    >
      <span>{statusLabel}</span>
      <strong>{detectedMidi === null ? "—" : noteLabel(detectedMidi)}</strong>
      <small>{statusDetail}</small>
    </div>
  );
}

/** Every variant renders the same direct, continuously updated detector frame. */
export function NoteInput(props: NoteInputProps) {
  if (props.variant === "scope") {
    const { variant: _variant, ...scope } = props;
    return <InputScope {...scope} />;
  }

  if (props.variant === "target") {
    const { variant: _variant, input, ...target } = props;
    return <TargetNoteInput input={input} {...target} />;
  }

  const { variant: _variant, ...compact } = props;
  return <CompactNoteInput {...compact} />;
}
