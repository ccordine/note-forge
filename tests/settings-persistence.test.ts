import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSettings: vi.fn(),
}));

vi.mock("../apps/web/src/storage/database", () => database);

import { SettingsPersistence } from "../apps/web/src/storage/settings-persistence";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("SettingsPersistence", () => {
  beforeEach(() => {
    database.getSetting.mockReset();
    database.setSettings.mockReset();
    database.setSettings.mockResolvedValue(undefined);
  });

  it("invalidates a disposed load and reopens the same authority for StrictMode setup replay", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    database.getSetting
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const persistence = new SettingsPersistence(["profile"] as const);

    const obsoleteLoad = persistence.load();
    persistence.dispose();
    const currentLoad = persistence.load();
    first.resolve({ version: 1 });
    second.resolve({ version: 2 });

    await expect(obsoleteLoad).resolves.toBeNull();
    await expect(currentLoad).resolves.toMatchObject({ values: { profile: { version: 2 } } });
  });

  it("never overwrites a key whose source record could not be read", async () => {
    database.getSetting.mockImplementation((key: string) => {
      if (key === "unreadable") return Promise.reject(new Error("broken record"));
      return Promise.resolve({ version: 1 });
    });
    const persistence = new SettingsPersistence(["readable", "unreadable"] as const);
    const stored = await persistence.load();
    const results: string[] = [];

    persistence.save([
      { key: "readable", value: { version: 2 } },
      { key: "unreadable", value: { version: 2 } },
    ], (result) => results.push(result));
    await persistence.flushWhileActive();

    expect(stored?.readableKeys).toEqual(new Set(["readable"]));
    expect(database.setSettings).toHaveBeenCalledWith([
      { key: "readable", value: { version: 2 } },
    ]);
    expect(results).toEqual(["saving", "saved"]);
  });

  it("serializes writes and reports completion only for the latest requested snapshot", async () => {
    database.getSetting.mockResolvedValue({ version: 0 });
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    database.setSettings
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const persistence = new SettingsPersistence(["progress"] as const);
    await persistence.load();
    const firstResults: string[] = [];
    const secondResults: string[] = [];

    persistence.save([{ key: "progress", value: { version: 1 } }], (result) => firstResults.push(result));
    persistence.save([{ key: "progress", value: { version: 2 } }], (result) => secondResults.push(result));
    await vi.waitFor(() => expect(database.setSettings).toHaveBeenCalledTimes(1));
    firstWrite.resolve();
    await vi.waitFor(() => expect(database.setSettings).toHaveBeenCalledTimes(2));
    secondWrite.resolve();
    await persistence.flushWhileActive();

    expect(database.setSettings.mock.calls).toEqual([
      [[{ key: "progress", value: { version: 1 } }]],
      [[{ key: "progress", value: { version: 2 } }]],
    ]);
    expect(firstResults).toEqual(["saving"]);
    expect(secondResults).toEqual(["saving", "saved"]);
  });

  it("suppresses completion callbacks and reports inactive after disposal", async () => {
    database.getSetting.mockResolvedValue({ version: 0 });
    const write = deferred<void>();
    database.setSettings.mockImplementation(() => write.promise);
    const persistence = new SettingsPersistence(["progress"] as const);
    await persistence.load();
    const results: string[] = [];

    persistence.save([{ key: "progress", value: { version: 1 } }], (result) => results.push(result));
    await vi.waitFor(() => expect(database.setSettings).toHaveBeenCalledTimes(1));
    persistence.dispose();
    write.resolve();

    await expect(persistence.flushWhileActive()).resolves.toBe(false);
    expect(results).toEqual(["saving"]);
  });

  it("makes a remount wait for every queued write from the previous mount", async () => {
    let stored: unknown = { version: 0 };
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    database.getSetting.mockImplementation(() => Promise.resolve(stored));
    database.setSettings
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);

    const firstMount = new SettingsPersistence(["progress"] as const);
    await firstMount.load();
    firstMount.save([{ key: "progress", value: { version: 1 } }], () => undefined);
    firstMount.save([{ key: "progress", value: { version: 2 } }], () => undefined);
    firstMount.dispose();

    const secondMount = new SettingsPersistence(["progress"] as const);
    const remountLoad = secondMount.load();
    await vi.waitFor(() => expect(database.setSettings).toHaveBeenCalledTimes(1));
    expect(database.getSetting).toHaveBeenCalledTimes(1);

    stored = { version: 1 };
    firstWrite.resolve();
    await vi.waitFor(() => expect(database.setSettings).toHaveBeenCalledTimes(2));
    expect(database.getSetting).toHaveBeenCalledTimes(1);

    stored = { version: 2 };
    secondWrite.resolve();
    await expect(remountLoad).resolves.toMatchObject({
      values: { progress: { version: 2 } },
    });
    expect(database.getSetting).toHaveBeenCalledTimes(2);
  });

  it("coalesces queued snapshots to the newest value before the next database write", async () => {
    database.getSetting.mockResolvedValue({ version: 0 });
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    database.setSettings
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const persistence = new SettingsPersistence(["progress"] as const);
    await persistence.load();

    persistence.save([{ key: "progress", value: { version: 1 } }], () => undefined);
    persistence.save([{ key: "progress", value: { version: 2 } }], () => undefined);
    persistence.save([{ key: "progress", value: { version: 3 } }], () => undefined);
    await vi.waitFor(() => expect(database.setSettings).toHaveBeenCalledTimes(1));
    firstWrite.resolve();
    await vi.waitFor(() => expect(database.setSettings).toHaveBeenCalledTimes(2));

    expect(database.setSettings.mock.calls[1]).toEqual([[
      { key: "progress", value: { version: 3 } },
    ]]);
    secondWrite.resolve();
    await persistence.flushWhileActive();
  });
});
