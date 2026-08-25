export type ToneMapChallengeMode = "single" | "simon";

export const TONE_MAP_SIMON_MINIMUM_LENGTH = 2;
export const TONE_MAP_SIMON_MAXIMUM_LENGTH = 8;
export const TONE_MAP_DEFAULT_SIMON_LENGTH = 3;

export function requireToneMapSimonLength(candidate: unknown): number {
  if (
    !Number.isSafeInteger(candidate)
    || (candidate as number) < TONE_MAP_SIMON_MINIMUM_LENGTH
    || (candidate as number) > TONE_MAP_SIMON_MAXIMUM_LENGTH
  ) {
    throw new RangeError(
      `Simon sequence length must be an integer from ${TONE_MAP_SIMON_MINIMUM_LENGTH} through ${TONE_MAP_SIMON_MAXIMUM_LENGTH}.`,
    );
  }
  return candidate as number;
}
