import { describe, expect, it } from "vitest";
import type { PitchObservation } from "../apps/web/src/audio/note-input";
import {
  configureToneMapVoiceAnswer,
  createToneMapVoiceAnswerState,
  observeToneMapVoiceAnswer,
  toneMapVoiceAnswerMidi,
  toneMapVoiceAnswerSnapshot,
  TONE_MAP_VOICE_HOLD_SECONDS,
  TONE_MAP_VOICE_TOLERANCE_CENTS,
  type ToneMapVoiceAnswerState,
  type ToneMapVoiceTrialContext,
} from "../apps/web/src/features/ear-training/tone-map-voice-answer";

const SAMPLE_RATE = 48_000;
const WINDOW_SIZE = 4_096;
const HOP_SIZE = 960;

function observation(
  endSample: number,
  kind: PitchObservation["observationKind"] = "voiced",
  midiFloat = 48,
): PitchObservation {
  const voiced = kind === "voiced";
  const nearestMidi = voiced ? Math.round(midiFloat) : null;
  return Object.freeze({
    observationKind: kind,
    timeSeconds: (endSample - WINDOW_SIZE / 2) / SAMPLE_RATE,
    sampleRate: SAMPLE_RATE,
    startSample: endSample - WINDOW_SIZE,
    endSample,
    processedSampleCount: endSample,
    captureEpoch: 1,
    continuityEpoch: 0,
    graphGeneration: 0,
    workletProcessCount: Math.floor(endSample / 128),
    discontinuity: false,
    frequencyHz: voiced ? 440 * 2 ** ((midiFloat - 69) / 12) : null,
    midiFloat: voiced ? midiFloat : null,
    nearestMidi,
    centsFromNearest: voiced ? (midiFloat - nearestMidi!) * 100 : null,
    rms: voiced ? 0.02 : 0,
    confidence: voiced ? 0.96 : 0,
    voiced,
    detector: "yin",
    periodSamples: voiced ? 367 : null,
    yinValue: voiced ? 0.04 : null,
    reason: voiced
      ? "detected"
      : kind === "unvoiced"
        ? "below-rms-threshold"
        : "below-confidence-threshold",
    periodicity: voiced ? 0.96 : 0,
  });
}

function context(overrides: Partial<ToneMapVoiceTrialContext> = {}): ToneMapVoiceTrialContext {
  return {
    trialOrdinal: 1,
    active: true,
    answered: false,
    promptPlaying: false,
    ...overrides,
  };
}

function configured(
  trial = context(),
): ToneMapVoiceAnswerState {
  return configureToneMapVoiceAnswer(createToneMapVoiceAnswerState(), trial);
}

function feedVoiced(
  state: ToneMapVoiceAnswerState,
  firstEndSample: number,
  frameCount: number,
  midiFloat = 48,
): ToneMapVoiceAnswerState {
  let current = state;
  for (let index = 0; index < frameCount; index += 1) {
    current = observeToneMapVoiceAnswer(
      current,
      observation(firstEndSample + HOP_SIZE * index, "voiced", midiFloat),
    );
  }
  return current;
}

describe("Tone Map exact voice-answer evidence", () => {
  it("rejects a pre-task frame replayed after the task freshness boundary", () => {
    const oldSilence = observation(WINDOW_SIZE, "unvoiced");
    let state = observeToneMapVoiceAnswer(createToneMapVoiceAnswerState(), oldSilence);
    state = configureToneMapVoiceAnswer(state, context());

    state = observeToneMapVoiceAnswer(state, oldSilence);
    expect(state.status).toBe("awaiting-release");

    state = observeToneMapVoiceAnswer(
      state,
      observation(WINDOW_SIZE + HOP_SIZE, "unvoiced"),
    );
    expect(state.status).toBe("listening");
  });

  it("requires a post-task unvoiced boundary before a held pitch can arm", () => {
    let state = configured();
    state = feedVoiced(state, WINDOW_SIZE, 40);

    expect(state.status).toBe("awaiting-release");
    expect(toneMapVoiceAnswerMidi(state)).toBeNull();

    state = observeToneMapVoiceAnswer(
      state,
      observation(WINDOW_SIZE + HOP_SIZE * 40, "unvoiced"),
    );
    const listeningAuthority = toneMapVoiceAnswerSnapshot(state).statusAuthority;
    expect(listeningAuthority).toEqual({
      sampleRate: SAMPLE_RATE,
      startSample: HOP_SIZE * 40,
      endSample: WINDOW_SIZE + HOP_SIZE * 40,
      captureEpoch: 1,
      continuityEpoch: 0,
      graphGeneration: 0,
      processedSampleCount: WINDOW_SIZE + HOP_SIZE * 40,
      workletProcessCount: Math.floor((WINDOW_SIZE + HOP_SIZE * 40) / 128),
    });
    state = feedVoiced(state, WINDOW_SIZE + HOP_SIZE * 41, 14);
    expect(state.status).toBe("ready");
    expect(toneMapVoiceAnswerMidi(state)).toBe(48);
    expect(toneMapVoiceAnswerSnapshot(state).statusAuthority?.endSample).toBe(
      WINDOW_SIZE + HOP_SIZE * 54,
    );
  });

  it("retains transition provenance without replacing it on steady-status frames", () => {
    let state = configured();
    state = observeToneMapVoiceAnswer(state, observation(WINDOW_SIZE, "unvoiced"));
    const listening = toneMapVoiceAnswerSnapshot(state);
    expect(listening.statusAuthority?.endSample).toBe(WINDOW_SIZE);

    state = feedVoiced(state, WINDOW_SIZE + HOP_SIZE, 5);
    expect(state.lastSeenAuthority?.endSample).toBe(WINDOW_SIZE + HOP_SIZE * 5);
    expect(toneMapVoiceAnswerSnapshot(state).statusAuthority).toBe(listening.statusAuthority);

    state = configureToneMapVoiceAnswer(state, context({ promptPlaying: true }));
    expect(toneMapVoiceAnswerSnapshot(state)).toMatchObject({
      status: "awaiting-release",
      ready: false,
      statusAuthority: null,
    });
  });

  it("invalidates all evidence during prompt playback and requires release after Stop", () => {
    let state = configured();
    state = observeToneMapVoiceAnswer(state, observation(WINDOW_SIZE, "unvoiced"));
    state = feedVoiced(state, WINDOW_SIZE + HOP_SIZE, 14);
    expect(toneMapVoiceAnswerMidi(state)).toBe(48);

    state = configureToneMapVoiceAnswer(state, context({ promptPlaying: true }));
    state = feedVoiced(state, WINDOW_SIZE + HOP_SIZE * 15, 40);
    expect(state).toMatchObject({ status: "awaiting-release", promptPlaying: true, dwell: null });

    state = configureToneMapVoiceAnswer(state, context({ promptPlaying: false }));
    state = feedVoiced(state, WINDOW_SIZE + HOP_SIZE * 55, 40);
    expect(state.status).toBe("awaiting-release");
    expect(toneMapVoiceAnswerMidi(state)).toBeNull();

    state = observeToneMapVoiceAnswer(
      state,
      observation(WINDOW_SIZE + HOP_SIZE * 95, "unvoiced"),
    );
    state = feedVoiced(state, WINDOW_SIZE + HOP_SIZE * 96, 14);
    expect(toneMapVoiceAnswerMidi(state)).toBe(48);
  });

  it("resets exact dwell at a new task even if the same note never stopped", () => {
    let state = configured();
    state = observeToneMapVoiceAnswer(state, observation(WINDOW_SIZE, "unvoiced"));
    state = feedVoiced(state, WINDOW_SIZE + HOP_SIZE, 14);
    expect(toneMapVoiceAnswerMidi(state)).toBe(48);

    state = configureToneMapVoiceAnswer(state, context({ trialOrdinal: 2 }));
    state = feedVoiced(state, WINDOW_SIZE + HOP_SIZE * 15, 40);
    expect(state.status).toBe("awaiting-release");
    expect(toneMapVoiceAnswerMidi(state)).toBeNull();
  });

  it("uses the canonical 20-cent lane and exact 250ms sample-time dwell", () => {
    expect(TONE_MAP_VOICE_TOLERANCE_CENTS).toBe(20);
    expect(TONE_MAP_VOICE_HOLD_SECONDS).toBe(0.25);

    let inside = configured();
    inside = observeToneMapVoiceAnswer(inside, observation(WINDOW_SIZE, "unvoiced"));
    inside = feedVoiced(inside, WINDOW_SIZE + HOP_SIZE, 14, 48.2);
    expect(inside.dwell?.heldSeconds).toBeCloseTo(0.26, 12);
    expect(toneMapVoiceAnswerMidi(inside)).toBe(48);

    let outside = configured();
    outside = observeToneMapVoiceAnswer(outside, observation(WINDOW_SIZE, "unvoiced"));
    outside = feedVoiced(outside, WINDOW_SIZE + HOP_SIZE, 100, 48.21);
    expect(outside.dwell?.heldSeconds).toBe(0);
    expect(toneMapVoiceAnswerMidi(outside)).toBeNull();
  });

  it("changes candidate only from a real voiced step and rejects duplicate time credit", () => {
    let state = configured();
    state = observeToneMapVoiceAnswer(state, observation(WINDOW_SIZE, "unvoiced"));
    state = feedVoiced(state, WINDOW_SIZE + HOP_SIZE, 5, 48);
    expect(state.dwell?.targetMidi).toBe(48);

    const step = observation(WINDOW_SIZE + HOP_SIZE * 6, "voiced", 50);
    state = observeToneMapVoiceAnswer(state, step);
    expect(state.dwell).toMatchObject({ targetMidi: 50, heldSeconds: 0 });
    const duplicate = observeToneMapVoiceAnswer(state, step);
    expect(duplicate).toBe(state);

    state = feedVoiced(state, WINDOW_SIZE + HOP_SIZE * 7, 14, 50);
    expect(toneMapVoiceAnswerMidi(state)).toBe(50);
  });
});
