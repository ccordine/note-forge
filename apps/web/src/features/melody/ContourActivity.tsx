import { useReducer } from "react";
import { playFrequencies, playSafely } from "@/audio/synth";
import { continuousMidiToHz } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton } from "@/ui/Controls";
import type { MelodyActivityProps } from "./activity-types";
import { ContourGlyph } from "./ContourGlyph";
import {
  contourDirections,
  createContourState,
  MELODY_SHAPES,
  nextShapeIndex,
  reduceContourState,
} from "./model";

export function ContourActivity({ timbre, rootMidi }: MelodyActivityProps) {
  const [state, dispatch] = useReducer(reduceContourState, 0, createContourState);
  const reviewed = state.stage === "review";
  const activeShape = MELODY_SHAPES[state.shapeIndex] ?? MELODY_SHAPES[0];
  const notes = activeShape.offsets.map((offset) => rootMidi + offset);

  const playContour = () => {
    playSafely(playFrequencies(notes.map(continuousMidiToHz), "sequential", {
      timbre,
      duration: 0.48,
      amplitude: 0.25,
    }), "Melody contour");
  };

  const completePrimaryAction = () => {
    if (reviewed) {
      dispatch({ type: "next", shapeIndex: nextShapeIndex(state.shapeIndex) });
      return;
    }
    dispatch({ type: "reveal" });
  };

  return (
    <div className="melody-grid contour-mode">
      <Panel className="contour-prompt">
        <Eyebrow>Labels removed</Eyebrow>
        <h2>Which shape moved?</h2>
        <div className="abstract-contour"><ContourGlyph notes={notes} hidden /></div>
        <PlayButton label="Hear contour" onClick={playContour} />
        <p>Track sameness, direction, and relative leap size before exact pitch.</p>
      </Panel>
      <Panel className="shape-answers">
        <Eyebrow>Choose the gesture</Eyebrow>
        {MELODY_SHAPES.map((shape, index) => (
          <button
            key={shape.label}
            className={[
              state.answer === index && "selected",
              reviewed && state.shapeIndex === index && "correct",
            ].filter(Boolean).join(" ")}
            disabled={reviewed}
            onClick={() => dispatch({ type: "choose", answer: index })}
          >
            <span>{contourDirections(shape)}</span>
            <b>{shape.label}</b>
          </button>
        ))}
        <ActionButton
          className="wide primary"
          disabled={state.answer === undefined}
          onClick={completePrimaryAction}
        >
          {reviewed ? "Next contour" : "Reveal shape"}
        </ActionButton>
      </Panel>
    </div>
  );
}
