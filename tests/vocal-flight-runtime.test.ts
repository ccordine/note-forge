import { describe, expect, it } from "vitest";

import {
  advanceVocalFlight,
  createVocalFlightState,
} from "../apps/web/src/features/voice-arcade/vocal-flight/flight-runtime";
import type {
  VocalControlVector,
  VocalFlightInput,
  VocalFlightState,
} from "../apps/web/src/features/voice-arcade/vocal-flight/types";

function control(
  pitchAxis: number,
  brightnessAxis: number,
  active = true,
): VocalControlVector {
  return {
    pitchAxis,
    brightnessAxis,
    pitchConfidence: active ? 0.96 : 0,
    brightnessConfidence: active ? 0.94 : 0,
    voiced: active,
    active,
  };
}

function input(
  pitchAxis: number,
  brightnessAxis: number,
  overrides: Partial<VocalFlightInput> = {},
): VocalFlightInput {
  return { control: control(pitchAxis, brightnessAxis), ...overrides };
}

function advanceFor(
  initial: VocalFlightState,
  flightInput: VocalFlightInput,
  seconds: number,
  chunk = 0.02,
): VocalFlightState {
  let state = initial;
  for (let elapsed = 0; elapsed < seconds - 1e-10; elapsed += chunk) {
    state = advanceVocalFlight(state, flightInput, Math.min(chunk, seconds - elapsed));
  }
  return state;
}

describe("deterministic Vocal Flight arcade physics", () => {
  it("produces the same trajectory regardless of presentation chunking", () => {
    const initial = createVocalFlightState();
    const command = input(0.42, -0.36);
    const coarse = advanceFor(initial, command, 1, 0.1);
    const detectorCadence = advanceFor(initial, command, 1, 0.02);
    expect(coarse.fixedStepCount).toBe(200);
    expect(detectorCadence.fixedStepCount).toBe(200);
    expect(coarse.position.x).toBeCloseTo(detectorCadence.position.x, 10);
    expect(coarse.position.y).toBeCloseTo(detectorCadence.position.y, 10);
    expect(coarse.position.z).toBeCloseTo(detectorCadence.position.z, 10);
    expect(coarse.pitchRadians).toBeCloseTo(detectorCadence.pitchRadians, 10);
    expect(coarse.rollRadians).toBeCloseTo(detectorCadence.rollRadians, 10);
  });

  it("maps higher pitch to climb and brighter resonance to a coordinated right turn", () => {
    const initial = createVocalFlightState();
    const climbed = advanceFor(initial, input(0.65, 0), 1.2);
    expect(climbed.pitchRadians).toBeGreaterThan(0);
    expect(climbed.position.y).toBeGreaterThan(0);

    const banked = advanceFor(initial, input(0, 0.7), 1.2);
    expect(banked.rollRadians).toBeGreaterThan(0);
    expect(banked.headingRadians).toBeGreaterThan(0);
    expect(banked.position.x).toBeGreaterThan(0);
  });

  it("maps lower pitch and darker resonance to the opposite continuous response", () => {
    const state = advanceFor(createVocalFlightState(), input(-0.7, -0.65), 1.2);
    expect(state.pitchRadians).toBeLessThan(0);
    expect(state.rollRadians).toBeLessThan(0);
    expect(state.position.y).toBeLessThan(0);
    expect(state.position.x).toBeLessThan(0);
  });

  it("damps and self-levels after the vocal vector returns to neutral", () => {
    const displaced = advanceFor(createVocalFlightState(), input(0.8, -0.8), 1);
    const recovered = advanceFor(displaced, input(0, 0), 3);
    expect(Math.abs(recovered.pitchRadians)).toBeLessThan(Math.abs(displaced.pitchRadians));
    expect(Math.abs(recovered.rollRadians)).toBeLessThan(Math.abs(displaced.rollRadians));
    expect(Math.abs(recovered.pitchRate)).toBeLessThan(0.08);
    expect(Math.abs(recovered.rollRate)).toBeLessThan(0.08);
  });

  it("locks the unknown dimension in single-axis tutorials", () => {
    const initial = createVocalFlightState();
    const pitchOnly = advanceFor(initial, input(0.7, 1, { controlMode: "pitch" }), 1);
    expect(pitchOnly.pitchRadians).toBeGreaterThan(0);
    expect(pitchOnly.rollRadians).toBe(0);

    const brightnessOnly = advanceFor(initial, input(1, -0.7, {
      controlMode: "brightness",
    }), 1);
    expect(brightnessOnly.pitchRadians).toBe(0);
    expect(brightnessOnly.rollRadians).toBeLessThan(0);
  });

  it("lets neutral lessons reveal any acoustic displacement before release", () => {
    const displaced = advanceFor(createVocalFlightState(), input(0.5, -0.45, {
      controlMode: "neutral",
    }), 0.8);
    expect(displaced.pitchRadians).toBeGreaterThan(0);
    expect(displaced.rollRadians).toBeLessThan(0);
    const released = advanceFor(displaced, input(0, 0, { controlMode: "neutral" }), 2);
    expect(Math.abs(released.pitchRadians)).toBeLessThan(Math.abs(displaced.pitchRadians));
    expect(Math.abs(released.rollRadians)).toBeLessThan(Math.abs(displaced.rollRadians));
  });

  it("keeps constant propulsion during silence but applies exactly zero vocal force", () => {
    const initial = createVocalFlightState();
    const inactive = { control: control(1, 1, false) };
    const silent = advanceVocalFlight(initial, inactive, 0.02);
    const neutral = advanceVocalFlight(initial, input(0, 0), 0.02);
    expect(silent.position).toEqual(neutral.position);
    expect(silent.pitchRadians).toBe(0);
    expect(silent.rollRadians).toBe(0);
    expect(silent.position.z).toBeGreaterThan(0);
  });

  it("never catches up across an oversized or zero authority delta", () => {
    const initial = createVocalFlightState();
    expect(advanceVocalFlight(initial, input(1, 1), 0)).toBe(initial);
    expect(() => advanceVocalFlight(initial, input(1, 1), 0.101)).toThrow(/no-catch-up/);
    expect(initial.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("clamps attitude safely without snapping the aircraft to its input", () => {
    const initial = createVocalFlightState();
    const first = advanceVocalFlight(initial, input(1, 1), 0.005);
    const state = advanceFor(initial, input(1, 1), 10);
    expect(first.pitchRadians).toBeLessThan(0.001);
    expect(first.rollRadians).toBeLessThan(0.001);
    expect(Math.abs(state.pitchRadians)).toBeLessThanOrEqual(state.config.maximumPitchRadians);
    expect(Math.abs(state.rollRadians)).toBeLessThanOrEqual(state.config.maximumRollRadians);
  });
});
