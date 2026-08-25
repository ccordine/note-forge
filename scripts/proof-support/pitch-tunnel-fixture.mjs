import { SAMPLE_RATE } from "./note-input-fixture.mjs";

const BITS_PER_SAMPLE = 16;
const TARGET_RMS = 10 ** (-24 / 20);

export const PITCH_TUNNEL_ANCHOR_MIDI = 48;
export const PITCH_TUNNEL_LANE_HALF_WIDTH_CENTS = 10;
export const PITCH_TUNNEL_CHECKPOINT_OFFSETS = Object.freeze([
  0, 25, 50, 75, 100, 75, 50, 25, 0,
]);

const MICROPHONE_SEGMENTS = Object.freeze([
  { kind: "silence", durationSeconds: 1.2 },
  { offsetCents: 0, durationSeconds: 2.2 },
  { offsetCents: 25, durationSeconds: 1.8 },
  { offsetCents: 50, durationSeconds: 0.45 },
  { kind: "silence", durationSeconds: 0.45 },
  { offsetCents: 50, durationSeconds: 1.8 },
  { offsetCents: 75, durationSeconds: 0.45 },
  { offsetCents: 175, durationSeconds: 0.4 },
  { offsetCents: 75, durationSeconds: 1.8 },
  { offsetCents: 100, durationSeconds: 1.8 },
  { offsetCents: 75, durationSeconds: 1.8 },
  { offsetCents: 50, durationSeconds: 1.8 },
  { offsetCents: 25, durationSeconds: 1.8 },
  { offsetCents: 0, durationSeconds: 1.8 },
  { offsetCents: 100, durationSeconds: 0.8 },
  { kind: "silence", durationSeconds: 1.2 },
]);

function midiToFrequency(midiFloat) {
  return 440 * 2 ** ((midiFloat - 69) / 12);
}

export function generatedPitchTunnelWav() {
  const segmentSampleCounts = MICROPHONE_SEGMENTS.map(({ durationSeconds }) =>
    Math.round(durationSeconds * SAMPLE_RATE));
  const sampleCount = segmentSampleCounts.reduce((total, count) => total + count, 0);
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

  const weights = [1, 0.42, 0.19, 0.08];
  const phases = [0.1, 0.7, 1.3, 2.1];
  const unitRms = Math.sqrt(weights.reduce((sum, weight) => sum + weight ** 2, 0) / 2);
  const scale = TARGET_RMS / unitRms;
  const edgeSamples = Math.round(SAMPLE_RATE * 0.012);
  let outputSample = 0;
  let noiseState = 0x50_49_54_43;
  let phase = 0;
  for (let segmentIndex = 0; segmentIndex < MICROPHONE_SEGMENTS.length; segmentIndex += 1) {
    const segment = MICROPHONE_SEGMENTS[segmentIndex];
    const count = segmentSampleCounts[segmentIndex];
    const frequencyHz = segment.kind === "silence"
      ? null
      : midiToFrequency(PITCH_TUNNEL_ANCHOR_MIDI + segment.offsetCents / 100);
    for (let localSample = 0; localSample < count; localSample += 1) {
      let value = 0;
      if (frequencyHz !== null) {
        phase += 2 * Math.PI * frequencyHz / SAMPLE_RATE;
        noiseState = (Math.imul(noiseState, 1_664_525) + 1_013_904_223) >>> 0;
        const breath = (noiseState / 0x1_0000_0000 * 2 - 1)
          * TARGET_RMS * 10 ** (-42 / 20);
        const time = localSample / SAMPLE_RATE;
        const motion = 0.94 + 0.04 * Math.sin(2 * Math.PI * 1.7 * time)
          + 0.02 * Math.sin(2 * Math.PI * 3.1 * time + 0.4);
        const edge = Math.max(0, Math.min(
          1,
          localSample / edgeSamples,
          (count - 1 - localSample) / edgeSamples,
        ));
        const harmonics = weights.reduce((sum, weight, index) =>
          sum + weight * Math.sin(phase * (index + 1) + phases[index]), 0);
        value = (harmonics * scale * motion + breath) * edge;
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
