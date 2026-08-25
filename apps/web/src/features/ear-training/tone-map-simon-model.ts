import {
  TONE_MAP_MAX_MIDI,
  TONE_MAP_MIN_MIDI,
  recordToneMapTaskResult,
  type ToneMapCourseState,
} from "./tone-map-model";

export type ToneMapSimonPhase = "ready-to-play" | "playing" | "answering" | "review";

export interface ToneMapSimonRound {
  readonly kind: "simon-sequence";
  readonly sequence: readonly number[];
  readonly answers: readonly number[];
  readonly phase: ToneMapSimonPhase;
  readonly resumeAfterPlayback: Extract<ToneMapSimonPhase, "ready-to-play" | "answering"> | null;
}

export type ToneMapSimonAction =
  | Readonly<{ type: "play" }>
  | Readonly<{ type: "stop-playback" }>
  | Readonly<{ type: "playback-completed" }>
  | Readonly<{ type: "answer"; midi: number }>;

export interface ToneMapSimonGrade {
  readonly course: ToneMapCourseState;
  readonly positions: readonly Readonly<{
    index: number;
    targetMidi: number;
    answerMidi: number;
    correct: boolean;
  }>[];
}

function requirePianoMidi(midi: number): void {
  if (!Number.isInteger(midi) || midi < TONE_MAP_MIN_MIDI || midi > TONE_MAP_MAX_MIDI) {
    throw new RangeError(`MIDI must be an integer from ${TONE_MAP_MIN_MIDI} through ${TONE_MAP_MAX_MIDI}.`);
  }
}

export function createToneMapSimonRound(sequence: readonly number[]): ToneMapSimonRound {
  if (sequence.length === 0) throw new RangeError("Simon sequence cannot be empty.");
  sequence.forEach(requirePianoMidi);
  return {
    kind: "simon-sequence",
    sequence: [...sequence],
    answers: [],
    phase: "ready-to-play",
    resumeAfterPlayback: null,
  };
}

export function reduceToneMapSimonRound(
  round: ToneMapSimonRound,
  action: ToneMapSimonAction,
): ToneMapSimonRound {
  switch (action.type) {
    case "play":
      if (round.phase !== "ready-to-play" && round.phase !== "answering") return round;
      return { ...round, phase: "playing", resumeAfterPlayback: round.phase };
    case "stop-playback":
      if (round.phase !== "playing" || round.resumeAfterPlayback === null) return round;
      return { ...round, phase: round.resumeAfterPlayback, resumeAfterPlayback: null };
    case "playback-completed":
      if (round.phase !== "playing") return round;
      return { ...round, phase: "answering", resumeAfterPlayback: null };
    case "answer": {
      requirePianoMidi(action.midi);
      if (round.phase !== "answering" || round.answers.length >= round.sequence.length) return round;
      const answers = [...round.answers, action.midi];
      return {
        ...round,
        answers,
        phase: answers.length === round.sequence.length ? "review" : "answering",
      };
    }
  }
}

export function appendToneMapSimonAnswer(round: ToneMapSimonRound, midi: number): ToneMapSimonRound {
  return reduceToneMapSimonRound(round, { type: "answer", midi });
}

export function gradeToneMapSimonRound(
  course: ToneMapCourseState,
  round: ToneMapSimonRound,
): ToneMapSimonGrade {
  if (round.phase !== "review" || round.answers.length !== round.sequence.length) {
    throw new RangeError("Simon answers remain incomplete.");
  }
  let gradedCourse = course;
  const positions = round.sequence.map((targetMidi, index) => {
    const answerMidi = round.answers[index]!;
    const correct = answerMidi === targetMidi;
    gradedCourse = recordToneMapTaskResult(gradedCourse, {
      midi: targetMidi,
      skill: "identification",
      challengeKind: "keyboard-identification",
      cueVisibility: "blind",
    }, correct ? "correct" : "incorrect");
    return { index, targetMidi, answerMidi, correct };
  });
  return { course: gradedCourse, positions };
}
