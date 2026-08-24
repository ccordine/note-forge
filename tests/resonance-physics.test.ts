import { describe, expect, it } from "vitest";

import { generateResonanceLevel } from "../apps/web/src/features/voice-arcade/resonance-level";
import {
  RESONANCE_MINIMUM_CONFIDENCE,
  advanceResonanceGame,
  computeResonanceForce,
  createResonanceGame,
  evaluateResonanceVoice,
  evaluateResonatorActivation,
  normalizeResonanceIntensity,
  sampleResonanceField,
  type ResonanceGameState,
  type ResonanceLevelDefinition,
  type ResonanceVoiceInput,
} from "../apps/web/src/features/voice-arcade/resonance-physics";

const TARGET_MIDI = 60;

const BASE_LEVEL = {
  id: "resonance-physics-proof",
  room: { width: 10, height: 6 },
  obstacles: [],
  ball: {
    position: { x: 2, y: 3 },
    radius: 0.3,
    mass: 1,
    restitution: 0.3,
    linearDamping: 0.6,
  },
  goal: { position: { x: 9, y: 3 }, radius: 0.7 },
  microphone: {
    position: { x: 1, y: 3 },
    gain: 8,
    falloffRadius: 7,
    direction: { x: 1, y: 0 },
    directivity: 1,
  },
  resonators: [{
    id: "c4-lift",
    position: { x: 2, y: 2 },
    targetMidi: TARGET_MIDI,
    bandwidthCents: 30,
    gain: 10,
    influenceRadius: 4,
    mode: "directional",
    direction: { x: 0, y: -1 },
  }],
} as const satisfies ResonanceLevelDefinition;

function voice(
  midiFloat: number | null = TARGET_MIDI,
  overrides: Partial<ResonanceVoiceInput> = {},
): ResonanceVoiceInput {
  const normalizedLevel = overrides.normalizedLevel ?? 0.68;
  return {
    voiced: midiFloat !== null,
    midiFloat,
    frequencyHz: midiFloat === null ? null : 440 * 2 ** ((midiFloat - 69) / 12),
    normalizedLevel,
    coherentDrive: normalizedLevel,
    confidence: 0.96,
    stability: 0.94,
    ...overrides,
  };
}

function advanceFor(
  initial: ResonanceGameState,
  input: ResonanceVoiceInput,
  seconds: number,
  chunkSeconds = 0.05,
): ResonanceGameState {
  let state = initial;
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += chunkSeconds) {
    state = advanceResonanceGame(
      state,
      input,
      Math.min(chunkSeconds, seconds - elapsed),
    ).state;
  }
  return state;
}

describe("Resonance voice-to-force evidence", () => {
  it("rewards a comfortable normalized level and tapers overdrive", () => {
    const silent = normalizeResonanceIntensity(0);
    const quiet = normalizeResonanceIntensity(0.3);
    const comfortable = normalizeResonanceIntensity(0.68);
    const overdriven = normalizeResonanceIntensity(1);

    expect(silent).toBe(0);
    expect(quiet).toBeGreaterThan(0);
    expect(comfortable).toBe(1);
    expect(overdriven).toBeCloseTo(0.6, 8);
    expect(overdriven).toBeLessThan(comfortable);
    for (let level = -0.2; level <= 1.2; level += 0.01) {
      expect(normalizeResonanceIntensity(level)).toBeGreaterThanOrEqual(0);
      expect(normalizeResonanceIntensity(level)).toBeLessThanOrEqual(1);
    }
  });

  it("accepts either interpreted MIDI or F0, but not unreliable evidence", () => {
    const fromFrequency = evaluateResonanceVoice(voice(null, {
      voiced: true,
      frequencyHz: 261.625565,
    }));
    expect(fromFrequency.active).toBe(true);
    expect(fromFrequency.midiFloat).toBeCloseTo(60, 5);

    const threshold = evaluateResonanceVoice(voice(60, {
      confidence: RESONANCE_MINIMUM_CONFIDENCE,
    }));
    expect(threshold.active).toBe(true);
    expect(threshold.directEnergy).toBeGreaterThan(0);
    expect(evaluateResonanceVoice(voice(60, {
      confidence: RESONANCE_MINIMUM_CONFIDENCE - 0.001,
    })).active).toBe(false);
    expect(evaluateResonanceVoice(voice(60, { voiced: false })).directEnergy).toBe(0);
    expect(evaluateResonanceVoice(voice(Number.NaN)).active).toBe(false);
  });

  it("combines pitch accuracy with the controller's authoritative coherent drive", () => {
    const resonator = BASE_LEVEL.resonators[0]!;
    const centered = evaluateResonatorActivation(
      evaluateResonanceVoice(voice(60)),
      resonator,
    );
    const thirtyCentsSharp = evaluateResonatorActivation(
      evaluateResonanceVoice(voice(60.3)),
      resonator,
    );
    const wrongNote = evaluateResonatorActivation(
      evaluateResonanceVoice(voice(61)),
      resonator,
    );
    const unstable = evaluateResonatorActivation(
      evaluateResonanceVoice(voice(60, { stability: 0, coherentDrive: 0 })),
      resonator,
    );

    expect(centered.centsError).toBe(0);
    expect(centered.pitchAccuracy).toBe(1);
    expect(thirtyCentsSharp.pitchAccuracy).toBeCloseTo(Math.exp(-0.5), 8);
    expect(wrongNote.effectiveEnergy).toBeLessThan(0.01);
    expect(unstable.effectiveEnergy).toBe(0);
  });

  it("does not grade confidence and stability a second time after coherent drive is supplied", () => {
    const lowerTelemetry = evaluateResonanceVoice(voice(60, {
      coherentDrive: 0.34,
      confidence: 0.6,
      stability: 0.2,
    }));
    const higherTelemetry = evaluateResonanceVoice(voice(60, {
      coherentDrive: 0.34,
      confidence: 0.99,
      stability: 1,
    }));

    expect(lowerTelemetry.active).toBe(true);
    expect(lowerTelemetry.evidenceCoherence).toBeCloseTo(0.5, 12);
    expect(lowerTelemetry.directEnergy).toBeCloseTo(higherTelemetry.directEnergy, 12);
  });

  it("makes the tuned resonator a distinct force dimension", () => {
    const state = createResonanceGame(BASE_LEVEL);
    const centeredVoice = evaluateResonanceVoice(voice(60));
    const centeredActivation = BASE_LEVEL.resonators.map((resonator) =>
      evaluateResonatorActivation(centeredVoice, resonator));
    const wrongVoice = evaluateResonanceVoice(voice(62));
    const wrongActivation = BASE_LEVEL.resonators.map((resonator) =>
      evaluateResonatorActivation(wrongVoice, resonator));
    const centeredForce = computeResonanceForce(state, centeredVoice, centeredActivation);
    const wrongForce = computeResonanceForce(state, wrongVoice, wrongActivation);

    expect(centeredForce.x).toBeGreaterThan(0);
    expect(centeredForce.y).toBeLessThan(-5);
    expect(Math.abs(wrongForce.y)).toBeLessThan(0.01);
  });

  it("keeps a fully directional source on its authored forward axis", () => {
    const directionalLevel: ResonanceLevelDefinition = {
      ...BASE_LEVEL,
      id: "directional-source-proof",
      ball: { ...BASE_LEVEL.ball, position: { x: 2, y: 4.5 } },
      resonators: [],
      microphone: {
        ...BASE_LEVEL.microphone,
        position: { x: 1, y: 1.5 },
        direction: { x: 1, y: 0 },
        directivity: 1,
      },
    };
    const state = createResonanceGame(directionalLevel);
    const evaluated = evaluateResonanceVoice(voice());
    const force = computeResonanceForce(state, evaluated, []);

    expect(force.x).toBeGreaterThan(0);
    expect(force.y).toBeCloseTo(0, 12);
  });

  it("applies the same authored obstacle transmission to visible and physical fields", () => {
    const openLevel: ResonanceLevelDefinition = {
      ...BASE_LEVEL,
      id: "open-force-path",
      resonators: [],
    };
    const blockedLevel: ResonanceLevelDefinition = {
      ...openLevel,
      id: "blocked-force-path",
      obstacles: [{
        id: "force-absorber",
        x: 1.45,
        y: 0,
        width: .1,
        height: 6,
        acousticTransmission: .12,
      }],
    };
    const evaluated = evaluateResonanceVoice(voice());
    const openForce = computeResonanceForce(createResonanceGame(openLevel), evaluated, []);
    const blockedForce = computeResonanceForce(createResonanceGame(blockedLevel), evaluated, []);

    expect(openForce.x).toBeGreaterThan(0);
    expect(blockedForce.x).toBeCloseTo(openForce.x * .12, 10);
    expect(blockedForce.y).toBeCloseTo(0, 12);
  });
});

describe("Resonance fixed-step room physics", () => {
  it("is invariant to render-frame chunking when the evidence is unchanged", () => {
    const options = {
      fixedStepSeconds: 0.01,
      maximumFrameDeltaSeconds: 0.5,
      waveIntervalSeconds: 0.1,
    } as const;
    const initial = createResonanceGame(BASE_LEVEL, options);
    const oneFrame = advanceResonanceGame(initial, voice(), 0.4).state;
    let manyFrames = initial;
    for (let index = 0; index < 40; index += 1) {
      manyFrames = advanceResonanceGame(manyFrames, voice(), 0.01).state;
    }

    expect(manyFrames.fixedStepCount).toBe(oneFrame.fixedStepCount);
    expect(manyFrames.ball.position.x).toBeCloseTo(oneFrame.ball.position.x, 12);
    expect(manyFrames.ball.position.y).toBeCloseTo(oneFrame.ball.position.y, 12);
    expect(manyFrames.ball.velocity.x).toBeCloseTo(oneFrame.ball.velocity.x, 12);
    expect(manyFrames.ball.velocity.y).toBeCloseTo(oneFrame.ball.velocity.y, 12);
    expect(manyFrames.wavePulses).toEqual(oneFrame.wavePulses);
  });

  it("cannot tunnel through a thin obstacle at the maximum speed", () => {
    const wallLevel: ResonanceLevelDefinition = {
      ...BASE_LEVEL,
      id: "collision-proof",
      obstacles: [{
        id: "thin-wall",
        x: 4,
        y: 0,
        width: 0.02,
        height: 6,
        acousticTransmission: 0.1,
      }],
      resonators: [],
      goal: { position: { x: 8.8, y: 3 }, radius: 0.7 },
      microphone: { ...BASE_LEVEL.microphone, gain: 100 },
    };
    const state = advanceFor(createResonanceGame(wallLevel, {
      maximumSpeed: 18,
      maximumForce: 100,
    }), voice(60), 2);

    expect(state.collisionCount).toBeGreaterThan(0);
    expect(state.ball.position.x).toBeLessThanOrEqual(4 - state.ball.radius + 1e-7);
    expect(state.ball.position.x).toBeGreaterThanOrEqual(state.ball.radius);
    expect(state.ball.position.y).toBeGreaterThanOrEqual(state.ball.radius);
    expect(state.ball.position.y).toBeLessThanOrEqual(6 - state.ball.radius);
  });

  it("uses the moderate-level efficiency curve in actual movement", () => {
    const level = { ...BASE_LEVEL, resonators: [] } satisfies ResonanceLevelDefinition;
    const comfortable = advanceFor(createResonanceGame(level), voice(60, {
      normalizedLevel: 0.68,
    }), 0.4);
    const overdriven = advanceFor(createResonanceGame(level), voice(60, {
      normalizedLevel: 1,
    }), 0.4);

    expect(comfortable.ball.position.x).toBeGreaterThan(overdriven.ball.position.x);
  });

  it("bounds suspended-frame catch-up and reports discarded wall time", () => {
    const initial = createResonanceGame(BASE_LEVEL, {
      fixedStepSeconds: 0.01,
      maximumFrameDeltaSeconds: 0.2,
    });
    const result = advanceResonanceGame(initial, voice(), 5);
    expect(result.simulatedSteps).toBe(20);
    expect(result.state.droppedSeconds).toBeCloseTo(4.8, 12);
    expect(result.state.elapsedSeconds).toBeCloseTo(0.2, 12);
  });

  it("detects a win when the complete ball enters the goal and then freezes", () => {
    const shortLevel: ResonanceLevelDefinition = {
      ...BASE_LEVEL,
      id: "goal-proof",
      resonators: [],
      goal: { position: { x: 2.9, y: 3 }, radius: 0.65 },
      microphone: { ...BASE_LEVEL.microphone, gain: 18 },
    };
    let state = createResonanceGame(shortLevel);
    let wonThisAdvance = false;
    for (let index = 0; index < 40 && state.status === "playing"; index += 1) {
      const result = advanceResonanceGame(state, voice(), 0.05);
      state = result.state;
      wonThisAdvance ||= result.wonThisAdvance;
    }
    expect(state.status).toBe("won");
    expect(wonThisAdvance).toBe(true);
    const frozen = advanceResonanceGame(state, voice(64), 0.2);
    expect(frozen.state).toBe(state);
    expect(frozen.simulatedSteps).toBe(0);
  });
});

describe("Resonance pressure-wave representation", () => {
  it("emits bounded source and tuned-resonator pulses and exposes field samples", () => {
    let state = createResonanceGame(BASE_LEVEL, {
      waveIntervalSeconds: 0.05,
      maximumWavePulses: 6,
      fixedStepSeconds: 0.01,
    });
    state = advanceFor(state, voice(), 0.21, 0.03);

    expect(state.wavePulses.length).toBe(6);
    expect(state.wavePulses.some((pulse) => pulse.originKind === "microphone")).toBe(true);
    expect(state.wavePulses.some((pulse) => pulse.originKind === "resonator")).toBe(true);
    const pulse = state.wavePulses.at(-1)!;
    const sample = sampleResonanceField(state, {
      x: pulse.origin.x + pulse.radius,
      y: pulse.origin.y,
    });
    expect(sample.contributingPulses).toBeGreaterThan(0);
    expect(sample.intensity).toBeGreaterThan(0);
    expect(Number.isFinite(sample.pressure)).toBe(true);
    expect(Number.isFinite(sample.gradient.x)).toBe(true);
  });

  it("attenuates a pulse sampled behind an acoustically absorbing obstacle", () => {
    const openLevel: ResonanceLevelDefinition = {
      ...BASE_LEVEL,
      resonators: [],
      microphone: { ...BASE_LEVEL.microphone, directivity: 0 },
    };
    const blockedLevel: ResonanceLevelDefinition = {
      ...openLevel,
      id: "field-occlusion-proof",
      obstacles: [{
        id: "absorber",
        x: 4,
        y: 0.5,
        width: 0.3,
        height: 5,
        acousticTransmission: 0.1,
      }],
    };
    let open = createResonanceGame(openLevel, {
      fixedStepSeconds: 0.01,
      waveIntervalSeconds: 0.05,
      waveSpeed: 20,
      waveShellWidth: 0.3,
    });
    let blocked = createResonanceGame(blockedLevel, open.options);
    open = advanceFor(open, voice(), 0.2, 0.02);
    blocked = advanceFor(blocked, voice(), 0.2, 0.02);
    const samplePoint = { x: 4.9, y: 3 };
    const openSample = sampleResonanceField(open, samplePoint);
    const blockedSample = sampleResonanceField(blocked, samplePoint);
    expect(openSample.intensity).toBeGreaterThan(0);
    expect(blockedSample.intensity).toBeLessThan(openSample.intensity * 0.2);
  });
});

describe("deterministic Resonance level generation", () => {
  it("repeats the same seeded room and changes content with seed or level", () => {
    const options = {
      seed: "resonance-seed",
      level: 3,
      difficulty: "hard",
      lowMidi: 45,
      highMidi: 62,
      baselineMidi: 52,
    } as const;
    const first = generateResonanceLevel(options);
    const repeated = generateResonanceLevel(options);
    const otherSeed = generateResonanceLevel({ ...options, seed: "other-seed" });
    const otherLevel = generateResonanceLevel({ ...options, level: 4 });

    expect(repeated).toEqual(first);
    expect(otherSeed).not.toEqual(first);
    expect(otherLevel).not.toEqual(first);
    expect(first.definition.obstacles).toHaveLength(6);
    expect(first.definition.resonators).toHaveLength(4);
    expect(first.definition.resonators.at(-1)).toMatchObject({
      id: "goal-resonator",
      mode: "attract",
      position: first.definition.goal.position,
    });
    expect(new Set(first.metadata.targetMidis).size).toBe(4);
    expect(first.metadata.targetMidis.every((midi) => midi >= 45 && midi <= 62)).toBe(true);
    expect(() => createResonanceGame(first.definition)).not.toThrow();
  });

  it("generates valid rooms across difficulties, levels, and many seeds", () => {
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      for (let seed = 0; seed < 30; seed += 1) {
        const generated = generateResonanceLevel({
          seed,
          level: (seed % 12) + 1,
          difficulty,
          lowMidi: 43,
          highMidi: 67,
          baselineMidi: 52,
        });
        const state = createResonanceGame(generated.definition);
        expect(state.status).toBe("playing");
        expect(generated.metadata.routeWaypoints).toHaveLength(
          generated.definition.obstacles.length / 2 + 2,
        );
        expect(generated.definition.resonators).toHaveLength(
          generated.definition.obstacles.length / 2 + 1,
        );
      }
    }
  });

  it("rejects malformed generation and authored physics definitions", () => {
    const generation = {
      seed: "invalid-proof",
      lowMidi: 45,
      highMidi: 60,
      baselineMidi: 52,
    } as const;
    expect(() => generateResonanceLevel({ ...generation, seed: Number.NaN })).toThrow(RangeError);
    expect(() => generateResonanceLevel({ ...generation, level: 0 })).toThrow(RangeError);
    expect(() => generateResonanceLevel({ ...generation, lowMidi: 61 })).toThrow(RangeError);
    expect(() => generateResonanceLevel({ ...generation, baselineMidi: 61 })).toThrow(RangeError);
    expect(() => generateResonanceLevel({
      ...generation,
      lowMidi: 52,
      highMidi: 53,
      baselineMidi: 52,
      difficulty: "hard",
    })).toThrow(/at least 4 notes/);
    expect(() => createResonanceGame({
      ...BASE_LEVEL,
      obstacles: [{ id: "overlap", x: 1.9, y: 2.9, width: 1, height: 1 }],
    })).toThrow(/overlaps/);
    expect(() => createResonanceGame({
      ...BASE_LEVEL,
      resonators: [{ ...BASE_LEVEL.resonators[0]!, direction: undefined }],
    })).toThrow(/requires a direction/);
    expect(() => createResonanceGame(BASE_LEVEL, { fixedStepSeconds: 0 })).toThrow(RangeError);
    expect(() => advanceResonanceGame(createResonanceGame(BASE_LEVEL), voice(), -0.1))
      .toThrow(RangeError);
  });
});
