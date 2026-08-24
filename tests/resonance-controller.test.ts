import { describe, expect, it } from "vitest";
import type { YinPitchFrame } from "@noteforge/pitch-engine";

import {
  RESONANCE_CONTROLLER_MINIMUM_CONFIDENCE,
  RESONANCE_REFERENCE_FRAME_COUNT,
  advanceResonanceController,
  createResonanceController,
  resetResonanceController,
  toResonanceTutorialVoiceEvidence,
  toResonanceVoiceInput,
  updateResonanceControllerFromFrame,
  type ResonanceControllerState,
} from "../apps/web/src/features/voice-arcade/resonance-controller";
import {
  computeResonanceForce,
  createResonanceGame,
  evaluateResonanceVoice,
  evaluateResonatorActivation,
  type ResonanceLevelDefinition,
} from "../apps/web/src/features/voice-arcade/resonance-physics";

const FRAME_SECONDS = 0.08;
const TARGET_MIDI = 48;

const ADAPTER_LEVEL = {
  id: "resonance-controller-adapter-proof",
  room: { width: 8, height: 5 },
  obstacles: [],
  ball: { position: { x: 2, y: 2.5 }, radius: 0.3 },
  goal: { position: { x: 7, y: 2.5 }, radius: 0.7 },
  microphone: {
    position: { x: 1, y: 2.5 },
    gain: 8,
    falloffRadius: 6,
    direction: { x: 1, y: 0 },
    directivity: 1,
  },
  resonators: [{
    id: "c3-proof",
    position: { x: 3, y: 2.5 },
    targetMidi: TARGET_MIDI,
    bandwidthCents: 30,
    gain: 10,
    influenceRadius: 4,
    mode: "attract",
  }],
} as const satisfies ResonanceLevelDefinition;

function rmsFromDbfs(dbfs: number): number {
  return 10 ** (dbfs / 20);
}

function frequencyFromMidi(midiFloat: number): number {
  return 440 * 2 ** ((midiFloat - 69) / 12);
}

function frame(
  timeSeconds: number,
  midiFloat: number | null = TARGET_MIDI,
  options: {
    dbfs?: number;
    confidence?: number;
    reason?: YinPitchFrame["reason"];
    voiced?: boolean;
  } = {},
): YinPitchFrame {
  const voiced = options.voiced ?? midiFloat !== null;
  const confidence = options.confidence ?? (voiced ? 0.96 : 0);
  const reason = options.reason ?? (voiced ? "detected" : "below-rms-threshold");
  const nearestMidi = midiFloat === null ? null : Math.round(midiFloat);
  return {
    timeSeconds,
    frequencyHz: midiFloat === null ? null : frequencyFromMidi(midiFloat),
    midiFloat,
    nearestMidi,
    centsFromNearest: midiFloat === null ? null : (midiFloat - nearestMidi!) * 100,
    rms: rmsFromDbfs(options.dbfs ?? -24),
    confidence,
    voiced,
    detector: "yin",
    periodSamples: midiFloat === null ? null : 48_000 / frequencyFromMidi(midiFloat),
    yinValue: voiced ? 1 - confidence : null,
    reason,
  };
}

function consume(
  state: ResonanceControllerState,
  observation: YinPitchFrame,
  receivedAtSeconds = observation.timeSeconds,
  advanceSeconds = FRAME_SECONDS,
): ResonanceControllerState {
  const updated = updateResonanceControllerFromFrame(
    state,
    observation,
    receivedAtSeconds,
  ).state;
  return advanceResonanceController(updated, {
    nowSeconds: receivedAtSeconds + advanceSeconds,
    deltaSeconds: advanceSeconds,
  });
}

function stableSession(
  dbfs = -24,
  midiFloat = TARGET_MIDI,
): ResonanceControllerState {
  let state = createResonanceController();
  for (let index = 0; index < RESONANCE_REFERENCE_FRAME_COUNT; index += 1) {
    state = consume(state, frame(index * FRAME_SECONDS, midiFloat, { dbfs }));
  }
  return state;
}

describe("session-normalized Resonance control", () => {
  it("can retain only the comfort reference between tutorial puzzles", () => {
    const prior = stableSession(-27, TARGET_MIDI + .2);
    const reset = resetResonanceController(prior, { retainReference: true });

    expect(reset.referenceDbfs).toBeCloseTo(-27, 8);
    expect(reset.referenceLocked).toBe(true);
    expect(reset.referenceSamplesDbfs).toEqual(prior.referenceSamplesDbfs);
    expect(reset.coupling).toBe(1);
    expect(reset.pitchHistory).toEqual([]);
    expect(reset.midiFloat).toBeNull();
    expect(reset.normalizedLevel).toBe(0);
    expect(reset.drive).toBe(0);
    expect(reset.lastReliableReceivedAtSeconds).toBeNull();

    const fullyFresh = resetResonanceController(prior);
    expect(fullyFresh.referenceDbfs).toBeNull();
    expect(fullyFresh.referenceSamplesDbfs).toEqual([]);
  });

  it("ramps immediately from live evidence and locks the first-eight median", () => {
    const levels = [-31, -29, -27, -25, -23, -21, -19, -17];
    let state = createResonanceController();

    state = consume(state, frame(0, TARGET_MIDI, { dbfs: levels[0] }));
    expect(state.status).toBe("coupling");
    expect(state.coupling).toBe(1 / RESONANCE_REFERENCE_FRAME_COUNT);
    expect(state.referenceLocked).toBe(false);
    expect(state.drive).toBeGreaterThan(0);

    for (let index = 1; index < levels.length; index += 1) {
      state = consume(state, frame(index * FRAME_SECONDS, TARGET_MIDI, {
        dbfs: levels[index],
      }));
    }

    expect(state.referenceLocked).toBe(true);
    expect(state.coupling).toBe(1);
    expect(state.referenceSamplesDbfs).toHaveLength(8);
    expect(state.referenceDbfs).toBeCloseTo(-24, 8);
    expect(state.status).toBe("driving");

    const frozen = consume(state, frame(0.8, TARGET_MIDI, { dbfs: -6 }));
    expect(frozen.referenceDbfs).toBeCloseTo(-24, 8);
    expect(frozen.referenceSamplesDbfs).toEqual(state.referenceSamplesDbfs);
  });

  it("is invariant to a uniform microphone-gain offset", () => {
    const relativeSequence = [0, 0, 0, 0, 0, 0, 0, 0, -6, 3, 6, -3];
    let quietDevice = createResonanceController();
    let hotDevice = createResonanceController();

    relativeSequence.forEach((offset, index) => {
      const time = index * FRAME_SECONDS;
      quietDevice = consume(quietDevice, frame(time, TARGET_MIDI, { dbfs: -36 + offset }));
      hotDevice = consume(hotDevice, frame(time, TARGET_MIDI, { dbfs: -18 + offset }));
      expect(quietDevice.targetNormalizedLevel).toBeCloseTo(hotDevice.targetNormalizedLevel, 10);
      expect(quietDevice.normalizedLevel).toBeCloseTo(hotDevice.normalizedLevel, 10);
      expect(quietDevice.targetDrive).toBeCloseTo(hotDevice.targetDrive, 10);
      expect(quietDevice.drive).toBeCloseTo(hotDevice.drive, 10);
    });

    expect(quietDevice.referenceDbfs).toBeCloseTo(-36, 8);
    expect(hotDevice.referenceDbfs).toBeCloseTo(-18, 8);
  });

  it("uses a fixed inclusive 0.58 reliability floor", () => {
    const below = updateResonanceControllerFromFrame(
      createResonanceController(),
      frame(0, TARGET_MIDI, {
        confidence: RESONANCE_CONTROLLER_MINIMUM_CONFIDENCE - 0.001,
      }),
      0,
    );
    const boundary = updateResonanceControllerFromFrame(
      createResonanceController(),
      frame(0, TARGET_MIDI, {
        confidence: RESONANCE_CONTROLLER_MINIMUM_CONFIDENCE,
      }),
      0,
    );

    expect(below.accepted).toBe(false);
    expect(below.state.referenceDbfs).toBeNull();
    expect(boundary.accepted).toBe(true);
    expect(boundary.state.periodicity).toBe(0);
    expect(boundary.state.targetDrive).toBe(0);
  });

  it("never lets noise, uncertain pitch, or invalid samples build the reference or force", () => {
    const observations = [
      frame(0, null, { dbfs: -18 }),
      frame(0.08, TARGET_MIDI, {
        dbfs: -18,
        confidence: 0.3,
        reason: "below-confidence-threshold",
        voiced: false,
      }),
      frame(0.16, TARGET_MIDI, {
        dbfs: -18,
        confidence: 0,
        reason: "invalid-samples",
        voiced: false,
      }),
    ];
    let state = createResonanceController();
    observations.forEach((observation) => {
      state = consume(state, observation);
    });

    expect(state.reliableFrameCount).toBe(0);
    expect(state.referenceDbfs).toBeNull();
    expect(state.referenceSamplesDbfs).toEqual([]);
    expect(state.targetNormalizedLevel).toBe(0);
    expect(state.drive).toBe(0);
  });

  it("rewards steady pitch over equal-level jitter", () => {
    let steady = stableSession();
    let jitter = stableSession();
    for (let index = 0; index < 8; index += 1) {
      const time = (RESONANCE_REFERENCE_FRAME_COUNT + index) * FRAME_SECONDS;
      steady = consume(steady, frame(time, TARGET_MIDI));
      jitter = consume(jitter, frame(time, TARGET_MIDI + (index % 2 === 0 ? -0.3 : 0.3)));
    }

    expect(steady.stability).toBeGreaterThan(0.95);
    expect(jitter.stability).toBeLessThan(0.1);
    expect(steady.targetDrive).toBeGreaterThan(0.6);
    expect(jitter.targetDrive).toBeLessThan(0.08);
  });

  it("makes moderate coherent sound stronger than louder unstable sound", () => {
    let coherent = stableSession();
    let unstable = stableSession();
    for (let index = 0; index < 8; index += 1) {
      const time = (RESONANCE_REFERENCE_FRAME_COUNT + index) * FRAME_SECONDS;
      coherent = consume(coherent, frame(time, TARGET_MIDI, { dbfs: -24 }));
      unstable = consume(unstable, frame(
        time,
        TARGET_MIDI + (index % 2 === 0 ? -0.35 : 0.35),
        { dbfs: -18 },
      ));
    }

    expect(unstable.targetNormalizedLevel).toBe(1);
    expect(coherent.targetNormalizedLevel).toBeCloseTo(2 / 3, 8);
    expect(coherent.targetDrive).toBeGreaterThan(unstable.targetDrive);
  });

  it("ignores duplicate and out-of-order timestamps without mutating state", () => {
    const initial = stableSession();
    const duplicate = updateResonanceControllerFromFrame(
      initial,
      frame(initial.lastFrameTimeSeconds!, TARGET_MIDI + 1, { dbfs: -6 }),
      1,
    );
    const older = updateResonanceControllerFromFrame(
      initial,
      frame(initial.lastFrameTimeSeconds! - 0.01, TARGET_MIDI - 1, { dbfs: -60 }),
      1,
    );

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.state).toBe(initial);
    expect(older.duplicate).toBe(true);
    expect(older.state).toBe(initial);
  });
});

describe("Resonance controller timing and physics adapter", () => {
  it("smooths attack, releases faster, and decays stale evidence to zero", () => {
    let state = stableSession();
    expect(state.drive).toBeGreaterThan(0);
    expect(state.drive).toBeLessThanOrEqual(1);
    const beforeRelease = state.drive;

    const silenceTime = state.lastFrameTimeSeconds! + FRAME_SECONDS;
    state = updateResonanceControllerFromFrame(
      state,
      frame(silenceTime, null),
      silenceTime,
    ).state;
    expect(state.targetDrive).toBe(0);
    expect(state.drive).toBe(beforeRelease);

    state = advanceResonanceController(state, {
      nowSeconds: silenceTime + 0.05,
      deltaSeconds: 0.05,
    });
    expect(state.status).toBe("releasing");
    expect(state.drive).toBeGreaterThan(0);
    expect(state.drive).toBeLessThan(beforeRelease);

    state = advanceResonanceController(state, {
      nowSeconds: silenceTime + 1,
      deltaSeconds: 1,
    });
    expect(state.drive).toBe(0);
    expect(state.normalizedLevel).toBe(0);

    let stale = stableSession();
    const lastReceipt = stale.lastReliableReceivedAtSeconds!;
    stale = advanceResonanceController(stale, {
      nowSeconds: lastReceipt + stale.options.freshnessSeconds + 0.001,
      deltaSeconds: 0.1,
    });
    expect(stale.status).toBe("stale");
    expect(stale.targetDrive).toBe(0);
    expect(stale.targetNormalizedLevel).toBe(0);
    const decayingDrive = stale.drive;
    stale = advanceResonanceController(stale, {
      nowSeconds: lastReceipt + 2,
      deltaSeconds: 2,
    });
    expect(stale.drive).toBe(0);
    expect(stale.drive).toBeLessThan(decayingDrive);
  });

  it("emits only bounded scalars through the stable physics adapter", () => {
    const state = stableSession();
    const voice = toResonanceVoiceInput(state);
    const evaluated = evaluateResonanceVoice(voice);

    expect(Object.keys(voice).sort()).toEqual([
      "coherentDrive",
      "confidence",
      "frequencyHz",
      "midiFloat",
      "normalizedLevel",
      "stability",
      "voiced",
    ]);
    expect(voice.voiced).toBe(true);
    expect(voice.midiFloat).toBeCloseTo(TARGET_MIDI, 8);
    expect(voice.normalizedLevel).toBeGreaterThan(0);
    expect(voice.normalizedLevel).toBeLessThanOrEqual(1);
    expect(voice.confidence).toBeGreaterThanOrEqual(RESONANCE_CONTROLLER_MINIMUM_CONFIDENCE);
    expect(voice.stability).toBeGreaterThanOrEqual(0);
    expect(voice.stability).toBeLessThanOrEqual(1);
    expect(evaluated.active).toBe(true);

    const silent = toResonanceVoiceInput(createResonanceController());
    expect(silent).toEqual({
      voiced: false,
      midiFloat: null,
      frequencyHz: null,
      normalizedLevel: 0,
      coherentDrive: 0,
      confidence: 0,
      stability: 0,
    });
  });

  it("exposes zero-coherence reliable evidence only to the explicit tutorial policy", () => {
    const stable = stableSession();
    const zeroCoherence: ResonanceControllerState = {
      ...stable,
      evidenceReliable: true,
      stability: 0,
      coherence: 0,
      targetDrive: 0,
      drive: 0,
    };

    expect(toResonanceVoiceInput(zeroCoherence).voiced).toBe(false);
    expect(toResonanceTutorialVoiceEvidence(zeroCoherence)).toMatchObject({
      voiced: true,
      midiFloat: TARGET_MIDI,
      coherentDrive: 0,
      stability: 0,
    });
  });

  it("validates controller and clock options at the boundary", () => {
    expect(() => createResonanceController({ freshnessSeconds: 0 })).toThrow(RangeError);
    expect(() => createResonanceController({ stableSpreadCents: 50, unstableSpreadCents: 50 }))
      .toThrow(RangeError);
    const state = createResonanceController();
    expect(() => updateResonanceControllerFromFrame(state, frame(0), -1)).toThrow(RangeError);
    expect(() => advanceResonanceController(state, { nowSeconds: 0, deltaSeconds: -0.1 }))
      .toThrow(RangeError);
  });
});

describe("canonical Resonance controller-to-physics drive", () => {
  function evaluateAdapter(state: Readonly<ResonanceControllerState>) {
    const input = toResonanceVoiceInput(state);
    const voiceEvaluation = evaluateResonanceVoice(input);
    const game = createResonanceGame(ADAPTER_LEVEL);
    const activations = game.level.resonators.map((resonator) =>
      evaluateResonatorActivation(voiceEvaluation, resonator));
    return {
      input,
      voiceEvaluation,
      activations,
      force: computeResonanceForce(game, voiceEvaluation, activations),
    };
  }

  it("cannot manufacture force from an exact-floor frame whose controller drive is zero", () => {
    const updated = updateResonanceControllerFromFrame(
      createResonanceController(),
      frame(0, TARGET_MIDI, { confidence: RESONANCE_CONTROLLER_MINIMUM_CONFIDENCE }),
      0,
    ).state;
    const state = advanceResonanceController(updated, {
      nowSeconds: FRAME_SECONDS,
      deltaSeconds: FRAME_SECONDS,
    });
    expect(state.normalizedLevel).toBeGreaterThan(0);
    expect(state.drive).toBe(0);

    const evaluated = evaluateAdapter(state);
    expect(evaluated.input.coherentDrive).toBe(0);
    expect(evaluated.input.voiced).toBe(false);
    expect(evaluated.voiceEvaluation.directEnergy).toBe(0);
    expect(evaluated.activations.every((activation) => activation.effectiveEnergy === 0)).toBe(true);
    expect(evaluated.force).toEqual({ x: 0, y: 0 });
  });

  it("carries one decaying drive through uncertain and stale release, then reaches exact zero", () => {
    let state = stableSession();
    const live = evaluateAdapter(state);
    expect(live.input.coherentDrive).toBeCloseTo(state.drive, 12);
    expect(live.voiceEvaluation.directEnergy).toBeGreaterThan(0);

    const uncertainAt = state.lastFrameTimeSeconds! + FRAME_SECONDS;
    state = updateResonanceControllerFromFrame(
      state,
      frame(uncertainAt, null),
      uncertainAt,
    ).state;
    state = advanceResonanceController(state, {
      nowSeconds: uncertainAt + 0.05,
      deltaSeconds: 0.05,
    });
    const releasing = evaluateAdapter(state);
    expect(state.status).toBe("releasing");
    expect(releasing.input.coherentDrive).toBeGreaterThan(0);
    expect(releasing.input.coherentDrive).toBeLessThan(live.input.coherentDrive);
    expect(releasing.voiceEvaluation.directEnergy).toBeGreaterThan(0);
    expect(releasing.voiceEvaluation.directEnergy).toBeLessThan(live.voiceEvaluation.directEnergy);

    const lastReliableAt = state.lastReliableReceivedAtSeconds!;
    state = advanceResonanceController(state, {
      nowSeconds: lastReliableAt + state.options.freshnessSeconds + 0.01,
      deltaSeconds: 0.01,
    });
    const staleRelease = evaluateAdapter(state);
    expect(state.status).toBe("stale");
    expect(staleRelease.input.coherentDrive).toBeGreaterThan(0);
    expect(staleRelease.voiceEvaluation.directEnergy).toBeGreaterThan(0);

    state = advanceResonanceController(state, {
      nowSeconds: lastReliableAt + 2,
      deltaSeconds: 2,
    });
    const silent = evaluateAdapter(state);
    expect(state.status).toBe("stale");
    expect(state.drive).toBe(0);
    expect(silent.input.coherentDrive).toBe(0);
    expect(silent.voiceEvaluation.directEnergy).toBe(0);
    expect(silent.activations.every((activation) => activation.effectiveEnergy === 0)).toBe(true);
    expect(silent.force).toEqual({ x: 0, y: 0 });
  });
});
