import { Eyebrow, Panel } from "@/ui/Controls";
import {
  TONE_MAP_LEVEL_SIZE,
  type ToneMapCourseState,
  type ToneMapLevelSummary,
} from "./tone-map-model";

interface ToneMapProgressProps {
  readonly course: ToneMapCourseState;
  readonly summary: ToneMapLevelSummary;
  readonly mayAdvanceNow: boolean;
  readonly onAdvance: () => void;
}

function SkillProgress({
  label,
  stable,
  confirmed,
  eligible,
  excluded = 0,
}: {
  readonly label: string;
  readonly stable: number;
  readonly confirmed: number;
  readonly eligible: number;
  readonly excluded?: number;
}) {
  return (
    <span>
      <small>{label}</small>
      <b>{stable}/{eligible} stable</b>
      <em>{confirmed}/{eligible} confirmed this level</em>
      {excluded > 0 && <em>{excluded} outside vocal range</em>}
    </span>
  );
}

/** Progress uses anonymous positions while an answer is hidden. */
export function ToneMapProgress({
  course,
  summary,
  mayAdvanceNow,
  onAdvance,
}: ToneMapProgressProps) {
  const nextToneCount = Math.min(
    TONE_MAP_LEVEL_SIZE,
    course.order.length - summary.activeMidis.length,
  );
  const introduced = summary.introducedMidis.map((midi) => {
    const tone = course.tones[midi]!;
    const requiredStable = summary.requiredSkills.every((skill) => (
      skill === "production" && tone.productionEligibility === "unreachable"
        ? true
        : tone[skill].stable
    ));
    return requiredStable;
  });
  return (
    <Panel className="tone-map-progress" data-tone-map-level={summary.currentLevel}>
      <div>
        <Eyebrow>Cumulative sound map</Eyebrow>
        <h2>Level {summary.currentLevel} of {summary.totalLevels}</h2>
        <p>
          {summary.introducedMidis.length} new tones · {summary.activeMidis.length} active.
          Every earlier tone remains in rotation and earns a fresh blind confirmation this level.
        </p>
      </div>
      <div className="tone-map-progress__skills">
        {summary.requiredSkills.includes("identification") && (
          <SkillProgress
            label="Ear → key"
            stable={summary.identification.stableMidis.length}
            confirmed={summary.identification.blindConfirmedMidis.length}
            eligible={summary.identification.eligibleMidis.length}
          />
        )}
        {summary.requiredSkills.includes("production") && (
          <SkillProgress
            label="Ear → voice"
            stable={summary.production.stableMidis.length}
            confirmed={summary.production.blindConfirmedMidis.length}
            eligible={summary.production.eligibleMidis.length}
            excluded={summary.production.excludedMidis.length}
          />
        )}
      </div>
      <div className="tone-map-progress__introduced" aria-label="Current level tone stability">
        {introduced.map((stable, index) => (
          <i
            className={stable ? "stable" : ""}
            aria-label={`Tone ${index + 1}: ${stable ? "stable" : "learning"}`}
            key={index}
          />
        ))}
      </div>
      {summary.canAdvance && (
        <button
          type="button"
          className="action-button primary"
          disabled={!mayAdvanceNow}
          onClick={onAdvance}
        >
          Add the next {nextToneCount} tones
        </button>
      )}
      {summary.courseComplete && (
        <div className="tone-map-progress__complete" role="status">
          <b>Full piano map stable.</b>
          <span>Keep answering to retain it; this course never locks itself or ends for you.</span>
        </div>
      )}
    </Panel>
  );
}
