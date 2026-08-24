import { getSetting, setSettings } from "./database";

export type SettingsPersistenceResult = "saving" | "saved" | "error";

export interface StoredSettings<Key extends string> {
  readonly values: Readonly<Partial<Record<Key, unknown>>>;
  readonly readableKeys: ReadonlySet<Key>;
}

/**
 * One serial transaction authority for a mounted local workflow. Components
 * render persistence status but never grow mounted flags, write generations,
 * or promise chains of their own.
 */
export class SettingsPersistence<Key extends string> {
  private readonly keys: readonly Key[];
  private readableKeys = new Set<Key>();
  private writeChain: Promise<void> = Promise.resolve();
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
    const results = await Promise.allSettled(this.keys.map((key) => getSetting<unknown>(key)));
    if (this.disposed || revision !== this.loadRevision) return null;
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
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => setSettings(writableEntries))
      .then(() => {
        if (!this.disposed && revision === this.latestRevision) report("saved");
      })
      .catch(() => {
        if (!this.disposed && revision === this.latestRevision) report("error");
      });
  }

  async flushWhileActive(): Promise<boolean> {
    await this.writeChain.catch(() => undefined);
    return !this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.loadRevision += 1;
    this.latestRevision += 1;
  }
}
