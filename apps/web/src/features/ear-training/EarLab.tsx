import { useState } from "react";
import "../../styles-ear.css";
import { TIMBRES, type Timbre } from "@/audio/synth";
import type { EarMode } from "@/navigation";
import { useAppNavigation } from "@/routing/use-app-navigation";
import { useMusicalState } from "@/state/MusicalContext";
import { useUserPreferences } from "@/state/UserPreferencesContext";
import { Eyebrow, Panel, Segmented, Select, Switch } from "@/ui/Controls";
import { AdvancedEarActivity } from "./AdvancedEarActivity";
import { isFoundationEarMode, type AdvancedEarMode } from "./advanced-ear-model";
import { NoteFamilyTrainer } from "./NoteFamilyTrainer";

const MODES: readonly { value: EarMode; label: string }[] = Object.freeze([
  { value: "letters", label: "Letters · fixed register" },
  { value: "reference", label: "Anchor + keyboard" },
  { value: "same-different", label: "Same / different" },
  { value: "direction", label: "Higher / lower" },
  { value: "pitch-class", label: "Chromatic · mixed register" },
  { value: "octave", label: "Octave only" },
  { value: "complete", label: "Full note" },
  { value: "family", label: "Across octaves" },
]);

interface EarIntroduction {
  readonly eyebrow: string;
  readonly title: string;
  readonly detail: string;
}

function introductionFor(mode: EarMode): EarIntroduction {
  if (mode === "letters") {
    return {
      eyebrow: "Foundation · one variable at a time",
      title: "Learn one register before anything moves.",
      detail: "The active note family never changes octave mid-drill. Every letter earns visible evidence, and moving upward is always a decision—not a surprise.",
    };
  }
  if (mode === "reference") {
    return {
      eyebrow: "Foundation · one variable at a time",
      title: "Keep the start visible while you navigate.",
      detail: "The anchor stays explicit while each comparison adds one controlled piece of evidence.",
    };
  }
  return {
    eyebrow: "Advanced recognition",
    title: "Separate identity, register, and relationship.",
    detail: "These drills intentionally vary more than one dimension. Return to fixed-register letters whenever register changes obscure the thing you are learning.",
  };
}

function FoundationPrinciple() {
  return (
    <div className="register-principle">
      <small>CURRENT RULE</small>
      <b>ONE C → B FAMILY</b>
      <span>Manual progression only</span>
    </div>
  );
}

export function EarLab() {
  const { timbre, setTimbre, setSelectedMidi } = useMusicalState();
  const { labelsHidden, setLabelsHidden } = useUserPreferences();
  const { route, navigate } = useAppNavigation();
  const mode = route.surface === "practice" && route.activity === "note-recognition"
    ? route.mode
    : "letters";
  const [crossTimbre, setCrossTimbre] = useState(false);
  const introduction = introductionFor(mode);
  const foundation = isFoundationEarMode(mode);

  const changeMode = (nextMode: EarMode) => {
    navigate({ surface: "practice", activity: "note-recognition", mode: nextMode });
  };

  let activity;
  if (foundation) {
    activity = (
      <>
        <FoundationPrinciple />
        <NoteFamilyTrainer
          mode={mode}
          timbre={timbre}
          varyTimbre={crossTimbre}
          onRevealMidi={setSelectedMidi}
        />
      </>
    );
  } else {
    activity = (
      <AdvancedEarActivity
        key={`${mode}-${crossTimbre}`}
        mode={mode as AdvancedEarMode}
        timbre={timbre}
        crossTimbre={crossTimbre}
        labelsHidden={labelsHidden}
        onRevealMidi={setSelectedMidi}
      />
    );
  }

  return (
    <div className="page ear-page">
      <div className="lab-intro">
        <div>
          <Eyebrow>{introduction.eyebrow}</Eyebrow>
          <h1>{introduction.title}</h1>
          <p>{introduction.detail}</p>
        </div>
      </div>

      <Panel className="ear-config">
        <Segmented label="Recognition drill" value={mode} onChange={changeMode} options={MODES} />
        <div className="ear-tools">
          <Select
            label="Timbre"
            value={timbre}
            onChange={(event) => setTimbre(event.target.value as Timbre)}
          >
            {TIMBRES.map((item) => <option key={item} value={item}>{item}</option>)}
          </Select>
          <Switch label="Vary timbre (advanced)" checked={crossTimbre} onChange={setCrossTimbre} />
          {!foundation && (
            <Switch label="Discovery mode" checked={labelsHidden} onChange={setLabelsHidden} />
          )}
        </div>
      </Panel>

      {activity}
    </div>
  );
}
