import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SustainedNotePlaybackStore,
  type SustainedNoteLane,
  type SustainedNoteSpec,
} from "../apps/web/src/audio/sustained-note-playback";
import {
  SustainedNotePlaybackProvider,
  type SustainedNoteControl,
} from "../apps/web/src/audio/use-sustained-note";
import { NotePlaybackToggle } from "../apps/web/src/ui/NotePlaybackToggle";

const A3: Readonly<SustainedNoteSpec> = Object.freeze({
  frequencyHz: 220,
  timbre: "sine",
  amplitude: 0.18,
});
const C4: Readonly<SustainedNoteSpec> = Object.freeze({
  frequencyHz: 261.6256,
  timbre: "piano",
  amplitude: 0.2,
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

class FakeLane implements SustainedNoteLane {
  readonly starts: Readonly<SustainedNoteSpec>[] = [];
  readonly updates: Readonly<SustainedNoteSpec>[] = [];
  stopCount = 0;
  nextStart: Promise<boolean> = Promise.resolve(true);

  start = (spec: Readonly<SustainedNoteSpec>): Promise<boolean> => {
    this.starts.push(spec);
    return this.nextStart;
  };

  update = (spec: Readonly<SustainedNoteSpec>): void => {
    this.updates.push(spec);
  };

  stop = (): void => {
    this.stopCount += 1;
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("app-owned sustained isolated-note playback", () => {
  it("has no automatic cutoff after two hours and stops only on the owner's second toggle", async () => {
    vi.useFakeTimers();
    const lane = new FakeLane();
    const store = new SustainedNotePlaybackStore(lane);
    const owner = Symbol("owner");

    store.toggle(owner, A3);
    await settle();
    expect(store.getSnapshot()).toMatchObject({ status: "on", owner, spec: A3 });
    expect(lane.starts).toHaveLength(1);
    expect(lane.stopCount).toBe(0);

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
    expect(store.getSnapshot()).toMatchObject({ status: "on", owner, spec: A3 });
    expect(lane.starts).toHaveLength(1);
    expect(lane.stopCount).toBe(0);

    store.toggle(owner, A3);
    expect(store.getSnapshot()).toEqual({ status: "off", owner: null, spec: null, error: "" });
    expect(lane.stopCount).toBe(1);
  });

  it("updates the active owner's pitch and timbre in place", async () => {
    const lane = new FakeLane();
    const store = new SustainedNotePlaybackStore(lane);
    const owner = Symbol("owner");
    const stranger = Symbol("stranger");

    store.toggle(owner, A3);
    await settle();
    store.update(owner, C4);
    store.update(stranger, A3);

    expect(store.getSnapshot()).toMatchObject({ status: "on", owner, spec: C4 });
    expect(lane.starts).toHaveLength(1);
    expect(lane.updates).toEqual([C4]);
    expect(lane.stopCount).toBe(0);
  });

  it("hands the one lane to a new owner by retuning without overlap", async () => {
    const lane = new FakeLane();
    const store = new SustainedNotePlaybackStore(lane);
    const firstOwner = Symbol("first");
    const secondOwner = Symbol("second");

    store.toggle(firstOwner, A3);
    await settle();
    store.toggle(secondOwner, C4);

    expect(store.getSnapshot()).toMatchObject({ status: "on", owner: secondOwner, spec: C4 });
    expect(lane.starts).toHaveLength(1);
    expect(lane.updates).toEqual([C4]);
    expect(lane.stopCount).toBe(0);

    store.release(firstOwner);
    expect(store.getSnapshot().status).toBe("on");
    expect(lane.stopCount).toBe(0);
    store.release(secondOwner);
    expect(store.getSnapshot().status).toBe("off");
    expect(lane.stopCount).toBe(1);
  });

  it("keeps an async on-to-off race off after the old start completes", async () => {
    const pending = deferred<boolean>();
    const lane = new FakeLane();
    lane.nextStart = pending.promise;
    const store = new SustainedNotePlaybackStore(lane);
    const owner = Symbol("owner");

    store.toggle(owner, A3);
    expect(store.getSnapshot().status).toBe("starting");
    store.toggle(owner, A3);
    expect(store.getSnapshot().status).toBe("off");
    expect(lane.stopCount).toBe(1);

    pending.resolve(true);
    await settle();
    expect(store.getSnapshot().status).toBe("off");
    expect(lane.stopCount).toBe(1);
  });

  it("lets the final explicit On win an on-off-on race without reviving the old request", async () => {
    const firstStart = deferred<boolean>();
    const secondStart = deferred<boolean>();
    const lane = new FakeLane();
    lane.nextStart = firstStart.promise;
    const store = new SustainedNotePlaybackStore(lane);
    const owner = Symbol("owner");

    store.toggle(owner, A3);
    store.toggle(owner, A3);
    lane.nextStart = secondStart.promise;
    store.toggle(owner, C4);
    expect(store.getSnapshot()).toMatchObject({ status: "starting", owner, spec: C4 });

    firstStart.resolve(true);
    await settle();
    expect(store.getSnapshot()).toMatchObject({ status: "starting", owner, spec: C4 });

    secondStart.resolve(true);
    await settle();
    expect(store.getSnapshot()).toMatchObject({ status: "on", owner, spec: C4 });
    expect(lane.starts).toEqual([A3, C4]);
    expect(lane.stopCount).toBe(1);
  });

  it("lets a new owner replace a still-starting request without a second voice", async () => {
    const pending = deferred<boolean>();
    const lane = new FakeLane();
    lane.nextStart = pending.promise;
    const store = new SustainedNotePlaybackStore(lane);
    const firstOwner = Symbol("first");
    const secondOwner = Symbol("second");

    store.toggle(firstOwner, A3);
    store.toggle(secondOwner, C4);
    expect(store.getSnapshot()).toMatchObject({ status: "starting", owner: secondOwner, spec: C4 });
    expect(lane.starts).toHaveLength(1);
    expect(lane.updates).toEqual([C4]);

    pending.resolve(true);
    await settle();
    expect(store.getSnapshot()).toMatchObject({ status: "on", owner: secondOwner, spec: C4 });
    expect(lane.starts).toHaveLength(1);
    expect(lane.stopCount).toBe(0);
  });

  it("publishes a recoverable error and never reports a failed note as on", async () => {
    const lane = new FakeLane();
    lane.nextStart = Promise.reject(new Error("Audio device refused playback"));
    const store = new SustainedNotePlaybackStore(lane);
    const owner = Symbol("owner");
    const snapshots: string[] = [];
    const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot().status));

    store.toggle(owner, A3);
    await settle();
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      owner,
      error: "Audio device refused playback",
    });
    expect(snapshots).toEqual(["starting", "error"]);
    expect(lane.stopCount).toBe(1);

    lane.nextStart = Promise.resolve(true);
    store.toggle(owner, A3);
    await settle();
    expect(store.getSnapshot()).toMatchObject({ status: "on", owner, error: "" });
    unsubscribe();
  });

  it("freezes exact snapshots and rejects duration-shaped or invalid requests", () => {
    const lane = new FakeLane();
    const store = new SustainedNotePlaybackStore(lane);
    const owner = Symbol("owner");
    const invalid = {
      frequencyHz: 0,
      timbre: "sine",
      amplitude: 0.18,
      duration: 1,
    } as unknown as SustainedNoteSpec;

    store.toggle(owner, invalid);
    const snapshot = store.getSnapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.spec).toBeNull();
    expect(snapshot.error).toContain("frequency");
    expect(lane.starts).toHaveLength(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.keys(A3).sort()).toEqual(["amplitude", "frequencyHz", "timbre"]);
  });

  it("makes timed isolated-note playback absent from the public contract and runtime", () => {
    const source = readFileSync(
      new URL("../apps/web/src/audio/sustained-note-playback.ts", import.meta.url),
      "utf8",
    );
    const specBody = source.match(/export interface SustainedNoteSpec\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";
    const storeBody = source.slice(source.indexOf("export class SustainedNotePlaybackStore"));

    expect(specBody).not.toMatch(/duration|deadline|timeout|\bwhen\b/u);
    expect(storeBody).not.toMatch(/setTimeout|setInterval|Date\.now|performance\.now/u);
  });

  it("renders one accessible pressed toggle with literal Play and Stop labels", () => {
    const store = new SustainedNotePlaybackStore(new FakeLane());
    const offControl: SustainedNoteControl = Object.freeze({
      status: "off",
      playing: false,
      error: "",
      toggle: vi.fn(),
    });
    const onControl: SustainedNoteControl = Object.freeze({
      status: "on",
      playing: true,
      error: "",
      toggle: vi.fn(),
    });
    const render = (playback: SustainedNoteControl) => renderToStaticMarkup(createElement(
      SustainedNotePlaybackProvider,
      { store },
      createElement(NotePlaybackToggle, { label: "C3", playback }),
    ));

    const off = render(offControl);
    const on = render(onControl);
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('data-playback-status="off"');
    expect(off).toContain("Play C3");
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('data-playback-status="on"');
    expect(on).toContain("Stop C3");
  });
});
