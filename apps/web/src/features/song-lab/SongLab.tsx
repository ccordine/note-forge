import type { ChangeEvent } from "react";
import "../../styles-song-lab.css";
import {
  MAX_LOCAL_AUDIO_DURATION_SECONDS,
  MAX_LOCAL_AUDIO_FILE_BYTES,
  formatFileSize,
} from "@/audio/local-audio-file";
import { pitchClassLabel } from "@/lib/music-display";
import { useMusicalState } from "@/state/MusicalContext";
import { ActionButton, Eyebrow, Panel, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import type {
  PracticePass,
  SongWorkspaceStage,
} from "./song-workspace";
import { useSongWorkspace } from "./use-song-workspace";

const MAX_PHRASE_TEXT_LENGTH = 500;
const AUDIO_ACCEPT = "audio/*,.mp3,.m4a,.wav,.ogg,.flac";

const PASS_COPY: Readonly<Record<PracticePass, {
  title: string;
  mission: string;
  detail: string;
}>> = Object.freeze({
  shadow: {
    title: "Shadow",
    mission: "Reproduce the original as precisely as you can.",
    detail: "Borrow timing, contour, vowel, attack, and release before analyzing.",
  },
  understand: {
    title: "Understand",
    mission: "Name the notes, movements, and chord roles.",
    detail: "Translate the heard phrase into an explicit harmonic map.",
  },
  mutate: {
    title: "Mutate",
    mission: "Sing another valid line over the same chords.",
    detail: "Keep the harmonic problem; change the melodic solution.",
  },
});
const PASS_ICONS: Readonly<Record<PracticePass, Parameters<typeof Icon>[0]["name"]>> = Object.freeze({
  shadow: "mirror",
  understand: "skills",
  mutate: "spark",
});

const STAGES: readonly { id: SongWorkspaceStage; label: string; detail: string }[] = Object.freeze([
  { id: "configure", label: "1 · Configure", detail: "Loop and describe one phrase" },
  { id: "practice", label: "2 · Practice", detail: "Listen, sing, and record" },
  { id: "review", label: "3 · Review", detail: "Compare temporary takes" },
]);

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

type Workspace = ReturnType<typeof useSongWorkspace>;

function recordingActionLabel(options: Readonly<{
  active: boolean;
  opening: boolean;
  finalizing: boolean;
  unavailable: boolean;
  unsavable: boolean;
}>): string {
  if (options.active && options.unsavable) return "Stop unsaved take";
  if (options.active) return "Stop & review take";
  if (options.opening) return "Stop opening take";
  if (options.finalizing) return "Saving take locally…";
  if (options.unavailable) return "Enable voice in header";
  return "Start voice take";
}

function FileButton({
  primary = false,
  loading,
  disabled = false,
  onChange,
}: {
  primary?: boolean;
  loading: boolean;
  disabled?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const icon = primary ? "arrow" : "song";
  let label = primary ? "Choose audio file" : "Replace local audio";
  if (loading) label = "Decoding locally…";
  return (
    <label className={`file-button ${primary ? "primary" : ""}`} aria-disabled={loading || disabled}>
      <Icon name={icon} size={18} />
      {label}
      <input type="file" accept={AUDIO_ACCEPT} disabled={loading || disabled} onChange={onChange} />
    </label>
  );
}

function SongTransport({ workspace }: { workspace: Workspace }) {
  const { state } = workspace;
  return (
    <Panel className="transport-panel song-workflow-transport">
      <div className="track-meta">
        <span className="album-placeholder"><Icon name="song" /></span>
        <div><small>LOCAL PHRASE</small><b>{state.fileName}</b><span>{formatTime(state.duration)} · never uploaded</span></div>
      </div>
      <div className="waveform" onClick={workspace.seekFromWaveform}>
        {state.peaks.map((peak, index) => {
          const sampleTime = index / state.peaks.length * state.duration;
          const inLoop = sampleTime >= state.loopStart && sampleTime <= state.loopEnd;
          return <i key={index} style={{ height: `${Math.max(5, peak * 90)}%` }} className={inLoop ? "in-loop" : ""} />;
        })}
        <span className="loop-region" style={{
          left: `${state.duration ? state.loopStart / state.duration * 100 : 0}%`,
          width: `${state.duration ? (state.loopEnd - state.loopStart) / state.duration * 100 : 0}%`,
        }} />
        <span className="song-playhead" style={{ left: `${state.duration ? state.currentTime / state.duration * 100 : 0}%` }} />
        {state.markers.map((marker, index) => (
          <span
            key={`${marker.type}-${marker.time}-${index}`}
            className={`song-marker ${marker.type}`}
            style={{ left: `${state.duration ? marker.time / state.duration * 100 : 0}%` }}
          >{marker.type === "breath" ? "B" : "P"}</span>
        ))}
      </div>
      <div className="transport-controls">
        <div className="timecode"><b>{formatTime(state.currentTime)}</b><span>/ {formatTime(state.duration)}</span></div>
        <button onClick={() => {
          const element = workspace.audioRef.current;
          if (element) element.currentTime = Math.max(state.loopStart, element.currentTime - 2);
        }}>−2</button>
        <button className="main-transport" onClick={() => void workspace.togglePlayback()} aria-label={state.playing ? "Pause phrase" : "Play phrase"}>
          <Icon name={state.playing ? "pause" : "play"} size={20} />
        </button>
        <button onClick={() => {
          const element = workspace.audioRef.current;
          if (element) element.currentTime = Math.min(state.loopEnabled ? state.loopEnd : state.duration, element.currentTime + 2);
        }}>+2</button>
        <button className={state.loopEnabled ? "loop-active" : ""} aria-pressed={state.loopEnabled} onClick={() => workspace.act({ type: "loop-toggled" })}>
          <Icon name="loop" size={17} /> LOOP
        </button>
        <div className="timecode right"><b>{formatTime(state.loopEnd - state.loopStart)}</b><span>phrase</span></div>
      </div>
      <div className="loop-handles">
        <label><span>LOOP IN</span><input type="range" min="0" max={state.duration} step=".05" value={state.loopStart} onChange={(event) => workspace.act({ type: "loop-start-changed", time: Number(event.target.value) })} /><b>{formatTime(state.loopStart)}</b></label>
        <label><span>LOOP OUT</span><input type="range" min="0" max={state.duration} step=".05" value={state.loopEnd} onChange={(event) => workspace.act({ type: "loop-end-changed", time: Number(event.target.value) })} /><b>{formatTime(state.loopEnd)}</b></label>
      </div>
    </Panel>
  );
}

function SongStageNavigation({ stage, recordingBusy, setStage }: {
  stage: SongWorkspaceStage;
  recordingBusy: boolean;
  setStage: (stage: SongWorkspaceStage) => void;
}) {
  return (
    <nav className="song-workflow-navigation" aria-label="Song practice stages">
      {STAGES.map((candidate) => (
        <button
          key={candidate.id}
          className={stage === candidate.id ? "active" : ""}
          aria-current={stage === candidate.id ? "step" : undefined}
          disabled={recordingBusy && candidate.id !== "practice"}
          onClick={() => setStage(candidate.id)}
        >
          <b>{candidate.label}</b><span>{candidate.detail}</span>
        </button>
      ))}
      {recordingBusy && (
        <p className="song-recording-invariant" role="status">
          Finish the active take before leaving Practice. Route exit stops it immediately.
        </p>
      )}
    </nav>
  );
}

function ConfigureSong({ workspace }: { workspace: Workspace }) {
  const { tonicPitchClass, setTonicPitchClass } = useMusicalState();
  const { state, act } = workspace;
  const addMarker = (type: "phrase" | "breath") => act({
    type: "marker-added",
    marker: { time: state.currentTime, type },
  });
  return (
    <section className="song-current-stage" aria-labelledby="song-configure-title">
      <div className="song-stage-heading">
        <div><Eyebrow>Current step · configure</Eyebrow><h2 id="song-configure-title">Frame one useful phrase.</h2><p>Set its loop and write only the context you actually know.</p></div>
        <ActionButton className="primary" onClick={() => workspace.setStage("practice")}>Practice this phrase <Icon name="arrow" size={16} /></ActionButton>
      </div>
      <div className="song-settings-grid">
        <Panel className="transport-settings">
          <Eyebrow>Playback</Eyebrow>
          <div>
            <Select label="Speed" value={state.speed} onChange={(event) => act({ type: "speed-changed", speed: Number(event.target.value) })}>
              <option value=".5">50%</option><option value=".65">65%</option><option value=".75">75%</option><option value=".85">85%</option><option value="1">100%</option>
            </Select>
            <Select label="Transpose preview" value={state.transpose} onChange={(event) => act({ type: "transpose-changed", semitones: Number(event.target.value) })}>
              {Array.from({ length: 13 }, (_, index) => index - 6).map((semi) => <option value={semi} key={semi}>{semi > 0 ? "+" : ""}{semi} semitones</option>)}
            </Select>
          </div>
          <small>{state.transpose === 0 ? "Pitch-preserving slow playback is used when the browser provides it." : "Transpose preview is rate-based, so it also changes speed."}</small>
        </Panel>
        <Panel className="manual-context">
          <Eyebrow>Harmonic context</Eyebrow>
          <div>
            <Select label="Known key" value={tonicPitchClass} onChange={(event) => setTonicPitchClass(Number(event.target.value))}>
              {Array.from({ length: 12 }, (_, pitchClass) => <option key={pitchClass} value={pitchClass}>{pitchClassLabel(pitchClass)}</option>)}
            </Select>
            <label className="field"><span>Chord progression</span><input value={state.chords} maxLength={MAX_PHRASE_TEXT_LENGTH} onChange={(event) => act({ type: "chords-changed", chords: event.target.value })} placeholder="C | Am | F | G" /></label>
          </div>
          <small>Manual on purpose; no fabricated chord detection.</small>
        </Panel>
        <Panel className="phrase-markers">
          <Eyebrow>Phrase notes</Eyebrow>
          <div><ActionButton onClick={() => addMarker("phrase")}>+ Phrase</ActionButton><ActionButton onClick={() => addMarker("breath")}>+ Breath</ActionButton></div>
          <label className="field"><span>Notes / degrees</span><input value={state.phraseNote} maxLength={MAX_PHRASE_TEXT_LENGTH} onChange={(event) => act({ type: "phrase-note-changed", phraseNote: event.target.value })} placeholder="3 – 2 – 1 · land on E" /></label>
          <small>{state.markers.length} markers · {state.phraseNote.length}/{MAX_PHRASE_TEXT_LENGTH} characters</small>
        </Panel>
      </div>
    </section>
  );
}

function PracticeSong({ workspace }: { workspace: Workspace }) {
  const { state, act, input } = workspace;
  const copy = PASS_COPY[state.practicePass];
  const recordingActive = state.recordingStatus === "active";
  const recordingOpening = state.recordingStatus === "opening";
  const recordingFinalizing = state.recordingStatus === "finalizing";
  const recordingUnavailable = state.recordingStatus === "idle" && input.state !== "running";
  const recordingLabel = recordingActionLabel({
    active: recordingActive,
    opening: recordingOpening,
    finalizing: recordingFinalizing,
    unavailable: recordingUnavailable,
    unsavable: state.recordError.length > 0,
  });
  const passIcon = PASS_ICONS[state.practicePass];
  return (
    <section className="song-current-stage" aria-labelledby="song-practice-title">
      <div className="song-stage-heading">
        <div><Eyebrow>Current step · practice</Eyebrow><h2 id="song-practice-title">Sing against the selected loop.</h2><p>The shared detector remains live; recording is a separate explicit local take.</p></div>
        <ActionButton disabled={state.recordingStatus !== "idle"} onClick={() => workspace.setStage("configure")}>Edit phrase</ActionButton>
      </div>
      <NoteInput variant="scope" input={input} title="Live voice coordinate" />
      <Panel className="three-passes">
        <div className="panel-heading">
          <div><Eyebrow>One phrase · one current pass</Eyebrow><h2>{copy.title}</h2></div>
          <Segmented value={state.practicePass} onChange={(pass) => act({ type: "pass-changed", pass })} options={[{ value: "shadow", label: "1 · Shadow" }, { value: "understand", label: "2 · Understand" }, { value: "mutate", label: "3 · Mutate" }]} />
        </div>
        <div className="pass-mission">
          <span className={`pass-symbol ${state.practicePass}`}><Icon name={passIcon} size={28} /></span>
          <div><small>CURRENT PASS</small><h3>{copy.mission}</h3><p>{copy.detail}</p></div>
        </div>
        <div className="record-strip">
          <div className="headphone-note"><Icon name="headphones" size={20} /><span><b>Use headphones for the backing phrase.</b><small>The microphone stream is never stopped when this take ends.</small></span></div>
          <ActionButton disabled={recordingFinalizing || recordingUnavailable} className={recordingActive ? "recording coral" : "primary"} onClick={recordingActive || recordingOpening ? workspace.stopRecording : workspace.startRecording}>
            <Icon name="record" size={17} /> {recordingLabel}
          </ActionButton>
        </div>
        {state.recordError && <div className="error-banner">{state.recordError}</div>}
      </Panel>
    </section>
  );
}

function ReviewSong({ workspace }: { workspace: Workspace }) {
  const { state } = workspace;
  return (
    <section className="song-current-stage" aria-labelledby="song-review-title">
      <div className="song-stage-heading">
        <div><Eyebrow>Current step · review</Eyebrow><h2 id="song-review-title">Compare the attempts you chose to record.</h2><p>Takes stay local to this browser and disappear when this workspace closes.</p></div>
        <ActionButton className="primary" onClick={() => workspace.setStage("practice")}>Record another take</ActionButton>
      </div>
      <Panel className="takes-panel">
        <div className="panel-heading"><div><Eyebrow>Temporary comparison</Eyebrow><h2>Voice takes</h2></div>{state.takes.length > 0 && <ActionButton onClick={workspace.clearTakes}>Clear takes</ActionButton>}</div>
        {state.takes.length > 0 ? (
          <div className="takes-list">{state.takes.map((take, index) => <div key={take.id}><span>TAKE {state.takes.length - index}</span><audio controls src={take.url} /><small>{take.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div>)}</div>
        ) : (
          <div className="song-review-empty"><Icon name="record" size={26} /><h3>No take has been recorded.</h3><p>Return to Practice when you want to create one. The live microphone does not need to reconnect.</p></div>
        )}
      </Panel>
    </section>
  );
}

export function SongLab() {
  const workspace = useSongWorkspace();
  const { state } = workspace;
  const recordingBusy = state.recordingStatus !== "idle";

  let stageView;
  if (state.stage === "configure") stageView = <ConfigureSong workspace={workspace} />;
  else if (state.stage === "practice") stageView = <PracticeSong workspace={workspace} />;
  else stageView = <ReviewSong workspace={workspace} />;

  return (
    <div className="page song-page">
      <div className="lab-intro">
        <div><Eyebrow>Local phrase workspace</Eyebrow><h1>Choose. Frame. Practice. Review.</h1><p>One retained local track, one explicit stage at a time, and one shared voice sensor.</p></div>
        {state.audioUrl && <FileButton loading={state.loadingFile} disabled={recordingBusy} onChange={workspace.loadFile} />}
      </div>

      {state.loadError && <div className="error-banner"><strong>Local audio needs attention.</strong><span>{state.loadError}</span></div>}

      {!state.audioUrl ? (
        <Panel className="song-empty">
          <div className="drop-record"><Icon name="song" size={35} /><span className="record-grooves" /></div>
          <h2>Bring one phrase, not a whole production problem.</h2>
          <p>Choose a non-empty local audio file up to {formatFileSize(MAX_LOCAL_AUDIO_FILE_BYTES)} and {formatTime(MAX_LOCAL_AUDIO_DURATION_SECONDS)}. It is decoded locally and never uploaded.</p>
          <FileButton primary loading={state.loadingFile} onChange={workspace.loadFile} />
          <div className="song-starter-steps"><span><b>01</b> configure</span><span><b>02</b> practice</span><span><b>03</b> review</span></div>
        </Panel>
      ) : (
        <div className="song-workflow-shell">
          <audio
            key={state.audioUrl}
            ref={workspace.audioRef}
            src={state.audioUrl}
            onLoadedMetadata={workspace.onMetadata}
            onTimeUpdate={workspace.onTime}
            onPlay={workspace.onPlay}
            onPause={workspace.onPause}
            onEnded={workspace.onEnded}
            onError={workspace.onAudioError}
          />
          <SongTransport workspace={workspace} />
          <SongStageNavigation
            stage={state.stage}
            recordingBusy={recordingBusy}
            setStage={workspace.setStage}
          />
          {stageView}
        </div>
      )}
    </div>
  );
}
