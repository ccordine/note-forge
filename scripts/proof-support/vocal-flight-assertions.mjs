import { assert } from "./devtools-runtime.mjs";
import {
  segmentForWindow,
  VOCAL_FLIGHT_CENTER_MIDI,
} from "./vocal-flight-fixture.mjs";

export function frameKey(frame) {
  return `${frame.captureEpoch}:${frame.endSample}`;
}

export function pitchFramesFrom(batches) {
  return batches.flatMap((batch) => batch.events ?? [])
    .filter((event) => event.kind === "pitch-frame" && event.pitch?.frame)
    .map((event) => ({ ...event.pitch.frame, processingMs: event.pitch.processingMs }))
    .sort((left, right) => left.captureEpoch - right.captureEpoch
      || left.endSample - right.endSample);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function framesForSegment(frames, label) {
  return frames.filter((frame) => segmentForWindow(frame)?.label === label);
}

function voicedSummary(frames, label) {
  const voiced = framesForSegment(frames, label).filter((frame) => (
    frame.observationKind === "voiced" && frame.voiced === true
      && Number.isFinite(frame.midiFloat) && Number.isFinite(frame.brightness)
  ));
  assert(voiced.length >= 20, `${label} produced only ${voiced.length} complete voiced windows.`);
  return {
    count: voiced.length,
    midi: median(voiced.map((frame) => frame.midiFloat)),
    brightness: median(voiced.map((frame) => frame.brightness)),
    confidence: median(voiced.map((frame) => frame.confidence)),
    brightnessConfidence: median(voiced.map((frame) => frame.brightnessConfidence)),
  };
}

export function assertDerivedSignals(detectorFrames) {
  const neutral = voicedSummary(detectorFrames, "cal-neutral");
  const upper = voicedSummary(detectorFrames, "cal-upper");
  const lower = voicedSummary(detectorFrames, "cal-lower");
  const dark = voicedSummary(detectorFrames, "cal-dark");
  const bright = voicedSummary(detectorFrames, "cal-bright");
  for (const signal of [neutral, upper, lower, dark, bright]) {
    assert(signal.confidence >= 0.55 && signal.brightnessConfidence >= 0.55,
      `Fixture signal did not produce credible shared pitch/brightness: ${JSON.stringify(signal)}`);
  }
  assert(Math.abs(neutral.midi - VOCAL_FLIGHT_CENTER_MIDI) <= 0.04,
    `Neutral F0 was not C3: ${JSON.stringify(neutral)}`);
  assert(upper.midi - neutral.midi >= 2.85 && upper.midi - neutral.midi <= 3.15,
    `Upper calibration did not retain its +300-cent pitch extent: ${JSON.stringify({ neutral, upper })}`);
  assert(neutral.midi - lower.midi >= 2.35 && neutral.midi - lower.midi <= 2.65,
    `Lower calibration did not retain its -250-cent pitch extent: ${JSON.stringify({ neutral, lower })}`);
  assert(Math.abs(dark.midi - bright.midi) <= 0.04,
    `Dark and bright evidence changed F0 by more than four cents: ${JSON.stringify({ dark, bright })}`);
  assert(bright.brightness - dark.brightness >= 0.12,
    `The shared derived observation did not separate same-F0 dark and bright spectra: ${JSON.stringify({ dark, bright })}`);
  const processing = detectorFrames.map((frame) => frame.processingMs).filter(Number.isFinite);
  const maximumProcessingMs = Math.max(...processing);
  assert(processing.length === detectorFrames.length && maximumProcessingMs < 20,
    `Production detector + brightness work exceeded the 20 ms hop: max=${maximumProcessingMs}ms.`);
  return { neutral, upper, lower, dark, bright, maximumProcessingMs };
}

function segmentPublications(publications, label) {
  return publications.filter((publication) => segmentForWindow(publication)?.label === label);
}

function extrema(publications, field) {
  const values = publications.map((publication) => publication[field]).filter(Number.isFinite);
  return {
    minimum: values.length === 0 ? null : Math.min(...values),
    maximum: values.length === 0 ? null : Math.max(...values),
  };
}

export function assertControlBehavior(publications, detectorFrames) {
  const detectorByKey = new Map(detectorFrames.map((frame) => [frameKey(frame), frame]));
  const observationKind = (publication) => detectorByKey.get(frameKey(publication))?.observationKind;
  const flying = publications.filter((publication) => publication.phase === "flying");
  assert(flying.length > 80, `Only ${flying.length} bounded flight publications were observed.`);
  const signals = Object.fromEntries([
    "game-pitch-up", "game-pitch-down", "game-dark", "game-bright",
    "game-high-bright", "game-silence", "game-resume-high-bright",
  ].map((label) => [label, segmentPublications(flying, label)]));
  for (const [label, frames] of Object.entries(signals)) {
    assert(frames.length > 3, `${label} had only ${frames.length} flight publications.`);
  }

  const pitchUpPitch = extrema(signals["game-pitch-up"], "pitchAxis");
  const pitchUpBrightness = extrema(signals["game-pitch-up"], "brightnessAxis");
  const pitchDownPitch = extrema(signals["game-pitch-down"], "pitchAxis");
  const darkBrightness = extrema(signals["game-dark"], "brightnessAxis");
  const darkPitch = extrema(signals["game-dark"], "pitchAxis");
  const brightBrightness = extrema(signals["game-bright"], "brightnessAxis");
  const brightPitch = extrema(signals["game-bright"], "pitchAxis");
  const combinedPitch = extrema(signals["game-high-bright"], "pitchAxis");
  const combinedBrightness = extrema(signals["game-high-bright"], "brightnessAxis");
  assert(pitchUpPitch.maximum > 0.25 && Math.max(
    Math.abs(pitchUpBrightness.minimum), Math.abs(pitchUpBrightness.maximum),
  ) < 0.18, `Pitch-up input leaked into roll: ${JSON.stringify({ pitchUpPitch, pitchUpBrightness })}`);
  assert(pitchDownPitch.minimum < -0.25,
    `Pitch-down input did not produce negative elevator: ${JSON.stringify(pitchDownPitch)}`);
  assert(darkBrightness.minimum < -0.25 && Math.max(
    Math.abs(darkPitch.minimum), Math.abs(darkPitch.maximum),
  ) < 0.18, `Same-F0 dark input did not isolate negative roll: ${JSON.stringify({ darkBrightness, darkPitch })}`);
  assert(brightBrightness.maximum > 0.25 && Math.max(
    Math.abs(brightPitch.minimum), Math.abs(brightPitch.maximum),
  ) < 0.18, `Same-F0 bright input did not isolate positive roll: ${JSON.stringify({ brightBrightness, brightPitch })}`);
  assert(combinedPitch.maximum > 0.2 && combinedBrightness.maximum > 0.25,
    `Combined input did not drive both axes: ${JSON.stringify({ combinedPitch, combinedBrightness })}`);
  assert(signals["game-silence"].every((frame) => (
    observationKind(frame) === "unvoiced" && frame.active === false
      && frame.pitchAxis === 0 && frame.brightnessAxis === 0
  )), "Silence produced a non-neutral control force.");

  const silenceFrames = framesForSegment(detectorFrames, "game-silence");
  const resumeFrames = detectorFrames.filter((frame) => (
    frame.endSample > silenceFrames.at(-1)?.endSample && frame.observationKind === "voiced"
  ));
  const resumedDetector = resumeFrames[0];
  const resumed = flying.find((frame) => frameKey(frame) === frameKey(resumedDetector));
  assert(resumed && resumed.active === false && resumed.pitchAxis === 0
    && resumed.brightnessAxis === 0,
  `The first voiced observation after silence did not seed zero control: ${JSON.stringify(resumed)}`);
  const previousPublication = flying.filter((frame) => (
    frame.endSample < resumed.endSample && observationKind(frame) === "unvoiced"
  )).at(-1);
  const observedAdvance = resumed.observedFrames - previousPublication.observedFrames;
  const simulatedAdvance = resumed.simulatedFrames - previousPublication.simulatedFrames;
  assert(observedAdvance > 0 && simulatedAdvance === observedAdvance - 1,
    `The resumed authority frame advanced simulation time: ${JSON.stringify({
      previousPublication, resumed, observedAdvance, simulatedAdvance,
    })}`);
  const afterResume = signals["game-resume-high-bright"].filter((frame) => (
    frame.endSample > resumed.endSample
  ));
  assert(afterResume.some((frame) => frame.active && frame.pitchAxis > 0.2
    && frame.brightnessAxis > 0.25),
  "Vocal control did not resume immediately after its one zero-time authority frame.");

  const pitchFlight = extrema(signals["game-pitch-up"], "flightPitch");
  const darkFlight = extrema(signals["game-dark"], "flightRoll");
  const brightFlight = extrema(signals["game-bright"], "flightRoll");
  assert(pitchFlight.maximum > 0.03, `Positive pitch control did not climb: ${JSON.stringify(pitchFlight)}`);
  assert(darkFlight.minimum < -0.03 && brightFlight.maximum > 0.03,
    `Aircraft bank did not separate dark/bright control: ${JSON.stringify({ darkFlight, brightFlight })}`);
  return {
    flyingPublications: flying.length,
    pitchUpMaximum: pitchUpPitch.maximum,
    pitchDownMinimum: pitchDownPitch.minimum,
    darkMinimum: darkBrightness.minimum,
    brightMaximum: brightBrightness.maximum,
  };
}

export function assertExactAuthority(native, feature, detectorFrames) {
  const worklet = native.workletSampleEvents;
  const workletByKey = new Map(worklet.map((frame) => [frameKey(frame), frame]));
  const detectorByKey = new Map(detectorFrames.map((frame) => [frameKey(frame), frame]));
  const final = feature.current;
  assert(final && final.observedFrames === worklet.length,
    `Vocal Flight consumed ${final?.observedFrames} of ${worklet.length} worklet observations.`);
  assert(worklet.length > 1_200 && detectorFrames.length >= worklet.length,
    `Insufficient exact continuous evidence: worklet=${worklet.length}, detector=${detectorFrames.length}.`);
  const failures = [];
  for (const publication of feature.publications) {
    if (!Number.isSafeInteger(publication.endSample)) continue;
    const key = frameKey(publication);
    const nativeFrame = workletByKey.get(key);
    const detector = detectorByKey.get(key);
    if (!nativeFrame || !detector
      || publication.startSample !== nativeFrame.startSample
      || publication.processedSampleCount !== publication.endSample
      || publication.sampleRate !== detector.sampleRate
      || publication.continuityEpoch !== detector.continuityEpoch
      || publication.graphGeneration !== detector.graphGeneration) {
      failures.push(key);
    }
  }
  assert(failures.length === 0,
    `Bounded React publications lost exact authority: ${failures.slice(0, 12).join(", ")}`);
  const uniquePublicationFrames = new Set(feature.publications
    .filter((frame) => Number.isSafeInteger(frame.endSample))
    .map(frameKey)).size;
  assert(uniquePublicationFrames < worklet.length * 0.75,
    `React remained coupled to sensor cadence: publications=${uniquePublicationFrames}, windows=${worklet.length}.`);
  return { workletWindows: worklet.length, uniquePublicationFrames };
}
