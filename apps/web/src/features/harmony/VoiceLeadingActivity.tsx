import { useMemo, useReducer } from "react";
import { playSafely } from "@/audio/synth";
import { normalizePitchClass } from "@noteforge/music-core";
import { pitchClassLabel } from "@/lib/music-display";
import { useMusicalState } from "@/state/MusicalContext";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { MissionSelect, ProgressionSelect, TonicSelect } from "./HarmonyControls";
import {
  HARMONY_MISSIONS,
  nearestVoiceLines,
  PROGRESSION_PRESETS,
  type MissionId,
  type ProgressionPresetId,
} from "./model";
import { playHarmonyProgression } from "./playback";

interface VoiceLeadingState {
  readonly presetId: ProgressionPresetId;
  readonly mission: MissionId;
}

type VoiceLeadingAction =
  | Readonly<{ type: "set-preset"; presetId: ProgressionPresetId }>
  | Readonly<{ type: "set-mission"; mission: MissionId }>;

function reduceVoiceLeadingState(
  state: VoiceLeadingState,
  action: VoiceLeadingAction,
): VoiceLeadingState {
  if (action.type === "set-preset") return { ...state, presetId: action.presetId };
  return { ...state, mission: action.mission };
}

export function VoiceLeadingActivity() {
  const { tonicPitchClass, setTonicPitchClass, timbre } = useMusicalState();
  const [state, dispatch] = useReducer(reduceVoiceLeadingState, {
    presetId: "pop",
    mission: "nearest",
  });
  const progression = PROGRESSION_PRESETS[state.presetId];
  const voiceLines = useMemo(
    () => nearestVoiceLines(progression.chords, tonicPitchClass),
    [progression.chords, tonicPitchClass],
  );

  return (
    <>
      <Panel className="harmony-config activity-config">
        <div className="harmony-fields">
          <TonicSelect tonicPitchClass={tonicPitchClass} onChange={setTonicPitchClass} />
          <ProgressionSelect
            presetId={state.presetId}
            onChange={(presetId) => dispatch({ type: "set-preset", presetId })}
          />
          <MissionSelect
            mission={state.mission}
            onChange={(mission) => dispatch({ type: "set-mission", mission })}
          />
        </div>
        <ActionButton
          onClick={() => playSafely(
            playHarmonyProgression(progression.chords, tonicPitchClass, timbre),
            "Harmony progression",
          )}
        >
          <Icon name="play" size={16} /> Play progression
        </ActionButton>
      </Panel>
      <div className="harmony-main-grid voice-leading-view">
        <Panel className="voice-map-card">
          <div className="panel-heading">
            <div><Eyebrow>Motion across changes</Eyebrow><h2>Three possible voices</h2></div>
            <span className="local-badge">nearest paths</span>
          </div>
          <svg viewBox={`0 0 ${progression.chords.length * 220} 360`} preserveAspectRatio="none">
            {[0, 1, 2].map((lineIndex) => (
              <path
                key={lineIndex}
                d={(voiceLines[lineIndex] ?? []).map((midi, index) => (
                  `${index === 0 ? "M" : "L"} ${110 + index * 220} ${320 - (midi - 48) * 10}`
                )).join(" ")}
                className={`voice-line line-${lineIndex}`}
              />
            ))}
            {(voiceLines[0] ?? []).flatMap((lowMidi, chordIndex) => {
              const chordTones = [
                lowMidi,
                voiceLines[1]?.[chordIndex] ?? lowMidi,
                voiceLines[2]?.[chordIndex] ?? lowMidi,
              ];
              return chordTones.map((midi, toneIndex) => (
                <g key={`${chordIndex}-${toneIndex}`}>
                  <circle
                    cx={110 + chordIndex * 220}
                    cy={320 - (midi - 48) * 10}
                    r="18"
                    className={`voice-node line-${toneIndex}`}
                  />
                  <text
                    x={110 + chordIndex * 220}
                    y={326 - (midi - 48) * 10}
                    textAnchor="middle"
                  >
                    {pitchClassLabel(midi)}
                  </text>
                </g>
              ));
            })}
          </svg>
          <div className="voice-chord-labels">
            {progression.chords.map((chord, index) => (
              <span key={`${chord.roman}-${index}`}>
                {chord.roman}
                <small>{pitchClassLabel(normalizePitchClass(tonicPitchClass + chord.degree))}</small>
              </span>
            ))}
          </div>
        </Panel>
        <Panel className="voice-mission-list">
          <Eyebrow>Voice-leading missions</Eyebrow>
          <h2>Change the constraint.</h2>
          {HARMONY_MISSIONS.slice(0, 5).map((mission) => (
            <button
              className={state.mission === mission.id ? "selected" : ""}
              key={mission.id}
              onClick={() => dispatch({ type: "set-mission", mission: mission.id })}
            >
              <Icon name="arrow" size={17} />
              <span><b>{mission.label}</b><small>{mission.detail}</small></span>
            </button>
          ))}
        </Panel>
      </div>
    </>
  );
}
