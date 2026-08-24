import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { YinPitchFrame } from "@noteforge/pitch-engine";
import { useAudioInput } from "@/audio/use-audio-input";
import { playTone, playToneSequence, type ActiveVoice } from "@/audio/synth";
import { continuousMidiToHz, noteLabel, signed } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { resolveArcadeCurriculum } from "./curriculum";
import {
  createChallengeSession,
  createChallengeSteps,
  finishChallengeSession,
  generatePitchPattern,
  getDifficultyPreset,
  scoreChallengeFrame,
  summarizeChallenge,
  type ChallengeScoreSummary,
  type ChallengeSessionState,
  type PitchPatternStep,
  type VoiceChallengeMode,
} from "./model";
import type { ArcadeGameProps } from "./types";

type PatternPhase = "setup" | "connecting" | "preview" | "playing" | "result";

const MODE_COPY: Record<VoiceChallengeMode, { label: string; detail: string }> = {
  simon: { label: "Simon echo", detail: "Hear the whole phrase, then reproduce it from memory." },
  ddr: { label: "Sight run", detail: "Read the moving note rail and hit each target on time." },
};

export function PatternChallenge({
  difficulty,
  curriculumStage,
  voiceRange,
  onExit,
  onComplete,
}: ArcadeGameProps) {
  const [phase, setPhase] = useState<PatternPhase>("setup");
  const [challengeMode, setChallengeMode] = useState<VoiceChallengeMode>("simon");
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false);
  const [pattern, setPattern] = useState<PitchPatternStep[]>([]);
  const [session, setSession] = useState<ChallengeSessionState | null>(null);
  const [result, setResult] = useState<ChallengeScoreSummary | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [round, setRound] = useState(1);
  const [status, setStatus] = useState("Choose a run style, put on headphones, and start the first phrase.");

  const phaseRef = useRef<PatternPhase>(phase);
  const sessionRef = useRef<ChallengeSessionState | null>(null);
  const scoringArmedRef = useRef(false);
  const originFrameTimeRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const beginPreparedRoundRef = useRef<(generation: number) => void>(() => undefined);
  const timersRef = useRef<number[]>([]);
  const mountedRef = useRef(true);
  const completedRef = useRef(false);
  const finishRef = useRef<(state: ChallengeSessionState, early?: boolean) => void>(() => undefined);
  const onFrameRef = useRef<(frame: YinPitchFrame) => void>(() => undefined);
  const promptVoiceRef = useRef<ActiveVoice | null>(null);

  phaseRef.current = phase;

  const input = useAudioInput({
    onFrame: (frame) => onFrameRef.current(frame),
  });
  const inputRef = useRef(input);
  inputRef.current = input;

  const preset = getDifficultyPreset(difficulty);
  const curriculum = resolveArcadeCurriculum("pattern", curriculumStage);
  const feedback = curriculum.feedback;

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(window.clearTimeout);
    timersRef.current = [];
    promptVoiceRef.current?.stop(0.04);
    promptVoiceRef.current = null;
  }, []);

  const schedule = useCallback((callback: () => void, delayMs: number) => {
    timersRef.current.push(window.setTimeout(callback, delayMs));
  }, []);

  const finishRound = useCallback((state: ChallengeSessionState, early = false) => {
    if (completedRef.current) return;
    completedRef.current = true;
    scoringArmedRef.current = false;
    clearTimers();
    const completed = early ? finishChallengeSession(state) : state.status === "complete" ? state : finishChallengeSession(state);
    const summary = summarizeChallenge(completed);
    sessionRef.current = completed;
    setSession(completed);
    setResult(summary);
    setPhase("result");
    setStatus(`${summary.hitSteps} of ${summary.totalSteps} notes earned · ${summary.accuracyPercent.toFixed(0)}% pitch quality.`);
    onComplete({
      mode: "pattern",
      curriculumStage,
      variant: challengeMode,
      score: summary.scorePercent,
      grade: summary.grade,
      xp: Math.round(summary.scorePercent * preset.scoreMultiplier),
      accuracy: summary.accuracyPercent,
      bestCombo: summary.maxCombo,
      durationMs: Math.round((completed.steps.at(-1)?.windowEndSeconds ?? elapsed) * 1_000),
      details: {
        rawScore: summary.score,
        maximumScore: summary.maximumScore,
        completionPercent: summary.completionPercent,
        hitSteps: summary.hitSteps,
        missedSteps: summary.missedSteps,
      },
    });
  }, [challengeMode, clearTimers, curriculumStage, elapsed, onComplete, preset.scoreMultiplier]);

  finishRef.current = finishRound;

  onFrameRef.current = (frame) => {
    if (!scoringArmedRef.current || phaseRef.current !== "playing" || !sessionRef.current) return;
    originFrameTimeRef.current ??= frame.timeSeconds;
    const relativeTime = Math.max(0, frame.timeSeconds - originFrameTimeRef.current);
    const next = scoreChallengeFrame(sessionRef.current, {
      timeSeconds: relativeTime,
      midiFloat: frame.midiFloat,
      confidence: frame.confidence,
      voiced: frame.voiced,
    });
    sessionRef.current = next;
    setSession(next);
    setElapsed(relativeTime);
    if (next.status === "complete") finishRef.current(next);
  };

  const beginPreparedRound = useCallback((generation: number) => {
    if (!mountedRef.current || generation !== generationRef.current) return;
    const nextPattern = generatePitchPattern({
      seed: `${new Date().toISOString().slice(0, 10)}:${round}:${challengeMode}:${difficulty}`,
      baselineMidi: Math.max(voiceRange.lowMidi, Math.min(voiceRange.highMidi, voiceRange.baselineMidi)),
      lowMidi: voiceRange.lowMidi,
      highMidi: voiceRange.highMidi,
      difficulty,
    });
    const steps = createChallengeSteps(nextPattern, { mode: challengeMode, difficulty, startAtSeconds: 0 });
    const nextSession = createChallengeSession(steps, { minimumConfidence: 0.55 });
    setPattern(nextPattern);
    setSession(nextSession);
    sessionRef.current = nextSession;
    setPhase("preview");

    if (challengeMode === "simon") {
      setStatus("Listen to the phrase. Live note detection stays visible; only exercise scoring waits for the settle gap.");
      const toneDuration = difficulty === "hard" ? 0.34 : difficulty === "medium" ? 0.42 : 0.5;
      const gap = difficulty === "hard" ? 0.08 : 0.12;
      void playToneSequence(nextPattern.map((step) => ({
          frequencyHz: continuousMidiToHz(step.targetMidi),
          duration: toneDuration,
          gapAfter: gap,
          timbre: "sine",
          amplitude: 0.22,
          release: 0.06,
        })), { gap }).then((voice) => {
          if (!mountedRef.current || generation !== generationRef.current) {
            voice.stop(0.02);
            return;
          }
          promptVoiceRef.current = voice;
        schedule(() => {
          if (generation !== generationRef.current) return;
          promptVoiceRef.current?.stop(0.03);
          promptVoiceRef.current = null;
          originFrameTimeRef.current = null;
          scoringArmedRef.current = true;
          setPhase("playing");
          setStatus("Your turn. Drive every note into the hit line; silence between targets is allowed.");
        }, nextPattern.length * (toneDuration + gap) * 1_000 + 420);
      }).catch(() => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setPhase("setup");
        setStatus("The reference phrase could not start. Check browser audio and try again.");
      });
    } else {
      setStatus("Ready cue. The moving rail begins after the reference releases.");
      void playTone({ frequencyHz: continuousMidiToHz(nextPattern[0]!.targetMidi), duration: 0.7, amplitude: 0.2, release: 0.08 }).then((voice) => {
        if (!mountedRef.current || generation !== generationRef.current) {
          voice.stop(0.02);
          return;
        }
        promptVoiceRef.current = voice;
        schedule(() => {
          if (generation !== generationRef.current) return;
          promptVoiceRef.current?.stop(0.03);
          promptVoiceRef.current = null;
          originFrameTimeRef.current = null;
          scoringArmedRef.current = true;
          setPhase("playing");
          setStatus("Rail live. Meet each block at the cyan hit line.");
        }, 1_050);
      }).catch(() => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setPhase("setup");
        setStatus("The reference tone could not start. Check browser audio and try again.");
      });
    }
  }, [challengeMode, difficulty, input, round, schedule, voiceRange]);
  beginPreparedRoundRef.current = beginPreparedRound;

  const startRound = useCallback(async () => {
    if (!headphonesConfirmed || phase === "connecting" || phase === "preview" || phase === "playing") return;
    const generation = ++generationRef.current;
    clearTimers();
    completedRef.current = false;
    scoringArmedRef.current = false;
    originFrameTimeRef.current = null;
    setElapsed(0);
    setResult(null);
    setPhase("connecting");
    setStatus("Opening the local microphone…");
    const microphone = await input.enable();
    if (!mountedRef.current || generation !== generationRef.current) return;
    if (!microphone) {
      setPhase("setup");
      setStatus(inputRef.current.error || "Microphone access is needed to control the note rail.");
      return;
    }
    beginPreparedRoundRef.current(generation);
  }, [clearTimers, headphonesConfirmed, input, phase]);

  const stopRound = useCallback(() => {
    generationRef.current += 1;
    scoringArmedRef.current = false;
    clearTimers();
    if (sessionRef.current && (phaseRef.current === "playing" || phaseRef.current === "preview")) {
      finishRef.current(sessionRef.current, true);
    } else {
      setPhase("setup");
      setStatus("Round stopped safely.");
    }
  }, [clearTimers]);

  useEffect(() => {
    if (input.state !== "error") return;
    if (phaseRef.current === "playing" || phaseRef.current === "preview") {
      stopRound();
      setStatus("The microphone disconnected. The run stopped safely; enable input before trying again.");
    }
  }, [input.state, stopRound]);

  useEffect(() => {
    mountedRef.current = true;
    const visibility = () => {
      if (document.visibilityState === "hidden" && (phaseRef.current === "playing" || phaseRef.current === "preview")) stopRound();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      scoringArmedRef.current = false;
      clearTimers();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [clearTimers, stopRound]);

  const activeStep = session?.steps[session.activeStepIndex];
  const liveFrame = phase === "playing" ? input.liveFrame : undefined;
  const reliableLive = liveFrame?.voiced === true
    && liveFrame.midiFloat !== null;
  const liveMidi = reliableLive ? liveFrame.midiFloat! : null;
  const liveError = liveMidi === null || !activeStep ? null : (liveMidi - activeStep.targetMidi) * 100;
  const liveY = liveMidi === null
    ? 50
    : 8 + (1 - Math.max(0, Math.min(1, (liveMidi - voiceRange.lowMidi) / (voiceRange.highMidi - voiceRange.lowMidi)))) * 80;
  const lookAheadSeconds = difficulty === "hard" ? 3.2 : difficulty === "medium" ? 4.2 : 5.2;
  const noteTiles = useMemo(() => session?.steps.map((step) => {
    const left = 15 + (step.windowStartSeconds - elapsed) / lookAheadSeconds * 78;
    const top = 8 + (1 - (step.targetMidi - voiceRange.lowMidi) / (voiceRange.highMidi - voiceRange.lowMidi)) * 80;
    const width = Math.max(5, (step.windowEndSeconds - step.windowStartSeconds) / lookAheadSeconds * 78);
    return { step, left, top, width };
  }) ?? [], [elapsed, lookAheadSeconds, session?.steps, voiceRange.highMidi, voiceRange.lowMidi]);
  const liveVoiceLabel = !feedback.showLiveNote
    ? reliableLive ? "TRACKING" : "—"
    : liveFrame?.nearestMidi == null || !reliableLive
      ? "—"
      : noteLabel(liveFrame.nearestMidi);
  const liveVoiceDetail = liveError === null
    ? "waiting for pitch"
    : !feedback.showCents
      ? liveError < 0 ? "move up" : liveError > 0 ? "move down" : "centered"
      : `${signed(liveError, 0)}¢ · ${liveError < 0 ? "move up" : liveError > 0 ? "move down" : "centered"}`;

  return (
    <section className={`arcade-game-shell echo-run-shell curriculum-${curriculum.stage}`}>
      <div className="arcade-game-hud">
        <div><span>ROUND</span><strong>{round.toString().padStart(2, "0")}</strong></div>
        <div><span>SCORE</span><strong>{session?.score.toLocaleString() ?? "0"}</strong></div>
        <div className="combo"><span>COMBO</span><strong>{session?.combo ?? 0}<small>×</small></strong></div>
        <div><span>PITCH QUALITY</span><strong>{session ? `${session.accuracyPercent.toFixed(0)}%` : "—"}</strong></div>
        <ActionButton className="coral" onClick={phase === "setup" || phase === "result" ? onExit : stopRound}><Icon name="pause" size={16} /> {phase === "setup" || phase === "result" ? "Exit game" : "Stop & grade"}</ActionButton>
      </div>

      {phase === "setup" && (
        <Panel className="arcade-game-loadout">
          <div><Eyebrow>Echo Run · {curriculum.stageLabel}</Eyebrow><h1>Hear it. Remember it. Drive it.</h1><p>The prompt never scores. After it ends, the same phrase becomes a timed note rail controlled entirely by your voice. {curriculum.stageSummary}</p></div>
          <div className="arcade-mode-toggle" role="radiogroup" aria-label="Echo Run style">
            {(Object.keys(MODE_COPY) as VoiceChallengeMode[]).map((id) => <button type="button" role="radio" aria-checked={challengeMode === id} className={challengeMode === id ? "active" : ""} key={id} onClick={() => setChallengeMode(id)}><b>{MODE_COPY[id].label}</b><span>{MODE_COPY[id].detail}</span></button>)}
          </div>
          <div className="arcade-contract-grid"><span><b>{preset.patternLength}</b><small>notes</small></span><span><b>±{preset.toleranceCents}¢</b><small>pitch lane</small></span><span><b>{preset.tempoBpm}</b><small>BPM</small></span><span><b>{preset.sustainDurationSeconds.toFixed(2)}s</b><small>hold per target</small></span></div>
          <NoteInput variant="scope" input={input} title="Echo Run microphone setup" targetMidiFloat={voiceRange.baselineMidi} toleranceCents={preset.toleranceCents} />
          <button type="button" className={`arcade-headphone-confirm ${headphonesConfirmed ? "confirmed" : ""}`} aria-pressed={headphonesConfirmed} onClick={() => setHeadphonesConfirmed((current) => !current)}><Icon name="headphones" size={21} /><span><b>{headphonesConfirmed ? "Headphones confirmed" : "I’m wearing headphones"}</b><small>Speaker prompts can be mistaken for your voice.</small></span></button>
          {input.error && <div className="error-banner" role="alert">{input.error}</div>}
          <div className="arcade-start-row"><span>{status}</span><ActionButton className="primary" disabled={!headphonesConfirmed || input.state === "opening"} onClick={() => { void startRound(); }}><Icon name="mic" size={18} /> Start voice run</ActionButton></div>
        </Panel>
      )}

      {(phase === "connecting" || phase === "preview") && (
        <Panel className="arcade-countdown-stage" aria-live="polite">
          <NoteInput variant="compact" input={input} compact />
          <span className="arcade-countdown-orb"><Icon name={phase === "connecting" ? "mic" : "headphones"} size={34} /></span>
          <Eyebrow>{phase === "connecting" ? "Connecting local pitch controller" : challengeMode === "simon" ? "Listen · memorize" : "Ready cue"}</Eyebrow>
          <h2>{phase === "connecting"
            ? "Opening the microphone…"
            : feedback.showPreviewLabels
              ? pattern.map((step) => noteLabel(step.targetMidi)).join(" · ")
              : `${pattern.length}-note phrase`}</h2>
          <p>{status}</p>
          {phase === "preview" && <div className="arcade-preview-notes">{pattern.map((step, index) => <span key={`${step.targetMidi}-${index}`}><b>{feedback.showPreviewLabels ? noteLabel(step.targetMidi) : "•"}</b><small>{index + 1}</small></span>)}</div>}
          <ActionButton onClick={stopRound}>Cancel round</ActionButton>
        </Panel>
      )}

      {phase === "playing" && session && (
        <div className="echo-run-stage">
          <NoteInput variant="compact" input={input} compact />
          <div className="echo-target-readout">
            <div><span>NOW</span><strong>{activeStep ? noteLabel(activeStep.targetMidi) : "FINISH"}</strong><small>{activeStep ? `${activeStep.requiredSustainSeconds.toFixed(2)}s hold` : "phrase complete"}</small></div>
            <div className={liveError !== null && Math.abs(liveError) <= (activeStep?.toleranceCents ?? 0) ? "locked" : ""}><span>YOUR VOICE</span><strong>{liveVoiceLabel}</strong><small>{liveVoiceDetail}</small></div>
            <div><span>NEXT</span><strong>{session.steps[session.activeStepIndex + 1]
              ? feedback.showUpcomingCue ? noteLabel(session.steps[session.activeStepIndex + 1]!.targetMidi) : "HIDDEN"
              : "END"}</strong><small>{session.hitSteps}/{session.steps.length} hits</small></div>
          </div>
          <div className="echo-highway" role="img" aria-label={`Moving note highway. Current target ${activeStep ? noteLabel(activeStep.targetMidi) : "complete"}.`}>
            <div className="echo-pitch-grid">{Array.from({ length: 7 }, (_, index) => <i key={index} />)}</div>
            <i className="echo-hit-line"><span>HIT</span></i>
            {noteTiles.filter(({ left }) => left > -15 && left < 110).map(({ step, left, top, width }) => <span key={step.id} className={`echo-note-tile ${step.status}`} style={{ "--note-left": `${left}%`, "--note-top": `${top}%`, "--note-width": `${width}%` } as CSSProperties}><b>{feedback.showUpcomingCue || step.index <= session.activeStepIndex ? noteLabel(step.targetMidi) : "•"}</b><i style={{ width: `${step.progress * 100}%` }} /></span>)}
            <span className={`echo-voice-cursor ${liveMidi === null ? "silent" : ""}`} style={{ "--voice-top": `${liveY}%` } as CSSProperties}><i />{feedback.showLiveNote && <b>{liveMidi === null ? "VOICE" : noteLabel(liveMidi)}</b>}</span>
          </div>
          <div className="echo-step-strip">{session.steps.map((step) => <span key={step.id} className={step.status}><b>{feedback.showUpcomingCue || step.index <= session.activeStepIndex ? noteLabel(step.targetMidi) : "?"}</b><i>{step.status === "hit" ? "✓" : step.status === "miss" ? "×" : step.index + 1}</i></span>)}</div>
          <div className="arcade-live-status" role="status" aria-live="polite"><span>{status}</span><b>{activeStep?.status === "active" ? `${Math.round(activeStep.progress * 100)}% held` : `${Math.max(0, (activeStep?.windowStartSeconds ?? elapsed) - elapsed).toFixed(1)}s to target`}</b></div>
        </div>
      )}

      {phase === "result" && result && (
        <Panel className="arcade-result-stage">
          <div className="arcade-result-grade"><span>RUN GRADE</span><strong>{result.grade}</strong><b>{result.scorePercent}<small>/100</small></b></div>
          <div className="arcade-result-copy"><Eyebrow>Echo Run complete</Eyebrow><h2>{result.gradeLabel}</h2><p>{status}</p><div className="arcade-result-metrics"><span><small>Notes hit</small><b>{result.hitSteps}/{result.totalSteps}</b></span><span><small>Pitch quality</small><b>{result.accuracyPercent.toFixed(0)}%</b></span><span><small>Best combo</small><b>{result.maxCombo}×</b></span><span><small>Raw points</small><b>{result.score.toLocaleString()}</b></span></div><div className="arcade-result-actions"><ActionButton onClick={onExit}>Back to cabinet</ActionButton><ActionButton onClick={() => { setPhase("setup"); setStatus("Adjust the style or run the same difficulty again."); }}>Change loadout</ActionButton><ActionButton className="primary" onClick={() => { setRound((current) => current + 1); setPhase("setup"); setStatus("Next phrase ready. Take a breath, then start when you are set."); }}>Next phrase <Icon name="arrow" size={16} /></ActionButton></div></div>
        </Panel>
      )}
    </section>
  );
}
