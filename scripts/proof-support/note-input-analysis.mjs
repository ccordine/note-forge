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

function nearestMidiForFrequency(frequencyHz) {
  return Number.isFinite(frequencyHz) && frequencyHz > 0
    ? Math.round(69 + 12 * Math.log2(frequencyHz / 440))
    : null;
}

/**
 * Correlate the pre-tracker candidate, public authoritative frame, and exact
 * rendered mutation for each deliberately abrupt fixture transition.
 */
export function analyzeImmediatePitchTransitions({
  diagnosticFrames,
  presentationClaims,
  renderedFrames,
  expectedMidis,
  labelForMidi,
  confirmationFrames,
}) {
  const diagnosticIndexByKey = new Map(
    diagnosticFrames.map((frame, index) => [canonicalFrameKey(frame), index]),
  );
  let renderedSearchIndex = 0;
  let diagnosticSearchIndex = 0;
  let previousAcceptedEndSample = null;
  return expectedMidis.map((midi) => {
    const label = labelForMidi(midi);
    const acceptedOffset = diagnosticFrames.slice(diagnosticSearchIndex)
      .findIndex((frame) => frame.voiced && frame.nearestMidi === midi);
    const acceptedFrameIndex = acceptedOffset < 0
      ? -1
      : diagnosticSearchIndex + acceptedOffset;
    const detectorFrame = acceptedFrameIndex < 0
      ? null
      : diagnosticFrames[acceptedFrameIndex];
    const confirmationStartIndex = acceptedFrameIndex < 0
      ? -1
      : acceptedFrameIndex - confirmationFrames + 1;
    const transitionFrames = confirmationStartIndex < diagnosticSearchIndex
      ? []
      : diagnosticFrames.slice(confirmationStartIndex, acceptedFrameIndex + 1);
    const pendingFrameKeys = new Set(
      transitionFrames.slice(0, -1).map(canonicalFrameKey),
    );
    const candidateOffset = presentationClaims.slice(renderedSearchIndex)
      .findIndex((observation) =>
        observation.trackingDecision === "pending-transition"
          && pendingFrameKeys.has(canonicalFrameKey(observation)));
    const candidateRenderedIndex = candidateOffset < 0
      ? -1
      : renderedSearchIndex + candidateOffset;
    const candidateRendered = candidateRenderedIndex < 0
      ? null
      : presentationClaims[candidateRenderedIndex];
    const candidateFrameIndex = candidateRendered === null
      ? -1
      : diagnosticIndexByKey.get(canonicalFrameKey(candidateRendered)) ?? -1;
    const candidateFrame = candidateFrameIndex < 0
      ? null
      : diagnosticFrames[candidateFrameIndex];
    const rendered = detectorFrame === null
      ? null
      : renderedFrames.find((observation) =>
          canonicalFrameKey(observation) === canonicalFrameKey(detectorFrame)
            && observation.note === label) ?? null;
    const transitionGapSamples = candidateFrame === null
      || previousAcceptedEndSample === null
      ? null
      : candidateFrame.endSample - previousAcceptedEndSample;
    if (candidateRenderedIndex >= 0) renderedSearchIndex = candidateRenderedIndex + 1;
    if (acceptedFrameIndex >= 0) diagnosticSearchIndex = acceptedFrameIndex + 1;
    if (detectorFrame !== null) previousAcceptedEndSample = detectorFrame.endSample;
    return {
      midi,
      label,
      candidateFrame,
      candidateRendered,
      detectorFrame,
      transitionFrames,
      transitionGapSamples,
      rendered,
    };
  });
}

export function immediatePitchTransitionFailures(
  proof,
  { confirmationFrames, hopSamples, maximumSegmentSamples },
) {
  const failures = [];
  for (const [index, transition] of proof.entries()) {
    const {
      midi,
      label,
      candidateFrame,
      candidateRendered,
      detectorFrame,
      transitionFrames,
      transitionGapSamples,
      rendered,
    } = transition;
    const commonAccepted = detectorFrame?.voiced === true
      && detectorFrame.nearestMidi === midi
      && rendered?.endSample === detectorFrame.endSample
      && rendered?.captureEpoch === detectorFrame.captureEpoch
      && rendered?.continuityEpoch === detectorFrame.continuityEpoch
      && rendered?.graphGeneration === detectorFrame.graphGeneration
      && rendered?.observationKind === "voiced"
      && rendered?.inputState === "running";
    const candidateTelemetryMatches = candidateFrame !== null
      && candidateFrame.observationKind === "uncertain"
      && candidateFrame.voiced === false
      && candidateFrame.nearestMidi === null
      && candidateFrame.reason === "temporally-ambiguous"
      && candidateFrame.pitchTrackingDecision === "pending-transition"
      && candidateFrame.pitchCandidate?.voiced === true
      && candidateFrame.pitchCandidate.reason === "detected"
      && candidateRendered?.endSample === candidateFrame.endSample
      && candidateRendered?.captureEpoch === candidateFrame.captureEpoch
      && candidateRendered?.continuityEpoch === candidateFrame.continuityEpoch
      && candidateRendered?.graphGeneration === candidateFrame.graphGeneration
      && candidateRendered?.candidateMidi === candidateFrame.pitchCandidate?.nearestMidi
      && nearestMidiForFrequency(candidateRendered?.candidateFrequencyHz)
        === candidateFrame.pitchCandidate?.nearestMidi
      && Number.isFinite(candidateRendered?.candidateRawFrequencyHz)
      && candidateRendered?.inputState === "running";
    const segmentTimingMatches = index === 0
      || (transitionGapSamples !== null
        && transitionGapSamples > 0
        && transitionGapSamples <= maximumSegmentSamples);
    const consecutiveFrames = transitionFrames.length === confirmationFrames
      && transitionFrames.every((frame, frameIndex) => {
        const previous = transitionFrames[frameIndex - 1];
        return frame.pitchCandidate?.voiced === true
          && frame.pitchCandidate.reason === "detected"
          && (!previous || (
            frame.captureEpoch === previous.captureEpoch
            && frame.continuityEpoch === previous.continuityEpoch
            && frame.graphGeneration === previous.graphGeneration
            && !frame.discontinuity
            && frame.endSample - previous.endSample === hopSamples
          ));
      });
    const pendingFrames = transitionFrames.slice(0, -1);
    const remoteTransitionMatches = consecutiveFrames
      && pendingFrames.length === confirmationFrames - 1
      && pendingFrames.every((frame) =>
        frame.observationKind === "uncertain"
          && frame.voiced === false
          && frame.nearestMidi === null
          && frame.reason === "temporally-ambiguous"
          && frame.pitchTrackingDecision === "pending-transition")
      && candidateRendered?.observationKind === "uncertain"
      && candidateRendered.trackingDecision === "pending-transition"
      && candidateRendered.displayedMidi === null
      && candidateFrame.captureEpoch === transitionFrames[0]?.captureEpoch
      && candidateFrame.continuityEpoch === transitionFrames[0]?.continuityEpoch
      && candidateFrame.graphGeneration === transitionFrames[0]?.graphGeneration
      && candidateFrame.endSample >= transitionFrames[0]?.endSample
      && candidateFrame.endSample < detectorFrame?.endSample
      && detectorFrame === transitionFrames.at(-1)
      && detectorFrame?.pitchTrackingDecision === "accepted-confirmed-transition"
      && rendered?.trackingDecision === "accepted-confirmed-transition";
    if (!commonAccepted
      || !candidateTelemetryMatches
      || !segmentTimingMatches
      || !remoteTransitionMatches) {
      failures.push(`${label}: ${JSON.stringify(transition)}`);
    }
  }
  return failures;
}

export function formatImmediatePitchTransitions(proof) {
  return proof.map(({ label, candidateFrame, detectorFrame, transitionFrames }) =>
    `${label} candidate@${candidateFrame?.endSample} uncertain ×${Math.max(0, transitionFrames.length - 1)} -> confirmed@${detectorFrame?.endSample}`)
    .join(", ");
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
