import { browserProofSnapshot } from "./note-input-analysis.mjs";
import { assert, delay, evaluate, waitForBrowser } from "./devtools-runtime.mjs";

const TOGGLE_SELECTOR = ".range-loop-reference-action [data-note-playback-toggle]";

export async function startRangeLoopTargetPlayback(session) {
  const before = await browserProofSnapshot(session);
  const clicked = await evaluate(session, `(() => {
    const button = document.querySelector('${TOGGLE_SELECTOR}');
    window.__noteforgeRangeLoopPlaybackToggle = button || null;
    button?.click();
    return { found: Boolean(button) };
  })()`);
  assert(clicked.found, "Range Loop's sustained target toggle was unavailable.");
  await waitForBrowser(
    session,
    `(() => {
      const button = document.querySelector('${TOGGLE_SELECTOR}');
      return button?.getAttribute('aria-pressed') === 'true'
        && button?.getAttribute('data-playback-status') === 'on'
        && button.textContent?.includes('Stop C3');
    })()`,
    "Range Loop's target note entering its explicit On state",
    5_000,
  );
  const on = await browserProofSnapshot(session);
  const starts = on.oscillatorStarts.slice(before.oscillatorStarts.length);
  const startGainEvents = on.gainParamEvents.slice(before.gainParamEvents.length);
  const fullAmplitudeAttacks = startGainEvents.filter((event) => (
    event.method === "exponentialRampToValueAtTime"
    && Math.abs(event.value - 0.18) < 1e-9
  ));
  assert(starts.length === 4
    && new Set(starts.map(({ id }) => id)).size === 4
    && on.oscillatorStops.length === before.oscillatorStops.length,
  `The target toggle did not start exactly one four-part sustained lane: ${JSON.stringify({ starts, stops: on.oscillatorStops.slice(before.oscillatorStops.length) })}.`);
  assert(fullAmplitudeAttacks.length === 1,
    `The sustained lane did not expose one stable full-amplitude attack: ${JSON.stringify(startGainEvents)}.`);

  // This is deliberately longer than the deleted 0.5-second prompt plus its
  // release. No scheduler or envelope may reinterpret On as Stop or decay.
  await delay(1_500);
  const afterFormerCutoff = await browserProofSnapshot(session);
  const idle = await evaluate(session, `(() => {
    const button = document.querySelector('${TOGGLE_SELECTOR}');
    return {
      sameToggle: window.__noteforgeRangeLoopPlaybackToggle === button,
      pressed: button?.getAttribute('aria-pressed') || null,
      label: button?.textContent?.trim() || null,
      phase: document.querySelector('[data-range-loop-phase]')?.getAttribute('data-range-loop-phase') || null,
      heldSeconds: Number(document.querySelector('[data-note-input]')?.getAttribute('data-held-seconds')),
    };
  })()`);
  assert(idle.sameToggle === true
    && idle.pressed === "true"
    && idle.label?.includes("Stop C3")
    && idle.phase === "idle"
    && idle.heldSeconds === 0,
  `The sustained target toggle or idle workflow changed after the former cutoff: ${JSON.stringify(idle)}.`);
  assert(afterFormerCutoff.oscillatorStarts.length === on.oscillatorStarts.length
    && afterFormerCutoff.oscillatorStops.length === on.oscillatorStops.length
    && afterFormerCutoff.gainParamEvents.length === on.gainParamEvents.length,
  `Playback decayed, stopped, or created a quieter replacement after the former cutoff: ${JSON.stringify({
    starts: afterFormerCutoff.oscillatorStarts.slice(on.oscillatorStarts.length),
    stops: afterFormerCutoff.oscillatorStops.slice(on.oscillatorStops.length),
    gainEvents: afterFormerCutoff.gainParamEvents.slice(on.gainParamEvents.length),
  })}.`);
  return Object.freeze({ before, on, starts });
}

export async function assertRangeLoopTargetPlaybackUnchanged(session, playback, eventLabel) {
  const snapshot = await browserProofSnapshot(session);
  const state = await evaluate(session, `(() => {
    const button = document.querySelector('${TOGGLE_SELECTOR}');
    return {
      sameToggle: window.__noteforgeRangeLoopPlaybackToggle === button,
      pressed: button?.getAttribute('aria-pressed') || null,
      label: button?.textContent?.trim() || null,
    };
  })()`);
  assert(state.sameToggle === true
    && state.pressed === "true"
    && state.label?.includes("Stop C3")
    && snapshot.oscillatorStarts.length === playback.on.oscillatorStarts.length
    && snapshot.oscillatorStops.length === playback.on.oscillatorStops.length
    && snapshot.gainParamEvents.length === playback.on.gainParamEvents.length,
  `${eventLabel} stole or changed sustained playback authority: ${JSON.stringify({ state,
    starts: snapshot.oscillatorStarts.slice(playback.on.oscillatorStarts.length),
    stops: snapshot.oscillatorStops.slice(playback.on.oscillatorStops.length),
    gainEvents: snapshot.gainParamEvents.slice(playback.on.gainParamEvents.length),
  })}.`);
  return snapshot;
}

export async function stopRangeLoopTargetPlayback(session, playback, beforeStop) {
  const command = await evaluate(session, `(() => {
    const button = document.querySelector('${TOGGLE_SELECTOR}');
    const sameToggle = window.__noteforgeRangeLoopPlaybackToggle === button;
    const commandedAt = performance.now();
    button?.click();
    return { found: Boolean(button), sameToggle, commandedAt };
  })()`);
  assert(command.found && command.sameToggle,
    `The original visible target toggle was unavailable for Stop: ${JSON.stringify(command)}.`);
  await waitForBrowser(
    session,
    `(() => {
      const button = document.querySelector('${TOGGLE_SELECTOR}');
      return window.__noteforgeRangeLoopPlaybackToggle === button
        && button?.getAttribute('aria-pressed') === 'false'
        && button?.getAttribute('data-playback-status') === 'off'
        && button.textContent?.includes('Play C3');
    })()`,
    "the same target-note toggle honoring explicit Off",
    5_000,
  );
  await delay(150);
  const off = await browserProofSnapshot(session);
  const stops = off.oscillatorStops.slice(playback.before.oscillatorStops.length);
  const stoppedIds = new Set(stops.map(({ id }) => id));
  const startedIds = new Set(playback.starts.map(({ id }) => id));
  const stopGainEvents = off.gainParamEvents.slice(beforeStop.gainParamEvents.length);
  assert(off.oscillatorStarts.length === playback.on.oscillatorStarts.length
    && stops.length === playback.starts.length
    && [...startedIds].every((id) => stoppedIds.has(id))
    && stops.every(({ at }) => at >= command.commandedAt),
  `The same visible Off command was not the first stop for every sustained oscillator: ${JSON.stringify({ command, starts: playback.starts, stops })}.`);
  assert(stopGainEvents.length > 0
    && stopGainEvents.every(({ at }) => at >= command.commandedAt)
    && off.trackStopCalls.length === 0,
  `Playback gain changed before explicit Off or Off touched microphone capture: ${JSON.stringify({ command, stopGainEvents, trackStops: off.trackStopCalls })}.`);
  return Object.freeze({ off, stops });
}
