import type { Timbre } from "@/audio/synth";
import { ActionButton, Eyebrow, Panel, Segmented } from "@/ui/Controls";
import {
  summarizeToneMapLevel,
  type ToneMapSkillEvidence,
} from "./tone-map-model";
import {
  TONE_MAP_RESPONSE_OPTIONS,
  toneMapRequiredSkills,
  type ToneMapResponseMode,
} from "./tone-map-session";
import { ToneMapProgress } from "./ToneMapProgress";
import { ToneMapSimon } from "./ToneMapSimon";
import { ToneMapSingleTrial } from "./ToneMapSingleTrial";
import {
  useToneMapSession,
  type ToneMapChallengeMode,
} from "./use-tone-map-session";
import "./tone-map.css";

interface ToneMapTrainerProps {
  readonly timbre: Timbre;
}

const CHALLENGE_OPTIONS = Object.freeze([
  { value: "single", label: "Single tones" },
  { value: "simon", label: "Simon sequence" },
] satisfies readonly Readonly<{ value: ToneMapChallengeMode; label: string }>[]);

function taskEvidence(
  session: ReturnType<typeof useToneMapSession>["session"],
): ToneMapSkillEvidence | null {
  if (session.task === null) return null;
  return session.course.tones[session.task.midi]![session.task.skill];
}

export function ToneMapTrainer({ timbre }: ToneMapTrainerProps) {
  const controller = useToneMapSession(timbre);
  const { session } = controller;
  const requiredSkills = toneMapRequiredSkills(session.responseMode);
  const summary = summarizeToneMapLevel(session.course, requiredSkills);
  const evidence = taskEvidence(session);
  const settingsLocked = session.answer !== null;
  const persistenceIssue = controller.storageResetAvailable
    ? {
        title: "Stored Tone Map progress is incompatible or invalid.",
        detail: "It was not overwritten. Start a new progressive course to save the landmark-and-gap curriculum in this browser.",
      }
    : {
        title: "Local progress could not be saved.",
        detail: "You can keep practicing; this browser may not retain the new evidence.",
      };

  const changeChallenge = (mode: ToneMapChallengeMode) => {
    if (controller.promptPlayback.playing || settingsLocked) return;
    if (mode === "simon" && session.responseMode !== "keyboard") {
      controller.changeResponseMode("keyboard");
    }
    controller.changeChallengeMode(mode);
  };

  if (!controller.hydrated) {
    return (
      <Panel className="tone-map-loading" aria-busy="true">
        <Eyebrow>Local course</Eyebrow>
        <h2>Restoring your sound map…</h2>
      </Panel>
    );
  }

  return (
    <div className="tone-map" data-tone-map-root data-persistence-state={controller.persistenceState}>
      {controller.persistenceState === "error" && (
        <div className="error-banner" role="status">
          <strong>{persistenceIssue.title}</strong>
          <span>{persistenceIssue.detail}</span>
          {controller.storageResetAvailable && (
            <ActionButton onClick={controller.resetStoredCourse}>
              Start progressive course
            </ActionButton>
          )}
        </div>
      )}

      <Panel className="tone-map-controls">
        <div>
          <Eyebrow>Ear → note curriculum</Eyebrow>
          <h2>Commit first. See the answer second.</h2>
          <p>
            Begin with six middle-octave landmarks, fill the notes between them,
            then widen into neighboring octaves. Each addition joins the full cumulative mix,
            until every randomized round challenges you across all 88 keys.
          </p>
        </div>
        <div className="tone-map-controls__selectors">
          <Segmented<ToneMapResponseMode>
            label="Answer path"
            value={session.responseMode}
            onChange={controller.changeResponseMode}
            options={TONE_MAP_RESPONSE_OPTIONS}
            disabled={settingsLocked || controller.challengeMode === "simon"}
          />
          <Segmented<ToneMapChallengeMode>
            label="Challenge"
            value={controller.challengeMode}
            onChange={changeChallenge}
            options={CHALLENGE_OPTIONS}
            disabled={settingsLocked || controller.promptPlayback.playing}
          />
        </div>
        {controller.promptPlayback.playing && (
          <small className="tone-map-controls__notice">
            Stop the visible prompt toggle before switching to a sequence.
          </small>
        )}
      </Panel>

      <ToneMapProgress
        course={session.course}
        summary={summary}
        mayAdvanceNow
        onAdvance={controller.advanceLevel}
      />

      {controller.challengeMode === "single" ? (
        <ToneMapSingleTrial
          task={session.task}
          answer={session.answer}
          evidence={evidence}
          input={controller.input}
          voiceAnswer={controller.voiceAnswer}
          playback={controller.promptPlayback}
          onAnswerMidi={controller.answerMidi}
          onCommitVoiceAnswer={controller.commitVoiceAnswer}
          onUnreachable={controller.markProductionUnreachable}
          onNext={controller.next}
          onRetryExcluded={controller.retryExcludedProduction}
        />
      ) : (
        <ToneMapSimon
          course={session.course}
          timbre={timbre}
          length={controller.simonLength}
          onLengthChange={controller.changeSimonLength}
          onCourseChange={controller.replaceCourseFromSimon}
        />
      )}
    </div>
  );
}
