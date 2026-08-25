import { describe, expect, it, vi } from "vitest";
import {
  ACCEPTANCE_TOLERANCE_CENTS_OPTIONS,
  DEFAULT_USER_PREFERENCES,
  USER_PREFERENCES_STORAGE_KEY,
  UserPreferencesAuthority,
  isAcceptanceToleranceCents,
  normalizeStoredUserPreferences,
  storedUserPreferences,
  type StoredUserPreferences,
  type UserPreferencesPersistencePort,
} from "../apps/web/src/state/user-preferences-settings";
import type {
  SettingsPersistenceResult,
  StoredSettings,
} from "../apps/web/src/storage/settings-persistence";

type StorageKey = typeof USER_PREFERENCES_STORAGE_KEY;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function loaded(
  value: unknown,
  readable = true,
): StoredSettings<StorageKey> {
  return {
    values: Object.freeze({ [USER_PREFERENCES_STORAGE_KEY]: value }),
    readableKeys: new Set(readable ? [USER_PREFERENCES_STORAGE_KEY] : []),
  };
}

class FakePreferencesPersistence implements UserPreferencesPersistencePort {
  readonly writes: Array<readonly Readonly<{ key: StorageKey; value: unknown }>[]> = [];
  readonly reports: Array<(result: SettingsPersistenceResult) => void> = [];
  readonly dispose = vi.fn();

  constructor(
    readonly result: Promise<StoredSettings<StorageKey> | null>,
    private readonly finishWrites = true,
  ) {}

  load(): Promise<StoredSettings<StorageKey> | null> {
    return this.result;
  }

  save(
    entries: readonly Readonly<{ key: StorageKey; value: unknown }>[],
    report: (result: SettingsPersistenceResult) => void,
  ): void {
    this.writes.push(entries);
    this.reports.push(report);
    report("saving");
    if (this.finishWrites) queueMicrotask(() => report("saved"));
  }
}

const saved = (
  overrides: Partial<StoredUserPreferences> = {},
): StoredUserPreferences => ({
  version: 1,
  labelsHidden: false,
  toleranceCents: 20,
  remotePitchDiagnosticsEnabled: false,
  ...overrides,
});

describe("global user-preferences settings", () => {
  it("defines and validates the complete acceptance-tolerance domain", () => {
    expect(ACCEPTANCE_TOLERANCE_CENTS_OPTIONS).toEqual([
      5, 10, 15, 20, 25, 30, 35, 40, 45, 50,
    ]);
    for (const tolerance of ACCEPTANCE_TOLERANCE_CENTS_OPTIONS) {
      expect(isAcceptanceToleranceCents(tolerance)).toBe(true);
    }
    for (const invalid of [0, 17, 55, Number.NaN, "20", null]) {
      expect(isAcceptanceToleranceCents(invalid)).toBe(false);
    }
  });

  it("restores only a complete supported versioned record", () => {
    expect(normalizeStoredUserPreferences(saved({
      labelsHidden: true,
      toleranceCents: 35,
      remotePitchDiagnosticsEnabled: true,
    }))).toEqual({
      labelsHidden: true,
      toleranceCents: 35,
      remotePitchDiagnosticsEnabled: true,
    });

    for (const invalid of [
      null,
      {},
      saved({ version: 2 as 1 }),
      saved({ labelsHidden: "true" as unknown as boolean }),
      saved({ toleranceCents: 17 }),
      saved({ remotePitchDiagnosticsEnabled: "true" as unknown as boolean }),
    ]) {
      expect(normalizeStoredUserPreferences(invalid)).toBe(DEFAULT_USER_PREFERENCES);
    }
  });

  it("hydrates all preferences and applies saved diagnostic consent", async () => {
    const persistence = new FakePreferencesPersistence(Promise.resolve(loaded(saved({
      labelsHidden: true,
      toleranceCents: 10,
      remotePitchDiagnosticsEnabled: true,
    }))));
    const diagnosticChoices: boolean[] = [];
    const authority = new UserPreferencesAuthority(
      persistence,
      (enabled) => diagnosticChoices.push(enabled),
    );

    authority.start();
    await vi.waitFor(() => expect(authority.getSnapshot().preferencesReady).toBe(true));

    expect(authority.getSnapshot()).toEqual({
      labelsHidden: true,
      toleranceCents: 10,
      remotePitchDiagnosticsEnabled: true,
      preferencesReady: true,
      preferencesPersistenceState: "saved",
    });
    expect(diagnosticChoices.at(-1)).toBe(true);
    expect(persistence.writes).toEqual([]);
  });

  it("merges an in-flight load without replacing newer local edits", async () => {
    const pendingLoad = deferred<StoredSettings<StorageKey> | null>();
    const persistence = new FakePreferencesPersistence(pendingLoad.promise);
    const diagnosticChoices: boolean[] = [];
    const authority = new UserPreferencesAuthority(
      persistence,
      (enabled) => diagnosticChoices.push(enabled),
    );
    authority.start();

    authority.setToleranceCents(35);
    // This explicit choice equals the safe loading default, but must still win
    // over an older stored opt-in when that read eventually completes.
    authority.setRemotePitchDiagnosticsEnabled(false);
    pendingLoad.resolve(loaded(saved({
      labelsHidden: true,
      toleranceCents: 10,
      remotePitchDiagnosticsEnabled: true,
    })));

    await vi.waitFor(() => expect(persistence.writes).toHaveLength(1));
    await vi.waitFor(() => {
      expect(authority.getSnapshot().preferencesPersistenceState).toBe("saved");
    });
    expect(authority.getSnapshot()).toMatchObject({
      labelsHidden: true,
      toleranceCents: 35,
      remotePitchDiagnosticsEnabled: false,
      preferencesReady: true,
    });
    expect(persistence.writes[0]).toEqual([{
      key: USER_PREFERENCES_STORAGE_KEY,
      value: saved({
        labelsHidden: true,
        toleranceCents: 35,
        remotePitchDiagnosticsEnabled: false,
      }),
    }]);
    expect(diagnosticChoices.at(-1)).toBe(false);
  });

  it("saves one complete atomic snapshot for every ready preference change", async () => {
    const persistence = new FakePreferencesPersistence(
      Promise.resolve(loaded(undefined)),
    );
    const authority = new UserPreferencesAuthority(persistence, () => undefined);
    authority.start();
    await vi.waitFor(() => expect(authority.getSnapshot().preferencesReady).toBe(true));

    authority.setLabelsHidden(true);
    await vi.waitFor(() => expect(persistence.writes).toHaveLength(1));
    expect(persistence.writes[0]).toEqual([{
      key: USER_PREFERENCES_STORAGE_KEY,
      value: storedUserPreferences({
        labelsHidden: true,
        toleranceCents: 20,
        remotePitchDiagnosticsEnabled: false,
      }),
    }]);
    await vi.waitFor(() => {
      expect(authority.getSnapshot().preferencesPersistenceState).toBe("saved");
    });
  });

  it("keeps runtime choices but refuses to overwrite an unreadable record", async () => {
    const persistence = new FakePreferencesPersistence(
      Promise.resolve(loaded(saved(), false)),
    );
    const authority = new UserPreferencesAuthority(persistence, () => undefined);
    authority.start();
    await vi.waitFor(() => expect(authority.getSnapshot().preferencesReady).toBe(true));

    authority.setToleranceCents(30);

    expect(authority.getSnapshot()).toMatchObject({
      toleranceCents: 30,
      preferencesPersistenceState: "error",
    });
    expect(persistence.writes).toEqual([]);
  });

  it("rejects invalid runtime tolerance and ignores an obsolete load after disposal", async () => {
    const pendingLoad = deferred<StoredSettings<StorageKey> | null>();
    const persistence = new FakePreferencesPersistence(pendingLoad.promise);
    const diagnosticChoices: boolean[] = [];
    const authority = new UserPreferencesAuthority(
      persistence,
      (enabled) => diagnosticChoices.push(enabled),
    );
    authority.start();
    expect(() => authority.setToleranceCents(17)).toThrow(RangeError);

    authority.dispose();
    pendingLoad.resolve(loaded(saved({ labelsHidden: true, toleranceCents: 50 })));
    await Promise.resolve();
    await Promise.resolve();

    expect(authority.getSnapshot().preferencesReady).toBe(false);
    expect(persistence.dispose).toHaveBeenCalledOnce();
    expect(diagnosticChoices.at(-1)).toBe(false);
  });
});
