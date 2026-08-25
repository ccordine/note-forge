import type {
  SettingsPersistenceResult,
  StoredSettings,
} from "@/storage/settings-persistence";

export const USER_PREFERENCES_STORAGE_KEY = "user.preferences";

export const ACCEPTANCE_TOLERANCE_CENTS_OPTIONS = Object.freeze([
  5, 10, 15, 20, 25, 30, 35, 40, 45, 50,
] as const);

export interface UserPreferenceValues {
  readonly labelsHidden: boolean;
  readonly toleranceCents: number;
  readonly remotePitchDiagnosticsEnabled: boolean;
}

export interface StoredUserPreferences extends UserPreferenceValues {
  readonly version: 1;
}

export const DEFAULT_USER_PREFERENCES: UserPreferenceValues = Object.freeze({
  labelsHidden: false,
  toleranceCents: 20,
  remotePitchDiagnosticsEnabled: false,
});

export interface UserPreferencesSnapshot extends UserPreferenceValues {
  readonly preferencesReady: boolean;
  readonly preferencesPersistenceState: SettingsPersistenceResult | "loading";
}

type UserPreferencesKey = typeof USER_PREFERENCES_STORAGE_KEY;

export interface UserPreferencesPersistencePort {
  load(): Promise<StoredSettings<UserPreferencesKey> | null>;
  save(
    entries: readonly Readonly<{ key: UserPreferencesKey; value: unknown }>[],
    report: (result: SettingsPersistenceResult) => void,
  ): void;
  dispose(): void;
}

interface PendingPreferenceEdits {
  labelsHidden: boolean;
  toleranceCents: boolean;
  remotePitchDiagnosticsEnabled: boolean;
}

const NO_PENDING_EDITS: PendingPreferenceEdits = Object.freeze({
  labelsHidden: false,
  toleranceCents: false,
  remotePitchDiagnosticsEnabled: false,
});

function frozenSnapshot(
  values: Readonly<UserPreferenceValues>,
  preferencesReady: boolean,
  preferencesPersistenceState: SettingsPersistenceResult | "loading",
): UserPreferencesSnapshot {
  return Object.freeze({
    ...values,
    preferencesReady,
    preferencesPersistenceState,
  });
}

function booleanPreference(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
  return value;
}

export function isAcceptanceToleranceCents(value: unknown): value is number {
  return typeof value === "number"
    && ACCEPTANCE_TOLERANCE_CENTS_OPTIONS.some((candidate) => candidate === value);
}

export function requireAcceptanceToleranceCents(value: unknown): number {
  if (!isAcceptanceToleranceCents(value)) {
    throw new RangeError("Acceptance tolerance must be 5-50 cents in 5-cent steps.");
  }
  return value;
}

export function normalizeStoredUserPreferences(candidate: unknown): UserPreferenceValues {
  if (candidate === undefined) return DEFAULT_USER_PREFERENCES;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return DEFAULT_USER_PREFERENCES;
  }
  const value = candidate as Partial<StoredUserPreferences>;
  if (
    value.version !== 1
    || typeof value.labelsHidden !== "boolean"
    || !isAcceptanceToleranceCents(value.toleranceCents)
    || typeof value.remotePitchDiagnosticsEnabled !== "boolean"
  ) return DEFAULT_USER_PREFERENCES;
  return Object.freeze({
    labelsHidden: value.labelsHidden,
    toleranceCents: value.toleranceCents,
    remotePitchDiagnosticsEnabled: value.remotePitchDiagnosticsEnabled,
  });
}

export function storedUserPreferences(
  values: Readonly<UserPreferenceValues>,
): StoredUserPreferences {
  return Object.freeze({
    version: 1,
    labelsHidden: booleanPreference(values.labelsHidden, "Hidden-label preference"),
    toleranceCents: requireAcceptanceToleranceCents(values.toleranceCents),
    remotePitchDiagnosticsEnabled: booleanPreference(
      values.remotePitchDiagnosticsEnabled,
      "Remote-diagnostics preference",
    ),
  });
}

function hasPendingEdits(edits: Readonly<PendingPreferenceEdits>): boolean {
  return edits.labelsHidden || edits.toleranceCents || edits.remotePitchDiagnosticsEnabled;
}

/**
 * One app-lifetime authority for global, user-owned preferences. It keeps
 * pre-hydration edits explicit so an IndexedDB result can never replace a
 * choice the user made while that result was in flight.
 */
export class UserPreferencesAuthority {
  private readonly listeners = new Set<() => void>();
  private snapshot = frozenSnapshot(DEFAULT_USER_PREFERENCES, false, "loading");
  private pendingEdits: PendingPreferenceEdits = NO_PENDING_EDITS;
  private storageWritable = false;
  private active = false;
  private lifecycleRevision = 0;

  constructor(
    private readonly persistence: UserPreferencesPersistencePort,
    private readonly applyRemoteDiagnosticsPreference: (enabled: boolean) => void,
  ) {}

  readonly getSnapshot = (): UserPreferencesSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: UserPreferencesSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private saveCurrent(): void {
    if (!this.active || !this.storageWritable) return;
    const value = storedUserPreferences(this.snapshot);
    this.persistence.save(
      [{ key: USER_PREFERENCES_STORAGE_KEY, value }],
      (preferencesPersistenceState) => {
        if (!this.active) return;
        this.publish(frozenSnapshot(
          this.snapshot,
          true,
          preferencesPersistenceState,
        ));
      },
    );
  }

  start(): void {
    this.active = true;
    const revision = ++this.lifecycleRevision;
    this.applyRemoteDiagnosticsPreference(this.snapshot.remotePitchDiagnosticsEnabled);
    void this.persistence.load().then((stored) => {
      if (!this.active || revision !== this.lifecycleRevision || !stored) return;
      const restored = normalizeStoredUserPreferences(
        stored.values[USER_PREFERENCES_STORAGE_KEY],
      );
      const pending = this.pendingEdits;
      const values: UserPreferenceValues = Object.freeze({
        labelsHidden: pending.labelsHidden
          ? this.snapshot.labelsHidden
          : restored.labelsHidden,
        toleranceCents: pending.toleranceCents
          ? this.snapshot.toleranceCents
          : restored.toleranceCents,
        remotePitchDiagnosticsEnabled: pending.remotePitchDiagnosticsEnabled
          ? this.snapshot.remotePitchDiagnosticsEnabled
          : restored.remotePitchDiagnosticsEnabled,
      });
      const needsSave = hasPendingEdits(pending);
      this.pendingEdits = NO_PENDING_EDITS;
      this.storageWritable = stored.readableKeys.has(USER_PREFERENCES_STORAGE_KEY);
      this.applyRemoteDiagnosticsPreference(values.remotePitchDiagnosticsEnabled);
      this.publish(frozenSnapshot(
        values,
        true,
        this.storageWritable ? needsSave ? "saving" : "saved" : "error",
      ));
      if (needsSave) this.saveCurrent();
    }).catch(() => {
      if (!this.active || revision !== this.lifecycleRevision) return;
      this.pendingEdits = NO_PENDING_EDITS;
      this.storageWritable = false;
      this.applyRemoteDiagnosticsPreference(this.snapshot.remotePitchDiagnosticsEnabled);
      this.publish(frozenSnapshot(this.snapshot, true, "error"));
    });
  }

  dispose(): void {
    this.active = false;
    this.lifecycleRevision += 1;
    this.persistence.dispose();
    this.applyRemoteDiagnosticsPreference(false);
  }

  private change(
    values: Readonly<UserPreferenceValues>,
    pendingEdits: PendingPreferenceEdits,
  ): void {
    const ready = this.snapshot.preferencesReady;
    this.pendingEdits = ready ? NO_PENDING_EDITS : Object.freeze(pendingEdits);
    this.applyRemoteDiagnosticsPreference(values.remotePitchDiagnosticsEnabled);
    this.publish(frozenSnapshot(
      values,
      ready,
      ready ? this.storageWritable ? "saving" : "error" : "loading",
    ));
    if (ready) this.saveCurrent();
  }

  readonly setLabelsHidden = (labelsHidden: boolean): void => {
    const value = booleanPreference(labelsHidden, "Hidden-label preference");
    if (this.snapshot.preferencesReady && value === this.snapshot.labelsHidden) return;
    this.change(
      {
        labelsHidden: value,
        toleranceCents: this.snapshot.toleranceCents,
        remotePitchDiagnosticsEnabled: this.snapshot.remotePitchDiagnosticsEnabled,
      },
      { ...this.pendingEdits, labelsHidden: true },
    );
  };

  readonly setToleranceCents = (toleranceCents: number): void => {
    const value = requireAcceptanceToleranceCents(toleranceCents);
    if (this.snapshot.preferencesReady && value === this.snapshot.toleranceCents) return;
    this.change(
      {
        labelsHidden: this.snapshot.labelsHidden,
        toleranceCents: value,
        remotePitchDiagnosticsEnabled: this.snapshot.remotePitchDiagnosticsEnabled,
      },
      { ...this.pendingEdits, toleranceCents: true },
    );
  };

  readonly setRemotePitchDiagnosticsEnabled = (enabled: boolean): void => {
    const value = booleanPreference(enabled, "Remote-diagnostics preference");
    if (
      this.snapshot.preferencesReady
      && value === this.snapshot.remotePitchDiagnosticsEnabled
    ) return;
    this.change(
      {
        labelsHidden: this.snapshot.labelsHidden,
        toleranceCents: this.snapshot.toleranceCents,
        remotePitchDiagnosticsEnabled: value,
      },
      { ...this.pendingEdits, remotePitchDiagnosticsEnabled: true },
    );
  };
}
