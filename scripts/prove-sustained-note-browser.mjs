import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  amplitudeToDbfs,
  browserProofSnapshot,
  canonicalFrameKey,
  collectRenderedNotes,
  orderedPitchEvents,
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
  generatedSustainedMicrophoneWav,
  noteLabel,
  OLD_GATE_RMS_AMPLITUDE,
  SAMPLE_RATE,
  SUSTAINED_FIXTURE_SECONDS,
  SUSTAINED_NOTE_MIDIS,
  SUSTAINED_NOTE_SECONDS,
  SUSTAINED_SURVEY_SECONDS,
} from "./proof-support/note-input-fixture.mjs";
import { BROWSER_INSTRUMENTATION_SOURCE } from "./proof-support/note-input-instrumentation.mjs";
import {
  assertRangeLoopTargetPlaybackUnchanged,
  startRangeLoopTargetPlayback,
  stopRangeLoopTargetPlayback,
} from "./proof-support/sustained-playback-proof.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";
const MINIMUM_CONTINUOUS_SECONDS = 8;
const MINIMUM_RENDERED_SECONDS = 7.5;

function longestFrameRun(events, midi) {
  let current = [];
  let longest = [];
  for (const event of events) {
    const frame = event.pitch?.frame;
    const previous = current.at(-1)?.pitch?.frame;
    const continuous = frame?.voiced
      && frame.nearestMidi === midi
      && (!previous
        || (frame.captureEpoch === previous.captureEpoch
          && frame.continuityEpoch === previous.continuityEpoch
          && frame.endSample - previous.endSample === CAPTURE_HOP_SAMPLES));
    if (continuous) current.push(event);
    else current = frame?.voiced && frame.nearestMidi === midi ? [event] : [];
    if (current.length > longest.length) longest = [...current];
  }
  const first = longest[0]?.pitch?.frame;
  const last = longest.at(-1)?.pitch?.frame;
  return {
    events: longest,
    seconds: first && last ? (last.endSample - first.endSample) / first.sampleRate : 0,
    first,
    last,
  };
}

function longestRenderedRun(samples, label) {
  let current = [];
  let longest = [];
  for (const sample of samples) {
    if (sample.note === label && sample.inputState === "running") current.push(sample);
    else current = [];
    if (current.length > longest.length) longest = [...current];
  }
  return {
    samples: longest,
    seconds: longest.length > 1
      ? (longest.at(-1).at - longest[0].at) / 1_000
      : 0,
    maximumHeldSeconds: Math.max(0, ...longest.map((sample) => sample.heldSeconds ?? 0)),
  };
}

function longestSilenceRun(events) {
  let current = 0;
  let longest = 0;
  for (const event of events) {
    const frame = event.pitch?.frame;
    if (frame && !frame.voiced && frame.rms === 0) current += 1;
    else current = 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

async function main() {
  let temporaryDirectory;
  let vite;
  let chromium;
  let session;
  let viteOutput = [];
  let chromiumOutput = [];

  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-sustain-proof-"));
    const wavPath = join(temporaryDirectory, "sustained-notes.wav");
    const chromiumProfile = join(temporaryDirectory, "chromium-profile");
    const vitePort = await availablePort();
    const debugPort = await availablePort();
    const pageUrl = `http://127.0.0.1:${vitePort}/#/practice/pitch-match/glide`;
    await writeFile(wavPath, generatedSustainedMicrophoneWav());

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
      try { diagnosticBatches.push(JSON.parse(request.postData)); } catch { /* count assertions fail */ }
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
      "the production global voice control",
    );
    await enableRemotePitchDiagnostics(session);
    const clicked = await evaluate(session, `(() => {
      const button = document.querySelector('[data-global-mic-enable]');
      button?.click();
      return Boolean(button);
    })()`);
    assert(clicked, "The global Enable voice control was not clickable.");
    await waitForBrowser(
      session,
      "document.querySelector('.input-scope.running') && Number(document.querySelector('[data-note-input]')?.getAttribute('data-frame-count')) > 0",
      "continuous production pitch analysis",
      12_000,
    );

    const renderedSamples = await collectRenderedNotes(
      session,
      (SUSTAINED_SURVEY_SECONDS + 0.5) * 1_000,
    );
    const sustainEndProof = await browserProofSnapshot(session);
    assert(sustainEndProof.trackStopCalls.length === 0,
      `The microphone stopped during sustained input: ${JSON.stringify(sustainEndProof.trackStopCalls)}.`);
    assert(sustainEndProof.trackEnabledWrites.every((write) => write.value !== false),
      `The microphone was disabled during sustained input: ${JSON.stringify(sustainEndProof.trackEnabledWrites)}.`);

    // Use the same still-running stream to reproduce the exact workflow that
    // previously showed a moving meter while its exercise hold remained zero.
    await evaluate(session, "location.hash = '#/practice/range-loop'; true");
    await waitForBrowser(
      session,
      "location.hash === '#/practice/range-loop' && Boolean(document.querySelector('.range-loop-page')) && Boolean(document.querySelector('[data-note-input][data-input-state=running]'))",
      "Range Loop on the retained microphone",
      8_000,
    );
    const rangeLoopMounted = await evaluate(session, `(() => {
      const tuners = [...document.querySelectorAll('[data-note-input]')];
      window.__noteforgeRangeLoopTuner = tuners[0] || null;
      return {
        count: tuners.length,
        target: document.querySelector('.nf-voice-target strong')?.textContent?.trim() || null,
      };
    })()`);
    assert(rangeLoopMounted.count === 1 && rangeLoopMounted.target === "C3",
      `Range Loop did not mount exactly one C3 tuner: ${JSON.stringify(rangeLoopMounted)}.`);

    await delay(500);
    const rangeLoopReady = await evaluate(session, `(() => ({
      phase: document.querySelector('[data-range-loop-phase]')?.getAttribute('data-range-loop-phase') || null,
      heldSeconds: Number(document.querySelector('[data-note-input]')?.getAttribute('data-held-seconds')),
      detected: document.querySelector('[data-note-input]')?.getAttribute('data-detected-note') || null,
    }))()`);
    assert(rangeLoopReady.phase === "idle" && rangeLoopReady.heldSeconds === 0,
      `Range Loop scored before its visible Start command: ${JSON.stringify(rangeLoopReady)}.`);

    const playback = await startRangeLoopTargetPlayback(session);

    const rangeLoopStarted = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.includes('Start Range Loop'));
      button?.click();
      return Boolean(button);
    })()`);
    assert(rangeLoopStarted, "Range Loop's explicit Start control was unavailable.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-range-loop-phase]')?.getAttribute('data-range-loop-phase') === 'tracking'",
      "Range Loop entering tracking from its visible Start command",
      5_000,
    );
    await assertRangeLoopTargetPlaybackUnchanged(session, playback, "Visible Start");

    await waitForBrowser(
      session,
      `(() => {
        const detected = document.querySelector('[data-note-input]')?.getAttribute('data-detected-note');
        const hold = Number(document.querySelector('[data-note-input]')?.getAttribute('data-held-seconds'));
        return detected === 'C3' && hold >= 0.6 && hold < 2.2;
      })()`,
      "quiet C3 establishing sample-timed dwell while target playback stays on",
      25_000,
    );
    const playbackDuringHold = await evaluate(session, `(() => ({
      holdSeconds: Number(document.querySelector('[data-note-input]')?.getAttribute('data-held-seconds')),
      sameTuner: window.__noteforgeRangeLoopTuner === document.querySelector('[data-note-input]'),
      sameToggle: window.__noteforgeRangeLoopPlaybackToggle === document.querySelector('.range-loop-reference-action [data-note-playback-toggle]'),
      playbackPressed: document.querySelector('.range-loop-reference-action [data-note-playback-toggle]')?.getAttribute('aria-pressed') || null,
      inputState: document.querySelector('[data-note-input]')?.getAttribute('data-input-state') || null,
    }))()`);
    assert(playbackDuringHold.sameTuner === true
      && playbackDuringHold.sameToggle === true
      && playbackDuringHold.playbackPressed === "true"
      && playbackDuringHold.inputState === "running"
      && playbackDuringHold.holdSeconds >= 0.6,
    `Sustained playback replaced the tuner, changed its own toggle, or interrupted earned dwell: ${JSON.stringify(playbackDuringHold)}.`);

    await waitForBrowser(
      session,
      `(() => {
        const target = document.querySelector('.nf-voice-target strong')?.textContent?.trim();
        const hold = Number(document.querySelector('[data-note-input]')?.getAttribute('data-held-seconds'));
        const result = document.querySelector('.range-result-next b')?.textContent || '';
        return target === 'C3' && hold >= 30 && result.includes('C3 earned');
      })()`,
      "Range Loop collecting 30 seconds across separated quiet-C3 attempts",
      40_000,
    );
    const rangeLoopResult = await evaluate(session, `(() => ({
      target: document.querySelector('.nf-voice-target strong')?.textContent?.trim() || null,
      detected: document.querySelector('[data-note-input]')?.getAttribute('data-detected-note') || null,
      holdSeconds: Number(document.querySelector('[data-note-input]')?.getAttribute('data-held-seconds')),
      result: document.querySelector('.range-result-next b')?.textContent?.trim() || null,
      inputState: document.querySelector('[data-note-input]')?.getAttribute('data-input-state') || null,
      noteInputCount: document.querySelectorAll('[data-note-input]').length,
      sameTuner: window.__noteforgeRangeLoopTuner === document.querySelector('[data-note-input]'),
    }))()`);
    assert(rangeLoopResult.target === "C3"
      && rangeLoopResult.detected === "C3"
      && rangeLoopResult.holdSeconds >= 30
      && rangeLoopResult.inputState === "running"
      && rangeLoopResult.noteInputCount === 1
      && rangeLoopResult.sameTuner === true,
    `Range Loop did not render the achieved quiet C3 hold on the live stream: ${JSON.stringify(rangeLoopResult)}.`);

    await waitForBrowser(
      session,
      `Number(document.querySelector('[data-note-input]')?.getAttribute('data-held-seconds')) > ${rangeLoopResult.holdSeconds + 0.1}`,
      "Range Loop continuing collective credit beyond 30 seconds",
      5_000,
    );
    const uncappedRangeLoop = await evaluate(session, `(() => ({
      holdSeconds: Number(document.querySelector('[data-note-input]')?.getAttribute('data-held-seconds')),
      sameTuner: window.__noteforgeRangeLoopTuner === document.querySelector('[data-note-input]'),
      inputState: document.querySelector('[data-note-input]')?.getAttribute('data-input-state') || null,
    }))()`);
    assert(uncappedRangeLoop.holdSeconds > rangeLoopResult.holdSeconds
      && uncappedRangeLoop.sameTuner === true
      && uncappedRangeLoop.inputState === "running",
    `Range Loop capped or replaced the live dwell after achievement: ${JSON.stringify({ rangeLoopResult, uncappedRangeLoop })}.`);

    const rangeLoopFinished = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.includes('Finish Range Loop'));
      button?.click();
      return Boolean(button);
    })()`);
    assert(rangeLoopFinished, "Range Loop's explicit Finish control was unavailable.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-range-loop-phase]')?.getAttribute('data-range-loop-phase') === 'complete'",
      "Range Loop honoring its visible Finish command",
      5_000,
    );
    const finishBoundary = await evaluate(session, `(() => ({
      heldSeconds: Number(document.querySelector('[data-note-input]')?.getAttribute('data-held-seconds')),
      sameTuner: window.__noteforgeRangeLoopTuner === document.querySelector('[data-note-input]'),
    }))()`);
    const proofBeforeFinishedTelemetry = await browserProofSnapshot(session);
    await delay(500);
    const afterFinishBoundary = await evaluate(session, `(() => ({
      heldSeconds: Number(document.querySelector('[data-note-input]')?.getAttribute('data-held-seconds')),
      detected: document.querySelector('[data-note-input]')?.getAttribute('data-detected-note') || null,
      sameTuner: window.__noteforgeRangeLoopTuner === document.querySelector('[data-note-input]'),
    }))()`);
    const rangeLoopProof = await browserProofSnapshot(session);
    assert(afterFinishBoundary.heldSeconds === finishBoundary.heldSeconds
      && afterFinishBoundary.detected === "C3"
      && afterFinishBoundary.sameTuner === true
      && rangeLoopProof.workletSampleMessages > proofBeforeFinishedTelemetry.workletSampleMessages,
    `Range Loop Finish did not freeze only feature scoring while shared telemetry continued: ${JSON.stringify({ finishBoundary, afterFinishBoundary })}.`);
    assert(rangeLoopProof.getUserMediaCalls === sustainEndProof.getUserMediaCalls
      && rangeLoopProof.streams === sustainEndProof.streams
      && rangeLoopProof.tracks === sustainEndProof.tracks
      && rangeLoopProof.audioContexts === sustainEndProof.audioContexts
      && rangeLoopProof.workletNodes === sustainEndProof.workletNodes
      && rangeLoopProof.workletSampleMessages > sustainEndProof.workletSampleMessages
      && rangeLoopProof.trackStopCalls.length === 0,
    `Range Loop replaced or stopped continuous capture: ${JSON.stringify({ sustainEndProof, rangeLoopProof })}.`);
    await assertRangeLoopTargetPlaybackUnchanged(
      session,
      playback,
      "Achievement or visible Finish",
    );
    const { stops: playbackStops } = await stopRangeLoopTargetPlayback(
      session,
      playback,
      rangeLoopProof,
    );

    const advancedAfterFinish = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Next target');
      button?.click();
      return Boolean(button && !button.disabled);
    })()`);
    assert(advancedAfterFinish, "The earned C3 could not advance after visible Finish.");
    await waitForBrowser(
      session,
      "document.querySelector('.nf-voice-target strong')?.textContent?.trim() === 'D3'",
      "the explicit Next target decision selecting D3",
      5_000,
    );
    const resumed = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Start Range Loop');
      button?.click();
      return Boolean(button && !button.disabled);
    })()`);
    assert(resumed, "Range Loop could not resume for the outside-range proof.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-range-loop-phase]')?.getAttribute('data-range-loop-phase') === 'tracking'",
      "Range Loop resuming through visible Start",
      5_000,
    );
    const excluded = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === "I can't reach this note");
      button?.click();
      return Boolean(button && !button.disabled);
    })()`);
    assert(excluded, "The visible outside-range action was unavailable on D3.");
    await waitForBrowser(
      session,
      `(() => {
        const recheck = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.textContent?.includes('Recheck 1 excluded note'));
        return document.querySelector('.nf-voice-target strong')?.textContent?.trim() === 'E3'
          && Boolean(document.querySelector('[aria-label="D3, outside current range"]'))
          && Boolean(recheck && !recheck.disabled);
      })()`,
      "D3 being excluded without a pass while the live session moves to E3",
      5_000,
    );
    const rechecked = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.includes('Recheck 1 excluded note'));
      button?.click();
      return Boolean(button && !button.disabled);
    })()`);
    assert(rechecked, "The visible Recheck excluded notes action was unavailable.");
    await waitForBrowser(
      session,
      `document.querySelector('.nf-voice-target strong')?.textContent?.trim() === 'E3'
        && Boolean(document.querySelector('[aria-label="D3, upcoming"]'))
        && ![...document.querySelectorAll('button')]
          .some((candidate) => candidate.textContent?.includes('Recheck 1 excluded note'))`,
      "D3 returning to future scheduling without resetting the active E3 target",
      5_000,
    );
    const outsideRangeProof = await evaluate(session, `(() => ({
      phase: document.querySelector('[data-range-loop-phase]')?.getAttribute('data-range-loop-phase') || null,
      target: document.querySelector('.nf-voice-target strong')?.textContent?.trim() || null,
      heldSeconds: Number(document.querySelector('[data-note-input]')?.getAttribute('data-held-seconds')),
      sameTuner: window.__noteforgeRangeLoopTuner === document.querySelector('[data-note-input]'),
      inputState: document.querySelector('[data-note-input]')?.getAttribute('data-input-state') || null,
    }))()`);
    assert(outsideRangeProof.phase === "tracking"
      && outsideRangeProof.target === "E3"
      && outsideRangeProof.heldSeconds === 0
      && outsideRangeProof.sameTuner === true
      && outsideRangeProof.inputState === "running",
    `Outside-range scheduling altered capture, awarded false credit, or replaced the tuner: ${JSON.stringify(outsideRangeProof)}.`);
    const refinish = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Finish Range Loop');
      button?.click();
      return Boolean(button && !button.disabled);
    })()`);
    assert(refinish, "The outside-range proof could not end through visible Finish.");

    const stopArmed = await evaluate(session, `(() => {
      const control = window.__noteforgeNoteInputProof;
      const button = document.querySelector('[data-global-mic-disable]');
      if (!control || !button || button.disabled) return false;
      return control.armStopOnNextSample();
    })()`);
    assert(stopArmed, "The global Disable voice control was unavailable after the sustain run.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'disabled'",
      "the explicit global Disable action",
      5_000,
    );
    await delay(800);
    const stopped = await browserProofSnapshot(session);
    await delay(250);
    const settled = await browserProofSnapshot(session);
    assert(settled.workletSampleMessages === stopped.workletSampleMessages,
      `PCM continued after explicit Disable (${stopped.workletSampleMessages}->${settled.workletSampleMessages}).`);
    const flushedCount = await waitForDiagnosticCount(
      diagnosticBatches,
      settled.workletSampleMessages,
    );
    const events = orderedPitchEvents(diagnosticBatches);
    const frames = events.map((event) => event.pitch?.frame).filter(Boolean);

    assert(settled.instrumentationErrors.length === 0,
      `Browser instrumentation failed: ${JSON.stringify(settled.instrumentationErrors)}.`);
    assert(consoleErrors.length === 0,
      `The production page emitted browser errors: ${JSON.stringify(consoleErrors)}.`);
    assert(settled.getUserMediaCalls === 1 && settled.streams === 1 && settled.tracks === 1,
      `Expected one retained microphone authority; saw getUserMedia/streams/tracks=${settled.getUserMediaCalls}/${settled.streams}/${settled.tracks}.`);
    assert(settled.audioContexts === 1 && settled.workletNodes === 1,
      `Expected one AudioContext/worklet; saw ${settled.audioContexts}/${settled.workletNodes}.`);
    assert(settled.stopButtonClicks === 1 && settled.trackStopCalls.length === 1,
      `Only explicit Disable may stop capture: clicks/stops=${settled.stopButtonClicks}/${settled.trackStopCalls.length}.`);
    assert(settled.explicitStopSampleMessageCount === settled.workletSampleMessages,
      "A PCM window escaped after the explicit Disable boundary.");
    assert(flushedCount === settled.workletSampleMessages && events.length === settled.workletSampleMessages,
      `Worklet/detector accounting differs: ${settled.workletSampleMessages}/${events.length}.`);

    const workletKeys = new Set(settled.workletSampleEvents.map(canonicalFrameKey));
    const detectorKeys = new Set(frames.map(canonicalFrameKey));
    assert(workletKeys.size === settled.workletSampleMessages
      && detectorKeys.size === events.length
      && [...workletKeys].every((key) => detectorKeys.has(key)),
    "Worklet windows and detector frames are not an exact sample-coordinate bijection.");
    for (let index = 1; index < settled.workletSampleEvents.length; index += 1) {
      const previous = settled.workletSampleEvents[index - 1];
      const current = settled.workletSampleEvents[index];
      assert(current.captureEpoch === previous.captureEpoch
        && current.continuityEpoch === previous.continuityEpoch
        && current.graphGeneration === previous.graphGeneration
        && current.endSample - previous.endSample === CAPTURE_HOP_SAMPLES,
      `PCM authority broke at window ${index}: ${JSON.stringify({ previous, current })}.`);
    }

    const processingMs = events.map((event) => event.pitch?.processingMs);
    assert(processingMs.every((value) => Number.isFinite(value) && value < CAPTURE_HOP_BUDGET_MS),
      `Detector exceeded its ${CAPTURE_HOP_BUDGET_MS} ms hop budget: ${Math.max(...processingMs)} ms.`);
    const silenceFrames = longestSilenceRun(events);
    assert(silenceFrames >= 20,
      `Silence did not remain a continuously analyzed unvoiced stream: ${silenceFrames} frames.`);

    const detectorProof = SUSTAINED_NOTE_MIDIS.map((midi) => {
      const run = longestFrameRun(events, midi);
      const cents = run.events.map((event) => Math.abs(event.pitch.frame.centsFromNearest));
      const rmsDbfs = run.events.map((event) => amplitudeToDbfs(event.pitch.frame.rms));
      assert(run.seconds >= MINIMUM_CONTINUOUS_SECONDS,
        `${noteLabel(midi)} stayed continuously correct for only ${run.seconds.toFixed(3)} s.`);
      assert(cents.every((value) => Number.isFinite(value) && value <= 25),
        `${noteLabel(midi)} left its note region during the voice-like vibrato: ${Math.max(...cents).toFixed(3)} cents.`);
      return {
        midi,
        label: noteLabel(midi),
        frames: run.events.length,
        seconds: run.seconds,
        maximumCents: Math.max(...cents),
        medianRmsDbfs: [...rmsDbfs].sort((left, right) => left - right)[Math.floor(rmsDbfs.length / 2)],
      };
    });
    const quietLowProof = detectorProof.find(({ midi }) => midi === 48);
    assert(quietLowProof && quietLowProof.medianRmsDbfs < 20 * Math.log10(OLD_GATE_RMS_AMPLITUDE),
      `The quiet C3 proof did not remain below the historical gate: ${JSON.stringify(quietLowProof)}.`);

    const renderedProof = SUSTAINED_NOTE_MIDIS.map((midi) => {
      const label = noteLabel(midi);
      const run = longestRenderedRun(renderedSamples, label);
      assert(run.seconds >= MINIMUM_RENDERED_SECONDS,
        `The production UI continuously showed ${label} for only ${run.seconds.toFixed(3)} s.`);
      assert(run.maximumHeldSeconds >= MINIMUM_CONTINUOUS_SECONDS,
        `The production UI reported only ${run.maximumHeldSeconds.toFixed(3)} s held for ${label}.`);
      return {
        label,
        samples: run.samples.length,
        seconds: run.seconds,
        maximumHeldSeconds: run.maximumHeldSeconds,
      };
    });

    const firstSamples = detectorProof.map(({ label, midi }) => ({
      label,
      endSample: longestFrameRun(events, midi).first.endSample,
    }));
    assert(firstSamples.every((entry, index) => index === 0
      || entry.endSample > firstSamples[index - 1].endSample),
    `Sustained notes were not observed in fixture order: ${JSON.stringify(firstSamples)}.`);

    console.log("SUSTAINED NOTE BROWSER PROOF PASSED");
    console.log(`  authority: one MediaStream/track/AudioContext/worklet; ${settled.workletSampleMessages} PCM windows exactly paired with ${events.length} detector frames`);
    console.log(`  lifecycle: the ${SUSTAINED_FIXTURE_SECONDS}s fixture used one capture authority; explicit Disable produced the only track.stop()`);
    console.log(`  silence: ${silenceFrames} consecutive unvoiced detector frames while PCM continued`);
    for (const proof of detectorProof) {
      const rendered = renderedProof.find(({ label }) => label === proof.label);
      console.log(`  ${proof.label}: detector ${proof.seconds.toFixed(3)}s/${proof.frames} uninterrupted frames, max error ${proof.maximumCents.toFixed(2)}c, median ${proof.medianRmsDbfs.toFixed(1)} dBFS; UI ${rendered.seconds.toFixed(3)}s, hold ${rendered.maximumHeldSeconds.toFixed(3)}s`);
    }
    console.log(`  detector budget: max ${Math.max(...processingMs).toFixed(3)}ms < ${CAPTURE_HOP_BUDGET_MS.toFixed(3)}ms hop`);
    console.log(`  Range Loop: six separated quiet-C3 attempts collectively reached ${rangeLoopResult.holdSeconds.toFixed(2)}s, then continued to ${uncappedRangeLoop.holdSeconds.toFixed(2)}s; breaths erased nothing and visible Finish froze only feature credit while PCM/live C3 continued`);
    console.log("  reachability: visible D3 outside-range exclusion moved to E3 with zero false credit; visible Recheck restored D3 without replacing the tuner or capture");
    console.log(`  target playback: one ${playback.starts.length}-oscillator sustained lane remained at its full attack amplitude with zero stops or gain changes beyond the former cutoff and across Start/achievement/Finish; the same still-mounted Play/Stop toggle issued the first ${playbackStops.length} stops`);
    console.log(`  requested sustain: ${SUSTAINED_NOTE_SECONDS.toFixed(1)}s per note; accepted uninterrupted minimum ${MINIMUM_CONTINUOUS_SECONDS.toFixed(1)}s`);
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
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
