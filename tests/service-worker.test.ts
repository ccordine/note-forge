import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type WorkerListener = (event: {
  request?: RequestLike;
  waitUntil: (promise: Promise<unknown>) => void;
  respondWith: (promise: Promise<Response>) => void;
}) => void;

interface RequestLike {
  method: string;
  mode: string;
  url: string;
}

function workerHarness(precache = ["/", "/assets/app.js", "/assets/pitch-capture-worklet-build.js"]) {
  const source = readFileSync(new URL("../apps/web/public/sw.js", import.meta.url), "utf8")
    .replaceAll("__NOTEFORGE_BUILD__", "test-build")
    .replaceAll("__NOTEFORGE_PRECACHE__", JSON.stringify(precache));
  const listeners = new Map<string, WorkerListener>();
  const stores = new Map<string, Map<string, Response>>();
  const added: string[][] = [];
  const deleted: string[] = [];
  const origin = "https://noteforge.test";
  const normalize = (input: RequestInfo | URL) => new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    origin,
  ).href;
  const cacheFor = (name: string) => {
    let store = stores.get(name);
    if (!store) {
      store = new Map();
      stores.set(name, store);
    }
    return {
      addAll: async (paths: string[]) => {
        added.push([...paths]);
        for (const path of paths) store!.set(normalize(path), new Response(`precache:${path}`));
      },
      match: async (request: RequestInfo | URL) => store!.get(normalize(request)),
      put: async (request: RequestInfo | URL, response: Response) => {
        store!.set(normalize(request), response);
      },
    };
  };
  const caches = {
    open: async (name: string) => cacheFor(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => {
      deleted.push(name);
      return stores.delete(name);
    },
    match: async (request: RequestInfo | URL) => {
      for (const store of stores.values()) {
        const response = store.get(normalize(request));
        if (response) return response;
      }
      return undefined;
    },
  };
  const skipWaiting = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const fetcher = vi.fn<(request: RequestLike) => Promise<Response>>();
  const RequestConstructor = class {
    method = "GET";
    mode = "same-origin";
    url: string;

    constructor(input: string) {
      this.url = normalize(input);
    }
  };
  runInNewContext(source, {
    URL,
    Request: RequestConstructor,
    Response,
    Promise,
    caches,
    fetch: fetcher,
    self: {
      location: { origin },
      clients: { claim },
      skipWaiting,
      addEventListener: (kind: string, listener: WorkerListener) => listeners.set(kind, listener),
    },
  }, { filename: "sw.js" });

  async function dispatch(kind: string, request?: RequestLike) {
    const waits: Promise<unknown>[] = [];
    let response: Promise<Response> | null = null;
    const listener = listeners.get(kind);
    if (!listener) throw new Error(`No ${kind} listener was registered.`);
    listener({
      request,
      waitUntil: (promise) => waits.push(Promise.resolve(promise)),
      respondWith: (promise) => { response = Promise.resolve(promise); },
    });
    await Promise.all(waits);
    return { response: response as Promise<Response> | null, waits };
  }

  return { added, cacheFor, claim, deleted, dispatch, fetcher, skipWaiting, stores };
}

describe("production service worker", () => {
  it("atomically precaches the complete stamped shell without forcing an update over active clients", async () => {
    const harness = workerHarness();
    await harness.dispatch("install");
    expect(harness.added).toEqual([["/", "/assets/app.js", "/assets/pitch-capture-worklet-build.js"]]);
    expect(harness.skipWaiting).not.toHaveBeenCalled();
  });

  it("deletes only superseded NoteForge caches and claims clients", async () => {
    const harness = workerHarness();
    harness.stores.set("noteforge-shell-old", new Map());
    harness.stores.set("noteforge-shell-test-build", new Map());
    harness.stores.set("another-application", new Map());
    await harness.dispatch("activate");
    expect(harness.deleted).toEqual(["noteforge-shell-old"]);
    expect(harness.claim).toHaveBeenCalledOnce();
  });

  it("uses the cached shell only for failed navigation", async () => {
    const harness = workerHarness();
    await harness.dispatch("install");
    harness.fetcher.mockRejectedValue(new TypeError("offline"));

    const navigation = await harness.dispatch("fetch", {
      method: "GET",
      mode: "navigate",
      url: "https://noteforge.test/range-map",
    });
    expect(await navigation.response?.then((response) => response.text())).toBe("precache:/");

    const uncachedAsset = await harness.dispatch("fetch", {
      method: "GET",
      mode: "same-origin",
      url: "https://noteforge.test/assets/missing.js",
    });
    expect(uncachedAsset.response).toBeNull();

    harness.stores.get("noteforge-shell-test-build")
      ?.delete("https://noteforge.test/assets/app.js");
    const missingPrecachedAsset = await harness.dispatch("fetch", {
      method: "GET",
      mode: "same-origin",
      url: "https://noteforge.test/assets/app.js",
    });
    await expect(missingPrecachedAsset.response).rejects.toThrow("offline");
  });

  it("does not let an incumbent worker substitute an old worklet for a new hashed authority", async () => {
    const harness = workerHarness([
      "/",
      "/assets/app-old.js",
      "/assets/pitch-capture-worklet-old.js",
    ]);
    await harness.dispatch("install");

    const newWorklet = await harness.dispatch("fetch", {
      method: "GET",
      mode: "same-origin",
      url: "https://noteforge.test/assets/pitch-capture-worklet-new.js",
    });

    expect(newWorklet.response).toBeNull();
    expect(harness.fetcher).not.toHaveBeenCalled();
  });

  it("never intercepts API, health, cross-origin, or non-GET authority", async () => {
    const harness = workerHarness();
    for (const request of [
      { method: "GET", mode: "same-origin", url: "https://noteforge.test/api/diagnostics/pitch" },
      { method: "GET", mode: "same-origin", url: "https://noteforge.test/healthz" },
      { method: "GET", mode: "cors", url: "https://cdn.example.test/library.js" },
      { method: "POST", mode: "same-origin", url: "https://noteforge.test/" },
    ]) {
      const dispatched = await harness.dispatch("fetch", request);
      expect(dispatched.response).toBeNull();
    }
    expect(harness.fetcher).not.toHaveBeenCalled();
  });

  it("does not store a navigation response marked no-store", async () => {
    const harness = workerHarness();
    await harness.dispatch("install");
    harness.fetcher.mockResolvedValue(new Response("private", {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    }));
    const dispatched = await harness.dispatch("fetch", {
      method: "GET",
      mode: "navigate",
      url: "https://noteforge.test/skills",
    });
    expect(await dispatched.response?.then((response) => response.text())).toBe("private");
    const shell = await harness.cacheFor("noteforge-shell-test-build").match("/");
    expect(await shell?.text()).toBe("precache:/");
  });
});
