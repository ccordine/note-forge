import { SAMPLE_RATE } from "./note-input-fixture.mjs";

const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
const TARGET_RMS = 10 ** (-22 / 20);
export const VOCAL_FLIGHT_CENTER_MIDI = 48;
export const VOCAL_FLIGHT_TUTORIAL_IDS = Object.freeze([
  "neutral-find-center", "neutral-leave-return", "neutral-stabilize",
  "pitch-climb-descend", "pitch-hold-altitude", "pitch-alternating-altitude",
  "brightness-roll", "brightness-hold-bank", "brightness-alternating-banks",
  "combined-diagonal-rings", "combined-altitude-curve", "combined-helix",
  "precision-narrow-tunnel", "precision-moving-line", "precision-turbulence",
  "automaticity-navigation", "automaticity-collect", "automaticity-timed-run",
]);

const ENVELOPES = Object.freeze({
  dark: Object.freeze([1, 0.12, 0.04, 0.015]),
  neutral: Object.freeze([1, 0.55, 0.3, 0.18, 0.1, 0.06, 0.03]),
  bright: Object.freeze([1, 0.85, 0.7, 0.55, 0.43, 0.33, 0.25, 0.18]),
});

/**
 * Long plateaus let the proof operate the actual six-step calibration without
 * synchronizing production to a synthetic frame injection. Segment labels are
 * also an independent sample-domain oracle for the resulting diagnostics.
 */
export const VOCAL_FLIGHT_SEGMENTS = Object.freeze([
  { label: "opening-silence", kind: "silence", seconds: 0.8 },
  { label: "cal-neutral", cents: 0, envelope: "neutral", seconds: 2.4 },
  { label: "cal-upper", cents: 300, envelope: "neutral", seconds: 2.4 },
  { label: "cal-lower", cents: -250, envelope: "neutral", seconds: 2.4 },
  { label: "cal-dark", cents: 0, envelope: "dark", seconds: 2.4 },
  { label: "cal-bright", cents: 0, envelope: "bright", seconds: 2.4 },
  { label: "recovery-away-1", cents: 180, envelope: "neutral", seconds: 0.6 },
  { label: "recovery-center-1", cents: 0, envelope: "neutral", seconds: 0.6 },
  { label: "recovery-away-2", cents: -170, envelope: "neutral", seconds: 0.6 },
  { label: "recovery-center-2", cents: 0, envelope: "neutral", seconds: 0.6 },
  { label: "recovery-away-3", cents: 190, envelope: "bright", seconds: 0.6 },
  { label: "recovery-center-3", cents: 0, envelope: "neutral", seconds: 1.2 },
  { label: "game-neutral-open", cents: 0, envelope: "neutral", seconds: 1.2 },
  { label: "game-pitch-up", cents: 220, envelope: "neutral", seconds: 1.6 },
  { label: "game-neutral-after-up", cents: 0, envelope: "neutral", seconds: 0.8 },
  { label: "game-pitch-down", cents: -180, envelope: "neutral", seconds: 1.6 },
  { label: "game-neutral-before-dark", cents: 0, envelope: "neutral", seconds: 0.8 },
  { label: "game-dark", cents: 0, envelope: "dark", seconds: 1.6 },
  { label: "game-neutral-before-bright", cents: 0, envelope: "neutral", seconds: 0.8 },
  { label: "game-bright", cents: 0, envelope: "bright", seconds: 1.6 },
  { label: "game-neutral-before-combined", cents: 0, envelope: "neutral", seconds: 0.8 },
  { label: "game-high-bright", cents: 180, envelope: "bright", seconds: 1.6 },
  { label: "game-silence", kind: "silence", seconds: 1 },
  { label: "game-resume-high-bright", cents: 180, envelope: "bright", seconds: 1.6 },
  { label: "game-neutral-tail", cents: 0, envelope: "neutral", seconds: 2.5 },
  { label: "final-silence", kind: "silence", seconds: 3 },
]);

function midiToFrequency(midiFloat) {
  return 440 * 2 ** ((midiFloat - 69) / 12);
}

export function vocalFlightSegmentRanges() {
  let startSample = 0;
  return VOCAL_FLIGHT_SEGMENTS.map((segment) => {
    const sampleCount = Math.round(segment.seconds * SAMPLE_RATE);
    const range = Object.freeze({
      ...segment,
      startSample,
      endSample: startSample + sampleCount,
    });
    startSample += sampleCount;
    return range;
  });
}

export function segmentForWindow(frame) {
  return vocalFlightSegmentRanges().find((segment) => (
    frame.startSample >= segment.startSample && frame.endSample <= segment.endSample
  )) ?? null;
}

export function generatedVocalFlightWav() {
  const ranges = vocalFlightSegmentRanges();
  const totalSamples = ranges.at(-1)?.endSample ?? 0;
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataBytes = totalSamples * CHANNELS * bytesPerSample;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(CHANNELS, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * CHANNELS * bytesPerSample, 28);
  wav.writeUInt16LE(CHANNELS * bytesPerSample, 32);
  wav.writeUInt16LE(BITS_PER_SAMPLE, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);

  const phases = [0.1, 0.7, 1.3, 2.1, 2.7, 3.2, 3.8, 4.4];
  const edgeSamples = Math.round(SAMPLE_RATE * 0.012);
  let phase = 0;
  let outputSample = 0;
  for (const range of ranges) {
    const weights = range.kind === "silence" ? [] : ENVELOPES[range.envelope];
    const frequencyHz = range.kind === "silence"
      ? 0
      : midiToFrequency(VOCAL_FLIGHT_CENTER_MIDI + range.cents / 100);
    const unitRms = weights.length === 0
      ? 1
      : Math.sqrt(weights.reduce((sum, weight) => sum + weight ** 2, 0) / 2);
    const amplitude = TARGET_RMS / unitRms;
    const sampleCount = range.endSample - range.startSample;
    for (let localSample = 0; localSample < sampleCount; localSample += 1) {
      let value = 0;
      if (weights.length > 0) {
        phase += 2 * Math.PI * frequencyHz / SAMPLE_RATE;
        const edge = Math.max(0, Math.min(
          1,
          localSample / edgeSamples,
          (sampleCount - 1 - localSample) / edgeSamples,
        ));
        const seconds = localSample / SAMPLE_RATE;
        const amplitudeMotion = 0.97 + 0.02 * Math.sin(2 * Math.PI * 1.7 * seconds)
          + 0.01 * Math.sin(2 * Math.PI * 3.1 * seconds + 0.4);
        const signal = weights.reduce((sum, weight, index) => sum
          + weight * Math.sin(phase * (index + 1) + phases[index]), 0);
        value = signal * amplitude * amplitudeMotion * edge;
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
