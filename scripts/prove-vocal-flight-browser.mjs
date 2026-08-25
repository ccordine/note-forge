import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  availablePort,
  captureProcessOutput,
  delay,
  DevToolsSession,
  enableRemotePitchDiagnostics,
  evaluate,
  stopProcessGroup,
  waitForBrowser,
  waitForHttp,
  waitForPageTarget,
} from "./proof-support/devtools-runtime.mjs";
import { BROWSER_INSTRUMENTATION_SOURCE } from "./proof-support/note-input-instrumentation.mjs";
import {
  assertControlBehavior,
  assertDerivedSignals,
  assertExactAuthority,
  pitchFramesFrom,
} from "./proof-support/vocal-flight-assertions.mjs";
import {
  generatedVocalFlightWav,
  VOCAL_FLIGHT_TUTORIAL_IDS,
  vocalFlightSegmentRanges,
} from "./proof-support/vocal-flight-fixture.mjs";
import { VOCAL_FLIGHT_INSTRUMENTATION_SOURCE } from "./proof-support/vocal-flight-instrumentation.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";
const VIEWPORTS = Object.freeze([
  { width: 1_440, height: 900 },
  { width: 760, height: 800 },
  { width: 430, height: 760 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]);
const STAGES = Object.freeze([
  ["neutral", "Keep this center"],
  ["pitch-upper", "Keep upper extent"],
  ["pitch-lower", "Keep lower extent"],
  ["brightness-dark", "Keep darker extent"],
  ["brightness-bright", "Keep brighter extent"],
  ["center-recovery", "Use this control space"],
]);

async function clickVisible(session, selector, textIncludes = null) {
  const target = await evaluate(session, `(async () => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((candidate) => ${JSON.stringify(textIncludes)} === null
      || candidate.textContent?.includes(${JSON.stringify(textIncludes)}));
    if (!(element instanceof HTMLElement)) return { error: 'missing element' };
    element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    return {
      disabled: Boolean(element.disabled),
      error: rect.width <= 0 || rect.height <= 0 ? 'zero-sized element' : null,
      hit: Boolean(hit && (element === hit || element.contains(hit))), x, y,
    };
  })()`, true);
  assert(!target?.error && !target.disabled && target.hit,
    `${selector}/${textIncludes ?? "first"} was not a reachable live control: ${JSON.stringify(target)}`);
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1,
  });
}

async function synchronizedAuthoritySnapshot(session) {
  return evaluate(session, `(async () => new Promise((resolveSnapshot) => {
    let interval = null;
    let timeout = null;
    const finish = (snapshot) => {
      if (interval !== null) clearInterval(interval);
      if (timeout !== null) clearTimeout(timeout);
      resolveSnapshot(snapshot);
    };
    const check = () => {
      const native = window.__noteforgeNoteInputProof?.snapshot?.();
      const feature = window.__noteforgeVocalFlightProof?.snapshot?.();
      if (feature?.current?.observedFrames === native?.workletSampleMessages) {
        finish({ native, feature });
      }
    };
    interval = setInterval(check, 5);
    timeout = setTimeout(() => finish(null), 5_000);
    check();
  }))()`, true);
}

async function inspectLayout(session) {
  return evaluate(session, `(async () => {
    document.documentElement.style.scrollBehavior = 'auto';
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const label = (element) => {
      const classes = [...element.classList].slice(0, 3).join('.');
      return element.tagName.toLowerCase() + (classes ? '.' + classes : '');
    };
    const roots = [...document.querySelectorAll('.topbar,.surface-navigation,.arcade-game-topbar,[data-vocal-flight]')];
    const descendants = roots.flatMap((root) => [root, ...root.querySelectorAll('*')])
      .filter((element, index, all) => all.indexOf(element) === index
        && element instanceof HTMLElement && visible(element));
    const horizontalEdges = descendants.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > innerWidth + 1;
    }).map((element) => ({ element: label(element), rect: element.getBoundingClientRect().toJSON() }));
    const maskedOverflow = descendants.filter((element) => {
      const overflow = getComputedStyle(element).overflowX;
      return element.scrollWidth > element.clientWidth + 1
        && ['hidden', 'clip', 'auto', 'scroll'].includes(overflow);
    }).map((element) => ({
      element: label(element), clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth, overflowX: getComputedStyle(element).overflowX,
    }));
    const controls = [...document.querySelectorAll(
      '.topbar button,.surface-navigation select,.arcade-game-topbar a,[data-vocal-flight] button,[data-vocal-flight] select'
    )].filter(visible);
    const reachability = [];
    for (const [index, element] of controls.entries()) {
      element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(x, y);
      if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1
        || rect.bottom > innerHeight + 1 || !hit || !(element === hit || element.contains(hit))) {
        reachability.push({ index, element: label(element), rect: rect.toJSON(), hit: hit && label(hit) });
      }
    }
    const maximumScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    scrollTo({ top: document.documentElement.scrollHeight, left: 0, behavior: 'instant' });
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    const reachedBottom = Math.abs(scrollY - maximumScroll) <= 2;
    scrollTo({ top: 0, left: 0, behavior: 'instant' });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        maximumScroll, reachedBottom,
      },
      phase: document.querySelector('[data-vocal-flight]')?.getAttribute('data-phase'),
      controls: controls.length, horizontalEdges, maskedOverflow, reachability,
    };
  })()`, true);
}

function assertLayout(layout, viewport, phase) {
  const label = `${viewport.width}x${viewport.height}/${phase}`;
  assert(layout.viewport.width === viewport.width && layout.viewport.height === viewport.height,
    `${label}: viewport override failed: ${JSON.stringify(layout.viewport)}`);
  assert(layout.phase === phase, `${label}: rendered phase ${layout.phase}.`);
  assert(layout.document.scrollWidth <= layout.document.clientWidth + 1
    && layout.document.bodyScrollWidth <= layout.document.bodyClientWidth + 1,
  `${label}: the page requires or hides horizontal scrolling: ${JSON.stringify(layout.document)}`);
  assert(layout.document.reachedBottom, `${label}: the document bottom was unreachable.`);
  assert(layout.controls > 0, `${label}: no visible controls were found.`);
  assert(layout.horizontalEdges.length === 0,
    `${label}: content escapes horizontally: ${JSON.stringify(layout.horizontalEdges)}`);
  assert(layout.maskedOverflow.length === 0,
    `${label}: content is clipped behind overflow: ${JSON.stringify(layout.maskedOverflow)}`);
  assert(layout.reachability.length === 0,
    `${label}: controls are not scrollable/hit-testable: ${JSON.stringify(layout.reachability)}`);
}

async function proveResponsiveState(session, phase) {
  const results = [];
  for (const viewport of VIEWPORTS) {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1,
      mobile: viewport.width <= 760, screenWidth: viewport.width, screenHeight: viewport.height,
    });
    const layout = await inspectLayout(session);
    assertLayout(layout, viewport, phase);
    results.push({ ...viewport, scrollHeight: layout.document.scrollHeight, controls: layout.controls });
  }
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 1_440, height: 900, deviceScaleFactor: 1,
    mobile: false, screenWidth: 1_440, screenHeight: 900,
  });
  return results;
}

async function runCalibration(session) {
  for (const [stage, acceptLabel] of STAGES) {
    await waitForBrowser(
      session,
      `document.querySelector('[data-vocal-flight]')?.getAttribute('data-calibration-stage') === ${JSON.stringify(stage)}`,
      `${stage} calibration stage`,
      8_000,
    );
    await waitForBrowser(
      session,
      "Boolean(document.querySelector('.vocal-flight-calibration footer .primary:not(:disabled)'))",
      `${stage} sample action`,
      8_000,
    );
    await clickVisible(session, ".vocal-flight-calibration footer .primary");
    await waitForBrowser(
      session,
      `[...document.querySelectorAll('.vocal-flight-calibration footer .primary:not(:disabled)')]
        .some((button) => button.textContent?.includes(${JSON.stringify(acceptLabel)}))`,
      `${stage} qualified evidence`,
      5_000,
    );
    await clickVisible(session, ".vocal-flight-calibration footer .primary", acceptLabel);
  }
  await waitForBrowser(session, "Boolean(document.querySelector('.vocal-flight-loadout'))", "calibrated loadout", 4_000);
}

async function seedCompletedTutorials(session, origin) {
  await session.send("Page.navigate", { url: `${origin}/manifest.webmanifest` });
  await waitForBrowser(session, "document.readyState === 'complete'", "same-origin storage seed document");
  const seeded = await evaluate(session, `(async () => {
    const tutorialIds = ${JSON.stringify(VOCAL_FLIGHT_TUTORIAL_IDS)};
    const database = await new Promise((resolveDatabase, rejectDatabase) => {
      const request = indexedDB.open('noteforge', 1);
      request.onerror = () => rejectDatabase(request.error);
      request.onupgradeneeded = () => {
        const database = request.result;
        const attempts = database.createObjectStore('attempts', { keyPath: 'id' });
        attempts.createIndex('completedAt', 'completedAt');
        attempts.createIndex('exerciseType', 'exerciseType');
        database.createObjectStore('settings', { keyPath: 'key' });
      };
      request.onsuccess = () => resolveDatabase(request.result);
    });
    await new Promise((resolveWrite, rejectWrite) => {
      const transaction = database.transaction('settings', 'readwrite');
      transaction.oncomplete = resolveWrite;
      transaction.onerror = () => rejectWrite(transaction.error);
      transaction.onabort = () => rejectWrite(transaction.error);
      transaction.objectStore('settings').put({
        key: 'voice.arcade.progress',
        value: { completedVariantsByMode: { flight: tutorialIds } },
      });
    });
    const result = await new Promise((resolveRead, rejectRead) => {
      const transaction = database.transaction('settings', 'readonly');
      const request = transaction.objectStore('settings').get('voice.arcade.progress');
      request.onsuccess = () => resolveRead(request.result);
      request.onerror = () => rejectRead(request.error);
    });
    database.close();
    return result?.value?.completedVariantsByMode?.flight ?? [];
  })()`, true);
  assert(JSON.stringify(seeded) === JSON.stringify(VOCAL_FLIGHT_TUTORIAL_IDS),
    `Canonical Arcade tutorial evidence did not seed: ${JSON.stringify(seeded)}`);
}

async function main() {
  let temporaryDirectory;
  let preview;
  let chromium;
  let session;
  let previewOutput = [];
  let chromiumOutput = [];
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-vocal-flight-proof-"));
    const wavPath = join(temporaryDirectory, "vocal-flight.wav");
    const previewPort = await availablePort();
    const debugPort = await availablePort();
    const origin = `http://127.0.0.1:${previewPort}`;
    await writeFile(wavPath, generatedVocalFlightWav());
    preview = spawn(process.execPath, [
      join(REPOSITORY_ROOT, "node_modules/vite/bin/vite.js"), "preview",
      "--config", join(REPOSITORY_ROOT, "vite.config.ts"),
      "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort",
    ], { cwd: REPOSITORY_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    previewOutput = captureProcessOutput(preview, "vite-preview");
    await waitForHttp(`${origin}/`, preview, 12_000, previewOutput);

    chromium = spawn(CHROMIUM, [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}`,
      `--user-data-dir=${join(temporaryDirectory, "profile")}`,
      `--remote-debugging-port=${debugPort}`, "about:blank",
    ], { cwd: REPOSITORY_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    chromiumOutput = captureProcessOutput(chromium, "chromium");
    const target = await waitForPageTarget(debugPort, chromium, chromiumOutput);
    session = new DevToolsSession(target.webSocketDebuggerUrl);
    await session.connect();
    const diagnosticBatches = [];
    const browserErrors = [];
    session.on("Network.requestWillBeSent", ({ request }) => {
      if (!request?.url?.includes("/api/diagnostics/pitch") || !request.postData) return;
      try { diagnosticBatches.push(JSON.parse(request.postData)); } catch { /* asserted later */ }
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
      source: `${BROWSER_INSTRUMENTATION_SOURCE}\n${VOCAL_FLIGHT_INSTRUMENTATION_SOURCE}`,
    });
    await seedCompletedTutorials(session, origin);
    await session.send("Page.navigate", { url: `${origin}/#/arcade/flight` });
    await waitForBrowser(
      session,
      "document.readyState === 'complete' && Boolean(document.querySelector('[data-vocal-flight]'))",
      "the built Vocal Flight cabinet",
      12_000,
    );
    const assets = await evaluate(session, `[...document.querySelectorAll('script[src]')]
      .map((script) => new URL(script.src, location.href).pathname)`);
    assert(assets.some((path) => /^\/assets\/index-[A-Za-z0-9_-]+\.js$/u.test(path))
      && assets.every((path) => !path.includes('/@vite/') && !path.includes('/src/')),
    `Vocal Flight did not load the production bundle: ${JSON.stringify(assets)}`);
    const calibrationLayouts = await proveResponsiveState(session, "calibration");

    await enableRemotePitchDiagnostics(session);
    await clickVisible(session, "[data-global-mic-enable]");
    await waitForBrowser(
      session,
      "Boolean(document.querySelector('[data-global-mic-disable]'))\n        && Number(document.querySelector('[data-vocal-flight]')?.getAttribute('data-observed-frames')) > 0",
      "the one retained app-owned microphone",
      8_000,
    );
    await runCalibration(session);
    const calibrated = await evaluate(session, `(() => {
      const root = document.querySelector('[data-vocal-flight]');
      const modes = [...document.querySelectorAll('.vocal-flight-mode-grid button')];
      return {
        stage: root?.getAttribute('data-calibration-stage'),
        summary: document.querySelector('.vocal-flight-loadout')?.textContent?.trim() || '',
        ringRunDisabled: Boolean(modes.find((button) => button.textContent?.includes('Ring Run'))?.disabled),
      };
    })()`);
    assert(calibrated.stage === "complete" && calibrated.ringRunDisabled === false
      && calibrated.summary.includes("Two independent axes demonstrated")
      && /CENTER RETURNS\s*3/u.test(calibrated.summary),
    `The real calibration did not establish the asymmetric two-axis surface: ${JSON.stringify(calibrated)}`);
    await clickVisible(session, ".vocal-flight-mode-grid button", "Free Flight");
    await clickVisible(session, '[data-flight-action="start-flight"]', "Start flight");
    await waitForBrowser(
      session,
      "document.querySelector('[data-vocal-flight]')?.getAttribute('data-phase') === 'flying'",
      "Free Flight explicit Start",
      3_000,
    );
    const flightLayouts = await proveResponsiveState(session, "flying");
    const renderBefore = await evaluate(session,
      "Number(document.querySelector('[data-testid=vocal-flight-canvas]')?.dataset.renderFrames || 0)");
    await delay(350);
    const renderAfter = await evaluate(session,
      "Number(document.querySelector('[data-testid=vocal-flight-canvas]')?.dataset.renderFrames || 0)");
    assert(renderAfter - renderBefore >= 8,
      `Canvas rAF presentation did not run independently: ${renderBefore} -> ${renderAfter}.`);

    const finalSilence = vocalFlightSegmentRanges().find((segment) => segment.label === "final-silence");
    await waitForBrowser(
      session,
      `Number(document.querySelector('[data-vocal-flight]')?.getAttribute('data-end-sample'))
        >= ${finalSilence.startSample + 8_192}`,
      "the complete calibration and flight fixture",
      40_000,
    );
    const preRoute = await synchronizedAuthoritySnapshot(session);
    assert(preRoute, "Vocal Flight never caught up to the latest worklet observation.");
    await delay(1_000);
    const detectorFrames = pitchFramesFrom(diagnosticBatches);
    const derived = assertDerivedSignals(detectorFrames);
    const authority = assertExactAuthority(preRoute.native, preRoute.feature, detectorFrames);
    const controls = assertControlBehavior(preRoute.feature.publications, detectorFrames);

    const beforeExplicitFinish = await evaluate(session, `(() => {
      const root = document.querySelector('[data-vocal-flight]');
      return {
        phase: root?.getAttribute('data-phase') || null,
        observedFrames: Number(root?.getAttribute('data-observed-frames')),
        simulatedFrames: Number(root?.getAttribute('data-simulated-frames')),
        elapsedSeconds: Number(root?.getAttribute('data-flight-elapsed-seconds')),
        distance: Number(root?.getAttribute('data-flight-distance')),
        native: window.__noteforgeNoteInputProof.snapshot(),
      };
    })()`);
    await clickVisible(session, '[data-flight-action="finish-flight"]', "Finish flight");
    await waitForBrowser(
      session,
      "document.querySelector('[data-vocal-flight]')?.getAttribute('data-phase') === 'complete'",
      "Vocal Flight explicit Finish",
      3_000,
    );
    const finishBoundary = await evaluate(session, `(() => {
      const root = document.querySelector('[data-vocal-flight]');
      return {
        observedFrames: Number(root?.getAttribute('data-observed-frames')),
        simulatedFrames: Number(root?.getAttribute('data-simulated-frames')),
        elapsedSeconds: Number(root?.getAttribute('data-flight-elapsed-seconds')),
        distance: Number(root?.getAttribute('data-flight-distance')),
      };
    })()`);
    await delay(500);
    const afterExplicitFinish = await evaluate(session, `(() => {
      const root = document.querySelector('[data-vocal-flight]');
      return {
        phase: root?.getAttribute('data-phase') || null,
        observedFrames: Number(root?.getAttribute('data-observed-frames')),
        simulatedFrames: Number(root?.getAttribute('data-simulated-frames')),
        elapsedSeconds: Number(root?.getAttribute('data-flight-elapsed-seconds')),
        distance: Number(root?.getAttribute('data-flight-distance')),
        native: window.__noteforgeNoteInputProof.snapshot(),
      };
    })()`);
    assert(beforeExplicitFinish.phase === "flying"
      && afterExplicitFinish.phase === "complete"
      && afterExplicitFinish.observedFrames > finishBoundary.observedFrames
      && afterExplicitFinish.native.workletSampleMessages > beforeExplicitFinish.native.workletSampleMessages
      && afterExplicitFinish.simulatedFrames === finishBoundary.simulatedFrames
      && afterExplicitFinish.elapsedSeconds === finishBoundary.elapsedSeconds
      && afterExplicitFinish.distance === finishBoundary.distance,
    `Explicit Finish did not freeze only flight simulation while shared telemetry continued: ${JSON.stringify({ beforeExplicitFinish, finishBoundary, afterExplicitFinish })}`);

    await clickVisible(session, ".arcade-game-topbar a", "Back to cabinet");
    await waitForBrowser(session, "location.hash === '#/arcade' && !document.querySelector('[data-vocal-flight]')", "cabinet exit");
    await delay(500);
    const afterRoute = await evaluate(session, `({
      native: window.__noteforgeNoteInputProof.snapshot(),
      feature: window.__noteforgeVocalFlightProof.snapshot(),
    })`);
    assert(afterRoute.native.workletSampleMessages > preRoute.native.workletSampleMessages + 10,
      "PCM did not continue after Vocal Flight unmounted.");
    assert(afterRoute.native.getUserMediaCalls === 1 && afterRoute.native.streams === 1
      && afterRoute.native.tracks === 1 && afterRoute.native.audioContexts === 1
      && afterRoute.feature.mediaStreamSources === 1 && afterRoute.native.workletNodes === 1,
    `Capture authority was duplicated: ${JSON.stringify({ native: afterRoute.native, feature: afterRoute.feature })}`);
    assert(afterRoute.native.trackEnabledWrites.length === 0
      && afterRoute.native.trackStopCalls.length === 0,
    `Navigation changed the retained microphone track: ${JSON.stringify({
      enabledWrites: afterRoute.native.trackEnabledWrites,
      stops: afterRoute.native.trackStopCalls,
    })}`);
    assert(afterRoute.native.oscillators === 0 && afterRoute.native.oscillatorStarts.length === 0
      && afterRoute.feature.bufferSourceStarts === 0 && afterRoute.feature.mediaElementPlayCalls === 0,
    "Vocal Flight unexpectedly played audio.");
    const workletPaths = [...new Set(afterRoute.native.workletModuleUrls.map((url) => new URL(url).pathname))];
    assert(workletPaths.length === 1
      && /^\/assets\/pitch-capture-worklet-[A-Za-z0-9_-]+\.js$/u.test(workletPaths[0]),
    `The graph did not use one hashed production worklet: ${JSON.stringify(workletPaths)}`);
    assert(preRoute.feature.rootElements === 1 && preRoute.feature.canvasElements === 1,
      `The workflow replaced its root or renderer: ${JSON.stringify(preRoute.feature)}`);
    assert(browserErrors.length === 0, `Browser errors occurred:\n${browserErrors.join("\n")}`);

    console.log("Vocal Flight production browser proof passed.");
    console.log(JSON.stringify({
      capture: {
        getUserMediaCalls: afterRoute.native.getUserMediaCalls,
        workletWindowsBeforeExit: authority.workletWindows,
        workletWindowsAfterExit: afterRoute.native.workletSampleMessages,
        trackStops: afterRoute.native.trackStopCalls.length,
      },
      derived, authority, controls,
      explicitLifetime: {
        observedFramesBeforeFinish: beforeExplicitFinish.observedFrames,
        observedFramesAfterFinish: afterExplicitFinish.observedFrames,
        simulatedFramesAtFinish: finishBoundary.simulatedFrames,
        simulatedFramesAfterFinish: afterExplicitFinish.simulatedFrames,
      },
      presentation: { renderFramesAdvanced: renderAfter - renderBefore },
      responsive: { calibration: calibrationLayouts, flying: flightLayouts },
    }, null, 2));
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

await main();
