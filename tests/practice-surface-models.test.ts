import { describe, expect, it } from "vitest";
import {
  advancedAnswerIsCorrect,
  canSubmitAdvancedAnswer,
  createAdvancedEarState,
  reduceAdvancedEarState,
  type AdvancedEarTrial,
} from "../apps/web/src/features/ear-training/advanced-ear-model";
import {
  comparisonResult,
  createComparisonState,
  createIntervalTrial,
  createRecognitionState,
  intervalTrialNotes,
  reduceComparisonState,
  reduceRecognitionState,
} from "../apps/web/src/features/intervals/model";
import { intervalToneSchedule } from "../apps/web/src/features/intervals/playback";
import {
  appendDrawPoint,
  contourDirections,
  createContourState,
  createPhraseState,
  drawPath,
  drawPointsToMidi,
  generateMelodyPhrase,
  MELODY_SHAPES,
  nextShapeIndex,
  reduceContourState,
  reducePhraseState,
  toggleTranscribedNote,
} from "../apps/web/src/features/melody/model";
import {
  chordMidiFor,
  defaultModeForHarmonyView,
  harmonyView,
  nearestVoiceLines,
  PROGRESSION_PRESETS,
} from "../apps/web/src/features/harmony/model";

const COMPLETE_TRIAL: AdvancedEarTrial = Object.freeze({
  firstMidi: 69,
  targetMidi: 60,
  timbreA: "sine",
  timbreB: "sine",
});

describe("Practice activity state models", () => {
  it("admits only complete Ear answers and scores a submitted trial once", () => {
    let state = createAdvancedEarState(COMPLETE_TRIAL);
    expect(canSubmitAdvancedAnswer("complete", state.answer)).toBe(false);
    state = reduceAdvancedEarState(state, { type: "choose-pitch-class", pitchClass: 0 });
    expect(canSubmitAdvancedAnswer("complete", state.answer)).toBe(false);
    state = reduceAdvancedEarState(state, { type: "choose-octave", octave: 4 });
    expect(canSubmitAdvancedAnswer("complete", state.answer)).toBe(true);
    expect(advancedAnswerIsCorrect("complete", state.trial, state.answer)).toBe(true);

    state = reduceAdvancedEarState(state, { type: "submit", mode: "complete" });
    expect(state.stage).toBe("review");
    expect(state.score).toMatchObject({
      attempts: 1,
      pitchClass: 1,
      pitchClassAttempts: 1,
      octave: 1,
      octaveAttempts: 1,
    });
    expect(reduceAdvancedEarState(state, { type: "submit", mode: "complete" })).toBe(state);
  });

  it("uses explicit answering/review stages for interval trials", () => {
    const trial = createIntervalTrial("descending", () => 0);
    expect(trial).toEqual({ start: 48, semitones: 1, presentation: "descending" });
    expect(intervalTrialNotes(trial)).toEqual([48, 47]);

    let recognition = createRecognitionState(trial);
    recognition = reduceRecognitionState(recognition, { type: "choose", semitones: 1 });
    recognition = reduceRecognitionState(recognition, { type: "submit" });
    expect(recognition).toMatchObject({ stage: "review", right: 1, total: 1 });

    const wider = { ...trial, semitones: 7 };
    let comparison = createComparisonState(wider, trial);
    expect(comparisonResult(comparison.a, comparison.b)).toBe("a");
    comparison = reduceComparisonState(comparison, { type: "choose", answer: "a" });
    comparison = reduceComparisonState(comparison, { type: "submit" });
    expect(comparison.stage).toBe("review");
  });

  it("schedules interval comparisons on audio time without callback timers", () => {
    const ascending = { start: 60, semitones: 4, presentation: "ascending" } as const;
    const harmonic = { start: 60, semitones: 7, presentation: "harmonic" } as const;
    const ascendingSchedule = intervalToneSchedule(ascending, "sine", 10);
    const harmonicSchedule = intervalToneSchedule(harmonic, "sine", 20);
    expect(ascendingSchedule.map((tone) => tone.when)).toEqual([10, 10.94]);
    expect(harmonicSchedule.map((tone) => tone.when)).toEqual([20, 20]);
  });

  it("keeps Melody phrase, contour, drawing, and transcription transitions pure", () => {
    const phrase = generateMelodyPhrase(4, false, 60, () => 0);
    expect(phrase).toEqual([60, 60, 60, 60]);
    let phraseState = createPhraseState(phrase);
    phraseState = reducePhraseState(phraseState, { type: "toggle-reveal" });
    expect(phraseState.stage).toBe("revealed");

    let contour = createContourState(0);
    contour = reduceContourState(contour, { type: "choose", answer: 0 });
    contour = reduceContourState(contour, { type: "reveal" });
    expect(contour.stage).toBe("review");
    expect(nextShapeIndex(0, () => 0)).toBe(1);
    expect(contourDirections(MELODY_SHAPES[2]!)).toBe("• → ↗ ↗ ↘");

    const points = appendDrawPoint([], { x: 10, y: 110 });
    expect(appendDrawPoint(points, { x: 12, y: 90 })).toBe(points);
    const extended = appendDrawPoint(points, { x: 20, y: 0 });
    expect(drawPath(extended)).toBe("M 10 110 L 20 0");
    expect(drawPointsToMidi(extended)).toEqual([60, 72]);
    expect(toggleTranscribedNote([null, null], 1, 64)).toEqual([null, 64]);
    expect(toggleTranscribedNote([null, 64], 1, 64)).toEqual([null, null]);
  });

  it("maps every Harmony URL mode and builds bounded nearest voice lines", () => {
    expect(harmonyView("scale-degree-production")).toBe("scaleDegree");
    expect(harmonyView("chord-tone")).toBe("chordTone");
    expect(harmonyView("voice-leading")).toBe("voiceLeading");
    expect(harmonyView("harmony-follow")).toBe("harmonyFollow");
    expect(defaultModeForHarmonyView("scaleDegree")).toBe("scale-degree-recognition");

    const progression = PROGRESSION_PRESETS.pop;
    expect(chordMidiFor(0, progression.chords[0]!)).toEqual([60, 64, 67]);
    const voices = nearestVoiceLines(progression.chords, 0);
    expect(voices).toHaveLength(3);
    for (const voice of voices) {
      expect(voice).toHaveLength(progression.chords.length);
      expect(Math.min(...voice)).toBeGreaterThanOrEqual(44);
      expect(Math.max(...voice)).toBeLessThanOrEqual(76);
    }
  });
});
