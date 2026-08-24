const BUILD = "__NOTEFORGE_BUILD__";
const CACHE = `noteforge-shell-${BUILD}`;
const PRECACHE = __NOTEFORGE_PRECACHE__;

function cacheKey(url) {
  return new Request(`${url.origin}${url.pathname}`);
}

function responseMayBeCached(response) {
  return response.ok
    && response.type !== "opaque"
    && !response.headers.get("Cache-Control")?.toLowerCase().includes("no-store");
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE);
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith("noteforge-shell-") && key !== CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/healthz" || url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (responseMayBeCached(response)) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put("/", copy)));
        }
        return response;
      } catch (error) {
        const cache = await caches.open(CACHE);
        const shell = await cache.match("/");
        if (shell) return shell;
        throw error;
      }
    })());
    return;
  }

  const precachePath = url.pathname;
  if (!PRECACHE.includes(precachePath)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = cacheKey(url);
    const cached = await cache.match(key);
    if (cached) return cached;
    const response = await fetch(request);
    if (responseMayBeCached(response)) {
      event.waitUntil(cache.put(key, response.clone()));
    }
    return response;
  })());
});
