import { useReducer } from "react";
import { playFrequencies, playSafely } from "@/audio/synth";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import type { MelodyActivityProps } from "./activity-types";
import { ContourGlyph } from "./ContourGlyph";
import {
  createPhraseState,
  generateMelodyPhrase,
  largestMelodyLeap,
  reducePhraseState,
} from "./model";
import { PhraseControls } from "./PhraseControls";

export function EchoActivity({
  timbre,
  rootMidi,
  labelsHidden,
  onMeasureMidi,
}: MelodyActivityProps) {
  const [state, dispatch] = useReducer(
    reducePhraseState,
    generateMelodyPhrase(4, false, rootMidi),
    createPhraseState,
  );
  const revealed = state.stage === "revealed";

  const playPhrase = () => {
    playSafely(playFrequencies(state.phrase.map(continuousMidiToHz), "sequential", {
      timbre,
      duration: 0.48,
      amplitude: 0.25,
    }), "Melody playback");
  };

  const setLength = (length: number) => {
    dispatch({
      type: "set-length",
      length,
      phrase: generateMelodyPhrase(length, state.chromatic, rootMidi),
    });
  };

  const setChromatic = (chromatic: boolean) => {
    dispatch({
      type: "set-chromatic",
      chromatic,
      phrase: generateMelodyPhrase(state.length, chromatic, rootMidi),
    });
  };

  return (
    <>
      <Panel className="melody-config activity-config">
        <PhraseControls
          length={state.length}
          chromatic={state.chromatic}
          onLengthChange={setLength}
          onChromaticChange={setChromatic}
        />
      </Panel>
      <div className="melody-grid">
        <Panel className="phrase-stage">
          <div className="trial-index">
            CALL · {state.length} NOTES <span /> {state.chromatic ? "chromatic allowed" : "diatonic"}
          </div>
          <button className="phrase-play-orb" onClick={playPhrase}>
            <Icon name="play" size={27} />
            <span>HEAR CALL</span>
          </button>
          <ContourGlyph notes={state.phrase} hidden={labelsHidden && !revealed} />
          <h2>Reproduce the phrase in one breath.</h2>
          <p>Keep the contour first. Exact centers can arrive on the next pass.</p>
          <div className="stage-actions">
            <PlayButton label="Replay call" onClick={playPhrase} />
            <ActionButton className="primary" onClick={() => onMeasureMidi(state.phrase[0] ?? rootMidi, "cold")}>
              <Icon name="mic" size={17} /> Open response mirror
            </ActionButton>
          </div>
        </Panel>
        <Panel className="phrase-variables">
          <Eyebrow>Difficulty is multidimensional</Eyebrow>
          <h2>Change one pressure.</h2>
          <div><span>Note count</span><b>{state.length}</b></div>
          <div><span>Largest leap</span><b>{largestMelodyLeap(state.phrase)} st</b></div>
          <div><span>Playback count</span><b>unlimited</b></div>
          <div><span>Starting note</span><b>{labelsHidden ? "hidden" : noteLabel(state.phrase[0] ?? rootMidi)}</b></div>
          <div><span>Key membership</span><b>{state.chromatic ? "mixed" : "major"}</b></div>
          <button className="reveal-phrase" onClick={() => dispatch({ type: "toggle-reveal" })}>
            <Icon name={revealed ? "eyeOff" : "eye"} />
            {revealed ? state.phrase.map(noteLabel).join(" · ") : "Reveal exact notes"}
          </button>
          <ActionButton
            className="wide"
            onClick={() => dispatch({
              type: "replace",
              phrase: generateMelodyPhrase(state.length, state.chromatic, rootMidi),
            })}
          >
            <Icon name="spark" size={16} /> Generate another phrase
          </ActionButton>
        </Panel>
      </div>
    </>
  );
}
