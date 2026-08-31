import type { YinPitchFrame } from "@noteforge/pitch-engine";
import type { PitchCandidateTelemetry } from "@/audio/pitch-state-tracker";
import {
  LIVE_DIAGNOSTIC_SIGNAL_BOUNDS,
  serializeLivePitchCoordinates,
} from "./live-signal-contract";

export interface RawPitchCandidateDiagnostic {
  frequencyHz: number;
  periodSamples: number;
  yinValue: number;
  confidence: number;
}

export interface PitchCandidateDiagnostic {
  frequencyHz: number | null;
  midiFloat: number | null;
  nearestMidi: number | null;
  centsFromNearest: number | null;
  confidence: number;
  yinValue: number | null;
  periodSamples: number | null;
  voiced: boolean;
  reason: YinPitchFrame["reason"];
  rawCandidate: RawPitchCandidateDiagnostic | null;
}

function roundedBounded(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
  digits: number,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function optionalRoundedBounded(
  value: number | null,
  label: string,
  minimum: number,
  maximum: number,
  digits: number,
): number | null {
  return value === null
    ? null
    : roundedBounded(value, label, minimum, maximum, digits);
}

function serializeRawCandidate(
  candidate: Readonly<NonNullable<YinPitchFrame["rawCandidate"]>> | null,
): RawPitchCandidateDiagnostic | null {
  if (candidate === null) return null;
  return {
    frequencyHz: roundedBounded(
      candidate.frequencyHz,
      "Raw candidate frequency",
      0.0001,
      LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.analysisSampleRateHz.maximum,
      LIVE_DIAGNOSTIC_SIGNAL_BOUNDS.frequencyDecimalPlaces,
    ),
    periodSamples: roundedBounded(
      candidate.periodSamples,
      "Raw candidate period",
      1,
      1_000_000,
      4,
    ),
    yinValue: roundedBounded(candidate.yinValue, "Raw candidate YIN value", 0, 10, 5),
    confidence: roundedBounded(candidate.confidence, "Raw candidate confidence", 0, 1, 4),
  };
}

/** Preserve the detector decision that preceded target-independent tracking. */
export function serializePitchCandidate(
  candidate: Readonly<PitchCandidateTelemetry> | undefined,
  sampleRate: number,
): PitchCandidateDiagnostic | null {
  if (candidate === undefined) return null;
  const coordinates = serializeLivePitchCoordinates({
    observationKind: candidate.voiced ? "voiced" : "unvoiced",
    sampleRate,
    frequencyHz: candidate.frequencyHz,
    midiFloat: candidate.midiFloat,
    nearestMidi: candidate.nearestMidi,
    centsFromNearest: candidate.centsFromNearest,
  });
  return {
    frequencyHz: coordinates.frequencyHz,
    midiFloat: coordinates.midiFloat,
    nearestMidi: coordinates.nearestMidi,
    centsFromNearest: coordinates.centsFromNearest,
    confidence: roundedBounded(candidate.confidence, "Candidate confidence", 0, 1, 4),
    yinValue: optionalRoundedBounded(candidate.yinValue, "Candidate YIN value", 0, 10, 5),
    periodSamples: optionalRoundedBounded(
      candidate.periodSamples,
      "Candidate period",
      1,
      1_000_000,
      4,
    ),
    voiced: candidate.voiced,
    reason: candidate.reason,
    rawCandidate: serializeRawCandidate(candidate.rawCandidate ?? null),
  };
}
