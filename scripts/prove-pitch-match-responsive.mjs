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
  evaluate,
  stopProcessGroup,
  waitForBrowser,
  waitForHttp,
  waitForPageTarget,
} from "./proof-support/devtools-runtime.mjs";
import { generatedMicrophoneWav } from "./proof-support/note-input-fixture.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";
const VIEWPORTS = Object.freeze([
  { width: 1_440, height: 900, label: "1440x900", fullWorkflow: false },
  { width: 1_261, height: 850, label: "1261x850", fullWorkflow: false },
  { width: 1_260, height: 850, label: "1260x850", fullWorkflow: false },
  { width: 1_041, height: 800, label: "1041x800", fullWorkflow: false },
  { width: 1_040, height: 800, label: "1040x800", fullWorkflow: false },
  { width: 761, height: 800, label: "761x800", fullWorkflow: false },
  { width: 760, height: 800, label: "760x800", fullWorkflow: false },
  { width: 431, height: 760, label: "431x760", fullWorkflow: false },
  { width: 430, height: 760, label: "430x760", fullWorkflow: false },
  { width: 390, height: 844, label: "390x844", fullWorkflow: true },
  { width: 320, height: 568, label: "320x568", fullWorkflow: true },
]);
const MODES = Object.freeze(["glide", "delayed", "cold", "anchor", "silent"]);
const CONTROL_SELECTOR = [
  ".topbar button",
  ".surface-navigation select",
  ".pitch-mirror-page button",
  ".pitch-mirror-page select",
  ".pitch-mirror-page summary",
].join(",");

function describeFailures(failures) {
  return failures.map((failure) => JSON.stringify(failure)).join("\n");
}

async function clickVisible(session, selector, index = 0) {
  const target = await evaluate(session, `(async () => {
    const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
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
      hit: Boolean(hit && (element === hit || element.contains(hit))),
      x,
      y,
    };
  })()`, true);
  assert(!target?.error, `${selector}[${index}] could not be clicked: ${JSON.stringify(target)}`);
  assert(!target.disabled, `${selector}[${index}] was unexpectedly disabled.`);
  assert(target.hit, `${selector}[${index}] was covered or clipped at its visual center.`);
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
}

async function inspectLayout(session) {
  return evaluate(session, `(async () => {
    document.documentElement.style.scrollBehavior = 'auto';
    document.body.style.scrollBehavior = 'auto';
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const name = (element) => {
      const classes = [...element.classList].slice(0, 3).join('.');
      const role = element.getAttribute('role');
      return [element.tagName.toLowerCase(), classes && '.' + classes, role && '[role=' + role + ']']
        .filter(Boolean).join('');
    };
    const roots = [...document.querySelectorAll('.topbar,.surface-navigation,.pitch-mirror-page')];
    const descendants = roots.flatMap((root) => [root, ...root.querySelectorAll('*')])
      .filter((element, index, all) => all.indexOf(element) === index && visible(element));
    const horizontalEdges = descendants
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      })
      .map((element) => ({ element: name(element), rect: element.getBoundingClientRect().toJSON() }));
    const maskedOverflow = descendants
      .filter((element) => {
        if (element.closest('.topbar') && !element.closest('.global-mic-control')) return false;
        const overflow = getComputedStyle(element).overflowX;
        return element.scrollWidth > element.clientWidth + 1
          && ['hidden', 'clip', 'auto', 'scroll'].includes(overflow);
      })
      .map((element) => ({
        element: name(element),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: getComputedStyle(element).overflowX,
      }));
    const controlElements = [...document.querySelectorAll(${JSON.stringify(CONTROL_SELECTOR)})]
      .filter(visible);
    const initialControlEdges = controlElements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      })
      .map((element) => ({ element: name(element), rect: element.getBoundingClientRect().toJSON() }));
    const reachability = [];
    for (const [index, element] of controlElements.entries()) {
      if (element.closest('.topbar')) scrollTo({ top: 0, left: 0, behavior: 'instant' });
      else element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(x, y);
      if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1
        || rect.bottom > innerHeight + 1 || !hit || !(element === hit || element.contains(hit))) {
        reachability.push({
          index,
          element: name(element),
          rect: rect.toJSON(),
          hit: hit ? name(hit) : null,
        });
      }
    }
    const scrollRoot = document.scrollingElement ?? document.documentElement;
    scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, left: 0, behavior: 'instant' });
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    const maximumScroll = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    const reachedBottom = Math.abs(scrollRoot.scrollTop - maximumScroll) <= 2;
    scrollRoot.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        maximumScroll,
        reachedBottom,
      },
      workflowStep: document.querySelector('[data-workflow-step]')?.getAttribute('data-workflow-step') ?? null,
      counts: {
        controls: controlElements.length,
        radios: document.querySelectorAll('.mirror-mode-panel [role=radio]').length,
        settingSelects: document.querySelectorAll('.mirror-settings select').length,
        randomize: document.querySelectorAll('.randomize-button').length,
        idleActions: document.querySelectorAll('.mirror-mode-panel .stage-actions button').length,
        trackingActions: document.querySelectorAll('[data-workflow-step=tracking] .stage-actions button').length,
        completeActions: document.querySelectorAll('[data-workflow-step=complete] button').length,
        noteInputs: document.querySelectorAll('.pitch-mirror-page [data-note-input]').length,
      },
      labels: {
        playback: [...document.querySelectorAll('.pitch-mirror-page .play-button')]
          .filter(visible).map((element) => element.textContent?.trim() ?? ''),
        attempt: document.querySelector('.mirror-mode-panel .attempt-button')?.textContent?.trim() ?? null,
        localEnableButtons: [...document.querySelectorAll('.pitch-mirror-page button')]
          .filter((element) => /enable voice/iu.test(element.textContent ?? '')).length,
      },
      horizontalEdges,
      maskedOverflow,
      initialControlEdges,
      reachability,
    };
  })()`, true);
}

function assertLayout(layout, viewport, expectedStep) {
  assert(layout.viewport.width === viewport.width && layout.viewport.height === viewport.height,
    `${viewport.label}: Chromium viewport differs from the requested phone size: ${JSON.stringify(layout.viewport)}`);
  assert(layout.document.scrollWidth <= layout.document.clientWidth + 1,
    `${viewport.label}/${expectedStep}: document owns hidden horizontal overflow: ${JSON.stringify(layout.document)}`);
  assert(layout.document.bodyScrollWidth <= layout.document.bodyClientWidth + 1,
    `${viewport.label}/${expectedStep}: body owns hidden horizontal overflow: ${JSON.stringify(layout.document)}`);
  assert(layout.document.reachedBottom,
    `${viewport.label}/${expectedStep}: vertical scrolling could not reach the bottom: ${JSON.stringify(layout.document)}`);
  if (viewport.width <= 430) {
    assert(layout.document.maximumScroll > 0,
      `${viewport.label}/${expectedStep}: the complete workflow reports no vertical scroll range.`);
  }
  assert(layout.workflowStep === expectedStep,
    `${viewport.label}: expected ${expectedStep}, rendered ${layout.workflowStep}.`);
  assert(layout.horizontalEdges.length === 0,
    `${viewport.label}/${expectedStep}: visible content extends beyond the viewport:\n${describeFailures(layout.horizontalEdges)}`);
  assert(layout.maskedOverflow.length === 0,
    `${viewport.label}/${expectedStep}: overflow is clipped or requires hidden horizontal scrolling:\n${describeFailures(layout.maskedOverflow)}`);
  assert(layout.initialControlEdges.length === 0,
    `${viewport.label}/${expectedStep}: controls initially render outside the viewport:\n${describeFailures(layout.initialControlEdges)}`);
  assert(layout.reachability.length === 0,
    `${viewport.label}/${expectedStep}: controls cannot be vertically scrolled into view and hit-tested:\n${describeFailures(layout.reachability)}`);
  assert(layout.counts.noteInputs === 1,
    `${viewport.label}/${expectedStep}: expected one canonical Pitch Match input, found ${layout.counts.noteInputs}.`);
  assert(layout.counts.controls > 0,
    `${viewport.label}/${expectedStep}: no user controls were discovered.`);
  if (expectedStep === "idle") {
    assert(layout.counts.radios === MODES.length,
      `${viewport.label}: expected ${MODES.length} mode controls, found ${layout.counts.radios}.`);
    assert(layout.counts.settingSelects === 3,
      `${viewport.label}: expected three configuration selects, found ${layout.counts.settingSelects}.`);
    assert(layout.counts.randomize === 1 && layout.counts.idleActions === 1,
      `${viewport.label}: idle workflow actions are incomplete: ${JSON.stringify(layout.counts)}`);
    assert(layout.labels.playback.length <= 1
      && layout.labels.playback.every((label) => /^Play\s+\S+/u.test(label)),
    `${viewport.label}: every available isolated note must use the canonical Play/Stop toggle (silent-prep may omit it): ${JSON.stringify(layout.labels)}`);
    assert(layout.labels.attempt === "Start trace",
      `${viewport.label}: the local action must remain “Start trace” regardless of microphone state: ${JSON.stringify(layout.labels)}`);
  } else if (expectedStep === "tracking") {
    assert(layout.counts.trackingActions === 1,
      `${viewport.label}: tracking workflow actions are incomplete: ${JSON.stringify(layout.counts)}`);
    assert(layout.labels.playback.length === 1 && /^Play\s+\S+/u.test(layout.labels.playback[0]),
      `${viewport.label}: tracking must retain the canonical isolated-note Play/Stop toggle: ${JSON.stringify(layout.labels)}`);
  } else {
    assert(layout.counts.completeActions === 1,
      `${viewport.label}: completion workflow action is incomplete: ${JSON.stringify(layout.counts)}`);
  }
  assert(layout.labels.localEnableButtons === 0,
    `${viewport.label}/${expectedStep}: Pitch Match rendered a second local Enable voice action.`);
}

async function proveViewport(session, origin, viewport) {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  });
  await session.send("Page.navigate", { url: `${origin}/#/practice/pitch-match/glide` });
  await waitForBrowser(
    session,
    "document.readyState === 'complete' && Boolean(document.querySelector('[data-workflow-step=idle]'))",
    `${viewport.label} Pitch Match idle workflow`,
  );

  const loadedAssets = await evaluate(session, `[...document.querySelectorAll('script[src]')]
    .map((script) => new URL(script.src, location.href).pathname)`);
  assert(loadedAssets.some((path) => /^\/assets\/index-[A-Za-z0-9_-]+\.js$/u.test(path))
    && loadedAssets.every((path) => !path.includes('/@vite/') && !path.includes('/src/')),
  `${viewport.label}: responsive proof did not load the built application: ${JSON.stringify(loadedAssets)}`);

  for (const [modeIndex, mode] of MODES.entries()) {
    if (modeIndex > 0) {
      await clickVisible(session, ".mirror-mode-panel [role=radio]", modeIndex);
      await waitForBrowser(
        session,
        `location.hash === '#/practice/pitch-match/${mode}'
          && document.querySelectorAll('.mirror-mode-panel [role=radio]')[${modeIndex}]?.getAttribute('aria-checked') === 'true'`,
        `${viewport.label} ${mode} mode route`,
      );
    }
    assertLayout(await inspectLayout(session), viewport, "idle");
  }

  if (!viewport.fullWorkflow) {
    return {
      viewport: viewport.label,
      modes: MODES.length,
      workflowSteps: ["idle"],
    };
  }

  await clickVisible(session, ".mirror-mode-panel [role=radio]", 0);
  await waitForBrowser(session, "location.hash === '#/practice/pitch-match/glide'", `${viewport.label} glide route`);
  await clickVisible(session, "[data-global-mic-enable]");
  await waitForBrowser(
    session,
    "document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'running'",
    `${viewport.label} retained microphone`,
    8_000,
  );
  assertLayout(await inspectLayout(session), viewport, "idle");

  await clickVisible(session, ".mirror-mode-panel .attempt-button");
  await waitForBrowser(session, "Boolean(document.querySelector('[data-workflow-step=tracking]'))", `${viewport.label} tracking workflow`);
  assertLayout(await inspectLayout(session), viewport, "tracking");

  await clickVisible(session, "[data-workflow-step=tracking] .stage-actions button:not(.play-button)");
  await waitForBrowser(session, "Boolean(document.querySelector('[data-workflow-step=complete]'))", `${viewport.label} completion workflow`);
  assertLayout(await inspectLayout(session), viewport, "complete");

  await clickVisible(session, "[data-workflow-step=complete] button");
  await waitForBrowser(session, "Boolean(document.querySelector('[data-workflow-step=idle]'))", `${viewport.label} reset workflow`);
  assertLayout(await inspectLayout(session), viewport, "idle");
  await clickVisible(session, "[data-global-mic-disable]");
  await waitForBrowser(
    session,
    "document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'disabled'",
    `${viewport.label} explicit microphone disable`,
  );
  return {
    viewport: viewport.label,
    modes: MODES.length,
    workflowSteps: ["idle", "tracking", "complete"],
  };
}

async function main() {
  let temporaryDirectory;
  let preview;
  let chromium;
  let session;
  let previewOutput = [];
  let chromiumOutput = [];
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-pitch-match-responsive-"));
    const wavPath = join(temporaryDirectory, "microphone.wav");
    const previewPort = await availablePort();
    const debugPort = await availablePort();
    const origin = `http://127.0.0.1:${previewPort}`;
    await writeFile(wavPath, generatedMicrophoneWav());

    preview = spawn(process.execPath, [
      join(REPOSITORY_ROOT, "node_modules/vite/bin/vite.js"),
      "preview", "--config", join(REPOSITORY_ROOT, "vite.config.ts"),
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
    const browserErrors = [];
    session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      browserErrors.push(exceptionDetails?.exception?.description || exceptionDetails?.text || "browser exception");
    });
    session.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type !== "error") return;
      browserErrors.push(args?.map((argument) => argument.value ?? argument.description).join(" ") || "console error");
    });
    await session.send("Page.enable");
    await session.send("Runtime.enable");

    const results = [];
    for (const viewport of VIEWPORTS) results.push(await proveViewport(session, origin, viewport));
    assert(browserErrors.length === 0, `Browser errors occurred:\n${browserErrors.join("\n")}`);
    console.log("Pitch Match responsive browser proof passed.");
    console.log(JSON.stringify({ results }, null, 2));
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
