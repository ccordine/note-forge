import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  amplitudeToDbfs,
  analyzeImmediatePitchTransitions,
  browserProofSnapshot,
  canonicalFrameKey,
  collectRenderedNotes,
  expectedRenderedTransitions,
  formatImmediatePitchTransitions,
  includesContiguousSequence,
  includesOrderedSequence,
  immediatePitchTransitionFailures,
  lastWorkletSample,
  longestMatchingRun,
  maximumElapsedGap,
  missingValues,
  orderedPitchEvents,
  pitchFramesFrom,
  renderedFrameContinuity,
  renderedNoteSample,
  uniqueExpectedRenderedNotes,
  waitForDiagnosticCount,
} from "./proof-support/note-input-analysis.mjs";
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
import {
  CAPTURE_HOP_BUDGET_MS,
  CAPTURE_HOP_SAMPLES,
  CAPTURE_WINDOW_SAMPLES,
  EXPECTED_MIDIS,
  EXPECTED_NOTES,
  generatedMicrophoneWav,
  HIGHEST_SUPPORTED_MIDI,
  IMMEDIATE_CHANGE_MIDIS,
  IMMEDIATE_CHANGE_SEGMENT_SAMPLES,
  LOWEST_SUPPORTED_MIDI,
  noteLabel,
  OLD_GATE_RMS_AMPLITUDE,
  OLD_GATE_RMS_DBFS,
  QUIET_LOW_LABELS,
  QUIET_LOW_MIDIS,
  QUIET_LOW_NOTES,
  SAMPLE_RATE,
  SUPPORTED_MAX_FREQUENCY_HZ,
  SUPPORTED_MIN_FREQUENCY_HZ,
} from "./proof-support/note-input-fixture.mjs";
import { BROWSER_INSTRUMENTATION_SOURCE } from "./proof-support/note-input-instrumentation.mjs";
import {
  analyzePitchMeterProof,
  pitchMeterProofFailures,
} from "./proof-support/pitch-meter-proof.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";

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
    const pageUrl = `http://127.0.0.1:${vitePort}/#/practice/pitch-match/glide`;
    await writeFile(wavPath, generatedMicrophoneWav());
    const builtServiceWorker = await readFile(
      join(REPOSITORY_ROOT, "dist/sw.js"),
      "utf8",
    );
    assert(!builtServiceWorker.includes("__NOTEFORGE_"),
      "Run npm run build before the microphone proof; the service worker is unstamped.");
    const precacheMatch = builtServiceWorker.match(/const PRECACHE = (\[[^\n]*\]);/u);
    assert(precacheMatch,
      "The stamped service worker does not contain a readable precache manifest.");
    const stampedPrecache = JSON.parse(precacheMatch[1]);
    assert(Array.isArray(stampedPrecache),
      "The stamped service-worker precache manifest is not an array.");

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
      source: BROWSER_INSTRUMENTATION_SOURCE,
    });

    await session.send("Page.navigate", { url: pageUrl });
    await waitForBrowser(
      session,
      "document.readyState === 'complete' && Boolean(document.querySelector('[data-global-mic-enable]'))",
      "the global voice input control above Pitch Match",
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
    await enableRemotePitchDiagnostics(session);
    const clicked = await evaluate(session, `(() => {
      const button = document.querySelector('[data-global-mic-enable]');
      button?.click();
      return Boolean(button);
    })()`);
    assert(clicked, "The sole global Enable voice control was not clickable.");
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
      "document.querySelector('[role=\"radiogroup\"][aria-label=\"Mode\"] [role=\"radio\"][aria-checked=\"true\"]')?.textContent?.trim() === 'Delayed' && document.querySelector('.pitch-mirror-page [data-note-playback-toggle=\"true\"][aria-pressed=\"false\"]')?.textContent?.trim() === 'Play C4'",
      "Pitch Mirror Delayed mode",
    );
    const attemptClicked = await evaluate(session, `(() => {
      const button = document.querySelector('[data-pitch-mirror-action="start-trace"]');
      button?.click();
      return Boolean(button && !button.disabled);
    })()`);
    assert(attemptClicked, "Pitch Mirror's real Start trace control was not clickable.");
    await waitForBrowser(
      session,
      "document.querySelector('.mirror-stage.active .stage-status > span')?.textContent?.trim() === 'MEASURING LIVE STREAM'",
      "Pitch Mirror's active live trace",
    );
    await waitForBrowser(
      session,
      "Number(document.querySelector('[data-note-input]')?.getAttribute('data-frame-count')) >= 2 && Boolean(document.querySelector('[data-detected-note]')?.getAttribute('data-detected-note'))",
      "detector frames during the Pitch Mirror trace",
    );
    const promptStartProof = await browserProofSnapshot(session);
    const promptSamples = await collectRenderedNotes(session, 5_200);
    const promptEndProof = await browserProofSnapshot(session);
    const liveTraceAfterFormerCutoff = await evaluate(session, `(() => {
      const stage = document.querySelector('[data-workflow-step="tracking"][data-trace-lifetime="user-owned"]');
      const elapsed = Number.parseFloat(stage?.querySelector('.stage-status > b')?.textContent || 'NaN');
      return { active: Boolean(stage), elapsed };
    })()`);
    assert(liveTraceAfterFormerCutoff.active && liveTraceAfterFormerCutoff.elapsed > 4,
      `Pitch Mirror stopped at its former cutoff: ${JSON.stringify(liveTraceAfterFormerCutoff)}.`);
    const promptContinuity = renderedFrameContinuity(promptSamples, "Pitch Mirror live trace");
    assert(promptContinuity.lastCount - promptContinuity.firstCount >= 6,
      `Pitch Mirror's trace frame count advanced only ${promptContinuity.firstCount}->${promptContinuity.lastCount}.`);
    assert(promptContinuity.lastTime > promptContinuity.firstTime,
      `Pitch Mirror's detector time did not advance during the trace (${promptContinuity.firstTime}->${promptContinuity.lastTime}).`);
    assert(promptSamples.every((sample) => sample.inputState === "running"),
      `Voice input stopped during Pitch Mirror's live trace: ${JSON.stringify(promptSamples)}`);
    assert(promptSamples.some((sample) => sample.note === null),
      "The extended live trace never exercised ordinary unvoiced evidence.");
    assert(promptSamples.some((sample) => sample.note !== null),
      "The extended live trace never exercised voiced evidence.");
    assert(promptSamples.some((sample) => sample.note === noteLabel(LOWEST_SUPPORTED_MIDI)),
      `Pitch Mirror's live trace never rendered the opening ${noteLabel(LOWEST_SUPPORTED_MIDI)}.`);
    const finishClicked = await evaluate(session, `(() => {
      const button = document.querySelector('[data-pitch-mirror-action="finish-trace"]');
      button?.click();
      return Boolean(button && !button.disabled);
    })()`);
    assert(finishClicked, "Pitch Mirror's real Finish trace control was not clickable.");
    await waitForBrowser(
      session,
      "!document.querySelector('.mirror-stage.active')",
      "Pitch Mirror trace completion",
    );

    // The visible Pitch Mirror remains mounted for the complete MIDI 30-86
    // sweep, so production diagnostics and the real readout must both cover it.
    const beforeNavigationSamples = await collectRenderedNotes(session, 19_700);
    await delay(1_200);
    const beforeNavigationProof = await browserProofSnapshot(session);
    const beforeNavigationEndSample = lastWorkletSample(beforeNavigationProof)?.endSample ?? -1;
    const navigationMark = await evaluate(session, "performance.now()");
    await evaluate(session, "location.hash = '#/explore/sound/dyad'; true");
    await waitForBrowser(
      session,
      "location.hash === '#/explore/sound/dyad' && Boolean(document.querySelector('.sound-lab-page')) && !document.querySelector('[data-note-input]')",
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

    await evaluate(session, "location.hash = '#/practice/hum/anchor'; true");
    await waitForBrowser(
      session,
      "location.hash === '#/practice/hum/anchor' && Boolean(document.querySelector('.input-scope.running'))",
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
      `Production stopped the microphone before the explicit global Disable click: ${JSON.stringify(beforeStopProof.trackStopCalls)}`);
    assert(preStopFalseWrites.length === 0,
      `Production disabled the microphone before the explicit global Disable click: ${JSON.stringify(preStopFalseWrites)}`);
    const stopArmed = await evaluate(session, `(() => {
      const proofControl = window.__noteforgeNoteInputProof;
      const button = document.querySelector('button[data-global-mic-disable]');
      if (!proofControl || !button || button.disabled) return false;
      return proofControl.armStopOnNextSample();
    })()`);
    assert(stopArmed, "The real enabled global microphone Disable control was unavailable.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'disabled'",
      "the explicit global microphone Disable action",
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
    const processingMaximumIndex = processingMilliseconds.indexOf(processingMaximumMs);
    const processingMaximumFrame = allFrames[processingMaximumIndex] ?? null;
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
      if (diagnostic.voiced && diagnostic.midiFloat !== null) {
        const meter = observation.meter;
        const meterMatches = meter
          && meter.scale?.startsWith("full-")
          && Number.isFinite(meter.liveMidi)
          // The diagnostics transport intentionally rounds midiFloat to four
          // decimal places; sample identity remains exact.
          && Math.abs(meter.liveMidi - diagnostic.midiFloat) <= 1e-4
          && Number.isFinite(meter.declaredPositionPercent)
          && meter.declaredPositionPercent >= 0
          && meter.declaredPositionPercent <= 100
          && Number.isFinite(meter.markerInlinePositionPercent)
          && Math.abs(
            meter.markerInlinePositionPercent - meter.declaredPositionPercent,
          ) <= 1e-3
          && Number.isFinite(meter.markerComputedLeftPixels)
          && Number.isFinite(meter.markerCenterPercent)
          && Number.isFinite(meter.widthPixels)
          && meter.widthPixels > 0;
        if (!meterMatches) {
          domFrameClaimFailures.push(
            `${key}: voiced detector frame omitted its exact full-depth rendered meter coordinate ${JSON.stringify(meter)}`,
          );
        }
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

    const immediateChangeProof = analyzeImmediatePitchTransitions({
      diagnosticFrames,
      presentationClaims: settledProof.pitchPresentationClaims,
      renderedFrames: settledProof.domFrameMutations,
      expectedMidis: IMMEDIATE_CHANGE_MIDIS,
      labelForMidi: noteLabel,
    });
    const immediateChangeFailures = immediatePitchTransitionFailures(
      immediateChangeProof,
      {
        hopSamples: CAPTURE_HOP_SAMPLES,
        maximumSegmentSamples:
          IMMEDIATE_CHANGE_SEGMENT_SAMPLES + CAPTURE_WINDOW_SAMPLES,
      },
    );
    const meterPresentationProof = analyzePitchMeterProof({
      settledProof,
      diagnosticFrames,
      diagnosticByFrame,
      immediateChangeProof,
    });
    const {
      meterSweepProof,
      computedMeterPositions,
      ribbonProof,
    } = meterPresentationProof;
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

    // The former four-second cutoff proof now covers part of the same pitch
    // sweep. Treat the entire continuously mounted Pitch Mirror interval as
    // one UI observation sequence.
    const pitchMirrorSamples = [...promptSamples, ...beforeNavigationSamples];
    const renderedBefore = uniqueExpectedRenderedNotes(pitchMirrorSamples);
    const renderedAfter = uniqueExpectedRenderedNotes(afterNavigationSamples);
    const renderedAll = new Set([...renderedBefore, ...renderedAfter]);
    const transitionsBefore = expectedRenderedTransitions(pitchMirrorSamples);
    const transitionsAfter = expectedRenderedTransitions(afterNavigationSamples);
    const missingRenderedRange = EXPECTED_NOTES
      .map(({ label }) => label)
      .filter((label) => !renderedAll.has(label));
    const diagnosticFrameForRenderedSample = (sample) =>
      diagnosticByFrame.get(canonicalFrameKey(sample))?.pitch?.frame ?? null;
    const quietRenderedSamples = afterNavigationSamples.filter((sample) => {
      const frame = diagnosticFrameForRenderedSample(sample);
      return QUIET_LOW_LABELS.has(sample.note)
        && frame?.voiced === true
        && frame.rms > 0
        && frame.rms < OLD_GATE_RMS_AMPLITUDE;
    });
    const quietRenderedLabels = new Set(quietRenderedSamples.map((sample) => sample.note));
    const missingQuietRendered = QUIET_LOW_NOTES
      .map(({ label }) => label)
      .filter((label) => !quietRenderedLabels.has(label));
    const quietRenderedTransitions = expectedRenderedTransitions(quietRenderedSamples);
    const weakQuietRuns = QUIET_LOW_NOTES.map(({ label }) => ({
      label,
      run: longestMatchingRun(afterNavigationSamples, (sample) => {
        const frame = diagnosticFrameForRenderedSample(sample);
        return sample.note === label
          && frame?.voiced === true
          && frame.rms > 0
          && frame.rms < OLD_GATE_RMS_AMPLITUDE
          && sample.inputState === "running"
          && sample.diagnosis?.endsWith("detected");
      }),
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
    const browserSilenceRun = longestMatchingRun(afterNavigationSamples, (sample) => {
      const frame = diagnosticFrameForRenderedSample(sample);
      return sample.note === null
        && frame?.voiced === false
        && frame.reason === "below-rms-threshold"
        && frame.rms === 0;
    });
    const browserNoiseRun = longestMatchingRun(afterNavigationSamples, (sample) => {
      const frame = diagnosticFrameForRenderedSample(sample);
      return sample.note === null
        && frame?.voiced === false
        && frame.rms >= OLD_GATE_RMS_AMPLITUDE
        && frame.reason !== "below-rms-threshold";
    });
    const promptStartCounter = lastWorkletSample(promptStartProof);
    const promptEndCounter = lastWorkletSample(promptEndProof);
    const noConsumerStartCounter = lastWorkletSample(noConsumerStartProof);
    const noConsumerEndCounter = lastWorkletSample(noConsumerEndProof);
    const workletRequestPaths = [...new Set(settledProof.workletModuleUrls
      .map((url) => new URL(url).pathname)
      .filter((path) => path.includes("pitch-capture-worklet")))];
    const precachedWorkletPaths = stampedPrecache.filter((path) =>
      /^\/assets\/pitch-capture-worklet-[A-Za-z0-9_-]+\.js$/u.test(path));

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
    assert(precachedWorkletPaths.length === 1
      && precachedWorkletPaths[0] === workletRequestPaths[0],
    `The exact AudioWorklet requested by production was not the sole stamped precache authority: requested=${JSON.stringify(workletRequestPaths)}, precached=${JSON.stringify(precachedWorkletPaths)}.`);
    assert(!settledProof.workletModuleUrls.some((url) => new URL(url).pathname === "/worklets/pitch-capture.js"),
      "The browser requested the obsolete stable pitch-worklet path.");
    assert(workletEvents.length === settledProof.workletSampleMessages,
      `Worklet evidence retention lost messages: retained=${workletEvents.length}, counted=${settledProof.workletSampleMessages}.`);
    assert(settledProof.workletSampleEvents.every((event) => event.sampleCount === CAPTURE_WINDOW_SAMPLES),
      `A worklet samples message had the wrong production window size: ${JSON.stringify(settledProof.workletSampleEvents)}`);
    assert(workletSequenceFailures.length === 0,
      `Worklet sample/counter sequence was not continuous: ${JSON.stringify(workletSequenceFailures)}`);
    assert(settledProof.stopButtonMissing === false && settledProof.stopButtonClicks === 1,
      `The explicit real global Disable click was not observed exactly once: ${JSON.stringify(settledProof)}`);
    assert(settledProof.trackStopCalls.length === 1,
      `Expected exactly one track.stop() after explicit global Disable; saw ${settledProof.trackStopCalls.length}.`);
    assert(postStartFalseWrites.length === 0,
      `Production wrote track.enabled=false: ${JSON.stringify(postStartFalseWrites)} (first navigation at ${navigationMark.toFixed(1)}ms).`);
    assert(settledProof.explicitStopSampleMessageCount === settledProof.workletSampleMessages,
      `A boundary worklet message escaped after explicit Disable: click at ${settledProof.explicitStopSampleMessageCount}, final ${settledProof.workletSampleMessages}.`);
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
      `Production detector exceeded its ${CAPTURE_HOP_BUDGET_MS.toFixed(3)}ms capture-hop budget: median=${processingMedianMs.toFixed(3)}ms, p95=${processingP95Ms.toFixed(3)}ms, max=${processingMaximumMs.toFixed(3)}ms at ${JSON.stringify(processingMaximumFrame)}.`);
    assert(promptStartCounter && promptEndCounter
      && promptEndCounter.processCount > promptStartCounter.processCount
      && promptEndCounter.processedSampleCount > promptStartCounter.processedSampleCount,
    `Worklet counters did not advance through the active pitch trace: ${JSON.stringify({ promptStartCounter, promptEndCounter })}.`);
    assert(noConsumerStartCounter && noConsumerEndCounter
      && noConsumerEndCounter.processCount > noConsumerStartCounter.processCount
      && noConsumerEndCounter.processedSampleCount > noConsumerStartCounter.processedSampleCount,
    `Worklet counters did not advance with no React microphone consumer: ${JSON.stringify({ noConsumerStartCounter, noConsumerEndCounter })}.`);
    assert(immediateChangeFailures.length === 0,
      `Candidate-to-authoritative pitch transitions violated the causal one-hop contract: ${JSON.stringify(immediateChangeFailures)}.`);
    assert(stableOccupancyProgression.length >= 6
      && stableOccupancyProgression[0].heldSamples === 0
      && stableOccupancyProgression[0].heldSeconds === 0
      && stableOccupancyProgression.some((observation) =>
        observation.heldSamples >= CAPTURE_HOP_SAMPLES * 5)
      && stableOccupancyProgression.every((observation, index, progression) => {
        const heldSamples = observation.heldSamples;
        const previous = progression[index - 1];
        return Number.isSafeInteger(heldSamples)
          && heldSamples >= 0
          && heldSamples % CAPTURE_HOP_SAMPLES === 0
          && observation.endSample - progression[0].endSample === heldSamples
          && Number.isFinite(observation.heldSeconds)
          && Math.abs(observation.heldSeconds - heldSamples / SAMPLE_RATE) <= 1e-9
          && (!previous
            || (observation.endSample > previous.endSample
              && heldSamples > previous.heldSamples
              && (observation.endSample - previous.endSample) % CAPTURE_HOP_SAMPLES === 0));
      }),
    `Rendered same-note occupancy did not enter at zero and preserve exact coalesced sample authority: ${JSON.stringify(stableOccupancyProgression.slice(0, 8))}.`);
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
    const meterPresentationFailures = pitchMeterProofFailures(meterPresentationProof);
    assert(meterPresentationFailures.length === 0,
      `Built pitch presentation failed full-depth geometry: ${meterPresentationFailures.join("; ")}.`);
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
    console.log(`  build identity: requested ${workletRequestPaths[0]} and matched the sole stamped service-worker precache worklet`);
    console.log(`  causal changes: ${formatImmediatePitchTransitions(immediateChangeProof)}; singleton remote candidates rendered uncertain with no stale note`);
    console.log(`  full-depth meter: ${meterSweepProof.length}/${EXPECTED_NOTES.length} supported notes mapped to distinct computed positions ${computedMeterPositions[0].toFixed(2)}%→${computedMeterPositions.at(-1).toFixed(2)}%; no non-boundary edge aliases`);
    console.log(`  full-depth ribbon: ${ribbonProof.map(({ label, latestY, endSample }) => `${label}@${endSample}:y=${latestY.toFixed(1)}`).join(", ")} remained distinct and matched the live meter projection`);
    console.log(`  rendered occupancy: ${occupancyEntryProof.label} entered at ${stableOccupancyProgression[0].endSample}:0, then ${stableOccupancyProgression.slice(1, 6).map(({ endSample, heldSamples }) => `${endSample}:${heldSamples}`).join(", ")} as bounded exact projections; departure reset=0; silence cleared`);
    console.log(`  transport recovery: AudioContext suspended→running; continuity ${recoveryBeforeCounter.continuityEpoch}->${recoveryFirstWindow.continuityEpoch} with discontinuity=true; getUserMedia/track/worklet remained 1/1/1`);
    console.log(`  detector processing: median ${processingMedianMs.toFixed(3)}ms, p95 ${processingP95Ms.toFixed(3)}ms, max ${processingMaximumMs.toFixed(3)}ms; every frame below ${CAPTURE_HOP_BUDGET_MS.toFixed(3)}ms capture-hop budget`);
    console.log(`  detector continuity: ${beforeFrames.length} mirror, ${noConsumerFrames.length} with no consumer, ${afterFrames.length} hum; maximum gap ${maximumGap}ms (no-consumer ${noConsumerMaximumGap}ms)`);
    console.log(`  active-trace continuity: rendered frames ${promptContinuity.firstCount}->${promptContinuity.lastCount}, time ${promptContinuity.firstTime.toFixed(3)}->${promptContinuity.lastTime.toFixed(3)}s, notes always visible`);
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
