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
const EXPECTED_OFFLINE_ROUTES = [
  { hash: "#home", heading: "The Forge" },
  { hash: "#sound", heading: "Sound Laboratory" },
  { hash: "#mirror", heading: "Pitch Mirror" },
  { hash: "#hum", heading: "Hum Laboratory" },
  { hash: "#range-map", heading: "Guided Range Simulator" },
  { hash: "#loop", heading: "Range-Building Loop" },
  { hash: "#arcade", heading: "Voice Arcade" },
  { hash: "#control", heading: "Pitch & Dynamic Control" },
  { hash: "#ear", heading: "Note Recognition" },
  { hash: "#intervals", heading: "Interval Laboratory" },
  { hash: "#harmony", heading: "Chord & Harmony Laboratory" },
  { hash: "#melody", heading: "Melody & Phrase Laboratory" },
  { hash: "#song", heading: "Song Laboratory" },
  { hash: "#skills", heading: "Trainable Skill Graph" },
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
    await session.send("Page.navigate", { url: `${origin}/#mirror` });
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

    const navigationCount = await evaluate(session, "document.querySelectorAll('.sidebar nav button').length");
    assert.equal(navigationCount, EXPECTED_OFFLINE_ROUTES.length,
      `Expected ${EXPECTED_OFFLINE_ROUTES.length} canonical navigation controls, found ${navigationCount}.`);
    const routes = [];
    for (let index = 0; index < EXPECTED_OFFLINE_ROUTES.length; index += 1) {
      const expected = EXPECTED_OFFLINE_ROUTES[index];
      const label = await evaluate(session, `(() => {
        const button = document.querySelectorAll('.sidebar nav button')[${index}];
        if (!(button instanceof HTMLButtonElement)) throw new Error('Missing navigation button ${index}.');
        const label = button.textContent?.trim() || 'route-${index}';
        button.click();
        return label;
      })()`);
      await waitFor(session, `location.hash === ${JSON.stringify(expected.hash)}
        && document.querySelector('.topbar h2')?.textContent?.trim() === ${JSON.stringify(expected.heading)}
        && !document.querySelector('.route-loading')
        && (document.querySelector('.workspace')?.textContent?.trim().length || 0) > 40`,
      `offline route ${expected.hash}`);
      const snapshot = await evaluate(session, `({
        label: ${JSON.stringify(label)},
        hash: location.hash,
        heading: document.querySelector('.topbar h2')?.textContent?.trim() || '',
        textLength: document.querySelector('.workspace')?.textContent?.trim().length || 0,
      })`);
      assert.equal(snapshot.hash, expected.hash, `Offline route hash drifted: ${JSON.stringify(snapshot)}`);
      assert.equal(snapshot.heading, expected.heading, `Offline route heading drifted: ${JSON.stringify(snapshot)}`);
      routes.push(snapshot);
    }
    await evaluate(session, `(() => {
      const button = document.querySelector('.sidebar .brand');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Missing NoteForge home button.');
      button.click();
    })()`);
    await waitFor(session, `location.hash === '#home'
      && document.querySelector('.topbar h2')?.textContent?.trim() === 'The Forge'
      && !document.querySelector('.route-loading')`, "offline brand home navigation");
    const distinctHashes = new Set(routes.map(({ hash }) => hash));
    assert.equal(distinctHashes.size, EXPECTED_OFFLINE_ROUTES.length,
      `Offline navigation did not reach each canonical route: ${JSON.stringify(routes)}`);
    assert.equal(browserErrors.length, 0, `Browser errors occurred during offline route traversal: ${browserErrors.join("\n")}`);

    console.log("NoteForge fresh-install offline proof passed.");
    console.log(`  cache: ${online.names[0]}`);
    console.log(`  precached resources: ${online.keys.length}`);
    console.log("  offline React render: yes");
    console.log("  offline pitch worklet: yes");
    console.log(`  offline canonical routes: ${routes.length}`);
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
