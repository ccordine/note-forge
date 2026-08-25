import { useReducer } from "react";
import { normalizePitchClass } from "@noteforge/music-core";
import { playSafely, playToneSequence } from "@/audio/synth";
import { useSustainedNote } from "@/audio/use-sustained-note";
import {
  continuousMidiToHz,
  isScalePresetId,
  noteLabel,
  pitchClassLabel,
  SCALE_PRESETS,
  type ScalePresetId,
} from "@/lib/music-display";
import type { HarmonyMode } from "@/navigation";
import { useAppNavigation } from "@/routing/use-app-navigation";
import { useMusicalState } from "@/state/MusicalContext";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NotePlaybackToggle } from "@/ui/NotePlaybackToggle";
import { CHROMATIC_SCALE_DEGREES } from "@noteforge/music-core";
import { midiNearMiddleC } from "./model";

type DegreeMode = "recognize" | "produce";

interface DegreeState {
  readonly stage: "answering" | "review";
  readonly scaleSetId: ScalePresetId;
  readonly trial: number;
  readonly answer?: number;
}

type DegreeAction =
  | Readonly<{ type: "choose"; answer: number }>
  | Readonly<{ type: "submit" }>
  | Readonly<{ type: "next"; trial: number }>
  | Readonly<{ type: "set-scale"; scaleSetId: ScalePresetId }>
  | Readonly<{ type: "reset" }>;

function randomDegree(): number {
  return Math.floor(Math.random() * 12);
}

function createDegreeState(): DegreeState {
  return { stage: "answering", scaleSetId: "major", trial: randomDegree() };
}

function reduceDegreeState(state: DegreeState, action: DegreeAction): DegreeState {
  if (action.type === "next") {
    return { ...state, stage: "answering", trial: action.trial, answer: undefined };
  }
  if (action.type === "set-scale") {
    return { ...state, stage: "answering", scaleSetId: action.scaleSetId, answer: undefined };
  }
  if (action.type === "reset") return { ...state, stage: "answering", answer: undefined };
  if (state.stage === "review") return state;
  if (action.type === "choose") return { ...state, answer: action.answer };
  if (state.answer === undefined) return state;
  return { ...state, stage: "review" };
}

function degreeButtonClass(
  offset: number,
  state: DegreeState,
): string {
  const reviewed = state.stage === "review";
  return [
    state.answer === offset && "selected",
    reviewed && state.trial === offset && "correct",
    reviewed && state.answer === offset && state.trial !== offset && "incorrect",
  ].filter(Boolean).join(" ");
}

function RecognitionAnswer({
  state,
  tonicPitchClass,
  onAction,
}: {
  readonly state: DegreeState;
  readonly tonicPitchClass: number;
  readonly onAction: (action: DegreeAction) => void;
}) {
  const scale = SCALE_PRESETS[state.scaleSetId] ?? SCALE_PRESETS.major;
  const reviewed = state.stage === "review";
  const membership = scale.intervals.includes(state.trial)
    ? `member of ${scale.label}`
    : `chromatic color against ${scale.label}`;
  return (
    <Panel className="degree-answer-card">
      <Eyebrow>Map the heard position</Eyebrow>
      <div className="degree-grid">
        {CHROMATIC_SCALE_DEGREES.map((label, offset) => (
          <button
            key={label}
            disabled={reviewed}
            className={degreeButtonClass(offset, state)}
            onClick={() => onAction({ type: "choose", answer: offset })}
          >
            <b>{label}</b>
            <span>{pitchClassLabel(tonicPitchClass + offset)}</span>
            <small>{scale.intervals.includes(offset) ? "IN SET" : "CHROMATIC"}</small>
          </button>
        ))}
      </div>
      {reviewed && (
        <div className="degree-reading">
          <span>{CHROMATIC_SCALE_DEGREES[state.trial]}</span>
          <div>
            <b>{pitchClassLabel(tonicPitchClass + state.trial)} relative to {pitchClassLabel(tonicPitchClass)}</b>
            <small>{membership}</small>
          </div>
        </div>
      )}
      <ActionButton
        className="wide primary"
        disabled={state.answer === undefined}
        onClick={() => onAction(reviewed ? { type: "next", trial: randomDegree() } : { type: "submit" })}
      >
        {reviewed ? "Next degree" : "Reveal function"}
      </ActionButton>
    </Panel>
  );
}

function ProductionAnswer({
  degree,
  tonicPitchClass,
  targetMidi,
  onNewDegree,
  onMeasure,
}: {
  readonly degree: number;
  readonly tonicPitchClass: number;
  readonly targetMidi: number;
  readonly onNewDegree: () => void;
  readonly onMeasure: (midi: number) => void;
}) {
  const { timbre } = useMusicalState();
  const tonicPlayback = useSustainedNote({
    frequencyHz: continuousMidiToHz(midiNearMiddleC(tonicPitchClass)),
    timbre,
    amplitude: 0.22,
  });
  return (
    <Panel className="degree-answer-card">
      <Eyebrow>Motor prediction mission</Eyebrow>
      <div className="degree-production">
        <span className="big-degree">{CHROMATIC_SCALE_DEGREES[degree]}</span>
        <h3>The tonic is {pitchClassLabel(tonicPitchClass)}.</h3>
        <p>Silently locate {pitchClassLabel(tonicPitchClass + degree)}, then begin directly without sliding.</p>
        <div>
          <NotePlaybackToggle
            label={pitchClassLabel(tonicPitchClass)}
            playback={tonicPlayback}
          />
          <ActionButton className="primary" onClick={() => onMeasure(targetMidi)}>
            <Icon name="mic" size={17} /> Measure the landing
          </ActionButton>
        </div>
        <button className="text-button" onClick={onNewDegree}>
          New production degree <Icon name="spark" size={14} />
        </button>
      </div>
    </Panel>
  );
}

export function ScaleDegreeActivity({ mode }: { readonly mode: Extract<HarmonyMode, "scale-degree-recognition" | "scale-degree-production"> }) {
  const { tonicPitchClass, setTonicPitchClass, timbre, setSelectedMidi } = useMusicalState();
  const { navigate } = useAppNavigation();
  const [state, dispatch] = useReducer(reduceDegreeState, undefined, createDegreeState);
  const degreeMode: DegreeMode = mode === "scale-degree-production" ? "produce" : "recognize";
  const scale = SCALE_PRESETS[state.scaleSetId] ?? SCALE_PRESETS.major;
  const targetMidi = midiNearMiddleC(tonicPitchClass) + state.trial;
  const reviewed = state.stage === "review";
  const degreeVisible = reviewed || degreeMode === "produce";

  const changeDegreeMode = (nextMode: DegreeMode) => {
    const routeMode: HarmonyMode = nextMode === "produce"
      ? "scale-degree-production"
      : "scale-degree-recognition";
    navigate({ surface: "practice", activity: "harmony", mode: routeMode });
  };

  const playContext = () => {
    const tonicMidi = midiNearMiddleC(tonicPitchClass);
    const establishment = [...scale.intervals, 12, 0].map((offset) => tonicMidi + offset);
    const notes = degreeMode === "recognize" ? [...establishment, targetMidi] : establishment;
    playSafely(playToneSequence(notes.map((midi, index) => ({
      frequencyHz: continuousMidiToHz(midi),
      timbre,
      duration: index === notes.length - 1 && degreeMode === "recognize" ? 1.05 : 0.24,
      amplitude: 0.2,
    })), { gap: 0.12 }), "Scale-degree context");
  };

  const measure = (midi: number) => {
    setSelectedMidi(midi);
    navigate({ surface: "practice", activity: "pitch-match", mode: "cold" });
  };

  const answer = degreeMode === "recognize"
    ? <RecognitionAnswer state={state} tonicPitchClass={tonicPitchClass} onAction={dispatch} />
    : (
      <ProductionAnswer
        degree={state.trial}
        tonicPitchClass={tonicPitchClass}
        targetMidi={targetMidi}
        onNewDegree={() => dispatch({ type: "next", trial: randomDegree() })}
        onMeasure={measure}
      />
    );

  return (
    <>
      <Panel className="harmony-config activity-config">
        <Segmented
          value={degreeMode}
          onChange={changeDegreeMode}
          options={[
            { value: "recognize", label: "Recognize" },
            { value: "produce", label: "Produce" },
          ]}
        />
        <div className="harmony-fields degree-fields">
          <Select
            label="Tonic"
            value={tonicPitchClass}
            onChange={(event) => {
              setTonicPitchClass(normalizePitchClass(Number(event.target.value)));
              dispatch({ type: "reset" });
            }}
          >
            {Array.from({ length: 12 }, (_, pitchClass) => (
              <option key={pitchClass} value={pitchClass}>{pitchClassLabel(pitchClass)}</option>
            ))}
          </Select>
          <Select
            label="Set"
            value={state.scaleSetId}
            onChange={(event) => {
              if (isScalePresetId(event.target.value)) {
                dispatch({ type: "set-scale", scaleSetId: event.target.value });
              }
            }}
          >
            {Object.entries(SCALE_PRESETS).map(([id, item]) => (
              <option key={id} value={id}>{item.label}</option>
            ))}
          </Select>
        </div>
      </Panel>
      <div className="scale-degree-workspace">
        <Panel className="tonal-prompt-card">
          <Eyebrow>Where is this relative to home?</Eyebrow>
          <h2>{degreeMode === "recognize" ? "Hear the degree." : `Produce degree ${CHROMATIC_SCALE_DEGREES[state.trial]}.`}</h2>
          <div className="tonal-home-map">
            <div className="home-orb">
              <small>HOME</small><strong>{pitchClassLabel(tonicPitchClass)}</strong><span>{scale.label}</span>
            </div>
            <div className="home-path"><span /><span /><span /><Icon name="arrow" size={18} /></div>
            <div className="degree-orb">
              <small>{degreeMode === "recognize" ? "HEAR" : "SING"}</small>
              <strong>{degreeVisible ? CHROMATIC_SCALE_DEGREES[state.trial] : "?"}</strong>
              <span>{reviewed ? noteLabel(targetMidi) : "relative position"}</span>
            </div>
          </div>
          <PlayButton
            label={degreeMode === "recognize" ? "Establish tonic, then play note" : "Establish tonic"}
            onClick={playContext}
          />
          <p>The cadence and scale create “home” before the chromatic degree appears. Its name is a relationship, not an isolated frequency.</p>
        </Panel>
        {answer}
      </div>
    </>
  );
}
