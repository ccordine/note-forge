import {
  normalizeRangeProfile,
  usableRangeBounds,
} from "@/features/range-loop/profile";
import {
  setToneMapProductionEligibility,
  type ToneMapCourseState,
} from "./tone-map-model";
import { isToneMapProductionMidiSupported } from "./tone-map-production-range";

/**
 * Apply detector limits and optional demonstrated vocal bounds without changing
 * keyboard evidence. Existing in-detector user eligibility choices win; hard
 * detector exclusions do not pretend that an impossible answer can be heard.
 */
export function applyToneMapProductionProfile(
  course: ToneMapCourseState,
  profileCandidate: unknown,
): ToneMapCourseState {
  const bounds = usableRangeBounds(normalizeRangeProfile(profileCandidate));
  let next = course;
  for (const midi of course.order) {
    if (!isToneMapProductionMidiSupported(midi)) {
      next = setToneMapProductionEligibility(next, midi, "unreachable");
      continue;
    }
    if (course.tones[midi]!.productionEligibility !== "unassessed") continue;
    if (bounds.lowMidi === null || bounds.highMidi === null) continue;
    const reachable = midi >= bounds.lowMidi && midi <= bounds.highMidi;
    next = setToneMapProductionEligibility(
      next,
      midi,
      reachable ? "reachable" : "unreachable",
    );
  }
  return next;
}
