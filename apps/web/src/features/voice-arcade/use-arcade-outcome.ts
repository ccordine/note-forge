import { useEffect, useRef } from "react";
import type { ArcadeOutcome } from "./types";

const NO_REPORTED_OUTCOME = Symbol("no-reported-arcade-outcome");

/**
 * One idempotent handoff from a game runtime's terminal state to the Arcade
 * progress owner. Games derive outcomes; they do not each invent another
 * report-once lifecycle.
 */
export function useArcadeOutcomeHandoff(
  outcomeKey: unknown | null,
  outcome: Readonly<ArcadeOutcome> | null,
  report: (outcome: ArcadeOutcome) => void,
): void {
  const reportedKeyRef = useRef<unknown>(NO_REPORTED_OUTCOME);

  useEffect(() => {
    if (outcomeKey === null || outcome === null) {
      reportedKeyRef.current = NO_REPORTED_OUTCOME;
      return;
    }
    if (Object.is(reportedKeyRef.current, outcomeKey)) return;
    reportedKeyRef.current = outcomeKey;
    report(outcome as ArcadeOutcome);
  }, [outcome, outcomeKey, report]);
}
