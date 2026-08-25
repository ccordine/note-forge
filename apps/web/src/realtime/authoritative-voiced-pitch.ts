import type { PitchObservation } from "@/audio/note-input";

/**
 * The feature-facing type guard for the pitch detector's already-admitted
 * voiced coordinate. Feature runtimes may apply musical tolerances and score
 * confidence, but must not invent a second confidence threshold that turns an
 * authoritative voiced observation into missing control input. The upstream
 * discriminant owns admission; detector reason and confidence are telemetry,
 * not another feature-facing veto. Finite coordinates are checked only so
 * downstream mathematics cannot receive a non-coordinate.
 */
export type AuthoritativeVoicedPitch = Readonly<PitchObservation> & Readonly<{
  observationKind: "voiced";
  voiced: true;
  frequencyHz: number;
  midiFloat: number;
  nearestMidi: number;
  centsFromNearest: number;
}>;

export function isAuthoritativeVoicedPitch(
  observation: Readonly<PitchObservation>,
): observation is AuthoritativeVoicedPitch {
  return observation.observationKind === "voiced"
    && observation.voiced
    && observation.frequencyHz !== null
    && Number.isFinite(observation.frequencyHz)
    && observation.frequencyHz > 0
    && observation.midiFloat !== null
    && Number.isFinite(observation.midiFloat)
    && observation.nearestMidi !== null
    && Number.isInteger(observation.nearestMidi)
    && observation.nearestMidi >= 0
    && observation.nearestMidi <= 127
    && observation.centsFromNearest !== null
    && Number.isFinite(observation.centsFromNearest);
}
