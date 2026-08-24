import { useState, type ComponentType } from "react";
import "../../styles-intervals.css";
import type { IntervalMode } from "@/navigation";
import { useAppNavigation } from "@/routing/use-app-navigation";
import { useMusicalState } from "@/state/MusicalContext";
import { Eyebrow, Panel, Segmented, Switch } from "@/ui/Controls";
import type { IntervalActivityProps } from "./activity-types";
import { ComparisonActivity } from "./ComparisonActivity";
import { MutationActivity } from "./MutationActivity";
import { ProductionActivity } from "./ProductionActivity";
import { RecognitionActivity } from "./RecognitionActivity";
import type { IntervalPresentation } from "./model";

const MODES: readonly { value: IntervalMode; label: string }[] = Object.freeze([
  { value: "recognition", label: "Recognition" },
  { value: "production", label: "Production" },
  { value: "comparison", label: "Comparison" },
  { value: "mutation", label: "Mutation" },
]);

const PRESENTATIONS: readonly { value: IntervalPresentation; label: string }[] = Object.freeze([
  { value: "ascending", label: "Ascending" },
  { value: "descending", label: "Descending" },
  { value: "harmonic", label: "Together" },
]);

const ACTIVITY_BY_MODE: Readonly<Record<IntervalMode, ComponentType<IntervalActivityProps>>> = Object.freeze({
  recognition: RecognitionActivity,
  production: ProductionActivity,
  comparison: ComparisonActivity,
  mutation: MutationActivity,
});

export function IntervalLab() {
  const { timbre, setSelectedMidi } = useMusicalState();
  const { route, navigate } = useAppNavigation();
  const mode = route.surface === "practice" && route.activity === "intervals"
    ? route.mode
    : "recognition";
  const [presentation, setPresentation] = useState<IntervalPresentation>("ascending");
  const [soundFirst, setSoundFirst] = useState(true);
  const Activity = ACTIVITY_BY_MODE[mode];

  const changeMode = (nextMode: IntervalMode) => {
    navigate({ surface: "practice", activity: "intervals", mode: nextMode });
  };

  const measureMidi = (midi: number) => {
    setSelectedMidi(midi);
    navigate({ surface: "practice", activity: "pitch-match", mode: "cold" });
  };

  return (
    <div className="page interval-page">
      <div className="lab-intro">
        <div>
          <Eyebrow>Distance is its own object</Eyebrow>
          <h1>Hear the movement before its name.</h1>
          <p>Recognize, produce, compare, and mutate intervals in separate tasks. The label can wait until the phenomenon is clear.</p>
        </div>
      </div>

      <Panel className="interval-config">
        <Segmented value={mode} onChange={changeMode} options={MODES} />
        <Segmented
          label="Presentation"
          value={presentation}
          onChange={setPresentation}
          options={PRESENTATIONS}
        />
        <Switch label="Sound first" checked={soundFirst} onChange={setSoundFirst} />
      </Panel>

      <Activity
        key={`${mode}-${presentation}`}
        presentation={presentation}
        soundFirst={soundFirst}
        timbre={timbre}
        onMeasureMidi={measureMidi}
      />
    </div>
  );
}
