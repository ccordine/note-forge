import { describe, expect, it } from "vitest";
import {
  clamp,
  clampPercent,
  clampSignedUnit,
  clampUnit,
} from "../apps/web/src/lib/numeric";
import { auditNumericBoundaryAuthority } from "../scripts/audit-support/numeric-boundary-authority.mjs";

describe("repository numeric boundary authority", () => {
  it("saturates only beyond a caller-declared ordered interval", () => {
    expect(clamp(-4, -2, 8)).toBe(-2);
    expect(clamp(3, -2, 8)).toBe(3);
    expect(clamp(12, -2, 8)).toBe(8);
  });

  it("provides the three canonical presentation/control domains", () => {
    expect(clampUnit(-0.1)).toBe(0);
    expect(clampUnit(1.1)).toBe(1);
    expect(clampSignedUnit(-2)).toBe(-1);
    expect(clampSignedUnit(2)).toBe(1);
    expect(clampPercent(-1)).toBe(0);
    expect(clampPercent(101)).toBe(100);
  });

  it("rejects an inverted or NaN boundary instead of silently rewriting it", () => {
    expect(() => clamp(0, 2, 1)).toThrow(RangeError);
    expect(() => clamp(0, Number.NaN, 1)).toThrow(RangeError);
    expect(() => clamp(0, 0, Number.NaN)).toThrow(RangeError);
  });

  it("rejects CSS interpolation of an authoritative live marker coordinate", () => {
    const records = [{
      relativePath: "apps/web/src/example.css",
      source: ".nf-voice-needle { left: var(--pitch); transition: opacity .1s, left .1s; }",
    }];
    expect(auditNumericBoundaryAuthority(records)).toEqual([
      expect.stringContaining("transitions an authoritative live coordinate"),
    ]);
    records[0]!.source = ".nf-voice-needle { left: var(--pitch); transition: opacity .1s; }";
    expect(auditNumericBoundaryAuthority(records)).toEqual([]);
  });
});
