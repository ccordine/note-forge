import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assert,
  availablePort,
  captureProcessOutput,
  DevToolsSession,
  evaluate,
  stopProcessGroup,
  waitForBrowser,
  waitForHttp,
  waitForPageTarget,
} from "./proof-support/devtools-runtime.mjs";
import {
  AUDIO_OUTPUT_INSTRUMENTATION_SOURCE,
  OUTPUT_DEVICE_ID,
  OUTPUT_DEVICE_LABEL,
  inspectOutputSettings,
  outputProofSnapshot,
  rejectSavedOutputAfterReload,
  waitForStoredPreferredOutput,
} from "./proof-support/audio-output-browser.mjs";
import { clickHitTested } from "./proof-support/monitoring-browser.mjs";
import {
  closeSettings,
  openSettings,
} from "./proof-support/settings-acceptance-browser.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";
const ROUTE = "/#/practice/range-loop";
const EXPECTED_OUTPUT = Object.freeze({
  deviceId: OUTPUT_DEVICE_ID,
  label: OUTPUT_DEVICE_LABEL,
});

function describe(value) {
  return JSON.stringify(value, null, 2);
}

async function waitForApplication(session, description) {
  await waitForBrowser(
    session,
    "document.readyState === 'complete' && Boolean(document.querySelector('[data-settings-open]'))",
    description,
    15_000,
  );
}

function assertNoAudio(snapshot, description) {
  assert(snapshot.contexts.length === 0
    && snapshot.getUserMediaCalls.length === 0
    && snapshot.sources.length === 0
    && snapshot.worklets.length === 0
    && snapshot.sinkCalls.length === 0,
  `${description} opened or routed audio: ${describe(snapshot)}.`);
}

function assertSharedContext(snapshot, rejected, description) {
  const context = snapshot.contexts[0];
  const sinkCalls = snapshot.sinkCalls.filter((call) => call.sinkId === OUTPUT_DEVICE_ID);
  assert(snapshot.contexts.length === 1
    && snapshot.getUserMediaCalls.length === 1
    && snapshot.sources.length === 1
    && snapshot.worklets.length === 1
    && sinkCalls.length >= 1
    && sinkCalls.every((call) => call.contextId === context?.id && call.rejected === rejected)
    && snapshot.sources.every((source) => source.contextId === context?.id)
    && snapshot.worklets.every((worklet) => worklet.contextId === context?.id),
  `${description} did not route the saved sink on the one capture context: ${describe(snapshot)}.`);
}

async function reloadDocument(session, description) {
  await evaluate(session, "window.__noteforgeOutputReloadMarker = true; true");
  await session.send("Page.reload", { ignoreCache: true });
  await waitForBrowser(
    session,
    "window.__noteforgeOutputReloadMarker !== true",
    `${description} replacement document`,
    15_000,
  );
  await waitForApplication(session, description);
}

async function waitForOutputLabel(session, expected, description) {
  await waitForBrowser(
    session,
    `document.querySelector('[data-audio-output-label]')?.textContent?.trim() === ${JSON.stringify(expected)}`,
    description,
    8_000,
  );
}

async function enableVoice(session, description) {
  await clickHitTested(session, "[data-global-mic-enable]", description);
  await waitForBrowser(
    session,
    `document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'running'
      && window.__noteforgeAudioOutputProof.snapshot().getUserMediaCalls.length === 1
      && window.__noteforgeAudioOutputProof.snapshot().sinkCalls.length >= 1`,
    `${description} capture and saved output routing`,
    15_000,
  );
}

async function disableVoice(session, description) {
  await clickHitTested(session, "[data-global-mic-disable]", description);
  await waitForBrowser(
    session,
    `document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'disabled'
      && window.__noteforgeAudioOutputProof.snapshot().trackStops.length === 1`,
    `${description} track stop`,
    8_000,
  );
}

async function main() {
  let temporaryDirectory;
  let preview;
  let chromium;
  let session;
  let previewOutput = [];
  let chromiumOutput = [];
  const browserErrors = [];

  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-audio-output-proof-"));
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
    ], {
      cwd: REPOSITORY_ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    previewOutput = captureProcessOutput(preview, "vite-preview");
    await waitForHttp(`${origin}/`, preview, 12_000, previewOutput);

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
      `--user-data-dir=${join(temporaryDirectory, "chromium-profile")}`,
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
    session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      browserErrors.push(exceptionDetails?.exception?.description
        || exceptionDetails?.text
        || "browser exception");
    });
    session.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type !== "error") return;
      browserErrors.push(args?.map((argument) => argument.value ?? argument.description).join(" ")
        || "console error");
    });
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: AUDIO_OUTPUT_INSTRUMENTATION_SOURCE,
    });
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });

    await session.send("Page.navigate", { url: `${origin}${ROUTE}` });
    await waitForApplication(session, "fresh built NoteForge application");
    const loadedAssets = await evaluate(session, `[...document.querySelectorAll('script[src]')]
      .map((script) => new URL(script.src, location.href).pathname)`);
    assert(loadedAssets.some((path) => /^\/assets\/index-[A-Za-z0-9_-]+\.js$/u.test(path))
      && loadedAssets.every((path) => !path.includes("/@vite/") && !path.includes("/src/")),
    `Output proof did not load the built application: ${describe(loadedAssets)}.`);

    await openSettings(session, "fresh audio-output Settings");
    await waitForOutputLabel(session, "System default", "default output label");
    const initialSettings = await inspectOutputSettings(session);
    const initialProof = await outputProofSnapshot(session);
    assert(initialSettings.chooser && !initialSettings.chooser.disabled,
      `Supported output chooser was not visibly available: ${describe(initialSettings)}.`);
    assertNoAudio(initialProof, "Opening Settings");

    await clickHitTested(
      session,
      "[data-audio-output-select]",
      "visible Choose output action",
    );
    await waitForOutputLabel(session, OUTPUT_DEVICE_LABEL, "chosen output label");
    const storedSelection = await waitForStoredPreferredOutput(session, EXPECTED_OUTPUT);
    const selectedSettings = await inspectOutputSettings(session);
    const selectedProof = await outputProofSnapshot(session);
    assert(selectedSettings.label === OUTPUT_DEVICE_LABEL
      && selectedSettings.error === null
      && selectedProof.chooserCalls.length === 1
      && selectedProof.contexts.length === 1
      && selectedProof.sinkCalls.length === 1
      && selectedProof.sinkCalls[0]?.sinkId === OUTPUT_DEVICE_ID
      && selectedProof.sinkCalls[0]?.contextId === selectedProof.contexts[0]?.id
      && !selectedProof.sinkCalls[0]?.rejected
      && selectedProof.getUserMediaCalls.length === 0
      && selectedProof.sources.length === 0
      && selectedProof.worklets.length === 0,
    `Visible output selection did not route and persist the shared output: ${describe({
      settings: selectedSettings,
      proof: selectedProof,
    })}.`);
    await closeSettings(session, "chosen audio-output Settings");

    await reloadDocument(session, "NoteForge after selecting an output");
    await openSettings(session, "restored audio-output Settings");
    await waitForOutputLabel(session, OUTPUT_DEVICE_LABEL, "restored output label");
    const restoredBeforeEnable = await inspectOutputSettings(session);
    const restoredBeforeEnableProof = await outputProofSnapshot(session);
    assert(restoredBeforeEnable.label === OUTPUT_DEVICE_LABEL
      && restoredBeforeEnable.error === null,
    `Reload did not hydrate the saved output label: ${describe(restoredBeforeEnable)}.`);
    assertNoAudio(restoredBeforeEnableProof, "Reload hydration and Settings");
    const storedAfterReload = await waitForStoredPreferredOutput(session, EXPECTED_OUTPUT);
    await closeSettings(session, "restored audio-output Settings");

    await enableVoice(session, "explicit Enable with restored output");
    const restoredRunningProof = await outputProofSnapshot(session);
    assertSharedContext(restoredRunningProof, false, "Restored output");
    assert(restoredRunningProof.chooserCalls.length === 0
      && restoredRunningProof.trackStops.length === 0,
    `Restore reopened the chooser or stopped capture: ${describe(restoredRunningProof)}.`);
    await openSettings(session, "running restored-output Settings");
    await waitForOutputLabel(session, OUTPUT_DEVICE_LABEL, "running restored output label");
    const runningSettings = await inspectOutputSettings(session);
    assert(runningSettings.error === null,
      `Restored output reported an error after routing: ${describe(runningSettings)}.`);
    await closeSettings(session, "running restored-output Settings");
    await disableVoice(session, "explicit Disable after successful restore");

    await rejectSavedOutputAfterReload(session, OUTPUT_DEVICE_ID);
    await reloadDocument(session, "NoteForge with a missing saved output");
    await openSettings(session, "missing-output hydration Settings");
    await waitForOutputLabel(session, OUTPUT_DEVICE_LABEL, "saved label before routing");
    assertNoAudio(
      await outputProofSnapshot(session),
      "Missing-output hydration before explicit Enable",
    );
    await closeSettings(session, "missing-output hydration Settings");

    await enableVoice(session, "explicit Enable with missing saved output");
    const clearedSelection = await waitForStoredPreferredOutput(session, null);
    await openSettings(session, "missing-output fallback Settings");
    await waitForOutputLabel(session, "System default", "missing-output fallback label");
    const fallbackSettings = await inspectOutputSettings(session);
    const fallbackProof = await outputProofSnapshot(session);
    assertSharedContext(fallbackProof, true, "Missing saved output");
    assert(fallbackSettings.label === "System default"
      && fallbackSettings.error?.includes("no longer available"),
    `Missing saved output did not visibly fall back: ${describe(fallbackSettings)}.`);
    await closeSettings(session, "missing-output fallback Settings");
    await disableVoice(session, "explicit Disable after output fallback");
    await evaluate(
      session,
      "localStorage.removeItem('__noteforgeOutputProofRejectSinkId'); true",
    );

    assert(selectedProof.instrumentationErrors.length === 0
      && restoredRunningProof.instrumentationErrors.length === 0
      && fallbackProof.instrumentationErrors.length === 0,
    `Output instrumentation errors occurred: ${describe({
      selected: selectedProof.instrumentationErrors,
      restored: restoredRunningProof.instrumentationErrors,
      fallback: fallbackProof.instrumentationErrors,
    })}.`);
    assert(browserErrors.length === 0,
      `Browser errors occurred: ${describe(browserErrors)}.`);

    console.log("Audio output persistence browser proof passed.");
    console.log(JSON.stringify({
      storedSelection,
      storedAfterReload,
      clearedSelection,
      restoredGraph: {
        contexts: restoredRunningProof.contexts.length,
        sources: restoredRunningProof.sources.length,
        worklets: restoredRunningProof.worklets.length,
        sinkCalls: restoredRunningProof.sinkCalls,
      },
      missingOutput: {
        settings: fallbackSettings,
        sinkCalls: fallbackProof.sinkCalls,
      },
    }, null, 2));
  } catch (error) {
    if (session) {
      try {
        const screenshot = await session.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        await writeFile(
          "/tmp/noteforge-audio-output-proof-failure.png",
          Buffer.from(screenshot.data, "base64"),
        );
      } catch {
        // Failure context below remains authoritative.
      }
    }
    const context = [...previewOutput, ...chromiumOutput].join("\n");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${context ? `\n${context}` : ""}`,
    );
  } finally {
    session?.close();
    await stopProcessGroup(chromium);
    await stopProcessGroup(preview);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
