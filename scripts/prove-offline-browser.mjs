import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const EXPECTED_PRODUCT_NAVIGATION = [
  { hash: "#/practice/pitch-match/glide", label: "Practice" },
  { hash: "#/arcade", label: "Arcade" },
  { hash: "#/explore/sound/dyad", label: "Explore" },
  { hash: "#/songs/lab", label: "Songs" },
  { hash: "#/progress/range-map", label: "Progress" },
];
const EXPECTED_OFFLINE_ROUTES = [
  { hash: "#/", heading: "The Forge" },
  { hash: "#/explore/sound/dyad", heading: "Sound Laboratory" },
  { hash: "#/practice/pitch-match/glide", heading: "Pitch Match" },
  { hash: "#/practice/pitch-tunnel", heading: "Pitch Tunnel" },
  { hash: "#/practice/hum/anchor", heading: "Hum Laboratory" },
  { hash: "#/progress/range-map", heading: "Vocal Range Map" },
  { hash: "#/practice/range-loop", heading: "Range-Building Loop" },
  { hash: "#/arcade", heading: "Voice Arcade" },
  { hash: "#/practice/pitch-control/diamond", heading: "Pitch & Dynamic Control" },
  { hash: "#/practice/note-recognition/letters", heading: "Note Recognition" },
  { hash: "#/practice/intervals/recognition", heading: "Interval Laboratory" },
  { hash: "#/practice/harmony/chord-tone", heading: "Chord & Harmony Laboratory" },
  { hash: "#/practice/melody/echo", heading: "Melody & Phrase Laboratory" },
  { hash: "#/songs/lab", heading: "Song Laboratory" },
];

async function availablePort() {
  const server = createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object", "Could not reserve a local proof port.");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

function captureOutput(child, label) {
  const lines = [];
  const append = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      lines.push(`[${label}] ${line}`);
      if (lines.length > 60) lines.shift();
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return lines;
}

async function stopProcessGroup(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => undefined);
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* exited */ } }
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* exited */ } }
  await Promise.race([exited, delay(1_000)]);
}

async function waitForHTTP(url, child, output) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Preview exited before becoming ready.\n${output.join("\n")}`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* retry */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}.\n${output.join("\n")}`);
}

async function waitForTarget(port, chromium, output) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (chromium.exitCode !== null || chromium.signalCode !== null) {
      throw new Error(`Chromium exited before DevTools became ready.\n${output.join("\n")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = response.ok ? await response.json() : [];
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* retry */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Chromium DevTools.\n${output.join("\n")}`);
}

class DevToolsSession {
  constructor(url) {
    this.nextID = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(url);
  }

  async connect() {
    await Promise.race([
      new Promise((resolve, reject) => {
        this.socket.addEventListener("open", resolve, { once: true });
        this.socket.addEventListener("error", reject, { once: true });
      }),
      delay(5_000).then(() => { throw new Error("Timed out connecting to Chromium DevTools."); }),
    ]);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {});
      }
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, 10_000);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket.close(); } catch { /* closed */ }
  }
}

async function evaluate(session, expression, awaitPromise = false) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(session, expression, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(session, expression, true)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function main() {
  const builtWorker = await readFile(join(REPOSITORY_ROOT, "dist/sw.js"), "utf8");
  assert(!builtWorker.includes("__NOTEFORGE_"), "Run npm run build before the offline proof; service worker is unstamped.");
  const precacheMatch = builtWorker.match(/const PRECACHE = (\[[^\n]*\]);/u);
  assert(precacheMatch, "The stamped service worker does not contain a readable precache manifest.");
  const stampedPrecache = JSON.parse(precacheMatch[1]);
  assert(Array.isArray(stampedPrecache) && stampedPrecache.length > 0,
    "The stamped service-worker precache manifest is empty.");
  assert.equal(new Set(stampedPrecache).size, stampedPrecache.length,
    "The stamped service-worker precache manifest contains duplicate paths.");
  const pitchWorkletPaths = stampedPrecache.filter((path) =>
    /^\/assets\/pitch-capture-worklet-[A-Za-z0-9_-]+\.js$/u.test(path));
  assert.equal(pitchWorkletPaths.length, 1,
    `Expected one content-hashed pitch worklet in the precache: ${JSON.stringify(pitchWorkletPaths)}`);
  const pitchWorkletPath = pitchWorkletPaths[0];
  assert(!stampedPrecache.includes("/worklets/pitch-capture.js"),
    "The obsolete stable pitch-worklet URL remains in the production precache.");

  let temporaryDirectory;
  let preview;
  let chromium;
  let session;
  let previewOutput = [];
  let chromiumOutput = [];
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-offline-proof-"));
    const previewPort = await availablePort();
    const debugPort = await availablePort();
    const origin = `http://127.0.0.1:${previewPort}`;

    preview = spawn(process.execPath, [
      join(REPOSITORY_ROOT, "node_modules/vite/bin/vite.js"),
      "preview",
      "--config", join(REPOSITORY_ROOT, "vite.config.ts"),
      "--host", "127.0.0.1",
      "--port", String(previewPort),
      "--strictPort",
    ], { cwd: REPOSITORY_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    previewOutput = captureOutput(preview, "preview");
    await waitForHTTP(`${origin}/`, preview, previewOutput);

    chromium = spawn(CHROMIUM, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${join(temporaryDirectory, "profile")}`,
      `--remote-debugging-port=${debugPort}`,
      "about:blank",
    ], { cwd: REPOSITORY_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    chromiumOutput = captureOutput(chromium, "chromium");
    const target = await waitForTarget(debugPort, chromium, chromiumOutput);
    session = new DevToolsSession(target.webSocketDebuggerUrl);
    await session.connect();
    const browserErrors = [];
    session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      browserErrors.push(exceptionDetails?.exception?.description || exceptionDetails?.text || "runtime exception");
    });
    session.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type !== "error") return;
      browserErrors.push(args?.map((argument) => argument.value ?? argument.description).join(" ") || "console error");
    });
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Network.enable");
    await session.send("Page.navigate", { url: `${origin}/#/practice/pitch-match/glide` });
    await waitFor(session, "Boolean(document.querySelector('.app-shell'))", "online production shell");
    await waitFor(session, `(async () => {
      const registration = await navigator.serviceWorker.ready;
      return Boolean(registration.active && navigator.serviceWorker.controller);
    })()`, "installed and controlling service worker");

    const online = await evaluate(session, `(async () => {
      const names = (await caches.keys()).filter((name) => name.startsWith('noteforge-shell-'));
      const cache = await caches.open(names[0]);
      const keys = (await cache.keys()).map((request) => new URL(request.url).pathname).sort();
      return { names, keys, title: document.title, rendered: Boolean(document.querySelector('.app-shell')) };
    })()`, true);
    assert.equal(online.names.length, 1, `Expected one current NoteForge cache: ${JSON.stringify(online.names)}`);
    assert.deepEqual(online.keys, [...stampedPrecache].sort(),
      "The installed service worker did not cache every stamped production resource.");
    assert(online.keys.includes("/"), "Fresh install did not cache the HTML shell.");
    assert(online.keys.some((key) => key.startsWith("/assets/") && key.endsWith(".js")), "Fresh install did not cache the application JavaScript.");
    assert(online.keys.some((key) => key.startsWith("/assets/") && key.endsWith(".css")), "Fresh install did not cache the application CSS.");
    assert(online.keys.includes(pitchWorkletPath), "Fresh install did not cache the content-hashed production AudioWorklet.");

    await session.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
      connectionType: "none",
    });
    await session.send("Page.reload", { ignoreCache: true });
    await waitFor(session, "Boolean(document.querySelector('.app-shell'))", "offline React application");

    const offline = await evaluate(session, `(async () => {
      const worklet = await fetch(${JSON.stringify(pitchWorkletPath)}).then((response) => response.text());
      const rejected = {};
      for (const path of ['/healthz', '/api/diagnostics/pitch', '/assets/missing.js']) {
        try { await fetch(path); rejected[path] = false; } catch { rejected[path] = true; }
      }
      return {
        controller: Boolean(navigator.serviceWorker.controller),
        rendered: Boolean(document.querySelector('.app-shell')),
        title: document.title,
        workletRegistered: worklet.includes('registerProcessor("pitch-capture"'),
        rejected,
      };
    })()`, true);
    assert(offline.controller, "Offline page lost service-worker control.");
    assert(offline.rendered && offline.title === "NoteForge", "The production app did not render from a fresh offline cache.");
    assert(offline.workletRegistered, "The shipped pitch worklet was unavailable offline.");
    assert(Object.values(offline.rejected).every(Boolean), `Offline API/health/missing assets received shell fallbacks: ${JSON.stringify(offline.rejected)}`);

    await evaluate(session, "document.querySelector('.mobile-menu')?.click(); true");
    await waitFor(session, "Boolean(document.querySelector('dialog.mobile-sidebar')?.open)", "native navigation dialog");
    await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await waitFor(session, "!document.querySelector('dialog.mobile-sidebar')?.open", "navigation dialog Escape");
    await waitFor(session, "document.activeElement === document.querySelector('.mobile-menu')", "navigation dialog focus return");
    await evaluate(session, "document.querySelector('button[aria-label=\"Settings\"]')?.click(); true");
    await waitFor(session, "Boolean(document.querySelector('dialog.drawer-backdrop')?.open)", "native settings dialog");
    await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await waitFor(session, "!document.querySelector('dialog.drawer-backdrop')", "settings dialog Escape");
    await waitFor(session, "document.activeElement === document.querySelector('button[aria-label=\"Settings\"]')", "settings dialog focus return");

    const navigationCount = await evaluate(session, "document.querySelectorAll('.sidebar nav a[href]').length");
    assert.equal(navigationCount, EXPECTED_PRODUCT_NAVIGATION.length,
      `Expected ${EXPECTED_PRODUCT_NAVIGATION.length} product navigation controls, found ${navigationCount}.`);
    const productNavigation = await evaluate(session, `[...document.querySelectorAll('.sidebar nav a[href]')].map((link) => ({
      hash: link.hash,
      label: link.textContent?.trim() || '',
    }))`);
    assert.deepEqual(productNavigation, EXPECTED_PRODUCT_NAVIGATION,
      `Permanent navigation exposed activities instead of five product jobs: ${JSON.stringify(productNavigation)}`);
    const routes = [];
    for (let index = 0; index < EXPECTED_OFFLINE_ROUTES.length; index += 1) {
      const expected = EXPECTED_OFFLINE_ROUTES[index];
      await evaluate(session, `location.hash = ${JSON.stringify(expected.hash)}; true`);
      await waitFor(session, `location.hash === ${JSON.stringify(expected.hash)}
        && document.querySelector('.topbar h2')?.textContent?.trim() === ${JSON.stringify(expected.heading)}
        && !document.querySelector('.route-loading')
        && (document.querySelector('.workspace')?.textContent?.trim().length || 0) > 40`,
      `offline route ${expected.hash}`);
      const snapshot = await evaluate(session, `({
        hash: location.hash,
        heading: document.querySelector('.topbar h2')?.textContent?.trim() || '',
        textLength: document.querySelector('.workspace')?.textContent?.trim().length || 0,
      })`);
      assert.equal(snapshot.hash, expected.hash, `Offline route hash drifted: ${JSON.stringify(snapshot)}`);
      assert.equal(snapshot.heading, expected.heading, `Offline route heading drifted: ${JSON.stringify(snapshot)}`);
      routes.push(snapshot);
    }
    await evaluate(session, `(() => {
      const link = document.querySelector('.sidebar .brand');
      if (!(link instanceof HTMLAnchorElement) || link.hash !== '#/') throw new Error('Missing NoteForge home link.');
      link.click();
    })()`);
    await waitFor(session, `location.hash === '#/'
      && document.querySelector('.topbar h2')?.textContent?.trim() === 'The Forge'
      && !document.querySelector('.route-loading')`, "offline brand home navigation");

    await evaluate(session, `(() => {
      const link = document.querySelector('.sidebar nav a[href="#/arcade"]');
      if (!(link instanceof HTMLAnchorElement)) throw new Error('Missing copyable Voice Arcade link.');
      link.click();
    })()`);
    await waitFor(session, `location.hash === '#/arcade'
      && Boolean(document.querySelector('.arcade-cabinet-grid'))`, "offline Arcade cabinet route");
    await evaluate(session, `(() => {
      const link = document.querySelector('a[data-arcade-mode="draw"][href="#/arcade/draw"]');
      if (!(link instanceof HTMLAnchorElement)) throw new Error('Missing Vocal Canvas deep link.');
      link.click();
    })()`);
    await waitFor(session, `location.hash === '#/arcade/draw'
      && Boolean(document.querySelector('.arcade-mode-page.mode-draw'))`, "offline Arcade nested route");
    await session.send("Page.reload", { ignoreCache: true });
    await waitFor(session, `location.hash === '#/arcade/draw'
      && Boolean(document.querySelector('.arcade-mode-page.mode-draw'))
      && !document.querySelector('.route-loading')`, "reloaded offline Arcade nested route");
    await evaluate(session, "history.back(); true");
    await waitFor(session, `location.hash === '#/arcade'
      && Boolean(document.querySelector('.arcade-cabinet-grid'))`, "Arcade nested browser Back");
    await evaluate(session, "location.hash = '#/skills'; true");
    await waitFor(session, `location.hash === '#/'
      && document.querySelector('.topbar h2')?.textContent?.trim() === 'The Forge'`,
    "invalid hash canonicalization");

    const distinctHashes = new Set(routes.map(({ hash }) => hash));
    assert.equal(distinctHashes.size, EXPECTED_OFFLINE_ROUTES.length,
      `Offline navigation did not reach each canonical route: ${JSON.stringify(routes)}`);
    assert.equal(browserErrors.length, 0, `Browser errors occurred during offline route traversal: ${browserErrors.join("\n")}`);

    console.log("NoteForge fresh-install offline proof passed.");
    console.log(`  cache: ${online.names[0]}`);
    console.log(`  precached resources: ${online.keys.length}`);
    console.log("  offline React render: yes");
    console.log("  offline pitch worklet: yes");
    console.log(`  permanent product links: ${EXPECTED_PRODUCT_NAVIGATION.length}`);
    console.log(`  offline canonical routes: ${routes.length}`);
    console.log("  native dialog Escape/focus return: 2/2");
    console.log("  API/health/missing-asset shell fallbacks: 0");
  } catch (error) {
    const context = [...previewOutput, ...chromiumOutput].join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}${context ? `\n${context}` : ""}`);
  } finally {
    session?.close();
    await stopProcessGroup(chromium);
    await stopProcessGroup(preview);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
