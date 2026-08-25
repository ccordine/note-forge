/**
 * Repository-wide numeric saturation primitive for the web application.
 *
 * Saturation is allowed only when the caller's domain explicitly has a hard
 * boundary (canvas edge, normalized control axis, percentage, physics limit,
 * or bounded presentation capacity). It must never be used to discard sensor
 * evidence, alias a pitch visualization, or end a user-owned session.
 */
export function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (Number.isNaN(minimum) || Number.isNaN(maximum) || minimum > maximum) {
    throw new RangeError("Numeric clamp requires an ordered non-NaN range.");
  }
  return Math.min(maximum, Math.max(minimum, value));
}

/** Saturate a value whose declared domain is the unit interval. */
export function clampUnit(value: number): number {
  return clamp(value, 0, 1);
}

/** Saturate a value whose declared domain is a signed control axis. */
export function clampSignedUnit(value: number): number {
  return clamp(value, -1, 1);
}

/** Saturate a value whose declared domain is a displayed percentage. */
export function clampPercent(value: number): number {
  return clamp(value, 0, 100);
}
