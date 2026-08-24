export interface MelodyShape {
  readonly label: string;
  readonly offsets: readonly number[];
}

export interface DrawPoint {
  readonly x: number;
  readonly y: number;
}

export interface PhraseState {
  readonly stage: "hidden" | "revealed";
  readonly length: number;
  readonly chromatic: boolean;
  readonly phrase: readonly number[];
}

export type PhraseAction =
  | Readonly<{ type: "set-length"; length: number; phrase: readonly number[] }>
  | Readonly<{ type: "set-chromatic"; chromatic: boolean; phrase: readonly number[] }>
  | Readonly<{ type: "replace"; phrase: readonly number[] }>
  | Readonly<{ type: "toggle-reveal" }>;

export interface ContourState {
  readonly stage: "answering" | "review";
  readonly shapeIndex: number;
  readonly answer?: number;
}

export type ContourAction =
  | Readonly<{ type: "choose"; answer: number }>
  | Readonly<{ type: "reveal" }>
  | Readonly<{ type: "next"; shapeIndex: number }>;

export const MELODY_SHAPES: readonly MelodyShape[] = Object.freeze([
  Object.freeze({ label: "rising arch", offsets: Object.freeze([0, 2, 4, 7, 5, 2]) }),
  Object.freeze({ label: "descending steps", offsets: Object.freeze([7, 5, 4, 2, 0]) }),
  Object.freeze({ label: "same · up · up · drop", offsets: Object.freeze([0, 0, 2, 4, -3]) }),
  Object.freeze({ label: "valley", offsets: Object.freeze([5, 2, 0, 2, 5]) }),
]);

const DIATONIC_OFFSETS = Object.freeze([0, 2, 4, 5, 7, 9, 11, 12]);
const CHROMATIC_OFFSETS = Object.freeze(Array.from({ length: 13 }, (_, index) => index - 2));

function randomIndex(length: number, random: () => number): number {
  return Math.min(length - 1, Math.floor(random() * length));
}

export function generateMelodyPhrase(
  length: number,
  chromatic: boolean,
  rootMidi = 60,
  random: () => number = Math.random,
): readonly number[] {
  if (!Number.isInteger(length) || length < 1 || length > 32) {
    throw new RangeError("Melody length must be an integer from 1 through 32.");
  }
  const allowed = chromatic ? CHROMATIC_OFFSETS : DIATONIC_OFFSETS;
  const phrase = [rootMidi];
  for (let index = 1; index < length; index += 1) {
    const previous = phrase[index - 1] ?? rootMidi;
    const choices = allowed
      .map((offset) => rootMidi + offset)
      .filter((midi) => Math.abs(midi - previous) <= 7);
    phrase.push(choices[randomIndex(choices.length, random)] ?? rootMidi);
  }
  return phrase;
}

export function createPhraseState(phrase: readonly number[]): PhraseState {
  return { stage: "hidden", length: phrase.length, chromatic: false, phrase };
}

export function reducePhraseState(state: PhraseState, action: PhraseAction): PhraseState {
  if (action.type === "toggle-reveal") {
    const stage = state.stage === "hidden" ? "revealed" : "hidden";
    return { ...state, stage };
  }
  if (action.type === "set-length") {
    return { ...state, stage: "hidden", length: action.length, phrase: action.phrase };
  }
  if (action.type === "set-chromatic") {
    return { ...state, stage: "hidden", chromatic: action.chromatic, phrase: action.phrase };
  }
  return { ...state, stage: "hidden", phrase: action.phrase };
}

export function createContourState(shapeIndex = 0): ContourState {
  return { stage: "answering", shapeIndex };
}

export function reduceContourState(state: ContourState, action: ContourAction): ContourState {
  if (action.type === "next") return { stage: "answering", shapeIndex: action.shapeIndex };
  if (state.stage === "review") return state;
  if (action.type === "choose") return { ...state, answer: action.answer };
  if (state.answer === undefined) return state;
  return { ...state, stage: "review" };
}

export function nextShapeIndex(
  current: number,
  random: () => number = Math.random,
): number {
  const next = randomIndex(MELODY_SHAPES.length, random);
  return next === current ? (next + 1) % MELODY_SHAPES.length : next;
}

export function contourDirections(shape: MelodyShape): string {
  return shape.offsets.map((offset, index) => {
    if (index === 0) return "•";
    const previous = shape.offsets[index - 1] ?? offset;
    if (offset === previous) return "→";
    return offset > previous ? "↗" : "↘";
  }).join(" ");
}

export function contourSvgPoints(notes: readonly number[]): readonly DrawPoint[] {
  if (notes.length === 0) return [];
  const minimum = Math.min(...notes);
  const maximum = Math.max(...notes);
  const range = Math.max(1, maximum - minimum);
  const horizontalStep = 560 / Math.max(1, notes.length - 1);
  return notes.map((note, index) => ({
    x: 20 + index * horizontalStep,
    y: 150 - ((note - minimum) / range) * 105,
  }));
}

export function appendDrawPoint(
  points: readonly DrawPoint[],
  point: DrawPoint,
): readonly DrawPoint[] {
  const previous = points.at(-1);
  if (previous && point.x < previous.x + 3) return points;
  return [...points.slice(-199), point];
}

export function drawPointsToMidi(points: readonly DrawPoint[]): readonly number[] {
  return points.map((point) => 72 - (point.y / 220) * 24);
}

export function drawPath(points: readonly DrawPoint[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

export function largestMelodyLeap(phrase: readonly number[]): number {
  let largest = 0;
  for (let index = 1; index < phrase.length; index += 1) {
    largest = Math.max(largest, Math.abs((phrase[index] ?? 0) - (phrase[index - 1] ?? 0)));
  }
  return largest;
}

export function toggleTranscribedNote(
  transcription: readonly (number | null)[],
  column: number,
  midi: number,
): readonly (number | null)[] {
  return transcription.map((value, index) => {
    if (index !== column) return value;
    return value === midi ? null : midi;
  });
}

export function transcribedNotes(transcription: readonly (number | null)[]): readonly number[] {
  return transcription.filter((note): note is number => note !== null);
}
