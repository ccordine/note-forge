import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { playTone, playToneSequence, TIMBRES, type ActiveVoice, type Timbre } from "@/audio/synth";
import { continuousMidiToHz, INTERVAL_LONG, noteLabel } from "@/lib/music-display";
import { saveAttempt, getSetting, setSetting } from "@/storage/database";
import { ActionButton, Eyebrow, Panel, PlayButton, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { PianoKeyboard, type PianoKeyMarker } from "@/ui/PianoKeyboard";
import {
  NOTE_FAMILIES,
  NOTE_LETTERS,
  advanceHighestUnlockedFamily,
  createEmptyNoteFamilyProgress,
  createNoteFamilyTrial,
  createReferenceTrial,
  getNoteFamily,
  isFamilyComplete,
  isNoteMastered,
  masteredNoteCount,
  midiForFamilyLetter,
  normalizeFamilyProgress,
  parseNoteLetterKey,
  recordNoteAttempt,
  unlockedFamilyIdsThrough,
  type FamilyEvidence,
  type NoteFamilyId,
  type NoteFamilyProgress,
  type NoteFamilyTrial,
  type NoteLetter,
  type ReferenceTrial
} from "./trials";

export type FoundationEarMode = "letters" | "reference";

interface StoredFamilyState {
  activeFamilyId?: NoteFamilyId;
  highestUnlockedFamilyId?: NoteFamilyId;
  progress?: unknown;
}

interface PromptTrial {
  kind: FoundationEarMode;
  note: NoteFamilyTrial | ReferenceTrial;
  timbreA: Timbre;
  timbreB: Timbre;
  startedAt: string;
}

const STORAGE_KEY = "ear.note-families";

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

function familyIndex(familyId: NoteFamilyId): number {
  return NOTE_FAMILIES.findIndex((family) => family.id === familyId);
}

function isKnownFamilyId(value: unknown): value is NoteFamilyId {
  return NOTE_FAMILIES.some((family) => family.id === value);
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
  const [highestUnlockedFamilyId, setHighestUnlockedFamilyId] = useState<NoteFamilyId>("low");
  const [anchorLetter, setAnchorLetter] = useState<NoteLetter>("A");
  const [trial, setTrial] = useState<PromptTrial>(() => makePromptTrial("letters", "low", createEmptyNoteFamilyProgress().low, "A"));
  const [answerLetter, setAnswerLetter] = useState<NoteLetter>();
  const [submitted, setSubmitted] = useState(false);
  const [heardCurrent, setHeardCurrent] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [promptError, setPromptError] = useState("");
  const [promptStarting, setPromptStarting] = useState(false);
  const progressReadRef = useRef(false);
  const mountedRef = useRef(false);
  const promptGenerationRef = useRef(0);
  const promptVoiceRef = useRef<ActiveVoice | null>(null);
  const heardCurrentRef = useRef(false);
  const heardPromptRef = useRef<PromptTrial | null>(null);

  const family = getNoteFamily(activeFamilyId);
  const evidence = progress[activeFamilyId];
  const familyComplete = isFamilyComplete(evidence);
  const highestUnlockedIndex = familyIndex(highestUnlockedFamilyId);
  const unlockedFamilyIds = unlockedFamilyIdsThrough(highestUnlockedFamilyId);
  const currentFamilyIndex = familyIndex(activeFamilyId);
  const nextFamily = NOTE_FAMILIES[currentFamilyIndex + 1];
  const promptTransitioning = trial.kind !== mode;
  const currentPromptHeard = heardCurrent && !promptTransitioning;

  const invalidatePrompt = useCallback(() => {
    promptGenerationRef.current += 1;
    promptVoiceRef.current?.stop(0.03);
    promptVoiceRef.current = null;
    heardCurrentRef.current = false;
    heardPromptRef.current = null;
    setPromptStarting(false);
  }, []);

  const resetTrial = useCallback((nextMode: FoundationEarMode, familyId: NoteFamilyId, nextAnchor = anchorLetter, nextProgress = progress) => {
    invalidatePrompt();
    const next = makePromptTrial(nextMode, familyId, nextProgress[familyId], nextAnchor);
    setTrial(next);
    setAnswerLetter(undefined);
    setSubmitted(false);
    setHeardCurrent(false);
    setPromptError("");
    return next;
  }, [anchorLetter, invalidatePrompt, progress]);

  const playPrompt = useCallback(async (prompt = trial): Promise<void> => {
    if (!hydrated || prompt.kind !== mode) return;
    const generation = ++promptGenerationRef.current;
    promptVoiceRef.current?.stop(0.03);
    promptVoiceRef.current = null;
    heardCurrentRef.current = false;
    heardPromptRef.current = null;
    setHeardCurrent(false);
    setPromptError("");
    setPromptStarting(true);
    try {
      const voice = isReferencePrompt(prompt)
        ? await playToneSequence([
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
        ])
        : await playTone({
          frequencyHz: continuousMidiToHz(prompt.note.targetMidi),
          timbre: varyTimbre ? prompt.timbreB : timbre,
          duration: 1.05,
          amplitude: 0.26
        });
      if (!mountedRef.current || generation !== promptGenerationRef.current) {
        voice.stop(0.02);
        return;
      }
      promptVoiceRef.current = voice;
      heardCurrentRef.current = true;
      heardPromptRef.current = prompt;
      setHeardCurrent(true);
      setPromptStarting(false);
    } catch {
      if (!mountedRef.current || generation !== promptGenerationRef.current) return;
      promptVoiceRef.current = null;
      heardCurrentRef.current = false;
      heardPromptRef.current = null;
      setHeardCurrent(false);
      setPromptStarting(false);
      setPromptError("The listening prompt could not start. No answer is enabled and no attempt will be scored; check browser audio, then try again.");
    }
  }, [hydrated, mode, timbre, trial, varyTimbre]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      promptGenerationRef.current += 1;
      promptVoiceRef.current?.stop(0.02);
      promptVoiceRef.current = null;
      heardCurrentRef.current = false;
      heardPromptRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getSetting<StoredFamilyState>(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        progressReadRef.current = true;
        const restoredProgress = normalizeFamilyProgress(stored?.progress);
        const restoredHighest = isKnownFamilyId(stored?.highestUnlockedFamilyId)
          ? stored.highestUnlockedFamilyId
          : "low";
        const requestedFamily = stored?.activeFamilyId;
        const restoredFamily = isKnownFamilyId(requestedFamily) && familyIndex(requestedFamily) <= familyIndex(restoredHighest)
          ? requestedFamily
          : "low";
        setProgress(restoredProgress);
        setActiveFamilyId(restoredFamily);
        setHighestUnlockedFamilyId(restoredHighest);
        setTrial(makePromptTrial(mode, restoredFamily, restoredProgress[restoredFamily], anchorLetter));
      })
      .catch(() => {
        if (!cancelled) setStorageError("Local ear-training progress could not be read. Unread progress will not be overwritten during this visit.");
      })
      .finally(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated || !progressReadRef.current) return;
    void setSetting<StoredFamilyState>(STORAGE_KEY, {
      activeFamilyId,
      highestUnlockedFamilyId,
      progress
    }).catch(() => setStorageError("Local ear-training progress could not be saved."));
  }, [activeFamilyId, highestUnlockedFamilyId, hydrated, progress]);

  useEffect(() => {
    const nextHighest = advanceHighestUnlockedFamily(highestUnlockedFamilyId, activeFamilyId, familyComplete);
    if (nextHighest !== highestUnlockedFamilyId) setHighestUnlockedFamilyId(nextHighest);
  }, [activeFamilyId, familyComplete, highestUnlockedFamilyId]);

  useEffect(() => {
    if (!hydrated || trial.kind === mode) return;
    resetTrial(mode, activeFamilyId);
  }, [activeFamilyId, hydrated, mode, resetTrial, trial.kind]);

  const commitLetter = useCallback((letter: NoteLetter) => {
    if (
      !hydrated
      || !heardCurrentRef.current
      || heardPromptRef.current !== trial
      || trial.kind !== mode
      || submitted
    ) return;
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
    }).catch(() => setStorageError("This ear-training attempt could not be saved to local history."));
  }, [activeFamilyId, hydrated, mode, onRevealMidi, submitted, trial]);

  const advanceAndPlay = useCallback(() => {
    const next = resetTrial(mode, activeFamilyId);
    void playPrompt(next);
  }, [activeFamilyId, mode, playPrompt, resetTrial]);

  const selectFamily = useCallback((familyId: NoteFamilyId) => {
    if (familyIndex(familyId) > highestUnlockedIndex) return;
    setActiveFamilyId(familyId);
    const next = resetTrial(mode, familyId);
    void playPrompt(next);
  }, [highestUnlockedIndex, mode, playPrompt, resetTrial]);

  const changeAnchor = (nextAnchor: NoteLetter) => {
    setAnchorLetter(nextAnchor);
    const next = resetTrial(mode, activeFamilyId, nextAnchor);
    if (mode === "reference") void playPrompt(next);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (answerTargetIsEditable(event.target) || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (!event.repeat) void playPrompt();
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
  const targetEvidence = evidence[trial.note.targetLetter];
  const targetStreak = Math.min(targetEvidence.correctStreak, 3);
  const targetStable = isNoteMastered(targetEvidence);
  const streakFeedback = resultCorrect
    ? targetStable ? "Stable now: three correct in a row." : `Current streak: ${targetStreak}/3 correct in a row.`
    : "Miss: this note's stability streak reset to 0/3.";
  const attemptCount = NOTE_LETTERS.reduce((sum, letter) => sum + evidence[letter].attempts, 0);
  const correctCount = NOTE_LETTERS.reduce((sum, letter) => sum + evidence[letter].correct, 0);

  return (
    <>
      {storageError && <div className="error-banner"><strong>Local progress storage needs attention.</strong><span>{storageError}</span></div>}
      {promptError && <div className="error-banner" role="alert"><strong>Prompt audio did not start.</strong><span>{promptError}</span></div>}
      <Panel className="family-path" aria-label="Register family progression">
        <div className="family-path-copy">
          <Eyebrow>One register at a time</Eyebrow>
          <b>No octave changes happen automatically.</b>
          <small>Each note needs three correct answers in a row; any miss resets that note to 0/3. Earned registers remain available.</small>
        </div>
        <div className="family-stages">
          {NOTE_FAMILIES.map((candidate) => {
            const unlocked = unlockedFamilyIds.includes(candidate.id);
            const complete = isFamilyComplete(progress[candidate.id]);
            const active = candidate.id === activeFamilyId;
            const mastered = masteredNoteCount(progress[candidate.id]);
            const previouslyPassed = familyIndex(candidate.id) < highestUnlockedIndex;
            const status = complete ? "Complete" : active ? "Active" : previouslyPassed ? "Review" : unlocked ? "Ready" : "Locked";
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
                <i>{NOTE_LETTERS.map((letter) => <em key={letter} className={isNoteMastered(progress[candidate.id][letter]) ? "earned" : ""} />)}</i>
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

          <button className="sound-orb family-sound-orb" type="button" onClick={() => { void playPrompt(); }} disabled={!hydrated || promptStarting || promptTransitioning} aria-label={currentPromptHeard ? "Replay prompt" : "Play prompt"}>
            <div className="orb-ring one" /><div className="orb-ring two" /><div className="orb-ring three" />
            <Icon name="play" size={32} />
            <span>{promptStarting ? "STARTING AUDIO" : currentPromptHeard ? "REPLAY" : hydrated ? mode === "reference" ? "PLAY TWO TONES" : "PLAY NOTE" : "LOADING"}</span>
          </button>
          <h2>{mode === "reference" ? `Start at ${anchorLetter}${family.octave}. Name the second tone.` : "Hear one note. Press its letter."}</h2>
          <p>{varyTimbre ? "Advanced variation is on: the sound surface may change, but the register cannot." : `Only natural notes in ${family.rangeLabel}; ${timbre} timbre stays fixed.`}</p>
          <PlayButton label={promptStarting ? "Starting prompt…" : currentPromptHeard ? "Replay prompt · Space" : "Begin this challenge"} onClick={() => { void playPrompt(); }} disabled={!hydrated || promptStarting || promptTransitioning} />
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
            <div><b>{currentPromptHeard ? "Which letter did you hear?" : "Play the prompt first."}</b><small>Press A–G on your keyboard or choose below. The answer submits immediately.</small></div>
            <span>{masteredNoteCount(evidence)}/7 stable</span>
          </div>
          <div className="letter-answer-grid">
            {NOTE_LETTERS.map((letter) => {
              const item = evidence[letter];
              const stable = isNoteMastered(item);
              const streak = Math.min(item.correctStreak, 3);
              const isTarget = submitted && letter === trial.note.targetLetter;
              const isWrong = submitted && letter === answerLetter && letter !== trial.note.targetLetter;
              return (
                <button
                  key={letter}
                  type="button"
                  disabled={!currentPromptHeard || submitted}
                  className={`${stable ? "mastered" : ""} ${isTarget ? "correct" : ""} ${isWrong ? "incorrect" : ""}`}
                  onClick={() => commitLetter(letter)}
                  aria-label={`Answer ${letter}. ${stable ? "Stable with three consecutive correct answers" : `${streak} of 3 consecutive correct answers`}. ${item.correct} correct of ${item.attempts} lifetime attempts.`}
                >
                  <kbd>{letter}</kbd>
                  <span>{stable ? "STABLE · 3/3" : `${streak}/3 IN A ROW`}</span>
                  <i>{[0, 1, 2].map((index) => <em key={index} className={index < streak ? "earned" : ""} />)}</i>
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
                <small>{isReferencePrompt(trial) ? relationshipText(trial.note.anchorMidi, trial.note.targetMidi) : resultCorrect ? "Letter and register now agree." : `The sound was ${trial.note.targetLetter}${family.octave}; compare the two marked keys.`} {streakFeedback}</small>
              </div>
            </div>
          )}

          {familyComplete && (
            <div className="family-complete-banner">
              <Icon name="spark" size={22} />
              <div><b>{family.label} family complete.</b><small>Every letter has three correct answers in a row. You stay here until you choose otherwise.</small></div>
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
