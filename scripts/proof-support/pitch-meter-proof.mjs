import { canonicalFrameKey } from "./note-input-analysis.mjs";
import {
  EXPECTED_NOTES,
  HIGHEST_SUPPORTED_MIDI,
  IMMEDIATE_CHANGE_MIDIS,
  IMMEDIATE_CHANGE_SEGMENT_SAMPLES,
  LOWEST_SUPPORTED_MIDI,
  noteLabel,
  OLD_GATE_RMS_AMPLITUDE,
} from "./note-input-fixture.mjs";

function strictlyIncreasing(values, minimumGap = 0) {
  return values.slice(1).every((value, index) =>
    value - values[index] > minimumGap);
}

function accurateNormalSweepFrame(frame, midi) {
  return frame?.voiced === true
    && frame.nearestMidi === midi
    && frame.rms > OLD_GATE_RMS_AMPLITUDE
    && Math.abs(frame.centsFromNearest) <= 8;
}

/** Correlate the built meter/ribbon geometry with exact detector-frame keys. */
export function analyzePitchMeterProof({
  settledProof,
  diagnosticFrames,
  diagnosticByFrame,
  immediateChangeProof,
}) {
  const lastImmediateFrame = immediateChangeProof.at(-1)?.detectorFrame ?? null;
  const sweepStartIndex = lastImmediateFrame === null
    ? -1
    : diagnosticFrames.findIndex((frame) =>
        frame.endSample > lastImmediateFrame.endSample
          && accurateNormalSweepFrame(frame, LOWEST_SUPPORTED_MIDI));
  const sweepMaximumStartIndex = sweepStartIndex < 0
    ? -1
    : diagnosticFrames.findIndex((frame, index) =>
        index > sweepStartIndex
          && accurateNormalSweepFrame(frame, HIGHEST_SUPPORTED_MIDI));
  let sweepEndIndex = diagnosticFrames.length;
  if (sweepMaximumStartIndex >= 0) {
    const followingFrameIndex = diagnosticFrames.findIndex((frame, index) =>
      index > sweepMaximumStartIndex
        && (!frame.voiced || frame.nearestMidi !== HIGHEST_SUPPORTED_MIDI));
    if (followingFrameIndex >= 0) sweepEndIndex = followingFrameIndex;
  }
  const sweepFrameKeys = new Set(
    sweepStartIndex >= 0 && sweepMaximumStartIndex >= 0
      ? diagnosticFrames.slice(sweepStartIndex, sweepEndIndex)
        .map(canonicalFrameKey)
      : [],
  );
  const meterSweepProof = EXPECTED_NOTES.map(({ midi, label }) => {
    const samples = settledProof.domFrameMutations.filter((observation) => {
      if (!sweepFrameKeys.has(canonicalFrameKey(observation))) return false;
      const frame = diagnosticByFrame.get(canonicalFrameKey(observation))?.pitch?.frame;
      return observation.hash.startsWith("#/practice/pitch-match")
        && accurateNormalSweepFrame(frame, midi)
        && observation.note === label
        && observation.meter?.scale === "full-depth-target-lens";
    });
    const representative = samples.at(-1) ?? null;
    return {
      midi,
      label,
      sampleCount: samples.length,
      endSample: representative?.endSample ?? null,
      liveMidi: representative?.meter?.liveMidi ?? null,
      declaredPositionPercent:
        representative?.meter?.declaredPositionPercent ?? null,
      markerInlinePositionPercent:
        representative?.meter?.markerInlinePositionPercent ?? null,
      markerCenterPercent:
        representative?.meter?.markerCenterPercent ?? null,
    };
  });

  const ribbonMidis = [LOWEST_SUPPORTED_MIDI, ...IMMEDIATE_CHANGE_MIDIS];
  const ribbonProof = ribbonMidis.map((midi, index) => {
    const startSample = index === 0
      ? 0
      : immediateChangeProof[index - 1]?.detectorFrame?.endSample ?? 0;
    const endSample = immediateChangeProof[index]?.detectorFrame?.endSample
      ?? startSample + IMMEDIATE_CHANGE_SEGMENT_SAMPLES;
    const samples = settledProof.ribbonMutations.filter((observation) => {
      const frame = diagnosticByFrame.get(canonicalFrameKey(observation))?.pitch?.frame;
      return observation.hash.startsWith("#/practice/pitch-match")
        && observation.endSample >= startSample
        && observation.endSample < endSample
        && accurateNormalSweepFrame(frame, midi)
        && Number.isFinite(observation.liveMidi)
        && Math.abs(observation.liveMidi - frame.midiFloat) <= 0.05
        && observation.startSample === frame.startSample
        && observation.continuityEpoch === frame.continuityEpoch
        && observation.graphGeneration === frame.graphGeneration;
    });
    const representative = samples.at(-1) ?? null;
    const exactMeterObservation = representative === null
      ? null
      : settledProof.domFrameMutations.find((observation) =>
          canonicalFrameKey(observation) === canonicalFrameKey(representative));
    // The tuner and trace are deliberately separate bounded React
    // publications over one authoritative stream. Prefer identical sample
    // identity, but compare against another stable frame of the same generated
    // note when one coalescer did not publish the other's exact frame.
    const meterObservation = exactMeterObservation
      ?? settledProof.domFrameMutations.filter((observation) => {
        const frame = diagnosticByFrame.get(canonicalFrameKey(observation))?.pitch?.frame;
        return observation.hash.startsWith("#/practice/pitch-match")
          && observation.endSample >= startSample
          && observation.endSample < endSample
          && accurateNormalSweepFrame(frame, midi)
          && Number.isFinite(observation.meter?.declaredPositionPercent);
      }).at(-1)
      ?? null;
    const expectedY = Number.isFinite(
      meterObservation?.meter?.declaredPositionPercent,
    )
      ? (100 - meterObservation.meter.declaredPositionPercent) * 3
      : null;
    return {
      midi,
      label: noteLabel(midi),
      sampleCount: samples.length,
      endSample: representative?.endSample ?? null,
      meterEndSample: meterObservation?.endSample ?? null,
      liveMidi: representative?.liveMidi ?? null,
      latestX: representative?.latestX ?? null,
      latestY: representative?.latestY ?? null,
      expectedY,
    };
  });

  return {
    sweepStartIndex,
    sweepMaximumStartIndex,
    sweepEndIndex,
    meterSweepProof,
    declaredMeterPositions: meterSweepProof
      .map((item) => item.declaredPositionPercent),
    inlineMeterPositions: meterSweepProof
      .map((item) => item.markerInlinePositionPercent),
    computedMeterPositions: meterSweepProof
      .map((item) => item.markerCenterPercent),
    ribbonProof,
    ribbonYPositions: ribbonProof.map((item) => item.latestY),
  };
}

export function pitchMeterProofFailures(proof) {
  const failures = [];
  if (!(proof.sweepStartIndex >= 0
    && proof.sweepMaximumStartIndex > proof.sweepStartIndex)) {
    failures.push(`could not isolate full sweep ${JSON.stringify({
      sweepStartIndex: proof.sweepStartIndex,
      sweepMaximumStartIndex: proof.sweepMaximumStartIndex,
      sweepEndIndex: proof.sweepEndIndex,
    })}`);
  }
  const incompleteMeters = proof.meterSweepProof.filter((item) =>
    item.sampleCount < 2
      || !Number.isFinite(item.endSample)
      || !Number.isFinite(item.liveMidi)
      || !Number.isFinite(item.declaredPositionPercent)
      || !Number.isFinite(item.markerInlinePositionPercent)
      || !Number.isFinite(item.markerCenterPercent));
  if (incompleteMeters.length > 0) {
    failures.push(`missing computed meter coordinates ${JSON.stringify(incompleteMeters)}`);
  }
  if (!strictlyIncreasing(proof.declaredMeterPositions, 0.05)
    || !strictlyIncreasing(proof.inlineMeterPositions, 0.05)
    || !strictlyIncreasing(proof.computedMeterPositions, 0.05)) {
    failures.push(`meter did not move strictly left-to-right ${JSON.stringify(proof.meterSweepProof)}`);
  }
  if (!(proof.declaredMeterPositions[0] > 0
    && proof.declaredMeterPositions.at(-1) < 100
    && new Set(proof.declaredMeterPositions).size === EXPECTED_NOTES.length
    && proof.meterSweepProof.every((item) => Math.abs(
      item.markerCenterPercent - item.declaredPositionPercent,
    ) <= 2))) {
    failures.push(`meter aliased an edge or missed declared geometry ${JSON.stringify(proof.meterSweepProof)}`);
  }
  if (!(proof.ribbonProof.every((item) => item.sampleCount >= 2
    && Number.isFinite(item.endSample)
    && Number.isFinite(item.liveMidi)
    && Number.isFinite(item.latestX)
    && Number.isFinite(item.latestY)
    && Number.isFinite(item.expectedY)
    && Math.abs(item.latestY - item.expectedY) <= 2)
    && proof.ribbonYPositions.slice(1).every((position, index) =>
      proof.ribbonYPositions[index] - position > 0.05)
    && new Set(proof.ribbonYPositions).size === proof.ribbonProof.length)) {
    failures.push(`pitch ribbon collapsed distinct notes ${JSON.stringify(proof.ribbonProof)}`);
  }
  return failures;
}
