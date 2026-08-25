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
import { clickHitTested } from "./proof-support/monitoring-browser.mjs";
import {
  SETTINGS_ACCEPTANCE_INSTRUMENTATION_SOURCE,
  closeSettings,
  generatedMicrophoneSnapshot,
  openSettings,
  readToleranceControl,
  setGeneratedMicrophone,
  setVisibleTolerance,
  waitForGeneratedWindows,
  waitForPreferenceState,
  waitForStoredTolerance,
} from "./proof-support/settings-acceptance-browser.mjs";
import { TONE_MAP_VOICE_INSTRUMENTATION_SOURCE } from "./proof-support/tone-map-voice-browser.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";
const INITIAL_ROUTE = "/#/practice/pitch-match/glide";
const RANGE_ROUTE = "/#/practice/range-loop";
const TARGET_MIDI = 48;
const TARGET_LABEL = "C3";
const TOLERANCE_CENTS = 10;
const UPDATED_TOLERANCE_CENTS = 15;
const INSIDE_CENTS = 9;
const OUTSIDE_CENTS = 11;

function describe(value) {
  return JSON.stringify(value, null, 2);
}

function assertToleranceControl(control, expectedCents, description) {
  assert(control && control.value === String(expectedCents) && !control.disabled,
    `${description}: tolerance control was not restored: ${describe(control)}.`);
  assert(control.label.includes(`±${expectedCents} cents`),
    `${description}: visible tolerance copy was stale: ${describe(control)}.`);
  const rectangle = control.rectangle;
  assert(rectangle.width > 0 && rectangle.height > 0
    && rectangle.left >= -1 && rectangle.right <= control.viewport.width + 1
    && rectangle.top >= -1 && rectangle.bottom <= control.viewport.height + 1,
  `${description}: tolerance control was not visible in the Settings viewport: ${describe(control)}.`);
}

async function clickButtonByText(session, text, description) {
  const point = await evaluate(session, `(async () => {
    const element = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)});
    if (!(element instanceof HTMLButtonElement)) return { error: 'missing' };
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rectangle = element.getBoundingClientRect();
    const x = rectangle.left + rectangle.width / 2;
    const y = rectangle.top + rectangle.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      error: rectangle.width <= 0 || rectangle.height <= 0 ? 'zero-size' : null,
      disabled: element.disabled,
      hit: Boolean(hit && (hit === element || element.contains(hit))),
      x,
      y,
      rectangle: rectangle.toJSON(),
    };
  })()`, true);
  assert(!point?.error && !point.disabled && point.hit,
    `${description} was not visibly operable: ${describe(point)}.`);
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function waitForApplication(session, description) {
  await waitForBrowser(
    session,
    "document.readyState === 'complete' && Boolean(document.querySelector('[data-settings-open]'))",
    description,
    15_000,
  );
}

async function inspectRangeAcceptance(session) {
  return evaluate(session, `(() => {
    const input = document.querySelector('[data-note-input]');
    const lane = input?.querySelector('.nf-voice-lane');
    const guidance = input?.querySelector('.nf-voice-guidance');
    const target = input?.querySelector('.nf-voice-target');
    return {
      noteInputCount: document.querySelectorAll('[data-note-input]').length,
      inputState: input?.getAttribute('data-input-state') ?? null,
      detectedNote: input?.getAttribute('data-detected-note') ?? null,
      heldSeconds: Number(input?.getAttribute('data-held-seconds')),
      endSample: Number(input?.getAttribute('data-end-sample')),
      laneClass: lane?.className ?? null,
      errorCents: Number(lane?.getAttribute('aria-valuenow')),
      guidance: guidance?.innerText.replace(/\\s+/gu, ' ').trim() ?? null,
      target: target?.innerText.replace(/\\s+/gu, ' ').trim() ?? null,
      summary: document.querySelector('.range-loop-settings summary b')
        ?.textContent?.replace(/\\s+/gu, ' ').trim() ?? null,
      phase: document.querySelector('[data-range-loop-phase]')
        ?.getAttribute('data-range-loop-phase') ?? null,
      result: document.querySelector('.range-result-next')?.textContent?.trim() ?? null,
    };
  })()`);
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
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-settings-acceptance-"));
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
      source: TONE_MAP_VOICE_INSTRUMENTATION_SOURCE,
    });
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: SETTINGS_ACCEPTANCE_INSTRUMENTATION_SOURCE,
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

    await session.send("Page.navigate", { url: `${origin}${INITIAL_ROUTE}` });
    await waitForApplication(session, "fresh built NoteForge application");
    const loadedAssets = await evaluate(session, `[...document.querySelectorAll('script[src]')]
      .map((script) => new URL(script.src, location.href).pathname)`);
    assert(loadedAssets.some((path) => /^\/assets\/index-[A-Za-z0-9_-]+\.js$/u.test(path))
      && loadedAssets.every((path) => !path.includes("/@vite/") && !path.includes("/src/")),
    `Settings proof did not load the built application: ${describe(loadedAssets)}.`);

    await openSettings(session, "fresh global Settings");
    await waitForPreferenceState(session);
    await setVisibleTolerance(session, TOLERANCE_CENTS);
    await waitForPreferenceState(session);
    const storedBeforeReload = await waitForStoredTolerance(session, TOLERANCE_CENTS);
    const changedControl = await readToleranceControl(session);
    assertToleranceControl(changedControl, TOLERANCE_CENTS, "changed global Settings");
    await closeSettings(session, "changed global Settings");

    await evaluate(session, "window.__noteforgeSettingsReloadMarker = true; true");
    await session.send("Page.reload", { ignoreCache: true });
    await waitForBrowser(
      session,
      "window.__noteforgeSettingsReloadMarker !== true",
      "a replacement document after reload",
      15_000,
    );
    await waitForApplication(session, "NoteForge after a true page reload");
    await openSettings(session, "reloaded global Settings");
    await waitForPreferenceState(session);
    const restoredControl = await readToleranceControl(session);
    assertToleranceControl(restoredControl, TOLERANCE_CENTS, "reloaded global Settings");
    const storedAfterReload = await waitForStoredTolerance(session, TOLERANCE_CENTS);
    await closeSettings(session, "reloaded global Settings");

    // A full direct load catches consumers that freeze the default before the
    // asynchronous global preference record has hydrated.
    await session.send("Page.navigate", { url: `${origin}${RANGE_ROUTE}` });
    await waitForApplication(session, "directly loaded Range Loop");
    await waitForBrowser(
      session,
      `location.hash === '#/practice/range-loop'
        && document.querySelector('.range-loop-settings summary b')?.textContent?.includes('±${TOLERANCE_CENTS}¢')
        && document.querySelector('.nf-voice-target small')?.textContent?.includes('${TOLERANCE_CENTS} cent lane')`,
      "Range Loop hydrating the restored acceptance tolerance",
      15_000,
    );
    const hydratedRange = await inspectRangeAcceptance(session);
    assert(hydratedRange.noteInputCount === 1
      && hydratedRange.target?.includes(TARGET_LABEL)
      && hydratedRange.target?.includes(`${TOLERANCE_CENTS} cent lane`)
      && hydratedRange.summary?.includes(`±${TOLERANCE_CENTS}¢`),
    `Range Loop did not consume the restored global tolerance: ${describe(hydratedRange)}.`);
    await openSettings(session, "direct-load global Settings");
    await waitForPreferenceState(session);
    assertToleranceControl(
      await readToleranceControl(session),
      TOLERANCE_CENTS,
      "direct-load global Settings",
    );
    await closeSettings(session, "direct-load global Settings");

    await clickHitTested(session, "[data-global-mic-enable]", "Range Loop Enable voice");
    await waitForBrowser(
      session,
      "document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'running'",
      "generated microphone through the production input path",
      12_000,
    );
    const canonicalInput = await evaluate(session, `(() => {
      const input = document.querySelector('[data-note-input]');
      window.__noteforgeSettingsCanonicalInput = input;
      return Boolean(input);
    })()`);
    assert(canonicalInput, "Range Loop's shared NoteInput was unavailable.");
    await clickButtonByText(session, "Start Range Loop", "visible Start Range Loop action");
    await waitForBrowser(
      session,
      "document.querySelector('[data-range-loop-phase]')?.getAttribute('data-range-loop-phase') === 'tracking'",
      "Range Loop tracking after explicit Start",
    );

    let microphone = await generatedMicrophoneSnapshot(session);
    const beforeInsideWindows = microphone.workletSampleEvents.length;
    await setGeneratedMicrophone(session, TARGET_MIDI, INSIDE_CENTS);
    await waitForGeneratedWindows(
      session,
      beforeInsideWindows,
      12,
      `${TARGET_LABEL} +${INSIDE_CENTS} cents through production PCM`,
    );
    await waitForBrowser(
      session,
      `(() => {
        const input = document.querySelector('[data-note-input]');
        const lane = input?.querySelector('.nf-voice-lane');
        const error = Number(lane?.getAttribute('aria-valuenow'));
        return input === window.__noteforgeSettingsCanonicalInput
          && document.querySelectorAll('[data-note-input]').length === 1
          && input?.getAttribute('data-detected-note') === '${TARGET_LABEL}'
          && lane?.classList.contains('locked')
          && error > 0 && error <= ${TOLERANCE_CENTS}
          && Number(input?.getAttribute('data-held-seconds')) >= 0.08;
      })()`,
      `real shared acceptance of +${INSIDE_CENTS} cents inside ±${TOLERANCE_CENTS}`,
      8_000,
    );
    const inside = await inspectRangeAcceptance(session);
    assert(inside.guidance?.includes("IN LANE")
      && inside.laneClass?.includes("locked")
      && inside.errorCents > 0
      && inside.errorCents <= TOLERANCE_CENTS
      && inside.heldSeconds >= 0.08,
    `Inside-boundary pitch was not accepted by the shared dwell/coach: ${describe(inside)}.`);

    microphone = await generatedMicrophoneSnapshot(session);
    const beforeOutsideWindows = microphone.workletSampleEvents.length;
    await setGeneratedMicrophone(session, TARGET_MIDI, OUTSIDE_CENTS);
    await waitForGeneratedWindows(
      session,
      beforeOutsideWindows,
      12,
      `${TARGET_LABEL} +${OUTSIDE_CENTS} cents through production PCM`,
    );
    await waitForBrowser(
      session,
      `(() => {
        const input = document.querySelector('[data-note-input]');
        const lane = input?.querySelector('.nf-voice-lane');
        const error = Number(lane?.getAttribute('aria-valuenow'));
        return input === window.__noteforgeSettingsCanonicalInput
          && document.querySelectorAll('[data-note-input]').length === 1
          && input?.getAttribute('data-detected-note') === '${TARGET_LABEL}'
          && lane?.classList.contains('searching')
          && error > ${TOLERANCE_CENTS}
          && Number(input?.getAttribute('data-held-seconds')) === 0;
      })()`,
      `real shared rejection of +${OUTSIDE_CENTS} cents outside ±${TOLERANCE_CENTS}`,
      8_000,
    );
    const outsideStart = await generatedMicrophoneSnapshot(session);
    await waitForGeneratedWindows(
      session,
      outsideStart.workletSampleEvents.length,
      8,
      "continued out-of-lane PCM without false dwell",
    );
    const outside = await inspectRangeAcceptance(session);
    assert(outside.guidance?.includes("FIND THE TARGET LANE")
      && outside.laneClass?.includes("searching")
      && outside.errorCents > TOLERANCE_CENTS
      && outside.heldSeconds === 0
      && outside.result === null,
    `Outside-boundary pitch was accepted or retained stale dwell: ${describe(outside)}.`);

    // Keep the same +11-cent oscillator running while changing the user-visible
    // global setting. This is the regression boundary: Range Loop must consume
    // the new tolerance live, rather than freezing the value captured at Start.
    const beforeLiveUpdate = await generatedMicrophoneSnapshot(session);
    await openSettings(session, "tracking global Settings");
    await waitForPreferenceState(session);
    await setVisibleTolerance(session, UPDATED_TOLERANCE_CENTS);
    const storedAfterLiveUpdate = await waitForStoredTolerance(
      session,
      UPDATED_TOLERANCE_CENTS,
    );
    assertToleranceControl(
      await readToleranceControl(session),
      UPDATED_TOLERANCE_CENTS,
      "live-updated global Settings",
    );
    await closeSettings(session, "live-updated global Settings");
    await waitForBrowser(
      session,
      `(() => {
        const input = document.querySelector('[data-note-input]');
        return input === window.__noteforgeSettingsCanonicalInput
          && document.querySelectorAll('[data-note-input]').length === 1
          && document.querySelector('[data-range-loop-phase]')?.getAttribute('data-range-loop-phase') === 'tracking'
          && document.querySelector('.range-loop-settings summary b')?.textContent?.includes('±${UPDATED_TOLERANCE_CENTS}¢')
          && document.querySelector('.nf-voice-target small')?.textContent?.includes('${UPDATED_TOLERANCE_CENTS} cent lane');
      })()`,
      "active Range Loop consuming the live global tolerance",
      8_000,
    );
    await waitForBrowser(
      session,
      `(() => {
        const input = document.querySelector('[data-note-input]');
        const lane = input?.querySelector('.nf-voice-lane');
        const error = Number(lane?.getAttribute('aria-valuenow'));
        return input === window.__noteforgeSettingsCanonicalInput
          && input?.getAttribute('data-detected-note') === '${TARGET_LABEL}'
          && lane?.classList.contains('locked')
          && error > ${TOLERANCE_CENTS} && error <= ${UPDATED_TOLERANCE_CENTS}
          && Number(input?.getAttribute('data-held-seconds')) > 0;
      })()`,
      `same +${OUTSIDE_CENTS}-cent pitch accepted after widening to ±${UPDATED_TOLERANCE_CENTS}`,
      8_000,
    );
    const liveAcceptedStart = await inspectRangeAcceptance(session);
    const liveGrowthStart = await generatedMicrophoneSnapshot(session);
    await waitForGeneratedWindows(
      session,
      liveGrowthStart.workletSampleEvents.length,
      8,
      "continued same-pitch PCM after the live tolerance update",
    );
    const liveAccepted = await inspectRangeAcceptance(session);
    const afterLiveUpdate = await generatedMicrophoneSnapshot(session);
    assert(liveAcceptedStart.laneClass?.includes("locked")
      && liveAccepted.laneClass?.includes("locked")
      && liveAccepted.errorCents > TOLERANCE_CENTS
      && liveAccepted.errorCents <= UPDATED_TOLERANCE_CENTS
      && liveAccepted.heldSeconds > liveAcceptedStart.heldSeconds,
    `Live tolerance update did not admit the same pitch and grow dwell: ${describe({
      start: liveAcceptedStart,
      later: liveAccepted,
    })}.`);
    assert(afterLiveUpdate.generatorCommands.length === beforeLiveUpdate.generatorCommands.length
      && afterLiveUpdate.generator?.frequencyHz === beforeLiveUpdate.generator?.frequencyHz
      && afterLiveUpdate.getUserMediaCalls === beforeLiveUpdate.getUserMediaCalls
      && afterLiveUpdate.streams === beforeLiveUpdate.streams
      && afterLiveUpdate.tracks === beforeLiveUpdate.tracks
      && afterLiveUpdate.generatorContexts === beforeLiveUpdate.generatorContexts
      && afterLiveUpdate.productionAudioContexts === beforeLiveUpdate.productionAudioContexts
      && afterLiveUpdate.mediaStreamSources === beforeLiveUpdate.mediaStreamSources
      && afterLiveUpdate.knownStreamSources === beforeLiveUpdate.knownStreamSources
      && afterLiveUpdate.workletNodes === beforeLiveUpdate.workletNodes
      && afterLiveUpdate.trackEnabledWrites.length === beforeLiveUpdate.trackEnabledWrites.length
      && afterLiveUpdate.trackStopCalls.length === beforeLiveUpdate.trackStopCalls.length,
    `Live tolerance update restarted or mutated the microphone path: ${describe({
      before: beforeLiveUpdate,
      after: afterLiveUpdate,
    })}.`);

    const finalProof = await generatedMicrophoneSnapshot(session);
    assert(finalProof.instrumentationErrors.length === 0,
      `Generated-microphone instrumentation failed: ${describe(finalProof.instrumentationErrors)}.`);
    assert(finalProof.getUserMediaCalls === 1
      && finalProof.streams === 1
      && finalProof.tracks === 1
      && finalProof.generatorContexts === 1
      && finalProof.productionAudioContexts === 1
      && finalProof.mediaStreamSources === 1
      && finalProof.knownStreamSources === 1
      && finalProof.workletNodes === 1,
    `Acceptance proof bypassed or duplicated the production audio path: ${describe(finalProof)}.`);
    assert(finalProof.generatorCommands.length === 2
      && finalProof.generatorCommands[0]?.midi === TARGET_MIDI
      && finalProof.generatorCommands[0]?.cents === INSIDE_CENTS
      && finalProof.generatorCommands[1]?.midi === TARGET_MIDI
      && finalProof.generatorCommands[1]?.cents === OUTSIDE_CENTS,
    `Generated microphone did not cross the requested boundary: ${describe(finalProof.generatorCommands)}.`);
    assert(finalProof.trackEnabledWrites.length === 0 && finalProof.trackStopCalls.length === 0,
      `Settings or acceptance changed capture lifetime: ${describe({
        enabledWrites: finalProof.trackEnabledWrites,
        stops: finalProof.trackStopCalls,
      })}.`);
    assert(finalProof.workletSampleEvents.every((frame, index, frames) => index === 0
      || frame.endSample - frames[index - 1].endSample === 960),
    "Generated microphone evidence was not one monotonic 20 ms overlapping stream.");
    assert(browserErrors.length === 0,
      `Browser errors occurred: ${describe(browserErrors)}.`);

    await clickHitTested(session, "[data-global-mic-disable]", "explicit Disable voice");
    await waitForBrowser(
      session,
      "document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'disabled'",
      "explicit global microphone Disable",
    );
    const stoppedProof = await generatedMicrophoneSnapshot(session);
    assert(stoppedProof.trackStopCalls.length === 1,
      `Explicit Disable did not alone stop the generated track: ${describe(stoppedProof.trackStopCalls)}.`);

    await evaluate(session, "window.__noteforgeSettingsReloadMarker = true; true");
    await session.send("Page.reload", { ignoreCache: true });
    await waitForBrowser(
      session,
      "window.__noteforgeSettingsReloadMarker !== true",
      "a replacement document after the live tolerance update",
      15_000,
    );
    await waitForApplication(session, "Range Loop reloaded after the live tolerance update");
    await waitForBrowser(
      session,
      `location.hash === '#/practice/range-loop'
        && document.querySelector('.range-loop-settings summary b')?.textContent?.includes('±${UPDATED_TOLERANCE_CENTS}¢')
        && document.querySelector('.nf-voice-target small')?.textContent?.includes('${UPDATED_TOLERANCE_CENTS} cent lane')`,
      "Range Loop restoring the live-updated tolerance after reload",
      15_000,
    );
    const restoredLiveRange = await inspectRangeAcceptance(session);
    await openSettings(session, "post-live-reload global Settings");
    await waitForPreferenceState(session);
    assertToleranceControl(
      await readToleranceControl(session),
      UPDATED_TOLERANCE_CENTS,
      "post-live-reload global Settings",
    );
    const storedAfterLiveReload = await waitForStoredTolerance(
      session,
      UPDATED_TOLERANCE_CENTS,
    );
    await closeSettings(session, "post-live-reload global Settings");
    assert(restoredLiveRange.target?.includes(`${UPDATED_TOLERANCE_CENTS} cent lane`)
      && restoredLiveRange.summary?.includes(`±${UPDATED_TOLERANCE_CENTS}¢`),
    `Reloaded Range Loop did not restore the live-updated tolerance: ${describe(restoredLiveRange)}.`);
    assert(browserErrors.length === 0,
      `Browser errors occurred: ${describe(browserErrors)}.`);

    console.log("Settings persistence and acceptance browser proof passed.");
    console.log(JSON.stringify({
      storedBeforeReload,
      storedAfterReload,
      storedAfterLiveUpdate,
      storedAfterLiveReload,
      hydratedRange,
      inside,
      outside,
      liveAcceptedStart,
      liveAccepted,
      restoredLiveRange,
      audio: {
        getUserMediaCalls: finalProof.getUserMediaCalls,
        sources: finalProof.mediaStreamSources,
        worklets: finalProof.workletNodes,
        windows: finalProof.workletSampleEvents.length,
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
          "/tmp/noteforge-settings-acceptance-failure.png",
          Buffer.from(screenshot.data, "base64"),
        );
      } catch { /* Failure context below remains authoritative. */ }
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
