import { useEffect, useReducer } from "react";
import "../../styles-note-family.css";
import { playToneSequence, type Timbre } from "@/audio/synth";
import { useSustainedNote, type SustainedNoteControl } from "@/audio/use-sustained-note";
import {
  BRIEF_COMPARISON_SECONDS,
  useSessionEffectScope,
} from "@/features/training-session/use-session-effect-scope";
import { continuousMidiToHz, INTERVAL_LONG, noteLabel } from "@/lib/music-display";
import { getSetting, saveAttempt, setSetting } from "@/storage/database";
import { ActionButton, Eyebrow, Panel, PlayButton, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NotePlaybackToggle } from "@/ui/NotePlaybackToggle";
import { PianoKeyboard, type PianoKeyMarker } from "@/ui/PianoKeyboard";
import {
  createNoteFamilySession,
  isReferencePrompt,
  makePromptTrial,
  reduceNoteFamilySession,
  type FoundationEarMode,
  type NoteFamilySession,
  type PromptTrial,
} from "./note-family-session";
import {
  NOTE_FAMILIES,
  NOTE_LETTERS,
  getNoteFamily,
  isFamilyComplete,
  isNoteMastered,
  masteredNoteCount,
  midiForFamilyLetter,
  normalizeFamilyProgress,
  parseNoteLetterKey,
  type NoteFamilyId,
  type NoteLetter,
} from "./trials";

export type { FoundationEarMode } from "./note-family-session";

interface StoredFamilyState {
  readonly progress?: unknown;
}

interface TrainerProps {
  readonly mode: FoundationEarMode;
  readonly timbre: Timbre;
  readonly varyTimbre: boolean;
  readonly onRevealMidi: (midi: number) => void;
}

const STORAGE_KEY = "ear.note-families";

function relationshipText(anchorMidi: number, targetMidi: number): string {
  const movement = targetMidi - anchorMidi;
  if (movement === 0) return "The second tone repeated the starting tone.";
  const distance = Math.abs(movement);
  const interval = INTERVAL_LONG[distance] ?? `${distance} semitones`;
  return `${distance} semitone${distance === 1 ? "" : "s"} ${movement > 0 ? "above" : "below"} the start · ${interval}.`;
}

function answerTargetIsEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, select, textarea, button, [contenteditable='true']"));
}

function startPrompt(
  trial: Readonly<PromptTrial>,
  timbre: Timbre,
  varyTimbre: boolean,
) {
  if (isReferencePrompt(trial)) {
    return playToneSequence([
      { frequencyHz: continuousMidiToHz(trial.note.anchorMidi), timbre: varyTimbre ? trial.timbreA : timbre, duration: BRIEF_COMPARISON_SECONDS, amplitude: 0.24, gapAfter: 0.12 },
      { frequencyHz: continuousMidiToHz(trial.note.targetMidi), timbre: varyTimbre ? trial.timbreB : timbre, duration: BRIEF_COMPARISON_SECONDS, amplitude: 0.24 },
    ]);
  }
  throw new Error("A one-note prompt uses the app-owned sustained note lane.");
}

function markersFor(session: Readonly<NoteFamilySession>): PianoKeyMarker[] {
  const markers: PianoKeyMarker[] = [];
  const { trial, answerLetter, activeFamilyId } = session;
  if (isReferencePrompt(trial)) markers.push({ midi: trial.note.anchorMidi, role: "anchor", label: "starting tone" });
  if (answerLetter === null) return markers;
  const guessedMidi = midiForFamilyLetter(activeFamilyId, answerLetter);
  markers.push({
    midi: guessedMidi,
    role: answerLetter === trial.note.targetLetter ? "guess" : "wrong",
    label: answerLetter === trial.note.targetLetter ? "your correct answer" : "your answer",
  });
  markers.push({ midi: trial.note.targetMidi, role: "target", label: "correct target" });
  return markers;
}

function FamilySelector({ session, onSelect }: { session: Readonly<NoteFamilySession>; onSelect: (familyId: NoteFamilyId) => void }) {
  return (
    <Panel className="family-path" aria-label="Choose a register family">
      <div className="family-path-copy"><Eyebrow>Direct register choice</Eyebrow><b>Every family is available.</b><small>Pick the register you need. Mastery is evidence, never an unlock gate.</small></div>
      <div className="family-stages">
        {NOTE_FAMILIES.map((candidate) => {
          const complete = isFamilyComplete(session.progress[candidate.id]);
          const active = candidate.id === session.activeFamilyId;
          const mastered = masteredNoteCount(session.progress[candidate.id]);
          const status = complete ? "Complete" : active ? "Active" : "Available";
          return (
            <button key={candidate.id} type="button" className={`${active ? "active" : ""} ${complete ? "complete" : ""}`} onClick={() => onSelect(candidate.id)} aria-label={`${candidate.label} family, ${candidate.rangeLabel}, ${status}, ${mastered} of 7 stable`}>
              <span>{status}</span><strong>{candidate.label}</strong><small>{candidate.rangeLabel}</small>
              <i>{NOTE_LETTERS.map((letter) => <em key={letter} className={isNoteMastered(session.progress[candidate.id][letter]) ? "earned" : ""} />)}</i><b>{mastered}/7 stable</b>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

function PromptPanel({ session, mode, timbre, varyTimbre, playback, onAnchor, onPlay }: {
  session: Readonly<NoteFamilySession>;
  mode: FoundationEarMode;
  timbre: Timbre;
  varyTimbre: boolean;
  playback: Readonly<SustainedNoteControl>;
  onAnchor: (letter: NoteLetter) => void;
  onPlay: () => void;
}) {
  const family = getNoteFamily(session.activeFamilyId);
  return (
    <Panel className="ear-prompt-card family-prompt-card">
      <div className="trial-index">FIXED REGISTER <span /> {mode === "reference" ? "anchor comparison" : "hear + name"}</div>
      <div className="register-selection"><span><i /> SELECTED REGISTER</span><strong>{family.label} · {family.rangeLabel}</strong><small>Change it at any time from the family selector above.</small></div>
      {mode === "reference" && <Select label="Visible starting tone" value={session.anchorLetter} onChange={(event) => onAnchor(event.target.value as NoteLetter)}>{NOTE_LETTERS.map((letter) => <option key={letter} value={letter}>{letter}{family.octave}</option>)}</Select>}
      <div className="sound-orb family-sound-orb" aria-hidden="true">
        <div className="orb-ring one" /><div className="orb-ring two" /><div className="orb-ring three" /><Icon name="play" size={32} /><span>{mode === "reference" ? "TWO-TONE PROMPT" : "ONE NOTE"}</span>
      </div>
      <h2>{mode === "reference" ? `Start at ${session.anchorLetter}${family.octave}. Name the second tone.` : "Hear one note. Press its letter."}</h2>
      <p>{varyTimbre ? "The timbre may vary; the selected register does not." : `Natural notes in ${family.rangeLabel} use the selected ${timbre} timbre.`}</p>
      {mode === "reference"
        ? <PlayButton label="Play comparison" onClick={onPlay} />
        : <NotePlaybackToggle label="prompt" playback={playback} />}
    </Panel>
  );
}

function AnswerPanel({ session, mode, onAnswer, onNext }: {
  session: Readonly<NoteFamilySession>;
  mode: FoundationEarMode;
  onAnswer: (letter: NoteLetter) => void;
  onNext: () => void;
}) {
  const { trial, answerLetter, activeFamilyId, progress } = session;
  const family = getNoteFamily(activeFamilyId);
  const evidence = progress[activeFamilyId];
  const submitted = answerLetter !== null;
  const resultCorrect = submitted && answerLetter === trial.note.targetLetter;
  const targetEvidence = evidence[trial.note.targetLetter];
  const targetStreak = Math.min(targetEvidence.correctStreak, 3);
  const targetStable = isNoteMastered(targetEvidence);
  const attempts = NOTE_LETTERS.reduce((sum, letter) => sum + evidence[letter].attempts, 0);
  const correct = NOTE_LETTERS.reduce((sum, letter) => sum + evidence[letter].correct, 0);
  const resultDetail = isReferencePrompt(trial)
    ? relationshipText(trial.note.anchorMidi, trial.note.targetMidi)
    : resultCorrect ? "Letter and register agree." : `The sound was ${trial.note.targetLetter}${family.octave}.`;
  const streakDetail = resultCorrect
    ? targetStable ? "Stable now: three correct in a row." : `Current streak: ${targetStreak}/3.`
    : "This note's current streak returned to 0/3.";
  const spaceAction = mode === "reference" ? "replay" : "play / stop";

  return (
    <Panel className="answer-card family-answer-card">
      <div className="family-answer-heading"><div><Eyebrow>Your map</Eyebrow><h2>{mode === "reference" ? "The start stays visible." : "One selected C–B register."}</h2></div><span><small>ACCURACY</small><b>{attempts ? Math.round(correct / attempts * 100) : 0}%</b></span></div>
      <div className="family-keyboard-wrap">
        <PianoKeyboard startMidi={family.firstMidi} endMidi={family.lastMidi} showLabels markers={markersFor(session)} ariaLabel={`${family.label} note family keyboard from ${family.rangeLabel}`} />
        <div className="keyboard-legend">{mode === "reference" && <span className="start"><i>S</i> Starting tone</span>}{submitted && <span className="guess"><i>●</i> Your answer</span>}{submitted && <span className="target"><i>◎</i> Correct tone</span>}{!submitted && <small>The target appears after you answer.</small>}</div>
      </div>
      <div className="letter-answer-label"><div><b>Which letter did you hear?</b><small>Play or replay whenever useful, then answer directly.</small></div><span>{masteredNoteCount(evidence)}/7 stable</span></div>
      <div className="letter-answer-grid">
        {NOTE_LETTERS.map((letter) => {
          const item = evidence[letter];
          const stable = isNoteMastered(item);
          const streak = Math.min(item.correctStreak, 3);
          const target = submitted && letter === trial.note.targetLetter;
          const wrong = submitted && letter === answerLetter && !target;
          return <button key={letter} type="button" disabled={submitted} className={`${stable ? "mastered" : ""} ${target ? "correct" : ""} ${wrong ? "incorrect" : ""}`} onClick={() => onAnswer(letter)} aria-label={`Answer ${letter}; ${streak} of 3 consecutive correct`}><kbd>{letter}</kbd><span>{stable ? "STABLE · 3/3" : `${streak}/3 IN A ROW`}</span><i>{[0, 1, 2].map((index) => <em key={index} className={index < streak ? "earned" : ""} />)}</i></button>;
        })}
      </div>
      {submitted && <div className={`answer-result family-answer-result ${resultCorrect ? "correct" : "partial"}`} role="status" aria-live="polite"><Icon name={resultCorrect ? "spark" : "ear"} size={21} /><div><span>{resultCorrect ? "CORRECT MAP" : `YOU PRESSED ${answerLetter}`}</span><b>{noteLabel(trial.note.targetMidi)} · {continuousMidiToHz(trial.note.targetMidi).toFixed(2)} Hz</b><small>{resultDetail} {streakDetail}</small></div></div>}
      {isFamilyComplete(evidence) && <div className="family-complete-banner"><Icon name="spark" size={22} /><div><b>{family.label} family complete.</b><small>Every register remains selectable above; this is progress, not a gate.</small></div></div>}
      {submitted ? <ActionButton className="wide primary family-next" onClick={onNext}>Next note in {family.rangeLabel} <Icon name="arrow" size={17} /></ActionButton> : <div className="answer-shortcuts"><span><kbd>Space</kbd> {spaceAction}</span><span><kbd>A–G</kbd> answer</span><span><kbd>Enter</kbd> next</span></div>}
    </Panel>
  );
}

export function NoteFamilyTrainer({ mode, timbre, varyTimbre, onRevealMidi }: TrainerProps) {
  const [session, dispatch] = useReducer(reduceNoteFamilySession, mode, createNoteFamilySession);
  const effects = useSessionEffectScope();
  const promptPlayback = useSustainedNote({
    frequencyHz: continuousMidiToHz(session.trial.note.targetMidi),
    timbre: varyTimbre ? session.trial.timbreB : timbre,
    amplitude: 0.26,
  });

  const replaceTrial = (familyId: NoteFamilyId, anchorLetter = session.anchorLetter) => {
    effects.abort();
    const trial = makePromptTrial(mode, familyId, session.progress[familyId], anchorLetter);
    dispatch({ type: "replace-trial", activeFamilyId: familyId, anchorLetter, trial });
  };
  const playCurrentPrompt = () => {
    if (!isReferencePrompt(session.trial)) {
      promptPlayback.toggle();
      return;
    }
    effects.playGesture(
      "Note-family comparison",
      () => startPrompt(session.trial, timbre, varyTimbre),
    );
  };
  const answer = (letter: NoteLetter) => {
    if (session.answerLetter !== null) return;
    const correct = letter === session.trial.note.targetLetter;
    const completedAt = new Date().toISOString();
    dispatch({ type: "answer", letter });
    onRevealMidi(session.trial.note.targetMidi);
    void saveAttempt({
      id: crypto.randomUUID(),
      exerciseType: mode === "reference" ? "pitch.reference.fixed_family" : "pitch.absolute.letter.fixed_family",
      target: { familyId: session.activeFamilyId, midi: session.trial.note.targetMidi, letter: session.trial.note.targetLetter, anchorMidi: isReferencePrompt(session.trial) ? session.trial.note.anchorMidi : undefined },
      metrics: { correct: correct ? 1 : 0, responseTimeMs: Math.max(0, new Date(completedAt).getTime() - new Date(session.trial.startedAt).getTime()) },
      startedAt: session.trial.startedAt,
      completedAt,
    }).catch(() => dispatch({ type: "notice", message: "This attempt could not be saved to local history." }));
  };

  useEffect(() => {
    let cancelled = false;
    void getSetting<StoredFamilyState>(STORAGE_KEY)
      .then((stored) => { if (!cancelled) dispatch({ type: "hydrate", progress: normalizeFamilyProgress(stored?.progress) }); })
      .catch(() => { if (!cancelled) dispatch({ type: "storage-error", message: "Local ear-training progress could not be read." }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (session.storage.status !== "ready") return;
    void setSetting<StoredFamilyState>(STORAGE_KEY, { progress: session.progress })
      .catch(() => dispatch({ type: "storage-error", message: "Local ear-training progress could not be saved." }));
  }, [session.storage.status, session.progress]);

  useEffect(() => {
    if (session.trial.kind === mode) return;
    replaceTrial(session.activeFamilyId);
  }, [mode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (answerTargetIsEditable(event.target) || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) return;
      if (event.code === "Space") {
        event.preventDefault();
        playCurrentPrompt();
        return;
      }
      if (event.key === "Enter" && session.answerLetter !== null) {
        event.preventDefault();
        replaceTrial(session.activeFamilyId);
        return;
      }
      const letter = parseNoteLetterKey(event.key);
      if (letter) answer(letter);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <>
      {session.storage.status === "error" && <div className="error-banner"><strong>Local progress storage needs attention.</strong><span>{session.storage.message}</span></div>}
      {session.notice && <div className="error-banner"><strong>Local attempt history needs attention.</strong><span>{session.notice}</span></div>}
      <FamilySelector session={session} onSelect={replaceTrial} />
      <div className="ear-workspace family-workspace">
        <PromptPanel session={session} mode={mode} timbre={timbre} varyTimbre={varyTimbre} playback={promptPlayback} onAnchor={(letter) => replaceTrial(session.activeFamilyId, letter)} onPlay={playCurrentPrompt} />
        <AnswerPanel session={session} mode={mode} onAnswer={answer} onNext={() => replaceTrial(session.activeFamilyId)} />
      </div>
    </>
  );
}
