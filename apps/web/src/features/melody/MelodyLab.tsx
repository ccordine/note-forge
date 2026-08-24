import type { ComponentType } from "react";
import "../../styles-melody.css";
import type { MelodyMode, MirrorMode } from "@/navigation";
import { useAppNavigation } from "@/routing/use-app-navigation";
import { useMusicalState } from "@/state/MusicalContext";
import { useUserPreferences } from "@/state/UserPreferencesContext";
import { Eyebrow, Panel, Segmented, Switch } from "@/ui/Controls";
import type { MelodyActivityProps } from "./activity-types";
import { ContourActivity } from "./ContourActivity";
import { DrawActivity } from "./DrawActivity";
import { EchoActivity } from "./EchoActivity";
import { TranscribeActivity } from "./TranscribeActivity";

const MODES: readonly { value: MelodyMode; label: string }[] = Object.freeze([
  { value: "echo", label: "Call & response" },
  { value: "contour", label: "Contour" },
  { value: "draw", label: "Pitch drawing" },
  { value: "transcribe", label: "Transcription" },
]);

const ACTIVITY_BY_MODE: Readonly<Record<MelodyMode, ComponentType<MelodyActivityProps>>> = Object.freeze({
  echo: EchoActivity,
  contour: ContourActivity,
  draw: DrawActivity,
  transcribe: TranscribeActivity,
});

export function MelodyLab() {
  const { timbre, tonicPitchClass, setSelectedMidi } = useMusicalState();
  const { labelsHidden, setLabelsHidden } = useUserPreferences();
  const { route, navigate } = useAppNavigation();
  const mode = route.surface === "practice" && route.activity === "melody"
    ? route.mode
    : "echo";
  const Activity = ACTIVITY_BY_MODE[mode];
  const rootMidi = 60 + tonicPitchClass;

  const changeMode = (nextMode: MelodyMode) => {
    navigate({ surface: "practice", activity: "melody", mode: nextMode });
  };

  const measureMidi = (midi: number, mirrorMode: MirrorMode) => {
    setSelectedMidi(midi);
    navigate({ surface: "practice", activity: "pitch-match", mode: mirrorMode });
  };

  return (
    <div className="page melody-page">
      <div className="lab-intro">
        <div>
          <Eyebrow>Shape → notes → embodied phrase</Eyebrow>
          <h1>Hold a gesture long enough to change it.</h1>
          <p>Echo exact pitches, isolate contour, draw a continuous vocal path, or turn hearing into a piano-roll plan.</p>
        </div>
        <Switch label="Hide note labels" checked={labelsHidden} onChange={setLabelsHidden} />
      </div>

      <Panel className="melody-config mode-selector">
        <Segmented value={mode} onChange={changeMode} options={MODES} />
      </Panel>

      <Activity
        key={mode}
        timbre={timbre}
        rootMidi={rootMidi}
        labelsHidden={labelsHidden}
        onMeasureMidi={measureMidi}
      />
    </div>
  );
}
