import { getSetting, setSettings } from "./database";

export type SettingsPersistenceResult = "saving" | "saved" | "error";

export interface StoredSettings<Key extends string> {
  readonly values: Readonly<Partial<Record<Key, unknown>>>;
  readonly readableKeys: ReadonlySet<Key>;
}

interface PendingWrite {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Settings are shared IndexedDB records, so their write order must outlive any
 * one mounted route. This coordinator is deliberately module-owned: a route
 * that remounts cannot read an older snapshot while its previous mount still
 * has writes queued.
 */
class SettingsWriteCoordinator {
  private readonly pendingValues = new Map<string, unknown>();
  private pendingWrites: PendingWrite[] = [];
  private idleWaiters: Array<() => void> = [];
  private draining = false;
  private writeRevision = 0;

  get revision(): number {
    return this.writeRevision;
  }

  enqueue(entries: readonly Readonly<{ key: string; value: unknown }>[]): Promise<void> {
    for (const entry of entries) this.pendingValues.set(entry.key, entry.value);
    this.writeRevision += 1;
    const operation = new Promise<void>((resolve, reject) => {
      this.pendingWrites.push({ resolve, reject });
    });
    void this.drain();
    return operation;
  }

  async awaitIdle(): Promise<void> {
    if (!this.draining && this.pendingValues.size === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.pendingValues.size > 0) {
      const entries = [...this.pendingValues].map(([key, value]) => ({ key, value }));
      const writes = this.pendingWrites;
      this.pendingValues.clear();
      this.pendingWrites = [];
      try {
        await setSettings(entries);
        writes.forEach(({ resolve }) => resolve());
      } catch (error) {
        writes.forEach(({ reject }) => reject(error));
      }
    }
    this.draining = false;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }
}

const SETTINGS_WRITES = new SettingsWriteCoordinator();

/**
 * One serial transaction authority for a mounted local workflow. Components
 * render persistence status but never grow mounted flags, write generations,
 * or promise chains of their own.
 */
export class SettingsPersistence<Key extends string> {
  private readonly keys: readonly Key[];
  private readableKeys = new Set<Key>();
  private latestWrite: Promise<void> = Promise.resolve();
  private latestRevision = 0;
  private loadRevision = 0;
  private disposed = false;

  constructor(keys: readonly Key[]) {
    if (new Set(keys).size !== keys.length) {
      throw new RangeError("Settings persistence keys must be unique.");
    }
    this.keys = Object.freeze([...keys]);
  }

  async load(): Promise<StoredSettings<Key> | null> {
    // React StrictMode deliberately runs an effect setup/cleanup/setup cycle.
    // A fresh load is the new mounted scope, so it reactivates this stable
    // service identity while invalidating results from the previous scope.
    this.disposed = false;
    const revision = ++this.loadRevision;
    let results: PromiseSettledResult<unknown>[];
    while (true) {
      await SETTINGS_WRITES.awaitIdle();
      const writeRevision = SETTINGS_WRITES.revision;
      results = await Promise.allSettled(this.keys.map((key) => getSetting<unknown>(key)));
      if (this.disposed || revision !== this.loadRevision) return null;
      // A write queued while IndexedDB was being read can make this snapshot
      // stale. Wait for it and reread rather than hydrating a route from data
      // that an earlier mount is still replacing.
      if (writeRevision === SETTINGS_WRITES.revision) break;
    }
    const values: Partial<Record<Key, unknown>> = {};
    const readableKeys = new Set<Key>();
    results.forEach((result, index) => {
      const key = this.keys[index]!;
      if (result.status !== "fulfilled") return;
      readableKeys.add(key);
      values[key] = result.value;
    });
    this.readableKeys = readableKeys;
    return { values: Object.freeze(values), readableKeys };
  }

  save(
    entries: readonly Readonly<{ key: Key; value: unknown }>[],
    report: (result: SettingsPersistenceResult) => void,
  ): void {
    if (this.disposed) return;
    const writableEntries = entries.filter((entry) => this.readableKeys.has(entry.key));
    if (writableEntries.length === 0) {
      report("error");
      return;
    }
    const revision = ++this.latestRevision;
    report("saving");
    this.latestWrite = SETTINGS_WRITES.enqueue(writableEntries)
      .then(() => {
        if (!this.disposed && revision === this.latestRevision) report("saved");
      })
      .catch(() => {
        if (!this.disposed && revision === this.latestRevision) report("error");
      });
  }

  async flushWhileActive(): Promise<boolean> {
    await this.latestWrite.catch(() => undefined);
    return !this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.loadRevision += 1;
    this.latestRevision += 1;
  }
}
