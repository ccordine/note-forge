import type { AudioInputController } from "@/audio/use-audio-input";
import type { SustainedNoteControl } from "@/audio/use-sustained-note";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { NotePlaybackToggle } from "@/ui/NotePlaybackToggle";
import { ToneMapKeyboard } from "./ToneMapKeyboard";
import { VoiceAnswerControl } from "./VoiceAnswerControl";
import type {
  ToneMapCommittedAnswer,
} from "./tone-map-session";
import type {
  ToneMapSkillEvidence,
  ToneMapTask,
} from "./tone-map-model";
import type { ToneMapVoiceAnswerSnapshot } from "./tone-map-voice-answer";

interface ToneMapSingleTrialProps {
  readonly task: ToneMapTask | null;
  readonly answer: ToneMapCommittedAnswer | null;
  readonly evidence: ToneMapSkillEvidence | null;
  readonly input: AudioInputController;
  readonly voiceAnswer: Readonly<ToneMapVoiceAnswerSnapshot>;
  readonly playback: Readonly<SustainedNoteControl>;
  readonly onAnswerMidi: (midi: number) => void;
  readonly onCommitVoiceAnswer: () => void;
  readonly onUnreachable: () => void;
  readonly onNext: () => void;
  readonly onRetryExcluded: () => void;
}

function EvidenceLine({
  task,
  evidence,
}: {
  readonly task: ToneMapTask;
  readonly evidence: ToneMapSkillEvidence;
}) {
  const guided = task.cueVisibility === "guided";
  const streak = guided ? evidence.guidedStreak : evidence.blindStreak;
  const gate = guided ? 2 : 3;
  return (
    <small>
      {guided ? "Association" : "Blind streak"}: {Math.min(streak, gate)}/{gate}
      {evidence.stable ? " · stable" : ""} · lifetime {evidence.correct}/{evidence.attempts}
    </small>
  );
}

function TrialReview({
  task,
  answer,
  evidence,
  onNext,
}: {
  readonly task: ToneMapTask;
  readonly answer: ToneMapCommittedAnswer;
  readonly evidence: ToneMapSkillEvidence;
  readonly onNext: () => void;
}) {
  const unreachable = answer.kind === "production-unreachable";
  const correct = answer.kind === "midi" && answer.correct;
  const answerLabel = answer.kind === "midi" ? noteLabel(answer.midi) : null;
  const presentation = (() => {
    if (unreachable) {
      return {
        className: "neutral",
        status: "NOT SCORED",
        detail: "This note is excluded only from vocal scheduling. Ear-to-key learning is unchanged.",
      };
    }
    if (correct) {
      return {
        className: "correct",
        status: "CORRECT",
        detail: "Your committed answer matched the prompt.",
      };
    }
    return {
      className: "incorrect",
      status: "MAP MISSED",
      detail: `You committed ${answerLabel}. This note's current ${task.cueVisibility} streak restarted.`,
    };
  })();
  return (
    <div
      className={`tone-map-trial__review ${presentation.className}`}
      role="status"
      aria-live="polite"
      data-tone-map-review
      data-tone-map-target-midi={task.midi}
    >
      <span>{presentation.status}</span>
      <b>{noteLabel(task.midi)} · {continuousMidiToHz(task.midi).toFixed(2)} Hz</b>
      <p>{presentation.detail}</p>
      <EvidenceLine task={task} evidence={evidence} />
      <ActionButton className="primary" onClick={onNext}>Next randomized tone</ActionButton>
    </div>
  );
}

function NoProductionTask({
  playback,
  onRetry,
}: {
  readonly playback: Readonly<SustainedNoteControl>;
  readonly onRetry: () => void;
}) {
  return (
    <Panel className="tone-map-trial tone-map-trial--empty">
      <Eyebrow>Vocal range respected</Eyebrow>
      <h2>No active tone is currently marked reachable.</h2>
      <p>This is neutral—not a failure. Use keyboard recall, or explicitly reconsider the excluded vocal notes.</p>
      <NotePlaybackToggle label="last prompt" playback={playback} />
      <ActionButton onClick={onRetry}>Retry excluded vocal notes</ActionButton>
    </Panel>
  );
}

export function ToneMapSingleTrial({
  task,
  answer,
  evidence,
  input,
  voiceAnswer,
  playback,
  onAnswerMidi,
  onCommitVoiceAnswer,
  onUnreachable,
  onNext,
  onRetryExcluded,
}: ToneMapSingleTrialProps) {
  if (task === null || evidence === null) {
    return <NoProductionTask playback={playback} onRetry={onRetryExcluded} />;
  }
  const answerMidi = answer?.kind === "midi" ? answer.midi : null;
  const answered = answer !== null;
  return (
    <Panel
      className="tone-map-trial"
      data-tone-map-trial
      data-cue-visibility={task.cueVisibility}
      data-response-skill={task.skill}
    >
      <div className="tone-map-trial__instruction">
        <Eyebrow>
          {task.cueVisibility === "guided" ? "Build the association" : "Stability check"}
        </Eyebrow>
        {task.cueVisibility === "guided" ? (
          <div className="tone-map-trial__guided">
            <strong>HEAR</strong>
            <span>Use the labeled keys to connect this sound to its place.</span>
          </div>
        ) : (
          <div className="tone-map-trial__blind">
            <strong>?</strong>
            <span>The target stays hidden until you commit; key names remain visible for context.</span>
          </div>
        )}
        <h2>
          {task.skill === "identification"
            ? "Hear it, then find its exact key."
            : "Hear it, then reproduce that exact pitch."}
        </h2>
        <p>
          {task.skill === "identification"
            ? "Every key keeps its note name. On phones, drag only the keyboard sideways."
            : "The detector remains hidden until commitment. Headphones prevent the prompt from becoming your sung answer."}
        </p>
        <NotePlaybackToggle label="prompt" playback={playback} />
      </div>

      <div className="tone-map-trial__answer">
        {task.skill === "identification" ? (
          <ToneMapKeyboard
            targetMidi={task.midi}
            answerMidi={answerMidi}
            disabled={answered}
            onAnswer={onAnswerMidi}
          />
        ) : (
          <VoiceAnswerControl
            input={input}
            voiceAnswer={voiceAnswer}
            promptPlaying={playback.playing}
            answered={answered}
            onCommit={onCommitVoiceAnswer}
            onUnreachable={onUnreachable}
          />
        )}
        {answer !== null && (
          <TrialReview
            task={task}
            answer={answer}
            evidence={evidence}
            onNext={onNext}
          />
        )}
      </div>
    </Panel>
  );
}
