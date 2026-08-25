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

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";
const VIEWPORTS = Object.freeze([
  { width: 320, height: 568, label: "320x568" },
  { width: 390, height: 844, label: "390x844" },
]);
const TOGGLE = "[data-note-playback-toggle=true]";
const INTENTIONAL_HORIZONTAL_SCROLL = [
  ".sound-lab-keyboard-scroll",
  ".piano-keyboard-scroll",
  ".family-keyboard-wrap",
].join(",");
const ROUTES = Object.freeze([
  { label: "Pitch Match", path: "/practice/pitch-match/glide", root: ".pitch-mirror-page" },
  { label: "Range Loop", path: "/practice/range-loop", root: ".range-loop-page" },
  { label: "Range Simulator", path: "/progress/range-map", root: ".range-simulator-page" },
  { label: "Interval Production", path: "/practice/intervals/production", root: ".interval-page .production" },
  { label: "Note Recognition letters", path: "/practice/note-recognition/letters", root: ".ear-page .family-prompt-card" },
  { label: "Harmony production", path: "/practice/harmony/scale-degree-production", root: ".harmony-page .degree-production" },
  { label: "Harmony chord tone", path: "/practice/harmony/chord-tone", root: ".harmony-page .selected-function-card" },
  { label: "Sound Lab note", path: "/explore/sound/note", root: ".sound-lab-page" },
  {
    label: "Echo Run sight preview",
    path: "/arcade/pattern",
    root: ".arcade-page.mode-pattern",
    prepare: `(() => {
      const sight = [...document.querySelectorAll('.arcade-mode-toggle [role=radio]')]
        .find((element) => /sight run/iu.test(element.textContent ?? ''));
      if (!(sight instanceof HTMLElement)) return false;
      sight.click();
      const prepare = [...document.querySelectorAll('button')]
        .find((element) => /prepare phrase/iu.test(element.textContent ?? ''));
      if (!(prepare instanceof HTMLElement)) return false;
      prepare.click();
      return true;
    })()`,
  },
  { label: "Pitch Maze", path: "/arcade/maze", root: ".arcade-page.mode-maze" },
  { label: "Resonance", path: "/arcade/resonance", root: ".arcade-page.mode-resonance" },
]);

function formatFailures(items) {
  return items.map((item) => JSON.stringify(item)).join("\n");
}

async function inspect(session) {
  return evaluate(session, `(async () => {
    document.documentElement.style.scrollBehavior = 'auto';
    document.body.style.scrollBehavior = 'auto';
    for (const details of document.querySelectorAll('details')) details.open = true;
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    const scrollRoot = document.scrollingElement ?? document.documentElement;
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const name = (element) => {
      const classes = [...element.classList].slice(0, 4).join('.');
      return [element.tagName.toLowerCase(), classes && '.' + classes].filter(Boolean).join('');
    };
    const toggle = document.querySelector(${JSON.stringify(TOGGLE)});
    const toggleState = [];
    if (toggle instanceof HTMLElement) {
      toggle.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      const rect = toggle.getBoundingClientRect();
      const centerX = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const centerY = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(centerX, centerY);
      toggleState.push({
        text: toggle.textContent?.trim() ?? '',
        pressed: toggle.getAttribute('aria-pressed'),
        rect: rect.toJSON(),
        hit: Boolean(hit && (hit === toggle || toggle.contains(hit))),
      });
    }

    const controls = [...document.querySelectorAll('button,select,input:not([type=hidden]),summary,a[href]')]
      .filter((element) => visible(element) && !element.closest(${JSON.stringify(INTENTIONAL_HORIZONTAL_SCROLL)}));
    const unreachable = [];
    for (const element of controls) {
      element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      const rect = element.getBoundingClientRect();
      const centerX = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const centerY = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(centerX, centerY);
      if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1
        || rect.bottom > innerHeight + 1 || !hit || !(hit === element || element.contains(hit))) {
        unreachable.push({
          element: name(element),
          text: element.textContent?.trim().slice(0, 80),
          rect: rect.toJSON(),
          hit: hit ? name(hit) : null,
          hitText: hit?.textContent?.trim().slice(0, 80) ?? null,
          hitControl: hit?.closest('button,select,input,summary,a[href]') ? name(hit.closest('button,select,input,summary,a[href]')) : null,
        });
      }
    }

    const clipped = [...document.querySelectorAll('.page,.panel,.range-loop-toolbar,.range-sim-toolbar,.production-actions,.resonance-actions,.arcade-persistent-note-control,.pitch-slots,.selected-function-card')]
      .filter((element) => visible(element) && !element.closest(${JSON.stringify(INTENTIONAL_HORIZONTAL_SCROLL)}))
      .filter((element) => {
        const style = getComputedStyle(element);
        return element.scrollWidth > element.clientWidth + 1
          && ['hidden', 'clip', 'visible'].includes(style.overflowX);
      })
      .map((element) => ({
        element: name(element),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: getComputedStyle(element).overflowX,
      }));
    const horizontalEdges = [...document.body.querySelectorAll('*')]
      .filter((element) => visible(element) && !element.closest(${JSON.stringify(INTENTIONAL_HORIZONTAL_SCROLL)}))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      })
      .map((element) => ({ element: name(element), text: element.textContent?.trim().slice(0, 80), rect: element.getBoundingClientRect().toJSON() }))
      .slice(0, 20);

    scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, left: 0, behavior: 'instant' });
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    const maximumScroll = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    const reachedBottom = Math.abs(scrollRoot.scrollTop - maximumScroll) <= 2;
    scrollRoot.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    return {
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        scrollHeight: scrollRoot.scrollHeight,
        maximumScroll,
        reachedBottom,
      },
      toggles: document.querySelectorAll(${JSON.stringify(TOGGLE)}).length,
      toggleState,
      unreachable,
      clipped,
      horizontalEdges,
      pitchSlots: [...document.querySelectorAll('.pitch-slots > *')].map((element) => ({
        element: name(element),
        text: element.textContent?.trim().slice(0, 50),
        rect: element.getBoundingClientRect().toJSON(),
        position: getComputedStyle(element).position,
        transform: getComputedStyle(element).transform,
      })),
    };
  })()`, true);
}

function assertLayout(result, viewport, route, state) {
  const prefix = `${viewport.label} / ${route.label} / ${state}`;
  assert(result.document.scrollWidth <= result.document.clientWidth + 1,
    `${prefix}: document horizontal overflow: ${JSON.stringify(result.document)}`);
  assert(result.document.bodyScrollWidth <= result.document.bodyClientWidth + 1,
    `${prefix}: body horizontal overflow: ${JSON.stringify(result.document)}\n${formatFailures(result.horizontalEdges)}`);
  assert(result.document.reachedBottom, `${prefix}: page cannot reach its vertical end.`);
  assert(result.toggles >= 1, `${prefix}: no canonical note playback toggle rendered.`);
  assert(result.toggleState.length === 1 && result.toggleState[0].hit,
    `${prefix}: playback toggle is clipped or covered: ${JSON.stringify(result.toggleState)}`);
  const toggleRect = result.toggleState[0].rect;
  assert(toggleRect.left >= -1 && toggleRect.right <= viewport.width + 1,
    `${prefix}: playback toggle extends outside viewport: ${JSON.stringify(toggleRect)}`);
  assert(result.unreachable.length === 0,
    `${prefix}: controls cannot be reached and hit-tested:\n${formatFailures(result.unreachable)}\nPitch slots: ${formatFailures(result.pitchSlots)}`);
  assert(result.clipped.length === 0,
    `${prefix}: a surface clips horizontal content:\n${formatFailures(result.clipped)}`);
}

async function clickToggle(session) {
  return evaluate(session, `(() => {
    const toggle = document.querySelector(${JSON.stringify(TOGGLE)});
    if (!(toggle instanceof HTMLButtonElement)) return false;
    toggle.click();
    return true;
  })()`);
}

async function proveRoute(session, origin, viewport, route) {
  await session.send("Page.navigate", { url: `${origin}/#${route.path}` });
  await waitForBrowser(
    session,
    `location.hash === ${JSON.stringify(`#${route.path}`)} && Boolean(document.querySelector(${JSON.stringify(route.root)}))`,
    `${viewport.label} ${route.label} page`,
  );
  if (route.prepare) {
    await waitForBrowser(session, "Boolean(document.querySelector('.arcade-mode-toggle'))", `${viewport.label} ${route.label} setup`);
    assert(await evaluate(session, route.prepare), `${viewport.label} ${route.label}: could not prepare the requested mode.`);
  }
  await waitForBrowser(session, `(() => {
    const toggle = document.querySelector(${JSON.stringify(TOGGLE)});
    return toggle instanceof HTMLElement && toggle.getBoundingClientRect().width > 0;
  })()`, `${viewport.label} ${route.label} playback toggle`);

  const stopped = await inspect(session);
  assertLayout(stopped, viewport, route, "Play");
  assert(stopped.toggleState[0].pressed === "false" && /^Play\b/u.test(stopped.toggleState[0].text),
    `${viewport.label} ${route.label}: stopped toggle has the wrong state/copy: ${JSON.stringify(stopped.toggleState)}`);

  assert(await clickToggle(session), `${viewport.label} ${route.label}: playback toggle disappeared before activation.`);
  await waitForBrowser(session, `document.querySelector(${JSON.stringify(TOGGLE)})?.getAttribute('aria-pressed') === 'true'`, `${viewport.label} ${route.label} playing state`);
  const playing = await inspect(session);
  assertLayout(playing, viewport, route, "Stop");
  assert(/^Stop\b/u.test(playing.toggleState[0].text),
    `${viewport.label} ${route.label}: playing toggle has the wrong copy: ${JSON.stringify(playing.toggleState)}`);

  assert(await clickToggle(session), `${viewport.label} ${route.label}: playback toggle disappeared before stop.`);
  await waitForBrowser(session, `document.querySelector(${JSON.stringify(TOGGLE)})?.getAttribute('aria-pressed') === 'false'`, `${viewport.label} ${route.label} stopped state`);
  const stoppedAgain = await inspect(session);
  assertLayout(stoppedAgain, viewport, route, "Play again");
  assert(stoppedAgain.toggleState[0].pressed === "false"
    && /^Play\b/u.test(stoppedAgain.toggleState[0].text),
  `${viewport.label} ${route.label}: explicit Stop did not restore the Play toggle: ${JSON.stringify(stoppedAgain.toggleState)}`);
  return {
    route: route.path,
    unreachableControls: stopped.unreachable.length,
    pageWidth: stopped.document.clientWidth,
    pageHeight: stopped.document.scrollHeight,
    playCopy: stopped.toggleState[0].text,
    stopCopy: playing.toggleState[0].text,
    replayCopy: stoppedAgain.toggleState[0].text,
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
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-mobile-playback-layout-"));
    const previewPort = await availablePort();
    const debugPort = await availablePort();
    const origin = `http://127.0.0.1:${previewPort}`;
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
      `--user-data-dir=${join(temporaryDirectory, "profile")}`,
      `--remote-debugging-port=${debugPort}`, "about:blank",
    ], { cwd: REPOSITORY_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    chromiumOutput = captureProcessOutput(chromium, "chromium");
    const target = await waitForPageTarget(debugPort, chromium, chromiumOutput);
    session = new DevToolsSession(target.webSocketDebuggerUrl);
    await session.connect();
    await session.send("Page.enable");
    await session.send("Runtime.enable");

    const browserErrors = [];
    session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      browserErrors.push(exceptionDetails?.exception?.description || exceptionDetails?.text || "browser exception");
    });
    session.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type !== "error") return;
      browserErrors.push(args?.map((argument) => argument.value ?? argument.description).join(" ") || "console error");
    });

    const results = [];
    for (const viewport of VIEWPORTS) {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: true,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
      });
      for (const route of ROUTES) results.push({ viewport: viewport.label, ...await proveRoute(session, origin, viewport, route) });
    }
    assert(browserErrors.length === 0, `Browser errors occurred:\n${browserErrors.join("\n")}`);
    console.log("Mobile note playback layout proof passed.");
    console.log(JSON.stringify({ results }, null, 2));
  } catch (error) {
    if (session) {
      const screenshot = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile("/tmp/noteforge-mobile-layout-failure.png", Buffer.from(screenshot.data, "base64"));
    }
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
