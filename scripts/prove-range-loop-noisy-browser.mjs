import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserProofSnapshot,
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
  CAPTURE_HOP_SAMPLES,
  generatedNoisyRangeLoopMicrophoneWav,
  NOISY_RANGE_C3_MIDI,
  NOISY_RANGE_C3_STAGES,
  NOISY_RANGE_D3_MIDI,
  NOISY_RANGE_D3_START_SAMPLE,
  NOISY_RANGE_FIXTURE_SAMPLES,
  noteLabel,
  SAMPLE_RATE,
} from "./proof-support/note-input-fixture.mjs";
import { BROWSER_INSTRUMENTATION_SOURCE } from "./proof-support/note-input-instrumentation.mjs";
import { RANGE_LOOP_INSTRUMENTATION_SOURCE } from "./proof-support/range-loop-instrumentation.mjs";
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";
const REQUIRED_HOLD_SECONDS = 3;
const C3_LABEL = noteLabel(NOISY_RANGE_C3_MIDI);
const D3_LABEL = noteLabel(NOISY_RANGE_D3_MIDI);
const CLEAN_RECOVERY = NOISY_RANGE_C3_STAGES.find(({ id }) => id === "clean-recovery");
const C3_CHECKPOINT_SAMPLE = CLEAN_RECOVERY.startSample + Math.round(0.55 * SAMPLE_RATE);
function stageForSample(sample) {
  if (sample >= NOISY_RANGE_D3_START_SAMPLE) return "persistent-d3";
  return NOISY_RANGE_C3_STAGES.find((stage) => (
    sample >= stage.startSample && sample < stage.endSample
  ))?.id ?? "pre-capture";
}

function authoritativeObservation(event) {
  const frame = event.pitch?.frame;
  return {
    stage: stageForSample(Math.max(0, (frame?.endSample ?? 0) - 1)),
    kind: frame?.observationKind ?? null,
    frequencyHz: frame?.frequencyHz ?? null,
    midiFloat: frame?.midiFloat ?? null,
    nearestMidi: frame?.nearestMidi ?? null,
    confidence: frame?.confidence ?? null,
    periodicity: frame?.periodicity ?? null,
    yinValue: frame?.yinValue ?? null,
    periodSamples: frame?.periodSamples ?? null,
    reason: frame?.reason ?? null,
    captureEpoch: frame?.captureEpoch ?? null,
    continuityEpoch: frame?.continuityEpoch ?? null,
    graphGeneration: frame?.graphGeneration ?? null,
    startSample: frame?.startSample ?? null,
    endSample: frame?.endSample ?? null,
  };
}

function detectorStageSummary(events) {
  return [...NOISY_RANGE_C3_STAGES.map(({ id }) => id), "persistent-d3"].map((stage) => {
    const observations = events.map(authoritativeObservation).filter((observation) => observation.stage === stage);
    const voiced = observations.filter((observation) => observation.kind === "voiced");
    const intendedMidi = stage === "persistent-d3" ? NOISY_RANGE_D3_MIDI : NOISY_RANGE_C3_MIDI;
    const contradictory = voiced.filter((observation) => observation.nearestMidi !== intendedMidi);
    const confidences = observations
      .map(({ confidence }) => confidence)
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    return {
      stage,
      frames: observations.length,
      voiced: voiced.length,
      unvoicedOrUncertain: observations.length - voiced.length,
      contradictory: contradictory.length,
      minimumConfidence: confidences[0] ?? null,
      medianConfidence: confidences[Math.floor(confidences.length / 2)] ?? null,
      reasons: [...new Set(observations.map(({ reason }) => reason).filter(Boolean))],
      contradictoryExamples: contradictory.slice(0, 3),
    };
  });
}

function holdRegressions(snapshots, target, afterAt, throughSample) {
  const relevant = snapshots.filter((snapshot) => (
    snapshot.at >= afterAt
    && snapshot.phase === "tracking"
    && snapshot.target === target
    && Number.isFinite(snapshot.heldSeconds)
    && Number.isFinite(snapshot.endSample)
    && snapshot.endSample <= throughSample
  ));
  const regressions = [];
  let previous = null;
  for (const snapshot of relevant) {
    if (previous && snapshot.heldSeconds + 1e-9 < previous.heldSeconds) {
      regressions.push({ before: previous, after: snapshot });
    }
    previous = snapshot;
  }
  return { relevant, regressions };
}

function evidenceReport(events, rangeProof, startedAt, throughSample) {
  const observations = events.map(authoritativeObservation).filter((observation) => (
    observation.endSample !== null && observation.endSample <= throughSample
  ));
  const observationBySample = new Map(observations.map((observation) => [
    `${observation.captureEpoch}:${observation.endSample}`,
    observation,
  ]));
  const authoritativeContradictions = observations.filter((observation) => (
    observation.kind === "voiced" && observation.nearestMidi !== NOISY_RANGE_C3_MIDI
  ));
  const trackedContradictions = rangeProof.snapshots.filter((snapshot) => (
    snapshot.at >= startedAt
    && snapshot.target === C3_LABEL
    && snapshot.endSample <= throughSample
    && snapshot.detectedNote !== null
    && snapshot.detectedNote !== C3_LABEL
  )).map((snapshot) => ({
    ...snapshot,
    authoritativeObservation: observationBySample.get(`${snapshot.captureEpoch}:${snapshot.endSample}`) ?? null,
  }));
  const hold = holdRegressions(rangeProof.snapshots, C3_LABEL, startedAt, throughSample);
  return {
    authoritativeContradictions: authoritativeContradictions.slice(0, 4),
    trackedContradictions: trackedContradictions.slice(0, 4),
    holdRegressions: hold.regressions.slice(0, 3),
    maximumHeldSeconds: Math.max(0, ...hold.relevant.map(({ heldSeconds }) => heldSeconds)),
    stages: detectorStageSummary(events),
  };
}

async function rangeProofSnapshot(session) {
  return evaluate(session, `window.__noteforgeNoisyRangeProof?.snapshot?.() || null`);
}

async function main() {
  let temporaryDirectory;
  let vite;
  let chromium;
  let session;
  let viteOutput = [];
  let chromiumOutput = [];
  let failureEvidence = null;
  const diagnosticBatches = [];
  const consoleErrors = [];

  try {
    assert(CLEAN_RECOVERY, "The noisy Range Loop fixture has no clean-recovery stage.");
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-noisy-range-proof-"));
    const wavPath = join(temporaryDirectory, "continuous-noisy-c3-then-d3.wav");
    const chromiumProfile = join(temporaryDirectory, "chromium-profile");
    const vitePort = await availablePort();
    const debugPort = await availablePort();
    const pageUrl = `http://127.0.0.1:${vitePort}/#/practice/range-loop`;
    await writeFile(wavPath, generatedNoisyRangeLoopMicrophoneWav());
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
    session.on("Network.requestWillBeSent", ({ request }) => {
      if (!request?.url?.includes("/api/diagnostics/pitch") || !request.postData) return;
      try { diagnosticBatches.push(JSON.parse(request.postData)); } catch { /* accounting fails below */ }
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
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: RANGE_LOOP_INSTRUMENTATION_SOURCE,
    });
    await session.send("Page.navigate", { url: pageUrl });
    await waitForBrowser(
      session,
      `location.hash === '#/practice/range-loop'
        && document.readyState === 'complete'
        && document.querySelectorAll('[data-note-input]').length === 1
        && document.querySelector('.nf-voice-target strong')?.textContent?.trim() === '${C3_LABEL}'
        && Boolean([...document.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('Start Range Loop')))`,
      "the real hydrated C3 Range Loop with one shared NoteInput",
      10_000,
    );
    const loadedEntryScripts = await evaluate(session, `[
      ...document.querySelectorAll('script[src]'),
    ].map((script) => new URL(script.src, location.href).pathname)`);
    assert(loadedEntryScripts.some((path) => /^\/assets\/index-[A-Za-z0-9_-]+\.js$/u.test(path)),
      `The noisy Range Loop proof did not load a hashed production bundle: ${JSON.stringify(loadedEntryScripts)}.`);
    await enableRemotePitchDiagnostics(session);
    const enableClicked = await evaluate(session, `(() => {
      const button = document.querySelector('[data-global-mic-enable]');
      button?.click();
      return Boolean(button && !button.disabled);
    })()`);
    assert(enableClicked, "The visible global Enable voice control was unavailable.");
    await waitForBrowser(
      session,
      `document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'running'
        && document.querySelector('[data-note-input]')?.getAttribute('data-detected-note') === '${C3_LABEL}'
        && window.__noteforgeNoteInputProof?.snapshot?.().workletSampleMessages > 0`,
      "the generated C3 reaching the real Range Loop through getUserMedia and AudioWorklet",
      8_000,
    );
    const beforeStart = await browserProofSnapshot(session);
    const startEndSample = beforeStart.workletSampleEvents.at(-1)?.endSample ?? Number.POSITIVE_INFINITY;
    assert(startEndSample < NOISY_RANGE_C3_STAGES[0].endSample - Math.round(0.4 * SAMPLE_RATE),
      `Range Loop did not start early enough to traverse the full adversarial C3 schedule (capture already at ${startEndSample}).`);
    const mounted = await evaluate(session, `(() => {
      const input = document.querySelector('[data-note-input]');
      window.__noteforgeCanonicalRangeInput = input;
      return {
        count: document.querySelectorAll('[data-note-input]').length,
        heldSeconds: Number(input?.getAttribute('data-held-seconds')),
        phase: document.querySelector('[data-range-loop-phase]')?.getAttribute('data-range-loop-phase'),
        following: document.querySelector('.range-loop-next b')?.textContent?.trim(),
        settings: document.querySelector('.range-loop-settings summary b')?.textContent?.trim(),
      };
    })()`);
    assert(mounted.count === 1
      && mounted.phase === "idle"
      && mounted.heldSeconds === 0
      && mounted.following === D3_LABEL
      && mounted.settings?.includes("3.0 sec"),
    `The real default C3 -> D3 Range Loop was not mounted: ${JSON.stringify(mounted)}.`);
    const startClicked = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Start Range Loop');
      button?.click();
      return Boolean(button && !button.disabled);
    })()`);
    assert(startClicked, "The visible Start Range Loop action was unavailable.");
    await waitForBrowser(
      session,
      `document.querySelector('[data-range-loop-phase]')?.getAttribute('data-range-loop-phase') === 'tracking'`,
      "Range Loop tracking after its visible Start command",
      5_000,
    );
    const startedAt = await evaluate(session, `window.__noteforgeNoisyRangeProof.snapshot().actions
      .find((action) => action.label === 'Start Range Loop')?.at ?? performance.now()`);

    await waitForBrowser(
      session,
      `window.__noteforgeNoteInputProof.snapshot().workletSampleEvents.at(-1)?.endSample >= ${C3_CHECKPOINT_SAMPLE}`,
      "the complete clean/noise/transient/harmonic/dropout/changing-noise C3 schedule",
      25_000,
    );
    await waitForBrowser(
      session,
      `Number(document.querySelector('[data-note-input]')?.getAttribute('data-end-sample')) >= ${C3_CHECKPOINT_SAMPLE - 2 * CAPTURE_HOP_SAMPLES}`,
      "the shared NoteInput rendering the clean-recovery checkpoint",
      3_000,
    );
    await delay(350);
    const c3Checkpoint = await evaluate(session, `(() => {
      const input = document.querySelector('[data-note-input]');
      const next = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Next target');
      return {
        count: document.querySelectorAll('[data-note-input]').length,
        sameInput: input === window.__noteforgeCanonicalRangeInput,
        target: document.querySelector('.nf-voice-target strong')?.textContent?.trim() || null,
        following: document.querySelector('.range-loop-next b')?.textContent?.trim() || null,
        detected: input?.getAttribute('data-detected-note') || null,
        heldSeconds: Number(input?.getAttribute('data-held-seconds')),
        endSample: Number(input?.getAttribute('data-end-sample')),
        result: document.querySelector('.range-result-next b')?.textContent?.trim() || null,
        nextEnabled: Boolean(next && !next.disabled),
      };
    })()`);
    const c3RangeProof = await rangeProofSnapshot(session);
    const c3Events = orderedPitchEvents(diagnosticBatches);
    const c3Evidence = evidenceReport(c3Events, c3RangeProof, startedAt, c3Checkpoint.endSample);
    failureEvidence = { checkpoint: c3Checkpoint, evidence: c3Evidence };
    assert(c3RangeProof.instrumentationErrors.length === 0,
      `Range Loop DOM instrumentation failed: ${JSON.stringify(c3RangeProof.instrumentationErrors)}.`);
    assert(c3RangeProof.topologyViolations.length === 0,
      `Range Loop duplicated or replaced its canonical NoteInput: ${JSON.stringify(c3RangeProof.topologyViolations.slice(0, 8))}.`);
    assert(c3Checkpoint.count === 1 && c3Checkpoint.sameInput,
      `Range Loop replaced or duplicated its canonical NoteInput: ${JSON.stringify(c3Checkpoint)}.`);
    assert(c3Evidence.trackedContradictions.length === 0,
      "The authoritative Range Loop readout abandoned C3 during C3 + interference; see the sample-correlated adversarial evidence below.");
    assert(c3Evidence.authoritativeContradictions.length === 0,
      "The shared temporal tracker granted a contradictory note authority during C3 + interference; see the sample-correlated adversarial evidence below.");
    assert(c3Evidence.holdRegressions.length === 0,
      "Range Loop reset already-earned C3 sample time during transient contradictory evidence; see the sample-correlated adversarial evidence below.");
    assert(c3Checkpoint.target === C3_LABEL
      && c3Checkpoint.following === D3_LABEL
      && c3Checkpoint.detected === C3_LABEL
      && c3Checkpoint.heldSeconds >= REQUIRED_HOLD_SECONDS
      && c3Checkpoint.result?.includes(`${C3_LABEL} earned`)
      && c3Checkpoint.nextEnabled,
    "The imperfect continuous C3 could not clear the real Range Loop gate; see the sample-correlated adversarial evidence below.");
    assert(c3Checkpoint.endSample < NOISY_RANGE_D3_START_SAMPLE,
      `The C3 gate was not cleared before the fixture's genuine D3 transition: ${JSON.stringify(c3Checkpoint)}.`);

    const nextClicked = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Next target');
      button?.click();
      return Boolean(button && !button.disabled);
    })()`);
    assert(nextClicked, "The C3-earned Next target action was not clickable.");
    await waitForBrowser(
      session,
      `document.querySelector('.nf-voice-target strong')?.textContent?.trim() === '${D3_LABEL}'
        && document.querySelectorAll('[data-note-input]').length === 1
        && document.querySelector('[data-note-input]') === window.__noteforgeCanonicalRangeInput`,
      "the same Range Loop NoteInput advancing to D3",
      4_000,
    );
    const nextAt = await evaluate(session, `window.__noteforgeNoisyRangeProof.snapshot().actions
      .find((action) => action.label === 'Next target')?.at ?? performance.now()`);

    await waitForBrowser(
      session,
      `(() => {
        const input = document.querySelector('[data-note-input]');
        const held = Number(input?.getAttribute('data-held-seconds'));
        const result = document.querySelector('.range-result-next b')?.textContent || '';
        return document.querySelector('.nf-voice-target strong')?.textContent?.trim() === '${D3_LABEL}'
          && input?.getAttribute('data-detected-note') === '${D3_LABEL}'
          && held >= ${REQUIRED_HOLD_SECONDS}
          && result.includes('${D3_LABEL} earned');
      })()`,
      "persistent real D3 becoming authoritative and earning D3",
      9_000,
    );
    const d3Checkpoint = await evaluate(session, `(() => {
      const input = document.querySelector('[data-note-input]');
      return {
        count: document.querySelectorAll('[data-note-input]').length,
        sameInput: input === window.__noteforgeCanonicalRangeInput,
        target: document.querySelector('.nf-voice-target strong')?.textContent?.trim() || null,
        detected: input?.getAttribute('data-detected-note') || null,
        heldSeconds: Number(input?.getAttribute('data-held-seconds')),
        endSample: Number(input?.getAttribute('data-end-sample')),
        result: document.querySelector('.range-result-next b')?.textContent?.trim() || null,
      };
    })()`);
    const d3RangeProof = await rangeProofSnapshot(session);
    const d3Hold = holdRegressions(
      d3RangeProof.snapshots,
      D3_LABEL,
      nextAt,
      d3Checkpoint.endSample,
    );
    const d3TrackedContradictions = d3RangeProof.snapshots.filter((snapshot) => (
      snapshot.at >= nextAt
      && snapshot.target === D3_LABEL
      && snapshot.endSample >= NOISY_RANGE_D3_START_SAMPLE + Math.round(0.25 * SAMPLE_RATE)
      && snapshot.detectedNote !== null
      && snapshot.detectedNote !== D3_LABEL
    ));
    failureEvidence = {
      c3Checkpoint,
      d3Checkpoint,
      d3HoldRegressions: d3Hold.regressions.slice(0, 8),
      d3TrackedContradictions: d3TrackedContradictions.slice(0, 12),
    };
    assert(d3Checkpoint.count === 1
      && d3Checkpoint.sameInput
      && d3Checkpoint.target === D3_LABEL
      && d3Checkpoint.detected === D3_LABEL
      && d3Checkpoint.heldSeconds >= REQUIRED_HOLD_SECONDS
      && d3Checkpoint.result?.includes(`${D3_LABEL} earned`),
    `Persistent D3 did not earn through the real shared Range Loop: ${JSON.stringify(failureEvidence)}.`);
    assert(d3Hold.regressions.length === 0 && d3TrackedContradictions.length === 0,
      `The D3 authority was sticky in the wrong way or unstable after a persistent real change: ${JSON.stringify(failureEvidence)}.`);

    const beforeDisable = await browserProofSnapshot(session);
    assert(beforeDisable.trackStopCalls.length === 0
      && beforeDisable.trackEnabledWrites.every(({ value }) => value !== false),
    `Capture was stopped or disabled before the visible Disable action: ${JSON.stringify(beforeDisable)}.`);
    const disabled = await evaluate(session, `(() => {
      const button = document.querySelector('[data-global-mic-disable]');
      button?.click();
      return Boolean(button && !button.disabled);
    })()`);
    assert(disabled, "The visible global Disable voice action was unavailable.");
    await waitForBrowser(
      session,
      `document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'disabled'`,
      "the explicit Disable voice boundary",
      5_000,
    );
    await delay(500);
    const stopped = await browserProofSnapshot(session);
    await delay(250);
    const settled = await browserProofSnapshot(session);
    assert(stopped.workletSampleMessages === settled.workletSampleMessages,
      `PCM continued after explicit Disable (${stopped.workletSampleMessages}->${settled.workletSampleMessages}).`);
    const diagnosticCount = await waitForDiagnosticCount(
      diagnosticBatches,
      settled.workletSampleMessages,
    );
    const events = orderedPitchEvents(diagnosticBatches);
    const stageSummary = detectorStageSummary(events);
    failureEvidence = { c3Checkpoint, d3Checkpoint, stageSummary };

    assert(settled.instrumentationErrors.length === 0 && consoleErrors.length === 0,
      `The production browser path emitted errors: ${JSON.stringify({ instrumentation: settled.instrumentationErrors, consoleErrors })}.`);
    assert(settled.getUserMediaCalls === 1
      && settled.streams === 1
      && settled.tracks === 1
      && settled.audioContexts === 1
      && settled.workletNodes === 1,
    `Expected one real microphone/worklet authority: ${JSON.stringify(settled)}.`);
    assert(settled.trackStopCalls.length === 1 && settled.stopButtonClicks === 0,
      `Only the one visible direct Disable click may stop the fake microphone: ${JSON.stringify(settled.trackStopCalls)}.`);
    assert(diagnosticCount === settled.workletSampleMessages,
      `Raw detector/worklet accounting differs: ${diagnosticCount}/${settled.workletSampleMessages}.`);
    for (let index = 1; index < settled.workletSampleEvents.length; index += 1) {
      const previous = settled.workletSampleEvents[index - 1];
      const current = settled.workletSampleEvents[index];
      assert(current.endSample - previous.endSample === CAPTURE_HOP_SAMPLES,
        `The production AudioWorklet skipped a configured analysis hop: ${JSON.stringify({ previous, current })}.`);
    }
    assert(stageSummary.every(({ frames }) => frames >= 20),
      `The raw detector did not traverse every authored interference stage: ${JSON.stringify(stageSummary)}.`);
    assert(d3Checkpoint.endSample < NOISY_RANGE_FIXTURE_SAMPLES,
      `D3 was not earned during the fixture's first persistent D3 run: ${JSON.stringify(d3Checkpoint)}.`);

    console.log("NOISY RANGE LOOP BROWSER PROOF PASSED");
    console.log(`  path: one getUserMedia -> MediaStreamAudioSourceNode -> AudioWorklet -> NoteInputEngine -> shared NoteInput -> real /practice/range-loop`);
    console.log(`  C3: ${c3Checkpoint.heldSeconds.toFixed(2)}s survived all ${NOISY_RANGE_C3_STAGES.length} interference stages with no hold regression; ${C3_LABEL}-earned Next ${D3_LABEL} became enabled`);
    console.log(`  D3: persistent real change became authoritative and earned ${d3Checkpoint.heldSeconds.toFixed(2)}s on the same NoteInput DOM node`);
    for (const stage of stageSummary) {
      console.log(`  ${stage.stage}: ${stage.frames} authoritative observations, ${stage.voiced} voiced, ${stage.unvoicedOrUncertain} unvoiced/uncertain, ${stage.contradictory} contradictory authorities, confidence median ${stage.medianConfidence ?? "n/a"}`);
    }
  } catch (error) {
    const context = [
      failureEvidence ? `Adversarial evidence:\n${JSON.stringify(failureEvidence, null, 2)}` : "",
      viteOutput.length ? `Vite output:\n${viteOutput.join("\n")}` : "",
      chromiumOutput.length ? `Chromium output:\n${chromiumOutput.join("\n")}` : "",
    ].filter(Boolean).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}${context ? `\n${context}` : ""}`);
  } finally {
    if (session) {
      try { await evaluate(session, "window.__noteforgeNoisyRangeProof?.stop?.(); true"); } catch { /* browser may already be gone */ }
      session.close();
    }
    await stopProcessGroup(chromium);
    await stopProcessGroup(vite);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
