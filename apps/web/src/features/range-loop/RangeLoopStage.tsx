import { noteLabel } from "@/lib/music-display";
import { ActionButton, Panel, PlayButton } from "@/ui/Controls";
import { NoteInput } from "@/ui/voice";
import { RangeLoopSettings } from "./RangeLoopSettings";
import type { RangeLoopSession } from "./use-range-loop-session";

function formatBounds(lowMidi: number | null, highMidi: number | null): string {
  if (lowMidi === null || highMidi === null) return "not marked yet";
  return lowMidi === highMidi
    ? noteLabel(lowMidi)
    : `${noteLabel(lowMidi)}–${noteLabel(highMidi)}`;
}

function RangeLoopToolbar({ session }: { readonly session: RangeLoopSession }) {
  return (
    <div className="range-loop-toolbar" aria-label="Range Loop controls">
      {session.input.state !== "running" && (
        <span className="range-loop-input-guidance">Enable voice in the header.</span>
      )}
      <span className="range-loop-reference-action">
        <PlayButton
          label={`Hear ${noteLabel(session.targetMidi)}`}
          onClick={session.hearReference}
        />
        <small>short reference</small>
      </span>
      <ActionButton onClick={session.resetHold}>Reset hold</ActionButton>
      {session.completed && (
        <ActionButton className="primary" onClick={session.advanceTarget}>
          Next target
        </ActionButton>
      )}
      <span className="range-loop-next">
        <small>NEXT</small>
        <b>{noteLabel(session.followingMidi)}</b>
        <em>{session.passedMidis.size}/{session.sequence.length} earned</em>
      </span>
    </div>
  );
}

function RangeLoopSequence({ session }: { readonly session: RangeLoopSession }) {
  return (
    <div
      className="range-session-family-strip"
      role="list"
      aria-label={`${session.family.label} note sequence`}
    >
      {session.sequence.map((midi) => {
        const current = midi === session.targetMidi;
        const passed = session.passedMidis.has(midi);
        const stateLabel = current ? "current target" : passed ? "earned" : "upcoming";
        return (
          <span
            role="listitem"
            key={midi}
            className={`${current ? "current" : ""} ${passed ? "passed" : ""}`}
            aria-label={`${noteLabel(midi)}, ${stateLabel}`}
          >
            <b>{noteLabel(midi)}</b><i />
          </span>
        );
      })}
    </div>
  );
}

export function RangeLoopStage({ session }: { readonly session: RangeLoopSession }) {
  const inputRunning = session.input.state === "running";
  const phase = session.completed ? "complete" : inputRunning ? "listening" : "idle";
  const holdStatus = session.completed ? "complete" : session.holding ? "holding" : "waiting";
  return (
    <Panel className={`range-loop-stage ${inputRunning ? "active" : ""}`}>
      <RangeLoopSettings session={session} />
      <RangeLoopToolbar session={session} />

      <NoteInput
        variant="target"
        input={session.input}
        targetMidi={session.targetMidi}
        toleranceCents={session.toleranceCents}
        phase={phase}
        hold={{
          heldSeconds: session.dwell.heldSeconds,
          requiredSeconds: session.holdSeconds,
          status: holdStatus,
        }}
        title={`Range Loop live target ${noteLabel(session.targetMidi)}`}
        diagnosticsFlow="range-loop"
      />

      <RangeLoopSequence session={session} />

      {session.completed && (
        <div className="range-result-next" role="status" aria-live="polite">
          <span>
            <b>{noteLabel(session.targetMidi)} held for {session.dwell.heldSeconds.toFixed(2)} seconds.</b>
            <small>The detector remains live. Next target is ready in the toolbar.</small>
          </span>
        </div>
      )}

      <div className="range-profile-notice" aria-live="polite">
        <span>
          <b>Baseline {noteLabel(session.profileBaselineMidi)}</b>
          {" · "}mapped usable range {formatBounds(session.profileLowMidi, session.profileHighMidi)}
          {" · "}shared keyboard follows this target
        </span>
      </div>

      <div className="range-session-privacy">
        One app-owned microphone stream · no raw waveform saved · silence and uncertain frames remain ordinary live observations.
      </div>
    </Panel>
  );
}
