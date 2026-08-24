import { useReducer } from "react";
import { playSafely } from "@/audio/synth";
import { INTERVAL_SHORT } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import type { IntervalActivityProps } from "./activity-types";
import {
  comparisonResult,
  createComparisonState,
  createIntervalTrial,
  reduceComparisonState,
  type ComparisonAnswer,
  type IntervalTrial,
} from "./model";
import { playIntervalComparison, playIntervalTrial } from "./playback";

const CHOICES: readonly { value: ComparisonAnswer; label: string }[] = Object.freeze([
  { value: "a", label: "A is wider" },
  { value: "same", label: "Identical" },
  { value: "b", label: "B is wider" },
]);

function newComparison(presentation: IntervalActivityProps["presentation"]): readonly [IntervalTrial, IntervalTrial] {
  return [createIntervalTrial(presentation), createIntervalTrial(presentation)];
}

export function ComparisonActivity({
  presentation,
  soundFirst,
  timbre,
}: IntervalActivityProps) {
  const [state, dispatch] = useReducer(
    reduceComparisonState,
    newComparison(presentation),
    ([a, b]) => createComparisonState(a, b),
  );
  const reviewed = state.stage === "review";
  const correct = comparisonResult(state.a, state.b);
  const labelsVisible = reviewed || !soundFirst;

  const completePrimaryAction = () => {
    if (reviewed) {
      const [a, b] = newComparison(presentation);
      dispatch({ type: "next", a, b });
      return;
    }
    dispatch({ type: "submit" });
  };

  return (
    <div className="interval-workspace comparison">
      <Panel className="comparison-card">
        <Eyebrow>Two candidate movements</Eyebrow>
        <h2>Which distance is wider?</h2>
        <div className="candidate-intervals">
          <button onClick={() => playSafely(playIntervalTrial(state.a, timbre), "Interval A")}>
            <span>A</span>
            <i>{labelsVisible ? INTERVAL_SHORT[state.a.semitones] : "?"}</i>
            <Icon name="play" />
          </button>
          <b>versus</b>
          <button onClick={() => playSafely(playIntervalTrial(state.b, timbre), "Interval B")}>
            <span>B</span>
            <i>{labelsVisible ? INTERVAL_SHORT[state.b.semitones] : "?"}</i>
            <Icon name="play" />
          </button>
        </div>
        <ActionButton
          className="wide"
          onClick={() => playSafely(
            playIntervalComparison(state.a, state.b, timbre),
            "Interval comparison",
          )}
        >
          Play A, then B
        </ActionButton>
      </Panel>
      <Panel className="comparison-answer">
        <Eyebrow>Your comparison</Eyebrow>
        <div className="wide-choice">
          {CHOICES.map((choice) => (
            <button
              key={choice.value}
              className={[
                state.answer === choice.value && "selected",
                reviewed && correct === choice.value && "correct",
              ].filter(Boolean).join(" ")}
              disabled={reviewed}
              onClick={() => dispatch({ type: "choose", answer: choice.value })}
            >
              {choice.label}
            </button>
          ))}
        </div>
        {reviewed && (
          <div className="comparison-reveal">
            <b>{INTERVAL_SHORT[state.a.semitones]} · {state.a.semitones} st</b>
            <span>versus</span>
            <b>{INTERVAL_SHORT[state.b.semitones]} · {state.b.semitones} st</b>
          </div>
        )}
        <ActionButton
          className="wide primary"
          disabled={state.answer === undefined}
          onClick={completePrimaryAction}
        >
          {reviewed ? "Next comparison" : "Reveal distances"}
        </ActionButton>
      </Panel>
    </div>
  );
}
