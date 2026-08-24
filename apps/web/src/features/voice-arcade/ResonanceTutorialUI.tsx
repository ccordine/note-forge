import {
  useId,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { Icon } from "@/ui/Icon";

export type ResonanceTutorialPuzzleKind = "discover" | "control" | "apply";
export type ResonanceTutorialItemState = "complete" | "current" | "available" | "locked";
export type ResonanceTutorialObjectiveState = "waiting" | "active" | "paused" | "complete";

export interface ResonanceTutorialPuzzleCard {
  readonly id: string;
  readonly kind: ResonanceTutorialPuzzleKind;
  readonly title: string;
  readonly objective: string;
  readonly state: ResonanceTutorialItemState;
  readonly bestScore?: number | null;
  readonly lockReason?: string;
}

export interface ResonanceTutorialMechanicCard {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly principle: string;
  readonly state: ResonanceTutorialItemState;
  readonly puzzles: readonly ResonanceTutorialPuzzleCard[];
}

const KIND_LABELS: Readonly<Record<ResonanceTutorialPuzzleKind, string>> = {
  discover: "Discover",
  control: "Control",
  apply: "Apply",
};

const ITEM_STATE_LABELS: Readonly<Record<ResonanceTutorialItemState, string>> = {
  complete: "Complete",
  current: "Next lesson",
  available: "Available",
  locked: "Locked",
};

function puzzleMarker(puzzle: Readonly<ResonanceTutorialPuzzleCard>, index: number): ReactNode {
  if (puzzle.state === "complete") return <span aria-hidden="true">✓</span>;
  if (puzzle.state === "locked") return <Icon name="lock" size={14} />;
  return <span aria-hidden="true">{index + 1}</span>;
}

interface ResonanceTutorialPathProps {
  mechanics: readonly ResonanceTutorialMechanicCard[];
  completedPuzzles: number;
  totalPuzzles: number;
  onSelectPuzzle: (puzzleId: string) => void;
}

/**
 * Compact course map for the Resonance setup screen. This component only
 * presents authored progression; the curriculum model remains responsible for
 * deciding which lesson is current, available, complete, or locked.
 */
export function ResonanceTutorialPath({
  mechanics,
  completedPuzzles,
  totalPuzzles,
  onSelectPuzzle,
}: ResonanceTutorialPathProps) {
  const titleId = useId();
  const boundedTotal = Math.max(1, Math.round(totalPuzzles));
  const boundedCompleted = Math.min(boundedTotal, Math.max(0, Math.round(completedPuzzles)));
  const completionPercent = boundedCompleted / boundedTotal * 100;

  return (
    <section className="resonance-tutorial-path" aria-labelledby={titleId}>
      <header className="resonance-tutorial-path__header">
        <div>
          <span>RESONANCE FOUNDATIONS</span>
          <h2 id={titleId}>Learn one physical rule at a time.</h2>
          <p>Each mechanic gets three isolated proofs before it can appear in a combined chamber.</p>
        </div>
        <div className="resonance-tutorial-path__total">
          <strong>{boundedCompleted}/{boundedTotal}</strong>
          <span>PUZZLES PROVEN</span>
        </div>
      </header>

      <div
        className="resonance-tutorial-path__meter"
        role="progressbar"
        aria-label="Resonance foundations progress"
        aria-valuemin={0}
        aria-valuemax={boundedTotal}
        aria-valuenow={boundedCompleted}
        aria-valuetext={`${boundedCompleted} of ${boundedTotal} onboarding puzzles complete`}
        style={{ "--resonance-tutorial-progress": `${completionPercent}%` } as React.CSSProperties}
      >
        <i />
      </div>

      <ol className="resonance-tutorial-mechanics">
        {mechanics.map((mechanic) => (
          <li
            key={mechanic.id}
            className={`resonance-tutorial-mechanic ${mechanic.state}`}
            data-mechanic={mechanic.id}
          >
            <header>
              <span className="resonance-tutorial-mechanic__number">{String(mechanic.number).padStart(2, "0")}</span>
              <div>
                <h3>{mechanic.title}</h3>
                <p>{mechanic.principle}</p>
              </div>
              <b>{ITEM_STATE_LABELS[mechanic.state]}</b>
            </header>
            <ol className="resonance-tutorial-puzzles" aria-label={`${mechanic.title} lessons`}>
              {mechanic.puzzles.map((puzzle, index) => {
                const card = (
                  <>
                    <span className="resonance-tutorial-puzzle__marker">{puzzleMarker(puzzle, index)}</span>
                    <span className="resonance-tutorial-puzzle__copy">
                      <b>{KIND_LABELS[puzzle.kind]} · {puzzle.title}</b>
                      <small>{puzzle.state === "locked" && puzzle.lockReason ? puzzle.lockReason : puzzle.objective}</small>
                    </span>
                    <span className="resonance-tutorial-puzzle__result">
                      {puzzle.state === "complete" && puzzle.bestScore !== null && puzzle.bestScore !== undefined
                        ? `${Math.round(puzzle.bestScore)} best`
                        : ITEM_STATE_LABELS[puzzle.state]}
                    </span>
                  </>
                );

                return (
                  <li key={puzzle.id} className={puzzle.state}>
                    {puzzle.state === "locked" ? (
                      <div className="resonance-tutorial-puzzle" aria-disabled="true">
                        {card}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="resonance-tutorial-puzzle"
                        aria-label={`${KIND_LABELS[puzzle.kind]}: ${puzzle.title}. ${ITEM_STATE_LABELS[puzzle.state]}. ${puzzle.objective}`}
                        onClick={() => onSelectPuzzle(puzzle.id)}
                      >
                        {card}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
    </section>
  );
}

interface ResonanceLessonProgressProps {
  activePuzzleIndex: number;
  completedPuzzleCount?: number;
  label?: string;
}

/** The invariant three-puzzle rhythm shown inside every mechanic lesson. */
export function ResonanceLessonProgress({
  activePuzzleIndex,
  completedPuzzleCount = activePuzzleIndex,
  label = "Mechanic lesson progress",
}: ResonanceLessonProgressProps) {
  return (
    <ol className="resonance-lesson-progress" aria-label={label}>
      {(Object.keys(KIND_LABELS) as ResonanceTutorialPuzzleKind[]).map((kind, index) => {
        const complete = index < completedPuzzleCount;
        const current = index === activePuzzleIndex;
        return (
          <li
            key={kind}
            className={complete ? "complete" : current ? "current" : "pending"}
            aria-current={current ? "step" : undefined}
          >
            <span aria-hidden="true">{complete ? "✓" : index + 1}</span>
            <b>{KIND_LABELS[kind]}</b>
          </li>
        );
      })}
    </ol>
  );
}

interface ResonanceLessonBriefProps extends PropsWithChildren {
  mechanicLabel: string;
  puzzleKind: ResonanceTutorialPuzzleKind;
  puzzleIndex: number;
  title: string;
  instruction: string;
  ruleInput: string;
  ruleOutput: string;
  success: string;
  normalized: readonly string[];
  demonstration?: ReactNode;
}

/** One-cause briefing shown before microphone capture or physics begins. */
export function ResonanceLessonBrief({
  mechanicLabel,
  puzzleKind,
  puzzleIndex,
  title,
  instruction,
  ruleInput,
  ruleOutput,
  success,
  normalized,
  demonstration,
  children,
}: ResonanceLessonBriefProps) {
  return (
    <section className="resonance-lesson-brief">
      <ResonanceLessonProgress activePuzzleIndex={puzzleIndex} />
      <div className="resonance-lesson-brief__copy">
        <span>{mechanicLabel.toUpperCase()} · {KIND_LABELS[puzzleKind].toUpperCase()}</span>
        <h3>{title}</h3>
        <p>{instruction}</p>
      </div>

      <div className="resonance-causal-rule" aria-label={`${ruleInput} causes ${ruleOutput}`}>
        <div><span>YOU CHANGE</span><strong>{ruleInput}</strong></div>
        <Icon name="arrow" size={24} />
        <div><span>THE ROOM CHANGES</span><strong>{ruleOutput}</strong></div>
      </div>

      {demonstration && <div className="resonance-lesson-demonstration">{demonstration}</div>}

      <div className="resonance-lesson-contract">
        <div>
          <span>YOUR ONE JOB</span>
          <b>{success}</b>
        </div>
        <div>
          <span>HELD CONSTANT FOR THIS PUZZLE</span>
          <ul>{normalized.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      </div>
      {children}
    </section>
  );
}

interface ResonanceTutorialObjectiveProps {
  mechanicLabel: string;
  puzzleKind: ResonanceTutorialPuzzleKind;
  puzzleIndex: number;
  title: string;
  instruction: string;
  metricLabel: string;
  metricValue: string;
  progress: number;
  progressText: string;
  state: ResonanceTutorialObjectiveState;
  hint?: string;
}

/**
 * Single live objective for a tutorial chamber. It intentionally owns no live
 * region: the game should announce only debounced state changes through its
 * existing accessible-status channel, never every pitch frame.
 */
export function ResonanceTutorialObjective({
  mechanicLabel,
  puzzleKind,
  puzzleIndex,
  title,
  instruction,
  metricLabel,
  metricValue,
  progress,
  progressText,
  state,
  hint,
}: ResonanceTutorialObjectiveProps) {
  const boundedProgress = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return (
    <section className={`resonance-tutorial-objective ${state}`} aria-label={`${mechanicLabel} tutorial objective`}>
      <header>
        <div>
          <span>PUZZLE {puzzleIndex + 1} OF 3 · {KIND_LABELS[puzzleKind].toUpperCase()}</span>
          <h3>{title}</h3>
          <p>{instruction}</p>
        </div>
        <div className="resonance-tutorial-objective__state">
          <span>{state === "complete" ? "PROVEN" : state === "paused" ? "PAUSED" : state === "active" ? "RESPONDING" : "LISTENING"}</span>
          <b>{metricValue}</b>
          <small>{metricLabel}</small>
        </div>
      </header>
      <div
        className="resonance-tutorial-objective__meter"
        role="meter"
        aria-label={metricLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(boundedProgress * 100)}
        aria-valuetext={progressText}
        style={{ "--resonance-objective-progress": `${boundedProgress * 100}%` } as React.CSSProperties}
      >
        <i />
        <em />
      </div>
      <footer>
        <span>{progressText}</span>
        {hint && <small><Icon name="spark" size={14} /> {hint}</small>}
      </footer>
    </section>
  );
}

export interface ResonanceTutorialEvidence {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}

interface ResonanceTutorialProofProps extends PropsWithChildren {
  passed: boolean;
  mechanicLabel: string;
  puzzleKind: ResonanceTutorialPuzzleKind;
  title: string;
  summary: string;
  primaryValue: string;
  primaryLabel: string;
  evidence: readonly ResonanceTutorialEvidence[];
  unlock?: string | null;
}

/** Puzzle-specific transfer proof; no unrelated chamber score dump. */
export function ResonanceTutorialProof({
  passed,
  mechanicLabel,
  puzzleKind,
  title,
  summary,
  primaryValue,
  primaryLabel,
  evidence,
  unlock,
  children,
}: ResonanceTutorialProofProps) {
  return (
    <section className={`resonance-tutorial-proof ${passed ? "passed" : "retry"}`}>
      <div className="resonance-tutorial-proof__mark" aria-hidden="true">{passed ? "✓" : "↻"}</div>
      <div className="resonance-tutorial-proof__copy">
        <span>{mechanicLabel.toUpperCase()} · {KIND_LABELS[puzzleKind].toUpperCase()} PROOF</span>
        <h3>{title}</h3>
        <p>{summary}</p>
      </div>
      <div className="resonance-tutorial-proof__primary">
        <strong>{primaryValue}</strong>
        <span>{primaryLabel}</span>
      </div>
      <div className="resonance-tutorial-proof__evidence" aria-label="Lesson evidence">
        {evidence.slice(0, 3).map((item) => (
          <div key={item.label}>
            <span>{item.label}</span>
            <b>{item.value}</b>
            <small>{item.detail}</small>
          </div>
        ))}
      </div>
      {unlock && (
        <div className="resonance-tutorial-proof__unlock">
          <Icon name="lock" size={17} />
          <span><b>NEW VOCABULARY UNLOCKED</b>{unlock}</span>
        </div>
      )}
      {children}
    </section>
  );
}
