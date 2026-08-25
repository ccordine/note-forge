import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import "../../styles-arcade.css";
import "../../styles-arcade-previews.css";
import "../../styles-arcade-game.css";
import "../../styles-arcade-result.css";
import "../../styles-arcade-responsive.css";
import "../../styles-arcade-compact.css";
import { saveAttempt } from "@/storage/database";
import { SettingsPersistence } from "@/storage/settings-persistence";
import { noteLabel } from "@/lib/music-display";
import { useAppNavigation } from "@/routing/use-app-navigation";
import {
  VOCAL_PROFILE_STORAGE_KEY,
  normalizeRangeProfile,
  usableRangeBounds,
  type PersonalRangeProfile,
} from "@/features/range-loop/profile";
import { Eyebrow, Panel, RouteLink, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import {
  ARCADE_GAME_DEFINITIONS,
  ARCADE_FEATURED_GAME,
  ARCADE_MODE_ORDER,
} from "./arcade-registry";
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
type ArcadeStorageKey =
  | typeof VOCAL_PROFILE_STORAGE_KEY
  | typeof ARCADE_PROGRESS_STORAGE_KEY
  | typeof ARCADE_STAGE_STORAGE_KEY
  | typeof ARCADE_DIFFICULTY_STORAGE_KEY;

type ArcadeProgressAction =
  | Readonly<{ type: "hydrate"; value: ArcadeProgress }>
  | Readonly<{ type: "record"; outcome: ArcadeOutcome; completedAt: string }>;

function reduceArcadeProgress(
  state: Readonly<ArcadeProgress>,
  action: ArcadeProgressAction,
): ArcadeProgress {
  switch (action.type) {
    case "hydrate":
      return action.value;
    case "record":
      return applyArcadeOutcome(state, action.outcome, action.completedAt);
  }
}

function rangeFromProfile(profile: Readonly<PersonalRangeProfile>): ArcadeVoiceRange {
  const measured = usableRangeBounds(profile);
  // Until the range mapper has real evidence, keep the arcade inside the
  // provisional A2-E3 neighborhood around the default C3 home note. Games can
  // widen automatically once the singer's own map supplies measured bounds.
  let lowMidi = measured.lowMidi ?? Math.max(36, profile.baseline.midi - 3);
  let highMidi = measured.highMidi ?? Math.min(83, profile.baseline.midi + 4);
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

function curriculumFeedbackLabel(level: "full" | "reduced" | "gameplay"): string {
  if (level === "full") return "FULL TUNER + LABELS";
  if (level === "reduced") return "DIRECTIONAL CORRECTION";
  return "GAME-FIRST FEEDBACK";
}

export function VoiceArcade() {
  const { route, navigate } = useAppNavigation();
  const mode: ArcadeMode | null = route.surface === "arcade" && route.activity !== "cabinet" ? route.activity : null;
  const [difficulty, setDifficulty] = useState<ArcadeDifficultyId>("medium");
  const [curriculumStage, setCurriculumStage] = useState<ArcadeCurriculumStage>("deliberate");
  const [voiceRange, setVoiceRange] = useState<ArcadeVoiceRange>({ lowMidi: 43, highMidi: 55, baselineMidi: 48 });
  const [progress, dispatchProgress] = useReducer(reduceArcadeProgress, DEFAULT_ARCADE_PROGRESS);
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState("Loading your local voice profile…");
  const [storageWarning, setStorageWarning] = useState("");
  const returnFocusModeRef = useRef<ArcadeMode | null>(null);
  const persistenceRef = useRef<SettingsPersistence<ArcadeStorageKey> | null>(null);
  if (persistenceRef.current === null) {
    persistenceRef.current = new SettingsPersistence([
      VOCAL_PROFILE_STORAGE_KEY,
      ARCADE_PROGRESS_STORAGE_KEY,
      ARCADE_STAGE_STORAGE_KEY,
      ARCADE_DIFFICULTY_STORAGE_KEY,
    ]);
  }
  const persistence = persistenceRef.current;
  const reportStorageFailure = useCallback((operation: string) => {
    setStorageWarning(`Local storage failed while ${operation}. Progress shown in this visit may not be saved.`);
  }, []);

  useEffect(() => {
    void persistence.load().then((stored) => {
      if (!stored) return;
      const rejectedReads = 4 - stored.readableKeys.size;
      if (rejectedReads > 0) {
        setStorageWarning(`${rejectedReads} local record${rejectedReads === 1 ? "" : "s"} could not be read. Unread progress will not be overwritten during this visit.`);
      }
      const profile = normalizeRangeProfile(stored.values[VOCAL_PROFILE_STORAGE_KEY]);
      const normalizedProgress = normalizeArcadeProgress(stored.values[ARCADE_PROGRESS_STORAGE_KEY]);
      setVoiceRange(rangeFromProfile(profile));
      dispatchProgress({ type: "hydrate", value: normalizedProgress });
      try {
        setCurriculumStage(getArcadeCurriculumStage(stored.values[ARCADE_STAGE_STORAGE_KEY]));
      } catch {
        setCurriculumStage("deliberate");
      }
      setDifficulty(normalizeDifficulty(stored.values[ARCADE_DIFFICULTY_STORAGE_KEY]));
      setNotice(profile.baseline.source === "default"
        ? "Using a conservative C3-centered starter range. Range Simulator will personalize future cabinets."
        : `Voice profile loaded around ${noteLabel(profile.baseline.midi)}. Every cabinet is fitted to your current map.`);
      setHydrated(true);
    });
    return () => persistence.dispose();
  }, [persistence]);

  useEffect(() => {
    if (!hydrated) return;
    persistence.save([
      { key: ARCADE_PROGRESS_STORAGE_KEY, value: progress },
      { key: ARCADE_STAGE_STORAGE_KEY, value: curriculumStage },
      { key: ARCADE_DIFFICULTY_STORAGE_KEY, value: difficulty },
    ], (result) => {
      if (result === "error") reportStorageFailure("saving arcade settings");
    });
  }, [curriculumStage, difficulty, hydrated, persistence, progress, reportStorageFailure]);

  const recordOutcome = useCallback((outcome: ArcadeOutcome) => {
    const completedAt = new Date().toISOString();
    dispatchProgress({ type: "record", outcome, completedAt });
    void saveAttempt({
      id: crypto.randomUUID(),
      exerciseType: `voice-arcade:${outcome.mode}`,
      target: {
        difficulty,
        curriculumStage: outcome.curriculumStage,
        variant: outcome.variant,
        completedVariant: outcome.completedVariant,
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
  }, [difficulty, reportStorageFailure, voiceRange]);

  const exitActiveMode = useCallback(() => {
    returnFocusModeRef.current = mode;
    navigate({ surface: "arcade", activity: "cabinet" });
  }, [mode, navigate]);

  useEffect(() => {
    if (mode !== null || returnFocusModeRef.current === null) return undefined;
    const returnMode = returnFocusModeRef.current;
    returnFocusModeRef.current = null;
    const focusFrame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLAnchorElement>(`a[data-arcade-mode="${returnMode}"]`)
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [mode]);

  const rangeOptions = useMemo(() => Array.from({ length: 48 }, (_, index) => 36 + index), []);
  const activeCopy = mode ? ARCADE_GAME_DEFINITIONS[mode] : null;
  const activeCurriculum = mode ? resolveArcadeCurriculum(mode, curriculumStage) : null;
  const ActiveGame = activeCopy?.component ?? null;

  // IndexedDB owns the saved vocal profile, difficulty, and curriculum. The
  // cabinet range begins from that profile, while the two visible range
  // selectors are deliberately a temporary loadout for this visit. A deep
  // link must not construct a game from placeholders before those saved
  // authorities have loaded.
  if (!hydrated) {
    return (
      <div className="page arcade-page" data-arcade-hydration="pending">
        <Panel className="arcade-loadout" role="status" aria-live="polite">
          <Eyebrow>Voice Arcade</Eyebrow>
          <h1>Loading your cabinet settings…</h1>
          <p>Your saved vocal map, control stage, and difficulty are being restored before any game runtime starts.</p>
        </Panel>
      </div>
    );
  }

  if (mode && activeCopy && activeCurriculum && ActiveGame) {
    return (
      <div className={`page arcade-page arcade-mode-page mode-${mode} curriculum-${curriculumStage}`}>
        <div className="arcade-game-topbar">
          <RouteLink className="action-button" route={{ surface: "arcade", activity: "cabinet" }} onClick={() => { returnFocusModeRef.current = mode; }}><Icon name="arrow" size={16} /> Back to cabinet</RouteLink>
          <div><span>{activeCurriculum.stageLabel.toUpperCase()} · {activeCopy.kicker}</span><strong>{activeCopy.title}</strong></div>
          <div className="arcade-live-profile"><span>VOICE MAP</span><b>{noteLabel(voiceRange.lowMidi)}–{noteLabel(voiceRange.highMidi)}</b><small>{activeCurriculum.stageLabel} · {DIFFICULTY_COPY[difficulty].label}</small></div>
        </div>
        {storageWarning && <div className="error-banner"><strong>Local progress storage needs attention.</strong><span>{storageWarning}</span></div>}
        <Suspense fallback={<Panel><strong>Loading cabinet…</strong></Panel>}>
          <ActiveGame
            difficulty={difficulty}
            curriculumStage={curriculumStage}
            voiceRange={voiceRange}
            completedVariants={progress.completedVariantsByMode[mode]}
            onExit={exitActiveMode}
            onComplete={recordOutcome}
          />
        </Suspense>
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
          <RouteLink className="action-button arcade-hero-feature" route={{ surface: "arcade", activity: ARCADE_FEATURED_GAME.mode }}><span>FEATURED CABINET</span><b>{ARCADE_FEATURED_GAME.title}</b><small>{ARCADE_FEATURED_GAME.detail}</small><Icon name="arrow" size={16} /></RouteLink>
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
          <p>{notice} Controller floor and ceiling are temporary for this visit; they never overwrite your saved Vocal Map.</p>
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
              const feedbackLabel = curriculumFeedbackLabel(feedback.level);
              return (
                <button type="button" role="radio" aria-checked={curriculumStage === stage} className={curriculumStage === stage ? "active" : ""} key={stage} onClick={() => setCurriculumStage(stage)}>
                  <span>{String(index + 1).padStart(2, "0")}</span><b>{stageCopy.label}</b><small>{stageCopy.summary}</small><em>{feedbackLabel}</em>
                </button>
              );
            })}
          </div>
        </div>
      </Panel>

      <div className="arcade-cabinet-grid">
        {ARCADE_MODE_ORDER.map((id) => {
          const copy = ARCADE_GAME_DEFINITIONS[id];
          const Preview = copy.preview;
          const requirement = getArcadeStageMasteryRequirement(id, curriculumStage);
          const evidence = progress.masteryByMode[id][curriculumStage];
          const mastered = hasArcadeStageMastery(progress, id, curriculumStage);
          const recommended = recommendArcadeStage(progress, id);
          return (
            <Panel className={`arcade-cabinet mode-${id} accent-${copy.accent}`} key={id}>
              <div className="arcade-cabinet-screen" aria-hidden="true">
                <Preview />
              </div>
              <div className="arcade-cabinet-title"><span>{copy.number}</span><div><small>{copy.kicker}</small><h2>{copy.title}</h2></div><strong>{progress.bestByMode[id] ? `BEST ${progress.bestByMode[id]}` : "NEW"}</strong></div>
              <p>{copy.description}</p>
              <div className="arcade-skill-chips">{copy.skills.map((skill) => <span key={skill}>{skill}</span>)}</div>
              <div className={`arcade-cabinet-mastery ${mastered ? "mastered" : ""}`}>
                <span><b>{mastered ? "STAGE PROVEN" : `${evidence.qualifyingRuns}/${requirement.requiredRuns} PROOFS`}</b><small>{requirement.minimumScore}+ score · {ARCADE_CURRICULUM_STAGE_COPY[curriculumStage].label}</small></span>
                <span><b>NEXT FIT</b><small>{ARCADE_CURRICULUM_STAGE_COPY[recommended].label}</small></span>
              </div>
              <RouteLink data-arcade-mode={id} className="action-button primary wide" route={{ surface: "arcade", activity: id }}>{copy.button} <Icon name="arrow" size={16} /></RouteLink>
            </Panel>
          );
        })}
      </div>

    </div>
  );
}
