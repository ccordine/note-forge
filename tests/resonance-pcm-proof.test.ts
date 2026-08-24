import { describe, expect, it } from "vitest";
import {
  midiToFrequency,
  type YinPitchFrame,
} from "@noteforge/pitch-engine";

import { NoteInputEngine } from "../apps/web/src/audio/note-input";
import {
  advanceResonanceController,
  createResonanceController,
  toResonanceTutorialVoiceEvidence,
  toResonanceVoiceInput,
  updateResonanceControllerFromFrame,
  type ResonanceControllerState,
} from "../apps/web/src/features/voice-arcade/resonance-controller";
import {
  advanceResonanceGame,
  createResonanceGame,
  evaluateResonanceVoice,
  evaluateResonatorActivation,
  type ResonanceGameState,
  type ResonanceLevelDefinition,
} from "../apps/web/src/features/voice-arcade/resonance-physics";
import {
  advanceResonanceTutorialSession,
  createResonanceTutorialSession,
  type ResonanceTutorialLessonId,
  type ResonanceTutorialSessionState,
} from "../apps/web/src/features/voice-arcade/resonance-tutorial";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const WINDOW_SECONDS = WINDOW_SIZE / SAMPLE_RATE;
const TARGET_MIDI = 48; // C3 · 130.81 Hz

type NoiseProfile = "none" | "white" | "room";

interface WindowRecipe {
  readonly midi?: number | null;
  readonly voiceRmsDbfs?: number;
  readonly snrDb?: number;
  readonly noiseRmsDbfs?: number;
  readonly noiseProfile?: NoiseProfile;
  readonly seed?: number;
  readonly pureSine?: boolean;
}

interface PipelineStep {
  readonly frame: YinPitchFrame;
  readonly state: ResonanceControllerState;
}

interface PipelineRun {
  readonly steps: readonly PipelineStep[];
  readonly state: ResonanceControllerState;
}

function amplitudeFromDbfs(dbfs: number): number {
  return 10 ** (dbfs / 20);
}

function rms(samples: ArrayLike<number>): number {
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sumSquares += samples[index]! * samples[index]!;
  }
  return samples.length === 0 ? 0 : Math.sqrt(sumSquares / samples.length);
}

function scaleToRms(samples: Float64Array, targetRms: number): void {
  const measured = rms(samples);
  if (measured <= 0) return;
  const scale = targetRms / measured;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] *= scale;
  }
}

function seededNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0xffff_ffff * 2 - 1;
  };
}

/**
 * Deterministic microphone-sized PCM. The voice model is either a sine or a
 * fundamental plus three vocal-style harmonics. Room noise adds seeded white
 * noise and 60/120 Hz electrical hum before exact RMS normalization.
 */
function makeWindow(recipe: Readonly<WindowRecipe>, windowIndex: number): Float32Array {
  const midi = recipe.midi === undefined ? TARGET_MIDI : recipe.midi;
  const voiceRmsDbfs = recipe.voiceRmsDbfs ?? -24;
  const noiseProfile = recipe.noiseProfile ?? (recipe.snrDb === undefined ? "none" : "room");
  const absoluteStart = windowIndex * WINDOW_SIZE;
  const voice = new Float64Array(WINDOW_SIZE);
  const noise = new Float64Array(WINDOW_SIZE);

  if (midi !== null) {
    const frequency = midiToFrequency(midi);
    const multiples = recipe.pureSine ? [1] : [1, 2, 3, 4];
    const weights = recipe.pureSine ? [1] : [1, 0.52, 0.27, 0.13];
    const phases = recipe.pureSine ? [0.1] : [0.1, 0.7, 1.3, 0.35];
    for (let index = 0; index < WINDOW_SIZE; index += 1) {
      const time = (absoluteStart + index) / SAMPLE_RATE;
      for (let harmonic = 0; harmonic < multiples.length; harmonic += 1) {
        voice[index] += weights[harmonic]!
          * Math.sin(2 * Math.PI * frequency * multiples[harmonic]! * time + phases[harmonic]!);
      }
    }
    scaleToRms(voice, amplitudeFromDbfs(voiceRmsDbfs));
  }

  let targetNoiseRms = 0;
  if (recipe.noiseRmsDbfs !== undefined) {
    targetNoiseRms = amplitudeFromDbfs(recipe.noiseRmsDbfs);
  } else if (recipe.snrDb !== undefined && midi !== null) {
    targetNoiseRms = amplitudeFromDbfs(voiceRmsDbfs - recipe.snrDb);
  }
  if (noiseProfile !== "none" && targetNoiseRms > 0) {
    const random = seededNoise(
      (recipe.seed ?? 0x4e_46_47_45) ^ Math.imul(windowIndex + 1, 0x9e_37_79_b1),
    );
    for (let index = 0; index < WINDOW_SIZE; index += 1) {
      const time = (absoluteStart + index) / SAMPLE_RATE;
      const white = random();
      noise[index] = noiseProfile === "white"
        ? white
        : 0.82 * white
          + 0.34 * Math.sin(2 * Math.PI * 60 * time + 0.4)
          + 0.16 * Math.sin(2 * Math.PI * 120 * time + 1.1);
    }
    scaleToRms(noise, targetNoiseRms);
  }

  const samples = new Float32Array(WINDOW_SIZE);
  for (let index = 0; index < WINDOW_SIZE; index += 1) {
    samples[index] = voice[index]! + noise[index]!;
  }
  return samples;
}

function directPitchFrame(samples: Float32Array, timeSeconds: number): YinPitchFrame {
  const startSample = Math.max(0, Math.round(timeSeconds * SAMPLE_RATE - samples.length / 2));
  const endSample = startSample + samples.length;
  return new NoteInputEngine().process({
    samples,
    sampleRate: SAMPLE_RATE,
    capturedAt: (startSample + endSample) / (2 * SAMPLE_RATE),
    startSample,
    endSample,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    processCount: endSample,
    processedSampleCount: endSample,
    discontinuity: startSample === 0,
  }).observation;
}

function runPipeline(
  recipes: readonly WindowRecipe[],
  initialState = createResonanceController(),
): PipelineRun {
  let state = initialState;
  const steps: PipelineStep[] = [];
  recipes.forEach((recipe, index) => {
    const samples = makeWindow(recipe, index);
    const capturedAt = (index + 0.5) * WINDOW_SECONDS;
    const frame = directPitchFrame(samples, capturedAt);
    state = updateResonanceControllerFromFrame(
      state,
      frame,
      capturedAt,
    ).state;
    state = advanceResonanceController(state, {
      nowSeconds: (index + 1) * WINDOW_SECONDS,
      deltaSeconds: WINDOW_SECONDS,
    });
    steps.push({ frame, state });
  });
  return { steps, state };
}

function repeated(recipe: Readonly<WindowRecipe>, count: number): WindowRecipe[] {
  return Array.from({ length: count }, () => ({ ...recipe }));
}

function resonatorEnergy(
  state: Readonly<ResonanceControllerState>,
  targetMidi = TARGET_MIDI,
  bandwidthCents = 30,
): number {
  const voice = evaluateResonanceVoice(toResonanceVoiceInput(state));
  return evaluateResonatorActivation(voice, {
    id: "pcm-proof-resonator",
    position: { x: 0, y: 0 },
    targetMidi,
    bandwidthCents,
    gain: 1,
    influenceRadius: 1,
    mode: "attract",
  }).effectiveEnergy;
}

const PCM_MOVEMENT_LEVEL = {
  id: "pcm-to-room-proof",
  room: { width: 6, height: 4 },
  obstacles: [],
  ball: {
    position: { x: 1.5, y: 2 },
    radius: .28,
    linearDamping: .8,
  },
  goal: { position: { x: 3.1, y: 2 }, radius: .72 },
  microphone: {
    position: { x: .5, y: 2 },
    gain: 12,
    falloffRadius: 5,
    direction: { x: 1, y: 0 },
    directivity: 1,
  },
  resonators: [{
    id: "c3-goal-attractor",
    position: { x: 3.1, y: 2 },
    targetMidi: TARGET_MIDI,
    bandwidthCents: 30,
    gain: 8,
    influenceRadius: 4,
    mode: "attract",
  }],
} as const satisfies ResonanceLevelDefinition;

function driveGameFromPipeline(run: Readonly<PipelineRun>): ResonanceGameState {
  let game = createResonanceGame(PCM_MOVEMENT_LEVEL);
  for (const step of run.steps) {
    game = advanceResonanceGame(
      game,
      toResonanceVoiceInput(step.state),
      WINDOW_SECONDS,
    ).state;
  }
  return game;
}

function driveTutorialFromPipeline(
  run: Readonly<PipelineRun>,
  lessonId: ResonanceTutorialLessonId = "pitch-discover",
): ResonanceTutorialSessionState {
  let session = createResonanceTutorialSession(lessonId, {
    baselineMidi: TARGET_MIDI,
  });
  for (const step of run.steps) {
    session = advanceResonanceTutorialSession(
      session,
      toResonanceTutorialVoiceEvidence(step.state),
      WINDOW_SECONDS,
    ).state;
  }
  return session;
}

describe("Resonance PCM-to-controller integration (not browser proof)", () => {
  it.each([24, 18, 12])(
    "passes pitch-discovery from sustained C3 PCM at %i dB SNR while equal-RMS noise stays inert",
    (snrDb) => {
      const tone = runPipeline(repeated({
        midi: TARGET_MIDI,
        voiceRmsDbfs: -24,
        snrDb,
        noiseProfile: "room",
        seed: 0x54_55_54_52,
      }, 30));
      const noise = runPipeline(repeated({
        midi: null,
        noiseRmsDbfs: -24,
        noiseProfile: "white",
        seed: 0x4e_4f_49_53,
      }, 30));
      const toneTutorial = driveTutorialFromPipeline(tone);
      const noiseTutorial = driveTutorialFromPipeline(noise);

      expect(toneTutorial.objective.status).toBe("passed");
      expect(toneTutorial.objective.bestHoldSeconds).toBeGreaterThanOrEqual(.3);
      expect(noiseTutorial.objective.status).toBe("playing");
      expect(noiseTutorial.objective.progress).toBe(0);
      expect(noiseTutorial.game.ball.position).toEqual(noiseTutorial.game.level.ball.position);
    },
  );

  it("keeps all four tutorial mechanics functional through noisy PCM and rejects the wrong evidence", () => {
    const stableNoisyTone = runPipeline(repeated({
      midi: TARGET_MIDI,
      voiceRmsDbfs: -24,
      snrDb: 18,
      noiseProfile: "room",
      seed: 0x46_49_45_4c,
    }, 36));
    const wrongPitch = runPipeline(repeated({
      midi: TARGET_MIDI + 1,
      voiceRmsDbfs: -24,
      snrDb: 18,
      noiseProfile: "room",
      seed: 0x57_52_4f_4e,
    }, 36));
    const brokenHold = runPipeline([
      ...repeated({ midi: TARGET_MIDI, voiceRmsDbfs: -24, snrDb: 18, noiseProfile: "room" }, 8),
      ...repeated({ midi: null, noiseRmsDbfs: -42, noiseProfile: "white" }, 5),
      ...repeated({ midi: TARGET_MIDI, voiceRmsDbfs: -24, snrDb: 18, noiseProfile: "room" }, 8),
    ]);
    const jitter = runPipeline(Array.from({ length: 36 }, (_, index) => ({
      midi: TARGET_MIDI + (index % 2 === 0 ? -.3 : .3),
      voiceRmsDbfs: -24,
      snrDb: 18,
      noiseProfile: "room" as const,
      seed: 0x4a_49_54_52,
    })));

    expect(driveTutorialFromPipeline(stableNoisyTone, "force-discover").objective.status).toBe("passed");
    expect(driveTutorialFromPipeline(stableNoisyTone, "pitch-discover").objective.status).toBe("passed");
    expect(driveTutorialFromPipeline(wrongPitch, "pitch-discover").objective.status).toBe("playing");
    expect(driveTutorialFromPipeline(stableNoisyTone, "sustain-discover").objective.status).toBe("passed");
    expect(driveTutorialFromPipeline(brokenHold, "sustain-discover").objective.status).toBe("playing");
    expect(driveTutorialFromPipeline(stableNoisyTone, "stability-discover").objective.status).toBe("passed");
    expect(driveTutorialFromPipeline(jitter, "stability-discover").objective.status).toBe("playing");
  });

  it("makes force respond to a relative-energy gesture without changing the voiced note", () => {
    const sharedReference = repeated({
      midi: TARGET_MIDI,
      voiceRmsDbfs: -30,
      snrDb: 18,
      noiseProfile: "room" as const,
      seed: 0x45_4e_45_52,
    }, 10);
    const quieter = runPipeline([
      ...sharedReference,
      ...repeated({ midi: TARGET_MIDI, voiceRmsDbfs: -36, snrDb: 18, noiseProfile: "room" }, 18),
    ]);
    const stronger = runPipeline([
      ...sharedReference,
      ...repeated({ midi: TARGET_MIDI, voiceRmsDbfs: -24, snrDb: 18, noiseProfile: "room" }, 18),
    ]);
    const quietTutorial = driveTutorialFromPipeline(quieter, "force-control");
    const strongTutorial = driveTutorialFromPipeline(stronger, "force-control");

    expect(strongTutorial.game.ball.position.x).toBeGreaterThan(quietTutorial.game.ball.position.x);
    expect(strongTutorial.game.voice.normalizedLevel).toBeGreaterThan(quietTutorial.game.voice.normalizedLevel);
  });

  it("moves and captures a room ball end-to-end from noisy C3 PCM, while equal-RMS noise cannot", () => {
    const tone = runPipeline(repeated({
      midi: TARGET_MIDI,
      voiceRmsDbfs: -24,
      snrDb: 18,
      noiseProfile: "room",
      seed: 0x43_33_52_4d,
    }, 42));
    const noise = runPipeline(repeated({
      midi: null,
      noiseRmsDbfs: -24,
      noiseProfile: "white",
      seed: 0x4e_4f_49_53,
    }, 42));
    const toneGame = driveGameFromPipeline(tone);
    const noiseGame = driveGameFromPipeline(noise);

    expect(toneGame.status).toBe("won");
    expect(toneGame.ball.position.x).toBeGreaterThan(PCM_MOVEMENT_LEVEL.ball.position.x + .8);
    expect(noiseGame.status).toBe("playing");
    expect(noiseGame.ball.position.x).toBeCloseTo(PCM_MOVEMENT_LEVEL.ball.position.x, 8);
    expect(noiseGame.fixedStepCount).toBeGreaterThan(0);
  });

  it.each([24, 18, 12])(
    "couples and drives the C3 resonator through deterministic room noise at %i dB SNR",
    (snrDb) => {
      const run = runPipeline(repeated({
        midi: TARGET_MIDI,
        voiceRmsDbfs: -24,
        snrDb,
        noiseProfile: "room",
        seed: 0x51_47_4e_52,
      }, 28));

      expect(run.state.referenceLocked).toBe(true);
      expect(run.state.reliableFrameCount).toBeGreaterThanOrEqual(20);
      expect(run.state.midiFloat).not.toBeNull();
      expect(Math.abs((run.state.midiFloat! - TARGET_MIDI) * 100)).toBeLessThan(10);
      expect(run.state.periodicity).toBeGreaterThan(0.65);
      expect(run.state.stability).toBeGreaterThan(0.8);
      expect(run.state.drive).toBeGreaterThan(0.4);
      expect(resonatorEnergy(run.state)).toBeGreaterThan(0.35);
    },
  );

  it("normalizes identical dynamic gestures across an 18 dB microphone-gain difference", () => {
    const gesture = [
      ...repeated({ voiceRmsDbfs: -36 }, 12),
      ...repeated({ voiceRmsDbfs: -30 }, 8),
      ...repeated({ voiceRmsDbfs: -42 }, 6),
    ];
    const hotterGesture = gesture.map((recipe) => ({
      ...recipe,
      voiceRmsDbfs: recipe.voiceRmsDbfs! + 18,
    }));
    const quiet = runPipeline(gesture);
    const hot = runPipeline(hotterGesture);

    expect(quiet.state.referenceDbfs).toBeCloseTo(-36, 5);
    expect(hot.state.referenceDbfs).toBeCloseTo(-18, 5);
    expect(quiet.state.relativeDb).toBeCloseTo(hot.state.relativeDb!, 5);
    expect(quiet.state.targetNormalizedLevel).toBeCloseTo(hot.state.targetNormalizedLevel, 5);
    expect(quiet.state.drive).toBeCloseTo(hot.state.drive, 5);
  });

  it.each([0x12_34_56_78, 0x0b_ad_f0_0d, 0x5e_ed_c3_01])(
    "keeps equal-RMS white noise from initializing or driving the field (seed %i)",
    (seed) => {
      const run = runPipeline(repeated({
        midi: null,
        noiseProfile: "white",
        noiseRmsDbfs: -24,
        seed,
      }, 36));

      expect(run.steps.some((step) => step.frame.voiced)).toBe(false);
      expect(run.state.referenceDbfs).toBeNull();
      expect(run.state.reliableFrameCount).toBe(0);
      expect(run.state.drive).toBe(0);
      expect(resonatorEnergy(run.state)).toBe(0);
    },
  );

  it("does not energize the C3 resonator from white + 60/120 Hz room noise alone", () => {
    const run = runPipeline(repeated({
      midi: null,
      noiseProfile: "room",
      noiseRmsDbfs: -24,
      seed: 0x60_12_00_60,
    }, 36));

    expect(resonatorEnergy(run.state)).toBeLessThan(0.001);
  });

  it("does not reward a C3 tone buried below deterministic room noise", () => {
    const run = runPipeline(repeated({
      midi: TARGET_MIDI,
      voiceRmsDbfs: -30,
      snrDb: -6,
      noiseProfile: "room",
      seed: 0x0b_ad_51_4e,
    }, 36));

    expect(resonatorEnergy(run.state)).toBeLessThan(0.05);
  });

  it("reduces coherent force when actual detected pitch jitters around the target", () => {
    const stable = runPipeline([
      ...repeated({ midi: TARGET_MIDI, voiceRmsDbfs: -24 }, 12),
      ...repeated({ midi: TARGET_MIDI, voiceRmsDbfs: -24 }, 12),
    ]);
    const jitter = runPipeline([
      ...repeated({ midi: TARGET_MIDI, voiceRmsDbfs: -24 }, 12),
      ...Array.from({ length: 12 }, (_, index) => ({
        midi: TARGET_MIDI + (index % 2 === 0 ? -0.28 : 0.28),
        voiceRmsDbfs: -24,
      })),
    ]);

    expect(stable.state.stability).toBeGreaterThan(jitter.state.stability);
    expect(stable.state.drive).toBeGreaterThan(jitter.state.drive);
    expect(resonatorEnergy(stable.state)).toBeGreaterThan(resonatorEnergy(jitter.state));
  });

  it("requires tuned frequency even when an off-target note is equally coherent", () => {
    const centered = runPipeline(repeated({ midi: TARGET_MIDI }, 24));
    const wholeStepHigh = runPipeline(repeated({ midi: TARGET_MIDI + 2 }, 24));

    expect(centered.state.drive).toBeGreaterThan(0.4);
    expect(wholeStepHigh.state.drive).toBeGreaterThan(0.4);
    expect(resonatorEnergy(centered.state)).toBeGreaterThan(0.35);
    expect(resonatorEnergy(wholeStepHigh.state)).toBeLessThan(0.001);
  });

  it("documents that a target-frequency speaker-like sine can also drive the monophonic detector", () => {
    const speakerLike = runPipeline(repeated({
      midi: TARGET_MIDI,
      voiceRmsDbfs: -24,
      pureSine: true,
    }, 24));

    expect(speakerLike.state.referenceLocked).toBe(true);
    expect(speakerLike.state.drive).toBeGreaterThan(0.4);
    expect(resonatorEnergy(speakerLike.state)).toBeGreaterThan(0.35);
  });
});
