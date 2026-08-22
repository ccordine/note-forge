import { useCallback, useEffect, useMemo, useState } from "react";
import { playTone, playToneSequence, TIMBRES, type Timbre } from "@/audio/synth";
import { continuousMidiToHz, INTERVAL_LONG, noteLabel } from "@/lib/music-display";
import { saveAttempt, getSetting, setSetting } from "@/storage/database";
import { ActionButton, Eyebrow, Panel, PlayButton, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { PianoKeyboard, type PianoKeyMarker } from "@/ui/PianoKeyboard";
import {
  NOTE_FAMILIES,
  NOTE_LETTERS,
  createEmptyNoteFamilyProgress,
  createNoteFamilyTrial,
  createReferenceTrial,
  getNoteFamily,
  getUnlockedFamilyIds,
  isFamilyComplete,
  isFamilyUnlocked,
  masteredNoteCount,
  midiForFamilyLetter,
  parseNoteLetterKey,
  recordNoteAttempt,
  type FamilyEvidence,
  type NoteFamilyId,
  type NoteFamilyProgress,
  type NoteFamilyTrial,
  type NoteLetter,
  type ReferenceTrial
} from "./trials";

export type FoundationEarMode = "letters" | "reference";

interface StoredFamilyState {
  version: 1;
  activeFamilyId: NoteFamilyId;
  progress: NoteFamilyProgress;
}

interface PromptTrial {
  kind: FoundationEarMode;
  note: NoteFamilyTrial | ReferenceTrial;
  timbreA: Timbre;
  timbreB: Timbre;
  startedAt: string;
}

const STORAGE_KEY = "ear.note-families.v1";

function randomTimbre(): Timbre {
  return TIMBRES[Math.floor(Math.random() * TIMBRES.length)] ?? "sine";
}

function makePromptTrial(
  kind: FoundationEarMode,
  familyId: NoteFamilyId,
  evidence: Readonly<FamilyEvidence>,
  anchorLetter: NoteLetter
): PromptTrial {
  const timbreA = randomTimbre();
  return {
    kind,
    note: kind === "reference"
      ? createReferenceTrial(familyId, { anchorLetter, evidence, allowSame: true })
      : createNoteFamilyTrial(familyId, Math.random, evidence),
    timbreA,
    timbreB: randomTimbre(),
    startedAt: new Date().toISOString()
  };
}

function isReferencePrompt(trial: PromptTrial): trial is PromptTrial & { note: ReferenceTrial } {
  return trial.kind === "reference";
}

function normalizeProgress(candidate?: Partial<NoteFamilyProgress>): NoteFamilyProgress {
  const result = createEmptyNoteFamilyProgress();
  for (const family of NOTE_FAMILIES) {
    for (const letter of NOTE_LETTERS) {
      const stored = candidate?.[family.id]?.[letter];
      if (!stored) continue;
      const attempts = Number.isFinite(stored.attempts) ? Math.max(0, Math.floor(stored.attempts)) : 0;
      const correct = Number.isFinite(stored.correct) ? Math.max(0, Math.min(attempts, Math.floor(stored.correct))) : 0;
      result[family.id][letter] = { attempts, correct, mastered: stored.mastered === true };
    }
  }
  return result;
}

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

export function NoteFamilyTrainer({
  mode,
  timbre,
  varyTimbre,
  onRevealMidi
}: {
  mode: FoundationEarMode;
  timbre: Timbre;
  varyTimbre: boolean;
  onRevealMidi: (midi: number) => void;
}) {
  const [progress, setProgress] = useState<NoteFamilyProgress>(createEmptyNoteFamilyProgress);
  const [activeFamilyId, setActiveFamilyId] = useState<NoteFamilyId>("low");
  const [anchorLetter, setAnchorLetter] = useState<NoteLetter>("A");
  const [trial, setTrial] = useState<PromptTrial>(() => makePromptTrial("letters", "low", createEmptyNoteFamilyProgress().low, "A"));
  const [answerLetter, setAnswerLetter] = useState<NoteLetter>();
  const [submitted, setSubmitted] = useState(false);
  const [heardCurrent, setHeardCurrent] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const family = getNoteFamily(activeFamilyId);
  const evidence = progress[activeFamilyId];
  const familyComplete = isFamilyComplete(evidence);
  const unlockedFamilyIds = getUnlockedFamilyIds(progress);
  const currentFamilyIndex = NOTE_FAMILIES.findIndex((candidate) => candidate.id === activeFamilyId);
  const nextFamily = NOTE_FAMILIES[currentFamilyIndex + 1];

  const resetTrial = useCallback((nextMode: FoundationEarMode, familyId: NoteFamilyId, nextAnchor = anchorLetter, nextProgress = progress) => {
    const next = makePromptTrial(nextMode, familyId, nextProgress[familyId], nextAnchor);
    setTrial(next);
    setAnswerLetter(undefined);
    setSubmitted(false);
    setHeardCurrent(false);
    return next;
  }, [anchorLetter, progress]);

  const playPrompt = useCallback((prompt = trial) => {
    if (!hydrated) return;
    setHeardCurrent(true);
    if (isReferencePrompt(prompt)) {
      void playToneSequence([
        {
          frequencyHz: continuousMidiToHz(prompt.note.anchorMidi),
          timbre: varyTimbre ? prompt.timbreA : timbre,
          duration: 0.82,
          amplitude: 0.24,
          gapAfter: 0.24
        },
        {
          frequencyHz: continuousMidiToHz(prompt.note.targetMidi),
          timbre: varyTimbre ? prompt.timbreB : timbre,
          duration: 0.92,
          amplitude: 0.24
        }
      ]);
    } else {
      void playTone({
        frequencyHz: continuousMidiToHz(prompt.note.targetMidi),
        timbre: varyTimbre ? prompt.timbreB : timbre,
        duration: 1.05,
        amplitude: 0.26
      });
    }
  }, [hydrated, timbre, trial, varyTimbre]);

  useEffect(() => {
    let cancelled = false;
    void getSetting<StoredFamilyState>(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        const restoredProgress = normalizeProgress(stored?.progress);
        const requestedFamily = stored?.activeFamilyId;
        const restoredFamily = requestedFamily && isFamilyUnlocked(requestedFamily, restoredProgress) ? requestedFamily : "low";
        setProgress(restoredProgress);
        setActiveFamilyId(restoredFamily);
        setTrial(makePromptTrial(mode, restoredFamily, restoredProgress[restoredFamily], anchorLetter));
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void setSetting<StoredFamilyState>(STORAGE_KEY, {
      version: 1,
      activeFamilyId,
      progress
    }).catch(() => undefined);
  }, [activeFamilyId, hydrated, progress]);

  useEffect(() => {
    if (!hydrated || trial.kind === mode) return;
    resetTrial(mode, activeFamilyId);
  }, [activeFamilyId, hydrated, mode, resetTrial, trial.kind]);

  const commitLetter = useCallback((letter: NoteLetter) => {
    if (!hydrated || !heardCurrent || submitted) return;
    const correct = letter === trial.note.targetLetter;
    const completedAt = new Date();
    setAnswerLetter(letter);
    setSubmitted(true);
    onRevealMidi(trial.note.targetMidi);
    setProgress((current) => ({
      ...current,
      [activeFamilyId]: recordNoteAttempt(current[activeFamilyId], trial.note.targetLetter, correct)
    }));
    void saveAttempt({
      id: crypto.randomUUID(),
      exerciseType: mode === "reference" ? "pitch.reference.fixed_family" : "pitch.absolute.letter.fixed_family",
      target: {
        familyId: activeFamilyId,
        midi: trial.note.targetMidi,
        letter: trial.note.targetLetter,
        anchorMidi: isReferencePrompt(trial) ? trial.note.anchorMidi : undefined
      },
      metrics: {
        correct: correct ? 1 : 0,
        responseTimeMs: Math.max(0, completedAt.getTime() - new Date(trial.startedAt).getTime())
      },
      startedAt: trial.startedAt,
      completedAt: completedAt.toISOString()
    }).catch(() => undefined);
  }, [activeFamilyId, heardCurrent, hydrated, mode, onRevealMidi, submitted, trial]);

  const advanceAndPlay = useCallback(() => {
    const next = resetTrial(mode, activeFamilyId);
    setHeardCurrent(true);
    if (isReferencePrompt(next)) {
      void playToneSequence([
        { frequencyHz: continuousMidiToHz(next.note.anchorMidi), timbre: varyTimbre ? next.timbreA : timbre, duration: 0.82, amplitude: 0.24, gapAfter: 0.24 },
        { frequencyHz: continuousMidiToHz(next.note.targetMidi), timbre: varyTimbre ? next.timbreB : timbre, duration: 0.92, amplitude: 0.24 }
      ]);
    } else {
      void playTone({ frequencyHz: continuousMidiToHz(next.note.targetMidi), timbre: varyTimbre ? next.timbreB : timbre, duration: 1.05, amplitude: 0.26 });
    }
  }, [activeFamilyId, mode, resetTrial, timbre, varyTimbre]);

  const selectFamily = useCallback((familyId: NoteFamilyId) => {
    if (!isFamilyUnlocked(familyId, progress)) return;
    setActiveFamilyId(familyId);
    const next = resetTrial(mode, familyId);
    setHeardCurrent(true);
    if (isReferencePrompt(next)) {
      void playToneSequence([
        { frequencyHz: continuousMidiToHz(next.note.anchorMidi), timbre: varyTimbre ? next.timbreA : timbre, duration: 0.82, amplitude: 0.24, gapAfter: 0.24 },
        { frequencyHz: continuousMidiToHz(next.note.targetMidi), timbre: varyTimbre ? next.timbreB : timbre, duration: 0.92, amplitude: 0.24 }
      ]);
    } else {
      void playTone({ frequencyHz: continuousMidiToHz(next.note.targetMidi), timbre: varyTimbre ? next.timbreB : timbre, duration: 1.05, amplitude: 0.26 });
    }
  }, [mode, progress, resetTrial, timbre, varyTimbre]);

  const changeAnchor = (nextAnchor: NoteLetter) => {
    setAnchorLetter(nextAnchor);
    const next = resetTrial(mode, activeFamilyId, nextAnchor);
    if (mode === "reference") {
      setHeardCurrent(true);
      if (isReferencePrompt(next)) {
        void playToneSequence([
          { frequencyHz: continuousMidiToHz(next.note.anchorMidi), timbre: varyTimbre ? next.timbreA : timbre, duration: 0.82, amplitude: 0.24, gapAfter: 0.24 },
          { frequencyHz: continuousMidiToHz(next.note.targetMidi), timbre: varyTimbre ? next.timbreB : timbre, duration: 0.92, amplitude: 0.24 }
        ]);
      }
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (answerTargetIsEditable(event.target) || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (!event.repeat) playPrompt();
        return;
      }
      if (event.key === "Enter" && submitted) {
        event.preventDefault();
        if (!event.repeat) advanceAndPlay();
        return;
      }
      if (event.repeat) return;
      const letter = parseNoteLetterKey(event.key);
      if (letter) commitLetter(letter);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [advanceAndPlay, commitLetter, playPrompt, submitted]);

  const guessedMidi = answerLetter ? midiForFamilyLetter(activeFamilyId, answerLetter) : undefined;
  const markers = useMemo<PianoKeyMarker[]>(() => {
    const result: PianoKeyMarker[] = [];
    if (isReferencePrompt(trial)) {
      result.push({ midi: trial.note.anchorMidi, role: "anchor", label: "starting tone" });
    }
    if (!submitted) return result;
    if (guessedMidi != null) {
      result.push({
        midi: guessedMidi,
        role: answerLetter === trial.note.targetLetter ? "guess" : "wrong",
        label: answerLetter === trial.note.targetLetter ? "your correct answer" : "your answer"
      });
    }
    result.push({ midi: trial.note.targetMidi, role: "target", label: "correct target" });
    return result;
  }, [answerLetter, guessedMidi, submitted, trial]);

  const resultCorrect = submitted && answerLetter === trial.note.targetLetter;
  const targetFrequency = continuousMidiToHz(trial.note.targetMidi);
  const attemptCount = NOTE_LETTERS.reduce((sum, letter) => sum + evidence[letter].attempts, 0);
  const correctCount = NOTE_LETTERS.reduce((sum, letter) => sum + evidence[letter].correct, 0);

  return (
    <>
      <Panel className="family-path" aria-label="Register family progression">
        <div className="family-path-copy">
          <Eyebrow>One register at a time</Eyebrow>
          <b>No octave changes happen automatically.</b>
          <small>Master all seven letters here, then choose when to move upward.</small>
        </div>
        <div className="family-stages">
          {NOTE_FAMILIES.map((candidate) => {
            const unlocked = unlockedFamilyIds.includes(candidate.id);
            const complete = isFamilyComplete(progress[candidate.id]);
            const active = candidate.id === activeFamilyId;
            const mastered = masteredNoteCount(progress[candidate.id]);
            const status = complete ? "Complete" : active ? "Active" : unlocked ? "Ready" : "Locked";
            return (
              <button
                key={candidate.id}
                type="button"
                className={`${active ? "active" : ""} ${complete ? "complete" : ""} ${!unlocked ? "locked" : ""}`}
                disabled={!unlocked}
                onClick={() => selectFamily(candidate.id)}
                aria-label={`${candidate.label} family, ${candidate.rangeLabel}, ${status}, ${mastered} of 7 stable`}
              >
                <span>{status}{!unlocked && <Icon name="lock" size={11} />}</span>
                <strong>{candidate.label}</strong>
                <small>{candidate.rangeLabel}</small>
                <i>{NOTE_LETTERS.map((letter) => <em key={letter} className={progress[candidate.id][letter].mastered ? "earned" : ""} />)}</i>
                <b>{mastered}/7 stable</b>
              </button>
            );
          })}
        </div>
      </Panel>

      <div className="ear-workspace family-workspace">
        <Panel className="ear-prompt-card family-prompt-card">
          <div className="trial-index">FIXED REGISTER <span /> {mode === "reference" ? "guided anchor" : "hear + name"}</div>
          <div className="register-lock">
            <span><i /> REGISTER LOCK</span>
            <strong>{family.label} · {family.rangeLabel}</strong>
            <small>C is always the lowest note. B is always the highest.</small>
          </div>

          {mode === "reference" && (
            <Select label="Visible starting tone" value={anchorLetter} onChange={(event) => changeAnchor(event.target.value as NoteLetter)}>
              {NOTE_LETTERS.map((letter) => <option key={letter} value={letter}>{letter}{family.octave}</option>)}
            </Select>
          )}

          <button className="sound-orb family-sound-orb" type="button" onClick={() => playPrompt()} disabled={!hydrated} aria-label={heardCurrent ? "Replay prompt" : "Play prompt"}>
            <div className="orb-ring one" /><div className="orb-ring two" /><div className="orb-ring three" />
            <Icon name="play" size={32} />
            <span>{heardCurrent ? "REPLAY" : hydrated ? mode === "reference" ? "PLAY TWO TONES" : "PLAY NOTE" : "LOADING"}</span>
          </button>
          <h2>{mode === "reference" ? `Start at ${anchorLetter}${family.octave}. Name the second tone.` : "Hear one note. Press its letter."}</h2>
          <p>{varyTimbre ? "Advanced variation is on: the sound surface may change, but the register cannot." : `Only natural notes in ${family.rangeLabel}; ${timbre} timbre stays fixed.`}</p>
          <PlayButton label={heardCurrent ? "Replay prompt · Space" : "Begin this challenge"} onClick={() => playPrompt()} disabled={!hydrated} />
        </Panel>

        <Panel className="answer-card family-answer-card">
          <div className="family-answer-heading">
            <div><Eyebrow>Your map</Eyebrow><h2>{mode === "reference" ? "The start stays visible." : "Nothing crosses the register boundary."}</h2></div>
            <span><small>FAMILY ACCURACY</small><b>{attemptCount ? Math.round(correctCount / attemptCount * 100) : 0}%</b></span>
          </div>

          <div className="family-keyboard-wrap">
            <PianoKeyboard
              startMidi={family.firstMidi}
              endMidi={family.lastMidi}
              showLabels
              markers={markers}
              ariaLabel={`${family.label} note family keyboard from ${family.rangeLabel}`}
            />
            <div className="keyboard-legend">
              {mode === "reference" && <span className="start"><i>S</i> Starting tone</span>}
              {submitted && <span className="guess"><i>●</i> Your answer</span>}
              {submitted && <span className="target"><i>◎</i> Correct tone</span>}
              {!submitted && <small>{mode === "reference" ? "The blue S never moves; the answer remains hidden." : "The keyboard reveals the target only after you answer."}</small>}
            </div>
          </div>

          <div className="letter-answer-label">
            <div><b>{heardCurrent ? "Which letter did you hear?" : "Play the prompt first."}</b><small>Press A–G on your keyboard or choose below. The answer submits immediately.</small></div>
            <span>{masteredNoteCount(evidence)}/7 stable</span>
          </div>
          <div className="letter-answer-grid">
            {NOTE_LETTERS.map((letter) => {
              const item = evidence[letter];
              const accuracy = item.attempts ? Math.round(item.correct / item.attempts * 100) : 0;
              const isTarget = submitted && letter === trial.note.targetLetter;
              const isWrong = submitted && letter === answerLetter && letter !== trial.note.targetLetter;
              return (
                <button
                  key={letter}
                  type="button"
                  disabled={!heardCurrent || submitted}
                  className={`${item.mastered ? "mastered" : ""} ${isTarget ? "correct" : ""} ${isWrong ? "incorrect" : ""}`}
                  onClick={() => commitLetter(letter)}
                  aria-label={`Answer ${letter}. ${item.mastered ? "Stable" : `${item.correct} correct of ${item.attempts} attempts`}`}
                >
                  <kbd>{letter}</kbd>
                  <span>{item.mastered ? "STABLE" : `${Math.min(item.correct, 3)}/3 · ${accuracy}%`}</span>
                  <i>{[0, 1, 2].map((index) => <em key={index} className={item.mastered || index < item.correct ? "earned" : ""} />)}</i>
                </button>
              );
            })}
          </div>

          {submitted && (
            <div className={`answer-result family-answer-result ${resultCorrect ? "correct" : "partial"}`} role="status" aria-live="polite">
              <Icon name={resultCorrect ? "spark" : "ear"} size={21} />
              <div>
                <span>{resultCorrect ? "CORRECT MAP" : `YOU PRESSED ${answerLetter}`}</span>
                <b>{noteLabel(trial.note.targetMidi)} · {targetFrequency.toFixed(2)} Hz</b>
                <small>{isReferencePrompt(trial) ? relationshipText(trial.note.anchorMidi, trial.note.targetMidi) : resultCorrect ? "Letter and register now agree." : `The sound was ${trial.note.targetLetter}${family.octave}; compare the two marked keys.`}</small>
              </div>
            </div>
          )}

          {familyComplete && (
            <div className="family-complete-banner">
              <Icon name="spark" size={22} />
              <div><b>{family.label} family complete.</b><small>Every letter is stable. You stay here until you choose otherwise.</small></div>
              {nextFamily && <ActionButton onClick={() => selectFamily(nextFamily.id)}>Move to {nextFamily.label} when ready <Icon name="arrow" size={15} /></ActionButton>}
            </div>
          )}

          {submitted ? (
            <ActionButton className="wide primary family-next" onClick={advanceAndPlay}>Next note in {family.rangeLabel} <Icon name="arrow" size={17} /></ActionButton>
          ) : (
            <div className="answer-shortcuts"><span><kbd>Space</kbd> replay</span><span><kbd>A–G</kbd> answer</span><span><kbd>Enter</kbd> next after reveal</span></div>
          )}
        </Panel>
      </div>
    </>
  );
}
