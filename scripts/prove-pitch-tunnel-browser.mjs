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
  CAPTURE_HOP_SAMPLES,
  CAPTURE_WINDOW_SAMPLES,
  SAMPLE_RATE,
} from "./proof-support/note-input-fixture.mjs";
import { BROWSER_INSTRUMENTATION_SOURCE } from "./proof-support/note-input-instrumentation.mjs";
import {
  generatedPitchTunnelWav,
  PITCH_TUNNEL_ANCHOR_MIDI as ANCHOR_MIDI,
  PITCH_TUNNEL_CHECKPOINT_OFFSETS as CHECKPOINT_OFFSETS,
  PITCH_TUNNEL_LANE_HALF_WIDTH_CENTS as LANE_HALF_WIDTH_CENTS,
} from "./proof-support/pitch-tunnel-fixture.mjs";
import { PITCH_TUNNEL_INSTRUMENTATION_SOURCE } from "./proof-support/pitch-tunnel-instrumentation.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";
function frameKey(frame) {
  return `${frame.captureEpoch}:${frame.endSample}`;
}

function pitchEventsFrom(batches) {
  return batches.flatMap((batch) => batch.events ?? [])
    .filter((event) => event.kind === "pitch-frame" && event.pitch?.frame)
    .sort((left, right) => left.pitch.frame.captureEpoch - right.pitch.frame.captureEpoch
      || left.pitch.frame.endSample - right.pitch.frame.endSample);
}

function canonicalSnapshots(snapshots) {
  const canonical = [];
  for (const snapshot of snapshots) {
    if (!Number.isSafeInteger(snapshot.endSample) || !Number.isSafeInteger(snapshot.observedFrameCount)) continue;
    const previous = canonical.at(-1);
    if (previous && frameKey(previous) === frameKey(snapshot)) canonical[canonical.length - 1] = snapshot;
    else canonical.push(snapshot);
  }
  return canonical;
}

function transitionValues(values) {
  const transitions = [];
  for (const value of values) {
    if (value === null || transitions.at(-1) === value) continue;
    transitions.push(value);
  }
  return transitions;
}

function metricNumber(text) {
  if (typeof text !== "string" || text === "—") return null;
  const value = Number.parseFloat(text.replace("−", "-"));
  return Number.isFinite(value) ? value : null;
}

/**
 * Independent sample-coordinate oracle for the browser fixture. Capture
 * suspension/recovery is owned by the canonical note-input Chromium proof;
 * this oracle owns Pitch Tunnel's exact dwell/reset semantics over the real
 * detector frames, while reducer tests exhaust discontinuity/no-catch-up math.
 */
function expectedTrajectory(detectorFrames, anchorFrame) {
  const completions = [];
  const resets = [];
  let checkpointIndex = 0;
  let heldSeconds = 0;
  let totalInLaneSeconds = 0;
  let previous = anchorFrame;
  let previousReliable = true;
  let previousInLane = true;
  for (const frame of detectorFrames) {
    if (frame.endSample <= anchorFrame.endSample || completions.length === CHECKPOINT_OFFSETS.length) continue;
    const offset = CHECKPOINT_OFFSETS[checkpointIndex];
    const reliable = frame.observationKind === "voiced" && frame.voiced === true
      && Number.isFinite(frame.midiFloat) && Number.isFinite(frame.frequencyHz);
    const inLane = reliable
      && Math.abs((frame.midiFloat - anchorFrame.midiFloat) * 100 - offset)
        <= LANE_HALF_WIDTH_CENTS + 1e-9;
    const sameAuthority = frame.sampleRate === previous.sampleRate
      && frame.captureEpoch === previous.captureEpoch
      && frame.continuityEpoch === previous.continuityEpoch
      && frame.graphGeneration === previous.graphGeneration;
    const rawDelta = sameAuthority
      ? (frame.endSample - previous.endSample) / frame.sampleRate
      : 0;
    const continuous = sameAuthority && !frame.discontinuity
      && rawDelta > 0 && rawDelta <= 0.03 + 1e-9;
    const qualified = continuous && previousReliable && reliable && previousInLane && inLane;
    const heldBefore = heldSeconds;
    if (reliable && !inLane) {
      heldSeconds = 0;
      if (heldBefore > 0) resets.push({ checkpointIndex, heldBefore, frame });
    } else if (qualified) {
      heldSeconds = Math.min(1, heldSeconds + rawDelta);
      totalInLaneSeconds += rawDelta;
    }
    previous = frame;
    previousReliable = reliable;
    previousInLane = inLane;
    if (heldSeconds + 1e-9 < 1) continue;
    completions.push({
      checkpointIndex,
      targetOffsetCents: offset,
      heldSeconds,
      totalInLaneSeconds,
      frame,
    });
    checkpointIndex += 1;
    if (checkpointIndex === CHECKPOINT_OFFSETS.length) continue;
    heldSeconds = 0;
    const nextOffset = CHECKPOINT_OFFSETS[checkpointIndex];
    previousInLane = reliable
      && Math.abs((frame.midiFloat - anchorFrame.midiFloat) * 100 - nextOffset)
        <= LANE_HALF_WIDTH_CENTS + 1e-9;
  }
  return { completions, resets, totalInLaneSeconds };
}

async function synchronizedSnapshot(session, anchor, timeoutMilliseconds = 6_000) {
  return evaluate(session, `(async () => new Promise((resolveSnapshot) => {
    const deadline = performance.now() + ${timeoutMilliseconds};
    const check = () => {
      const native = window.__noteforgeNoteInputProof?.snapshot?.();
      const feature = window.__noteforgePitchTunnelProof?.snapshot?.();
      const lane = document.querySelector('[data-pitch-tunnel-lane]');
      const anchorIndex = native?.workletSampleEvents?.findIndex((frame) =>
        frame.captureEpoch === ${anchor.captureEpoch} && frame.endSample === ${anchor.endSample}) ?? -1;
      const observed = Number(lane?.getAttribute('data-observed-frame-count'));
      const endSample = Number(lane?.getAttribute('data-end-sample'));
      const last = native?.workletSampleEvents?.at(-1);
      const expected = anchorIndex < 0 ? -1 : native.workletSampleEvents.length - anchorIndex;
      if (feature && last && observed === expected && endSample === last.endSample) {
        resolveSnapshot({ native, feature });
        return;
      }
      if (performance.now() >= deadline) {
        resolveSnapshot({ native, feature, synchronizationFailure: { anchorIndex, observed, expected, endSample, last } });
        return;
      }
      setTimeout(check, 5);
    };
    check();
  }))()`, true);
}

async function main() {
  let temporaryDirectory;
  let preview;
  let chromium;
  let session;
  let previewOutput = [];
  let chromiumOutput = [];
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-pitch-tunnel-proof-"));
    const wavPath = join(temporaryDirectory, "pitch-tunnel.wav");
    const chromiumProfile = join(temporaryDirectory, "chromium-profile");
    const previewPort = await availablePort();
    const debugPort = await availablePort();
    const pageUrl = `http://127.0.0.1:${previewPort}/#/practice/pitch-tunnel`;
    await writeFile(wavPath, generatedPitchTunnelWav());

    preview = spawn(process.execPath, [
      join(REPOSITORY_ROOT, "node_modules/vite/bin/vite.js"),
      "preview", "--config", join(REPOSITORY_ROOT, "vite.config.ts"),
      "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort",
    ], { cwd: REPOSITORY_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    previewOutput = captureProcessOutput(preview, "vite-preview");
    await waitForHttp(`http://127.0.0.1:${previewPort}/`, preview, 12_000, previewOutput);

    chromium = spawn(CHROMIUM, [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}`,
      `--user-data-dir=${chromiumProfile}`, `--remote-debugging-port=${debugPort}`, "about:blank",
    ], { cwd: REPOSITORY_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    chromiumOutput = captureProcessOutput(chromium, "chromium");
    const target = await waitForPageTarget(debugPort, chromium, chromiumOutput);
    session = new DevToolsSession(target.webSocketDebuggerUrl);
    await session.connect();

    const diagnosticBatches = [];
    const browserErrors = [];
    session.on("Network.requestWillBeSent", ({ request }) => {
      if (!request?.url?.includes("/api/diagnostics/pitch") || !request.postData) return;
      try { diagnosticBatches.push(JSON.parse(request.postData)); } catch { /* missing evidence fails later */ }
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
      source: `${BROWSER_INSTRUMENTATION_SOURCE}\n${PITCH_TUNNEL_INSTRUMENTATION_SOURCE}`,
    });
    await session.send("Page.navigate", { url: pageUrl });
    await waitForBrowser(
      session,
      "document.readyState === 'complete' && Boolean(document.querySelector('[data-pitch-tunnel-lane]'))",
      "the direct built Pitch Tunnel route",
      10_000,
    );
    const assets = await evaluate(session, `[...document.querySelectorAll('script[src]')]
      .map((script) => new URL(script.src, location.href).pathname)`);
    assert(assets.some((path) => /^\/assets\/index-[A-Za-z0-9_-]+\.js$/u.test(path))
      && assets.every((path) => !path.includes('/@vite/') && !path.includes('/src/')),
    `Pitch Tunnel proof did not load the built application: ${JSON.stringify(assets)}`);
    const enabled = await evaluate(session, `(() => {
      const button = document.querySelector('[data-global-mic-enable]');
      button?.click();
      return Boolean(button);
    })()`);
    assert(enabled, "The sole global Enable voice control was not available.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-pitch-tunnel-lane]')?.getAttribute('data-input-state') === 'running'",
      "the retained running microphone",
      8_000,
    );
    await waitForBrowser(
      session,
      `(() => {
        const lane = document.querySelector('[data-pitch-tunnel-lane]');
        const midi = Number(lane?.getAttribute('data-live-midi'));
        return lane?.getAttribute('data-workflow-step') === 'idle'
          && lane?.getAttribute('data-observation-kind') === 'voiced'
          && Math.abs(midi - ${ANCHOR_MIDI}) <= 0.04;
      })()`,
      "the live C3 anchor candidate",
      5_000,
    );
    const anchorClicked = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('[data-pitch-tunnel] button')]
        .find((candidate) => candidate.textContent?.trim() === 'Start trace here');
      button?.click();
      return Boolean(button);
    })()`);
    assert(anchorClicked, "The real Start trace here action was not clickable.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-pitch-tunnel-lane]')?.getAttribute('data-workflow-step') === 'tracking'",
      "the explicitly started sample-authoritative session",
      2_000,
    );
    const anchor = await evaluate(session, `(() => {
      const lane = document.querySelector('[data-pitch-tunnel-lane]');
      return {
        workflowStep: lane?.getAttribute('data-workflow-step'),
        captureEpoch: Number(lane?.getAttribute('data-capture-epoch')),
        endSample: Number(lane?.getAttribute('data-end-sample')),
        observedFrameCount: Number(lane?.getAttribute('data-observed-frame-count')),
        liveMidi: Number(lane?.getAttribute('data-live-midi')),
      };
    })()`);
    assert(anchor.workflowStep === "tracking"
      && anchor.observedFrameCount === 1 && Math.abs(anchor.liveMidi - ANCHOR_MIDI) <= 0.04,
    `The real Start action did not adopt the exact live C3 authority: ${JSON.stringify(anchor)}`);

    await waitForBrowser(
      session,
      `(() => {
        const snapshots = window.__noteforgePitchTunnelProof?.snapshot?.().tunnelSnapshots ?? [];
        const achieved = snapshots.findIndex((frame) => frame.workflowStep === 'tracking'
          && frame.traceLifetime === 'user-owned'
          && frame.achievementReached
          && frame.completedCheckpointCount === ${CHECKPOINT_OFFSETS.length});
        if (achieved < 0) return false;
        const after = snapshots.slice(achieved + 1);
        return after.some((frame) => frame.liveMidi !== null && Math.abs(frame.liveMidi - 49) <= 0.08)
          && after.some((frame) => frame.observationKind === 'unvoiced' && frame.liveMidi === null)
          && after.every((frame) => frame.workflowStep === 'tracking');
      })()`,
      "all nine checkpoints and post-achievement user-owned live authority",
      30_000,
    );

    const finishClicked = await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('[data-pitch-tunnel] button')]
        .find((candidate) => candidate.textContent?.trim() === 'Finish trace');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert(finishClicked, "The explicit Pitch Tunnel Finish trace action was unavailable.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-pitch-tunnel-lane]')?.getAttribute('data-workflow-step') === 'complete'",
      "Pitch Tunnel completion after explicit Finish trace",
      2_000,
    );
    await delay(300);

    let synchronized = await synchronizedSnapshot(session, anchor);
    assert(!synchronized.synchronizationFailure,
      `Pitch Tunnel did not consume every post-anchor observation: ${JSON.stringify(synchronized.synchronizationFailure)}`);
    const armed = await evaluate(session, `(() => {
      const control = window.__noteforgeNoteInputProof;
      const button = document.querySelector('[data-global-mic-disable]');
      return Boolean(button && !button.disabled && control?.armStopOnNextSample?.());
    })()`);
    assert(armed, "The explicit global Disable boundary could not be armed.");
    await waitForBrowser(
      session,
      "document.querySelector('[data-pitch-tunnel-lane]')?.getAttribute('data-input-state') === 'disabled'",
      "the explicit global Disable action",
      5_000,
    );
    synchronized = await synchronizedSnapshot(session, anchor);
    assert(!synchronized.synchronizationFailure,
      `The final pre-Disable observation was not consumed: ${JSON.stringify(synchronized.synchronizationFailure)}`);
    await delay(1_200);

    const native = synchronized.native;
    const feature = synchronized.feature;
    const snapshots = canonicalSnapshots(feature.tunnelSnapshots)
      .filter((frame) => frame.workflowStep !== "idle");
    const workletFrames = native.workletSampleEvents;
    const anchorOrdinal = workletFrames.findIndex((frame) => frameKey(frame) === frameKey(anchor));
    const postAnchorWorkletFrames = workletFrames.slice(anchorOrdinal);
    const workletByKey = new Map(workletFrames.map((frame, index) => [frameKey(frame), { frame, index }]));
    const pitchEvents = pitchEventsFrom(diagnosticBatches);
    const detectorByKey = new Map(pitchEvents.map((event) => [frameKey(event.pitch.frame), event.pitch.frame]));

    assert(native.instrumentationErrors.length === 0 && feature.instrumentationErrors.length === 0,
      `Browser instrumentation failed: ${JSON.stringify([...native.instrumentationErrors, ...feature.instrumentationErrors])}`);
    assert(native.getUserMediaCalls === 1 && native.streams === 1 && native.tracks === 1
      && native.audioContexts === 1 && feature.mediaStreamSources === 1 && native.workletNodes === 1,
    `Pitch Tunnel created duplicate capture authority: ${JSON.stringify({
      getUserMediaCalls: native.getUserMediaCalls,
      streams: native.streams,
      tracks: native.tracks,
      audioContexts: native.audioContexts,
      sources: feature.mediaStreamSources,
      worklets: native.workletNodes,
    })}`);
    assert(native.trackInitialStates.length === 1 && native.trackInitialStates[0].enabled === true
      && native.trackEnabledWrites.length === 0 && native.trackStopCalls.length === 1
      && native.stopButtonClicks === 1
      && native.explicitStopSampleMessageCount === native.workletSampleMessages,
    `The retained track was changed outside the one explicit Disable boundary: ${JSON.stringify({
      initial: native.trackInitialStates,
      enabledWrites: native.trackEnabledWrites,
      stops: native.trackStopCalls,
      stopClicks: native.stopButtonClicks,
      stopBoundary: native.explicitStopSampleMessageCount,
      finalSamples: native.workletSampleMessages,
    })}`);
    assert(native.oscillators === 0 && native.oscillatorStarts.length === 0
      && feature.bufferSourceStarts === 0 && feature.mediaElementPlayCalls === 0,
    `Pitch Tunnel played audio: ${JSON.stringify({
      oscillators: native.oscillators,
      oscillatorStarts: native.oscillatorStarts,
      bufferSourceStarts: feature.bufferSourceStarts,
      mediaElementPlayCalls: feature.mediaElementPlayCalls,
    })}`);
    assert(anchorOrdinal >= 0 && postAnchorWorkletFrames.length > 600,
      `Anchor authority was absent from native worklet evidence: ${JSON.stringify(anchor)}`);
    assert(postAnchorWorkletFrames.every((frame, index) => (
      frame.sampleCount === CAPTURE_WINDOW_SAMPLES
      && frame.processedSampleCount === frame.endSample
      && (index === 0 || frame.endSample - postAnchorWorkletFrames[index - 1].endSample === CAPTURE_HOP_SAMPLES)
    )), "Post-anchor worklet authority was not one monotonic overlapping-window sequence.");
    assert(detectorByKey.size >= postAnchorWorkletFrames.length
      && postAnchorWorkletFrames.every((frame) => detectorByKey.has(frameKey(frame))),
    `Production diagnostics omitted worklet windows after the anchor: detector=${detectorByKey.size}, postAnchor=${postAnchorWorkletFrames.length}.`);

    const publicationFailures = [];
    for (let index = 0; index < snapshots.length; index += 1) {
      const frame = snapshots[index];
      const authority = workletByKey.get(frameKey(frame));
      const detector = detectorByKey.get(frameKey(frame));
      const expectedCount = authority ? authority.index - anchorOrdinal + 1 : null;
      if (!authority || !detector || frame.observedFrameCount !== expectedCount
        || frame.processedSampleCount !== frame.endSample
        || frame.sampleRate !== SAMPLE_RATE
        || frame.startSample !== authority.frame.startSample
        || frame.continuityEpoch !== authority.frame.continuityEpoch
        || frame.graphGeneration !== authority.frame.graphGeneration) {
        publicationFailures.push(`${frameKey(frame)} count=${frame.observedFrameCount}/${expectedCount}`);
      }
      const previous = snapshots[index - 1];
      if (previous && (frame.endSample <= previous.endSample
        || frame.observedFrameCount <= previous.observedFrameCount)) {
        publicationFailures.push(`${frameKey(previous)} -> ${frameKey(frame)} not monotonic`);
      }
    }
    assert(publicationFailures.length === 0,
      `Bounded Pitch Tunnel DOM publications lost exact sample authority: ${JSON.stringify(publicationFailures)}`);
    const finalSnapshot = snapshots.at(-1);
    assert(finalSnapshot.observedFrameCount === postAnchorWorkletFrames.length,
      `Pitch Tunnel consumed ${finalSnapshot.observedFrameCount}/${postAnchorWorkletFrames.length} post-anchor observations.`);
    const publicationSeconds = (
      finalSnapshot.endSample - snapshots[0].endSample
    ) / SAMPLE_RATE;
    const maximumPublications = Math.ceil(publicationSeconds * 30) + 2;
    assert(snapshots.length >= Math.floor(publicationSeconds * 10)
      && snapshots.length <= maximumPublications,
    `React publication cadence was not live and bounded: ${snapshots.length} across ${publicationSeconds.toFixed(3)}s (max ${maximumPublications}).`);

    const targetTransitions = transitionValues(snapshots
      .filter((frame) => frame.workflowStep === "tracking")
      .map((frame) => frame.targetOffsetCents));
    assert(CHECKPOINT_OFFSETS.every((offset, index) => targetTransitions[index] === offset),
      `Rendered checkpoint order was not the exact round trip: ${JSON.stringify(targetTransitions)}`);
    const anchorDetector = detectorByKey.get(frameKey(anchor));
    assert(anchorDetector?.voiced && Number.isFinite(anchorDetector.midiFloat),
      `The clicked anchor lacked its exact voiced detector frame: ${JSON.stringify(anchorDetector)}`);
    const trajectory = expectedTrajectory(
      pitchEvents.map((event) => event.pitch.frame),
      anchorDetector,
    );
    assert(trajectory.completions.length === CHECKPOINT_OFFSETS.length
      && trajectory.completions.every((completion, index) => (
        completion.checkpointIndex === index
        && completion.targetOffsetCents === CHECKPOINT_OFFSETS[index]
        && Math.abs(completion.heldSeconds - 1) <= 1e-9
      )),
    `Independent sample oracle did not complete nine exact 1.0s dwells: ${JSON.stringify(trajectory.completions)}`);
    const completionPublicationFailures = [];
    for (const completion of trajectory.completions) {
      const published = snapshots.find((frame) => frameKey(frame) === frameKey(completion.frame));
      const final = completion.checkpointIndex === CHECKPOINT_OFFSETS.length - 1;
      const expectedIndex = final ? completion.checkpointIndex : completion.checkpointIndex + 1;
      const expectedOffset = CHECKPOINT_OFFSETS[expectedIndex];
      if (!published
        || published.workflowStep !== "tracking"
        || published.traceLifetime !== "user-owned"
        || published.achievementReached !== final
        || published.checkpointIndex !== expectedIndex
        || published.targetOffsetCents !== expectedOffset
        || (final ? Math.abs(published.checkpointHeldSeconds - 1) > 1e-9
          : published.checkpointHeldSeconds !== 0)) {
        completionPublicationFailures.push({ completion, published });
      }
    }
    assert(completionPublicationFailures.length === 0,
      `Checkpoint/status transitions did not publish the exact completing detector frame: ${JSON.stringify(completionPublicationFailures)}`);
    const centerMeasurements = [...new Set(CHECKPOINT_OFFSETS)].map((offset) => {
      const targetMidi = anchorDetector.midiFloat + offset / 100;
      const closest = postAnchorWorkletFrames
        .map((frame) => detectorByKey.get(frameKey(frame)))
        .filter((frame) => frame?.voiced && Number.isFinite(frame.midiFloat))
        .sort((left, right) => Math.abs(left.midiFloat - targetMidi)
          - Math.abs(right.midiFloat - targetMidi))[0];
      return { offset, targetMidi, measuredMidi: closest?.midiFloat ?? null };
    });
    assert(centerMeasurements.every(({ targetMidi, measuredMidi }) =>
      measuredMidi !== null && Math.abs(measuredMidi - targetMidi) <= 0.03),
    `Detector/UI path collapsed continuous quarter-tone coordinates: ${JSON.stringify(centerMeasurements)}`);
    assert(feature.laneElements === 1 && snapshots.every((frame) => frame.laneId === 1),
      `Pitch Tunnel replaced its live lane across workflow states: ${feature.laneElements} lane elements.`);
    assert(snapshots.every((frame) => frame.laneLabel === `±${LANE_HALF_WIDTH_CENTS}¢ TARGET WALLS`),
      `Pitch Tunnel did not retain one ±${LANE_HALF_WIDTH_CENTS}¢ lane.`);
    const achievementSnapshots = snapshots.filter((frame) => frame.workflowStep === "tracking"
      && frame.traceLifetime === "user-owned"
      && frame.achievementReached
      && frame.completedCheckpointCount === CHECKPOINT_OFFSETS.length);
    const completeSnapshots = snapshots.filter((frame) => frame.workflowStep === "complete");
    assert(achievementSnapshots.length > 4,
      "The ninth checkpoint replaced the user-owned trace instead of latching an inline achievement.");
    assert(completeSnapshots.length > 4
      && completeSnapshots.every((frame) => frame.completedCheckpointCount === CHECKPOINT_OFFSETS.length)
      && completeSnapshots[0].endSample >= achievementSnapshots[0].endSample,
    "The same instrument reached terminal completion only after explicit Finish trace.");

    const silenceFrames = snapshots.filter((frame) => frame.workflowStep === "tracking"
      && frame.targetOffsetCents === 50 && frame.observationKind === "unvoiced");
    assert(silenceFrames.length >= 3
      && silenceFrames[0].checkpointHeldSeconds > 0.1
      && silenceFrames.every((frame) => frame.liveMidi === null && frame.pointOpacity === 0
        && frame.checkpointIndex === silenceFrames[0].checkpointIndex
        && Math.abs(frame.checkpointHeldSeconds - silenceFrames[0].checkpointHeldSeconds) <= 1e-9),
    `Silence did not clear the point and pause retained dwell: ${JSON.stringify(silenceFrames)}`);
    const wrongFrames = snapshots.filter((frame) => frame.workflowStep === "tracking"
      && frame.targetOffsetCents === 75 && frame.observationKind === "voiced"
      && frame.liveMidi !== null && frame.liveMidi > ANCHOR_MIDI + 1.45);
    const preWrong = snapshots.filter((frame) => frame.workflowStep === "tracking"
      && frame.targetOffsetCents === 75 && frame.inLane === "true"
      && frame.endSample < (wrongFrames[0]?.endSample ?? 0)).at(-1);
    assert(preWrong?.checkpointHeldSeconds > 0.1 && wrongFrames.length >= 3
      && wrongFrames.every((frame) => frame.inLane === "false"
        && frame.checkpointHeldSeconds === 0
        && frame.inLaneSeconds >= preWrong.inLaneSeconds),
    `Credible wrong pitch did not reset only current dwell: ${JSON.stringify({ preWrong, wrongFrames })}`);
    const firstAchievement = achievementSnapshots[0];
    assert(trajectory.resets.some((reset) => reset.checkpointIndex === 3
      && reset.heldBefore > 0.1)
      && Math.abs(firstAchievement.inLaneSeconds - trajectory.totalInLaneSeconds) <= 1e-9
      && finalSnapshot.inLaneSeconds > firstAchievement.inLaneSeconds,
    `Wrong-pitch reset erased or fabricated aggregate sample time: ${JSON.stringify({
      resets: trajectory.resets,
      achievementTotal: firstAchievement.inLaneSeconds,
      renderedTotal: finalSnapshot.inLaneSeconds,
      authoredTrajectoryTotal: trajectory.totalInLaneSeconds,
    })}`);

    const firstAnchorDetector = pitchEvents
      .map((event) => event.pitch.frame)
      .find((frame) => frame.endSample <= anchor.endSample && frame.voiced
        && frame.midiFloat !== null && Math.abs(frame.midiFloat - ANCHOR_MIDI) <= 0.04);
    const firstAnchorDom = feature.tunnelSnapshots.find((frame) => frame.workflowStep === "idle"
      && frame.observationKind === "voiced" && frame.liveMidi !== null
      && Math.abs(frame.liveMidi - ANCHOR_MIDI) <= 0.04);
    assert(firstAnchorDetector && firstAnchorDom && frameKey(firstAnchorDetector) === frameKey(firstAnchorDom),
      `The initial C3 candidate was not rendered on its first exact detector frame: ${JSON.stringify({ firstAnchorDetector, firstAnchorDom })}`);
    const firstSilenceIndex = pitchEvents.findIndex((event) => {
      const frame = event.pitch.frame;
      return frame.endSample > anchor.endSample && !frame.voiced && frame.rms === 0;
    });
    const firstVoicedAfterSilence = pitchEvents.slice(firstSilenceIndex + 1)
      .map((event) => event.pitch.frame)
      .find((frame) => frame.voiced && frame.midiFloat !== null
        && Math.abs(frame.midiFloat - (ANCHOR_MIDI + 0.5)) <= 0.04);
    const firstDomAfterSilence = silenceFrames.length === 0 ? null : snapshots.find((frame) =>
      frame.endSample > silenceFrames.at(-1).endSample && frame.observationKind === "voiced"
        && frame.liveMidi !== null && Math.abs(frame.liveMidi - (ANCHOR_MIDI + 0.5)) <= 0.04);
    assert(firstVoicedAfterSilence && firstDomAfterSilence
      && frameKey(firstVoicedAfterSilence) === frameKey(firstDomAfterSilence),
    `Voiced F0 after silence was not published on its first exact frame: ${JSON.stringify({ firstVoicedAfterSilence, firstDomAfterSilence })}`);

    const achievementVoiced = achievementSnapshots.find((frame) => frame.liveMidi !== null
      && Math.abs(frame.liveMidi - (ANCHOR_MIDI + 1)) <= 0.08);
    const achievementSilence = achievementSnapshots.find((frame) => frame.observationKind === "unvoiced"
      && frame.liveMidi === null && frame.endSample > (achievementVoiced?.endSample ?? 0));
    assert(achievementVoiced && achievementSilence
      && achievementSilence.observedFrameCount > achievementVoiced.observedFrameCount,
    `Achieving the trajectory stopped the user-owned live authority: ${JSON.stringify({ achievementVoiced, achievementSilence })}`);
    assert(finalSnapshot.workflowStep === "complete"
      && finalSnapshot.observedFrameCount > completeSnapshots[0].observedFrameCount
      && completeSnapshots.every((frame) => (
        Math.abs(frame.inLaneSeconds - completeSnapshots[0].inLaneSeconds) <= 1e-9
      )),
    `The live instrument stopped following observations after explicit Finish: ${JSON.stringify({ firstComplete: completeSnapshots[0], finalSnapshot })}`);
    const finiteMetricSnapshot = achievementSnapshots.find((frame) => [
      frame.metrics.Distance,
      frame.metrics["Time in lane"],
      frame.metrics.Overshoots,
      frame.metrics.Correction,
      frame.metrics.Stability,
    ].every((value) => metricNumber(value) !== null));
    assert(finiteMetricSnapshot,
      `Achievement did not render finite clinical metrics: ${JSON.stringify(achievementSnapshots.map((frame) => frame.metrics))}`);
    assert(browserErrors.length === 0,
      `Chromium reported browser errors: ${JSON.stringify(browserErrors)}`);

    console.log("Pitch Tunnel production browser proof passed.");
    console.log(`  authority: 1 stream · 1 track · 1 source · 1 worklet · ${postAnchorWorkletFrames.length} exact post-anchor observations`);
    console.log(`  presentation: ${snapshots.length} exact DOM publications across ${publicationSeconds.toFixed(2)} sample-seconds · <=30 Hz`);
    console.log(`  trajectory: ${targetTransitions.slice(0, CHECKPOINT_OFFSETS.length).join(" -> ")} cents · 9 exact 1.00s dwells · ±${LANE_HALF_WIDTH_CENTS}¢ · achievement remained tracking`);
    console.log(`  boundaries: silence retained ${silenceFrames[0].checkpointHeldSeconds.toFixed(2)}s dwell · credible wrong reset to 0.00s`);
    console.log(`  lifetime: achievement stayed live and scoring grew ${firstAchievement.inLaneSeconds.toFixed(2)}s -> ${finalSnapshot.inLaneSeconds.toFixed(2)}s; explicit Finish froze scoring while telemetry continued · no playback`);
  } catch (error) {
    throw new Error([
      error instanceof Error ? error.stack || error.message : String(error),
      ...previewOutput,
      ...chromiumOutput,
    ].join("\n"));
  } finally {
    session?.close();
    await stopProcessGroup(chromium);
    await stopProcessGroup(preview);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
