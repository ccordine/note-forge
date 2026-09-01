import { useState } from "react";
import { playToneSequence, type Timbre } from "@/audio/synth";
import { useSessionEffectScope } from "@/features/training-session/use-session-effect-scope";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton, Select } from "@/ui/Controls";
import { PianoKeyboardViewport } from "@/ui/PianoKeyboard";
import {
  createToneMapSimonSequence,
  type ToneMapCourseState,
} from "./tone-map-model";
import {
  appendToneMapSimonAnswer,
  createToneMapSimonRound,
  gradeToneMapSimonRound,
  reduceToneMapSimonRound,
  type ToneMapSimonGrade,
  type ToneMapSimonRound,
} from "./tone-map-simon-model";

interface ToneMapSimonProps {
  readonly course: ToneMapCourseState;
  readonly timbre: Timbre;
  readonly length: number;
  readonly onLengthChange: (length: number) => void;
  readonly onCourseChange: (course: ToneMapCourseState) => void;
}

function createRound(course: ToneMapCourseState, length: number): ToneMapSimonRound {
  return createToneMapSimonRound(createToneMapSimonSequence(course, {
    seed: `simon:${crypto.randomUUID()}`,
    length,
  }));
}

function playRound(round: ToneMapSimonRound, timbre: Timbre) {
  return playToneSequence(round.sequence.map((midi) => ({
    frequencyHz: continuousMidiToHz(midi),
    timbre,
    duration: 0.46,
    gapAfter: 0.14,
    amplitude: 0.22,
    release: 0.06,
  })));
}

function SequenceReview({ grade }: { readonly grade: ToneMapSimonGrade }) {
  const correct = grade.positions.filter((position) => position.correct).length;
  return (
    <div className="tone-map-simon__review" role="status" aria-live="polite">
      <b>{correct}/{grade.positions.length} positions correct</b>
      <ol>
        {grade.positions.map((position) => (
          <li className={position.correct ? "correct" : "incorrect"} key={position.index}>
            <span>{noteLabel(position.targetMidi)}</span>
            <small>
              {position.correct ? "correct" : `you chose ${noteLabel(position.answerMidi)}`}
            </small>
          </li>
        ))}
      </ol>
    </div>
  );
}

function sequenceTransportLabel(round: ToneMapSimonRound): string {
  if (round.phase === "playing") return "Stop sequence";
  if (round.phase === "answering") return "Replay sequence";
  return "Play sequence";
}

function sequenceInstruction(round: ToneMapSimonRound): string {
  switch (round.phase) {
    case "ready-to-play":
      return "Play the hidden sequence before answering.";
    case "playing":
      return "Listen to the complete sequence. Answers stay locked during playback.";
    case "answering":
      return "Enter the remembered tones in order. There is no answer deadline.";
    case "review":
      return "Review the complete response, then choose Next sequence.";
  }
}

/** Untimed auditory working-memory challenge over the same cumulative course. */
export function ToneMapSimon({
  course,
  timbre,
  length,
  onLengthChange,
  onCourseChange,
}: ToneMapSimonProps) {
  const effects = useSessionEffectScope();
  const [round, setRound] = useState(() => createRound(course, length));
  const [grade, setGrade] = useState<ToneMapSimonGrade | null>(null);
  const reviewed = grade !== null;
  const playing = round.phase === "playing";
  const acceptingAnswers = round.phase === "answering";

  const startRound = (nextLength = length) => {
    effects.abort();
    setRound(createRound(course, nextLength));
    setGrade(null);
  };
  const changeLength = (nextLength: number) => {
    onLengthChange(nextLength);
    startRound(nextLength);
  };
  const answer = (midi: number) => {
    if (!acceptingAnswers) return;
    const next = appendToneMapSimonAnswer(round, midi);
    setRound(next);
    if (next.answers.length !== next.sequence.length) return;
    const completed = gradeToneMapSimonRound(course, next);
    setGrade(completed);
    onCourseChange(completed.course);
  };
  const toggleSequencePlayback = () => {
    if (playing) {
      effects.abort();
      setRound((current) => reduceToneMapSimonRound(current, { type: "stop-playback" }));
      return;
    }
    const next = reduceToneMapSimonRound(round, { type: "play" });
    if (next === round) return;
    setRound(next);
    void effects.playGesture(
      "Tone-map Simon sequence",
      () => playRound(next, timbre),
    ).then((completed) => {
      if (!completed) return;
      setRound((current) => reduceToneMapSimonRound(current, { type: "playback-completed" }));
    });
  };
  const transportLabel = sequenceTransportLabel(round);
  const instruction = sequenceInstruction(round);

  return (
    <Panel className="tone-map-simon" data-tone-map-challenge="simon">
      <div className="tone-map-simon__heading">
        <div>
          <Eyebrow>Sequence memory</Eyebrow>
          <h2>Hear the whole pattern. Map it back in order.</h2>
          <p>Key names stay visible for context. Sequence locations appear only after every position is committed.</p>
        </div>
        <Select
          label="Pattern length"
          value={length}
          disabled={playing || (round.answers.length > 0 && !reviewed)}
          onChange={(event) => changeLength(Number(event.target.value))}
        >
          {[2, 3, 4, 5, 6, 7, 8].map((value) => (
            <option value={value} key={value}>{value} tones</option>
          ))}
        </Select>
      </div>

      <div className="tone-map-simon__controls">
        <PlayButton
          label={transportLabel}
          aria-pressed={playing}
          disabled={reviewed}
          onClick={toggleSequencePlayback}
        />
        <div className="tone-map-simon__position" aria-label={`${round.answers.length} of ${round.sequence.length} answers entered`}>
          {round.sequence.map((_, index) => (
            <i className={index < round.answers.length ? "filled" : ""} key={index} />
          ))}
          <span>{round.answers.length}/{round.sequence.length} entered</span>
        </div>
      </div>
      <p className="tone-map-simon__instruction" data-simon-phase={round.phase} aria-live="polite">
        {instruction}
      </p>

      <PianoKeyboardViewport
        startMidi={21}
        endMidi={108}
        showLabels
        onKeyPress={answer}
        disabled={!acceptingAnswers}
        viewportAriaLabel="Full-range Simon answer keyboard"
        className="tone-map-simon__keyboard"
      />

      {grade !== null && <SequenceReview grade={grade} />}
      {grade !== null && (
        <ActionButton className="primary wide" onClick={() => startRound()}>
          Next sequence
        </ActionButton>
      )}
    </Panel>
  );
}
