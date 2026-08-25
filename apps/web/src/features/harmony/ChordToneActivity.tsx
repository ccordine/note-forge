import { useReducer } from "react";
import {
  analyzeHarmonicRelationship,
  buildChord,
  buildScale,
  createHarmonicContext,
  normalizePitchClass,
} from "@noteforge/music-core";
import { playSafely } from "@/audio/synth";
import { useSustainedNote } from "@/audio/use-sustained-note";
import { CHORD_PRESETS, continuousMidiToHz, noteLabel, pitchClassLabel } from "@/lib/music-display";
import { useAppNavigation } from "@/routing/use-app-navigation";
import { useMusicalState } from "@/state/MusicalContext";
import { ActionButton, Eyebrow, Panel, PlayButton } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NotePlaybackToggle } from "@/ui/NotePlaybackToggle";
import {
  MissionSelect,
  ProgressionSelect,
  ProgressionTimeline,
  TonicSelect,
} from "./HarmonyControls";
import {
  midiNearMiddleC,
  PROGRESSION_PRESETS,
  type MissionId,
  type ProgressionChord,
  type ProgressionPresetId,
} from "./model";
import { playHarmonyChord, playHarmonyProgression } from "./playback";

interface ChordToneState {
  readonly presetId: ProgressionPresetId;
  readonly activeIndex: number;
  readonly mission: MissionId;
  readonly reveal: boolean;
}

type ChordToneAction =
  | Readonly<{ type: "set-preset"; presetId: ProgressionPresetId }>
  | Readonly<{ type: "set-active"; activeIndex: number }>
  | Readonly<{ type: "set-mission"; mission: MissionId }>
  | Readonly<{ type: "toggle-reveal" }>;

function reduceChordToneState(state: ChordToneState, action: ChordToneAction): ChordToneState {
  if (action.type === "set-preset") return { ...state, presetId: action.presetId, activeIndex: 0 };
  if (action.type === "set-active") return { ...state, activeIndex: action.activeIndex };
  if (action.type === "set-mission") return { ...state, mission: action.mission };
  return { ...state, reveal: !state.reveal };
}

function createChordToneState(): ChordToneState {
  return { presetId: "pop", activeIndex: 0, mission: "nearest", reveal: true };
}

export function ChordToneActivity() {
  const {
    tonicPitchClass,
    setTonicPitchClass,
    timbre,
    selectedMidi,
    setSelectedMidi,
  } = useMusicalState();
  const { navigate } = useAppNavigation();
  const [state, dispatch] = useReducer(reduceChordToneState, undefined, createChordToneState);
  const progression = PROGRESSION_PRESETS[state.presetId];
  const active = progression.chords[state.activeIndex] ?? progression.chords[0];
  const activeRootPitchClass = normalizePitchClass(tonicPitchClass + active.degree);
  const activeChord = CHORD_PRESETS[active.quality];
  const harmonicScale = buildScale(tonicPitchClass, "major");
  const harmonicChord = buildChord(activeRootPitchClass, activeChord.quality);
  const activePitchClasses = harmonicChord.pitchClasses;
  const selectedPitchClass = normalizePitchClass(selectedMidi);
  const selectedRelationship = analyzeHarmonicRelationship(
    { pitchClass: selectedPitchClass },
    createHarmonicContext(harmonicScale, harmonicChord),
  );
  const isChordTone = selectedRelationship.chordMembership.member;
  const nearest = selectedRelationship.possibleResolutions.map((resolution) => resolution.pitchClass);
  const stabilityHeading = isChordTone
    ? "Chord tone · structurally stable"
    : "Intentional tension · asking for motion";
  const stabilityDetail = isChordTone
    ? "Reinforce the chord, linger, or use it as a landing point."
    : `Nearest stable options are ${nearest.map(pitchClassLabel).join(" or ")}. The note is not “wrong”; its continuation defines its function.`;
  const selectedNotePlayback = useSustainedNote({
    frequencyHz: continuousMidiToHz(selectedMidi),
    timbre,
    amplitude: 0.22,
  });

  const roleNotes = [
    { role: "Root", offset: 0, function: "1 · foundation" },
    {
      role: "Third",
      offset: activeChord.intervals[1] ?? 4,
      function: `${activeChord.intervals[1] === 3 ? "♭3" : "3"} · quality`,
    },
    { role: "Fifth", offset: activeChord.intervals[2] ?? 7, function: "5 · support" },
    ...(
      activeChord.intervals[3] === undefined
        ? []
        : [{
            role: "Seventh",
            offset: activeChord.intervals[3],
            function: `${activeChord.intervals[3] === 11 ? "7" : "♭7"} · color`,
          }]
    ),
    { role: "Ninth", offset: 14, function: "9 · diatonic tension" },
    { role: "♭Ninth", offset: 13, function: "♭9 · close friction" },
  ];

  const selectRole = (offset: number) => {
    const midi = midiNearMiddleC(activeRootPitchClass) + offset;
    setSelectedMidi(midi);
  };

  const selectChord = (index: number, chord: ProgressionChord) => {
    dispatch({ type: "set-active", activeIndex: index });
    playSafely(playHarmonyChord(chord, tonicPitchClass, timbre), "Chord playback");
  };

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
      </Panel>
      <ProgressionTimeline
        tonicPitchClass={tonicPitchClass}
        label={progression.label}
        chords={progression.chords}
        activeIndex={state.activeIndex}
        mission={state.mission}
        onSelectChord={selectChord}
        onPlayProgression={() => playSafely(
          playHarmonyProgression(progression.chords, tonicPitchClass, timbre),
          "Harmony progression",
        )}
      />
      <div className="harmony-main-grid">
        <Panel className="chord-orbit-card">
          <div className="panel-heading">
            <div><Eyebrow>Current sonority</Eyebrow><h2>{pitchClassLabel(activeRootPitchClass)} {activeChord.label}</h2></div>
            <PlayButton
              label="Sound chord"
              onClick={() => playSafely(
                playHarmonyChord(active, tonicPitchClass, timbre),
                "Chord playback",
              )}
            />
          </div>
          <div className="chord-orbit">
            <div className="orbit-ring outer" />
            <div className="orbit-ring inner" />
            {roleNotes.slice(0, Math.min(4, activeChord.intervals.length)).map((role, index) => {
              const angle = index * (360 / activeChord.intervals.length) - 90;
              const rolePitchClass = normalizePitchClass(activeRootPitchClass + role.offset);
              return (
                <button
                  key={role.role}
                  style={{
                    left: `${50 + 39 * Math.cos(angle * Math.PI / 180)}%`,
                    top: `${50 + 39 * Math.sin(angle * Math.PI / 180)}%`,
                  }}
                  className={selectedPitchClass === rolePitchClass ? "selected" : ""}
                  onClick={() => selectRole(role.offset)}
                >
                  <small>{role.role}</small><b>{pitchClassLabel(rolePitchClass)}</b>
                </button>
              );
            })}
            <div className="orbit-center">
              <small>ROOT</small><strong>{pitchClassLabel(activeRootPitchClass)}</strong><span>{active.roman}</span>
            </div>
          </div>
          <div className="chord-spelling">
            {activePitchClasses.map((pitchClass, index) => (
              <span key={pitchClass}>
                <small>{["ROOT", "THIRD", "FIFTH", "SEVENTH"][index]}</small>
                <b>{pitchClassLabel(pitchClass)}</b>
              </span>
            ))}
          </div>
        </Panel>
        <Panel className="role-missions-card">
          <div className="panel-heading">
            <div><Eyebrow>Choose a function</Eyebrow><h2>Sing from inside</h2></div>
            <button className="icon-button" onClick={() => dispatch({ type: "toggle-reveal" })}>
              <Icon name={state.reveal ? "eyeOff" : "eye"} />
            </button>
          </div>
          <div className="role-list">
            {roleNotes.map((role) => {
              const pitchClass = normalizePitchClass(activeRootPitchClass + role.offset);
              const inChord = activePitchClasses.includes(pitchClass);
              return (
                <button
                  key={role.role}
                  className={[
                    selectedPitchClass === pitchClass && "selected",
                    !inChord && "tension",
                  ].filter(Boolean).join(" ")}
                  onClick={() => selectRole(role.offset)}
                >
                  <span className="role-index">{pitchClassLabel(pitchClass)}</span>
                  <span><b>{role.role}</b><small>{state.reveal ? role.function : "function hidden"}</small></span>
                  <i>{inChord ? "CHORD" : "COLOR"}</i>
                </button>
              );
            })}
          </div>
          <ActionButton
            className="wide primary"
            onClick={() => navigate({ surface: "practice", activity: "pitch-match", mode: "cold" })}
          >
            <Icon name="mic" size={17} /> Measure {noteLabel(selectedMidi)} in Pitch Mirror
          </ActionButton>
        </Panel>
        <Panel className="selected-function-card">
          <Eyebrow>Selected note in context</Eyebrow>
          <div className="function-note">
            <strong>{pitchClassLabel(selectedPitchClass)}</strong>
            <span>over</span>
            <b>{pitchClassLabel(activeRootPitchClass)} {activeChord.label.toLowerCase()}</b>
          </div>
          <NotePlaybackToggle
            label={noteLabel(selectedMidi)}
            playback={selectedNotePlayback}
          />
          <h2>{stabilityHeading}</h2>
          <p>{stabilityDetail}</p>
          <div className="resolution-route">
            <span>{pitchClassLabel(selectedPitchClass)}</span><i>→</i>
            {nearest.map((pitchClass) => (
              <button
                key={pitchClass}
                onClick={() => selectRole(normalizePitchClass(pitchClass - activeRootPitchClass))}
              >
                {pitchClassLabel(pitchClass)}
              </button>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
