import type { AudioInputController } from "../../audio/use-audio-input";
import { noteLabel } from "../../lib/music-display";
import { InputScope, type InputScopeProps } from "../InputScope";
import { VoiceCoach, type VoiceCoachProps } from "./VoiceCoach";
import { VoiceSignalCoach, type VoiceSignalCoachProps } from "./VoiceSignalCoach";

export type NoteInputScopeProps = Omit<InputScopeProps, "input"> & {
  variant: "scope";
  input: AudioInputController;
};

export type NoteInputTargetProps = Omit<VoiceCoachProps, "frame" | "telemetry" | "inputState" | "inputError"> & {
  variant: "target";
  input: AudioInputController;
};

export type NoteInputSignalProps = Omit<
  VoiceSignalCoachProps,
  "midiFloat" | "frequencyHz" | "reliable" | "inputState" | "inputError"
> & {
  variant: "signal";
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
  | NoteInputSignalProps
  | NoteInputCompactProps;

/** Every variant renders the same direct, continuously updated detector frame. */
export function NoteInput(props: NoteInputProps) {
  if (props.variant === "scope") {
    const { variant: _variant, ...scope } = props;
    return <InputScope {...scope} />;
  }

  if (props.variant === "target") {
    const { variant: _variant, input, ...target } = props;
    return (
      <VoiceCoach
        {...target}
        inputState={input.state}
        inputError={input.error}
        frame={input.state === "running" ? input.liveFrame : undefined}
        telemetry={input.state === "running" ? input.telemetry : null}
      />
    );
  }

  if (props.variant === "compact") {
    const state = props.input.state;
    const frame = state === "running" ? props.input.liveFrame : undefined;
    const detectedMidi = frame?.voiced === true ? frame.nearestMidi : null;
    const detected = detectedMidi !== null && detectedMidi !== undefined;
    const statusLabel = state === "disabled"
      ? "MICROPHONE OFF"
      : state === "opening"
        ? "OPENING MICROPHONE"
        : state === "error"
          ? "MICROPHONE ERROR"
          : "LIVE NOTE";
    const statusDetail = state === "disabled"
      ? "enable input to begin"
      : state === "opening"
        ? "waiting for browser input"
        : state === "error"
          ? props.input.error || "microphone unavailable"
          : frame?.frequencyHz === null || frame?.frequencyHz === undefined
            ? frame?.reason ?? "no observation yet"
            : `${frame.frequencyHz.toFixed(2)} Hz · ${Math.round(frame.confidence * 100)}%`;
    return (
      <div
        className={`nf-note-input-compact ${props.compact ? "compact" : ""} state-${state} ${detected ? "voiced" : "unvoiced"}`}
        data-note-input
        data-input-state={state}
        data-detected-note={detectedMidi === null || detectedMidi === undefined ? "" : noteLabel(detectedMidi)}
        data-frame-time={frame?.timeSeconds ?? ""}
        aria-live="polite"
      >
        <span>{statusLabel}</span>
        <strong>{detectedMidi === null || detectedMidi === undefined ? "—" : noteLabel(detectedMidi)}</strong>
        <small>{statusDetail}</small>
      </div>
    );
  }

  const {
    variant: _variant,
    input,
    ...signal
  } = props;
  const live = input.state === "running" ? input.liveFrame : undefined;
  return (
    <VoiceSignalCoach
      {...signal}
      inputState={input.state}
      inputError={input.error}
      midiFloat={live?.midiFloat ?? null}
      frequencyHz={live?.frequencyHz ?? null}
      reliable={live?.voiced === true}
    />
  );
}
