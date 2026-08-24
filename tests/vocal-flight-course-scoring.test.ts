import { describe, expect, it } from "vitest";

import {
  VOCAL_FLIGHT_TUTORIALS,
  advanceVocalFlightCourse,
  createVocalFlightCourseState,
  disturbanceAtPosition,
  getVocalFlightCourse,
  vocalFlightCourseGateCount,
  vocalFlightGateCenter,
} from "../apps/web/src/features/voice-arcade/vocal-flight/courses";
import { getVocalFlightMode } from "../apps/web/src/features/voice-arcade/vocal-flight/vocal-flight-modes";
import { createVocalFlightState } from "../apps/web/src/features/voice-arcade/vocal-flight/flight-runtime";
import {
  advanceVocalFlightScore,
  createVocalFlightScoreState,
  summarizeVocalFlightScore,
  type VocalFlightScoringSample,
} from "../apps/web/src/features/voice-arcade/vocal-flight/scoring";
import type {
  VocalControlVector,
  VocalFlightCourseDefinition,
  VocalFlightState,
} from "../apps/web/src/features/voice-arcade/vocal-flight/types";

function control(pitchAxis: number, brightnessAxis: number, active = true): VocalControlVector {
  return {
    pitchAxis,
    brightnessAxis,
    pitchConfidence: active ? 0.96 : 0,
    brightnessConfidence: active ? 0.95 : 0,
    voiced: active,
    active,
  };
}

function at(state: VocalFlightState, x: number, y: number, z: number): VocalFlightState {
  return { ...state, position: { x, y, z } };
}

function scoreSample(
  overrides: Partial<VocalFlightScoringSample> = {},
): VocalFlightScoringSample {
  return {
    deltaSeconds: 0.02,
    control: control(0.3, 0.2),
    controlMode: "combined",
    pathError: 0,
    pathTolerance: 5,
    desiredPitchAxis: 0.3,
    desiredBrightnessAxis: 0.2,
    pitchDeltaCents: 80,
    ...overrides,
  };
}

describe("authored Vocal Flight curriculum and course reducer", () => {
  it("ships exactly three ordered challenges per chapter before combining dimensions", () => {
    expect(VOCAL_FLIGHT_TUTORIALS).toHaveLength(18);
    const chapters = ["neutral", "pitch", "brightness", "combined", "precision", "automaticity"];
    for (const chapter of chapters) {
      const entries = VOCAL_FLIGHT_TUTORIALS.filter((candidate) => candidate.chapter === chapter);
      expect(entries.map((entry) => entry.discovery)).toEqual([
        "discovery", "control", "application",
      ]);
      expect(entries).toHaveLength(3);
    }
    expect(VOCAL_FLIGHT_TUTORIALS.slice(3, 6).every((item) => item.controlMode === "pitch"))
      .toBe(true);
    expect(VOCAL_FLIGHT_TUTORIALS.slice(6, 9).every((item) => item.controlMode === "brightness"))
      .toBe(true);
    expect(VOCAL_FLIGHT_TUTORIALS.slice(0, 9).some((item) => item.controlMode === "combined"))
      .toBe(false);
  });

  it("has one typed lookup authority and rejects an invented course", () => {
    expect(getVocalFlightCourse("combined-helix").title).toBe("Broad helix");
    expect(() => getVocalFlightCourse("secret-second-runtime")).toThrow(/Unknown Vocal Flight/);
  });

  it("scores exact gate-plane crossings without depending on render time", () => {
    const definition: VocalFlightCourseDefinition = {
      id: "crossing-proof",
      chapter: "pitch",
      order: 1,
      title: "Crossing proof",
      objective: "Test",
      discovery: "control",
      controlMode: "pitch",
      selfLevelStrength: 1,
      gates: [{ id: "gate", center: { x: 1, y: 2, z: 10 }, radius: 2 }],
      disturbances: [],
      requiredNeutralRecoveries: 0,
    };
    const flight = createVocalFlightState();
    const before = at(flight, 0.5, 1.5, 9);
    const after = at(flight, 1.5, 2.5, 11);
    const course = advanceVocalFlightCourse(
      createVocalFlightCourseState(definition),
      before,
      after,
      control(0.2, 0),
      0.02,
    );
    expect(course).toMatchObject({
      status: "complete",
      nextGateIndex: 1,
      gatesPassed: 1,
      gatesMissed: 0,
      sampleSeconds: 0.02,
    });
  });

  it("requires an active voiced return and never mistakes silent zero axes for center recovery", () => {
    const definition = getVocalFlightCourse("neutral-leave-return");
    const flight = createVocalFlightState();
    let state = createVocalFlightCourseState(definition);
    state = advanceVocalFlightCourse(state, flight, flight, control(0.5, 0), 0.02);
    expect(state.neutralWasReleased).toBe(true);
    state = advanceVocalFlightCourse(state, flight, flight, control(0, 0, false), 0.02);
    expect(state.centerRecoveries).toBe(0);
    expect(state.status).toBe("flying");
    for (let index = 0; index < 16; index += 1) {
      state = advanceVocalFlightCourse(state, flight, flight, control(0, 0), 0.02);
    }
    expect(state.centerRecoveries).toBe(1);
    expect(state.status).toBe("flying");
  });

  it("lets Find center succeed by holding center through a gentle authored drift", () => {
    const definition = getVocalFlightCourse("neutral-find-center");
    expect(definition.disturbances).toHaveLength(1);
    const flight = createVocalFlightState();
    let state = createVocalFlightCourseState(definition);
    for (let index = 0; index < 61; index += 1) {
      state = advanceVocalFlightCourse(state, flight, flight, control(0, 0), 0.02);
    }
    expect(state.neutralSteadySeconds).toBeGreaterThanOrEqual(1.2);
    expect(state.centerRecoveries).toBe(0);
    expect(state.status).toBe("complete");
  });

  it("moves the precision target from sample time and presents Pitch Tunnel as a continuous corridor", () => {
    const moving = getVocalFlightCourse("precision-moving-line").gates[0]!;
    expect(moving.motion).toBeDefined();
    expect(vocalFlightGateCenter(moving, 0)).not.toEqual(vocalFlightGateCenter(moving, 4));
    const tunnel = getVocalFlightMode("pitch-tunnel").course!;
    expect(tunnel.visual).toBe("tunnel");
    expect(tunnel.gates.map((item) => item.center.y)).toEqual([
      0, 1.5625, 3.125, 4.6875, 6.25, 4.6875, 3.125, 1.5625, 0,
    ]);
  });

  it("offers real alternate navigation gates and advances whichever branch is crossed", () => {
    const definition = getVocalFlightCourse("automaticity-navigation");
    expect(vocalFlightCourseGateCount(definition)).toBe(3);
    const flight = createVocalFlightState();
    const state = advanceVocalFlightCourse(
      createVocalFlightCourseState(definition),
      at(flight, -7, 5, 47),
      at(flight, -7, 5, 49),
      control(0.2, -0.4),
      0.02,
    );
    expect(state.gatesPassed).toBe(1);
    expect(state.nextGateIndex).toBe(2);
    expect(state.lastPassedCenter).toMatchObject({ x: -7, y: 5, z: 48 });
  });

  it("returns only authored, position-bounded turbulence", () => {
    const definition = getVocalFlightCourse("precision-turbulence");
    expect(disturbanceAtPosition(definition, 40)).toEqual({ pitchTorque: 0, rollTorque: 0 });
    expect(disturbanceAtPosition(definition, 60)).toEqual({ pitchTorque: 0.55, rollTorque: -0.7 });
    expect(disturbanceAtPosition(definition, 70)).toEqual({ pitchTorque: 0, rollTorque: 0 });
  });
});

describe("flight-relevant sample-time scoring", () => {
  it("scores an explicit par only for authored timed courses", () => {
    let onPar = createVocalFlightScoreState(1);
    let slow = createVocalFlightScoreState(1);
    for (let index = 0; index < 50; index += 1) {
      onPar = advanceVocalFlightScore(onPar, scoreSample());
    }
    for (let index = 0; index < 100; index += 1) {
      slow = advanceVocalFlightScore(slow, scoreSample());
    }
    expect(summarizeVocalFlightScore(onPar).timeEfficiencyPercent).toBeCloseTo(100, 10);
    expect(summarizeVocalFlightScore(slow).timeEfficiencyPercent).toBeCloseTo(50, 10);
    expect(summarizeVocalFlightScore(createVocalFlightScoreState()).timeEfficiencyPercent)
      .toBeNull();
    expect(() => createVocalFlightScoreState(0)).toThrow(/par time/u);
  });

  it("reports unmeasured recovery and independence as N/A instead of free mastery", () => {
    let state = createVocalFlightScoreState();
    for (let index = 0; index < 50; index += 1) {
      state = advanceVocalFlightScore(state, scoreSample());
    }
    const result = summarizeVocalFlightScore(state);
    expect(result.score).toBe(100);
    expect(result.centerRecoveryPercent).toBeNull();
    expect(result.averageCenterRecoverySeconds).toBeNull();
    expect(result.axisIndependencePercent).toBeNull();
    expect(result.pitchTaskBrightnessLeak).toBeNull();
    expect(result.brightnessTaskPitchDriftCents).toBeNull();
  });

  it("measures symmetric normalized cross-axis leakage and reports pitch drift in cents", () => {
    let clean = createVocalFlightScoreState();
    let coupled = createVocalFlightScoreState();
    for (let index = 0; index < 50; index += 1) {
      clean = advanceVocalFlightScore(clean, scoreSample({
        control: control(0.5, 0),
        controlMode: "pitch",
        desiredPitchAxis: 0.5,
        desiredBrightnessAxis: 0,
      }));
      clean = advanceVocalFlightScore(clean, scoreSample({
        control: control(0, 0.5),
        controlMode: "brightness",
        desiredPitchAxis: 0,
        desiredBrightnessAxis: 0.5,
        pitchDeltaCents: 0,
      }));
      coupled = advanceVocalFlightScore(coupled, scoreSample({
        control: control(0.5, 0.22),
        controlMode: "pitch",
        desiredPitchAxis: 0.5,
        desiredBrightnessAxis: 0,
      }));
      coupled = advanceVocalFlightScore(coupled, scoreSample({
        control: control(0.28, 0.5),
        controlMode: "brightness",
        desiredPitchAxis: 0,
        desiredBrightnessAxis: 0.5,
        pitchDeltaCents: 180,
      }));
    }
    const cleanResult = summarizeVocalFlightScore(clean);
    const coupledResult = summarizeVocalFlightScore(coupled);
    expect(cleanResult.axisIndependencePercent).toBe(100);
    expect(coupledResult.axisIndependencePercent).toBeLessThan(35);
    expect(coupledResult.pitchTaskBrightnessLeak).toBeCloseTo(0.22, 8);
    expect(coupledResult.brightnessTaskPitchDriftCents).toBeCloseTo(180, 8);
  });

  it("detects overshoot through a neutral band but resets comparison after inactive evidence", () => {
    let state = createVocalFlightScoreState();
    state = advanceVocalFlightScore(state, scoreSample({
      control: control(0.4, 0), desiredPitchAxis: 0, desiredBrightnessAxis: 0,
    }));
    state = advanceVocalFlightScore(state, scoreSample({
      control: control(0.04, 0), desiredPitchAxis: 0, desiredBrightnessAxis: 0,
    }));
    state = advanceVocalFlightScore(state, scoreSample({
      control: control(-0.4, 0), desiredPitchAxis: 0, desiredBrightnessAxis: 0,
    }));
    expect(state.overshootCount).toBe(1);

    state = advanceVocalFlightScore(state, scoreSample({ control: control(0, 0, false) }));
    state = advanceVocalFlightScore(state, scoreSample({
      control: control(0.4, 0), desiredPitchAxis: 0, desiredBrightnessAxis: 0,
    }));
    expect(state.overshootCount).toBe(1);
  });

  it("times center recovery only from active vocal evidence", () => {
    let state = createVocalFlightScoreState();
    state = advanceVocalFlightScore(state, scoreSample({
      deltaSeconds: 0.1,
      control: control(0.5, 0),
      desiredPitchAxis: 0.5,
      desiredBrightnessAxis: 0,
    }));
    state = advanceVocalFlightScore(state, scoreSample({
      deltaSeconds: 0.1,
      control: control(0.3, 0),
      desiredPitchAxis: 0,
      desiredBrightnessAxis: 0,
    }));
    state = advanceVocalFlightScore(state, scoreSample({
      deltaSeconds: 0.1,
      control: control(0, 0, false),
      desiredPitchAxis: 0,
      desiredBrightnessAxis: 0,
    }));
    expect(state.recoveryCompleted).toBe(0);
    state = advanceVocalFlightScore(state, scoreSample({
      deltaSeconds: 0.1,
      control: control(0, 0),
      desiredPitchAxis: 0,
      desiredBrightnessAxis: 0,
    }));
    expect(state.recoveryCompleted).toBe(1);
    expect(summarizeVocalFlightScore(state).averageCenterRecoverySeconds).toBeCloseTo(0.3, 8);
  });

  it("keeps course-path time authoritative through silence without scoring fake control", () => {
    let state = createVocalFlightScoreState();
    for (let index = 0; index < 10; index += 1) {
      state = advanceVocalFlightScore(state, scoreSample({
        control: control(0, 0, false),
        pathError: 5,
        pathTolerance: 5,
      }));
    }
    const result = summarizeVocalFlightScore(state);
    expect(result.scoredSeconds).toBeCloseTo(0.2, 12);
    expect(result.courseAccuracyPercent).toBe(0);
    expect(result.smoothnessPercent).toBe(0);
    expect(result.controlEfficiencyPercent).toBe(0);
    expect(result.axisIndependencePercent).toBeNull();
  });

  it("does not count authority gaps as time or a control jerk", () => {
    let state = createVocalFlightScoreState();
    state = advanceVocalFlightScore(state, scoreSample({ control: control(-1, -1) }));
    const before = state;
    state = advanceVocalFlightScore(state, scoreSample({
      deltaSeconds: 0,
      control: control(1, 1, false),
    }));
    expect(state.scoredSeconds).toBe(before.scoredSeconds);
    expect(state.controlVariation).toBe(before.controlVariation);
    state = advanceVocalFlightScore(state, scoreSample({ control: control(1, 1) }));
    expect(state.controlVariation).toBe(before.controlVariation);
  });
});
