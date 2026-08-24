import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSetting, saveAttempt, setSetting } from "@/storage/database";
import { noteLabel } from "@/lib/music-display";
import {
  VOCAL_PROFILE_STORAGE_KEY,
  cleanStableBounds,
  normalizeRangeProfile,
  pitchStableBounds,
  type PersonalRangeProfile,
} from "@/features/range-loop/profile";
import { ActionButton, Eyebrow, Panel, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { PatternChallenge } from "./PatternChallenge";
import { PitchMaze } from "./PitchMaze";
import { PitchPong } from "./PitchPong";
import { Resonance } from "./Resonance";
import { SongRide } from "./SongRide";
import { VoiceDraw } from "./VoiceDraw";
import {
  ARCADE_PROGRESS_STORAGE_KEY,
  DEFAULT_ARCADE_PROGRESS,
  applyArcadeOutcome,
  hasArcadeStageMastery,
  normalizeArcadeProgress,
  recommendArcadeStage,
  type ArcadeProgress,
} from "./arcade-progress";
import {
  DEFAULT_RESONANCE_TUTORIAL_PROGRESS,
  RESONANCE_TUTORIAL_PROGRESS_STORAGE_KEY,
  completedResonanceTutorialLessonCount,
  normalizeResonanceTutorialProgress,
  recordResonanceTutorialAttempt,
  resonanceCombinedChambersUnlocked,
  type ResonanceTutorialAttempt,
  type ResonanceTutorialProgress,
} from "./resonance-tutorial-progress";
import {
  ARCADE_CURRICULUM_STAGES,
  ARCADE_CURRICULUM_STAGE_COPY,
  getArcadeCurriculumStage,
  getArcadeStageMasteryRequirement,
  resolveArcadeCurriculum,
} from "./curriculum";
import type {
  ArcadeCurriculumStage,
  ArcadeDifficultyId,
  ArcadeMode,
  ArcadeOutcome,
  ArcadeVoiceRange,
} from "./types";

const DIFFICULTY_COPY: Record<ArcadeDifficultyId, { label: string; detail: string; multiplier: string }> = {
  easy: { label: "Cruise", detail: "Wide lanes · slower timing", multiplier: "BASE XP" },
  medium: { label: "Locked in", detail: "Tighter pitch · musical pace", multiplier: "BONUS XP" },
  hard: { label: "Arcade", detail: "Precise lanes · fast reactions", multiplier: "MAX XP" },
};

const ARCADE_STAGE_STORAGE_KEY = "voice.arcade.curriculum-stage";
const ARCADE_DIFFICULTY_STORAGE_KEY = "voice.arcade.difficulty";

const MODE_COPY: Record<ArcadeMode, {
  number: string;
  title: string;
  kicker: string;
  description: string;
  skills: string[];
  accent: string;
  button: string;
}> = {
  pattern: {
    number: "03",
    title: "Echo Run",
    kicker: "SIMON × NOTE HIGHWAY",
    description: "Hear a pitch pattern, then drive through the same notes on time. Accuracy, clean transitions, memory, and sustain all feed the combo.",
    skills: ["pitch matching", "interval motion", "rhythm", "memory"],
    accent: "lime",
    button: "Enter the note highway",
  },
  pong: {
    number: "01",
    title: "Pitch Pong",
    kicker: "CONTINUOUS VOICE CONTROL",
    description: "Your sung pitch is the paddle. Glide upward and downward, intercept the ball, and learn to place pitch continuously instead of guessing isolated notes.",
    skills: ["glides", "range navigation", "reaction", "stability"],
    accent: "blue",
    button: "Take the paddle",
  },
  song: {
    number: "04",
    title: "Song Rail",
    kicker: "LOCAL MP3 × TARGET LANES",
    description: "Load a local track. NoteForge builds a playable target chart from local pitch and energy cues, fits it to your range, and scores your voice against moving note lanes.",
    skills: ["phrasing", "song context", "timing", "range transfer"],
    accent: "violet",
    button: "Build a song challenge",
  },
  maze: {
    number: "02",
    title: "Pitch Maze",
    kicker: "FOUR NOTES × CARDINAL CONTROL",
    description: "Four notes become north, east, south, and west. Sustain the note for the direction you want, release to re-arm, and navigate generated mazes that grow with you.",
    skills: ["note recall", "pitch fluency", "sustain", "navigation"],
    accent: "orange",
    button: "Enter the pitch maze",
  },
  resonance: {
    number: "05",
    title: "Resonance",
    kicker: "VOICE FIELD × PHYSICS PUZZLES",
    description: "Shape a local acoustic field with stable pitch and normalized voice energy. Guide a ball through resonators, walls, and goals without brute-force volume.",
    skills: ["resonance", "steady force", "pitch discovery", "field control"],
    accent: "amber",
    button: "Enter Resonance Field School",
  },
  draw: {
    number: "06",
    title: "Vocal Canvas",
    kicker: "EIGHT NOTES × SPATIAL CONTROL",
    description: "Eight neighboring notes steer a live drawing cursor in eight directions. Sing to move, use silence to stop, and turn pitch transitions into lines, shapes, and pictures.",
    skills: ["note fluency", "spatial control", "transitions", "motor planning"],
    accent: "pink",
    button: "Draw with your voice",
  },
};

const ARCADE_MODE_ORDER = ["pong", "maze", "pattern", "song", "resonance", "draw"] as const satisfies readonly ArcadeMode[];

function rangeFromProfile(profile: Readonly<PersonalRangeProfile>): ArcadeVoiceRange {
  const clean = cleanStableBounds(profile);
  const measured = pitchStableBounds(profile);
  // Until the range mapper has real evidence, keep the arcade inside the
  // provisional A2-E3 neighborhood around the default C3 home note. Games can
  // widen automatically once the singer's own map supplies measured bounds.
  let lowMidi = clean.lowMidi ?? measured.lowMidi ?? Math.max(36, profile.baseline.midi - 3);
  let highMidi = clean.highMidi ?? measured.highMidi ?? Math.min(83, profile.baseline.midi + 4);
  lowMidi = Math.min(lowMidi, profile.baseline.midi);
  highMidi = Math.max(highMidi, profile.baseline.midi);
  // The shared loadout guarantees Maze's four distinct notes. Eight-note
  // consumers derive their own bank and explicitly mark any notes outside the
  // measured profile instead of pretending this selector measured them.
  while (highMidi - lowMidi < 3 && (lowMidi > 36 || highMidi < 83)) {
    if (lowMidi > 36 && profile.baseline.midi - lowMidi <= highMidi - profile.baseline.midi) lowMidi -= 1;
    else if (highMidi < 83) highMidi += 1;
    else lowMidi -= 1;
  }
  return {
    lowMidi,
    highMidi,
    baselineMidi: profile.baseline.midi,
  };
}

function normalizeDifficulty(value: unknown): ArcadeDifficultyId {
  return value === "easy" || value === "medium" || value === "hard" ? value : "medium";
}

export function VoiceArcade() {
  const [mode, setMode] = useState<ArcadeMode | null>(null);
  const [difficulty, setDifficulty] = useState<ArcadeDifficultyId>("medium");
  const [curriculumStage, setCurriculumStage] = useState<ArcadeCurriculumStage>("deliberate");
  const [voiceRange, setVoiceRange] = useState<ArcadeVoiceRange>({ lowMidi: 43, highMidi: 55, baselineMidi: 48 });
  const [progress, setProgress] = useState<ArcadeProgress>(DEFAULT_ARCADE_PROGRESS);
  const [resonanceTutorialProgress, setResonanceTutorialProgress] = useState<ResonanceTutorialProgress>(DEFAULT_RESONANCE_TUTORIAL_PROGRESS);
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState("Loading your local voice profile…");
  const [storageWarning, setStorageWarning] = useState("");
  const returnFocusModeRef = useRef<ArcadeMode | null>(null);
  const progressRef = useRef<ArcadeProgress>(DEFAULT_ARCADE_PROGRESS);
  const tutorialProgressRef = useRef<ResonanceTutorialProgress>(DEFAULT_RESONANCE_TUTORIAL_PROGRESS);
  const progressWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const tutorialWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const storageAuthorityRef = useRef({
    progress: false,
    tutorial: false,
    stage: false,
    difficulty: false,
  });
  const reportStorageFailure = useCallback((operation: string) => {
    setStorageWarning(`Local storage failed while ${operation}. Progress shown in this visit may not be saved.`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      getSetting<PersonalRangeProfile>(VOCAL_PROFILE_STORAGE_KEY),
      getSetting<ArcadeProgress>(ARCADE_PROGRESS_STORAGE_KEY),
      getSetting<ResonanceTutorialProgress>(RESONANCE_TUTORIAL_PROGRESS_STORAGE_KEY),
      getSetting<ArcadeCurriculumStage>(ARCADE_STAGE_STORAGE_KEY),
      getSetting<ArcadeDifficultyId>(ARCADE_DIFFICULTY_STORAGE_KEY),
    ]).then(([profileResult, progressResult, resonanceTutorialResult, stageResult, difficultyResult]) => {
      if (cancelled) return;
      storageAuthorityRef.current = {
        progress: progressResult.status === "fulfilled",
        tutorial: resonanceTutorialResult.status === "fulfilled",
        stage: stageResult.status === "fulfilled",
        difficulty: difficultyResult.status === "fulfilled",
      };
      const rejectedReads = [profileResult, progressResult, resonanceTutorialResult, stageResult, difficultyResult]
        .filter((result) => result.status === "rejected").length;
      if (rejectedReads > 0) {
        setStorageWarning(`${rejectedReads} local record${rejectedReads === 1 ? "" : "s"} could not be read. Unread progress will not be overwritten during this visit.`);
      }
      const profile = normalizeRangeProfile(profileResult.status === "fulfilled" ? profileResult.value : undefined);
      const storedProgress = progressResult.status === "fulfilled" ? progressResult.value : undefined;
      const normalizedProgress = normalizeArcadeProgress(storedProgress);
      const normalizedResonanceTutorial = normalizeResonanceTutorialProgress(
        resonanceTutorialResult.status === "fulfilled" ? resonanceTutorialResult.value : undefined,
      );
      setVoiceRange(rangeFromProfile(profile));
      progressRef.current = normalizedProgress;
      tutorialProgressRef.current = normalizedResonanceTutorial;
      setProgress(normalizedProgress);
      setResonanceTutorialProgress(normalizedResonanceTutorial);
      try {
        setCurriculumStage(getArcadeCurriculumStage(stageResult.status === "fulfilled" ? stageResult.value : undefined));
      } catch {
        setCurriculumStage("deliberate");
      }
      setDifficulty(normalizeDifficulty(difficultyResult.status === "fulfilled" ? difficultyResult.value : undefined));
      if (cancelled) return;
      setNotice(profile.baseline.source === "default"
        ? "Using a conservative C3-centered starter range. Range Simulator will personalize future cabinets."
        : `Voice profile loaded around ${noteLabel(profile.baseline.midi)}. Every cabinet is fitted to your current map.`);
      setHydrated(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated || !storageAuthorityRef.current.stage) return;
    void setSetting(ARCADE_STAGE_STORAGE_KEY, curriculumStage)
      .catch(() => reportStorageFailure("saving the curriculum stage"));
  }, [curriculumStage, hydrated, reportStorageFailure]);

  useEffect(() => {
    if (!hydrated || !storageAuthorityRef.current.difficulty) return;
    void setSetting(ARCADE_DIFFICULTY_STORAGE_KEY, difficulty)
      .catch(() => reportStorageFailure("saving arcade difficulty"));
  }, [difficulty, hydrated, reportStorageFailure]);

  const recordOutcome = useCallback((outcome: ArcadeOutcome) => {
    const completedAt = new Date().toISOString();
    const nextProgress = applyArcadeOutcome(progressRef.current, outcome, completedAt);
    progressRef.current = nextProgress;
    setProgress(nextProgress);
    if (storageAuthorityRef.current.progress) {
      progressWriteChainRef.current = progressWriteChainRef.current
        .catch(() => undefined)
        .then(() => setSetting(ARCADE_PROGRESS_STORAGE_KEY, nextProgress))
        .catch(() => reportStorageFailure("saving arcade progress"));
    }
    void saveAttempt({
      id: crypto.randomUUID(),
      exerciseType: `voice-arcade:${outcome.mode}`,
      target: {
        difficulty,
        curriculumStage: outcome.curriculumStage,
        variant: outcome.variant,
        voiceRange,
        grade: outcome.grade,
      },
      metrics: {
        score: outcome.score,
        accuracy: outcome.accuracy,
        bestCombo: outcome.bestCombo,
        xp: outcome.xp,
        durationMs: outcome.durationMs,
        ...outcome.details,
      },
      startedAt: new Date(Date.now() - outcome.durationMs).toISOString(),
      completedAt,
    }).catch(() => reportStorageFailure("saving the completed attempt"));
  }, [curriculumStage, difficulty, reportStorageFailure, voiceRange]);

  const recordTutorialAttempt = useCallback((
    attempt: ResonanceTutorialAttempt,
    completedAt: string,
  ) => {
    const nextProgress = recordResonanceTutorialAttempt(
      tutorialProgressRef.current,
      attempt,
      completedAt,
    );
    tutorialProgressRef.current = nextProgress;
    setResonanceTutorialProgress(nextProgress);
    if (storageAuthorityRef.current.tutorial) {
      tutorialWriteChainRef.current = tutorialWriteChainRef.current
        .catch(() => undefined)
        .then(() => setSetting(RESONANCE_TUTORIAL_PROGRESS_STORAGE_KEY, nextProgress))
        .catch(() => reportStorageFailure("saving Field School progress"));
    }
  }, [reportStorageFailure]);

  const exitActiveMode = useCallback(() => {
    returnFocusModeRef.current = mode;
    setMode(null);
  }, [mode]);

  useEffect(() => {
    if (mode !== null || returnFocusModeRef.current === null) return undefined;
    const returnMode = returnFocusModeRef.current;
    returnFocusModeRef.current = null;
    const focusFrame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`button[data-arcade-mode="${returnMode}"]`)
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [mode]);

  const rangeOptions = useMemo(() => Array.from({ length: 48 }, (_, index) => 36 + index), []);
  const activeCopy = mode ? MODE_COPY[mode] : null;
  const activeCurriculum = mode ? resolveArcadeCurriculum(mode, curriculumStage) : null;
  const resonanceFoundationsCompleted = completedResonanceTutorialLessonCount(resonanceTutorialProgress);
  const resonanceChambersReady = resonanceCombinedChambersUnlocked(resonanceTutorialProgress);

  if (mode && activeCopy && activeCurriculum) {
    return (
      <div className={`page arcade-page arcade-mode-page mode-${mode} curriculum-${curriculumStage}`}>
        <div className="arcade-game-topbar">
          <ActionButton onClick={exitActiveMode}><Icon name="arrow" size={16} /> Back to cabinet</ActionButton>
          <div><span>{activeCurriculum.stageLabel.toUpperCase()} · {activeCopy.kicker}</span><strong>{activeCopy.title}</strong></div>
          <div className="arcade-live-profile"><span>VOICE MAP</span><b>{noteLabel(voiceRange.lowMidi)}–{noteLabel(voiceRange.highMidi)}</b><small>{activeCurriculum.stageLabel} · {DIFFICULTY_COPY[difficulty].label}</small></div>
        </div>
        {storageWarning && <div className="error-banner"><strong>Local progress storage needs attention.</strong><span>{storageWarning}</span></div>}
        {mode === "pattern" && <PatternChallenge difficulty={difficulty} curriculumStage={curriculumStage} voiceRange={voiceRange} onExit={exitActiveMode} onComplete={recordOutcome} />}
        {mode === "pong" && <PitchPong difficulty={difficulty} curriculumStage={curriculumStage} voiceRange={voiceRange} onExit={exitActiveMode} onComplete={recordOutcome} />}
        {mode === "song" && <SongRide difficulty={difficulty} curriculumStage={curriculumStage} voiceRange={voiceRange} onExit={exitActiveMode} onComplete={recordOutcome} />}
        {mode === "maze" && <PitchMaze difficulty={difficulty} curriculumStage={curriculumStage} voiceRange={voiceRange} onExit={exitActiveMode} onComplete={recordOutcome} />}
        {mode === "resonance" && <Resonance difficulty={difficulty} curriculumStage={curriculumStage} voiceRange={voiceRange} tutorialProgress={resonanceTutorialProgress} onTutorialAttempt={recordTutorialAttempt} onExit={exitActiveMode} onComplete={recordOutcome} />}
        {mode === "draw" && <VoiceDraw difficulty={difficulty} curriculumStage={curriculumStage} voiceRange={voiceRange} onExit={exitActiveMode} onComplete={recordOutcome} />}
      </div>
    );
  }

  return (
    <div className="page arcade-page">
      {storageWarning && <div className="error-banner"><strong>Local progress storage needs attention.</strong><span>{storageWarning}</span></div>}
      <section className="arcade-hero">
        <div className="arcade-hero-copy">
          <Eyebrow>Pitch is no longer a reading · it is the controller</Eyebrow>
          <h1>Your voice moves the game.</h1>
          <p>Concrete pitch skill through reaction, memory, navigation, rhythm, spatial creation, continuous control, and acoustic physics. Every cabinet reads the same local microphone detector; no raw voice audio leaves the device.</p>
          <div className="arcade-hero-tags"><span>VOICE INPUT</span><i /> <span>REAL-TIME PITCH</span><i /> <span>SKILL XP</span></div>
          <ActionButton className="arcade-hero-feature" disabled={!hydrated} onClick={() => setMode("draw")}><span>NEW CABINET</span><b>Vocal Canvas</b><small>Draw with eight sung directions</small><Icon name="arrow" size={16} /></ActionButton>
        </div>
        <div className="arcade-level-card" aria-label={`${progress.totalXp} total voice arcade experience points`}>
          <span>VOICE ARCADE · LOCAL PROFILE</span>
          <strong>{progress.totalXp.toLocaleString()}<small> XP</small></strong>
          <div><i style={{ width: `${progress.totalXp % 500 / 5}%` }} /></div>
          <p>{progress.gamesPlayed} challenges played · selected stage: {ARCADE_CURRICULUM_STAGE_COPY[curriculumStage].label}</p>
        </div>
      </section>

      <Panel className="arcade-loadout">
        <div>
          <Eyebrow>Cabinet loadout</Eyebrow>
          <h2>Fit the games to today’s voice.</h2>
          <p>{notice}</p>
        </div>
        <div className="arcade-difficulty" role="radiogroup" aria-label="Arcade difficulty">
          {(Object.keys(DIFFICULTY_COPY) as ArcadeDifficultyId[]).map((id) => (
            <button type="button" role="radio" aria-checked={difficulty === id} className={difficulty === id ? "active" : ""} key={id} onClick={() => setDifficulty(id)}>
              <span>{DIFFICULTY_COPY[id].label}</span><small>{DIFFICULTY_COPY[id].detail}</small><b>{DIFFICULTY_COPY[id].multiplier}</b>
            </button>
          ))}
        </div>
        <div className="arcade-range-fields">
          <Select label="Controller floor" value={voiceRange.lowMidi} onChange={(event) => setVoiceRange((current) => ({ ...current, lowMidi: Math.min(Number(event.target.value), current.highMidi - 3) }))}>
            {rangeOptions.filter((midi) => midi < voiceRange.highMidi).map((midi) => <option key={midi} value={midi}>{noteLabel(midi)}</option>)}
          </Select>
          <Select label="Controller ceiling" value={voiceRange.highMidi} onChange={(event) => setVoiceRange((current) => ({ ...current, highMidi: Math.max(Number(event.target.value), current.lowMidi + 3) }))}>
            {rangeOptions.filter((midi) => midi > voiceRange.lowMidi).map((midi) => <option key={midi} value={midi}>{noteLabel(midi)}</option>)}
          </Select>
        </div>
        <div className="arcade-curriculum-selector">
          <div><Eyebrow>Control curriculum</Eyebrow><h3>Move correction out of conscious attention.</h3><p>Stage and mechanical intensity are independent. A stage changes visible assistance and cognitive workload; it never weakens microphone evidence rules.</p></div>
          <div className="arcade-curriculum-stages" role="radiogroup" aria-label="Vocal control curriculum stage">
            {ARCADE_CURRICULUM_STAGES.map((stage, index) => {
              const stageCopy = ARCADE_CURRICULUM_STAGE_COPY[stage];
              const feedback = resolveArcadeCurriculum("pong", stage).feedback;
              return (
                <button type="button" role="radio" aria-checked={curriculumStage === stage} className={curriculumStage === stage ? "active" : ""} key={stage} onClick={() => setCurriculumStage(stage)}>
                  <span>{String(index + 1).padStart(2, "0")}</span><b>{stageCopy.label}</b><small>{stageCopy.summary}</small><em>{feedback.level === "full" ? "FULL TUNER + LABELS" : feedback.level === "reduced" ? "DIRECTIONAL CORRECTION" : "GAME-FIRST FEEDBACK"}</em>
                </button>
              );
            })}
          </div>
        </div>
      </Panel>

      <div className="arcade-cabinet-grid">
        {ARCADE_MODE_ORDER.map((id) => {
          const copy = MODE_COPY[id];
          const requirement = getArcadeStageMasteryRequirement(id, curriculumStage);
          const evidence = progress.masteryByMode[id][curriculumStage];
          const mastered = hasArcadeStageMastery(progress, id, curriculumStage);
          const recommended = recommendArcadeStage(progress, id);
          return (
            <Panel className={`arcade-cabinet mode-${id} accent-${copy.accent}`} key={id}>
              <div className="arcade-cabinet-screen" aria-hidden="true">
                {id === "pattern" && <div className="arcade-demo-highway">{[0, 1, 2, 3, 4].map((index) => <i key={index} style={{ "--demo-index": index } as React.CSSProperties} />)}<span /></div>}
                {id === "pong" && <div className="arcade-demo-pong"><i /><i /><b /><span /></div>}
                {id === "song" && <div className="arcade-demo-song">{[.7, .35, .55, .2, .65].map((position, index) => <i key={index} style={{ "--demo-note": position, "--demo-time": index } as React.CSSProperties} />)}<span /></div>}
                {id === "maze" && <div className="arcade-demo-maze"><i /><i /><i /><i /><i /><i /><i /><i /><i /><b /><span /></div>}
                {id === "resonance" && <div className="arcade-demo-resonance"><i /><i /><i /><b /><span /></div>}
                {id === "draw" && <div className="arcade-demo-draw" aria-hidden="true"><svg viewBox="0 0 240 160"><path d="M28 128 L62 88 L98 112 L137 55 L181 73 L211 34" /><circle cx="211" cy="34" r="7" /><text x="136" y="28">G3 ↗</text></svg></div>}
              </div>
              <div className="arcade-cabinet-title"><span>{copy.number}</span><div><small>{copy.kicker}</small><h2>{copy.title}</h2></div><strong>{progress.bestByMode[id] ? `BEST ${progress.bestByMode[id]}` : "NEW"}</strong></div>
              <p>{copy.description}</p>
              <div className="arcade-skill-chips">{copy.skills.map((skill) => <span key={skill}>{skill}</span>)}</div>
              {id === "resonance" && (
                <div className={`resonance-cabinet-foundations ${resonanceChambersReady ? "complete" : "active"}`}>
                  <span><b>{resonanceFoundationsCompleted}/12 FIELD SCHOOL PROOFS</b><small>{resonanceChambersReady ? "Combined chambers unlocked" : "Discover → Control → Apply for each mechanic"}</small></span>
                  <div role="progressbar" aria-label="Resonance Field School progress" aria-valuemin={0} aria-valuemax={12} aria-valuenow={resonanceFoundationsCompleted}><i style={{ width: `${resonanceFoundationsCompleted / 12 * 100}%` }} /></div>
                </div>
              )}
              <div className={`arcade-cabinet-mastery ${mastered ? "mastered" : ""}`}>
                <span><b>{mastered ? "STAGE PROVEN" : `${evidence.qualifyingRuns}/${requirement.requiredRuns} PROOFS`}</b><small>{requirement.minimumScore}+ score · {ARCADE_CURRICULUM_STAGE_COPY[curriculumStage].label}</small></span>
                <span><b>NEXT FIT</b><small>{ARCADE_CURRICULUM_STAGE_COPY[recommended].label}</small></span>
              </div>
              <ActionButton data-arcade-mode={id} className="primary wide" disabled={!hydrated} onClick={() => setMode(id)}>{copy.button} <Icon name="arrow" size={16} /></ActionButton>
            </Panel>
          );
        })}
      </div>

    </div>
  );
}
