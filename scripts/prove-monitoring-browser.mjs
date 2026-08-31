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
  MONITORING_INSTRUMENTATION_SOURCE,
  clickHitTested,
  inspectMobileGlobalControls,
  inspectSettingsReachability,
  proofSnapshot,
  setRangeValue,
  waitForMonitoringSetting,
  waitForWorkletAdvance,
} from "./proof-support/monitoring-browser.mjs";
import { generatedMonitoringC3Wav } from "./proof-support/note-input-fixture.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CHROMIUM = process.env.NOTEFORGE_CHROMIUM || "/usr/bin/chromium";
const ROUTE = "/#/practice/pitch-match/glide";
const VIEWPORTS = Object.freeze([
  { width: 320, height: 568, label: "320x568" },
  { width: 390, height: 844, label: "390x844" },
]);

function describe(value) {
  return JSON.stringify(value, null, 2);
}

function nodeById(proof, id) {
  return proof.nodes.find((node) => node.id === id) ?? null;
}

function graphAuthority(proof, label) {
  const sources = proof.nodes.filter((node) => node.kind === "media-stream-source");
  const worklets = proof.nodes.filter((node) => node.kind === "audio-worklet");
  const destinations = proof.nodes.filter((node) => node.kind === "destination");
  assert(proof.productionContexts.length === 1,
    `${label}: expected one production context: ${describe(proof.productionContexts)}.`);
  assert(proof.getUserMediaCalls.length === 1 && proof.streams === 1 && proof.tracks === 1,
    `${label}: microphone authority was not singular: ${describe(proof)}.`);
  assert(sources.length === 1 && worklets.length === 1 && destinations.length === 1
    && proof.workletNodes === 1 && proof.sourceTrackMatches === 1,
  `${label}: source/worklet/destination topology was not singular: ${describe({ sources, worklets, destinations, proof })}.`);

  const source = sources[0];
  const worklet = worklets[0];
  const destination = destinations[0];
  const sourceEdges = proof.edges.filter((edge) => edge.from === source.id);
  const directGainEdge = sourceEdges.find((edge) => {
    const candidate = nodeById(proof, edge.to);
    return candidate?.kind === "gain"
      && proof.edges.some((next) => next.from === candidate.id && next.to === destination.id);
  });
  const analysisEdge = sourceEdges.find((edge) => edge.to === worklet.id);
  const analysisGainEdge = proof.edges.find((edge) => edge.from === worklet.id
    && nodeById(proof, edge.to)?.kind === "gain");
  const analysisDestinationEdge = analysisGainEdge && proof.edges.find((edge) =>
    edge.from === analysisGainEdge.to && edge.to === destination.id);
  assert(directGainEdge && analysisEdge && analysisGainEdge && analysisDestinationEdge,
    `${label}: missing direct or analysis branch: ${describe({ nodes: proof.nodes, edges: proof.edges })}.`);
  assert(directGainEdge.to !== analysisGainEdge.to,
    `${label}: monitor and analysis shared a gain node.`);
  assert(sourceEdges.length === 2,
    `${label}: source had ${sourceEdges.length} outgoing connections instead of monitor + analysis.`);
  assert(!proof.edges.some((edge) => edge.from === worklet.id && edge.to === directGainEdge.to),
    `${label}: monitor gain was downstream of the worklet.`);
  return Object.freeze({
    contextId: proof.productionContexts[0].id,
    sourceId: source.id,
    workletId: worklet.id,
    monitorGainId: directGainEdge.to,
    analysisGainId: analysisGainEdge.to,
    destinationId: destination.id,
  });
}

function assertSameAuthority(before, after, authority, label) {
  const current = graphAuthority(after, label);
  assert(current.contextId === authority.contextId
    && current.sourceId === authority.sourceId
    && current.workletId === authority.workletId
    && current.monitorGainId === authority.monitorGainId
    && current.analysisGainId === authority.analysisGainId,
  `${label}: monitoring changed graph authority: ${describe({ authority, current })}.`);
  assert(after.getUserMediaCalls.length === before.getUserMediaCalls.length
    && after.workletNodes === before.workletNodes
    && after.sourceTrackMatches === before.sourceTrackMatches,
  `${label}: monitoring allocated capture resources.`);
  assert(after.trackEnabledWrites.length === 0 && after.trackStops.length === 0,
    `${label}: monitoring changed or stopped the track.`);
}

function latestRamp(proof, nodeId) {
  return proof.gainEvents.filter((event) =>
    event.nodeId === nodeId && event.method === "linearRampToValueAtTime").at(-1) ?? null;
}

function assertRamp(proof, nodeId, target, label) {
  const event = latestRamp(proof, nodeId);
  const automationStart = event && proof.gainEvents.filter((candidate) =>
    candidate.nodeId === nodeId
      && candidate.at <= event.at
      && (candidate.method === "cancelAndHoldAtTime"
        || candidate.method === "cancelScheduledValues"))
    .at(-1);
  assert(event && Math.abs(event.value - target) < 1e-9
    && automationStart
    && Math.abs(event.when - automationStart.when - 0.005) < 1e-6,
  `${label}: monitor did not use one 5 ms ramp to ${target}: ${describe({ automationStart, event })}.`);
  const foreignNonzero = proof.gainEvents.some((candidate) =>
    candidate.nodeId !== nodeId
      && candidate.method === "linearRampToValueAtTime"
      && Number(candidate.value) > 0);
  assert(!foreignNonzero, `${label}: a non-monitor gain received audible automation.`);
}

function assertPcmContinuity(before, after, label) {
  assert(after.workletSamples.length > before.workletSamples.length,
    `${label}: PCM did not continue.`);
  const segment = after.workletSamples.slice(before.workletSamples.length);
  assert(segment.every((frame, index) => {
    const previous = index === 0 ? before.workletSamples.at(-1) : segment[index - 1];
    return previous
      && frame.endSample - previous.endSample === 960
      && frame.captureEpoch === previous.captureEpoch
      && frame.continuityEpoch === previous.continuityEpoch
      && frame.graphGeneration === previous.graphGeneration;
  }), `${label}: monitoring introduced a missing hop or authority change: ${describe(segment.slice(0, 4))}.`);
}

function assertGlobalLayout(layout, viewport, phase) {
  assert(layout.documentWidth === layout.clientWidth,
    `${viewport.label} ${phase}: document overflow ${layout.clientWidth}->${layout.documentWidth}.`);
  for (const [name, control] of Object.entries({ microphone: layout.microphone, monitor: layout.monitor })) {
    assert(control.exists && !control.disabled && control.inBounds && control.hit,
      `${viewport.label} ${phase}: ${name} control was not visible/hit-testable: ${describe(control)}.`);
  }
  assert(layout.monitor.hasIcon && /Only\s*·?\s*(?:Off|Ready|On)/iu.test(layout.monitor.visibleText),
    `${viewport.label} ${phase}: phone monitor control lacked visible headphones-only state: ${describe(layout.monitor)}.`);
}

function expectedLatency(seconds) {
  return Number.isFinite(seconds) ? `${(seconds * 1_000).toFixed(1)} ms` : "Not reported";
}

function expectedSwitch(value) {
  if (value === undefined) return "Not reported";
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

function assertDiagnosticAuthority(layout, proof, label) {
  const context = proof.productionContexts[0];
  const settings = proof.trackSettings[0] ?? {};
  const rows = layout.diagnosticsRows;
  const lastRead = (name) => proof.contextLatencyReads
    .filter((entry) => entry.contextId === context.id && entry.name === name)
    .at(-1)?.value;
  const expected = {
    "Requested latency hint": "Interactive",
    "Context sample rate": `${context.sampleRate.toLocaleString("en-US")} Hz`,
    "WebAudio base latency": expectedLatency(lastRead("baseLatency")),
    "Reported output latency": expectedLatency(lastRead("outputLatency")),
    "Reported input latency": expectedLatency(settings.latency),
    "Echo cancellation": expectedSwitch(settings.echoCancellation),
    "Noise suppression": expectedSwitch(settings.noiseSuppression),
    "Automatic gain": expectedSwitch(settings.autoGainControl),
  };
  assert(Object.entries(expected).every(([key, value]) => rows[key] === value),
    `${label}: rendered diagnostics diverged from browser authority: ${describe({ expected, rows, context, settings })}.`);
}

function assertSettingsLayout(layout, viewport) {
  assert(layout.drawer && ["auto", "scroll"].includes(layout.drawer.overflowY),
    `${viewport.label}: Settings drawer is not vertically scrollable: ${describe(layout.drawer)}.`);
  assert(layout.results.every((result) => result.exists && result.inBounds && result.hit),
    `${viewport.label}: a Settings monitoring surface was unreachable: ${describe(layout.results)}.`);
  const close = layout.results.find((result) => result.selector === "close");
  const summary = layout.results.find((result) => result.selector === "diagnostics-summary");
  assert(close?.rect?.width >= 44 && close?.rect?.height >= 44
    && summary?.rect?.height >= 44,
  `${viewport.label}: mobile Settings touch targets were undersized: ${describe({ close, summary })}.`);
  assert(/Use wired headphones/u.test(layout.warning)
    && /Speaker monitoring can feed back/u.test(layout.warning),
  `${viewport.label}: headphone/feedback warning was absent: ${layout.warning}.`);
  assert(/System default/u.test(layout.output) && !layout.hasOutputChooser,
    `${viewport.label}: unsupported output routing did not render a truthful fallback: ${describe(layout)}.`);
  assert(/browser-reported estimates/u.test(layout.diagnosticsText)
    && /not measured microphone-to-ear round-trip latency/u.test(layout.diagnosticsText),
  `${viewport.label}: latency diagnostics made an unqualified measurement claim.`);
}

async function uiState(session) {
  return evaluate(session, `(() => {
    const monitor = document.querySelector('[data-global-monitor-toggle]');
    const root = document.querySelector('.global-mic-control');
    const note = document.querySelector('[data-note-input]');
    return {
      monitorPressed: monitor?.getAttribute('aria-pressed') ?? null,
      monitorEffective: root?.getAttribute('data-monitor-effective') ?? null,
      micEnable: Boolean(document.querySelector('[data-global-mic-enable]')),
      micDisable: Boolean(document.querySelector('[data-global-mic-disable]')),
      detected: note?.querySelector('[data-detected-note]')?.getAttribute('data-detected-note') ?? null,
      endSample: Number(note?.getAttribute('data-end-sample') || 0),
      inputState: note?.getAttribute('data-input-state') ?? null,
    };
  })()`);
}

async function openAndInspectSettings(session, viewport) {
  await clickHitTested(session, "[data-settings-open]", `${viewport.label} Settings`);
  await waitForBrowser(session, "Boolean(document.querySelector('[data-settings-monitor-toggle]'))", "monitoring Settings");
  await clickHitTested(session, ".audio-diagnostics > summary", `${viewport.label} audio diagnostics`);
  await waitForBrowser(session, "document.querySelector('.audio-diagnostics')?.open === true", "open audio diagnostics");
  const layout = await inspectSettingsReachability(session);
  assertSettingsLayout(layout, viewport);
  return layout;
}

async function closeSettings(session, viewport) {
  await clickHitTested(session, 'button[aria-label="Close settings"]', `${viewport.label} close Settings`);
  await waitForBrowser(session, "!document.querySelector('.settings-drawer')", "Settings dismissal");
}

async function waitForC3(session) {
  await waitForBrowser(
    session,
    `document.querySelector('[data-note-input]')?.getAttribute('data-input-state') === 'running'
      && document.querySelector('[data-detected-note]')?.getAttribute('data-detected-note') === 'C3'`,
    "generated C3 through the production worklet and detector",
    12_000,
  );
}

async function beginC3PublicationAudit(session) {
  await evaluate(session, `(() => {
    window.__monitoringPitchObserver?.disconnect();
    window.__monitoringPitchClaims = [];
    const input = document.querySelector('[data-note-input]');
    if (!input) return false;
    const record = () => {
      const value = input.getAttribute('data-pitch-presentation-claim');
      if (value && window.__monitoringPitchClaims.at(-1) !== value) {
        window.__monitoringPitchClaims.push(value);
      }
    };
    record();
    window.__monitoringPitchObserver = new MutationObserver(record);
    window.__monitoringPitchObserver.observe(input, {
      attributes: true,
      attributeFilter: ['data-pitch-presentation-claim'],
    });
    return true;
  })()`);
}

async function assertC3Publications(session, label) {
  const claims = await evaluate(session, `(() => {
    window.__monitoringPitchObserver?.disconnect();
    return (window.__monitoringPitchClaims ?? []).map((value) => JSON.parse(value));
  })()`);
  assert(claims.length >= 2 && claims.every((claim) =>
    claim[4] === "voiced" && claim[9] === 48 && claim[10] === "running"),
  `${label}: clean C3 publication changed during monitoring: ${describe(claims)}.`);
}

async function proveViewport(session, origin, viewport) {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1,
    mobile: true, screenWidth: viewport.width, screenHeight: viewport.height,
  });
  await session.send("Page.navigate", { url: "about:blank" });
  await waitForBrowser(session, "location.href === 'about:blank'", "blank page reset");
  await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
  await session.send("Page.navigate", { url: `${origin}${ROUTE}` });
  await waitForBrowser(session,
    "Boolean(document.querySelector('[data-global-monitor-toggle]')) && Boolean(document.querySelector('[data-global-mic-enable]'))",
    `${viewport.label} hydrated global audio controls`, 15_000);

  const defaultLayout = await inspectMobileGlobalControls(session);
  assertGlobalLayout(defaultLayout, viewport, "default");
  const defaultState = await uiState(session);
  const defaultProof = await proofSnapshot(session);
  assert(defaultState.monitorPressed === "false" && defaultState.monitorEffective === "false"
    && defaultState.micEnable && defaultProof.getUserMediaCalls.length === 0
    && defaultProof.productionContexts.length === 0,
  `${viewport.label}: monitoring did not hydrate Off without opening audio: ${describe({ defaultState, defaultProof })}.`);
  await clickHitTested(session, "[data-global-mic-enable]", `${viewport.label} Enable voice`);
  await waitForC3(session);
  const baseline = await proofSnapshot(session);
  const authority = graphAuthority(baseline, `${viewport.label} baseline`);
  const monitorNode = nodeById(baseline, authority.monitorGainId);
  assert(monitorNode?.gain === 0,
    `${viewport.label}: monitor gain did not begin at zero: ${describe(monitorNode)}.`);
  const constraints = baseline.getUserMediaCalls[0]?.audio;
  assert(constraints && constraints.sampleRate === undefined
    && constraints.echoCancellation === false
    && constraints.noiseSuppression === false
    && constraints.autoGainControl === false,
  `${viewport.label}: raw microphone constraints were wrong: ${describe(constraints)}.`);
  const trackConstraint = baseline.trackConstraintApplications[0];
  assert(baseline.trackConstraintApplications.length === 1
    && trackConstraint.error === null
    && trackConstraint.constraints?.sampleRate === undefined
    && trackConstraint.constraints?.echoCancellation === false
    && trackConstraint.constraints?.noiseSuppression === false
    && trackConstraint.constraints?.autoGainControl === false,
  `${viewport.label}: raw preferences were not reapplied once to the selected track: ${describe(baseline.trackConstraintApplications)}.`);
  assert(baseline.productionContexts[0]?.options?.latencyHint === "interactive"
    && baseline.productionContexts[0]?.options?.sampleRate === undefined,
  `${viewport.label}: production context was not native-rate interactive: ${describe(baseline.productionContexts)}.`);

  await beginC3PublicationAudit(session);
  await clickHitTested(session, "[data-global-monitor-toggle]", `${viewport.label} Monitor On`);
  await waitForBrowser(session, "document.querySelector('.global-mic-control')?.getAttribute('data-monitor-effective') === 'true'", "effective monitoring On");
  await waitForWorkletAdvance(session, baseline.workletSamples.length);
  const enabled = await proofSnapshot(session);
  assertSameAuthority(baseline, enabled, authority, `${viewport.label} Monitor On`);
  assertPcmContinuity(baseline, enabled, `${viewport.label} Monitor On`);
  assertRamp(enabled, authority.monitorGainId, 0.65, `${viewport.label} Monitor On`);
  const enabledState = await uiState(session);
  assert(enabledState.detected === "C3",
    `${viewport.label}: C3 disappeared after Monitor On: ${describe(enabledState)}.`);
  await assertC3Publications(session, `${viewport.label} Monitor On`);

  await beginC3PublicationAudit(session);
  const activeSettings = await openAndInspectSettings(session, viewport);
  assertDiagnosticAuthority(activeSettings, enabled, `${viewport.label} active diagnostics`);
  await setRangeValue(session, "[data-monitor-level]", 73);
  await waitForBrowser(session, "document.querySelector('[data-monitor-level]')?.value === '73'", "73% monitor level");
  await waitForMonitoringSetting(session, { enabled: true, level: 0.73 });
  await closeSettings(session, viewport);
  await waitForWorkletAdvance(session, enabled.workletSamples.length);
  const leveled = await proofSnapshot(session);
  assertSameAuthority(enabled, leveled, authority, `${viewport.label} Monitor 73%`);
  assertPcmContinuity(enabled, leveled, `${viewport.label} Monitor 73%`);
  assertRamp(leveled, authority.monitorGainId, 0.73, `${viewport.label} Monitor 73%`);
  await assertC3Publications(session, `${viewport.label} Monitor 73%`);

  const beforeRoute = await proofSnapshot(session);
  await evaluate(session, "location.hash = '#/explore/sound/dyad'; true");
  await waitForBrowser(session, "location.hash === '#/explore/sound/dyad' && Boolean(document.querySelector('.sound-lab-page'))", "route without pitch consumer");
  await waitForWorkletAdvance(session, beforeRoute.workletSamples.length);
  const afterRoute = await proofSnapshot(session);
  assertSameAuthority(beforeRoute, afterRoute, authority, `${viewport.label} route change`);
  assertPcmContinuity(beforeRoute, afterRoute, `${viewport.label} route change`);
  assert((await uiState(session)).monitorEffective === "true", `${viewport.label}: monitoring stopped on navigation.`);
  await evaluate(session, "location.hash = '#/practice/pitch-match/glide'; true");
  await waitForC3(session);

  await beginC3PublicationAudit(session);
  await clickHitTested(session, "[data-global-monitor-toggle]", `${viewport.label} Monitor Off`);
  await waitForBrowser(session, "document.querySelector('.global-mic-control')?.getAttribute('data-monitor-effective') === 'false'", "effective monitoring Off");
  const offStart = await proofSnapshot(session);
  await waitForWorkletAdvance(session, offStart.workletSamples.length);
  const off = await proofSnapshot(session);
  assertSameAuthority(offStart, off, authority, `${viewport.label} Monitor Off`);
  assertPcmContinuity(offStart, off, `${viewport.label} Monitor Off`);
  assertRamp(off, authority.monitorGainId, 0, `${viewport.label} Monitor Off`);
  const offState = await uiState(session);
  assert(offState.detected === "C3",
    `${viewport.label}: C3 disappeared after Monitor Off: ${describe(offState)}.`);
  await assertC3Publications(session, `${viewport.label} Monitor Off`);

  await clickHitTested(session, "[data-global-monitor-toggle]", `${viewport.label} persist Monitor On`);
  await waitForMonitoringSetting(session, { enabled: true, level: 0.73 });
  const beforeReload = await proofSnapshot(session);
  assert(beforeReload.trackStops.length === 0 && beforeReload.trackEnabledWrites.length === 0,
    `${viewport.label}: capture ended before reload: ${describe(beforeReload)}.`);

  await session.send("Page.reload");
  await waitForBrowser(session,
    "Boolean(document.querySelector('[data-global-monitor-toggle]')) && Boolean(document.querySelector('[data-global-mic-enable]'))",
    `${viewport.label} persisted audio controls after reload`, 15_000);
  const restored = await uiState(session);
  const restoredProof = await proofSnapshot(session);
  assert(restored.monitorPressed === "true" && restored.monitorEffective === "false"
    && restored.micEnable && restoredProof.getUserMediaCalls.length === 0
    && restoredProof.productionContexts.length === 0,
  `${viewport.label}: saved monitoring opened audio or failed to restore: ${describe({ restored, restoredProof })}.`);
  const restoredLayout = await inspectMobileGlobalControls(session);
  assertGlobalLayout(restoredLayout, viewport, "restored");
  const restoredSettings = await openAndInspectSettings(session, viewport);
  const restoredLevel = await evaluate(session, "document.querySelector('[data-monitor-level]')?.value ?? null");
  assert(restoredLevel === "73", `${viewport.label}: restored monitor level was ${restoredLevel}, not 73.`);
  assert(/Not reported/u.test(restoredSettings.diagnosticsText),
    `${viewport.label}: diagnostics fabricated latency before input existed.`);
  await closeSettings(session, viewport);

  await clickHitTested(session, "[data-global-mic-enable]", `${viewport.label} explicit restored Enable`);
  await waitForC3(session);
  await waitForBrowser(session, "document.querySelector('.global-mic-control')?.getAttribute('data-monitor-effective') === 'true'", "restored monitoring becoming effective only after Enable");
  const restoredRunning = await proofSnapshot(session);
  const restoredAuthority = graphAuthority(restoredRunning, `${viewport.label} restored running`);
  assertRamp(restoredRunning, restoredAuthority.monitorGainId, 0.73, `${viewport.label} restored running`);
  const runningSettings = await openAndInspectSettings(session, viewport);
  assertDiagnosticAuthority(runningSettings, restoredRunning, `${viewport.label} restored diagnostics`);
  await closeSettings(session, viewport);

  await clickHitTested(session, "[data-global-mic-disable]", `${viewport.label} explicit Disable`);
  await waitForBrowser(session,
    "Boolean(document.querySelector('[data-global-mic-enable]')) && document.querySelector('.global-mic-control')?.getAttribute('data-monitor-effective') === 'false'",
    "explicit global Disable stopping effective monitoring");
  const stopped = await proofSnapshot(session);
  await delay(350);
  const settled = await proofSnapshot(session);
  assert(stopped.trackStops.length === 1 && settled.trackStops.length === 1
    && settled.trackEnabledWrites.length === 0,
  `${viewport.label}: explicit Disable did not alone stop one track: ${describe(settled)}.`);
  assert(settled.workletSamples.length === stopped.workletSamples.length,
    `${viewport.label}: PCM continued after explicit Disable.`);
  assert(settled.contextSuspends === 0 && settled.contextCloses === 0,
    `${viewport.label}: app suspended/closed the shared context: ${describe(settled)}.`);
  assert(settled.instrumentationErrors.length === 0,
    `${viewport.label}: browser instrumentation errors: ${describe(settled.instrumentationErrors)}.`);

  return {
    viewport: viewport.label,
    firstCaptureWindows: beforeReload.workletSamples.length,
    restoredCaptureWindows: settled.workletSamples.length,
    directGraph: authority,
    ramps: [0.65, 0.73, 0],
    routeResources: {
      contexts: afterRoute.productionContexts.length,
      sources: afterRoute.sourceTrackMatches,
      worklets: afterRoute.workletNodes,
    },
    explicitStops: settled.trackStops.length,
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
    temporaryDirectory = await mkdtemp(join(tmpdir(), "noteforge-monitoring-proof-"));
    const wavPath = join(temporaryDirectory, "stable-c3.wav");
    await writeFile(wavPath, generatedMonitoringC3Wav());
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
      if (type === "error") browserErrors.push(args?.map((item) => item.value ?? item.description).join(" ") || "console error");
    });
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: MONITORING_INSTRUMENTATION_SOURCE,
    });

    const results = [];
    for (const viewport of VIEWPORTS) results.push(await proveViewport(session, origin, viewport));
    assert(browserErrors.length === 0, `Browser errors occurred:\n${browserErrors.join("\n")}`);
    console.log("Global low-latency microphone monitoring browser proof passed.");
    console.log(JSON.stringify({ results }, null, 2));
  } catch (error) {
    const processContext = [...previewOutput, ...chromiumOutput].join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}${processContext ? `\n${processContext}` : ""}`);
  } finally {
    session?.close();
    await stopProcessGroup(chromium);
    await stopProcessGroup(preview);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
