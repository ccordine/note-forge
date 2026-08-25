import { afterEach, describe, expect, it, vi } from "vitest";
import { frequencyToMidi, splitMidiPitch } from "@noteforge/music-core";
import {
  YIN_DETECTOR_DEFAULTS,
  YIN_FREQUENCY_BOUNDARY_TOLERANCE_CENTS,
} from "@noteforge/pitch-engine";

interface ManualRequest {
  result: unknown;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface ManualTransaction {
  error: DOMException | null;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  abort: () => void;
  objectStore: () => unknown;
  requests: ManualRequest[];
  written: unknown[];
  deleted: unknown[];
}

function request(result?: unknown): ManualRequest {
  return { result, error: null, onsuccess: null, onerror: null };
}

function indexedDBHarness(
  cursorValues: unknown[] = [],
  storedAttemptCount = Math.max(1, cursorValues.length),
  storedSetting?: unknown,
) {
  const transactions: ManualTransaction[] = [];
  const database = {
    objectStoreNames: { contains: () => true },
    onversionchange: null as (() => void) | null,
    onclose: null as (() => void) | null,
    close: vi.fn(),
    createObjectStore: vi.fn(),
    transaction: vi.fn(() => {
      const requests: ManualRequest[] = [];
      const written: unknown[] = [];
      const deleted: unknown[] = [];
      const transaction: ManualTransaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        abort: vi.fn(),
        requests,
        written,
        deleted,
        objectStore: () => ({
          put: (value: unknown) => {
            written.push(value);
            const created = request();
            requests.push(created);
            return created;
          },
          get: () => {
            const created = request(storedSetting);
            requests.push(created);
            queueMicrotask(() => {
              created.onsuccess?.();
              queueMicrotask(() => transaction.oncomplete?.());
            });
            return created;
          },
          count: () => {
            const created = request(storedAttemptCount);
            requests.push(created);
            queueMicrotask(() => created.onsuccess?.());
            return created;
          },
          index: () => ({
            openCursor: (_range: unknown, direction: "next" | "prev") => {
              const created = request();
              requests.push(created);
              let index = 0;
              const orderedValues = direction === "prev" ? cursorValues : [...cursorValues].reverse();
              const emit = () => {
                let continued = false;
                created.result = index < orderedValues.length
                  ? {
                      value: orderedValues[index],
                      delete: () => {
                        deleted.push((orderedValues[index] as { id?: unknown } | undefined)?.id ?? orderedValues[index]);
                        return request();
                      },
                      continue: () => {
                        continued = true;
                        index += 1;
                        queueMicrotask(emit);
                      },
                    }
                  : null;
                created.onsuccess?.();
                queueMicrotask(() => {
                  if (!continued) transaction.oncomplete?.();
                });
              };
              queueMicrotask(emit);
              return created;
            },
          }),
        }),
      };
      transactions.push(transaction);
      return transaction;
    }),
  };
  const openRequest = {
    result: database,
    error: null as DOMException | null,
    transaction: null,
    onerror: null as (() => void) | null,
    onblocked: null as (() => void) | null,
    onupgradeneeded: null as (() => void) | null,
    onsuccess: null as (() => void) | null,
  };
  const factory = {
    open: vi.fn(() => {
      queueMicrotask(() => openRequest.onsuccess?.());
      return openRequest;
    }),
  };
  vi.stubGlobal("indexedDB", factory as unknown as IDBFactory);
  return { database, factory, openRequest, transactions };
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

const attempt = {
  id: "attempt-1",
  exerciseType: "pitch.match",
  target: { midi: 48 },
  metrics: { accuracy: 0.9 },
  pitchFrames: [{
    timeSeconds: 1,
    frequencyHz: 130.81,
    midiFloat: 48,
    nearestMidi: 48,
    centsFromNearest: 0,
    rms: 0.08,
    confidence: 0.99,
    voiced: true,
  }],
  startedAt: "2026-08-24T00:00:00.000Z",
  completedAt: "2026-08-24T00:00:04.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("IndexedDB storage authority", () => {
  it("does not resolve a write before its transaction commits", async () => {
    const harness = indexedDBHarness();
    const { saveAttempt } = await import("../apps/web/src/storage/database");
    let state = "pending";
    const saved = saveAttempt(attempt).then(() => { state = "resolved"; });
    await settleMicrotasks();

    expect(harness.transactions).toHaveLength(1);
    expect(state).toBe("pending");
    harness.transactions[0]!.oncomplete?.();
    await saved;
    expect(state).toBe("resolved");
  });

  it("rejects a write that aborts after its request was accepted", async () => {
    const harness = indexedDBHarness();
    const { saveAttempt } = await import("../apps/web/src/storage/database");
    const saved = saveAttempt(attempt);
    await settleMicrotasks();

    const transaction = harness.transactions[0]!;
    transaction.error = new DOMException("Quota exhausted", "QuotaExceededError");
    transaction.onabort?.();
    await expect(saved).rejects.toMatchObject({ name: "QuotaExceededError" });
  });

  it("stores only the bounded derived pitch contour fields", async () => {
    const harness = indexedDBHarness();
    const { saveAttempt } = await import("../apps/web/src/storage/database");
    const frameWithRawData = {
      ...attempt.pitchFrames[0],
      samples: new Float32Array([0.1, -0.1]),
      pcm: new Float32Array([0.2, -0.2]),
      deviceId: "private-device",
    };
    const saved = saveAttempt({ ...attempt, pitchFrames: [frameWithRawData] });
    await settleMicrotasks();
    const transaction = harness.transactions[0]!;
    const written = transaction.written[0] as typeof attempt;
    expect(Object.keys(written.pitchFrames[0]!).sort()).toEqual([
      "centsFromNearest",
      "confidence",
      "frequencyHz",
      "midiFloat",
      "nearestMidi",
      "rms",
      "timeSeconds",
      "voiced",
    ]);
    expect(JSON.stringify(written)).not.toContain("private-device");
    transaction.oncomplete?.();
    await saved;
  });

  it("accepts canonical unvoiced frames and rejects contradictory pitch coordinates", async () => {
    const harness = indexedDBHarness();
    const { saveAttempt } = await import("../apps/web/src/storage/database");
    const unvoiced = {
      ...attempt.pitchFrames[0],
      voiced: false,
      frequencyHz: null,
      midiFloat: null,
      nearestMidi: null,
      centsFromNearest: null,
    };
    const saved = saveAttempt({ ...attempt, pitchFrames: [unvoiced] });
    await settleMicrotasks();
    const stored = harness.transactions[0]!.written[0] as typeof attempt;
    expect(stored.pitchFrames[0]).toMatchObject({
      voiced: false,
      frequencyHz: null,
      midiFloat: null,
      nearestMidi: null,
      centsFromNearest: null,
    });
    harness.transactions[0]!.oncomplete?.();
    await saved;

    await expect(saveAttempt({
      ...attempt,
      id: "bad-unvoiced-frame",
      pitchFrames: [{ ...attempt.pitchFrames[0], voiced: false }],
    })).rejects.toThrow("must not contain pitch coordinates");

    await expect(saveAttempt({
      ...attempt,
      id: "bad-voiced-frame",
      pitchFrames: [{ ...attempt.pitchFrames[0], frequencyHz: null }],
    })).rejects.toThrow("frequency");
  });

  it("persists only coherent coordinates from the canonical live detector range", async () => {
    const harness = indexedDBHarness();
    const { saveAttempt } = await import("../apps/web/src/storage/database");
    const frameAt = (frequencyHz: number) => {
      const midiFloat = frequencyToMidi(frequencyHz);
      const split = splitMidiPitch(midiFloat);
      return {
        ...attempt.pitchFrames[0],
        frequencyHz,
        midiFloat,
        nearestMidi: split.nearestMidi,
        centsFromNearest: split.centsFromNearest,
      };
    };
    await expect(saveAttempt({
      ...attempt,
      id: "fabricated-low-frequency",
      pitchFrames: [frameAt(20)],
    })).rejects.toThrow("frequency");
    await expect(saveAttempt({
      ...attempt,
      id: "fabricated-high-frequency",
      pitchFrames: [frameAt(20_000)],
    })).rejects.toThrow("frequency");
    await expect(saveAttempt({
      ...attempt,
      id: "fabricated-midi-coordinate",
      pitchFrames: [{ ...frameAt(440), midiFloat: 48 }],
    })).rejects.toThrow("contradictory pitch coordinates");
    expect(harness.factory.open).not.toHaveBeenCalled();

    const boundaryRatio = 2 ** (YIN_FREQUENCY_BOUNDARY_TOLERANCE_CENTS / 1_200);
    const boundaryFrames = [
      YIN_DETECTOR_DEFAULTS.minFrequency / boundaryRatio,
      YIN_DETECTOR_DEFAULTS.minFrequency,
      YIN_DETECTOR_DEFAULTS.maxFrequency,
      YIN_DETECTOR_DEFAULTS.maxFrequency * boundaryRatio,
    ].map(frameAt);
    const saved = saveAttempt({
      ...attempt,
      id: "canonical-boundary-evidence",
      pitchFrames: boundaryFrames,
    });
    await settleMicrotasks();
    expect(harness.transactions[0]!.written[0]).toMatchObject({
      pitchFrames: boundaryFrames,
    });
    harness.transactions[0]!.oncomplete?.();
    await saved;
  });

  it("rejects oversized or non-plain local records before opening IndexedDB", async () => {
    const harness = indexedDBHarness();
    const { saveAttempt, setSetting, setSettings } = await import("../apps/web/src/storage/database");
    await expect(saveAttempt({
      ...attempt,
      pitchFrames: new Array(2_049).fill(attempt.pitchFrames[0]),
    })).rejects.toThrow("at most 2048 frames");
    await expect(saveAttempt({
      ...attempt,
      completedAt: "2020-01-01T00:00:00.000Z",
    })).rejects.toThrow("cannot precede");
    await expect(setSetting("binary-audio", new Float32Array([0.1, -0.1])))
      .rejects.toThrow("not binary");
    await expect(setSettings([{ key: "duplicate", value: 1 }, { key: "duplicate", value: 2 }]))
      .rejects.toThrow("more than once");
    const unsafeMetrics = Object.create(null) as Record<string, number>;
    unsafeMetrics.__proto__ = 1;
    await expect(saveAttempt({ ...attempt, metrics: unsafeMetrics }))
      .rejects.toThrow("unsafe field name");
    expect(harness.factory.open).not.toHaveBeenCalled();
  });

  it("never deletes older user history when a new attempt is committed", async () => {
    const oldest = { ...attempt, id: "oldest", completedAt: "2026-08-24T01:00:00.000Z" };
    const middle = { ...attempt, id: "middle", completedAt: "2026-08-24T02:00:00.000Z" };
    const newest = { ...attempt, id: "newest", completedAt: "2026-08-24T03:00:00.000Z" };
    const harness = indexedDBHarness([newest, middle, oldest], 503);
    const { saveAttempt } = await import("../apps/web/src/storage/database");
    const saved = saveAttempt({ ...attempt, id: "new-write" });
    await settleMicrotasks();
    harness.transactions[0]!.oncomplete?.();
    await expect(saved).resolves.toBeUndefined();

    expect(harness.transactions).toHaveLength(1);
    expect(harness.transactions[0]!.written).toHaveLength(1);
    expect(harness.transactions[0]!.deleted).toEqual([]);
  });

  it("reads only the requested newest attempts through the descending index", async () => {
    const newest = { ...attempt, id: "newest", completedAt: "2026-08-24T03:00:00.000Z" };
    const middle = { ...attempt, id: "middle", completedAt: "2026-08-24T02:00:00.000Z" };
    const oldest = { ...attempt, id: "oldest", completedAt: "2026-08-24T01:00:00.000Z" };
    const harness = indexedDBHarness([newest, middle, oldest]);
    const { recentAttempts } = await import("../apps/web/src/storage/database");
    await expect(recentAttempts(2)).resolves.toEqual([newest, middle]);
    expect(harness.database.transaction).toHaveBeenCalledWith("attempts", "readonly");
  });

  it("rejects corrupt IndexedDB attempt records instead of trusting them", async () => {
    const corrupt = {
      ...attempt,
      pitchFrames: [{ ...attempt.pitchFrames[0], voiced: false }],
    };
    indexedDBHarness([corrupt]);
    const { recentAttempts } = await import("../apps/web/src/storage/database");
    await expect(recentAttempts(1)).rejects.toThrow("must not contain pitch coordinates");
  });

  it("returns immediately for non-positive history limits without opening the database", async () => {
    const harness = indexedDBHarness();
    const { recentAttempts } = await import("../apps/web/src/storage/database");
    await expect(recentAttempts(-5)).resolves.toEqual([]);
    expect(harness.factory.open).not.toHaveBeenCalled();
  });

  it("validates setting records read from IndexedDB", async () => {
    indexedDBHarness([], 1, { key: "profile", value: { lowMidi: 42, highMidi: 60 } });
    const { getSetting } = await import("../apps/web/src/storage/database");
    await expect(getSetting<{ lowMidi: number; highMidi: number }>("profile"))
      .resolves.toEqual({ lowMidi: 42, highMidi: 60 });

    vi.resetModules();
    indexedDBHarness([], 1, { key: "different-key", value: { lowMidi: 42 } });
    const mismatched = await import("../apps/web/src/storage/database");
    await expect(mismatched.getSetting("profile")).rejects.toThrow("does not match");

    vi.resetModules();
    indexedDBHarness([], 1, { key: "profile", value: new Float32Array([0.1]) });
    const binary = await import("../apps/web/src/storage/database");
    await expect(binary.getSetting("profile")).rejects.toThrow("not binary");
  });

  it("rejects a blocked database open instead of hanging forever", async () => {
    const harness = indexedDBHarness();
    harness.factory.open.mockImplementationOnce(() => harness.openRequest);
    const { getSetting } = await import("../apps/web/src/storage/database");
    const reading = getSetting("profile");
    await settleMicrotasks();
    harness.openRequest.onblocked?.();
    await expect(reading).rejects.toThrow("blocking the local database upgrade");
  });
});
