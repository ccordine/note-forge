import { useReducer, useState } from "react";
import { playFrequencies, playSafely } from "@/audio/synth";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import type { MelodyActivityProps } from "./activity-types";
import { ContourGlyph } from "./ContourGlyph";
import {
  createPhraseState,
  generateMelodyPhrase,
  reducePhraseState,
  toggleTranscribedNote,
  transcribedNotes,
} from "./model";
import { PhraseControls } from "./PhraseControls";

const EMPTY_TRANSCRIPTION: readonly null[] = Object.freeze(Array(8).fill(null));

export function TranscribeActivity({
  timbre,
  rootMidi,
  onMeasureMidi,
}: MelodyActivityProps) {
  const [phraseState, dispatchPhrase] = useReducer(
    reducePhraseState,
    generateMelodyPhrase(4, false, rootMidi),
    createPhraseState,
  );
  const [transcription, setTranscription] = useState<readonly (number | null)[]>(EMPTY_TRANSCRIPTION);
  const revealed = phraseState.stage === "revealed";
  const notes = transcribedNotes(transcription);

  const playPhrase = (phrase: readonly number[]) => {
    playSafely(playFrequencies(phrase.map(continuousMidiToHz), "sequential", {
      timbre,
      duration: 0.48,
      amplitude: 0.25,
    }), "Melody playback");
  };

  const resetForPhrase = (action: Parameters<typeof dispatchPhrase>[0]) => {
    dispatchPhrase(action);
    setTranscription(EMPTY_TRANSCRIPTION);
  };

  return (
    <>
      <Panel className="melody-config activity-config">
        <PhraseControls
          length={phraseState.length}
          chromatic={phraseState.chromatic}
          onLengthChange={(length) => resetForPhrase({
            type: "set-length",
            length,
            phrase: generateMelodyPhrase(length, phraseState.chromatic, rootMidi),
          })}
          onChromaticChange={(chromatic) => resetForPhrase({
            type: "set-chromatic",
            chromatic,
            phrase: generateMelodyPhrase(phraseState.length, chromatic, rootMidi),
          })}
        />
      </Panel>
      <div className="transcribe-workspace">
        <Panel className="transcription-source">
          <Eyebrow>Hearing → symbols → voice</Eyebrow>
          <h2>Place what you heard.</h2>
          <PlayButton label="Play source phrase" onClick={() => playPhrase(phraseState.phrase)} />
          <ContourGlyph notes={phraseState.phrase} hidden={!revealed} />
          <button className="text-button" onClick={() => dispatchPhrase({ type: "toggle-reveal" })}>
            {revealed ? "Hide source notes" : "Reveal source after attempt"}
          </button>
          <ActionButton
            className="wide"
            onClick={() => resetForPhrase({
              type: "replace",
              phrase: generateMelodyPhrase(phraseState.length, phraseState.chromatic, rootMidi),
            })}
          >
            New source phrase
          </ActionButton>
        </Panel>
        <Panel className="piano-roll-card">
          <div className="panel-heading">
            <div><Eyebrow>Your symbolic reading</Eyebrow><h2>Eight-step piano roll</h2></div>
            <span>{notes.length}/8 placed</span>
          </div>
          <div className="mini-piano-roll">
            <div className="roll-labels">
              {Array.from({ length: 13 }, (_, row) => 72 - row).map((midi) => (
                <span key={midi}>{noteLabel(midi)}</span>
              ))}
            </div>
            <div className="roll-grid">
              {Array.from({ length: 13 }, (_, row) => 72 - row).flatMap((midi) => (
                Array.from({ length: 8 }, (_, column) => (
                  <button
                    key={`${midi}-${column}`}
                    className={transcription[column] === midi ? "active" : ""}
                    onClick={() => setTranscription((current) => (
                      toggleTranscribedNote(current, column, midi)
                    ))}
                    aria-label={`Step ${column + 1}: ${noteLabel(midi)}`}
                  />
                ))
              ))}
            </div>
          </div>
          <div className="draw-actions">
            <ActionButton disabled={notes.length === 0} onClick={() => playPhrase(notes)}>
              <Icon name="play" size={17} /> Hear transcription
            </ActionButton>
            <ActionButton
              className="primary"
              disabled={notes.length === 0}
              onClick={() => onMeasureMidi(notes[0] ?? rootMidi, "cold")}
            >
              <Icon name="mic" size={17} /> Sing what you wrote
            </ActionButton>
          </div>
        </Panel>
      </div>
    </>
  );
}
