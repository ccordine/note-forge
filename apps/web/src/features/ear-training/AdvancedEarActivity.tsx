import { useReducer } from "react";
import { playSafely, playTone, playToneSequence, type Timbre } from "@/audio/synth";
import { continuousMidiToHz, noteLabel, pitchClassLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import {
  advancedAnswerIsCorrect,
  advancedAnswerKind,
  advancedEarPrompt,
  canSubmitAdvancedAnswer,
  correctRelation,
  createAdvancedEarState,
  createAdvancedEarTrial,
  reduceAdvancedEarState,
  targetOctave,
  targetPitchClass,
  type AdvancedEarMode,
  type AdvancedEarScore,
  type RelationAnswer,
} from "./advanced-ear-model";

interface AdvancedEarActivityProps {
  readonly mode: AdvancedEarMode;
  readonly timbre: Timbre;
  readonly crossTimbre: boolean;
  readonly labelsHidden: boolean;
  readonly onRevealMidi: (midi: number) => void;
}

function percent(correct: number, attempts: number): number {
  return attempts === 0 ? 0 : Math.round((correct / attempts) * 100);
}

function ScoreSummary({ score }: { readonly score: AdvancedEarScore }) {
  return (
    <div className="score-lozenges" aria-label="Advanced recognition score">
      <span><small>TRIALS</small><b>{score.attempts}</b></span>
      <span>
        <small>PITCH CLASS</small>
        <b>{percent(score.pitchClass, score.pitchClassAttempts)}%</b>
      </span>
      <span><small>OCTAVE</small><b>{percent(score.octave, score.octaveAttempts)}%</b></span>
    </div>
  );
}

function playAdvancedTrial(
  mode: AdvancedEarMode,
  trial: ReturnType<typeof createAdvancedEarTrial>,
  timbre: Timbre,
  crossTimbre: boolean,
): void {
  if (mode === "pitch-class" || mode === "octave" || mode === "complete") {
    playSafely(playTone({
      frequencyHz: continuousMidiToHz(trial.targetMidi),
      timbre: crossTimbre ? trial.timbreB : timbre,
      duration: 1.15,
    }), "Ear-training tone");
    return;
  }

  if (mode === "family") {
    const pitchClass = targetPitchClass(trial);
    const notes = [36, 48, 60, 72]
      .map((base) => base + pitchClass)
      .filter((midi) => midi >= 40 && midi <= 84);
    playSafely(playToneSequence(notes.map((midi, index) => ({
      frequencyHz: continuousMidiToHz(midi),
      timbre: familyTimbre(index, trial, timbre, crossTimbre),
      duration: 0.55,
      amplitude: 0.2,
    })), { gap: 0.12 }), "Ear-training note family");
    return;
  }

  playSafely(playToneSequence([
    {
      frequencyHz: continuousMidiToHz(trial.firstMidi),
      timbre: crossTimbre ? trial.timbreA : timbre,
      duration: 0.72,
      amplitude: 0.24,
      gapAfter: 0.16,
    },
    {
      frequencyHz: continuousMidiToHz(trial.targetMidi),
      timbre: crossTimbre ? trial.timbreB : timbre,
      duration: 0.72,
      amplitude: 0.24,
    },
  ]), "Ear-training comparison");
}

function familyTimbre(
  index: number,
  trial: ReturnType<typeof createAdvancedEarTrial>,
  timbre: Timbre,
  crossTimbre: boolean,
): Timbre {
  if (!crossTimbre) return timbre;
  return index % 2 === 1 ? trial.timbreB : trial.timbreA;
}

function answerClass(selected: boolean, correct: boolean, incorrect: boolean): string {
  return [selected && "selected", correct && "correct", incorrect && "incorrect"]
    .filter(Boolean)
    .join(" ");
}

const RELATION_GLYPHS: Readonly<Record<RelationAnswer, string>> = Object.freeze({
  higher: "↗",
  lower: "↘",
  same: "＝",
  different: "≠",
});

function RelationAnswers({
  mode,
  trial,
  answer,
  reviewed,
  onChoose,
}: {
  readonly mode: Extract<AdvancedEarMode, "same-different" | "direction">;
  readonly trial: ReturnType<typeof createAdvancedEarTrial>;
  readonly answer?: RelationAnswer;
  readonly reviewed: boolean;
  readonly onChoose: (answer: RelationAnswer) => void;
}) {
  const options: readonly RelationAnswer[] = mode === "same-different"
    ? ["same", "different"]
    : ["higher", "lower"];
  const correct = correctRelation(mode, trial);

  return (
    <div className="binary-answers">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={answerClass(
            answer === option,
            reviewed && correct === option,
            reviewed && answer === option && correct !== option,
          )}
          disabled={reviewed}
          onClick={() => onChoose(option)}
        >
          <span>{RELATION_GLYPHS[option]}</span>
          <b>{option}</b>
        </button>
      ))}
    </div>
  );
}

function PitchClassAnswers({
  selected,
  target,
  reviewed,
  onChoose,
}: {
  readonly selected?: number;
  readonly target: number;
  readonly reviewed: boolean;
  readonly onChoose: (pitchClass: number) => void;
}) {
  const status = reviewed ? (selected === target ? "mapped" : "review") : undefined;
  return (
    <>
      <div className="answer-label">
        <span>1</span>
        <div><b>Pitch class</b><small>Identity, independent of octave</small></div>
        {status && <em className={status === "mapped" ? "pass" : "miss"}>{status}</em>}
      </div>
      <div className="pitch-class-grid">
        {Array.from({ length: 12 }, (_, pitchClass) => (
          <button
            key={pitchClass}
            type="button"
            disabled={reviewed}
            className={answerClass(
              selected === pitchClass,
              reviewed && target === pitchClass,
              reviewed && selected === pitchClass && target !== pitchClass,
            )}
            onClick={() => onChoose(pitchClass)}
          >
            {pitchClassLabel(pitchClass)}
          </button>
        ))}
      </div>
    </>
  );
}

function OctaveAnswers({
  selected,
  target,
  reviewed,
  secondCoordinate,
  onChoose,
}: {
  readonly selected?: number;
  readonly target: number;
  readonly reviewed: boolean;
  readonly secondCoordinate: boolean;
  readonly onChoose: (octave: number) => void;
}) {
  const status = reviewed ? (selected === target ? "mapped" : "review") : undefined;
  const labelClass = secondCoordinate ? "answer-label second" : "answer-label";
  return (
    <>
      <div className={labelClass}>
        <span>{secondCoordinate ? "2" : "1"}</span>
        <div><b>Octave</b><small>Register, scored separately</small></div>
        {status && <em className={status === "mapped" ? "pass" : "miss"}>{status}</em>}
      </div>
      <div className="octave-grid">
        {[2, 3, 4, 5].map((octave) => (
          <button
            key={octave}
            type="button"
            disabled={reviewed}
            className={answerClass(
              selected === octave,
              reviewed && target === octave,
              reviewed && selected === octave && target !== octave,
            )}
            onClick={() => onChoose(octave)}
          >
            Octave {octave}
          </button>
        ))}
      </div>
    </>
  );
}

function ReviewResult({
  mode,
  trial,
  answer,
  labelsHidden,
}: {
  readonly mode: AdvancedEarMode;
  readonly trial: ReturnType<typeof createAdvancedEarTrial>;
  readonly answer: Parameters<typeof advancedAnswerIsCorrect>[2];
  readonly labelsHidden: boolean;
}) {
  const correct = advancedAnswerIsCorrect(mode, trial, answer);
  const pitchClassCorrect = answer.pitchClass === targetPitchClass(trial);
  const octaveCorrect = answer.octave === targetOctave(trial);
  const oneCoordinate = mode === "complete" && (pitchClassCorrect || octaveCorrect);
  let heading = "Useful confusion captured";
  if (correct) heading = "Relationship mapped";
  else if (oneCoordinate) heading = "One coordinate mapped";
  const detail = mode === "complete" && pitchClassCorrect && !octaveCorrect
    ? "Pitch class succeeded; register needs another pass."
    : "This distinction stays separate from fixed-family progress.";

  return (
    <div className={`answer-result ${correct ? "correct" : "partial"}`}>
      <Icon name={correct ? "spark" : "ear"} size={21} />
      <div>
        <span>{heading}</span>
        <b>{labelsHidden ? "Reveal: " : ""}{noteLabel(trial.targetMidi)} · {continuousMidiToHz(trial.targetMidi).toFixed(2)} Hz</b>
        <small>{detail}</small>
      </div>
    </div>
  );
}

export function AdvancedEarActivity({
  mode,
  timbre,
  crossTimbre,
  labelsHidden,
  onRevealMidi,
}: AdvancedEarActivityProps) {
  const [state, dispatch] = useReducer(
    reduceAdvancedEarState,
    createAdvancedEarTrial(mode, crossTimbre),
    createAdvancedEarState,
  );
  const reviewed = state.stage === "review";
  const kind = advancedAnswerKind(mode);
  const pitchClass = targetPitchClass(state.trial);
  const octave = targetOctave(state.trial);
  const replay = () => playAdvancedTrial(mode, state.trial, timbre, crossTimbre);

  const completePrimaryAction = () => {
    if (reviewed) {
      dispatch({ type: "next", trial: createAdvancedEarTrial(mode, crossTimbre) });
      return;
    }
    dispatch({ type: "submit", mode });
    onRevealMidi(state.trial.targetMidi);
  };

  let answers = null;
  if (kind === "relation") {
    const relationMode = mode as Extract<AdvancedEarMode, "same-different" | "direction">;
    answers = (
      <RelationAnswers
        mode={relationMode}
        trial={state.trial}
        answer={state.answer.relation}
        reviewed={reviewed}
        onChoose={(relation) => dispatch({ type: "choose-relation", relation })}
      />
    );
  } else {
    answers = (
      <>
        {kind !== "octave" && (
          <PitchClassAnswers
            selected={state.answer.pitchClass}
            target={pitchClass}
            reviewed={reviewed}
            onChoose={(nextPitchClass) => dispatch({ type: "choose-pitch-class", pitchClass: nextPitchClass })}
          />
        )}
        {(kind === "complete" || kind === "octave") && (
          <OctaveAnswers
            selected={state.answer.octave}
            target={octave}
            reviewed={reviewed}
            secondCoordinate={kind === "complete"}
            onChoose={(nextOctave) => dispatch({ type: "choose-octave", octave: nextOctave })}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="advanced-ear-summary">
        <Panel className="advanced-warning">
          <Icon name="spark" size={17} />
          <span>
            <b>Advanced variation is intentional here.</b>
            Mixed register and chromatic material stay isolated from fixed-family mastery.
          </span>
        </Panel>
        <ScoreSummary score={state.score} />
      </div>

      <div className="ear-workspace">
        <Panel className="ear-prompt-card">
          <div className="trial-index">
            TRIAL {String(state.score.attempts + 1).padStart(2, "0")} <span /> {mode}
          </div>
          <button className="sound-orb" type="button" onClick={replay} aria-label="Play prompt">
            <div className="orb-ring one" />
            <div className="orb-ring two" />
            <div className="orb-ring three" />
            <Icon name="play" size={32} />
            <span>PLAY SOUND</span>
          </button>
          <h2>{advancedEarPrompt(mode)}</h2>
          <p>
            {crossTimbre
              ? `Timbres vary independently: ${state.trial.timbreA} → ${state.trial.timbreB}.`
              : `Every sound uses the selected ${timbre} timbre.`}
          </p>
          <PlayButton label="Replay prompt" onClick={replay} />
        </Panel>

        <Panel className="answer-card">
          <Eyebrow>Your reading</Eyebrow>
          {answers}
          {reviewed && (
            <ReviewResult
              mode={mode}
              trial={state.trial}
              answer={state.answer}
              labelsHidden={labelsHidden}
            />
          )}
          <ActionButton
            className="wide primary"
            disabled={!reviewed && !canSubmitAdvancedAnswer(mode, state.answer)}
            onClick={completePrimaryAction}
          >
            {reviewed ? <>Next sound <Icon name="arrow" size={17} /></> : "Commit answer"}
          </ActionButton>
        </Panel>
      </div>
    </>
  );
}
