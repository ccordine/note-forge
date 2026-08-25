import type { ResonanceVector } from "./resonance-types";
export { clamp, clampUnit as clamp01 } from "@/lib/numeric";

export const RESONANCE_EPSILON = 1e-9;

export function vector(x: number, y: number): ResonanceVector {
  return { x, y };
}

export function add(
  first: Readonly<ResonanceVector>,
  second: Readonly<ResonanceVector>,
): ResonanceVector {
  return vector(first.x + second.x, first.y + second.y);
}

export function subtract(
  first: Readonly<ResonanceVector>,
  second: Readonly<ResonanceVector>,
): ResonanceVector {
  return vector(first.x - second.x, first.y - second.y);
}

export function scale(value: Readonly<ResonanceVector>, scalar: number): ResonanceVector {
  return vector(value.x * scalar, value.y * scalar);
}

export function dot(
  first: Readonly<ResonanceVector>,
  second: Readonly<ResonanceVector>,
): number {
  return first.x * second.x + first.y * second.y;
}

export function magnitudeSquared(value: Readonly<ResonanceVector>): number {
  return dot(value, value);
}

export function magnitude(value: Readonly<ResonanceVector>): number {
  return Math.sqrt(magnitudeSquared(value));
}

export function normalize(
  value: Readonly<ResonanceVector>,
  fallback: ResonanceVector = vector(1, 0),
): ResonanceVector {
  const length = magnitude(value);
  return length <= RESONANCE_EPSILON ? fallback : scale(value, 1 / length);
}

export function clampMagnitude(
  value: Readonly<ResonanceVector>,
  maximum: number,
): ResonanceVector {
  const length = magnitude(value);
  return length > maximum ? scale(value, maximum / length) : value;
}

export function distance(
  first: Readonly<ResonanceVector>,
  second: Readonly<ResonanceVector>,
): number {
  return magnitude(subtract(first, second));
}
