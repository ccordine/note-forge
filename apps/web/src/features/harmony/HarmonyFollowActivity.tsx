import { useState } from "react";
import { playSafely } from "@/audio/synth";
import { useMusicalState } from "@/state/MusicalContext";
import { Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { TonicSelect } from "./HarmonyControls";
import { FOLLOW_LINES, FOLLOW_MELODY } from "./model";
import { playHarmonyFollowLine } from "./playback";

const FIXED_THIRD = Object.freeze([3, 5, 7, 8, 10, 8, 7, 5]);
const CHORD_AWARE = Object.freeze([4, 4, 4, 5, 7, 5, 4, 4]);

function MelodyLane({
  label,
  offsets,
  variant,
}: {
  readonly label: string;
  readonly offsets: readonly number[];
  readonly variant?: "fixed" | "aware";
}) {
  return (
    <div>
      <span>{label}</span>
      {offsets.map((offset, index) => {
        let className: string | undefined;
        if (variant === "aware") className = "aware";
        else if (variant === "fixed" && index === 4) className = "clash";
        return <i key={index} className={className} style={{ transform: `translateY(${-offset * 3}px)` }} />;
      })}
    </div>
  );
}

export function HarmonyFollowActivity() {
  const { tonicPitchClass, setTonicPitchClass, timbre } = useMusicalState();
  const [selectedLine, setSelectedLine] = useState(3);

  const playLine = (index: number) => {
    setSelectedLine(index);
    playSafely(
      playHarmonyFollowLine(index, tonicPitchClass, timbre),
      "Harmony-follow example",
    );
  };

  return (
    <>
      <Panel className="harmony-config activity-config">
        <div className="harmony-fields single-field">
          <TonicSelect tonicPitchClass={tonicPitchClass} onChange={setTonicPitchClass} />
        </div>
      </Panel>
      <div className="harmony-main-grid follow-view">
        <Panel className="follow-card">
          <Eyebrow>Same melody · different rule</Eyebrow>
          <h2>Where fixed thirds break.</h2>
          <div className="melody-lanes">
            <MelodyLane label="MELODY" offsets={FOLLOW_MELODY} />
            <MelodyLane label="FIXED +3" offsets={FIXED_THIRD} variant="fixed" />
            <MelodyLane label="CHORD-AWARE" offsets={CHORD_AWARE} variant="aware" />
          </div>
          <p>A fixed interval preserves geometry. Chord-aware harmony preserves function. Hear both, then choose deliberately.</p>
        </Panel>
        <Panel className="follow-modes">
          <Eyebrow>Following constraint</Eyebrow>
          <h2>Build the second line</h2>
          {FOLLOW_LINES.map((line, index) => (
            <button
              className={selectedLine === index ? "selected" : ""}
              aria-pressed={selectedLine === index}
              key={line.label}
              onClick={() => playLine(index)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <b>{line.label}</b>
              <Icon name="play" size={16} />
            </button>
          ))}
        </Panel>
      </div>
    </>
  );
}
