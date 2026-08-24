import { describe, expect, it } from "vitest";
import { midiToFrequency } from "@noteforge/pitch-engine";

import {
  RESONANCE_TUTORIAL_LESSON_IDS,
  adaptResonanceTutorialVoice,
  advanceResonanceTutorialSession,
  createResonanceTutorialCurriculum,
  createResonanceTutorialObjectiveState,
  createResonanceTutorialSession,
  nextResonanceTutorialLessonId,
  nextUnlockedResonanceTutorialLessonId,
  resonanceTutorialLesson,
  resonanceTutorialLessonIsUnlocked,
  type ResonanceTutorialLessonId,
  type ResonanceTutorialSessionState,
} from "../apps/web/src/features/voice-arcade/resonance-tutorial";
import { createResonanceGame, type ResonanceVoiceInput } from "../apps/web/src/features/voice-arcade/resonance-physics";

const BASELINE_MIDI = 48;
const STEP_SECONDS = .02;

function voice(
  midiFloat = BASELINE_MIDI,
  normalizedLevel = .64,
  coherence = 1,
): ResonanceVoiceInput {
  return {
    voiced: true,
    midiFloat,
    frequencyHz: midiToFrequency(midiFloat),
    normalizedLevel,
    coherentDrive: normalizedLevel * coherence,
    confidence: .97,
    stability: coherence,
  };
}

const SILENCE: ResonanceVoiceInput = Object.freeze({
  voiced: false,
  midiFloat: null,
  frequencyHz: null,
  normalizedLevel: 0,
  coherentDrive: 0,
  confidence: 0,
  stability: 0,
});

function advanceFor(
  initial: ResonanceTutorialSessionState,
  input: ResonanceVoiceInput,
  seconds: number,
): ResonanceTutorialSessionState {
  let state = initial;
  for (let elapsed = 0; elapsed < seconds - 1e-9 && state.objective.status === "playing";
    elapsed += STEP_SECONDS) {
    state = advanceResonanceTutorialSession(
      state,
      input,
      Math.min(STEP_SECONDS, seconds - elapsed),
    ).state;
  }
  return state;
}

function solveStraightRoom(
  id: ResonanceTutorialLessonId,
  input = voice(),
  maximumSeconds = 20,
): ResonanceTutorialSessionState {
  return advanceFor(
    createResonanceTutorialSession(id, { baselineMidi: BASELINE_MIDI }),
    input,
    maximumSeconds,
  );
}

describe("Resonance authored tutorial curriculum", () => {
  it("authors exactly three ordered Discover, Control, Apply proofs for every supported mechanic", () => {
    const curriculum = createResonanceTutorialCurriculum({ baselineMidi: BASELINE_MIDI });

    expect(curriculum.map((lesson) => lesson.id)).toEqual(RESONANCE_TUTORIAL_LESSON_IDS);
    for (const mechanic of ["force", "pitch", "sustain", "stability"] as const) {
      const lessons = curriculum.filter((lesson) => lesson.mechanic === mechanic);
      expect(lessons.map((lesson) => lesson.stage)).toEqual(["discover", "control", "apply"]);
    }
    curriculum.forEach((lesson, order) => {
      expect(lesson.order).toBe(order);
      expect(lesson.instruction.length).toBeGreaterThan(20);
      expect(lesson.observation.length).toBeGreaterThan(20);
      expect(lesson.causeAndEffect.length).toBeGreaterThan(20);
      expect(() => createResonanceGame(lesson.level.definition)).not.toThrow();
    });
  });

  it("is deterministic and keeps every target inside MIDI bounds at range edges", () => {
    expect(createResonanceTutorialCurriculum({ baselineMidi: BASELINE_MIDI }))
      .toEqual(createResonanceTutorialCurriculum({ baselineMidi: BASELINE_MIDI }));
    for (const baselineMidi of [0, 127]) {
      const curriculum = createResonanceTutorialCurriculum({ baselineMidi });
      const pitchControl = curriculum.find((lesson) => lesson.id === "pitch-control")!;
      expect(pitchControl.targetMidis).toHaveLength(3);
      expect(new Set(pitchControl.targetMidis).size).toBe(3);
      expect(pitchControl.targetMidis).toContain(baselineMidi);
      for (const lesson of curriculum) {
        expect(lesson.targetMidis.every((midi) => midi >= 0 && midi <= 127)).toBe(true);
        expect(() => createResonanceGame(lesson.level.definition)).not.toThrow();
      }
    }
  });

  it("unlocks lessons strictly in authored order", () => {
    expect(nextResonanceTutorialLessonId("force-discover")).toBe("force-control");
    expect(nextResonanceTutorialLessonId("stability-apply")).toBeNull();
    expect(resonanceTutorialLessonIsUnlocked("force-discover", [])).toBe(true);
    expect(resonanceTutorialLessonIsUnlocked("force-control", [])).toBe(false);
    expect(resonanceTutorialLessonIsUnlocked("force-control", ["force-discover"])).toBe(true);
    expect(resonanceTutorialLessonIsUnlocked("pitch-discover", [
      "force-discover", "force-control", "force-apply",
    ])).toBe(true);
    expect(nextUnlockedResonanceTutorialLessonId(["force-discover", "force-control"]))
      .toBe("force-apply");
  });
});

describe("Resonance tutorial variable isolation", () => {
  it("lets only relative level vary in force lessons", () => {
    const lesson = resonanceTutorialLesson("force-discover", { baselineMidi: BASELINE_MIDI });
    const quiet = adaptResonanceTutorialVoice(lesson, voice(44, .25, .25));
    const loud = adaptResonanceTutorialVoice(lesson, voice(55, .65, .95));

    expect(quiet.midiFloat).toBe(loud.midiFloat);
    expect(quiet.stability).toBe(1);
    expect(loud.stability).toBe(1);
    expect(quiet.coherentDrive).toBeCloseTo(quiet.normalizedLevel, 12);
    expect(loud.coherentDrive).toBeCloseTo(loud.normalizedLevel, 12);
    expect(loud.normalizedLevel).toBeGreaterThan(quiet.normalizedLevel);

    const zeroProductionDrive = adaptResonanceTutorialVoice(lesson, voice(50, .5, 0));
    expect(zeroProductionDrive.voiced).toBe(true);
    expect(zeroProductionDrive.coherentDrive).toBeCloseTo(.5, 12);
  });

  it("lets only pitch vary in pitch lessons", () => {
    const lesson = resonanceTutorialLesson("pitch-control", { baselineMidi: BASELINE_MIDI });
    const low = adaptResonanceTutorialVoice(lesson, voice(47, .18, .2));
    const high = adaptResonanceTutorialVoice(lesson, voice(49, .9, .98));

    expect(low.midiFloat).toBe(47);
    expect(high.midiFloat).toBe(49);
    expect(low.normalizedLevel).toBe(high.normalizedLevel);
    expect(low.coherentDrive).toBe(high.coherentDrive);
    expect(low.stability).toBe(1);
    expect(high.stability).toBe(1);
  });

  it("normalizes every untaught input axis in sustain lessons and enforces the real charge gate", () => {
    const lesson = resonanceTutorialLesson("sustain-apply", { baselineMidi: BASELINE_MIDI });
    const empty = createResonanceTutorialObjectiveState();
    const blocked = adaptResonanceTutorialVoice(lesson, voice(43, .2, .2), empty);
    const charged = adaptResonanceTutorialVoice(
      lesson,
      voice(55, .9, .95),
      { ...empty, chargeSeconds: lesson.isolation.chargeGate! },
    );

    expect(blocked.voiced).toBe(false);
    expect(charged.voiced).toBe(true);
    expect(charged.midiFloat).toBe(BASELINE_MIDI);
    expect(charged.normalizedLevel).toBeCloseTo(.67, 12);
    expect(charged.coherentDrive).toBeCloseTo(.67, 12);
  });

  it("lets only controller coherence vary in stability lessons", () => {
    const lesson = resonanceTutorialLesson("stability-discover", { baselineMidi: BASELINE_MIDI });
    const scattered = adaptResonanceTutorialVoice(lesson, voice(43, .2, .3));
    const focused = adaptResonanceTutorialVoice(lesson, voice(55, .9, .9));

    expect(scattered.midiFloat).toBe(focused.midiFloat);
    expect(scattered.normalizedLevel).toBe(focused.normalizedLevel);
    expect(scattered.coherentDrive).toBeCloseTo(.67 * .3, 12);
    expect(focused.coherentDrive).toBeCloseTo(.67 * .9, 12);
    expect(adaptResonanceTutorialVoice(lesson, voice(50, .5, 0)).voiced).toBe(false);
  });

  it("never upgrades rejected evidence, while explicitly normalized lessons may ignore zero coherence", () => {
    const lesson = resonanceTutorialLesson("pitch-discover", { baselineMidi: BASELINE_MIDI });
    const unreliable = adaptResonanceTutorialVoice(lesson, {
      ...voice(), confidence: .2, coherentDrive: .64,
    });
    const controllerSuppressed = adaptResonanceTutorialVoice(lesson, {
      ...voice(), coherentDrive: 0,
    });
    const noRelativeLevel = adaptResonanceTutorialVoice(lesson, {
      ...voice(), normalizedLevel: 0, coherentDrive: 0,
    });

    expect(unreliable).toEqual(SILENCE);
    expect(controllerSuppressed.voiced).toBe(true);
    expect(controllerSuppressed.coherentDrive).toBeGreaterThan(0);
    expect(noRelativeLevel).toEqual(SILENCE);
  });
});

describe("Resonance tutorial deterministic state-machine scenarios", () => {
  it("passes the force discovery and clean application chambers with controlled direct force", () => {
    expect(solveStraightRoom("force-discover").objective.status).toBe("passed");
    const applied = solveStraightRoom("force-apply", voice(BASELINE_MIDI, .48), 20);
    expect(applied.objective.status).toBe("passed");
    expect(applied.game.collisionCount).toBe(0);
  });

  it("requires release-and-settle control at each of the three force zones", () => {
    let state = createResonanceTutorialSession("force-control", { baselineMidi: BASELINE_MIDI });
    const zones = state.lesson.objective.kind === "stopped-zones"
      ? state.lesson.objective.zones
      : [];
    for (const zone of zones) {
      for (let step = 0; step < 2_000 && state.game.ball.position.x < zone.minimumX + .08;
        step += 1) {
        state = advanceResonanceTutorialSession(state, voice(BASELINE_MIDI, .32), STEP_SECONDS).state;
      }
      for (let step = 0; step < 2_000 && state.objective.milestoneIndex < zones.indexOf(zone) + 1;
        step += 1) {
        state = advanceResonanceTutorialSession(state, SILENCE, STEP_SECONDS).state;
      }
    }
    expect(state.objective.status, JSON.stringify({
      ball: state.game.ball,
      objective: state.objective,
    })).toBe("passed");
  });

  it("proves pitch discovery, neighboring-note control, and application without loudness shortcuts", () => {
    const discover = solveStraightRoom("pitch-discover", voice(BASELINE_MIDI, .12, .2), 1);
    expect(discover.objective.status).toBe("passed");

    let control = createResonanceTutorialSession("pitch-control", { baselineMidi: BASELINE_MIDI });
    for (const target of control.lesson.targetMidis) {
      control = advanceFor(control, voice(target, .95, .2), .5);
    }
    expect(control.objective.status).toBe("passed");

    const apply = solveStraightRoom("pitch-apply", voice(BASELINE_MIDI, .12, .2), 20);
    expect(apply.objective.status).toBe("passed");
  });

  it("proves uninterrupted hold, separated hold control, and a charge-gated crossing", () => {
    expect(solveStraightRoom("sustain-discover", voice(44, .2, .2), 1.2).objective.status)
      .toBe("passed");

    let control = createResonanceTutorialSession("sustain-control", { baselineMidi: BASELINE_MIDI });
    const objective = control.lesson.objective;
    expect(objective.kind).toBe("sustain-sequence");
    if (objective.kind !== "sustain-sequence") throw new Error("Unexpected objective.");
    for (const requirement of objective.holdSeconds) {
      control = advanceFor(control, voice(55, .9, .2), requirement + .08);
      if (control.objective.status === "playing") {
        control = advanceFor(control, SILENCE, objective.releaseSeconds + .08);
      }
    }
    expect(control.objective.status).toBe("passed");

    const apply = solveStraightRoom("sustain-apply", voice(44, .2, .2), 20);
    expect(apply.objective.status).toBe("passed");
    expect(apply.objective.bestHoldSeconds).toBeGreaterThan(.7);
  });

  it("proves focused holds at increasing thresholds and blocks unstable application force", () => {
    expect(solveStraightRoom("stability-discover", voice(44, .2, .75), 1).objective.status)
      .toBe("passed");

    let control = createResonanceTutorialSession("stability-control", { baselineMidi: BASELINE_MIDI });
    control = advanceFor(control, voice(55, .9, .9), 1.5);
    expect(control.objective.status).toBe("passed");

    const unstable = solveStraightRoom("stability-apply", voice(55, .9, .65), 4);
    expect(unstable.game.ball.position.x).toBeCloseTo(2, 8);
    expect(unstable.objective.status).toBe("playing");
    const stable = solveStraightRoom("stability-apply", voice(44, .2, .9), 20);
    expect(stable.objective.status).toBe("passed");
    expect(stable.game.collisionCount).toBe(0);
  });
});
