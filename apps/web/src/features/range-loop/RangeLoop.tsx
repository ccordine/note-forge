import "../../styles-range-loop.css";
import { Eyebrow } from "@/ui/Controls";
import { RangeLoopStage } from "./RangeLoopStage";
import { useRangeLoopSession } from "./use-range-loop-session";

function inputStatusLabel(state: "disabled" | "opening" | "running" | "error"): string {
  if (state === "disabled") return "ENABLE VOICE IN HEADER";
  if (state === "opening") return "OPENING INPUT";
  if (state === "error") return "INPUT ERROR";
  return "TRACKING SAMPLE TIME";
}

export function RangeLoop() {
  const session = useRangeLoopSession();
  const runningClass = session.input.state === "running" ? "running" : "";
  let statusLabel = inputStatusLabel(session.input.state);
  if (!session.hydrated) statusLabel = "LOADING SAVED TARGET";
  else if (session.phase === "idle") statusLabel = "READY · PRESS START";
  else if (session.phase === "complete") statusLabel = "FINISHED · DETECTOR STILL LIVE";
  else if (session.achievementReached) statusLabel = "TARGET EARNED · STILL LIVE";
  return (
    <div className="page range-loop-page">
      <div className="lab-intro range-loop-intro">
        <div>
          <Eyebrow>One live detector · one target · sample-time dwell</Eyebrow>
          <h1>Sing the note. Stay in its lane. Move on when you choose.</h1>
          <p>The microphone remains an app-level continuous sensor. This page only decides whether each authoritative pitch interval belongs to the current target.</p>
        </div>
        <div className={`range-loop-state-pill ${runningClass}`}>
          <i />
          <div><small>RANGE LOOP</small><strong>{statusLabel}</strong></div>
        </div>
      </div>

      <RangeLoopStage session={session} />
    </div>
  );
}
