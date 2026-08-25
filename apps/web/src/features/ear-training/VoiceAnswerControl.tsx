import type { AudioInputController, AudioInputState } from "@/audio/use-audio-input";
import { ActionButton } from "@/ui/Controls";
import type { ToneMapVoiceAnswerSnapshot } from "./tone-map-voice-answer";

export interface VoiceAnswerControlProps {
  readonly input: AudioInputController;
  readonly voiceAnswer: Readonly<ToneMapVoiceAnswerSnapshot>;
  readonly promptPlaying: boolean;
  readonly answered: boolean;
  readonly onCommit: () => void;
  readonly onUnreachable: () => void;
}

function statusCopy(
  inputState: AudioInputState,
  voiceAnswer: Readonly<ToneMapVoiceAnswerSnapshot>,
  promptPlaying: boolean,
  answered: boolean,
): string {
  if (answered) return "Answer recorded.";
  if (inputState === "disabled") return "Enable voice globally to answer by singing.";
  if (inputState === "opening") return "Voice input is opening from the global control.";
  if (inputState === "error") return "Voice input is unavailable. Use the global voice control.";
  if (promptPlaying) return "Stop the prompt, then let it clear before singing.";
  if (voiceAnswer.status === "awaiting-release") return "Let the prior sound clear, then sing.";
  if (voiceAnswer.ready) return "Sung answer ready.";
  return "Sing and hold one steady pitch.";
}

/**
 * Explicit voice-answer input. It observes shared pitch evidence but never
 * knows the requested answer and never commits, enables, or stops anything on
 * the user's behalf.
 */
export function VoiceAnswerControl({
  input,
  voiceAnswer,
  promptPlaying,
  answered,
  onCommit,
  onUnreachable,
}: VoiceAnswerControlProps) {
  const ready = input.state === "running"
    && voiceAnswer.ready
    && !promptPlaying
    && !answered;
  const status = statusCopy(input.state, voiceAnswer, promptPlaying, answered);
  const authority = voiceAnswer.statusAuthority;

  return (
    <section
      className="voice-answer-control"
      aria-label="Voice answer"
      data-voice-answer-control
      data-transport-state={input.state}
      data-answer-ready={ready ? "true" : "false"}
      data-answered={answered ? "true" : "false"}
      data-status-sample-rate={authority?.sampleRate}
      data-status-start-sample={authority?.startSample}
      data-status-end-sample={authority?.endSample}
      data-status-capture-epoch={authority?.captureEpoch}
      data-status-continuity-epoch={authority?.continuityEpoch}
      data-status-graph-generation={authority?.graphGeneration}
    >
      <p className="voice-answer-status" aria-live="polite">{status}</p>
      <div className="voice-answer-actions">
        <ActionButton
          type="button"
          className="primary"
          data-voice-answer-action="commit"
          disabled={!ready}
          onClick={onCommit}
        >
          Commit sung answer
        </ActionButton>
        <ActionButton
          type="button"
          data-voice-answer-action="unreachable"
          disabled={answered}
          onClick={onUnreachable}
        >
          Outside my voice range
        </ActionButton>
      </div>
    </section>
  );
}
