export const SAMPLE_RATE = 48_000;
export const WINDOW_SAMPLES = 4_096;
export const HOP_SAMPLES = 960;
const BITS_PER_SAMPLE = 16;
const NORMAL_RMS_DBFS = -24;

export const EXPECTED_COMMANDS = Object.freeze([
  Object.freeze({ midi: 48, direction: "up", dx: 0, dy: -1 }),
  Object.freeze({ midi: 50, direction: "right", dx: 1, dy: 0 }),
  Object.freeze({ midi: 52, direction: "down", dx: 0, dy: 1 }),
  Object.freeze({ midi: 54, direction: "left", dx: -1, dy: 0 }),
]);

const FIXTURE_SEGMENTS = Object.freeze([
  // Leave enough PCM runway for visible Enable + Start authority before tone.
  Object.freeze({ label: "opening-silence", kind: "silence", durationSeconds: 5 }),
  ...EXPECTED_COMMANDS.flatMap(({ midi, direction }, index) => [
    Object.freeze({ label: direction, kind: "tone", midi, durationSeconds: 1.15 }),
    Object.freeze({
      label: index === EXPECTED_COMMANDS.length - 1 ? "final-silence" : `silence-after-${direction}`,
      kind: "silence",
      durationSeconds: index === EXPECTED_COMMANDS.length - 1 ? 2.2 : 0.5,
    }),
  ]),
]);

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function generatedVoiceDrawWav() {
  const segmentSamples = FIXTURE_SEGMENTS.map(({ durationSeconds }) =>
    Math.round(durationSeconds * SAMPLE_RATE));
  const sampleCount = segmentSamples.reduce((total, count) => total + count, 0);
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataByteLength = sampleCount * bytesPerSample;
  const wav = Buffer.alloc(44 + dataByteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataByteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(BITS_PER_SAMPLE, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataByteLength, 40);

  const targetRms = 10 ** (NORMAL_RMS_DBFS / 20);
  const weights = [1, 0.35, 0.173333];
  const phases = [0.1, 0.7, 1.3];
  const unitRms = Math.sqrt(weights.reduce((sum, weight) => sum + weight ** 2, 0) / 2);
  const amplitudeScale = targetRms / unitRms;
  const edgeSamples = Math.round(SAMPLE_RATE * 0.01);
  let outputSample = 0;
  for (let segmentIndex = 0; segmentIndex < FIXTURE_SEGMENTS.length; segmentIndex += 1) {
    const segment = FIXTURE_SEGMENTS[segmentIndex];
    const count = segmentSamples[segmentIndex];
    const frequencyHz = segment.kind === "tone" ? midiToFrequency(segment.midi) : null;
    for (let localSample = 0; localSample < count; localSample += 1) {
      let value = 0;
      if (frequencyHz !== null) {
        const timeSeconds = localSample / SAMPLE_RATE;
        const edgeGain = Math.max(0, Math.min(
          1,
          localSample / edgeSamples,
          (count - 1 - localSample) / edgeSamples,
        ));
        value = weights.reduce((sum, weight, harmonicIndex) => sum + weight * Math.sin(
          2 * Math.PI * frequencyHz * (harmonicIndex + 1) * timeSeconds + phases[harmonicIndex],
        ), 0) * amplitudeScale * edgeGain;
      }
      wav.writeInt16LE(
        Math.round(Math.max(-1, Math.min(1, value)) * 0x7fff),
        44 + outputSample * bytesPerSample,
      );
      outputSample += 1;
    }
  }
  return wav;
}

function fixtureRanges() {
  let startSample = 0;
  return FIXTURE_SEGMENTS.map((segment) => {
    const endSample = startSample + Math.round(segment.durationSeconds * SAMPLE_RATE);
    const range = { ...segment, startSample, endSample };
    startSample = endSample;
    return range;
  });
}

export function fixtureRelation(frame) {
  const ranges = fixtureRanges();
  const overlaps = ranges.filter((range) => (
    frame.startSample < range.endSample && frame.endSample > range.startSample
  )).map(({ label, startSample, endSample }) => ({ label, startSample, endSample }));
  const boundaries = ranges.flatMap((range) => [range.startSample, range.endSample]);
  const nearestBoundary = boundaries.reduce((nearest, boundary) => (
    Math.abs(boundary - frame.endSample) < Math.abs(nearest - frame.endSample) ? boundary : nearest
  ), boundaries[0]);
  return { overlaps, nearestBoundary, endMinusBoundary: frame.endSample - nearestBoundary };
}

export function canonicalDrawFrames(snapshots) {
  const canonical = [];
  for (const snapshot of snapshots) {
    if (!Number.isSafeInteger(snapshot.endSample) || snapshot.endSample < 0) continue;
    const previous = canonical.at(-1);
    const sameFrame = previous
      && previous.captureEpoch === snapshot.captureEpoch
      && previous.continuityEpoch === snapshot.continuityEpoch
      && previous.graphGeneration === snapshot.graphGeneration
      && previous.endSample === snapshot.endSample;
    if (sameFrame) canonical[canonical.length - 1] = snapshot;
    else canonical.push(snapshot);
  }
  return canonical;
}

export function contiguousRuns(values, predicate) {
  const runs = [];
  let current = [];
  for (const value of values) {
    if (predicate(value)) current.push(value);
    else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

export function frameKey(frame) {
  return `${frame.captureEpoch}:${frame.endSample}`;
}

export function coordinatesFromPath(path) {
  const coordinates = path.match(/-?(?:\d+\.?\d*|\.\d+)/gu)?.map(Number) ?? [];
  if (coordinates.length !== 4) {
    throw new Error(`A voice stroke was not coalesced into one M/L segment: ${path}`);
  }
  return {
    from: { x: coordinates[0], y: coordinates[1] },
    to: { x: coordinates[2], y: coordinates[3] },
  };
}

export function pointDistance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function pitchFramesFrom(batches) {
  return batches.flatMap((batch) => batch.events ?? [])
    .filter((event) => event.kind === "pitch-frame")
    .map((event) => event.pitch?.frame)
    .filter(Boolean);
}

function compactDetectorEvidence(detector) {
  return {
    observationKind: detector.observationKind,
    voiced: detector.voiced,
    nearestMidi: detector.nearestMidi,
    midiFloat: detector.midiFloat,
    centsFromNearest: detector.centsFromNearest,
    frequencyHz: detector.frequencyHz,
    confidence: detector.confidence,
    periodicity: detector.periodicity,
    rms: detector.rms,
    yinValue: detector.yinValue,
    periodSamples: detector.periodSamples,
    reason: detector.reason,
    startSample: detector.startSample,
    endSample: detector.endSample,
    captureEpoch: detector.captureEpoch,
    continuityEpoch: detector.continuityEpoch,
    graphGeneration: detector.graphGeneration,
    fixture: fixtureRelation(detector),
  };
}

export function drawProgressDiagnostic(snapshot, batches) {
  const frames = canonicalDrawFrames(snapshot?.drawSnapshots ?? []);
  const detectorFrames = pitchFramesFrom(batches);
  const detectorByKey = new Map(detectorFrames.map((frame) => [frameKey(frame), frame]));
  const detectorIndexByKey = new Map(detectorFrames.map((frame, index) => [frameKey(frame), index]));
  const workletByKey = new Map(
    (snapshot?.workletSampleEvents ?? []).map((frame) => [frameKey(frame), frame]),
  );
  const transitions = frames.flatMap((frame, index) => {
    const previous = frames[index - 1];
    if (previous
      && previous.activeMidi === frame.activeMidi
      && previous.activeDirection === frame.activeDirection) return [];
    const detector = detectorByKey.get(frameKey(frame));
    return [{
      activeMidi: frame.activeMidi,
      activeDirection: frame.activeDirection,
      segmentCount: frame.segmentCount,
      evidence: detector ? {
        ...compactDetectorEvidence(detector),
        workletWindow: workletByKey.get(frameKey(frame)) ?? null,
      } : null,
    }];
  });
  const expectedMidis = new Set(EXPECTED_COMMANDS.map(({ midi }) => midi));
  const unexpected = transitions.filter(({ activeMidi }) => (
    activeMidi !== null && !expectedMidis.has(activeMidi)
  )).map((transition) => {
    const index = transition.evidence === null
      ? undefined
      : detectorIndexByKey.get(frameKey(transition.evidence));
    return {
      ...transition,
      adjacentDetectorFrames: index === undefined
        ? []
        : detectorFrames.slice(Math.max(0, index - 3), index + 4).map(compactDetectorEvidence),
    };
  });
  return {
    workletSampleMessages: snapshot?.workletSampleMessages,
    publishedFrames: frames.length,
    transitions,
    unexpected,
    last: frames.at(-1) ?? null,
  };
}
