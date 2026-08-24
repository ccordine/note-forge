import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearRangeLoopHandoff,
  consumeRangeLoopHandoff,
  queueRangeLoopHandoff,
} from "../apps/web/src/features/range-loop/handoff";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let records: Map<string, string>;

beforeEach(() => {
  records = new Map();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => records.get(key) ?? null,
        setItem: (key: string, value: string) => { records.set(key, value); },
        removeItem: (key: string) => { records.delete(key); },
      },
    },
  });
  clearRangeLoopHandoff();
});

afterEach(() => {
  clearRangeLoopHandoff();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("Range Simulator to Range Loop handoff", () => {
  it("survives two Strict Mode reads and clears only after hydration applies it", () => {
    expect(queueRangeLoopHandoff(46)).toBe(true);

    expect(consumeRangeLoopHandoff()).toBe(46);
    expect(consumeRangeLoopHandoff()).toBe(46);

    clearRangeLoopHandoff();
    expect(consumeRangeLoopHandoff()).toBeNull();
  });

  it("rejects notes outside the shared C2–B5 map", () => {
    expect(() => queueRangeLoopHandoff(35)).toThrow(RangeError);
    expect(() => queueRangeLoopHandoff(84)).toThrow(RangeError);
    expect(() => queueRangeLoopHandoff(48.5)).toThrow(RangeError);
  });
});
