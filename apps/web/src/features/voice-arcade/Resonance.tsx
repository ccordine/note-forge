import { playTone } from "@/audio/synth";
import { useAudioInput } from "@/audio/use-audio-input";
import { useSessionEffectScope } from "@/features/training-session/use-session-effect-scope";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { useRealtimeSession } from "@/realtime/use-realtime-session";
import { resolveArcadeCurriculum } from "./curriculum";
import { getDifficultyPreset } from "./model";
import { ResonanceChamber } from "./ResonanceChamber";
import { generateResonanceLevel, type GeneratedResonanceLevel } from "./resonance-level";
import {
  createResonanceSession,
  focusedResonator,
  goalProgressPercent,
  reduceResonanceSession,
  resonanceHeldSeconds,
  resonatorIsCoupled,
  type ResonanceSessionState,
} from "./resonance-session";
import type { ResonanceResult } from "./resonance-scoring";
import type { ArcadeGameProps, ArcadeOutcome } from "./types";
import { useArcadeOutcomeHandoff } from "./use-arcade-outcome";

const OCCUPANCY_DISPLAY_SECONDS = 3;
const REFERENCE_SECONDS = 0.32;

function outcomeFrom(
  result: Readonly<ResonanceResult>,
  props: Readonly<Pick<ArcadeGameProps, "difficulty" | "curriculumStage">>,
  chamberNumber: number,
): ArcadeOutcome {
  return {
    mode: "resonance",
    curriculumStage: props.curriculumStage,
    variant: `field-chamber-${chamberNumber}`,
    score: result.score,
    grade: result.grade,
    xp: Math.round(result.score * getDifficultyPreset(props.difficulty).scoreMultiplier),
    accuracy: result.tunedEfficiencyPercent,
    bestCombo: Math.round(result.bestCoherentHoldSeconds * 10),
    durationMs: Math.round(result.durationSeconds * 1_000),
    details: {
      pathEfficiencyPercent: result.pathEfficiencyPercent,
      coherentEfficiencyPercent: result.coherentEfficiencyPercent,
      tunedEfficiencyPercent: result.tunedEfficiencyPercent,
      collisionControlPercent: result.collisionControlPercent,
      speedPercent: result.speedPercent,
      collisions: result.collisionCount,
      reliableFrames: result.reliableFrames,
      bestCoherentHoldMs: result.bestCoherentHoldSeconds * 1_000,
      resonators: result.resonators,
    },
  };
}

function referenceVoice(midi: number) {
  return playTone({
    frequencyHz: continuousMidiToHz(midi),
    duration: REFERENCE_SECONDS,
    amplitude: 0.16,
    timbre: "sine",
    release: 0.05,
  });
}

function guidanceFor(state: Readonly<ResonanceSessionState>): Readonly<{
  title: string;
  detail: string;
}> {
  if (state.phase === "complete") {
    return {
      title: "Chamber finished",
      detail: "You ended this run. Replay it or generate the next chamber when you choose.",
    };
  }
  if (state.phase === "idle") {
    return {
      title: "Chamber ready",
      detail: "Choose Start chamber. Every following PCM window drives this same field until you finish.",
    };
  }
  if (state.game.status === "won") {
    return {
      title: "Goal captured · field still live",
      detail: "Keep shaping the field for as long as you want, then choose Finish chamber.",
    };
  }
  const target = focusedResonator(state.game);
  const activation = target
    ? state.game.resonatorActivations.find((candidate) => candidate.resonatorId === target.id)
    : null;
  if (resonatorIsCoupled(state.controller, target, activation)) {
    return {
      title: "Resonator coupled",
      detail: "Stay in the lane to keep tuned force on the ball.",
    };
  }
  if (!state.controller.evidenceReliable || state.controller.midiFloat === null) {
    return {
      title: "PCM is flowing",
      detail: "This window is unvoiced or uncertain. The next credible pitch acts immediately.",
    };
  }
  if (!target) {
    return {
      title: "Carry the ball into the goal",
      detail: "No resonator remains ahead; keep shaping the direct field.",
    };
  }
  const cents = (state.controller.midiFloat - target.targetMidi) * 100;
  return {
    title: cents < 0 ? "Move pitch upward" : "Move pitch downward",
    detail: `${Math.abs(cents).toFixed(0)} cents from ${noteLabel(target.targetMidi)}.`,
  };
}

function ResonanceGuide() {
  return (
    <details className="resonance-guide">
      <summary>Optional guide · how the field works</summary>
      <div>
        <p>Your current detected pitch continuously creates the field. Valid quiet notes count exactly like valid loud notes.</p>
        <ul>
          <li>Match the focused resonator to add tuned force.</li>
          <li>Stable pitch makes the field more coherent; no setup calibration is required.</li>
          <li>Silence and uncertain windows add no force, but PCM and detection keep running.</li>
          <li>Reference playback is a brief, explicit sound. It never pauses or resets the detector.</li>
        </ul>
      </div>
    </details>
  );
}

function ResonanceTargetBank({ state }: { readonly state: Readonly<ResonanceSessionState> }) {
  const focus = focusedResonator(state.game);
  return (
    <div className="resonance-target-bank" aria-label="Chamber resonators">
      {state.game.level.resonators.map((resonator, index) => {
        const activation = state.game.resonatorActivations[index];
        const focused = resonator.id === focus?.id;
        const coupled = resonatorIsCoupled(state.controller, resonator, activation);
        return (
          <div key={resonator.id} className={`${focused ? "focus" : ""} ${coupled ? "coupled" : ""}`.trim()}>
            <span>{focused ? "CURRENT" : `NEXT ${index + 1}`}</span>
            <strong>{noteLabel(resonator.targetMidi)}</strong>
            <small>{coupled ? "coupled" : `${Math.round((activation?.effectiveEnergy ?? 0) * 100)}% field`}</small>
          </div>
        );
      })}
    </div>
  );
}

function ResonanceGameStats({ state }: { readonly state: Readonly<ResonanceSessionState> }) {
  return (
    <div className="resonance-game-stats" aria-label="Live chamber state">
      <div><span>GOAL</span><b>{goalProgressPercent(state.game).toFixed(0)}%</b></div>
      <div><span>SAMPLE TIME</span><b>{state.game.elapsedSeconds.toFixed(1)}s</b></div>
      <div><span>BALL SPEED</span><b>{Math.hypot(state.game.ball.velocity.x, state.game.ball.velocity.y).toFixed(2)}</b></div>
      <div><span>CONTACTS</span><b>{state.game.collisionCount}</b></div>
    </div>
  );
}

function ResonanceResultPanel({
  result,
  live,
}: {
  readonly result: Readonly<ResonanceResult> | null;
  readonly live: boolean;
}) {
  return (
    <section className="resonance-result" aria-live="polite" hidden={result === null} data-live-achievement="resonance">
      {result && (
        <>
          <div className="resonance-result-mark">{result.grade}</div>
          <div>
            <span>{live ? "GOAL CAPTURED · FIELD STILL LIVE" : "CHAMBER FINISHED"}</span>
            <h2>{result.score} field-control score</h2>
            <p>{result.pathEfficiencyPercent.toFixed(0)}% path · {result.coherentEfficiencyPercent.toFixed(0)}% coherence · {result.tunedEfficiencyPercent.toFixed(0)}% tuned transfer · {result.collisionCount} contact episodes</p>
          </div>
        </>
      )}
    </section>
  );
}

export function Resonance(props: ArcadeGameProps) {
  const { difficulty, curriculumStage, voiceRange, onExit, onComplete } = props;
  const curriculum = resolveArcadeCurriculum("resonance", curriculumStage);
  const realtime = useRealtimeSession(
    reduceResonanceSession,
    () => createResonanceSession({
      seed: `resonance-preview:${difficulty}:${voiceRange.lowMidi}:${voiceRange.highMidi}`,
      level: 1,
      difficulty,
      lowMidi: voiceRange.lowMidi,
      highMidi: voiceRange.highMidi,
      baselineMidi: voiceRange.baselineMidi,
    }),
  );
  const session = realtime.state;
  const reference = useSessionEffectScope();
  const target = focusedResonator(session.game);
  const heldSeconds = resonanceHeldSeconds(session);
  const input = useAudioInput({
    diagnostics: {
      flow: "voice-arcade",
      phase: session.phase,
      targetMidi: target?.targetMidi ?? null,
      toleranceCents: target?.bandwidthCents ?? null,
      stableMs: heldSeconds * 1_000,
      requiredHoldMs: null,
      resetReason: null,
    },
    onFrame: (observation) => realtime.observe({ type: "observation", observation }),
  });
  const completedOutcome = session.phase === "complete" && session.result
    ? outcomeFrom(
      session.result,
      { difficulty, curriculumStage },
      session.chamberNumber,
    )
    : null;
  useArcadeOutcomeHandoff(
    completedOutcome ? session.runSerial : null,
    completedOutcome,
    onComplete,
  );

  function generatedChamber(chamberNumber: number): GeneratedResonanceLevel {
    return generateResonanceLevel({
      seed: `resonance:${crypto.randomUUID()}`,
      level: chamberNumber,
      difficulty,
      lowMidi: voiceRange.lowMidi,
      highMidi: voiceRange.highMidi,
      baselineMidi: voiceRange.baselineMidi,
    });
  }

  const targetActivation = target
    ? session.game.resonatorActivations.find((candidate) => candidate.resonatorId === target.id)
    : null;
  const coupled = resonatorIsCoupled(session.controller, target, targetActivation);
  const guidance = guidanceFor(session);
  let primaryLabel = "Start chamber";
  if (session.phase === "tracking") primaryLabel = "Finish chamber";
  if (session.phase === "complete") primaryLabel = "Start chamber again";
  const holdStatus = coupled ? "holding" as const : "waiting" as const;

  return (
    <div className="resonance-page" data-live-lifetime="user-owned">
      <Panel className="resonance-header">
        <div>
          <Eyebrow>Resonance · continuous pitch physics</Eyebrow>
          <h1>Sing into the field.</h1>
          <p>{curriculum.focus} The chamber is available now; the guide is optional.</p>
        </div>
        <div className="resonance-actions">
          <ActionButton
            className="primary"
            onClick={() => {
              reference.abort();
              if (session.phase === "tracking") {
                realtime.dispatch({ type: "finish" });
              } else {
                realtime.dispatch({ type: "start" });
              }
            }}
          >
            <Icon name="arrow" size={17} /> {primaryLabel}
          </ActionButton>
          <ActionButton
            disabled={session.phase === "tracking"}
            onClick={() => {
              reference.abort();
              const chamberNumber = session.chamberNumber + 1;
              realtime.dispatch({
                type: "install",
                chamberNumber,
                generated: generatedChamber(chamberNumber),
              });
            }}
          >
            <Icon name="spark" size={17} /> New chamber
          </ActionButton>
          <ActionButton disabled={!target} onClick={() => target && reference.playReference(
            `Resonance ${noteLabel(target.targetMidi)} reference`,
            () => referenceVoice(target.targetMidi),
          )}>
            <Icon name="headphones" size={17} /> Hear target
          </ActionButton>
          <ActionButton onClick={() => { reference.abort(); onExit(); }}><Icon name="arrow" size={16} /> Cabinet</ActionButton>
        </div>
        <ResonanceGuide />
      </Panel>

      <div className="resonance-play-layout">
        <section className="resonance-chamber-panel" aria-label="Live Resonance chamber">
          <div className="resonance-chamber-heading">
            <span>CHAMBER {session.chamberNumber} · {difficulty.toUpperCase()}</span>
            <b>{session.phase.toUpperCase()} · {session.game.fixedStepCount.toLocaleString()} SAMPLE-DERIVED STEPS</b>
          </div>
          <ResonanceChamber
            state={session.game}
            metadata={session.generated.metadata}
            focusResonatorId={target?.id ?? null}
            showLabels
            showRoute={curriculumStage === "deliberate"}
            showForceVector
          />
          <ResonanceGameStats state={session} />
        </section>

        <aside className="resonance-controller-panel" aria-label="Continuous Resonance voice controller">
          <div className="resonance-controller-heading">
            <span>ONE SHARED PITCH STREAM</span>
            <b>{session.controller.status.toUpperCase()}</b>
          </div>
          <ResonanceTargetBank state={session} />
          <NoteInput
            variant="target"
            input={input}
            targetMidi={target?.targetMidi ?? voiceRange.baselineMidi}
            toleranceCents={Math.round(target?.bandwidthCents ?? 30)}
            phase="listening"
            hold={{
              heldSeconds,
              requiredSeconds: OCCUPANCY_DISPLAY_SECONDS,
              status: holdStatus,
            }}
            holdMode="occupancy"
            guidanceTitle={guidance.title}
            guidanceDetail={guidance.detail}
            diagnosticsFlow="voice-arcade"
            feedbackLevel="full"
            guidanceLive={false}
          />
        </aside>
      </div>

      <ResonanceResultPanel
        result={session.phase === "tracking" ? session.achievement : session.result}
        live={session.phase === "tracking"}
      />
    </div>
  );
}
