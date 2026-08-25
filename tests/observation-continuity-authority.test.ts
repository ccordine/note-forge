import { describe, expect, it } from "vitest";
import { auditObservationContinuityAuthority } from "../scripts/audit-support/observation-continuity-authority.mjs";

function audit(source: string): readonly string[] {
  return auditObservationContinuityAuthority([{
    relativePath: "apps/web/src/features/example/runtime.ts",
    source,
  }]);
}

describe("repository observation-continuity authority", () => {
  it("rejects direct and aliased feature-local epoch identity", () => {
    expect(audit("const same = previous.captureEpoch === current.captureEpoch;")).toEqual([
      expect.stringContaining("recreates captureEpoch stream identity"),
    ]);
    expect(audit(`
      const prior = previous.continuityEpoch;
      const { continuityEpoch: next } = current;
      const same = prior === next;
    `)).toEqual([
      expect.stringContaining("recreates continuityEpoch stream identity"),
    ]);
  });

  it("rejects local sample deltas and expected-hop reconstruction", () => {
    expect(audit("const delta = current.endSample - previous.endSample;")).toEqual([
      expect.stringContaining("recreates endSample sample delta"),
    ]);
    expect(audit("const expectedHop = Math.round(frame.sampleRate * 0.02);")).toEqual([
      expect.stringContaining("recreates the detector hop"),
    ]);
  });

  it("allows exact presentation identity and caller-specific time windows", () => {
    expect(audit(`
      const sameRenderedFrame = segment.endSample === authority.endSample;
      const historyFloor = frame.endSample - Math.round(
        frame.sampleRate * options.stabilityWindowSeconds,
      );
      const continuity = observationContinuity(previous, current);
    `)).toEqual([]);
  });
});
