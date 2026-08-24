import { EXPECTED_LABELS } from "./note-input-fixture.mjs";
import { assert, delay, evaluate } from "./devtools-runtime.mjs";

export async function renderedNoteSample(session) {
  return evaluate(session, `(() => {
    const scope = document.querySelector('.input-scope')
      || document.querySelector('[data-note-input]');
    const pitch = document.querySelector('[data-detected-note]');
    const meter = scope?.querySelector('[role="meter"]');
    const diagnosis = scope?.querySelector('.scope-diagnosis b');
    const frequency = [...(pitch?.querySelectorAll('span') || [])]
      .find((element) => element.textContent?.includes('Hz'));
    return {
      note: pitch?.getAttribute('data-detected-note') || null,
      frequency: frequency?.textContent?.trim() || null,
      scopeState: scope?.className || null,
      inputState: scope?.getAttribute('data-input-state') || null,
      meterDbfs: meter?.getAttribute('aria-valuenow') == null
        ? null
        : Number(meter.getAttribute('aria-valuenow')),
      diagnosis: diagnosis?.textContent?.trim() || null,
      frameCount: Number(scope?.getAttribute('data-frame-count') || 0),
      frameTime: Number(scope?.getAttribute('data-frame-time') || 0),
      endSample: Number(scope?.getAttribute('data-end-sample') || 0),
      captureEpoch: Number(scope?.getAttribute('data-capture-epoch') || 0),
      continuityEpoch: Number(scope?.getAttribute('data-continuity-epoch') || 0),
      graphGeneration: Number(scope?.getAttribute('data-graph-generation') || 0),
      heldSamples: scope?.getAttribute('data-held-samples') == null
        || scope?.getAttribute('data-held-samples') === ''
        ? null
        : Number(scope.getAttribute('data-held-samples')),
      heldSeconds: scope?.getAttribute('data-held-seconds') == null
        || scope?.getAttribute('data-held-seconds') === ''
        ? null
        : Number(scope.getAttribute('data-held-seconds')),
      hash: location.hash,
      at: performance.now(),
    };
  })()`);
}

export async function collectRenderedNotes(session, durationMilliseconds) {
  const samples = [];
  const deadline = Date.now() + durationMilliseconds;
  while (Date.now() < deadline) {
    samples.push(await renderedNoteSample(session));
    await delay(80);
  }
  return samples;
}

export function pitchFramesFrom(requests) {
  return requests.flatMap((batch) => batch.events ?? [])
    .filter((event) => event.kind === "pitch-frame");
}

export async function browserProofSnapshot(session) {
  return evaluate(session, `(() => {
    const control = window.__noteforgeNoteInputProof;
    return typeof control?.snapshot === 'function' ? control.snapshot() : null;
  })()`);
}

export async function waitForDiagnosticCount(
  diagnosticBatches,
  expectedCount,
  timeoutMilliseconds = 6_000,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const count = pitchFramesFrom(diagnosticBatches).length;
    if (count === expectedCount) return count;
    if (count > expectedCount) {
      throw new Error(`Production emitted ${count} detector frames for ${expectedCount} worklet sample messages.`);
    }
    await delay(100);
  }
  return pitchFramesFrom(diagnosticBatches).length;
}

export function uniqueExpectedRenderedNotes(samples) {
  return [...new Set(samples
    .map((sample) => sample.note)
    .filter((note) => EXPECTED_LABELS.has(note)))];
}

export function expectedRenderedTransitions(samples) {
  const transitions = [];
  for (const note of samples.map((sample) => sample.note)) {
    if (!EXPECTED_LABELS.has(note) || transitions.at(-1) === note) continue;
    transitions.push(note);
  }
  return transitions;
}

export function includesContiguousSequence(values, expected) {
  return values.some((_value, start) =>
    expected.every((expectedValue, offset) => values[start + offset] === expectedValue));
}

export function includesOrderedSequence(values, expected) {
  let expectedIndex = 0;
  for (const value of values) {
    if (value === expected[expectedIndex]) expectedIndex += 1;
    if (expectedIndex === expected.length) return true;
  }
  return expected.length === 0;
}

export function missingValues(expected, actual) {
  return [...expected].filter((value) => !actual.has(value));
}

export function amplitudeToDbfs(amplitude) {
  return 20 * Math.log10(Math.max(amplitude, 1e-12));
}

export function longestMatchingRun(samples, predicate) {
  let longest = 0;
  let current = 0;
  for (const sample of samples) {
    if (predicate(sample)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

export function maximumElapsedGap(frames) {
  let maximum = 0;
  for (let index = 1; index < frames.length; index += 1) {
    maximum = Math.max(maximum, frames[index].elapsedMs - frames[index - 1].elapsedMs);
  }
  return maximum;
}

export function canonicalFrameKey(frame) {
  return `${frame.captureEpoch}:${frame.endSample}`;
}

export function orderedPitchEvents(requests) {
  return [...pitchFramesFrom(requests)].sort((left, right) => {
    const leftFrame = left.pitch?.frame;
    const rightFrame = right.pitch?.frame;
    return (leftFrame?.captureEpoch ?? -1) - (rightFrame?.captureEpoch ?? -1)
      || (leftFrame?.endSample ?? -1) - (rightFrame?.endSample ?? -1);
  });
}

export function lastWorkletSample(snapshot) {
  return snapshot.workletSampleEvents.at(-1) ?? null;
}

export function renderedFrameContinuity(samples, label) {
  const withFrames = samples.filter((sample) =>
    Number.isFinite(sample.frameCount) && sample.frameCount > 0
      && Number.isFinite(sample.frameTime) && sample.frameTime > 0);
  assert(withFrames.length > 1, `${label} exposed no advancing production frame metadata.`);
  let maximumAdvanceGapMilliseconds = 0;
  let lastAdvanceAt = withFrames[0].at;
  for (let index = 1; index < withFrames.length; index += 1) {
    const previous = withFrames[index - 1];
    const current = withFrames[index];
    assert(current.frameCount >= previous.frameCount,
      `${label} frame count moved backward from ${previous.frameCount} to ${current.frameCount}.`);
    assert(current.frameTime >= previous.frameTime,
      `${label} detector timestamp moved backward from ${previous.frameTime} to ${current.frameTime}.`);
    if (current.frameCount > previous.frameCount) {
      maximumAdvanceGapMilliseconds = Math.max(maximumAdvanceGapMilliseconds, current.at - lastAdvanceAt);
      lastAdvanceAt = current.at;
    }
  }
  return {
    firstCount: withFrames[0].frameCount,
    lastCount: withFrames.at(-1).frameCount,
    firstTime: withFrames[0].frameTime,
    lastTime: withFrames.at(-1).frameTime,
    maximumAdvanceGapMilliseconds,
  };
}
