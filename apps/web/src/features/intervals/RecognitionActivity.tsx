import { useReducer } from "react";
import { playSafely } from "@/audio/synth";
import { INTERVAL_LONG, INTERVAL_SHORT, noteLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import type { IntervalActivityProps } from "./activity-types";
import {
  createIntervalTrial,
  createRecognitionState,
  intervalTrialNotes,
  reduceRecognitionState,
} from "./model";
import { playIntervalTrial } from "./playback";

function IntervalSteps({ semitones, revealed }: { readonly semitones: number; readonly revealed: boolean }) {
  return (
    <div className="interval-steps" aria-label={`${semitones} semitone distance`}>
      <span className="step-origin">A</span>
      {Array.from({ length: 13 }, (_, index) => (
        <i key={index} className={index <= semitones ? "filled" : ""}>
          {index === semitones && <b>B</b>}
        </i>
      ))}
      <em>{revealed ? `${semitones} semitones` : "distance hidden"}</em>
    </div>
  );
}

function answerClass(
  semitones: number,
  selected: number | undefined,
  target: number,
  reviewed: boolean,
): string {
  return [
    selected === semitones && "selected",
    reviewed && target === semitones && "correct",
    reviewed && selected === semitones && target !== semitones && "incorrect",
  ].filter(Boolean).join(" ");
}

export function RecognitionActivity({
  presentation,
  soundFirst,
  timbre,
}: IntervalActivityProps) {
  const [state, dispatch] = useReducer(
    reduceRecognitionState,
    createIntervalTrial(presentation),
    createRecognitionState,
  );
  const reviewed = state.stage === "review";
  const visible = reviewed || !soundFirst;
  const notes = intervalTrialNotes(state.trial);
  const replay = () => playSafely(playIntervalTrial(state.trial, timbre), "Interval playback");
  const correct = state.answer === state.trial.semitones;

  const completePrimaryAction = () => {
    if (reviewed) {
      dispatch({ type: "next", trial: createIntervalTrial(presentation) });
      return;
    }
    dispatch({ type: "submit" });
  };

  return (
    <div className="interval-workspace">
      <Panel className="interval-listen-card">
        <div className="trial-index">
          RELATIONSHIP {String(state.total + 1).padStart(2, "0")} <span /> {presentation}
        </div>
        <button className="interval-orb" onClick={replay} aria-label="Play interval">
          <span className="note-a">A</span>
          <i><span /><span /><span /><span /></i>
          <span className="note-b">B</span>
          <Icon name="play" size={23} />
        </button>
        <h2>{visible ? INTERVAL_LONG[state.trial.semitones] : "What did the distance feel like?"}</h2>
        <p>
          {visible
            ? `${INTERVAL_SHORT[state.trial.semitones]} · ${state.trial.semitones} semitones · ${notes.map(noteLabel).join(" → ")}`
            : "Replay it, sing it back if useful, then choose a relationship."}
        </p>
        <IntervalSteps semitones={state.trial.semitones} revealed={visible} />
        <PlayButton label="Replay" onClick={replay} />
      </Panel>

      <Panel className="interval-answer-card">
        <div className="panel-heading">
          <div><Eyebrow>Choose the relationship</Eyebrow><h2>Map one distance.</h2></div>
          <div className="interval-score">
            <span>{state.right}<small>mapped</small></span>
            <i>/</i>
            <span>{state.total}<small>attempted</small></span>
          </div>
        </div>
        <div className="interval-answer-grid">
          {Array.from({ length: 13 }, (_, semitones) => (
            <button
              key={semitones}
              className={answerClass(
                semitones,
                state.answer,
                state.trial.semitones,
                reviewed,
              )}
              disabled={reviewed}
              onClick={() => dispatch({ type: "choose", semitones })}
            >
              <span>{INTERVAL_SHORT[semitones]}</span>
              <b>{INTERVAL_LONG[semitones]}</b>
              <small>{semitones} st</small>
            </button>
          ))}
        </div>
        {reviewed && (
          <div className={`interval-result ${correct ? "correct" : "review"}`}>
            <Icon name={correct ? "spark" : "ear"} size={20} />
            <div>
              <b>
                {correct
                  ? "Distance mapped."
                  : `${INTERVAL_SHORT[state.answer ?? 0]} ↔ ${INTERVAL_SHORT[state.trial.semitones]} logged as a confusion.`}
              </b>
              <span>Now hear it once more with the name attached.</span>
            </div>
            <button onClick={replay}><Icon name="play" size={15} /></button>
          </div>
        )}
        <ActionButton
          className="wide primary"
          disabled={state.answer === undefined}
          onClick={completePrimaryAction}
        >
          {reviewed ? <>Next interval <Icon name="arrow" size={17} /></> : "Reveal relationship"}
        </ActionButton>
      </Panel>
    </div>
  );
}
