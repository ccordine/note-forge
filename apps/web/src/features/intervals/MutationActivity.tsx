import { useMemo } from "react";
import { playFrequencies, playSafely } from "@/audio/synth";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import { Eyebrow, Panel, PlayButton } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import type { IntervalActivityProps } from "./activity-types";
import { createIntervalTrial, mutationPhrase } from "./model";

const MUTATIONS = Object.freeze([
  { label: "Unchanged", detail: "Copy contour, register, and intervals", shift: 0 },
  { label: "Octave higher", detail: "Keep pitch classes and contour", shift: 12 },
  { label: "A third above", detail: "Transpose every movement by M3", shift: 4 },
]);

export function MutationActivity({ presentation, soundFirst, timbre }: IntervalActivityProps) {
  const trial = useMemo(() => createIntervalTrial(presentation), [presentation]);
  const phrase = useMemo(() => mutationPhrase(trial.start), [trial.start]);

  const playPhrase = (shift = 0) => {
    const frequencies = phrase.map((midi) => continuousMidiToHz(midi + shift));
    playSafely(playFrequencies(frequencies, "sequential", {
      timbre,
      duration: 0.46,
    }), "Interval mutation phrase");
  };

  return (
    <div className="interval-workspace mutation">
      <Panel className="mutation-phrase">
        <Eyebrow>Imitation becomes control</Eyebrow>
        <h2>Hear this gesture.</h2>
        <div className="phrase-notes">
          {phrase.map((midi, index) => (
            <span key={index} style={{ transform: `translateY(${-(midi - trial.start) * 5}px)` }}>
              {soundFirst ? "•" : noteLabel(midi)}
            </span>
          ))}
        </div>
        <PlayButton label="Play phrase" onClick={() => playPhrase()} />
      </Panel>
      <Panel className="mutation-missions">
        <Eyebrow>Now mutate it</Eyebrow>
        <h2>Preserve one thing; change another.</h2>
        {MUTATIONS.map((mission) => (
          <button key={mission.label} onClick={() => playPhrase(mission.shift)}>
            <span><b>{mission.label}</b><small>{mission.detail}</small></span>
            <Icon name="play" size={18} />
          </button>
        ))}
      </Panel>
    </div>
  );
}
