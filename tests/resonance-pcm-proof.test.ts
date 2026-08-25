import { describe, expect, it } from "vitest";
import { midiToFrequency } from "@noteforge/pitch-engine";
import { NoteInputEngine, type PitchObservation } from "../apps/web/src/audio/note-input";
import type { GeneratedResonanceLevel } from "../apps/web/src/features/voice-arcade/resonance-level";
import {
  createResonanceSession,
  reduceResonanceSession,
} from "../apps/web/src/features/voice-arcade/resonance-session";
import type { ResonanceLevelDefinition } from "../apps/web/src/features/voice-arcade/resonance-types";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const HOP_SIZE = 960;
const TARGET_MIDI = 48;

const LEVEL = {
  id: "resonance-pcm-pipeline-proof",
  room: { width: 10, height: 6 },
  obstacles: [],
  ball: { position: { x: 2, y: 3 }, radius: 0.3, linearDamping: 0.7 },
  goal: { position: { x: 9, y: 3 }, radius: 0.7 },
  microphone: {
    position: { x: 1, y: 3 },
    gain: 14,
    falloffRadius: 8,
    direction: { x: 1, y: 0 },
    directivity: 1,
  },
  resonators: [{
    id: "quiet-c3",
    position: { x: 4, y: 3 },
    targetMidi: TARGET_MIDI,
    bandwidthCents: 30,
    gain: 8,
    influenceRadius: 5,
    mode: "directional",
    direction: { x: 1, y: 0 },
  }],
} as const satisfies ResonanceLevelDefinition;

const GENERATED = {
  definition: LEVEL,
  metadata: {
    seed: "resonance-pcm-pipeline-proof",
    level: 1,
    difficulty: "easy",
    targetMidis: [TARGET_MIDI],
    routeWaypoints: [LEVEL.ball.position, LEVEL.goal.position],
  },
} as const satisfies GeneratedResonanceLevel;

function harmonicWindow(startSample: number, midi: number, rmsDbfs: number): Float32Array {
  const frequency = midiToFrequency(midi);
  const targetRms = 10 ** (rmsDbfs / 20);
  const harmonicScale = Math.sqrt(1 + 0.22 ** 2 + 0.09 ** 2);
  const amplitude = targetRms * Math.SQRT2 / harmonicScale;
  return Float32Array.from({ length: WINDOW_SIZE }, (_, index) => {
    const phase = 2 * Math.PI * frequency * (startSample + index) / SAMPLE_RATE;
    return amplitude * (
      Math.sin(phase)
      + 0.22 * Math.sin(phase * 2 + 0.2)
      + 0.09 * Math.sin(phase * 3 - 0.15)
    );
  });
}

function detectorObservation(
  engine: NoteInputEngine,
  index: number,
  midi: number | null,
  rmsDbfs = -60,
): PitchObservation {
  const startSample = index * HOP_SIZE;
  const samples = midi === null
    ? new Float32Array(WINDOW_SIZE)
    : harmonicWindow(startSample, midi, rmsDbfs);
  return engine.process({
    samples,
    sampleRate: SAMPLE_RATE,
    startSample,
    endSample: startSample + WINDOW_SIZE,
    processedSampleCount: startSample + WINDOW_SIZE,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    processCount: index + 1,
    discontinuity: false,
    capturedAt: (startSample * 2 + WINDOW_SIZE) / (2 * SAMPLE_RATE),
  }).observation;
}

function trackingSession() {
  const idle = createResonanceSession({
    seed: "preview",
    difficulty: "easy",
    lowMidi: 43,
    highMidi: 55,
    baselineMidi: TARGET_MIDI,
  });
  const installed = reduceResonanceSession(idle, {
    type: "install",
    chamberNumber: 1,
    generated: GENERATED,
  });
  return reduceResonanceSession(installed, { type: "start" });
}

describe("Resonance PCM-to-session integration (not browser proof)", () => {
  it("moves from quiet low-note PCM with exact overlapping sample authority", () => {
    const engine = new NoteInputEngine();
    let state = trackingSession();
    const initialX = state.game.ball.position.x;
    const observations: PitchObservation[] = [];

    for (let index = 0; index < 28; index += 1) {
      const observation = detectorObservation(engine, index, TARGET_MIDI, -62);
      observations.push(observation);
      state = reduceResonanceSession(state, { type: "observation", observation });
    }

    expect(observations.every((frame) => frame.observationKind === "voiced")).toBe(true);
    expect(observations.every((frame) => frame.nearestMidi === TARGET_MIDI)).toBe(true);
    expect(observations.slice(1).every((frame, index) => (
      frame.endSample - observations[index]!.endSample === HOP_SIZE
    ))).toBe(true);
    expect(state.controller.evidenceReliable).toBe(true);
    expect(state.game.ball.position.x).toBeGreaterThan(initialX);
    expect(state.game.elapsedSeconds + state.game.accumulatorSeconds)
      .toBeCloseTo((observations.length - 1) * HOP_SIZE / SAMPLE_RATE, 10);
    expect(state.targetDwell.heldSamples).toBe((observations.length - 1) * HOP_SIZE);
  });

  it("keeps processing silence, applies zero new voice force, and resumes on the next note", () => {
    const engine = new NoteInputEngine();
    let state = trackingSession();
    for (let index = 0; index < 8; index += 1) {
      state = reduceResonanceSession(state, {
        type: "observation",
        observation: detectorObservation(engine, index, TARGET_MIDI, -58),
      });
    }
    const heldBeforeSilence = state.targetDwell.heldSamples;
    const elapsedBeforeSilence = state.game.elapsedSeconds + state.game.accumulatorSeconds;

    for (let index = 8; index < 18; index += 1) {
      const silence = detectorObservation(engine, index, null);
      expect(silence.observationKind).toBe("unvoiced");
      state = reduceResonanceSession(state, { type: "observation", observation: silence });
    }
    expect(state.controller.status).toBe("unvoiced");
    expect(state.controller.drive).toBe(0);
    expect(state.targetDwell.heldSamples).toBe(heldBeforeSilence);
    expect(state.game.elapsedSeconds + state.game.accumulatorSeconds)
      .toBeCloseTo(elapsedBeforeSilence + 10 * HOP_SIZE / SAMPLE_RATE, 10);

    const resumed = detectorObservation(engine, 18, TARGET_MIDI, -64);
    state = reduceResonanceSession(state, { type: "observation", observation: resumed });
    expect(state.controller.status).toBe("driving");
    expect(state.targetDwell.heldSamples).toBe(heldBeforeSilence + HOP_SIZE);
  });

  it("resets target occupancy only after credible wrong-note PCM", () => {
    const engine = new NoteInputEngine();
    let state = trackingSession();
    for (let index = 0; index < 6; index += 1) {
      state = reduceResonanceSession(state, {
        type: "observation",
        observation: detectorObservation(engine, index, TARGET_MIDI, -60),
      });
    }
    expect(state.targetDwell.heldSamples).toBeGreaterThan(0);

    const wrongNote = detectorObservation(engine, 6, TARGET_MIDI + 3, -60);
    expect(wrongNote.observationKind).toBe("voiced");
    state = reduceResonanceSession(state, { type: "observation", observation: wrongNote });
    expect(state.targetDwell.heldSamples).toBe(0);
  });
});
