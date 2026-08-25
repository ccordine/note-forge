import { useMemo } from "react";
import "../../styles-range-simulator.css";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NotePlaybackToggle } from "@/ui/NotePlaybackToggle";
import { NoteInput } from "@/ui/voice";
import {
  activeRangeSimulatorTarget,
  canRateRangeProbe,
  type RangeSimulatorControllerState,
} from "./controller";
import {
  EFFORT_RATING_LABELS,
  RANGE_SIMULATOR_MAX_MIDI,
  RANGE_SIMULATOR_MIN_MIDI,
  currentRangeSimulatorProbe,
  type EffortRating,
  type ProbeDirection,
  type RangePreparation,
} from "./model";
import { summarizeRangeSimulatorSession, type RangeSimulatorSummary } from "./summary";
import {
  useRangeSimulator,
  type RangeSimulatorWorkspace,
} from "./use-range-simulator";

const RATING_VALUES = [1, 2, 3, 4, 5] as const;
const TRAINABLE_MIDIS = Array.from(
  { length: RANGE_SIMULATOR_MAX_MIDI - RANGE_SIMULATOR_MIN_MIDI + 1 },
  (_, index) => RANGE_SIMULATOR_MIN_MIDI + index,
);

function formatBounds(bounds: { lowMidi: number | null; highMidi: number | null }): string {
  if (bounds.lowMidi === null || bounds.highMidi === null) return "Not established";
  return bounds.lowMidi === bounds.highMidi
    ? noteLabel(bounds.lowMidi)
    : `${noteLabel(bounds.lowMidi)}–${noteLabel(bounds.highMidi)}`;
}

function preparationLabel(preparation: RangePreparation): string {
  switch (preparation) {
    case "unwarmed": return "No targeted warm-up";
    case "light-warmup": return "Light warm-up";
    case "warmed": return "Warmed up";
  }
}

function taskLabel(direction: ProbeDirection, kind: string): string {
  if (kind === "baseline-candidate") return "Home comparison";
  if (kind === "retest") return "Boundary recheck";
  if (direction === "ascending") return "Upper-range probe";
  if (direction === "descending") return "Lower-range probe";
  return "Home confirmation";
}

function progressLabel(state: Readonly<RangeSimulatorControllerState>): string {
  if (state.status === "complete") return "REVIEW";
  if (state.session.phase === "complete") return "MAP READY";
  if (state.session.phase === "baseline") {
    const probe = currentRangeSimulatorProbe(state.session);
    const index = probe ? state.session.baselineCandidates.indexOf(probe.midi) + 1 : 0;
    return `HOME ${Math.max(1, index)} / ${state.session.baselineCandidates.length}`;
  }
  return `PROBE ${state.session.ratedProbeCount}`;
}

function PersistenceBadge({ workspace }: { workspace: Readonly<RangeSimulatorWorkspace> }) {
  const label = !workspace.hydrated
    ? "Loading"
    : workspace.persistenceState === "saving"
      ? "Saving"
      : workspace.persistenceState === "saved"
        ? "Saved locally"
        : "Memory only";
  return (
    <span className={`range-sim-save-state ${workspace.persistenceState === "error" ? "error" : ""}`} role="status" aria-live="polite">
      {label}
    </span>
  );
}

function StartAction({ workspace }: { workspace: Readonly<RangeSimulatorWorkspace> }) {
  const { state } = workspace;
  const hasProgress = state.session.ratedProbeCount > 0;
  const configurationLocked = !workspace.hydrated || state.session.observations.length > 0;
  return (
    <div className="range-sim-action range-sim-start">
      <div>
        <Eyebrow>{hasProgress ? "Saved progress" : "Current conditions"}</Eyebrow>
        <h3>{hasProgress ? "Continue at the next note." : "Choose a comfortable starting area."}</h3>
        <p>Begin once. The shared live stream then remains authoritative while this assessment accepts its observations.</p>
      </div>
      <div className="range-sim-config">
        <Select
          label="Starting anchor"
          value={state.session.anchorMidi}
          disabled={configurationLocked}
          onChange={(event) => workspace.startFresh(Number(event.target.value), state.session.preparation)}
        >
          {TRAINABLE_MIDIS.map((midi) => <option key={midi} value={midi}>{noteLabel(midi)} · {continuousMidiToHz(midi).toFixed(1)} Hz</option>)}
        </Select>
        <Select
          label="Preparation"
          value={state.session.preparation}
          disabled={configurationLocked}
          onChange={(event) => workspace.startFresh(state.session.anchorMidi, event.target.value as RangePreparation)}
        >
          <option value="unwarmed">No targeted warm-up</option>
          <option value="light-warmup">Light warm-up</option>
          <option value="warmed">Warmed up</option>
        </Select>
      </div>
      <ActionButton className="primary wide" disabled={!workspace.hydrated} onClick={workspace.begin}>
        <Icon name="arrow" size={17} /> {hasProgress ? "Start saved assessment" : "Start assessment"}
      </ActionButton>
    </div>
  );
}

function TrackingAction({ workspace }: { workspace: Readonly<RangeSimulatorWorkspace> }) {
  const { state, input } = workspace;
  if (input.state !== "running") {
    return (
      <div className="range-sim-action range-sim-input-paused">
        <Eyebrow>Assessment time is preserved</Eyebrow>
        <h3>Voice input is currently {input.state}.</h3>
        <p>Enable voice in the header. Previously earned sample time remains intact and this target continues without restarting.</p>
      </div>
    );
  }
  return (
    <div className="range-sim-action range-sim-track">
      <div>
        <Eyebrow>Current action</Eyebrow>
        <h3>Reach {state.dwell.requiredHoldSeconds.toFixed(1)} seconds, then continue for as long as you choose.</h3>
        <p>Silence or uncertain evidence pauses current time. A reliable different pitch starts a new current hold while preserving the exact peak.</p>
      </div>
      <div className="range-sim-hold-number">
        <strong>{state.dwell.heldSeconds.toFixed(2)}</strong>
        <span>sec current · {state.dwell.peakHeldSeconds.toFixed(2)} sec peak</span>
      </div>
      <div className="range-sim-safe-exits">
        <span>Do not force the note.</span>
        <ActionButton onClick={() => workspace.chooseRating(4)}>Mark unstable</ActionButton>
        <ActionButton onClick={() => workspace.chooseRating(5)}>Can’t reliably produce</ActionButton>
      </div>
    </div>
  );
}

function RatingOption({
  value,
  selected,
  disabled,
  onChoose,
}: {
  value: EffortRating;
  selected: boolean;
  disabled: boolean;
  onChoose: (value: EffortRating) => void;
}) {
  const copy = EFFORT_RATING_LABELS[value];
  return (
    <label className={`range-rating-option rating-${value} ${disabled ? "disabled" : ""}`}>
      <input type="radio" name="range-effort-rating" value={value} checked={selected} disabled={disabled} onChange={() => onChoose(value)} />
      <strong>{value}</strong><span><b>{copy.label}</b><small>{copy.detail}</small></span>
    </label>
  );
}

function RatingAction({ workspace }: { workspace: Readonly<RangeSimulatorWorkspace> }) {
  const { state } = workspace;
  const probe = currentRangeSimulatorProbe(state.session)!;
  const holdAchievement = state.dwell.achievementReached;
  return (
    <div className="range-sim-action range-sim-rate">
      <div><Eyebrow>Pitch evidence recorded</Eyebrow><h3>How did {noteLabel(probe.midi)} feel?</h3><p>The detector confirms location; your rating reports comfort and repeatability.</p></div>
      <div className="range-rating-grid">
        {RATING_VALUES.map((value) => (
          <RatingOption key={value} value={value} selected={state.rating === value} disabled={!holdAchievement && value < 4} onChoose={workspace.chooseRating} />
        ))}
      </div>
      {probe.direction !== "center" && (
        <label className="range-sim-coordinate-check">
          <input type="checkbox" checked={state.coordinationChange} onChange={(event) => workspace.setCoordinationChange(event.target.checked)} />
          <span>I noticed a coordination/register change while moving {probe.direction === "ascending" ? "up" : "down"}.</span>
        </label>
      )}
      <div className="range-sim-action-buttons">
        <ActionButton onClick={workspace.retry}>Try this target again</ActionButton>
        <ActionButton className="primary" disabled={state.rating === null} onClick={workspace.saveRating}>Save rating &amp; next <Icon name="arrow" size={15} /></ActionButton>
      </div>
    </div>
  );
}

function AchievementAction({
  workspace,
  summary,
}: {
  workspace: Readonly<RangeSimulatorWorkspace>;
  summary: Readonly<RangeSimulatorSummary>;
}) {
  const baselineConfirmed = summary.baselineMidi !== null && summary.usableMidis.includes(summary.baselineMidi);
  return (
    <div className="range-sim-action range-sim-result" data-live-achievement="range-map">
      <div>
        <Eyebrow>Map ready · live session continues</Eyebrow>
        <h3>{baselineConfirmed ? "Today’s range map is recorded." : "No usable boundary was claimed."}</h3>
        <p>{workspace.state.notice}</p>
      </div>
      <dl className="range-sim-summary-grid">
        <div><dt>Working home</dt><dd>{summary.baselineMidi === null ? "Not established" : noteLabel(summary.baselineMidi)}</dd></div>
        <div><dt>Easy · ratings 1–2</dt><dd>{formatBounds(summary.easyBounds)}</dd></div>
        <div><dt>Usable · ratings 1–3</dt><dd>{formatBounds(summary.usableBounds)}</dd></div>
      </dl>
      <p>Keep using the live tuner for as long as you want. Only Finish today ends this assessment.</p>
      <div className="range-sim-action-buttons">
        <ActionButton onClick={workspace.recheck}>Recheck boundaries</ActionButton>
      </div>
    </div>
  );
}

function ResultAction({
  workspace,
  summary,
}: {
  workspace: Readonly<RangeSimulatorWorkspace>;
  summary: Readonly<RangeSimulatorSummary>;
}) {
  const { state } = workspace;
  const baselineConfirmed = summary.baselineMidi !== null && summary.usableMidis.includes(summary.baselineMidi);
  const latestByMidi = useMemo(() => {
    const result = new Map<number, typeof state.session.observations[number]>();
    for (const observation of state.session.observations) result.set(observation.task.midi, observation);
    return result;
  }, [state.session.observations]);
  return (
    <div className="range-sim-action range-sim-result">
      <div><Eyebrow>Today’s snapshot</Eyebrow><h3>{baselineConfirmed ? "Range map recorded." : "Assessment closed without inventing a boundary."}</h3><p>{state.notice}</p></div>
      <dl className="range-sim-summary-grid">
        <div><dt>Working home</dt><dd>{summary.baselineMidi === null ? "Not established" : noteLabel(summary.baselineMidi)}</dd></div>
        <div><dt>Easy · ratings 1–2</dt><dd>{formatBounds(summary.easyBounds)}</dd></div>
        <div><dt>Usable · ratings 1–3</dt><dd>{formatBounds(summary.usableBounds)}</dd></div>
      </dl>
      <div className="range-sim-action-buttons">
        <ActionButton className="primary" onClick={() => workspace.startFresh(summary.baselineMidi ?? state.profile.baseline.midi, state.session.preparation)}><Icon name="spark" size={15} /> New assessment</ActionButton>
        {baselineConfirmed && summary.baselineMidi !== null && <ActionButton onClick={() => workspace.openEndlessLoop(summary.baselineMidi!)}><Icon name="loop" size={15} /> Practice this map</ActionButton>}
      </div>
      <details className="range-sim-history">
        <summary>Note-by-note ratings · {latestByMidi.size} pitches</summary>
        <div>{[...latestByMidi].sort(([left], [right]) => left - right).map(([midi, observation]) => <span key={midi} className={`rating-${observation.rating}`}><b>{noteLabel(midi)}</b>{observation.rating} · {EFFORT_RATING_LABELS[observation.rating].label}</span>)}</div>
      </details>
    </div>
  );
}

function CurrentAction({
  workspace,
  summary,
}: {
  workspace: Readonly<RangeSimulatorWorkspace>;
  summary: Readonly<RangeSimulatorSummary>;
}) {
  const { state } = workspace;
  if (state.status === "complete") return <ResultAction workspace={workspace} summary={summary} />;
  if (state.status === "idle") return <StartAction workspace={workspace} />;
  if (state.session.phase === "complete") return <AchievementAction workspace={workspace} summary={summary} />;
  if (canRateRangeProbe(state)) return <RatingAction workspace={workspace} />;
  return <TrackingAction workspace={workspace} />;
}

export function RangeSimulator() {
  const workspace = useRangeSimulator();
  const { state } = workspace;
  const targetMidi = activeRangeSimulatorTarget(state);
  const probe = currentRangeSimulatorProbe(state.session);
  const summary = useMemo(() => summarizeRangeSimulatorSession(state.session), [state.session]);
  const holdStatus = state.dwell.currentInTolerance === true ? "holding" : "waiting";
  const noteInputPhase: "idle" | "listening" | "complete" = state.status === "tracking"
    ? "listening"
    : state.status;
  let shellEyebrow = "Assessment review";
  if (probe) shellEyebrow = taskLabel(probe.direction, probe.kind);
  if (!probe && state.status === "tracking") shellEyebrow = "Map achieved · live tuner";
  const shellTitle = state.status === "complete" ? "Today’s map" : `Current pitch · ${noteLabel(targetMidi)}`;
  const shellDetail = state.status === "complete"
    ? `${state.session.ratedProbeCount} ratings retained.`
    : `${continuousMidiToHz(targetMidi).toFixed(2)} Hz · ±${workspace.toleranceCents}¢ lane`;
  return (
    <div className="page range-simulator-page">
      <div className="lab-intro range-sim-intro">
        <div><Eyebrow>Continuous voice map</Eyebrow><h1>Map one honest note at a time.</h1><p>Live pitch never pauses for prompts, silence, ratings, or navigation. The assessment only derives dwell and comfort from the shared stream.</p></div>
        <div className="range-sim-status"><span>{progressLabel(state)}</span><strong>{state.status.toUpperCase()}</strong><small>{preparationLabel(state.session.preparation)} · no raw audio saved</small></div>
      </div>

      <Panel className="range-sim-shell" aria-labelledby="range-sim-target-title" data-live-lifetime="user-owned">
        <header className="range-sim-shell-header">
          <div><Eyebrow>{shellEyebrow}</Eyebrow><h2 id="range-sim-target-title">{shellTitle}</h2><p>{shellDetail}</p></div>
          <div className="range-sim-toolbar">
            <PersistenceBadge workspace={workspace} />
            <NotePlaybackToggle
              playback={workspace.referencePlayback}
              label={noteLabel(targetMidi)}
            />
            {state.status === "tracking" && <ActionButton onClick={workspace.finish}>Finish today</ActionButton>}
          </div>
        </header>

        <div className="range-sim-workspace">
          <CurrentAction workspace={workspace} summary={summary} />
          <NoteInput
            variant="target"
            input={workspace.input}
            targetMidi={targetMidi}
            toleranceCents={workspace.toleranceCents}
            phase={noteInputPhase}
            hold={{ heldSeconds: state.dwell.heldSeconds, requiredSeconds: state.dwell.requiredHoldSeconds, status: holdStatus }}
            holdMode="occupancy"
          />
        </div>

        <div className="range-sim-notice" role="status" aria-live="polite">{state.notice}</div>
        <details className="range-sim-safety"><summary>Safety and measurement contract</summary><p>Use an easy conversational sound and stop for pain, worsening discomfort, or fatigue. Silence and uncertain observations preserve earned dwell; only a credible different pitch resets it. The Play/Stop toggle is user-owned and does not change scoring state.</p></details>
      </Panel>
    </div>
  );
}
