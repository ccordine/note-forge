import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";
const SAMPLE_RATE = 48_000;
const CHANNEL_COUNT = 1;
const BITS_PER_SAMPLE = 16;
const CAPTURE_WINDOW_SAMPLES = 4_096;
const CAPTURE_HOP_SAMPLES = 960;
const CAPTURE_HOP_BUDGET_MS = CAPTURE_HOP_SAMPLES / SAMPLE_RATE * 1_000;
const SUPPORTED_MIN_FREQUENCY_HZ = 45;
const SUPPORTED_MAX_FREQUENCY_HZ = 1_200;
const LOWEST_SUPPORTED_MIDI = 30;
const HIGHEST_SUPPORTED_MIDI = 86;
const NORMAL_RMS_DBFS = -24;
const QUIET_RMS_DBFS = -60;
const NOISE_RMS_DBFS = -24;
const OLD_GATE_RMS_DBFS = -42;
const OLD_GATE_RMS_AMPLITUDE = 10 ** (OLD_GATE_RMS_DBFS / 20);
const FULL_RANGE_SEGMENT_SECONDS = 0.3;
const QUIET_LOW_SEGMENT_SECONDS = 0.4;
const OPENING_SEGMENT_SECONDS = 1.25;
const IMMEDIATE_CHANGE_SEGMENT_SECONDS = 0.7;
const IMMEDIATE_CHANGE_MIDIS = [48, 52, 55];
const IMMEDIATE_CHANGE_SEGMENT_SAMPLES = Math.round(
  SAMPLE_RATE * IMMEDIATE_CHANGE_SEGMENT_SECONDS,
);

const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

function noteLabel(midi) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

const EXPECTED_NOTES = Array.from(
  { length: HIGHEST_SUPPORTED_MIDI - LOWEST_SUPPORTED_MIDI + 1 },
  (_unused, index) => {
    const midi = LOWEST_SUPPORTED_MIDI + index;
    return { midi, label: noteLabel(midi) };
  },
);
const QUIET_LOW_NOTES = EXPECTED_NOTES.filter(({ midi }) => midi <= 47);
const EXPECTED_MIDIS = new Set(EXPECTED_NOTES.map(({ midi }) => midi));
const EXPECTED_LABELS = new Set(EXPECTED_NOTES.map(({ label }) => label));
const QUIET_LOW_MIDIS = new Set(QUIET_LOW_NOTES.map(({ midi }) => midi));
const QUIET_LOW_LABELS = new Set(QUIET_LOW_NOTES.map(({ label }) => label));

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function generatedMicrophoneWav() {
  const segments = [
    // A stable opening note gives the real Pitch Mirror prompt time to run.
    { midi: LOWEST_SUPPORTED_MIDI, durationSeconds: OPENING_SEGMENT_SECONDS, rmsDbfs: NORMAL_RMS_DBFS },
    // Each change is correlated by exact production endSample with the first
    // detector frame and the DOM mutation that rendered it. Long stable tones
    // make this an admission-delay proof without asking one 85 ms window to
    // identify physically incompatible one-hop-duration notes.
    ...IMMEDIATE_CHANGE_MIDIS.map((midi) => ({
      midi,
      durationSeconds: IMMEDIATE_CHANGE_SEGMENT_SECONDS,
      rmsDbfs: NORMAL_RMS_DBFS,
    })),
    // Every semitone fully enclosed by the production 45-1200 Hz profile.
    ...EXPECTED_NOTES.map(({ midi }) => ({
      midi,
      durationSeconds: FULL_RANGE_SEGMENT_SECONDS,
      rmsDbfs: NORMAL_RMS_DBFS,
      dominantSecond: midi <= 47,
    })),
    // The configured detector boundaries are not tempered semitones, so they
    // get literal frequency segments in addition to the enclosed MIDI sweep.
    { frequencyHz: SUPPORTED_MIN_FREQUENCY_HZ, durationSeconds: 0.45, rmsDbfs: NORMAL_RMS_DBFS },
    { frequencyHz: SUPPORTED_MAX_FREQUENCY_HZ, durationSeconds: 0.45, rmsDbfs: NORMAL_RMS_DBFS },
    // A known voiced bridge is long enough to visit a view with no microphone
    // consumer without sacrificing either measured sweep.
    { midi: 60, durationSeconds: 4.2, rmsDbfs: NORMAL_RMS_DBFS },
    // Repeat the complete low register quietly to reproduce the historical
    // meter-moving/no-note failure through Chromium's actual capture path.
    ...QUIET_LOW_NOTES.map(({ midi }) => ({
      midi,
      durationSeconds: QUIET_LOW_SEGMENT_SECONDS,
      rmsDbfs: QUIET_RMS_DBFS,
      dominantSecond: true,
    })),
    { midi: 60, durationSeconds: 1.2, rmsDbfs: QUIET_RMS_DBFS },
    // Browser-path negative controls: the live meter must distinguish real
    // silence and loud non-periodic evidence without manufacturing a note.
    { kind: "silence", durationSeconds: 1.2, rmsDbfs: Number.NEGATIVE_INFINITY },
    // Leave ample non-periodic tail for the deterministic AudioContext
    // suspend/resume exercise so Chromium never loops back to the first note.
    { kind: "noise", durationSeconds: 10, rmsDbfs: NOISE_RMS_DBFS, noiseSeed: 0x4e_4f_49_53 },
  ];
  const segmentSampleCounts = segments.map(({ durationSeconds }) =>
    Math.round(SAMPLE_RATE * durationSeconds));
  const sampleCount = segmentSampleCounts.reduce((sum, count) => sum + count, 0);
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataByteLength = sampleCount * CHANNEL_COUNT * bytesPerSample;
  const wav = Buffer.alloc(44 + dataByteLength);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataByteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(CHANNEL_COUNT, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * CHANNEL_COUNT * bytesPerSample, 28);
  wav.writeUInt16LE(CHANNEL_COUNT * bytesPerSample, 32);
  wav.writeUInt16LE(BITS_PER_SAMPLE, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataByteLength, 40);

  const edgeSamples = Math.round(SAMPLE_RATE * 0.008);
  const harmonicPhases = [0.1, 0.7, 1.3, 2.1];
  let outputSample = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const segmentSamples = segmentSampleCounts[segmentIndex];
    const frequency = segment.kind ? null : segment.frequencyHz ?? midiToFrequency(segment.midi);
    const targetRms = segment.kind === "silence" ? 0 : 10 ** (segment.rmsDbfs / 20);
    const harmonicWeights = segment.dominantSecond
      ? [segment.midi % 2 === 0 ? 0.08 : 0.2, 1, 0.24, 0.12]
      : [1, 0.35, 0.173333];
    const unitRms = Math.sqrt(
      harmonicWeights.reduce((sum, weight) => sum + weight ** 2, 0) / 2,
    );
    const amplitudeScale = targetRms / unitRms;
    let noiseState = segment.noiseSeed ?? 0;
    for (let segmentSample = 0; segmentSample < segmentSamples; segmentSample += 1) {
      const time = segmentSample / SAMPLE_RATE;
      const edgeGain = Math.min(
        1,
        segmentSample / edgeSamples,
        (segmentSamples - 1 - segmentSample) / edgeSamples,
      );
      let value = 0;
      if (segment.kind === "noise") {
        noiseState = (Math.imul(noiseState, 1_664_525) + 1_013_904_223) >>> 0;
        const uniformNoise = noiseState / 0x1_0000_0000 * 2 - 1;
        value = uniformNoise * Math.sqrt(3) * targetRms * edgeGain;
      } else if (segment.kind !== "silence") {
        const harmonicSignal = harmonicWeights.reduce((sum, weight, harmonicIndex) =>
          sum + weight * Math.sin(
            2 * Math.PI * frequency * (harmonicIndex + 1) * time + harmonicPhases[harmonicIndex],
          ), 0);
        value = harmonicSignal * amplitudeScale * edgeGain;
      }
      value = Math.max(-1, Math.min(1, value));
      wav.writeInt16LE(Math.round(value * 0x7fff), 44 + outputSample * bytesPerSample);
      outputSample += 1;
    }
  }

  return wav;
}

async function availablePort() {
  const server = createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object", "Could not reserve a local test port.");
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

async function waitForHttp(url, child, timeoutMilliseconds, output) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Process exited before ${url} became ready.\n${output.join("\n")}`);
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
    if (this.socket.readyState === WebSocket.OPEN) return;
    await Promise.race([
      new Promise((resolveConnection, rejectConnection) => {
        this.socket.addEventListener("open", resolveConnection, { once: true });
        this.socket.addEventListener("error", rejectConnection, { once: true });
      }),
      delay(5_000).then(() => { throw new Error("Timed out connecting to Chromium DevTools."); }),
    ]);
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
      try { listener(message.params ?? {}); } catch { /* a proof assertion handles collected data later */ }
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
    await delay(100);
  }
  const body = await evaluate(session, "document.body?.innerText?.slice(0, 4000) || ''");
  throw new Error(`Timed out waiting for ${description}.\nRendered page:\n${body}`);
}

async function renderedNoteSample(session) {
  return evaluate(session, `(() => {
    const scope = document.querySelector('.input-scope');
    const pitch = document.querySelector('[data-detected-note]');
    const meter = scope?.querySelector('[role="meter"]');
    const diagnosis = scope?.querySelector('.scope-diagnosis b');
    const frequency = [...(pitch?.querySelectorAll('span') || [])]
      .find((element) => element.textContent?.includes('Hz'));
    return {
      note: pitch?.getAttribute('data-detected-note') || null,
      frequency: frequency?.textContent?.trim() || null,
      scopeState: scope?.className || null,
      inputState: scope?.getAttribute('data-input-state') || null,
      meterDbfs: meter?.getAttribute('aria-valuenow') == null
        ? null
        : Number(meter.getAttribute('aria-valuenow')),
      diagnosis: diagnosis?.textContent?.trim() || null,
      frameCount: Number(scope?.getAttribute('data-frame-count') || 0),
      frameTime: Number(scope?.getAttribute('data-frame-time') || 0),
      endSample: Number(scope?.getAttribute('data-end-sample') || 0),
      captureEpoch: Number(scope?.getAttribute('data-capture-epoch') || 0),
      continuityEpoch: Number(scope?.getAttribute('data-continuity-epoch') || 0),
      graphGeneration: Number(scope?.getAttribute('data-graph-generation') || 0),
      hash: location.hash,
      at: performance.now(),
    };
  })()`);
}

async function collectRenderedNotes(session, durationMilliseconds) {
  const samples = [];
  const deadline = Date.now() + durationMilliseconds;
  while (Date.now() < deadline) {
    samples.push(await renderedNoteSample(session));
    await delay(80);
  }
  return samples;
}

function pitchFramesFrom(requests) {
  return requests.flatMap((batch) => batch.events ?? [])
    .filter((event) => event.kind === "pitch-frame");
}

async function browserProofSnapshot(session) {
  return evaluate(session, `(() => {
    const control = window.__noteforgeNoteInputProof;
    return typeof control?.snapshot === 'function' ? control.snapshot() : null;
  })()`);
}

async function waitForDiagnosticCount(diagnosticBatches, expectedCount, timeoutMilliseconds = 6_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const count = pitchFramesFrom(diagnosticBatches).length;
    if (count === expectedCount) return count;
    if (count > expectedCount) {
      throw new Error(`Production emitted ${count} detector frames for ${expectedCount} worklet sample messages.`);
    }
    await delay(100);
  }
  return pitchFramesFrom(diagnosticBatches).length;
}

function uniqueExpectedRenderedNotes(samples) {
  return [...new Set(samples
    .map((sample) => sample.note)
    .filter((note) => EXPECTED_LABELS.has(note)))];
}

function expectedRenderedTransitions(samples) {
  const transitions = [];
  for (const note of samples.map((sample) => sample.note)) {
    if (!EXPECTED_LABELS.has(note) || transitions.at(-1) === note) continue;
    transitions.push(note);
  }
  return transitions;
}

function includesContiguousSequence(values, expected) {
  return values.some((_value, start) =>
    expected.every((expectedValue, offset) => values[start + offset] === expectedValue));
}

function includesOrderedSequence(values, expected) {
  let expectedIndex = 0;
  for (const value of values) {
    if (value === expected[expectedIndex]) expectedIndex += 1;
    if (expectedIndex === expected.length) return true;
  }
  return expected.length === 0;
}

function missingValues(expected, actual) {
  return [...expected].filter((value) => !actual.has(value));
}

function amplitudeToDbfs(amplitude) {
  return 20 * Math.log10(Math.max(amplitude, 1e-12));
}

function longestMatchingRun(samples, predicate) {
  let longest = 0;
  let current = 0;
  for (const sample of samples) {
    if (predicate(sample)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function maximumElapsedGap(frames) {
  let maximum = 0;
  for (let index = 1; index < frames.length; index += 1) {
    maximum = Math.max(maximum, frames[index].elapsedMs - frames[index - 1].elapsedMs);
  }
  return maximum;
}

function canonicalFrameKey(frame) {
  return `${frame.captureEpoch}:${frame.endSample}`;
}

function orderedPitchEvents(requests) {
  return [...pitchFramesFrom(requests)].sort((left, right) => {
    const leftFrame = left.pitch?.frame;
    const rightFrame = right.pitch?.frame;
    return (leftFrame?.captureEpoch ?? -1) - (rightFrame?.captureEpoch ?? -1)
      || (leftFrame?.endSample ?? -1) - (rightFrame?.endSample ?? -1);
  });
}

function lastWorkletSample(snapshot) {
  return snapshot.workletSampleEvents.at(-1) ?? null;
}

function renderedFrameContinuity(samples, label) {
  const withFrames = samples.filter((sample) =>
    Number.isFinite(sample.frameCount) && sample.frameCount > 0
      && Number.isFinite(sample.frameTime) && sample.frameTime > 0);
  assert(withFrames.length > 1, `${label} exposed no advancing production frame metadata.`);
  let maximumAdvanceGapMilliseconds = 0;
  let lastAdvanceAt = withFrames[0].at;
  for (let index = 1; index < withFrames.length; index += 1) {
    const previous = withFrames[index - 1];
    const current = withFrames[index];
    assert(current.frameCount >= previous.frameCount,
      `${label} frame count moved backward from ${previous.frameCount} to ${current.frameCount}.`);
    assert(current.frameTime >= previous.frameTime,
      `${label} detector timestamp moved backward from ${previous.frameTime} to ${current.frameTime}.`);
    if (current.frameCount > previous.frameCount) {
      maximumAdvanceGapMilliseconds = Math.max(maximumAdvanceGapMilliseconds, current.at - lastAdvanceAt);
      lastAdvanceAt = current.at;
    }
  }
  return {
    firstCount: withFrames[0].frameCount,
    lastCount: withFrames.at(-1).frameCount,
    firstTime: withFrames[0].frameTime,
    lastTime: withFrames.at(-1).frameTime,
    maximumAdvanceGapMilliseconds,
  };
}

async function main() {
  let temporaryDirectory;
  let vite;
  let chromium;
  let session;
  let viteOutput = [];
  let chromiumOutput = [];

  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-note-input-proof-"));
    const wavPath = join(temporaryDirectory, "changing-notes.wav");
    const chromiumProfile = join(temporaryDirectory, "chromium-profile");
    const vitePort = await availablePort();
    const debugPort = await availablePort();
    const pageUrl = `http://127.0.0.1:${vitePort}/#mirror`;
    await writeFile(wavPath, generatedMicrophoneWav());

    vite = spawn(process.execPath, [
      join(REPOSITORY_ROOT, "node_modules/vite/bin/vite.js"),
      "preview",
      "--config", join(REPOSITORY_ROOT, "vite.config.ts"),
      "--host", "127.0.0.1",
      "--port", String(vitePort),
      "--strictPort",
    ], {
      cwd: REPOSITORY_ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    viteOutput = captureProcessOutput(vite, "vite-preview");
    await waitForHttp(`http://127.0.0.1:${vitePort}/`, vite, 12_000, viteOutput);

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
    const consoleErrors = [];
    session.on("Network.requestWillBeSent", ({ request }) => {
      if (!request?.url?.includes("/api/diagnostics/pitch") || !request.postData) return;
      try { diagnosticBatches.push(JSON.parse(request.postData)); } catch { /* malformed data fails counts below */ }
    });
    session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      consoleErrors.push(exceptionDetails?.exception?.description || exceptionDetails?.text || "browser exception");
    });
    session.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type !== "error") return;
      consoleErrors.push(args?.map((argument) => argument.value ?? argument.description).join(" ") || "console error");
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
          audioContexts: 0,
          audioContextStateEvents: [],
          audioContextSuspendRequests: 0,
          audioContextSuspendRequestedAt: null,
          workletModuleUrls: [],
          workletNodes: 0,
          workletSampleMessages: 0,
          workletLevelMessages: 0,
          workletSampleEvents: [],
          domFrameMutations: [],
          trackInitialStates: [],
          trackEnabledWrites: [],
          trackStopCalls: [],
          stopOnNextSample: false,
          explicitStopRequestedAt: null,
          explicitStopSampleMessageCount: null,
          stopButtonClicks: 0,
          stopButtonMissing: false,
          instrumentationErrors: [],
        };
        let capturedAudioContext = null;
        const proofControl = Object.freeze({
          snapshot: () => JSON.parse(JSON.stringify(proof)),
          suspendCapturedAudioContext: async () => {
            if (!capturedAudioContext) return { suspended: false, state: null };
            proof.audioContextSuspendRequests += 1;
            proof.audioContextSuspendRequestedAt = performance.now();
            await capturedAudioContext.suspend();
            return { suspended: true, state: capturedAudioContext.state };
          },
          armStopOnNextSample: () => {
            proof.stopOnNextSample = true;
            return true;
          },
        });
        Object.defineProperty(window, '__noteforgeNoteInputProof', {
          configurable: false,
          enumerable: false,
          writable: false,
          value: proofControl,
        });
        const NativeAudioContext = window.AudioContext;
        if (typeof NativeAudioContext !== 'function') {
          proof.instrumentationErrors.push('AudioContext unavailable');
        } else {
          try {
            window.AudioContext = new Proxy(NativeAudioContext, {
              construct(target, args) {
                const context = Reflect.construct(target, args, target);
                capturedAudioContext = context;
                proof.audioContexts += 1;
                proof.audioContextStateEvents.push({
                  at: performance.now(),
                  state: context.state,
                });
                context.addEventListener('statechange', () => {
                  proof.audioContextStateEvents.push({
                    at: performance.now(),
                    state: context.state,
                  });
                });
                return context;
              },
            });
          } catch (error) {
            proof.instrumentationErrors.push('AudioContext instrumentation: ' + String(error));
          }
        }
        const audioWorkletPrototype = window.AudioWorklet?.prototype;
        const nativeAddModule = audioWorkletPrototype?.addModule;
        if (typeof nativeAddModule !== 'function') {
          proof.instrumentationErrors.push('AudioWorklet.addModule unavailable');
        } else {
          try {
            Object.defineProperty(audioWorkletPrototype, 'addModule', {
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
                  if (event.data?.type === 'level') {
                    proof.workletLevelMessages += 1;
                    return;
                  }
                  if (event.data?.type !== 'samples') return;
                  proof.workletSampleMessages += 1;
                  proof.workletSampleEvents.push({
                    at: performance.now(),
                    capturedAt: event.data.capturedAt,
                    sampleCount: event.data.samples?.length ?? null,
                    startSample: event.data.startSample,
                    endSample: event.data.endSample,
                    captureEpoch: event.data.captureEpoch,
                    continuityEpoch: event.data.continuityEpoch,
                    graphGeneration: event.data.graphGeneration,
                    processCount: event.data.processCount,
                    processedSampleCount: event.data.processedSampleCount,
                    discontinuity: event.data.discontinuity,
                  });
                  if (proof.workletSampleEvents.length > 8192) proof.workletSampleEvents.shift();
                  if (proof.stopOnNextSample && proof.explicitStopRequestedAt === null) {
                    proof.explicitStopRequestedAt = performance.now();
                    // A zero-delay task runs after the entire MessagePort event
                    // dispatch, including production's port.onmessage handler.
                    // A microtask here can run between listeners in Chromium and
                    // create a one-frame stop-boundary race.
                    setTimeout(() => {
                      const button = [...document.querySelectorAll('button')]
                        .find((candidate) => candidate.textContent?.trim() === 'Stop input');
                      if (!button) {
                        proof.stopButtonMissing = true;
                        return;
                      }
                      // Establish the boundary synchronously with the actual
                      // user control. Messages queued before this task are
                      // pre-Stop evidence; none may arrive after button.click().
                      proof.explicitStopSampleMessageCount = proof.workletSampleMessages;
                      proof.stopButtonClicks += 1;
                      button.click();
                    }, 0);
                  }
                });
                return node;
              },
            });
          } catch (error) {
            proof.instrumentationErrors.push('AudioWorkletNode instrumentation: ' + String(error));
          }
        }
        const recordRenderedFrame = () => {
          const scope = document.querySelector('[data-note-input]');
          const pitch = document.querySelector('[data-detected-note]');
          const rawEndSample = scope?.getAttribute('data-end-sample');
          const rawHeldSamples = scope?.getAttribute('data-held-samples');
          const rawHeldSeconds = scope?.getAttribute('data-held-seconds');
          if (!scope || !pitch || rawEndSample === null || rawEndSample === '') return;
          const observation = {
            at: performance.now(),
            note: pitch.getAttribute('data-detected-note') || null,
            frameCount: Number(scope.getAttribute('data-frame-count')),
            endSample: Number(rawEndSample),
            captureEpoch: Number(scope.getAttribute('data-capture-epoch')),
            continuityEpoch: Number(scope.getAttribute('data-continuity-epoch')),
            graphGeneration: Number(scope.getAttribute('data-graph-generation')),
            heldSamples: rawHeldSamples === null || rawHeldSamples === ''
              ? null
              : Number(rawHeldSamples),
            heldSeconds: rawHeldSeconds === null || rawHeldSeconds === ''
              ? null
              : Number(rawHeldSeconds),
            inputState: scope.getAttribute('data-input-state'),
            hash: location.hash,
          };
          if (!Number.isSafeInteger(observation.endSample) || observation.endSample < 0) return;
          const previous = proof.domFrameMutations.at(-1);
          if (previous
            && previous.endSample === observation.endSample
            && previous.note === observation.note
            && previous.hash === observation.hash) return;
          proof.domFrameMutations.push(observation);
          if (proof.domFrameMutations.length > 8192) proof.domFrameMutations.shift();
        };
        const renderedFrameObserver = new MutationObserver(recordRenderedFrame);
        renderedFrameObserver.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: [
            'data-detected-note',
            'data-frame-count',
            'data-end-sample',
            'data-capture-epoch',
            'data-continuity-epoch',
            'data-graph-generation',
            'data-held-samples',
            'data-held-seconds',
            'data-input-state',
          ],
        });
        const devices = navigator.mediaDevices;
        if (!devices?.getUserMedia) {
          proof.instrumentationErrors.push('navigator.mediaDevices.getUserMedia unavailable');
          return;
        }
        const originalGetUserMedia = devices.getUserMedia.bind(devices);
        const instrumentTrack = (track) => {
          proof.tracks += 1;
          proof.trackInitialStates.push({
            at: performance.now(),
            enabled: track.enabled,
            kind: track.kind,
            readyState: track.readyState,
          });
          let prototype = track;
          let enabledDescriptor;
          while (prototype && !enabledDescriptor) {
            prototype = Object.getPrototypeOf(prototype);
            enabledDescriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'enabled');
          }
          if (enabledDescriptor?.get && enabledDescriptor?.set) {
            try {
              Object.defineProperty(track, 'enabled', {
                configurable: true,
                enumerable: enabledDescriptor.enumerable,
                get() { return enabledDescriptor.get.call(track); },
                set(value) {
                  proof.trackEnabledWrites.push({
                    at: performance.now(),
                    value: Boolean(value),
                    kind: track.kind,
                    readyState: track.readyState,
                  });
                  return enabledDescriptor.set.call(track, value);
                },
              });
            } catch (error) {
              proof.instrumentationErrors.push('enabled instrumentation: ' + String(error));
            }
          } else {
            proof.instrumentationErrors.push('MediaStreamTrack.enabled descriptor unavailable');
          }
          const originalStop = track.stop.bind(track);
          try {
            Object.defineProperty(track, 'stop', {
              configurable: true,
              value() {
                proof.trackStopCalls.push({ at: performance.now(), kind: track.kind, readyState: track.readyState });
                return originalStop();
              },
            });
          } catch (error) {
            proof.instrumentationErrors.push('stop instrumentation: ' + String(error));
          }
        };
        try {
          Object.defineProperty(devices, 'getUserMedia', {
            configurable: true,
            value: async (...args) => {
              proof.getUserMediaCalls += 1;
              const stream = await originalGetUserMedia(...args);
              proof.streams += 1;
              stream.getAudioTracks().forEach(instrumentTrack);
              return stream;
            },
          });
        } catch (error) {
          proof.instrumentationErrors.push('getUserMedia instrumentation: ' + String(error));
        }
      })();`,
    });

    await session.send("Page.navigate", { url: pageUrl });
    await waitForBrowser(
      session,
      "document.readyState === 'complete' && [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Enable input'))",
      "the Pitch Mirror input controls",
    );
    const loadedEntryScripts = await evaluate(session, `[
      ...document.querySelectorAll('script[src]'),
    ].map((script) => new URL(script.src, location.href).pathname)`);
    assert(
      loadedEntryScripts.some((path) => /^\/assets\/index-[A-Za-z0-9_-]+\.js$/u.test(path)),
      `The browser did not load a hashed production entry bundle: ${JSON.stringify(loadedEntryScripts)}`,
    );
    assert(
      loadedEntryScripts.every((path) => !path.includes('/@vite/') && !path.includes('/src/')),
      `The browser loaded a Vite development/source module: ${JSON.stringify(loadedEntryScripts)}`,
    );
    const clicked = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Enable input');
      button?.click();
      return Boolean(button);
    })()`);
    assert(clicked, "The real Enable input control was not clickable.");
    await waitForBrowser(
      session,
      "document.querySelector('.input-scope.running') && Boolean(document.querySelector('[data-detected-note]')?.getAttribute('data-detected-note'))",
      "a rendered Pitch Mirror note from fake microphone PCM",
      12_000,
    );

    const delayedModeClicked = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Delayed');
      button?.click();
      return Boolean(button);
    })()`);
    assert(delayedModeClicked, "Pitch Mirror's real Delayed mode control was not clickable.");
    await waitForBrowser(
      session,
      "document.querySelector('.pitch-mirror-page h1')?.textContent?.includes('Hold the sound')",
      "Pitch Mirror Delayed mode",
    );
    const attemptClicked = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Begin attempt');
      button?.click();
      return Boolean(button);
    })()`);
    assert(attemptClicked, "Pitch Mirror's real Begin attempt control was not clickable.");
    await waitForBrowser(
      session,
      "document.querySelector('.mirror-stage.active .stage-status > span')?.textContent?.trim() === 'LISTEN'",
      "Pitch Mirror's active LISTEN prompt",
    );
    await waitForBrowser(
      session,
      "Number(document.querySelector('[data-note-input]')?.getAttribute('data-frame-count')) >= 2 && Boolean(document.querySelector('[data-detected-note]')?.getAttribute('data-detected-note'))",
      "post-clear detector frames during the Pitch Mirror prompt",
    );
    const promptStartProof = await browserProofSnapshot(session);
    const promptSamples = await collectRenderedNotes(session, 800);
    const promptEndProof = await browserProofSnapshot(session);
    const promptContinuity = renderedFrameContinuity(promptSamples, "Pitch Mirror LISTEN prompt");
    assert(promptContinuity.lastCount - promptContinuity.firstCount >= 6,
      `Pitch Mirror's prompt frame count advanced only ${promptContinuity.firstCount}->${promptContinuity.lastCount}.`);
    assert(promptContinuity.lastTime > promptContinuity.firstTime,
      `Pitch Mirror's detector time did not advance during LISTEN (${promptContinuity.firstTime}->${promptContinuity.lastTime}).`);
    assert(promptSamples.every((sample) => sample.note && sample.inputState === "running"),
      `A rendered note disappeared during Pitch Mirror's LISTEN prompt: ${JSON.stringify(promptSamples)}`);
    assert(promptSamples.some((sample) => sample.note === noteLabel(LOWEST_SUPPORTED_MIDI)),
      `Pitch Mirror's LISTEN prompt never rendered the opening ${noteLabel(LOWEST_SUPPORTED_MIDI)}.`);
    const finishClicked = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Finish now');
      button?.click();
      return Boolean(button);
    })()`);
    assert(finishClicked, "Pitch Mirror's real Finish now control was not clickable.");
    await waitForBrowser(
      session,
      "!document.querySelector('.mirror-stage.active')",
      "Pitch Mirror prompt completion",
    );

    // The visible Pitch Mirror remains mounted for the complete MIDI 30-86
    // sweep, so production diagnostics and the real readout must both cover it.
    const beforeNavigationSamples = await collectRenderedNotes(session, 19_700);
    await delay(1_200);
    const beforeNavigationProof = await browserProofSnapshot(session);
    const beforeNavigationEndSample = lastWorkletSample(beforeNavigationProof)?.endSample ?? -1;
    const navigationMark = await evaluate(session, "performance.now()");
    await evaluate(session, "location.hash = '#sound'; true");
    await waitForBrowser(
      session,
      "location.hash === '#sound' && Boolean(document.querySelector('.sound-lab-page')) && !document.querySelector('[data-note-input]')",
      "Sound Laboratory with no microphone consumer mounted",
    );
    const noConsumerStartProof = await browserProofSnapshot(session);
    const noConsumerStartEndSample = lastWorkletSample(noConsumerStartProof)?.endSample ?? -1;
    await delay(1_200);
    // Remain on the non-microphone page long enough for the production
    // diagnostics transport to flush frames produced entirely without a consumer.
    await delay(1_100);
    const noConsumerEndProof = await browserProofSnapshot(session);
    const noConsumerEndEndSample = lastWorkletSample(noConsumerEndProof)?.endSample ?? -1;
    const noConsumerSampleDelta = noConsumerEndProof.workletSampleMessages
      - noConsumerStartProof.workletSampleMessages;
    const noConsumerFalseWrites = noConsumerEndProof.trackEnabledWrites.filter((write) =>
      write.value === false && write.at >= navigationMark);
    assert(noConsumerSampleDelta >= 20,
      `The worklet produced only ${noConsumerSampleDelta} sample messages with no microphone view mounted.`);
    assert(noConsumerEndProof.trackStopCalls.length === 0 && noConsumerFalseWrites.length === 0,
      `The microphone was stopped or disabled on the non-microphone view: ${JSON.stringify(noConsumerEndProof)}`);

    await evaluate(session, "location.hash = '#hum'; true");
    await waitForBrowser(
      session,
      "location.hash === '#hum' && Boolean(document.querySelector('.input-scope.running'))",
      "the retained microphone on Hum Lab after the no-consumer view",
    );
    const afterNavigationSamples = await collectRenderedNotes(session, 14_000);

    const recoveryBeforeProof = await browserProofSnapshot(session);
    const recoveryBeforeCounter = lastWorkletSample(recoveryBeforeProof);
    assert(recoveryBeforeCounter,
      "No authoritative worklet frame existed before the AudioContext recovery proof.");
    const suspendResult = await evaluate(session, `(async () => {
      const control = window.__noteforgeNoteInputProof;
      if (typeof control?.suspendCapturedAudioContext !== 'function') {
        return { suspended: false, state: null };
      }
      return control.suspendCapturedAudioContext();
    })()`, true);
    assert(suspendResult?.suspended === true,
      `The proof could not suspend the production AudioContext: ${JSON.stringify(suspendResult)}.`);
    await waitForBrowser(
      session,
      `(() => {
        const proof = window.__noteforgeNoteInputProof?.snapshot?.();
        const last = proof?.workletSampleEvents?.at(-1);
        const requestedAt = proof?.audioContextSuspendRequestedAt;
        return Number.isFinite(requestedAt)
          && proof.audioContextStateEvents.some((event) => event.at >= requestedAt && event.state === 'suspended')
          && proof.audioContextStateEvents.some((event) => event.at >= requestedAt && event.state === 'running')
          && last?.captureEpoch === ${recoveryBeforeCounter.captureEpoch}
          && last?.continuityEpoch > ${recoveryBeforeCounter.continuityEpoch}
          && last?.processedSampleCount > ${recoveryBeforeCounter.processedSampleCount};
      })()`,
      "production recovery from a suspended AudioContext",
      5_000,
    );
    const recoveryAfterProof = await browserProofSnapshot(session);
    const recoveryAfterCounter = lastWorkletSample(recoveryAfterProof);
    const recoveryFirstWindow = recoveryAfterProof.workletSampleEvents.find((event) =>
      event.captureEpoch === recoveryBeforeCounter.captureEpoch
        && event.continuityEpoch > recoveryBeforeCounter.continuityEpoch);

    const beforeStopProof = await browserProofSnapshot(session);
    const preStopFalseWrites = beforeStopProof.trackEnabledWrites.filter((write) =>
      write.value === false && write.at >= (beforeStopProof.trackInitialStates[0]?.at ?? 0));
    assert(beforeStopProof.trackStopCalls.length === 0,
      `Production stopped the microphone before the explicit Stop input click: ${JSON.stringify(beforeStopProof.trackStopCalls)}`);
    assert(preStopFalseWrites.length === 0,
      `Production disabled the microphone before the explicit Stop input click: ${JSON.stringify(preStopFalseWrites)}`);
    const stopArmed = await evaluate(session, `(() => {
      const proofControl = window.__noteforgeNoteInputProof;
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Stop input');
      if (!proofControl || !button || button.disabled) return false;
      return proofControl.armStopOnNextSample();
    })()`);
    assert(stopArmed, "The real enabled Stop input control was unavailable.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'disabled'",
      "the explicit Stop input action",
      5_000,
    );
    await delay(500);
    const stoppedProof = await browserProofSnapshot(session);
    await delay(300);
    const settledProof = await browserProofSnapshot(session);
    assert(settledProof.workletSampleMessages === stoppedProof.workletSampleMessages,
      `Worklet sample messages continued after Stop (${stoppedProof.workletSampleMessages}->${settledProof.workletSampleMessages}).`);
    const flushedDetectorCount = await waitForDiagnosticCount(
      diagnosticBatches,
      settledProof.workletSampleMessages,
    );

    const allFrames = orderedPitchEvents(diagnosticBatches);
    const diagnosticFrames = allFrames.map((event) => event.pitch?.frame);
    assert(diagnosticFrames.every(Boolean),
      "A production pitch-frame diagnostic omitted the canonical `pitch.frame` payload.");
    const beforeFrames = allFrames.filter((event) =>
      event.pitch.frame.endSample <= beforeNavigationEndSample);
    const noConsumerFrames = allFrames.filter((event) =>
      event.pitch.frame.endSample > noConsumerStartEndSample
        && event.pitch.frame.endSample <= noConsumerEndEndSample);
    const afterFrames = allFrames.filter((event) =>
      event.pitch.frame.endSample > noConsumerEndEndSample);
    const processingMilliseconds = allFrames.map((event) => event.pitch?.processingMs);
    assert(processingMilliseconds.every((value) => Number.isFinite(value) && value >= 0),
      `Production pitch diagnostics omitted a finite non-negative processingMs value: ${JSON.stringify(processingMilliseconds)}`);
    const sortedProcessingMilliseconds = [...processingMilliseconds]
      .sort((left, right) => left - right);
    const processingMedianMs = sortedProcessingMilliseconds[
      Math.floor(sortedProcessingMilliseconds.length / 2)
    ];
    const processingP95Ms = sortedProcessingMilliseconds[
      Math.max(0, Math.ceil(sortedProcessingMilliseconds.length * 0.95) - 1)
    ];
    const processingMaximumMs = sortedProcessingMilliseconds.at(-1);
    const workletEvents = settledProof.workletSampleEvents;
    const diagnosticByFrame = new Map();
    const duplicateDiagnosticKeys = [];
    for (const event of allFrames) {
      const key = canonicalFrameKey(event.pitch.frame);
      if (diagnosticByFrame.has(key)) duplicateDiagnosticKeys.push(key);
      diagnosticByFrame.set(key, event);
    }
    const exactFramePairingFailures = [];
    for (const workletEvent of workletEvents) {
      const key = canonicalFrameKey(workletEvent);
      const diagnostic = diagnosticByFrame.get(key)?.pitch?.frame;
      if (!diagnostic) {
        exactFramePairingFailures.push(`${key}: missing production diagnostic`);
        continue;
      }
      const mismatches = [
        ["startSample", diagnostic.startSample, workletEvent.startSample],
        ["continuityEpoch", diagnostic.continuityEpoch, workletEvent.continuityEpoch],
        ["graphGeneration", diagnostic.graphGeneration, workletEvent.graphGeneration],
        ["processedSampleCount", diagnostic.processedSampleCount, workletEvent.processedSampleCount],
        ["workletProcessCount", diagnostic.workletProcessCount, workletEvent.processCount],
        ["discontinuity", diagnostic.discontinuity, workletEvent.discontinuity],
      ].filter(([_name, actual, expected]) => actual !== expected);
      if (diagnostic.sampleRate !== SAMPLE_RATE
        || Math.abs(diagnostic.timeSeconds - workletEvent.capturedAt) > 1e-6) {
        mismatches.push([
          "time/sampleRate",
          `${diagnostic.timeSeconds}/${diagnostic.sampleRate}`,
          `${workletEvent.capturedAt}/${SAMPLE_RATE}`,
        ]);
      }
      if (mismatches.length > 0) {
        exactFramePairingFailures.push(
          `${key}: ${mismatches.map(([name, actual, expected]) => `${name}=${actual} expected ${expected}`).join(", ")}`,
        );
      }
    }
    const expectedOccupancyByFrame = new Map();
    let expectedLiveOccupancy = null;
    for (const frame of diagnosticFrames) {
      if (!frame.voiced || frame.nearestMidi === null) {
        expectedLiveOccupancy = null;
        expectedOccupancyByFrame.set(canonicalFrameKey(frame), null);
        continue;
      }
      const previous = expectedLiveOccupancy;
      const continues = previous !== null
        && !frame.discontinuity
        && frame.captureEpoch === previous.frame.captureEpoch
        && frame.continuityEpoch === previous.frame.continuityEpoch
        && frame.sampleRate === previous.frame.sampleRate
        && frame.nearestMidi === previous.frame.nearestMidi
        && frame.startSample > previous.frame.startSample
        && frame.endSample > previous.frame.endSample
        && frame.startSample <= previous.frame.endSample;
      const enteredAtSample = continues ? previous.enteredAtSample : frame.endSample;
      const heldSamples = frame.endSample - enteredAtSample;
      const occupancy = {
        frame,
        enteredAtSample,
        heldSamples,
        heldSeconds: heldSamples / frame.sampleRate,
      };
      expectedLiveOccupancy = occupancy;
      expectedOccupancyByFrame.set(canonicalFrameKey(frame), occupancy);
    }
    const domFrameClaimFailures = [];
    for (const observation of settledProof.domFrameMutations) {
      const key = canonicalFrameKey(observation);
      const diagnostic = diagnosticByFrame.get(key)?.pitch?.frame;
      if (!diagnostic) {
        domFrameClaimFailures.push(
          `${key}: rendered without a production detector frame`,
        );
        continue;
      }
      const expectedNote = diagnostic.voiced && diagnostic.nearestMidi !== null
        ? noteLabel(diagnostic.nearestMidi)
        : null;
      if (observation.note !== expectedNote
        || observation.continuityEpoch !== diagnostic.continuityEpoch
        || observation.graphGeneration !== diagnostic.graphGeneration) {
        domFrameClaimFailures.push(
          `${key}: DOM ${observation.note}/${observation.continuityEpoch}/${observation.graphGeneration}; detector ${expectedNote}/${diagnostic.continuityEpoch}/${diagnostic.graphGeneration}`,
        );
      }
      const expectedOccupancy = expectedOccupancyByFrame.get(key);
      const occupancyMatches = expectedOccupancy === null
        ? observation.heldSamples === null && observation.heldSeconds === null
        : expectedOccupancy !== undefined
          && observation.heldSamples === expectedOccupancy.heldSamples
          && Number.isFinite(observation.heldSeconds)
          && Math.abs(observation.heldSeconds - expectedOccupancy.heldSeconds) <= 1e-9;
      if (!occupancyMatches) {
        domFrameClaimFailures.push(
          `${key}: DOM occupancy ${observation.heldSamples}/${observation.heldSeconds}; expected ${expectedOccupancy?.heldSamples ?? null}/${expectedOccupancy?.heldSeconds ?? null}`,
        );
      }
    }

    const workletSequenceFailures = [];
    for (let index = 0; index < workletEvents.length; index += 1) {
      const event = workletEvents[index];
      const previous = workletEvents[index - 1];
      if (!Number.isSafeInteger(event.startSample)
        || !Number.isSafeInteger(event.endSample)
        || event.endSample - event.startSample !== CAPTURE_WINDOW_SAMPLES) {
        workletSequenceFailures.push(`${index}: invalid [${event.startSample}, ${event.endSample}) window`);
      }
      if (event.processedSampleCount !== event.endSample) {
        workletSequenceFailures.push(`${index}: processed=${event.processedSampleCount} end=${event.endSample}`);
      }
      const expectedCapturedAt = (event.startSample + event.endSample) / (2 * SAMPLE_RATE);
      if (!Number.isFinite(event.capturedAt) || Math.abs(event.capturedAt - expectedCapturedAt) > 1e-9) {
        workletSequenceFailures.push(`${index}: capturedAt=${event.capturedAt} expected=${expectedCapturedAt}`);
      }
      if (!Number.isSafeInteger(event.processCount) || event.processCount <= 0) {
        workletSequenceFailures.push(`${index}: invalid processCount=${event.processCount}`);
      }
      if (!previous) {
        if (event.startSample !== 0 || event.discontinuity !== true) {
          workletSequenceFailures.push(`${index}: first window did not establish epoch at sample zero`);
        }
        continue;
      }
      if (event.captureEpoch < previous.captureEpoch
        || (event.captureEpoch === previous.captureEpoch && event.endSample <= previous.endSample)) {
        workletSequenceFailures.push(`${index}: non-monotonic capture/end coordinates`);
      }
      if (event.captureEpoch === previous.captureEpoch
        && (event.continuityEpoch < previous.continuityEpoch
          || event.graphGeneration < previous.graphGeneration)) {
        workletSequenceFailures.push(`${index}: continuity/graph epoch moved backward`);
      }
      if (event.processCount <= previous.processCount) {
        workletSequenceFailures.push(`${index}: processCount ${previous.processCount}->${event.processCount}`);
      }
      if (event.captureEpoch === previous.captureEpoch
        && event.continuityEpoch === previous.continuityEpoch
        && event.graphGeneration === previous.graphGeneration) {
        if (event.endSample - previous.endSample !== CAPTURE_HOP_SAMPLES || event.discontinuity) {
          workletSequenceFailures.push(
            `${index}: continuous hop ${previous.endSample}->${event.endSample}, discontinuity=${event.discontinuity}`,
          );
        }
      } else if (!event.discontinuity
        || (event.captureEpoch === previous.captureEpoch
          && event.startSample < previous.endSample)) {
        workletSequenceFailures.push(
          `${index}: epoch/generation change overlapped prior evidence or lacked discontinuity`,
        );
      }
    }

    let immediateSearchIndex = 0;
    let previousImmediateEndSample = null;
    const immediateChangeProof = IMMEDIATE_CHANGE_MIDIS.map((midi) => {
      const relativeFrameIndex = diagnosticFrames.slice(immediateSearchIndex).findIndex((frame) =>
        frame.voiced && frame.nearestMidi === midi);
      const frameIndex = relativeFrameIndex < 0
        ? -1
        : immediateSearchIndex + relativeFrameIndex;
      const detectorFrame = frameIndex < 0 ? null : diagnosticFrames[frameIndex];
      const previousDetectorFrame = frameIndex <= 0 ? null : diagnosticFrames[frameIndex - 1];
      const transitionGapSamples = detectorFrame === null || previousImmediateEndSample === null
        ? null
        : detectorFrame.endSample - previousImmediateEndSample;
      const rendered = detectorFrame === null ? null : settledProof.domFrameMutations.find((observation) =>
        observation.captureEpoch === detectorFrame.captureEpoch
          && observation.endSample === detectorFrame.endSample
          && observation.note === noteLabel(midi));
      if (frameIndex >= 0) immediateSearchIndex = frameIndex + 1;
      if (detectorFrame !== null) previousImmediateEndSample = detectorFrame.endSample;
      return {
        midi,
        label: noteLabel(midi),
        detectorFrame,
        previousDetectorFrame,
        transitionGapSamples,
        rendered,
      };
    });
    const occupancyEntryProof = immediateChangeProof[0];
    const occupancyEntryIndex = occupancyEntryProof?.rendered
      ? settledProof.domFrameMutations.findIndex((observation) =>
          observation.captureEpoch === occupancyEntryProof.rendered.captureEpoch
            && observation.endSample === occupancyEntryProof.rendered.endSample)
      : -1;
    const stableOccupancyProgression = [];
    if (occupancyEntryIndex >= 0) {
      for (
        let index = occupancyEntryIndex;
        index < settledProof.domFrameMutations.length;
        index += 1
      ) {
        const observation = settledProof.domFrameMutations[index];
        if (observation.note !== occupancyEntryProof.label
          || observation.captureEpoch !== occupancyEntryProof.rendered.captureEpoch
          || observation.continuityEpoch !== occupancyEntryProof.rendered.continuityEpoch) {
          break;
        }
        stableOccupancyProgression.push(observation);
      }
    }
    const occupancyDepartureObservation = immediateChangeProof[1]?.rendered ?? null;
    const silenceOccupancyObservation = settledProof.domFrameMutations.find((observation) => {
      const frame = diagnosticByFrame.get(canonicalFrameKey(observation))?.pitch?.frame;
      return frame && !frame.voiced
        && frame.reason === "below-rms-threshold"
        && frame.rms === 0;
    }) ?? null;
    const normalAccurateMidis = new Set(diagnosticFrames
      .filter((frame) => frame.voiced
        && EXPECTED_MIDIS.has(frame.nearestMidi)
        && frame.rms > OLD_GATE_RMS_AMPLITUDE
        && Math.abs(frame.centsFromNearest) <= 8)
      .map((frame) => frame.nearestMidi));
    const missingNormalMidis = missingValues(EXPECTED_MIDIS, normalAccurateMidis);
    const quietAccurateFrames = diagnosticFrames.filter((frame) => frame.voiced
      && QUIET_LOW_MIDIS.has(frame.nearestMidi)
      && frame.rms > 0
      && frame.rms < OLD_GATE_RMS_AMPLITUDE
      && Math.abs(frame.centsFromNearest) <= 8);
    const quietAccurateMidis = new Set(quietAccurateFrames.map((frame) => frame.nearestMidi));
    const missingQuietMidis = missingValues(QUIET_LOW_MIDIS, quietAccurateMidis);
    const boundaryMeasurements = [
      SUPPORTED_MIN_FREQUENCY_HZ,
      SUPPORTED_MAX_FREQUENCY_HZ,
    ].map((targetFrequencyHz) => {
      const accurateFrames = diagnosticFrames.filter((frame) => frame.voiced
        && frame.frequencyHz !== null
        && frame.rms > OLD_GATE_RMS_AMPLITUDE
        && Math.abs(1_200 * Math.log2(frame.frequencyHz / targetFrequencyHz)) <= 2);
      const best = [...accurateFrames].sort((left, right) =>
        Math.abs(Math.log2(left.frequencyHz / targetFrequencyHz))
          - Math.abs(Math.log2(right.frequencyHz / targetFrequencyHz)))[0];
      return {
        targetFrequencyHz,
        accurateFrameCount: accurateFrames.length,
        measuredFrequencyHz: best?.frequencyHz ?? null,
        centsError: best?.frequencyHz == null
          ? Number.POSITIVE_INFINITY
          : 1_200 * Math.log2(best.frequencyHz / targetFrequencyHz),
      };
    });
    const diagnosticTransitions = [];
    const quietDiagnosticTransitions = [];
    for (const frame of diagnosticFrames) {
      if (frame.voiced && EXPECTED_MIDIS.has(frame.nearestMidi)
        && diagnosticTransitions.at(-1) !== frame.nearestMidi) {
        diagnosticTransitions.push(frame.nearestMidi);
      }
      if (frame.voiced && QUIET_LOW_MIDIS.has(frame.nearestMidi)
        && frame.rms > 0 && frame.rms < OLD_GATE_RMS_AMPLITUDE
        && quietDiagnosticTransitions.at(-1) !== frame.nearestMidi) {
        quietDiagnosticTransitions.push(frame.nearestMidi);
      }
    }

    const renderedBefore = uniqueExpectedRenderedNotes(beforeNavigationSamples);
    const renderedAfter = uniqueExpectedRenderedNotes(afterNavigationSamples);
    const renderedAll = new Set([...renderedBefore, ...renderedAfter]);
    const transitionsBefore = expectedRenderedTransitions(beforeNavigationSamples);
    const transitionsAfter = expectedRenderedTransitions(afterNavigationSamples);
    const missingRenderedRange = EXPECTED_NOTES
      .map(({ label }) => label)
      .filter((label) => !renderedAll.has(label));
    const quietRenderedSamples = afterNavigationSamples.filter((sample) =>
      sample.meterDbfs !== null
        && sample.meterDbfs < OLD_GATE_RMS_DBFS
        && QUIET_LOW_LABELS.has(sample.note));
    const quietRenderedLabels = new Set(quietRenderedSamples.map((sample) => sample.note));
    const missingQuietRendered = QUIET_LOW_NOTES
      .map(({ label }) => label)
      .filter((label) => !quietRenderedLabels.has(label));
    const quietRenderedTransitions = expectedRenderedTransitions(quietRenderedSamples);
    const weakQuietRuns = QUIET_LOW_NOTES.map(({ label }) => ({
      label,
      run: longestMatchingRun(afterNavigationSamples, (sample) =>
        sample.note === label
          && sample.meterDbfs !== null
          && sample.meterDbfs < OLD_GATE_RMS_DBFS
          && sample.inputState === "running"
          && sample.diagnosis?.endsWith("detected")),
    })).filter(({ run }) => run < 2);
    const renderedContinuityBefore = renderedFrameContinuity(beforeNavigationSamples, "Pitch Mirror");
    const renderedContinuityAfter = renderedFrameContinuity(afterNavigationSamples, "Hum Lab");
    const maximumGap = maximumElapsedGap(allFrames);
    const beforeMaximumGap = maximumElapsedGap(beforeFrames);
    const noConsumerMaximumGap = maximumElapsedGap(noConsumerFrames);
    const afterMaximumGap = maximumElapsedGap(afterFrames);
    const postStartFalseWrites = settledProof.trackEnabledWrites.filter((write) =>
      write.value === false && write.at >= (settledProof.trackInitialStates[0]?.at ?? 0));
    const quietDbfs = quietAccurateFrames.map((frame) => amplitudeToDbfs(frame.rms))
      .sort((left, right) => left - right);
    const quietMedianDbfs = quietDbfs[Math.floor(quietDbfs.length / 2)];
    const silenceRun = longestMatchingRun(diagnosticFrames, (frame) =>
      !frame.voiced && frame.reason === "below-rms-threshold" && frame.rms === 0);
    let silenceEndIndex = -1;
    let currentSilenceRun = 0;
    for (let index = 0; index < diagnosticFrames.length; index += 1) {
      const frame = diagnosticFrames[index];
      if (!frame.voiced && frame.reason === "below-rms-threshold" && frame.rms === 0) {
        currentSilenceRun += 1;
        if (currentSilenceRun === silenceRun) silenceEndIndex = index;
      } else {
        currentSilenceRun = 0;
      }
    }
    const noiseFrames = diagnosticFrames.slice(silenceEndIndex + 3);
    const browserSilenceRun = longestMatchingRun(afterNavigationSamples, (sample) =>
      sample.note === null && sample.meterDbfs !== null && sample.meterDbfs <= -90);
    const browserNoiseRun = longestMatchingRun(afterNavigationSamples, (sample) =>
      sample.note === null && sample.meterDbfs !== null && sample.meterDbfs >= NOISE_RMS_DBFS - 3);
    const promptStartCounter = lastWorkletSample(promptStartProof);
    const promptEndCounter = lastWorkletSample(promptEndProof);
    const noConsumerStartCounter = lastWorkletSample(noConsumerStartProof);
    const noConsumerEndCounter = lastWorkletSample(noConsumerEndProof);
    const workletRequestPaths = [...new Set(settledProof.workletModuleUrls
      .map((url) => new URL(url).pathname)
      .filter((path) => path.includes("pitch-capture-worklet")))];

    assert(settledProof.instrumentationErrors.length === 0,
      `Browser instrumentation failed: ${JSON.stringify(settledProof.instrumentationErrors)}`);
    assert(settledProof.getUserMediaCalls === 1 && settledProof.tracks === 1,
      `Expected one retained microphone stream/track; saw getUserMedia=${settledProof.getUserMediaCalls}, tracks=${settledProof.tracks}.`);
    assert(settledProof.workletNodes === 1,
      `Expected one real AudioWorkletNode; saw ${settledProof.workletNodes}.`);
    assert(recoveryBeforeProof.audioContexts === 1
      && recoveryAfterProof.audioContexts === 1
      && recoveryAfterProof.audioContextSuspendRequests === 1,
    `The transport-recovery proof did not retain one production AudioContext: ${JSON.stringify({
      beforeContexts: recoveryBeforeProof.audioContexts,
      afterContexts: recoveryAfterProof.audioContexts,
      suspendRequests: recoveryAfterProof.audioContextSuspendRequests,
    })}.`);
    assert(recoveryAfterProof.audioContextStateEvents.some((event) =>
      event.at >= recoveryAfterProof.audioContextSuspendRequestedAt
        && event.state === "suspended")
      && recoveryAfterProof.audioContextStateEvents.some((event) =>
        event.at >= recoveryAfterProof.audioContextSuspendRequestedAt
          && event.state === "running"),
    `The production AudioContext did not transition suspended→running: ${JSON.stringify(recoveryAfterProof.audioContextStateEvents)}.`);
    assert(recoveryFirstWindow
      && recoveryAfterCounter
      && recoveryFirstWindow.captureEpoch === recoveryBeforeCounter.captureEpoch
      && recoveryFirstWindow.continuityEpoch === recoveryBeforeCounter.continuityEpoch + 1
      && recoveryFirstWindow.graphGeneration === recoveryBeforeCounter.graphGeneration
      && recoveryFirstWindow.discontinuity === true
      && recoveryFirstWindow.startSample >= recoveryBeforeCounter.endSample
      && recoveryAfterCounter.processCount > recoveryBeforeCounter.processCount
      && recoveryAfterCounter.processedSampleCount > recoveryBeforeCounter.processedSampleCount,
    `The first post-resume authority did not establish a monotonic discontinuity: ${JSON.stringify({
      before: recoveryBeforeCounter,
      first: recoveryFirstWindow,
      after: recoveryAfterCounter,
    })}.`);
    assert(recoveryAfterProof.getUserMediaCalls === recoveryBeforeProof.getUserMediaCalls
      && recoveryAfterProof.streams === recoveryBeforeProof.streams
      && recoveryAfterProof.tracks === recoveryBeforeProof.tracks
      && recoveryAfterProof.workletNodes === recoveryBeforeProof.workletNodes
      && recoveryAfterProof.trackStopCalls.length === recoveryBeforeProof.trackStopCalls.length,
    `AudioContext recovery created or stopped microphone authority: ${JSON.stringify({
      before: {
        getUserMediaCalls: recoveryBeforeProof.getUserMediaCalls,
        streams: recoveryBeforeProof.streams,
        tracks: recoveryBeforeProof.tracks,
        workletNodes: recoveryBeforeProof.workletNodes,
        stopCalls: recoveryBeforeProof.trackStopCalls.length,
      },
      after: {
        getUserMediaCalls: recoveryAfterProof.getUserMediaCalls,
        streams: recoveryAfterProof.streams,
        tracks: recoveryAfterProof.tracks,
        workletNodes: recoveryAfterProof.workletNodes,
        stopCalls: recoveryAfterProof.trackStopCalls.length,
      },
    })}.`);
    assert(workletRequestPaths.length === 1
      && /^\/assets\/pitch-capture-worklet-[A-Za-z0-9_-]+\.js$/u.test(workletRequestPaths[0]),
    `The production graph did not request exactly one content-hashed worklet authority: ${JSON.stringify(workletRequestPaths)}.`);
    assert(!settledProof.workletModuleUrls.some((url) => new URL(url).pathname === "/worklets/pitch-capture.js"),
      "The browser requested the obsolete stable pitch-worklet path.");
    assert(workletEvents.length === settledProof.workletSampleMessages,
      `Worklet evidence retention lost messages: retained=${workletEvents.length}, counted=${settledProof.workletSampleMessages}.`);
    assert(settledProof.workletSampleEvents.every((event) => event.sampleCount === CAPTURE_WINDOW_SAMPLES),
      `A worklet samples message had the wrong production window size: ${JSON.stringify(settledProof.workletSampleEvents)}`);
    assert(workletSequenceFailures.length === 0,
      `Worklet sample/counter sequence was not continuous: ${JSON.stringify(workletSequenceFailures)}`);
    assert(settledProof.stopButtonMissing === false && settledProof.stopButtonClicks === 1,
      `The explicit real Stop input click was not observed exactly once: ${JSON.stringify(settledProof)}`);
    assert(settledProof.trackStopCalls.length === 1,
      `Expected exactly one track.stop() after explicit Stop input; saw ${settledProof.trackStopCalls.length}.`);
    assert(postStartFalseWrites.length === 0,
      `Production wrote track.enabled=false: ${JSON.stringify(postStartFalseWrites)} (first navigation at ${navigationMark.toFixed(1)}ms).`);
    assert(settledProof.explicitStopSampleMessageCount === settledProof.workletSampleMessages,
      `A boundary worklet message escaped after explicit Stop: click at ${settledProof.explicitStopSampleMessageCount}, final ${settledProof.workletSampleMessages}.`);
    assert(flushedDetectorCount === settledProof.workletSampleMessages
      && allFrames.length === settledProof.workletSampleMessages,
    `Independent worklet count ${settledProof.workletSampleMessages} != production detector-frame count ${allFrames.length}.`);
    assert(duplicateDiagnosticKeys.length === 0
      && diagnosticByFrame.size === workletEvents.length
      && exactFramePairingFailures.length === 0,
    `Worklet→detector accounting was not an exact endSample bijection: duplicates=${JSON.stringify(duplicateDiagnosticKeys)}, failures=${JSON.stringify(exactFramePairingFailures)}.`);
    assert(settledProof.domFrameMutations.length >= 100 && domFrameClaimFailures.length === 0,
      `Rendered note claims diverged from their exact production frames: observations=${settledProof.domFrameMutations.length}, failures=${JSON.stringify(domFrameClaimFailures)}.`);
    assert(processingMaximumMs < CAPTURE_HOP_BUDGET_MS,
      `Production detector exceeded its ${CAPTURE_HOP_BUDGET_MS.toFixed(3)}ms capture-hop budget: median=${processingMedianMs.toFixed(3)}ms, p95=${processingP95Ms.toFixed(3)}ms, max=${processingMaximumMs.toFixed(3)}ms.`);
    assert(promptStartCounter && promptEndCounter
      && promptEndCounter.processCount > promptStartCounter.processCount
      && promptEndCounter.processedSampleCount > promptStartCounter.processedSampleCount,
    `Worklet counters did not advance through the active game prompt: ${JSON.stringify({ promptStartCounter, promptEndCounter })}.`);
    assert(noConsumerStartCounter && noConsumerEndCounter
      && noConsumerEndCounter.processCount > noConsumerStartCounter.processCount
      && noConsumerEndCounter.processedSampleCount > noConsumerStartCounter.processedSampleCount,
    `Worklet counters did not advance with no React microphone consumer: ${JSON.stringify({ noConsumerStartCounter, noConsumerEndCounter })}.`);
    assert(immediateChangeProof.every(({ midi, detectorFrame, previousDetectorFrame, transitionGapSamples, rendered }, index) =>
      detectorFrame?.voiced
        && detectorFrame.nearestMidi === midi
        && previousDetectorFrame?.nearestMidi !== midi
        && (index === 0 || (transitionGapSamples > 0
          && transitionGapSamples <= IMMEDIATE_CHANGE_SEGMENT_SAMPLES + CAPTURE_WINDOW_SAMPLES))
        && rendered?.endSample === detectorFrame.endSample
        && rendered.captureEpoch === detectorFrame.captureEpoch
        && rendered.continuityEpoch === detectorFrame.continuityEpoch
        && rendered.graphGeneration === detectorFrame.graphGeneration
        && rendered.inputState === "running"),
    `A changed note was not rendered on the detector's first exact endSample: ${JSON.stringify(immediateChangeProof)}.`);
    assert(stableOccupancyProgression.length >= 6
      && stableOccupancyProgression.slice(0, 6).every((observation, index, progression) => {
        const expectedHeldSamples = index * CAPTURE_HOP_SAMPLES;
        return observation.heldSamples === expectedHeldSamples
          && Number.isFinite(observation.heldSeconds)
          && Math.abs(observation.heldSeconds - expectedHeldSamples / SAMPLE_RATE) <= 1e-9
          && (index === 0
            || observation.endSample - progression[index - 1].endSample === CAPTURE_HOP_SAMPLES);
      }),
    `Rendered same-note occupancy did not enter at zero and advance by exact hops: ${JSON.stringify(stableOccupancyProgression.slice(0, 8))}.`);
    assert(occupancyDepartureObservation
      && occupancyDepartureObservation.note === immediateChangeProof[1].label
      && occupancyDepartureObservation.heldSamples === 0
      && occupancyDepartureObservation.heldSeconds === 0,
    `Rendered occupancy did not reset on note departure: ${JSON.stringify(occupancyDepartureObservation)}.`);
    assert(silenceOccupancyObservation
      && silenceOccupancyObservation.note === null
      && silenceOccupancyObservation.heldSamples === null
      && silenceOccupancyObservation.heldSeconds === null,
    `Rendered occupancy did not clear on an exact unvoiced silence frame: ${JSON.stringify(silenceOccupancyObservation)}.`);
    assert(beforeFrames.length >= 180,
      `Expected at least 180 production detector frames before navigation; saw ${beforeFrames.length}.`);
    assert(noConsumerFrames.length >= 20,
      `Expected at least 20 production detector frames with no consumer; saw ${noConsumerFrames.length}.`);
    assert(afterFrames.length >= 70,
      `Expected at least 70 production detector frames after navigation; saw ${afterFrames.length}.`);
    assert(renderedContinuityBefore.lastCount - renderedContinuityBefore.firstCount >= 180,
      `Pitch Mirror's rendered production frame count advanced only ${renderedContinuityBefore.firstCount}->${renderedContinuityBefore.lastCount}.`);
    assert(renderedContinuityAfter.lastCount - renderedContinuityAfter.firstCount >= 35,
      `Hum Lab's rendered production frame count advanced only ${renderedContinuityAfter.firstCount}->${renderedContinuityAfter.lastCount}.`);
    assert(renderedContinuityAfter.lastTime > renderedContinuityAfter.firstTime + 7,
      `Hum Lab's rendered detector time advanced only ${renderedContinuityAfter.firstTime}->${renderedContinuityAfter.lastTime}.`);
    assert(renderedContinuityAfter.firstCount >= renderedContinuityBefore.lastCount,
      `Navigation reset the shared detector frame count from ${renderedContinuityBefore.lastCount} to ${renderedContinuityAfter.firstCount}.`);
    assert(renderedContinuityBefore.maximumAdvanceGapMilliseconds <= 350
      && renderedContinuityAfter.maximumAdvanceGapMilliseconds <= 350,
    `A rendered detector monotonic update gap exceeded 350ms: mirror=${renderedContinuityBefore.maximumAdvanceGapMilliseconds.toFixed(1)}ms, hum=${renderedContinuityAfter.maximumAdvanceGapMilliseconds.toFixed(1)}ms.`);
    assert(maximumGap <= 350 && noConsumerMaximumGap <= 350,
      `Production detector gap exceeded 350ms: all=${maximumGap}ms, no-consumer=${noConsumerMaximumGap}ms.`);
    assert(missingNormalMidis.length === 0,
      `Normal-level browser capture missed supported MIDI notes: ${missingNormalMidis.join(", ")}.`);
    assert(missingQuietMidis.length === 0,
      `Quiet browser capture below ${OLD_GATE_RMS_DBFS} dBFS missed low MIDI notes: ${missingQuietMidis.join(", ")}.`);
    assert(boundaryMeasurements.every(({ accurateFrameCount, centsError }) =>
      accurateFrameCount >= 2 && Math.abs(centsError) <= 2),
    `Literal detector boundaries were not each measured within 2 cents in at least two frames: ${JSON.stringify(boundaryMeasurements)}.`);
    assert(includesOrderedSequence(diagnosticTransitions, EXPECTED_NOTES.map(({ midi }) => midi)),
      `Production diagnostics did not preserve the complete MIDI 30-86 sweep order: ${diagnosticTransitions.join(", ")}.`);
    assert(includesOrderedSequence(quietDiagnosticTransitions, QUIET_LOW_NOTES.map(({ midi }) => midi)),
      `Production diagnostics did not preserve the quiet MIDI 30-47 sweep order: ${quietDiagnosticTransitions.join(", ")}.`);
    assert(missingRenderedRange.length === 0,
      `The real UI missed supported notes from the full sweep: ${missingRenderedRange.join(", ")}.`);
    assert(missingQuietRendered.length === 0,
      `The real UI missed quiet low notes below ${OLD_GATE_RMS_DBFS} dBFS: ${missingQuietRendered.join(", ")}.`);
    assert(weakQuietRuns.length === 0,
      `Quiet low notes appeared inactive instead of staying visibly detected: ${JSON.stringify(weakQuietRuns)}.`);
    assert(includesContiguousSequence(transitionsBefore, ["C3", "E3", "G3"]),
      `Pitch Mirror did not render the generated C3 -> E3 -> G3 order: ${transitionsBefore.join(" -> ") || "none"}.`);
    assert(includesOrderedSequence(quietRenderedTransitions, QUIET_LOW_NOTES.map(({ label }) => label)),
      `Hum Lab did not render the full quiet low-register order: ${quietRenderedTransitions.join(" -> ") || "none"}.`);
    assert(quietMedianDbfs < OLD_GATE_RMS_DBFS,
      `Measured quiet-frame median ${quietMedianDbfs.toFixed(1)} dBFS was not below the old ${OLD_GATE_RMS_DBFS} dBFS gate.`);
    assert(silenceRun >= 8 && browserSilenceRun >= 6,
      `Browser silence did not remain visibly and diagnostically unvoiced: detector run=${silenceRun}, UI run=${browserSilenceRun}.`);
    assert(noiseFrames.length >= 12,
      `Browser proof captured only ${noiseFrames.length} post-silence noise frames.`);
    assert(noiseFrames.every((frame) => !frame.voiced
      && frame.rms > OLD_GATE_RMS_AMPLITUDE
      && frame.reason !== "below-rms-threshold"),
    `Loud deterministic broadband noise manufactured pitch: ${JSON.stringify(noiseFrames.filter((frame) => frame.voiced))}.`);
    assert(browserNoiseRun >= 8,
      `The rendered UI did not remain note-free over loud broadband noise (longest run ${browserNoiseRun}).`);
    assert(consoleErrors.length === 0,
      `Browser exceptions occurred:\n${consoleErrors.join("\n")}`);

    console.log("PASS production browser microphone proof");
    console.log(`  production range: ${SUPPORTED_MIN_FREQUENCY_HZ}-${SUPPORTED_MAX_FREQUENCY_HZ} Hz; all ${EXPECTED_NOTES.length} enclosed semitones MIDI ${LOWEST_SUPPORTED_MIDI}-${HIGHEST_SUPPORTED_MIDI} detected accurately`);
    console.log(`  literal boundaries: ${boundaryMeasurements.map(({ targetFrequencyHz, measuredFrequencyHz, centsError, accurateFrameCount }) => `${targetFrequencyHz} Hz -> ${measuredFrequencyHz.toFixed(3)} Hz (${centsError >= 0 ? "+" : ""}${centsError.toFixed(2)} cents, ${accurateFrameCount} frames within 2 cents)`).join("; ")}`);
    console.log(`  quiet low pass: all ${QUIET_LOW_NOTES.length} notes MIDI ${LOWEST_SUPPORTED_MIDI}-47 detected; measured median ${quietMedianDbfs.toFixed(1)} dBFS (range ${quietDbfs[0].toFixed(1)} to ${quietDbfs.at(-1).toFixed(1)} dBFS), below old ${OLD_GATE_RMS_DBFS} dBFS gate`);
    console.log(`  negative controls: silence unvoiced for ${silenceRun} detector frames; loud seeded broadband noise unvoiced for ${noiseFrames.length}/${noiseFrames.length} frames; rendered note-free runs ${browserSilenceRun} silence samples and ${browserNoiseRun} noise samples`);
    console.log(`  independent accounting: exact ${workletEvents.length}/${allFrames.length} AudioWorklet→detector endSample pairs; hop=${CAPTURE_HOP_SAMPLES} samples`);
    console.log(`  immediate changes: ${immediateChangeProof.map(({ label, detectorFrame }) => `${label}@${detectorFrame.endSample}`).join(", ")} rendered on each first detector frame`);
    console.log(`  rendered occupancy: ${occupancyEntryProof.label} ${stableOccupancyProgression.slice(0, 6).map(({ endSample, heldSamples }) => `${endSample}:${heldSamples}`).join(", ")}; departure reset=0; silence cleared`);
    console.log(`  transport recovery: AudioContext suspended→running; continuity ${recoveryBeforeCounter.continuityEpoch}->${recoveryFirstWindow.continuityEpoch} with discontinuity=true; getUserMedia/track/worklet remained 1/1/1`);
    console.log(`  detector processing: median ${processingMedianMs.toFixed(3)}ms, p95 ${processingP95Ms.toFixed(3)}ms, max ${processingMaximumMs.toFixed(3)}ms; every frame below ${CAPTURE_HOP_BUDGET_MS.toFixed(3)}ms capture-hop budget`);
    console.log(`  detector continuity: ${beforeFrames.length} mirror, ${noConsumerFrames.length} with no consumer, ${afterFrames.length} hum; maximum gap ${maximumGap}ms (no-consumer ${noConsumerMaximumGap}ms)`);
    console.log(`  prompt continuity: rendered frames ${promptContinuity.firstCount}->${promptContinuity.lastCount}, time ${promptContinuity.firstTime.toFixed(3)}->${promptContinuity.lastTime.toFixed(3)}s, notes always visible`);
    console.log(`  rendered continuity: mirror ${renderedContinuityBefore.firstCount}->${renderedContinuityBefore.lastCount}, hum ${renderedContinuityAfter.firstCount}->${renderedContinuityAfter.lastCount}; all range notes and all quiet low notes visible`);
    console.log(`  microphone lifecycle: getUserMedia=${settledProof.getUserMediaCalls}, disabled-before-stop=${preStopFalseWrites.length}, stopped-before-click=${beforeStopProof.trackStopCalls.length}, stopped-after-click=${settledProof.trackStopCalls.length}`);
  } catch (error) {
    const context = [
      viteOutput.length ? `Vite output:\n${viteOutput.join("\n")}` : "",
      chromiumOutput.length ? `Chromium output:\n${chromiumOutput.join("\n")}` : "",
    ].filter(Boolean).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}${context ? `\n${context}` : ""}`);
  } finally {
    session?.close();
    await stopProcessGroup(chromium);
    await stopProcessGroup(vite);
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
