import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assert,
  availablePort,
  captureProcessOutput,
  delay,
  DevToolsSession,
  evaluate,
  stopProcessGroup,
  waitForBrowser,
  waitForHttp,
  waitForPageTarget,
} from "./proof-support/devtools-runtime.mjs";
import {
  generatedMicrophoneWav,
  SAMPLE_RATE,
} from "./proof-support/note-input-fixture.mjs";
import { BROWSER_INSTRUMENTATION_SOURCE } from "./proof-support/note-input-instrumentation.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";

const TRACE_CASES = Object.freeze([
  {
    name: "Pitch Match",
    hash: "#/practice/pitch-match/glide",
    pageSelector: ".pitch-mirror-page",
    formerCutoffSeconds: 4,
  },
  {
    name: "Hum Lab",
    hash: "#/practice/hum/sustain",
    pageSelector: ".hum-lab-page",
    formerCutoffSeconds: 8,
  },
  {
    name: "Pitch Control",
    hash: "#/practice/pitch-control/diamond",
    pageSelector: ".control-page",
    formerCutoffSeconds: 12,
  },
]);

function lastWorkletWindow(snapshot) {
  return snapshot.workletSampleEvents.at(-1) ?? null;
}

function clickButtonExpression(label) {
  return `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`;
}

async function readTraceDom(session) {
  return evaluate(session, `(() => {
    const stage = document.querySelector(
      '[data-workflow-step="tracking"][data-trace-lifetime="user-owned"]',
    );
    const scope = document.querySelector('[data-note-input]');
    return {
      tracking: Boolean(stage),
      inputState: scope?.getAttribute('data-input-state') ?? null,
      frameCount: Number(scope?.getAttribute('data-frame-count') ?? 'NaN'),
      endSample: Number(scope?.getAttribute('data-end-sample') ?? 'NaN'),
      captureEpoch: Number(scope?.getAttribute('data-capture-epoch') ?? 'NaN'),
      continuityEpoch: Number(scope?.getAttribute('data-continuity-epoch') ?? 'NaN'),
      graphGeneration: Number(scope?.getAttribute('data-graph-generation') ?? 'NaN'),
    };
  })()`);
}

async function runTraceCase(session, traceCase) {
  await evaluate(session, `location.hash = ${JSON.stringify(traceCase.hash)}; true`);
  await waitForBrowser(
    session,
    `location.hash === ${JSON.stringify(traceCase.hash)}
      && Boolean(document.querySelector(${JSON.stringify(traceCase.pageSelector)}))
      && document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'running'
      && Boolean(document.querySelector('[data-workflow-step="idle"]'))`,
    `${traceCase.name}'s idle live workflow on the retained microphone`,
  );

  const started = await evaluate(session, clickButtonExpression("Start trace"));
  assert(started, `${traceCase.name}'s Start trace button was not available.`);
  await waitForBrowser(
    session,
    "Boolean(document.querySelector('[data-workflow-step=\"tracking\"][data-trace-lifetime=\"user-owned\"]'))",
    `${traceCase.name}'s user-owned tracking state`,
  );
  await waitForBrowser(
    session,
    "Number(document.querySelector('[data-note-input]')?.getAttribute('data-end-sample')) > 0",
    `${traceCase.name}'s first authoritative rendered observation`,
  );

  const startedProof = await evaluate(
    session,
    "window.__noteforgeNoteInputProof.snapshot()",
  );
  const startedWindow = lastWorkletWindow(startedProof);
  const startedDom = await readTraceDom(session);
  assert(startedWindow && startedDom.tracking,
    `${traceCase.name} did not establish live worklet and workflow authority.`);

  // This is intentionally real elapsed browser/audio time. It crosses the
  // former feature cutoff instead of advancing a mocked clock underneath UI.
  await delay((traceCase.formerCutoffSeconds + 0.8) * 1_000);

  const liveDom = await readTraceDom(session);
  const liveProof = await evaluate(
    session,
    "window.__noteforgeNoteInputProof.snapshot()",
  );
  const liveWindow = lastWorkletWindow(liveProof);
  const minimumSampleAdvance = traceCase.formerCutoffSeconds * SAMPLE_RATE;
  assert(liveDom.tracking,
    `${traceCase.name} left tracking at its former ${traceCase.formerCutoffSeconds}s cutoff: ${JSON.stringify(liveDom)}.`);
  assert(liveDom.inputState === "running",
    `${traceCase.name} changed microphone state while its trace remained user-owned: ${JSON.stringify(liveDom)}.`);
  assert(liveWindow
      && liveWindow.captureEpoch === startedWindow.captureEpoch
      && liveWindow.processedSampleCount - startedWindow.processedSampleCount >= minimumSampleAdvance,
  `${traceCase.name}'s PCM authority did not advance beyond its former cutoff: ${JSON.stringify({ startedWindow, liveWindow })}.`);
  assert(liveDom.frameCount > startedDom.frameCount
      && liveDom.endSample - startedDom.endSample >= minimumSampleAdvance,
  `${traceCase.name}'s rendered authoritative observations did not continue beyond its former cutoff: ${JSON.stringify({ startedDom, liveDom })}.`);
  const matchingWorkletWindow = liveProof.workletSampleEvents.find((event) =>
    event.captureEpoch === liveDom.captureEpoch
      && event.continuityEpoch === liveDom.continuityEpoch
      && event.graphGeneration === liveDom.graphGeneration
      && event.endSample === liveDom.endSample);
  assert(matchingWorkletWindow,
    `${traceCase.name}'s live DOM sample was not an exact native worklet observation: ${JSON.stringify(liveDom)}.`);
  assert(liveProof.trackStopCalls.length === 0,
    `${traceCase.name} stopped capture before any explicit global Disable: ${JSON.stringify(liveProof.trackStopCalls)}.`);

  const finished = await evaluate(session, clickButtonExpression("Finish trace"));
  assert(finished, `${traceCase.name}'s explicit Finish trace button was not available.`);
  await waitForBrowser(
    session,
    "Boolean(document.querySelector('[data-workflow-step=\"complete\"]')) && !document.querySelector('[data-workflow-step=\"tracking\"]')",
    `${traceCase.name}'s result after the explicit Finish trace click`,
  );

  const afterFinishProof = await evaluate(
    session,
    "window.__noteforgeNoteInputProof.snapshot()",
  );
  await delay(300);
  const settledProof = await evaluate(
    session,
    "window.__noteforgeNoteInputProof.snapshot()",
  );
  assert(settledProof.workletSampleMessages > afterFinishProof.workletSampleMessages
      && settledProof.trackStopCalls.length === 0,
  `${traceCase.name}'s explicit feature Finish incorrectly stopped the app-owned sensor: ${JSON.stringify({ afterFinishProof, settledProof })}.`);

  return {
    name: traceCase.name,
    formerCutoffSeconds: traceCase.formerCutoffSeconds,
    sampleSeconds: (liveWindow.processedSampleCount - startedWindow.processedSampleCount) / SAMPLE_RATE,
    renderedFrameAdvance: liveDom.frameCount - startedDom.frameCount,
    renderedSampleAdvance: liveDom.endSample - startedDom.endSample,
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
    const builtServiceWorker = await readFile(join(REPOSITORY_ROOT, "dist/sw.js"), "utf8");
    assert(!builtServiceWorker.includes("__NOTEFORGE_"),
      "Run npm run build before the live-trace proof; the service worker is unstamped.");

    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-live-trace-proof-"));
    const wavPath = join(temporaryDirectory, "continuous-observations.wav");
    const chromiumProfile = join(temporaryDirectory, "chromium-profile");
    const vitePort = await availablePort();
    const debugPort = await availablePort();
    const pageUrl = `http://127.0.0.1:${vitePort}/${TRACE_CASES[0].hash}`;
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

    const consoleErrors = [];
    session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      consoleErrors.push(exceptionDetails?.exception?.description || exceptionDetails?.text || "browser exception");
    });
    session.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type !== "error") return;
      consoleErrors.push(args?.map((argument) => argument.value ?? argument.description).join(" ") || "console error");
    });
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: BROWSER_INSTRUMENTATION_SOURCE,
    });
    await session.send("Page.navigate", { url: pageUrl });
    await waitForBrowser(
      session,
      "document.readyState === 'complete' && Boolean(document.querySelector('[data-global-mic-enable]'))",
      "the global voice control on the first live-trace route",
    );

    const entryScripts = await evaluate(session, `[
      ...document.querySelectorAll('script[src]'),
    ].map((script) => new URL(script.src, location.href).pathname)`);
    assert(entryScripts.some((path) => /^\/assets\/index-[A-Za-z0-9_-]+\.js$/u.test(path)),
      `The proof did not load a hashed production bundle: ${JSON.stringify(entryScripts)}.`);
    const enabled = await evaluate(session, `(() => {
      const button = document.querySelector('[data-global-mic-enable]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert(enabled, "The sole global Enable voice action was unavailable.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'running' && Number(document.querySelector('[data-note-input]')?.getAttribute('data-end-sample')) > 0",
      "the first authoritative production microphone observation",
      12_000,
    );

    const results = [];
    for (const traceCase of TRACE_CASES) {
      results.push(await runTraceCase(session, traceCase));
    }

    const beforeDisable = await evaluate(
      session,
      "window.__noteforgeNoteInputProof.snapshot()",
    );
    assert(beforeDisable.instrumentationErrors.length === 0,
      `Browser instrumentation failed: ${JSON.stringify(beforeDisable.instrumentationErrors)}.`);
    assert(beforeDisable.getUserMediaCalls === 1
      && beforeDisable.streams === 1
      && beforeDisable.tracks === 1
      && beforeDisable.audioContexts === 1
      && beforeDisable.workletNodes === 1,
    `Navigation or a live mode replaced shared capture authority: ${JSON.stringify(beforeDisable)}.`);
    assert(beforeDisable.trackStopCalls.length === 0
      && !beforeDisable.trackEnabledWrites.some((write) => write.value === false),
    `A live mode stopped or disabled capture before explicit global Disable: ${JSON.stringify(beforeDisable)}.`);

    const disabled = await evaluate(session, `(() => {
      const button = document.querySelector('[data-global-mic-disable]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert(disabled, "The explicit global Disable voice action was unavailable.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'disabled'",
      "the explicit global Disable voice action",
    );
    await delay(300);
    const afterDisable = await evaluate(
      session,
      "window.__noteforgeNoteInputProof.snapshot()",
    );
    assert(afterDisable.trackStopCalls.length === 1,
      `Only explicit global Disable should stop the retained track; saw ${afterDisable.trackStopCalls.length} stops.`);
    assert(consoleErrors.length === 0,
      `The live-trace browser workflow emitted console errors: ${JSON.stringify(consoleErrors)}.`);

    console.log("User-owned live trace browser proof passed.");
    for (const result of results) {
      console.log(
        `${result.name}: active through ${result.sampleSeconds.toFixed(2)}s of authoritative PCM past former ${result.formerCutoffSeconds}s cutoff; `
          + `${result.renderedFrameAdvance} rendered counter steps / ${result.renderedSampleAdvance} samples; completed only after explicit Finish trace.`,
      );
    }
    console.log("Shared authority: one getUserMedia, one stream/track/context/worklet, zero pre-Disable stops, one explicit Disable stop.");
  } finally {
    session?.close();
    await stopProcessGroup(chromium);
    await stopProcessGroup(vite);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    if (vite?.exitCode && vite.exitCode !== 0) {
      console.error(viteOutput.join("\n"));
    }
    if (chromium?.exitCode && chromium.exitCode !== 0) {
      console.error(chromiumOutput.join("\n"));
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
