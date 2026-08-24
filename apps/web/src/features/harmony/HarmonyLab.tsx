import type { HarmonyMode } from "@/navigation";
import "../../styles-scale.css";
import "../../styles-harmony.css";
import { useAppNavigation } from "@/routing/use-app-navigation";
import { Eyebrow, Panel, Segmented } from "@/ui/Controls";
import { ChordToneActivity } from "./ChordToneActivity";
import { HarmonyFollowActivity } from "./HarmonyFollowActivity";
import {
  defaultModeForHarmonyView,
  harmonyView,
  type HarmonyView,
} from "./model";
import { ScaleDegreeActivity } from "./ScaleDegreeActivity";
import { VoiceLeadingActivity } from "./VoiceLeadingActivity";

const VIEWS: readonly { value: HarmonyView; label: string }[] = Object.freeze([
  { value: "scaleDegree", label: "Scale degrees" },
  { value: "chordTone", label: "Chord tones" },
  { value: "voiceLeading", label: "Voice leading" },
  { value: "harmonyFollow", label: "Harmony following" },
]);

function activityFor(mode: HarmonyMode) {
  if (mode === "scale-degree-recognition" || mode === "scale-degree-production") {
    return <ScaleDegreeActivity key={mode} mode={mode} />;
  }
  if (mode === "voice-leading") return <VoiceLeadingActivity key={mode} />;
  if (mode === "harmony-follow") return <HarmonyFollowActivity key={mode} />;
  return <ChordToneActivity key={mode} />;
}

export function HarmonyLab() {
  const { route, navigate } = useAppNavigation();
  const mode = route.surface === "practice" && route.activity === "harmony"
    ? route.mode
    : "chord-tone";
  const view = harmonyView(mode);

  const changeView = (nextView: HarmonyView) => {
    navigate({ surface: "practice", activity: "harmony", mode: defaultModeForHarmonyView(nextView) });
  };

  return (
    <div className="page harmony-page">
      <div className="lab-intro">
        <div>
          <Eyebrow>Function changes the meaning</Eyebrow>
          <h1>Stand inside the chord.</h1>
          <p>The same note can be home, support, shared glue, diatonic tension, or deliberate abrasion. Practice choosing the role.</p>
        </div>
      </div>

      <Panel className="harmony-config mode-selector">
        <Segmented value={view} onChange={changeView} options={VIEWS} />
      </Panel>

      {activityFor(mode)}
    </div>
  );
}
