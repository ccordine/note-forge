import { frequencyToMidi, midiToFrequency } from "@noteforge/music-core";
import type {
  FrequencyTunedResonator,
  ResonanceVoiceEvaluation,
  ResonanceVoiceInput,
  ResonatorActivation,
} from "./resonance-types";
import { RESONANCE_EPSILON as EPSILON, clamp01 } from "./resonance-vector";

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const position = clamp01((value - edge0) / (edge1 - edge0));
  return position * position * (3 - 2 * position);
}

/** Comfortable normalized input is most efficient; overdrive reduces force. */
export function normalizeResonanceIntensity(normalizedLevel: number): number {
  const level = clamp01(finiteOr(normalizedLevel, 0));
  const onset = smoothstep(0.03, 0.55, level);
  const overdrive = smoothstep(0.72, 1, level);
  return clamp01(onset * (1 - 0.4 * overdrive));
}

export function evaluateResonanceVoice(
  input: Readonly<ResonanceVoiceInput>,
): ResonanceVoiceEvaluation {
  const normalizedLevel = clamp01(finiteOr(input.normalizedLevel, 0));
  const coherentDrive = clamp01(finiteOr(input.coherentDrive, 0));
  const confidence = clamp01(finiteOr(input.confidence, 0));
  const stability = clamp01(finiteOr(input.stability, 0));
  const suppliedMidi = input.midiFloat !== null && Number.isFinite(input.midiFloat)
    ? input.midiFloat
    : null;
  const suppliedFrequency = input.frequencyHz !== null
    && Number.isFinite(input.frequencyHz)
    && input.frequencyHz > 0
    ? input.frequencyHz
    : null;
  const midiFloat = suppliedMidi
    ?? (suppliedFrequency === null ? null : frequencyToMidi(suppliedFrequency));
  const frequencyHz = suppliedMidi !== null
    ? midiToFrequency(suppliedMidi)
    : suppliedFrequency;
  const active = input.voiced
    && midiFloat !== null
    && midiFloat >= 0
    && midiFloat <= 127
    && normalizedLevel > EPSILON
    && coherentDrive > EPSILON;
  const effectiveIntensity = active ? normalizeResonanceIntensity(normalizedLevel) : 0;
  const evidenceCoherence = active ? clamp01(coherentDrive / normalizedLevel) : 0;
  return {
    active,
    midiFloat: active ? midiFloat : null,
    frequencyHz: active ? frequencyHz : null,
    normalizedLevel,
    coherentDrive,
    effectiveIntensity,
    confidence,
    stability,
    evidenceCoherence,
    directEnergy: effectiveIntensity * evidenceCoherence,
  };
}

export function evaluateResonatorActivation(
  voice: Readonly<ResonanceVoiceEvaluation>,
  resonator: Readonly<FrequencyTunedResonator>,
): ResonatorActivation {
  const centsError = voice.midiFloat === null
    ? null
    : (voice.midiFloat - resonator.targetMidi) * 100;
  const pitchAccuracy = centsError === null
    ? 0
    : Math.exp(-0.5 * (centsError / resonator.bandwidthCents) ** 2);
  const coherence = pitchAccuracy * voice.evidenceCoherence;
  return {
    resonatorId: resonator.id,
    targetMidi: resonator.targetMidi,
    centsError,
    pitchAccuracy,
    coherence,
    effectiveEnergy: voice.effectiveIntensity * coherence,
  };
}
