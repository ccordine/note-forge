import type {
  ProductionEligibility,
  ToneMapSkillEvidence,
  ToneMapToneState,
} from "./tone-map-model";
import { isToneMapProductionMidiSupported } from "./tone-map-production-range";

function containsLearningEvidence(evidence: ToneMapSkillEvidence): boolean {
  return evidence.attempts !== 0
    || evidence.lapses !== 0
    || evidence.guidedRecoveryRemaining !== 0
    || evidence.blindConfirmedAfterGuidance
    || evidence.stable
    || evidence.lastBlindConfirmedLevel !== null;
}

export function validateRestoredToneMapTone(
  midi: number,
  tone: ToneMapToneState,
  currentLevel: number,
  active: boolean,
): void {
  if (!isToneMapProductionMidiSupported(midi) && tone.productionEligibility !== "unreachable") {
    throw new RangeError(`Stored MIDI ${midi} must remain excluded from vocal production.`);
  }
  for (const evidence of [tone.identification, tone.production]) {
    if (evidence.lastBlindConfirmedLevel !== null && evidence.lastBlindConfirmedLevel > currentLevel) {
      throw new RangeError(`Stored MIDI ${midi} contains a future-level confirmation.`);
    }
    if (!active && containsLearningEvidence(evidence)) {
      throw new RangeError(`Stored MIDI ${midi} contains evidence before its course level.`);
    }
  }
}

export function requireSupportedProductionEligibility(
  midi: number,
  eligibility: ProductionEligibility,
): void {
  if (!isToneMapProductionMidiSupported(midi) && eligibility !== "unreachable") {
    throw new RangeError(`MIDI ${midi} is outside the supported vocal-production range.`);
  }
}
