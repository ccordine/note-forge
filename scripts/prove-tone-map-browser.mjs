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
import {
  KEYBOARD_VIEWPORT,
  ROOT,
  TOGGLE,
  TRIAL,
  answerGuided,
  assertHiddenAnswer,
  clickMidi,
  clickRadio,
  clickSelector,
  describe,
  guidedMidi,
  inspectHiddenAnswer,
  inspectLayout,
  nextTrial,
  proveKeyboardScrolling,
} from "./proof-support/tone-map-ui.mjs";
import {
  TONE_MAP_VOICE_INSTRUMENTATION_SOURCE,
  proveToneMapVoicePath,
} from "./proof-support/tone-map-voice-browser.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";
const ROUTE = "/practice/note-recognition/map";
const VIEWPORTS = Object.freeze([
  { width: 320, height: 568, label: "320x568" },
  { width: 390, height: 844, label: "390x844" },
]);
async function provePlaybackLifetime(session) {
  await clickSelector(session, TOGGLE, "Play prompt");
  await waitForBrowser(session, `document.querySelector(${JSON.stringify(TOGGLE)})?.getAttribute('aria-pressed') === 'true'`, "prompt playing");
  await delay(1_600);
  const sustained = await evaluate(session, `(() => {
    const toggle = document.querySelector(${JSON.stringify(TOGGLE)});
    return { pressed: toggle?.getAttribute('aria-pressed'), text: toggle?.textContent?.trim() };
  })()`);
  assert(sustained.pressed === "true" && /^Stop\s+prompt$/u.test(sustained.text),
    `The prompt automatically cut off: ${describe(sustained)}`);
  const answered = await answerGuided(session);
  const scrollBeforeNext = await evaluate(session, `document.querySelector(${JSON.stringify(KEYBOARD_VIEWPORT)})?.scrollLeft`);
  assert(await evaluate(session, `document.querySelector(${JSON.stringify(TOGGLE)})?.getAttribute('aria-pressed') === 'true'`),
    "Answering stopped the user-owned prompt.");
  await nextTrial(session);
  const afterNext = await evaluate(session, `(() => {
    const toggle = document.querySelector(${JSON.stringify(TOGGLE)});
    return {
      pressed: toggle?.getAttribute('aria-pressed'),
      text: toggle?.textContent?.trim(),
      scrollLeft: document.querySelector(${JSON.stringify(KEYBOARD_VIEWPORT)})?.scrollLeft,
    };
  })()`);
  assert(afterNext.pressed === "true" && /^Stop\s+prompt$/u.test(afterNext.text),
    `Next stopped or replaced the user-owned prompt: ${describe(afterNext)}`);
  assert(Math.abs(afterNext.scrollLeft - scrollBeforeNext) <= 1,
    `A new hidden target auto-scrolled the keyboard: ${describe({ scrollBeforeNext, afterNext })}`);
  await clickSelector(session, TOGGLE, "Stop prompt");
  await waitForBrowser(session, `document.querySelector(${JSON.stringify(TOGGLE)})?.getAttribute('aria-pressed') === 'false'`, "explicit prompt stop");
  return { displayedMidi: answered.midi, sustainedMilliseconds: 1_600, afterNext };
}

async function reachBlindTrial(session) {
  let guidedAnswers = 1;
  for (; guidedAnswers <= 24; guidedAnswers += 1) {
    const hidden = await inspectHiddenAnswer(session);
    assertHiddenAnswer(hidden, `curriculum trial ${guidedAnswers + 1}`);
    if (hidden.cue === "blind") return guidedAnswers;
    assert(hidden.cue === "guided" && hidden.guidedLabel,
      `Expected guided or blind task, received: ${describe(hidden)}`);
    await answerGuided(session);
    await nextTrial(session);
  }
  throw new Error("The six-tone guided curriculum never yielded a blind trial.");
}

async function createBlindLapseAndRecovery(session) {
  const hidden = await inspectHiddenAnswer(session);
  assertHiddenAnswer(hidden, "blind trial");
  assert(hidden.cue === "blind" && hidden.guidedLabel === null,
    `Blind trial exposed its guided identity: ${describe(hidden)}`);
  let misses = 0;
  let missedTarget = null;
  for (const candidate of [21, 108, 22]) {
    await clickMidi(session, candidate);
    await waitForBrowser(session, "Boolean(document.querySelector('[data-tone-map-review]'))", "blind review");
    const review = await evaluate(session, `(() => {
      const element = document.querySelector('[data-tone-map-review]');
      return {
        target: Number(element?.getAttribute('data-tone-map-target-midi')),
        incorrect: element?.classList.contains('incorrect') ?? false,
        roles: [...document.querySelectorAll(${JSON.stringify(`${KEYBOARD_VIEWPORT} [data-marker-role]`)})]
          .map((marker) => marker.getAttribute('data-marker-role')),
      };
    })()`);
    if (review.incorrect) {
      missedTarget = review.target;
      misses += 1;
      assert(review.roles.includes("wrong") && review.roles.includes("target"),
        `Blind miss review omitted wrong/target evidence: ${describe(review)}`);
      break;
    }
    await nextTrial(session);
    await waitForBrowser(session, `document.querySelector(${JSON.stringify(TRIAL)})?.getAttribute('data-cue-visibility') === 'blind'`, "another blind trial");
  }
  assert(misses === 1 && Number.isInteger(missedTarget), "Could not produce a genuine blind miss without reading its hidden target.");
  const levelBefore = await evaluate(session, "document.querySelector('[data-tone-map-level]')?.getAttribute('data-tone-map-level')");
  await nextTrial(session);
  await waitForBrowser(session, "document.querySelector('[data-tone-map-trial]')?.getAttribute('data-cue-visibility') === 'guided'", "guided lapse recovery");
  const recovery = await guidedMidi(session);
  const levelAfter = await evaluate(session, "document.querySelector('[data-tone-map-level]')?.getAttribute('data-tone-map-level')");
  assert(recovery?.midi === missedTarget,
    `The missed tone did not return through guided recovery: ${describe({ missedTarget, recovery })}`);
  assert(levelAfter === levelBefore, `A blind miss reset or changed the unrelated course level: ${levelBefore} -> ${levelAfter}`);
  return { missedTarget, recovery, level: levelAfter };
}

async function proveSimon(session) {
  await clickRadio(session, "Challenge", "Simon sequence");
  await waitForBrowser(session, "Boolean(document.querySelector('[data-tone-map-challenge=simon]'))", "Simon sequence mode");
  const hidden = await evaluate(session, `(() => {
    const root = document.querySelector('[data-tone-map-challenge=simon]');
    const keyboard = root?.querySelector(${JSON.stringify(KEYBOARD_VIEWPORT)});
    const position = root?.querySelector('.tone-map-simon__position span')?.textContent?.trim() ?? '';
    const match = position.match(/^(\\d+)\\/(\\d+) entered$/u);
    return {
      keys: keyboard?.querySelectorAll('[data-midi]').length ?? 0,
      labels: keyboard?.querySelectorAll('.piano-keyboard__label').length ?? 0,
      markers: keyboard?.querySelectorAll('[data-marker-role]').length ?? 0,
      targetAttributes: root?.querySelectorAll('[data-target-midi],[data-tone-map-target-midi]').length ?? 0,
      review: root?.querySelectorAll('.tone-map-simon__review').length ?? 0,
      visibleText: root?.textContent ?? '',
      entered: match ? Number(match[1]) : null,
      total: match ? Number(match[2]) : null,
    };
  })()`);
  assert(hidden.keys === 88 && hidden.labels === 0 && hidden.markers === 0
    && hidden.targetAttributes === 0 && hidden.review === 0 && hidden.entered === 0,
  `Simon exposed sequence identities before the complete answer: ${describe(hidden)}`);
  assert(Number.isInteger(hidden.total) && hidden.total >= 2,
    `Simon did not expose an answer count without exposing identities: ${describe(hidden)}`);

  const answers = [48, 52, 55, 59, 62, 65, 69, 72].slice(0, hidden.total);
  const readyLock = await evaluate(session, `(() => {
    const root = document.querySelector('[data-tone-map-challenge=simon]');
    const key = root?.querySelector('[data-midi="' + ${answers[0]} + '"]');
    key?.click();
    return {
      phase: root?.querySelector('[data-simon-phase]')?.getAttribute('data-simon-phase'),
      disabled: key instanceof HTMLButtonElement ? key.disabled : null,
      position: root?.querySelector('.tone-map-simon__position span')?.textContent?.trim(),
    };
  })()`);
  assert(readyLock.phase === "ready-to-play" && readyLock.disabled && readyLock.position === `0/${hidden.total} entered`,
    `Simon accepted an answer before Play: ${describe(readyLock)}`);

  await clickSelector(session, ".tone-map-simon .play-button", "Play Simon sequence");
  await waitForBrowser(session,
    "document.querySelector('[data-simon-phase]')?.getAttribute('data-simon-phase') === 'playing'",
    "Simon authored playback");
  const playbackLock = await evaluate(session, `(() => {
    const root = document.querySelector('[data-tone-map-challenge=simon]');
    const key = root?.querySelector('[data-midi="' + ${answers[0]} + '"]');
    key?.click();
    return {
      phase: root?.querySelector('[data-simon-phase]')?.getAttribute('data-simon-phase'),
      disabled: key instanceof HTMLButtonElement ? key.disabled : null,
      position: root?.querySelector('.tone-map-simon__position span')?.textContent?.trim(),
    };
  })()`);
  assert(playbackLock.phase === "playing" && playbackLock.disabled && playbackLock.position === `0/${hidden.total} entered`,
    `Simon accepted an answer during authored playback: ${describe(playbackLock)}`);
  await clickSelector(session, ".tone-map-simon .play-button", "Stop Simon sequence");
  await waitForBrowser(session,
    "document.querySelector('[data-simon-phase]')?.getAttribute('data-simon-phase') === 'ready-to-play'",
    "Simon ready state after explicit Stop");
  const stopped = await evaluate(session, `(() => {
    const root = document.querySelector('[data-tone-map-challenge=simon]');
    const key = root?.querySelector('[data-midi="' + ${answers[0]} + '"]');
    key?.click();
    return {
      disabled: key instanceof HTMLButtonElement ? key.disabled : null,
      position: root?.querySelector('.tone-map-simon__position span')?.textContent?.trim(),
    };
  })()`);
  assert(stopped.disabled && stopped.position === `0/${hidden.total} entered`,
    `Explicit Stop incorrectly unlocked Simon answers: ${describe(stopped)}`);
  await clickSelector(session, ".tone-map-simon .play-button", "Replay complete Simon sequence");
  await waitForBrowser(session,
    "document.querySelector('[data-simon-phase]')?.getAttribute('data-simon-phase') === 'playing'",
    "restarted Simon authored playback");
  await waitForBrowser(session,
    "document.querySelector('[data-simon-phase]')?.getAttribute('data-simon-phase') === 'answering'",
    "Simon answer phase after natural sequence completion",
    8_000);

  for (let index = 0; index < answers.length; index += 1) {
    await clickMidi(session, answers[index]);
    const expected = index + 1;
    await waitForBrowser(session,
      `document.querySelector('.tone-map-simon__position span')?.textContent?.trim().startsWith('${expected}/')`,
      `Simon answer ${expected}`);
    if (expected === 1) {
      await delay(1_600);
      const unchanged = await evaluate(session, `({
        position: document.querySelector('.tone-map-simon__position span')?.textContent?.trim(),
        review: Boolean(document.querySelector('.tone-map-simon__review')),
      })`);
      assert(unchanged.position === `1/${hidden.total} entered` && !unchanged.review,
        `Simon imposed a deadline or reviewed an incomplete sequence: ${describe(unchanged)}`);
    }
    const hasReview = await evaluate(session, "Boolean(document.querySelector('.tone-map-simon__review'))");
    assert(hasReview === (expected === hidden.total),
      `Simon review authority was wrong after ${expected}/${hidden.total} answers.`);
  }
  const review = await evaluate(session, `({
    positions: document.querySelectorAll('.tone-map-simon__review li').length,
    targets: [...document.querySelectorAll('.tone-map-simon__review li > span')]
      .map((element) => element.textContent?.trim() ?? ''),
    labels: document.querySelectorAll(${JSON.stringify(`${KEYBOARD_VIEWPORT} .piano-keyboard__label`)}).length,
    next: [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Next sequence'),
  })`);
  assert(review.positions === hidden.total && review.labels === 88 && review.next,
    `Completed Simon answer did not reveal one review per position: ${describe(review)}`);
  assert(review.targets.every((target) => target && !hidden.visibleText.includes(target)),
    `A Simon target identity was visible before the full answer: ${describe({ hidden: hidden.visibleText, targets: review.targets })}`);
  await clickSelector(session, ".tone-map-simon > .action-button", "Next sequence");
  await waitForBrowser(session, "!document.querySelector('.tone-map-simon__review')", "explicit next Simon sequence");
  return { length: hidden.total, waitedWithoutDeadlineMilliseconds: 1_600 };
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
  await session.send("Page.navigate", { url: "about:blank" });
  await waitForBrowser(session, "location.href === 'about:blank'", `${viewport.label} blank reset`);
  await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
  await session.send("Page.navigate", { url: `${origin}/#${ROUTE}` });
  await waitForBrowser(session,
    `location.hash === ${JSON.stringify(`#${ROUTE}`)} && Boolean(document.querySelector(${JSON.stringify(ROOT)}))`,
    `${viewport.label} hydrated Tone Map`, 15_000);

  const assets = await evaluate(session, `[...document.querySelectorAll('script[src]')]
    .map((script) => new URL(script.src, location.href).pathname)`);
  assert(assets.some((path) => /^\/assets\/index-[A-Za-z0-9_-]+\.js$/u.test(path))
    && assets.every((path) => !path.includes('/@vite/') && !path.includes('/src/')),
  `${viewport.label}: Tone Map did not load the production bundle: ${describe(assets)}`);

  const layout = await inspectLayout(session);
  assert(layout.viewport.width === viewport.width && layout.viewport.height === viewport.height,
    `${viewport.label}: Chromium viewport mismatch: ${describe(layout.viewport)}`);
  assert(layout.document.scrollWidth <= layout.document.clientWidth + 1
    && layout.document.bodyScrollWidth <= layout.document.bodyClientWidth + 1,
  `${viewport.label}: the document owns horizontal overflow: ${describe(layout.document)}`);
  assert(layout.document.reachedBottom && layout.document.maximumY > 0,
    `${viewport.label}: the page's vertical end is unreachable: ${describe(layout.document)}`);
  assert(layout.keyboard && layout.keyboard.scrollWidth > layout.keyboard.clientWidth + 1,
    `${viewport.label}: the full keyboard is not independently scrollable: ${describe(layout.keyboard)}`);
  assert(layout.initial.keyboardScrollLeft === 0 && layout.initial.rootScrollLeft === 0
    && layout.initial.bodyScrollLeft === 0,
  `${viewport.label}: a hidden target or document auto-scrolled before input: ${describe(layout.initial)}`);

  const initialHidden = await inspectHiddenAnswer(session);
  assertHiddenAnswer(initialHidden, `${viewport.label} fresh guided trial`);
  assert(initialHidden.cue === "guided" && initialHidden.guidedLabel,
    `${viewport.label}: a fresh course did not begin with guided association: ${describe(initialHidden)}`);
  const scrolling = await proveKeyboardScrolling(session);
  assert(!scrolling.error && scrolling.maximum > 0 && scrolling.restored === 0,
    `${viewport.label}: keyboard did not traverse its local range: ${describe(scrolling)}`);
  assert(scrolling.results.every((probe) => probe.hit && probe.documentScrollLeft === 0 && probe.bodyScrollLeft === 0),
    `${viewport.label}: first/middle/last keys were not locally hit-testable: ${describe(scrolling)}`);
  assert(Math.abs(scrolling.results[0].actual) <= 1
    && Math.abs(scrolling.results.at(-1).actual - scrolling.maximum) <= 1,
  `${viewport.label}: keyboard did not move from x=0 through its maximum: ${describe(scrolling)}`);

  const playback = await provePlaybackLifetime(session);
  const guidedAnswers = await reachBlindTrial(session);
  const recovery = await createBlindLapseAndRecovery(session);
  const simon = await proveSimon(session);
  return {
    viewport: viewport.label,
    document: layout.document,
    keyboard: layout.keyboard,
    keyboardProbes: scrolling.results.map(({ midi, actual, hit }) => ({ midi, scrollLeft: actual, hit })),
    playback,
    guidedAnswersBeforeBlind: guidedAnswers,
    recovery,
    simon,
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
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-tone-map-proof-"));
    const previewPort = await availablePort();
    const debugPort = await availablePort();
    const origin = `http://127.0.0.1:${previewPort}`;
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
      `--user-data-dir=${join(temporaryDirectory, "profile")}`,
      `--remote-debugging-port=${debugPort}`, "about:blank",
    ], { cwd: REPOSITORY_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    chromiumOutput = captureProcessOutput(chromium, "chromium");
    const target = await waitForPageTarget(debugPort, chromium, chromiumOutput);
    session = new DevToolsSession(target.webSocketDebuggerUrl);
    await session.connect();
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: TONE_MAP_VOICE_INSTRUMENTATION_SOURCE,
    });

    const browserErrors = [];
    session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      browserErrors.push(exceptionDetails?.exception?.description || exceptionDetails?.text || "browser exception");
    });
    session.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type !== "error") return;
      browserErrors.push(args?.map((argument) => argument.value ?? argument.description).join(" ") || "console error");
    });

    const results = [];
    for (const viewport of VIEWPORTS) results.push(await proveViewport(session, origin, viewport));
    const voice = await proveToneMapVoicePath(session, origin, ROUTE);
    assert(browserErrors.length === 0, `Browser errors occurred:\n${browserErrors.join("\n")}`);
    console.log("Tone Map production browser proof passed.");
    console.log(JSON.stringify({ route: ROUTE, results, voice }, null, 2));
  } catch (error) {
    if (session) {
      const screenshot = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile("/tmp/noteforge-tone-map-failure.png", Buffer.from(screenshot.data, "base64"));
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
