import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalDrawFrames,
  contiguousRuns,
  coordinatesFromPath,
  drawProgressDiagnostic,
  EXPECTED_COMMANDS,
  fixtureRelation,
  frameKey,
  generatedVoiceDrawWav,
  HOP_SAMPLES,
  pitchFramesFrom,
  pointDistance,
  SAMPLE_RATE,
  WINDOW_SAMPLES,
} from "./proof-support/voice-draw-proof-support.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function availablePort() {
  const server = createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object", "Could not reserve a local browser-proof port.");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

function captureProcessOutput(child, label) {
  const lines = [];
  const append = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      lines.push(`[${label}] ${line}`);
      if (lines.length > 80) lines.shift();
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return lines;
}

async function stopProcessGroup(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => undefined);
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
  await Promise.race([exited, delay(1_000)]);
}

async function waitForHttp(url, child, output) {
  const deadline = Date.now() + 12_000;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Preview exited before ${url} became ready.\n${output.join("\n")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}\n${output.join("\n")}`);
}

async function waitForPageTarget(debugPort, chromium, output) {
  const deadline = Date.now() + 12_000;
  let lastError = "DevTools endpoint unavailable";
  while (Date.now() < deadline) {
    if (chromium.exitCode !== null || chromium.signalCode !== null) {
      throw new Error(`Chromium exited before DevTools became ready.\n${output.join("\n")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page) return page;
        lastError = "no page target";
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Chromium DevTools: ${lastError}\n${output.join("\n")}`);
}

class DevToolsSession {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(webSocketUrl);
  }

  async connect() {
    if (this.socket.readyState !== WebSocket.OPEN) {
      await Promise.race([
        new Promise((resolveConnection, rejectConnection) => {
          this.socket.addEventListener("open", resolveConnection, { once: true });
          this.socket.addEventListener("error", rejectConnection, { once: true });
        }),
        delay(5_000).then(() => { throw new Error("Timed out connecting to Chromium DevTools."); }),
      ]);
    }
    this.socket.addEventListener("message", (event) => this.receive(event.data));
    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("Chromium DevTools disconnected."));
      this.pending.clear();
    });
  }

  receive(data) {
    const message = JSON.parse(String(data));
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) {
      try { listener(message.params ?? {}); } catch { /* final assertions inspect retained evidence */ }
    }
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error(`Timed out waiting for DevTools command ${method}.`));
      }, 8_000);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolveCommand(value); },
        reject: (error) => { clearTimeout(timer); rejectCommand(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

async function evaluate(session, expression, awaitPromise = false) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || `Browser evaluation failed: ${expression}`);
  }
  return result.result?.value;
}

async function waitForBrowser(session, expression, description, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await evaluate(session, expression)) return;
    await delay(80);
  }
  const body = await evaluate(session, "document.body?.innerText?.slice(0, 4000) || ''");
  throw new Error(`Timed out waiting for ${description}.\nRendered page:\n${body}`);
}

async function proofSnapshot(session) {
  return evaluate(session, `(async () => new Promise((resolveSnapshot) => {
    const control = window.__noteforgeVoiceDrawProof;
    if (typeof control?.snapshot !== 'function') {
      resolveSnapshot(null);
      return;
    }
    let interval = null;
    let timeout = null;
    const observer = new MutationObserver(() => check());
    const finish = (snapshot) => {
      observer.disconnect();
      if (interval !== null) clearInterval(interval);
      if (timeout !== null) clearTimeout(timeout);
      resolveSnapshot(snapshot);
    };
    const check = () => {
      const snapshot = control.snapshot();
      const published = snapshot.drawSnapshots.at(-1);
      if (published?.observedFrameCount === snapshot.workletSampleMessages) {
        finish(snapshot);
      }
    };
    observer.observe(document, { subtree: true, childList: true, attributes: true });
    interval = setInterval(check, 5);
    timeout = setTimeout(() => finish(null), 5_000);
    check();
  }))()`, true);
}

async function main() {
  let temporaryDirectory;
  let preview;
  let chromium;
  let session;
  let previewOutput = [];
  let chromiumOutput = [];

  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-voice-draw-proof-"));
    const wavPath = join(temporaryDirectory, "voice-draw-square.wav");
    const chromiumProfile = join(temporaryDirectory, "chromium-profile");
    const previewPort = await availablePort();
    const debugPort = await availablePort();
    const pageUrl = `http://127.0.0.1:${previewPort}/#/arcade`;
    await writeFile(wavPath, generatedVoiceDrawWav());

    preview = spawn(process.execPath, [
      join(REPOSITORY_ROOT, "node_modules/vite/bin/vite.js"),
      "preview",
      "--config", join(REPOSITORY_ROOT, "vite.config.ts"),
      "--host", "127.0.0.1",
      "--port", String(previewPort),
      "--strictPort",
    ], {
      cwd: REPOSITORY_ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    previewOutput = captureProcessOutput(preview, "vite-preview");
    await waitForHttp(`http://127.0.0.1:${previewPort}/`, preview, previewOutput);

    chromium = spawn(CHROMIUM, [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}`,
      `--user-data-dir=${chromiumProfile}`,
      `--remote-debugging-port=${debugPort}`,
      "about:blank",
    ], {
      cwd: REPOSITORY_ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    chromiumOutput = captureProcessOutput(chromium, "chromium");
    const target = await waitForPageTarget(debugPort, chromium, chromiumOutput);
    session = new DevToolsSession(target.webSocketDebuggerUrl);
    await session.connect();

    const diagnosticBatches = [];
    const browserErrors = [];
    session.on("Network.requestWillBeSent", ({ request }) => {
      if (!request?.url?.includes("/api/diagnostics/pitch") || !request.postData) return;
      try { diagnosticBatches.push(JSON.parse(request.postData)); } catch { /* assertions reject missing evidence */ }
    });
    session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      browserErrors.push(exceptionDetails?.exception?.description || exceptionDetails?.text || "browser exception");
    });
    session.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type !== "error") return;
      browserErrors.push(args?.map((argument) => argument.value ?? argument.description).join(" ") || "console error");
    });

    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Network.enable");
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const proof = {
          getUserMediaCalls: 0,
          streams: 0,
          tracks: 0,
          mediaStreamSources: 0,
          knownStreamSources: 0,
          audioContexts: 0,
          workletModuleUrls: [],
          workletNodes: 0,
          workletSampleMessages: 0,
          workletSampleEvents: [],
          trackInitialStates: [],
          trackEnabledWrites: [],
          trackStopCalls: [],
          drawSnapshots: [],
          instrumentationErrors: [],
        };
        const knownStreams = new WeakSet();
        Object.defineProperty(window, '__noteforgeVoiceDrawProof', {
          configurable: false,
          enumerable: false,
          writable: false,
          value: Object.freeze({ snapshot: () => JSON.parse(JSON.stringify(proof)) }),
        });

        const NativeAudioContext = window.AudioContext;
        if (typeof NativeAudioContext !== 'function') {
          proof.instrumentationErrors.push('AudioContext unavailable');
        } else {
          try {
            const nativeCreateMediaStreamSource = NativeAudioContext.prototype.createMediaStreamSource;
            Object.defineProperty(NativeAudioContext.prototype, 'createMediaStreamSource', {
              configurable: true,
              writable: true,
              value(stream) {
                proof.mediaStreamSources += 1;
                if (knownStreams.has(stream)) proof.knownStreamSources += 1;
                return Reflect.apply(nativeCreateMediaStreamSource, this, [stream]);
              },
            });
            window.AudioContext = new Proxy(NativeAudioContext, {
              construct(target, args) {
                proof.audioContexts += 1;
                return Reflect.construct(target, args, target);
              },
            });
          } catch (error) {
            proof.instrumentationErrors.push('AudioContext instrumentation: ' + String(error));
          }
        }

        const nativeAddModule = window.AudioWorklet?.prototype?.addModule;
        if (typeof nativeAddModule !== 'function') {
          proof.instrumentationErrors.push('AudioWorklet.addModule unavailable');
        } else {
          try {
            Object.defineProperty(window.AudioWorklet.prototype, 'addModule', {
              configurable: true,
              writable: true,
              value(...args) {
                proof.workletModuleUrls.push(new URL(String(args[0]), document.baseURI).href);
                return Reflect.apply(nativeAddModule, this, args);
              },
            });
          } catch (error) {
            proof.instrumentationErrors.push('AudioWorklet.addModule instrumentation: ' + String(error));
          }
        }

        const NativeAudioWorkletNode = window.AudioWorkletNode;
        if (typeof NativeAudioWorkletNode !== 'function') {
          proof.instrumentationErrors.push('AudioWorkletNode unavailable');
        } else {
          try {
            window.AudioWorkletNode = new Proxy(NativeAudioWorkletNode, {
              construct(target, args) {
                const node = Reflect.construct(target, args, target);
                proof.workletNodes += 1;
                node.port.addEventListener('message', (event) => {
                  if (event.data?.type !== 'samples') return;
                  const samples = event.data.samples;
                  let sumSquares = 0;
                  let peak = 0;
                  let nonzeroSampleCount = 0;
                  let firstNonzeroIndex = null;
                  let lastNonzeroIndex = null;
                  for (let index = 0; index < (samples?.length ?? 0); index += 1) {
                    const sample = samples[index];
                    sumSquares += sample * sample;
                    peak = Math.max(peak, Math.abs(sample));
                    if (sample !== 0) {
                      nonzeroSampleCount += 1;
                      if (firstNonzeroIndex === null) firstNonzeroIndex = index;
                      lastNonzeroIndex = index;
                    }
                  }
                  proof.workletSampleMessages += 1;
                  proof.workletSampleEvents.push({
                    startSample: event.data.startSample,
                    endSample: event.data.endSample,
                    captureEpoch: event.data.captureEpoch,
                    continuityEpoch: event.data.continuityEpoch,
                    graphGeneration: event.data.graphGeneration,
                    processCount: event.data.processCount,
                    processedSampleCount: event.data.processedSampleCount,
                    discontinuity: event.data.discontinuity,
                    sampleCount: samples?.length ?? null,
                    sampleRms: samples?.length ? Math.sqrt(sumSquares / samples.length) : null,
                    samplePeak: peak,
                    nonzeroSampleCount,
                    firstNonzeroIndex,
                    lastNonzeroIndex,
                  });
                });
                return node;
              },
            });
          } catch (error) {
            proof.instrumentationErrors.push('AudioWorkletNode instrumentation: ' + String(error));
          }
        }

        const devices = navigator.mediaDevices;
        if (!devices?.getUserMedia) {
          proof.instrumentationErrors.push('navigator.mediaDevices.getUserMedia unavailable');
        } else {
          const originalGetUserMedia = devices.getUserMedia.bind(devices);
          const instrumentTrack = (track) => {
            proof.tracks += 1;
            proof.trackInitialStates.push({ enabled: track.enabled, kind: track.kind, readyState: track.readyState });
            let prototype = track;
            let descriptor;
            while (prototype && !descriptor) {
              prototype = Object.getPrototypeOf(prototype);
              descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'enabled');
            }
            if (descriptor?.get && descriptor?.set) {
              try {
                Object.defineProperty(track, 'enabled', {
                  configurable: true,
                  enumerable: descriptor.enumerable,
                  get() { return descriptor.get.call(track); },
                  set(value) {
                    proof.trackEnabledWrites.push(Boolean(value));
                    return descriptor.set.call(track, value);
                  },
                });
              } catch (error) {
                proof.instrumentationErrors.push('track.enabled instrumentation: ' + String(error));
              }
            } else {
              proof.instrumentationErrors.push('MediaStreamTrack.enabled descriptor unavailable');
            }
            const originalStop = track.stop.bind(track);
            try {
              Object.defineProperty(track, 'stop', {
                configurable: true,
                value() {
                  proof.trackStopCalls.push({ kind: track.kind, readyState: track.readyState });
                  return originalStop();
                },
              });
            } catch (error) {
              proof.instrumentationErrors.push('track.stop instrumentation: ' + String(error));
            }
          };
          try {
            Object.defineProperty(devices, 'getUserMedia', {
              configurable: true,
              value: async (...args) => {
                proof.getUserMediaCalls += 1;
                const stream = await originalGetUserMedia(...args);
                proof.streams += 1;
                knownStreams.add(stream);
                stream.getAudioTracks().forEach(instrumentTrack);
                return stream;
              },
            });
          } catch (error) {
            proof.instrumentationErrors.push('getUserMedia instrumentation: ' + String(error));
          }
        }

        const numberAttribute = (root, name) => {
          const raw = root.getAttribute(name);
          return raw === null || raw === '' ? null : Number(raw);
        };
        const recordDrawSnapshot = () => {
          const root = document.querySelector('[data-voice-draw]');
          if (!root) return;
          const snapshot = {
            at: performance.now(),
            inputState: root.getAttribute('data-input-state'),
            drawPhase: root.getAttribute('data-draw-phase'),
            endSample: numberAttribute(root, 'data-end-sample'),
            captureEpoch: numberAttribute(root, 'data-capture-epoch'),
            continuityEpoch: numberAttribute(root, 'data-continuity-epoch'),
            graphGeneration: numberAttribute(root, 'data-graph-generation'),
            activeMidi: numberAttribute(root, 'data-active-midi'),
            activeDirection: root.getAttribute('data-active-direction') || null,
            heldSeconds: numberAttribute(root, 'data-held-seconds'),
            cursorX: numberAttribute(root, 'data-cursor-x'),
            cursorY: numberAttribute(root, 'data-cursor-y'),
            segmentCount: numberAttribute(root, 'data-segment-count'),
            observedFrameCount: numberAttribute(root, 'data-observed-frame-count'),
            paths: [...root.querySelectorAll('.voice-draw-artwork path')]
              .map((path) => path.getAttribute('d')),
          };
          const previous = proof.drawSnapshots.at(-1);
          const signature = JSON.stringify(snapshot, (key, value) => key === 'at' ? undefined : value);
          const previousSignature = previous
            ? JSON.stringify(previous, (key, value) => key === 'at' ? undefined : value)
            : null;
          if (signature !== previousSignature) proof.drawSnapshots.push(snapshot);
        };
        const observer = new MutationObserver(recordDrawSnapshot);
        observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: [
            'data-input-state',
            'data-draw-phase',
            'data-end-sample',
            'data-capture-epoch',
            'data-continuity-epoch',
            'data-graph-generation',
            'data-active-midi',
            'data-active-direction',
            'data-held-seconds',
            'data-cursor-x',
            'data-cursor-y',
            'data-segment-count',
            'data-observed-frame-count',
            'd',
          ],
        });
      })();`,
    });

    await session.send("Page.navigate", { url: pageUrl });
    await waitForBrowser(
      session,
      `(() => {
        const link = document.querySelector('a[data-arcade-mode="draw"][href="#/arcade/draw"]');
        return document.readyState === 'complete' && Boolean(link);
      })()`,
      "the hydrated Voice Arcade cabinet",
      10_000,
    );
    const entryScripts = await evaluate(session, `[...document.querySelectorAll('script[src]')]
      .map((script) => new URL(script.src, location.href).pathname)`);
    assert(entryScripts.some((path) => /^\/assets\/index-[A-Za-z0-9_-]+\.js$/u.test(path)),
      `Voice Draw proof did not load a hashed production entry: ${JSON.stringify(entryScripts)}`);
    assert(entryScripts.every((path) => !path.includes("/@vite/") && !path.includes("/src/")),
      `Voice Draw proof loaded development/source modules: ${JSON.stringify(entryScripts)}`);

    const cabinetClicked = await evaluate(session, `(() => {
      const link = document.querySelector('a[data-arcade-mode="draw"][href="#/arcade/draw"]');
      link?.click();
      return Boolean(link);
    })()`);
    assert(cabinetClicked, "The real Vocal Canvas cabinet control was not clickable.");
    await waitForBrowser(session, "Boolean(document.querySelector('[data-voice-draw]'))", "Voice Draw");
    const settingsOpened = await evaluate(session, `(() => {
      const settings = document.querySelector('[data-settings-open]');
      settings?.click();
      return Boolean(settings);
    })()`);
    assert(settingsOpened, "Voice Draw could not open the visible diagnostic consent setting.");
    await waitForBrowser(
      session,
      "Boolean(document.querySelector('[data-remote-pitch-diagnostics-toggle]'))",
      "Voice Draw's remote derived-diagnostic consent control",
    );
    const diagnosticsEnabled = await evaluate(session, `(() => {
      const consent = document.querySelector('[data-remote-pitch-diagnostics-toggle]');
      if (!(consent instanceof HTMLInputElement)) return false;
      if (!consent.checked) consent.click();
      document.querySelector('button[aria-label="Close settings"]')?.click();
      return consent.checked;
    })()`);
    assert(diagnosticsEnabled, "Voice Draw did not explicitly enable remote derived diagnostics.");
    const enableClicked = await evaluate(session, `(() => {
      const button = document.querySelector('[data-global-mic-enable]');
      button?.click();
      return Boolean(button);
    })()`);
    assert(enableClicked, "The sole global Enable voice control was not clickable from Voice Draw.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-voice-draw]')?.getAttribute('data-input-state') === 'running'",
      "Voice Draw's running shared input",
      8_000,
    );
    const startClicked = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('[data-voice-draw] button')]
        .find((candidate) => candidate.textContent?.trim() === 'Start drawing');
      button?.click();
      return Boolean(button);
    })()`);
    assert(startClicked, "Voice Draw did not expose a user-owned Start drawing control.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-voice-draw]')?.getAttribute('data-draw-phase') === 'drawing'",
      "Voice Draw's explicitly started drawing phase",
    );

    try {
      await waitForBrowser(
        session,
        `(() => {
        const frames = window.__noteforgeVoiceDrawProof?.snapshot?.().drawSnapshots ?? [];
        const commands = [];
        let previous = '';
        for (const frame of frames) {
          if (!frame.activeDirection) continue;
          const command = frame.activeMidi + ':' + frame.activeDirection;
          if (command !== previous) commands.push(command);
          previous = command;
        }
        const expected = ['48:up', '50:right', '52:down', '54:left'];
        const ordered = expected.every((value, index) => commands[index] === value);
        const lastLeft = frames.findLastIndex((frame) => frame.activeMidi === 54 && frame.activeDirection === 'left');
        const finalSilence = lastLeft < 0 ? [] : frames.slice(lastLeft + 1)
          .filter((frame) => frame.endSample !== null && frame.activeMidi === null);
        return ordered && finalSilence.length >= 12
          && finalSilence.at(-1).endSample - finalSilence[0].endSample >= ${HOP_SAMPLES * 8};
      })()`,
        "C3 up, D3 right, E3 down, and F-sharp3 left followed by silence",
        20_000,
      );
    } catch (error) {
      const stalledSnapshot = await evaluate(
        session,
        "window.__noteforgeVoiceDrawProof?.snapshot?.() ?? null",
      );
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n`
        + `Exact Voice Draw progress: ${JSON.stringify(
          drawProgressDiagnostic(stalledSnapshot, diagnosticBatches),
        )}`);
    }
    const beforeFinish = await evaluate(session, `(() => {
      const root = document.querySelector('[data-voice-draw]');
      return {
        cursorX: Number(root?.getAttribute('data-cursor-x')),
        cursorY: Number(root?.getAttribute('data-cursor-y')),
        segmentCount: Number(root?.getAttribute('data-segment-count')),
        observedFrameCount: Number(root?.getAttribute('data-observed-frame-count')),
      };
    })()`);
    const finishClicked = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('[data-voice-draw] button')]
        .find((candidate) => candidate.textContent?.trim() === 'Finish drawing');
      button?.click();
      return Boolean(button);
    })()`);
    assert(finishClicked, "Voice Draw did not expose a user-owned Finish drawing control.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-voice-draw]')?.getAttribute('data-draw-phase') === 'complete'",
      "Voice Draw's explicitly finished phase",
    );
    await waitForBrowser(
      session,
      `Number(document.querySelector('[data-voice-draw]')?.getAttribute('data-observed-frame-count'))
        > ${beforeFinish.observedFrameCount + 4}`,
      "continued authoritative observations after explicit Finish",
    );
    const afterFinish = await evaluate(session, `(() => {
      const root = document.querySelector('[data-voice-draw]');
      return {
        cursorX: Number(root?.getAttribute('data-cursor-x')),
        cursorY: Number(root?.getAttribute('data-cursor-y')),
        segmentCount: Number(root?.getAttribute('data-segment-count')),
        observedFrameCount: Number(root?.getAttribute('data-observed-frame-count')),
      };
    })()`);
    assert(afterFinish.observedFrameCount > beforeFinish.observedFrameCount,
      "Voice Draw stopped consuming telemetry after explicit Finish.");
    assert(afterFinish.cursorX === beforeFinish.cursorX
      && afterFinish.cursorY === beforeFinish.cursorY
      && afterFinish.segmentCount === beforeFinish.segmentCount,
    `Voice Draw mutated the finished artifact after explicit Finish: ${JSON.stringify({ beforeFinish, afterFinish })}`);
    // Let production's one-second diagnostic batch timer flush the final
    // voiced evidence while the generated microphone remains in its long tail.
    await delay(1_100);

    const snapshot = await proofSnapshot(session);
    assert(snapshot, "Voice Draw browser instrumentation returned no snapshot.");
    const frames = canonicalDrawFrames(snapshot.drawSnapshots);
    const workletFrames = snapshot.workletSampleEvents;
    const diagnosticFrames = pitchFramesFrom(diagnosticBatches);
    const workletByKey = new Map(workletFrames.map((frame) => [frameKey(frame), frame]));
    const workletOrdinalByKey = new Map(
      workletFrames.map((frame, index) => [frameKey(frame), index + 1]),
    );
    const diagnosticByKey = new Map(diagnosticFrames.map((frame) => [frameKey(frame), frame]));

    assert(snapshot.instrumentationErrors.length === 0,
      `Voice Draw instrumentation failed: ${JSON.stringify(snapshot.instrumentationErrors)}`);
    assert(snapshot.getUserMediaCalls === 1 && snapshot.streams === 1 && snapshot.tracks === 1,
      `Expected one microphone authority; got gUM=${snapshot.getUserMediaCalls}, streams=${snapshot.streams}, tracks=${snapshot.tracks}.`);
    assert(snapshot.audioContexts === 1 && snapshot.mediaStreamSources === 1
      && snapshot.knownStreamSources === 1 && snapshot.workletNodes === 1,
    `Expected one AudioContext/source/worklet graph over the retained stream: ${JSON.stringify({
      audioContexts: snapshot.audioContexts,
      mediaStreamSources: snapshot.mediaStreamSources,
      knownStreamSources: snapshot.knownStreamSources,
      workletNodes: snapshot.workletNodes,
    })}`);
    assert(snapshot.trackInitialStates.length === 1
      && snapshot.trackInitialStates[0].enabled === true
      && snapshot.trackEnabledWrites.length === 0
      && snapshot.trackStopCalls.length === 0,
    `Voice Draw disabled or stopped the retained track: ${JSON.stringify({
      initial: snapshot.trackInitialStates,
      enabledWrites: snapshot.trackEnabledWrites,
      stops: snapshot.trackStopCalls,
    })}`);
    const workletPaths = [...new Set(snapshot.workletModuleUrls.map((url) => new URL(url).pathname))];
    assert(workletPaths.length === 1
      && /^\/assets\/pitch-capture-worklet-[A-Za-z0-9_-]+\.js$/u.test(workletPaths[0]),
    `Voice Draw did not use exactly one content-hashed production worklet: ${JSON.stringify(workletPaths)}`);
    assert(workletFrames.length === snapshot.workletSampleMessages && workletFrames.length > 250,
      `Worklet sample evidence was absent or truncated: ${workletFrames.length}/${snapshot.workletSampleMessages}.`);
    assert(workletByKey.size === workletFrames.length,
      "Voice Draw worklet evidence contained duplicate sample identities.");

    const firstPublishedFrame = frames[0];
    const lastPublishedFrame = frames.at(-1);
    assert(firstPublishedFrame && lastPublishedFrame,
      "Voice Draw published no authoritative runtime state.");
    const publishedAuthoritySeconds = (
      lastPublishedFrame.observedFrameCount - firstPublishedFrame.observedFrameCount
    ) * HOP_SAMPLES / SAMPLE_RATE;
    const maximumPublishedFrames = Math.ceil(publishedAuthoritySeconds * 30) + 1;
    const minimumPublishedFrames = Math.max(100, Math.floor(publishedAuthoritySeconds * 10));
    assert(frames.length >= minimumPublishedFrames
      && frames.length <= maximumPublishedFrames,
    `Voice Draw publication was not a bounded, live projection of authoritative input: ${frames.length} snapshots across ${publishedAuthoritySeconds.toFixed(3)} sample-seconds (expected ${minimumPublishedFrames}-${maximumPublishedFrames}).`);
    assert(lastPublishedFrame.observedFrameCount === workletFrames.length,
      `Voice Draw runtime consumed ${lastPublishedFrame.observedFrameCount} of ${workletFrames.length} authoritative worklet observations.`);
    const authorityFailures = [];
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      const previous = frames[index - 1];
      const workletFrame = workletByKey.get(frameKey(frame));
      const workletOrdinal = workletOrdinalByKey.get(frameKey(frame));
      if (!workletFrame
        || workletFrame.sampleCount !== WINDOW_SAMPLES
        || workletFrame.processedSampleCount !== frame.endSample
        || frame.observedFrameCount !== workletOrdinal) {
        authorityFailures.push(
          `${frameKey(frame)} missing/mismatched worklet authority or runtime count ${frame.observedFrameCount}/${String(workletOrdinal)}`,
        );
      }
      if (previous && (
        frame.captureEpoch < previous.captureEpoch
        || (frame.captureEpoch === previous.captureEpoch && frame.endSample <= previous.endSample)
        || frame.observedFrameCount <= previous.observedFrameCount
      )) {
        authorityFailures.push(`${frameKey(previous)} -> ${frameKey(frame)} moved backward`);
      }
    }
    assert(authorityFailures.length === 0,
      `Voice Draw sample authority was not monotonic from worklet to SVG: ${JSON.stringify(authorityFailures)}`);

    const activeRuns = contiguousRuns(frames, (frame) => frame.activeMidi !== null);
    const activeCommands = activeRuns.map((run) => ({
      midi: run[0].activeMidi,
      direction: run[0].activeDirection,
      frames: run,
    }));
    assert(activeCommands.length === EXPECTED_COMMANDS.length
      && EXPECTED_COMMANDS.every((expected, index) =>
        activeCommands[index]?.midi === expected.midi
          && activeCommands[index]?.direction === expected.direction),
    `Rendered command order was wrong: ${JSON.stringify(activeCommands.map(({ midi, direction }) => ({ midi, direction })))}`);

    const motionProof = activeCommands.map((command, index) => {
      const expected = EXPECTED_COMMANDS[index];
      const first = command.frames[0];
      const last = command.frames.at(-1);
      const deltaX = last.cursorX - first.cursorX;
      const deltaY = last.cursorY - first.cursorY;
      const materialDistance = Math.hypot(deltaX, deltaY);
      assert(materialDistance >= 0.14,
        `${expected.direction} moved only ${materialDistance.toFixed(4)} normalized units.`);
      assert(expected.dx === 0 ? Math.abs(deltaX) <= 1e-9 : Math.sign(deltaX) === expected.dx,
        `${expected.direction} had wrong horizontal motion ${deltaX}.`);
      assert(expected.dy === 0 ? Math.abs(deltaY) <= 1e-9 : Math.sign(deltaY) === expected.dy,
        `${expected.direction} had wrong vertical motion ${deltaY}.`);
      for (const frame of command.frames) {
        const detector = diagnosticByKey.get(frameKey(frame));
        assert(detector?.observationKind === "voiced"
          && detector.voiced === true
          && detector.nearestMidi === expected.midi,
        `Rendered ${expected.midi}:${expected.direction} lacked its exact production detector frame at ${frameKey(frame)}: `
          + `${JSON.stringify(detector ? {
            observationKind: detector.observationKind,
            voiced: detector.voiced,
            nearestMidi: detector.nearestMidi,
            midiFloat: detector.midiFloat,
            centsFromNearest: detector.centsFromNearest,
            frequencyHz: detector.frequencyHz,
            confidence: detector.confidence,
            periodicity: detector.periodicity,
            reason: detector.reason,
            startSample: detector.startSample,
            endSample: detector.endSample,
            fixture: fixtureRelation(detector),
          } : null)}.`);
      }
      return { midi: expected.midi, direction: expected.direction, deltaX, deltaY, materialDistance };
    });

    const segmentEvents = frames.flatMap((frame, index) => {
      const previousCount = frames[index - 1]?.segmentCount ?? 0;
      if (frame.segmentCount <= previousCount) return [];
      const detector = diagnosticByKey.get(frameKey(frame));
      return [{
        previousCount,
        segmentCount: frame.segmentCount,
        activeMidi: frame.activeMidi,
        activeDirection: frame.activeDirection,
        detector: detector ? {
          observationKind: detector.observationKind,
          voiced: detector.voiced,
          nearestMidi: detector.nearestMidi,
          midiFloat: detector.midiFloat,
          centsFromNearest: detector.centsFromNearest,
          frequencyHz: detector.frequencyHz,
          confidence: detector.confidence,
          periodicity: detector.periodicity,
          reason: detector.reason,
          startSample: detector.startSample,
          endSample: detector.endSample,
          fixture: fixtureRelation(detector),
        } : null,
      }];
    });

    const silentRuns = contiguousRuns(frames, (frame) =>
      frame.activeMidi === null && frame.activeDirection === null)
      .filter((run) => run.length >= 8);
    for (const expectedSegmentCount of [0, 1, 2, 3, 4]) {
      const run = silentRuns.find((candidate) =>
        candidate.length >= 8
          && candidate.every((frame) => frame.segmentCount === expectedSegmentCount));
      assert(run,
        `No sustained silence run followed engine segment count ${expectedSegmentCount}. `
          + `Observed runs: ${JSON.stringify(silentRuns.map((candidate) => ({
            frames: candidate.length,
            startSample: candidate[0]?.endSample,
            endSample: candidate.at(-1)?.endSample,
            segmentCounts: [...new Set(candidate.map((frame) => frame.segmentCount))],
            phases: [...new Set(candidate.map((frame) => frame.drawPhase))],
          })))}. Segment events: ${JSON.stringify(segmentEvents)}. `
          + `Final frame: ${JSON.stringify(frames.at(-1))}.`);
      const anchor = run[0];
      assert(run.at(-1).endSample > anchor.endSample
        && run.every((frame) => frame.cursorX === anchor.cursorX
          && frame.cursorY === anchor.cursorY
          && frame.segmentCount === anchor.segmentCount),
      `Cursor or artwork moved during silence after segment ${expectedSegmentCount}: ${JSON.stringify(run)}`);
    }

    const finalFrame = frames.at(-1);
    assert(finalFrame.segmentCount === 4 && finalFrame.paths.length === 4,
      `Expected four coalesced strokes; engine/SVG reported ${finalFrame.segmentCount}/${finalFrame.paths.length}.`);
    const strokes = finalFrame.paths.map(coordinatesFromPath);
    for (let index = 0; index < strokes.length; index += 1) {
      const stroke = strokes[index];
      const expected = EXPECTED_COMMANDS[index];
      const deltaX = stroke.to.x - stroke.from.x;
      const deltaY = stroke.to.y - stroke.from.y;
      assert(pointDistance(stroke.from, stroke.to) >= 140,
        `${expected.direction} SVG stroke was not material: ${JSON.stringify(stroke)}`);
      assert(expected.dx === 0 ? Math.abs(deltaX) <= 0.01 : Math.sign(deltaX) === expected.dx,
        `${expected.direction} SVG stroke had wrong horizontal sign: ${JSON.stringify(stroke)}`);
      assert(expected.dy === 0 ? Math.abs(deltaY) <= 0.01 : Math.sign(deltaY) === expected.dy,
        `${expected.direction} SVG stroke had wrong vertical sign: ${JSON.stringify(stroke)}`);
      if (index > 0) {
        assert(pointDistance(strokes[index - 1].to, stroke.from) <= 0.01,
          `Voice strokes disconnected between ${index} and ${index + 1}.`);
      }
    }
    const closureDistance = pointDistance(strokes[0].from, strokes.at(-1).to);
    const verticalMismatch = Math.abs(
      pointDistance(strokes[0].from, strokes[0].to)
        - pointDistance(strokes[2].from, strokes[2].to),
    );
    const horizontalMismatch = Math.abs(
      pointDistance(strokes[1].from, strokes[1].to)
        - pointDistance(strokes[3].from, strokes[3].to),
    );
    assert(closureDistance <= 70 && verticalMismatch <= 70 && horizontalMismatch <= 70,
      `Four voice strokes did not form an approximate closed square: closure=${closureDistance.toFixed(2)}, vertical mismatch=${verticalMismatch.toFixed(2)}, horizontal mismatch=${horizontalMismatch.toFixed(2)}.`);
    assert(browserErrors.length === 0,
      `Chromium reported browser errors: ${JSON.stringify(browserErrors)}`);

    const firstFrame = frames[0];
    console.log("Voice Draw production browser proof passed.");
    console.log(`  authority: 1 stream · 1 track · 1 source · 1 worklet · ${workletFrames.length} PCM windows`);
    console.log(`  draw frames: ${frames.length} bounded DOM projections of ${finalFrame.observedFrameCount} exactly consumed observations · endSample ${firstFrame.endSample}->${finalFrame.endSample} · ${silentRuns.length} sustained stationary silence runs`);
    console.log(`  commands: ${motionProof.map(({ midi, direction, materialDistance }) => `${midi}:${direction} ${materialDistance.toFixed(3)}`).join(" · ")}`);
    console.log(`  SVG: 4 coalesced strokes · closure ${closureDistance.toFixed(1)} px · opposite mismatch V${verticalMismatch.toFixed(1)}/H${horizontalMismatch.toFixed(1)} px`);
    console.log(`  cursor: (${strokes[0].from.x.toFixed(1)}, ${strokes[0].from.y.toFixed(1)}) -> (${strokes.at(-1).to.x.toFixed(1)}, ${strokes.at(-1).to.y.toFixed(1)})`);
  } catch (error) {
    const details = [
      error instanceof Error ? error.stack || error.message : String(error),
      ...previewOutput,
      ...chromiumOutput,
    ].join("\n");
    throw new Error(details);
  } finally {
    session?.close();
    await stopProcessGroup(chromium);
    await stopProcessGroup(preview);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
