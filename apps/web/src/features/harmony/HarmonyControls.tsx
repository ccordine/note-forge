import { normalizePitchClass } from "@noteforge/music-core";
import { CHORD_PRESETS, pitchClassLabel } from "@/lib/music-display";
import { Eyebrow, Panel, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import {
  chordQualitySuffix,
  HARMONY_MISSIONS,
  PROGRESSION_PRESETS,
  type MissionId,
  type ProgressionChord,
  type ProgressionPresetId,
} from "./model";

export function TonicSelect({
  tonicPitchClass,
  onChange,
}: {
  readonly tonicPitchClass: number;
  readonly onChange: (pitchClass: number) => void;
}) {
  return (
    <Select
      label="Tonic"
      value={tonicPitchClass}
      onChange={(event) => onChange(normalizePitchClass(Number(event.target.value)))}
    >
      {Array.from({ length: 12 }, (_, pitchClass) => (
        <option key={pitchClass} value={pitchClass}>{pitchClassLabel(pitchClass)}</option>
      ))}
    </Select>
  );
}

export function ProgressionSelect({
  presetId,
  onChange,
}: {
  readonly presetId: ProgressionPresetId;
  readonly onChange: (presetId: ProgressionPresetId) => void;
}) {
  return (
    <Select
      label="Progression"
      value={presetId}
      onChange={(event) => {
        if (Object.hasOwn(PROGRESSION_PRESETS, event.target.value)) {
          onChange(event.target.value as ProgressionPresetId);
        }
      }}
    >
      {Object.entries(PROGRESSION_PRESETS).map(([id, progression]) => (
        <option key={id} value={id}>{progression.label}</option>
      ))}
    </Select>
  );
}

export function MissionSelect({
  mission,
  onChange,
}: {
  readonly mission: MissionId;
  readonly onChange: (mission: MissionId) => void;
}) {
  return (
    <Select
      label="Mission"
      value={mission}
      onChange={(event) => {
        const next = HARMONY_MISSIONS.find((item) => item.id === event.target.value);
        if (next) onChange(next.id);
      }}
    >
      {HARMONY_MISSIONS.map((missionItem) => (
        <option key={missionItem.id} value={missionItem.id}>{missionItem.label}</option>
      ))}
    </Select>
  );
}

export function ProgressionTimeline({
  tonicPitchClass,
  label,
  chords,
  activeIndex,
  mission,
  onSelectChord,
  onPlayProgression,
}: {
  readonly tonicPitchClass: number;
  readonly label: string;
  readonly chords: readonly ProgressionChord[];
  readonly activeIndex: number;
  readonly mission: MissionId;
  readonly onSelectChord: (index: number, chord: ProgressionChord) => void;
  readonly onPlayProgression: () => void;
}) {
  const missionCopy = HARMONY_MISSIONS.find((item) => item.id === mission) ?? HARMONY_MISSIONS[0];
  return (
    <Panel className="progression-strip">
      <div className="progression-heading">
        <div><Eyebrow>Manual harmony clock</Eyebrow><h2>{pitchClassLabel(tonicPitchClass)} · {label}</h2></div>
        <div className="transport">
          <button onClick={() => {
            const index = Math.max(0, activeIndex - 1);
            const chord = chords[index];
            if (chord) onSelectChord(index, chord);
          }}>←</button>
          <button onClick={onPlayProgression}><Icon name="play" size={16} /></button>
          <button onClick={() => {
            const index = Math.min(chords.length - 1, activeIndex + 1);
            const chord = chords[index];
            if (chord) onSelectChord(index, chord);
          }}>→</button>
        </div>
      </div>
      <div className="chord-timeline">
        {chords.map((chord, index) => {
          const rootPitchClass = normalizePitchClass(tonicPitchClass + chord.degree);
          const pitchClasses = CHORD_PRESETS[chord.quality].intervals
            .map((interval) => normalizePitchClass(rootPitchClass + interval));
          return (
            <button
              key={`${chord.roman}-${index}`}
              className={activeIndex === index ? "active" : ""}
              onClick={() => onSelectChord(index, chord)}
            >
              <small>BAR {index + 1}</small>
              <strong>{pitchClassLabel(rootPitchClass)}{chordQualitySuffix(chord.quality)}</strong>
              <span>{chord.roman} · {pitchClasses.map(pitchClassLabel).join(" ")}</span>
              <i />
            </button>
          );
        })}
      </div>
      <div className="mission-banner">
        <Icon name="spark" size={19} />
        <span><small>CURRENT MISSION</small><b>{missionCopy.label}</b></span>
        <p>{missionCopy.detail}</p>
      </div>
    </Panel>
  );
}
