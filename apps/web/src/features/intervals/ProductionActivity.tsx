import { useEffect, useRef, useState } from "react";
import { useSustainedNote } from "@/audio/use-sustained-note";
import { continuousMidiToHz, INTERVAL_LONG, INTERVAL_SHORT, noteLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NotePlaybackToggle } from "@/ui/NotePlaybackToggle";
import type { IntervalActivityProps } from "./activity-types";
import { createIntervalTrial, intervalTrialNotes } from "./model";

export function ProductionActivity({
  presentation,
  soundFirst,
  timbre,
  onMeasureMidi,
}: IntervalActivityProps) {
  const [trial, setTrial] = useState(() => createIntervalTrial(presentation));
  const [revealed, setRevealed] = useState(false);
  const previousPresentation = useRef(presentation);
  const notes = intervalTrialNotes(trial);
  const directionWord = presentation === "descending" ? "below" : "above";
  const directionGlyph = presentation === "descending" ? "↓" : "↑";
  const startPlayback = useSustainedNote({
    frequencyHz: continuousMidiToHz(notes[0]),
    timbre,
    amplitude: 0.22,
  });

  useEffect(() => {
    if (previousPresentation.current === presentation) return;
    previousPresentation.current = presentation;
    setTrial(createIntervalTrial(presentation));
    setRevealed(false);
  }, [presentation]);

  const newMission = () => {
    setTrial(createIntervalTrial(presentation));
    setRevealed(false);
  };

  return (
    <div className="interval-workspace production">
      <Panel className="production-mission">
        <div className="mission-number">PRODUCTION MISSION</div>
        <div className="start-note-disc">
          <small>START</small>
          <strong>{soundFirst ? "•" : noteLabel(notes[0])}</strong>
        </div>
        <div className="mission-arrow">
          <span>{directionGlyph}</span>
          <small>{trial.semitones} semitones</small>
        </div>
        <div className="target-note-disc">
          <small>SING</small>
          <strong>{INTERVAL_SHORT[trial.semitones]}</strong>
          <span>{presentation}</span>
        </div>
        <h2>Sing a {INTERVAL_LONG[trial.semitones]} {directionWord}.</h2>
        <p>Only the starting note sounds. Predict the second pitch, silently configure, then produce.</p>
        <div className="production-actions">
          <NotePlaybackToggle
            label={soundFirst ? "start" : noteLabel(notes[0])}
            playback={startPlayback}
          />
          <ActionButton className="primary" onClick={() => onMeasureMidi(notes[1])}>
            <Icon name="mic" size={18} /> Measure in Pitch Mirror
          </ActionButton>
          <ActionButton onClick={newMission}>New mission</ActionButton>
        </div>
      </Panel>
      <Panel className="production-map">
        <Eyebrow>After you produce</Eyebrow>
        <h2>Reveal the landing coordinate</h2>
        <p>The interval score belongs to the distance between both produced centers, so two sharp notes can still describe an accurate interval.</p>
        <button className="reveal-landing" onClick={() => setRevealed((current) => !current)}>
          <Icon name={revealed ? "eyeOff" : "eye"} />
          {revealed
            ? <><b>{noteLabel(notes[1])}</b><span>{continuousMidiToHz(notes[1]).toFixed(2)} Hz</span></>
            : <span>Reveal landing note</span>}
        </button>
        <div className="formula-card">
          <span>Δ actual</span>
          <b>1200 log₂ (f₂ / f₁)</b>
          <small>continuous cents · no early snapping</small>
        </div>
      </Panel>
    </div>
  );
}
