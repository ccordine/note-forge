export const SAMPLE_RATE = 48_000;
export const CAPTURE_WINDOW_SAMPLES = 4_096;
export const CAPTURE_HOP_SAMPLES = 960;
export const CAPTURE_HOP_BUDGET_MS = CAPTURE_HOP_SAMPLES / SAMPLE_RATE * 1_000;
export const SUPPORTED_MIN_FREQUENCY_HZ = 45;
export const SUPPORTED_MAX_FREQUENCY_HZ = 1_200;
export const LOWEST_SUPPORTED_MIDI = 30;
export const HIGHEST_SUPPORTED_MIDI = 86;
export const NOISE_RMS_DBFS = -24;
export const OLD_GATE_RMS_DBFS = -42;
export const OLD_GATE_RMS_AMPLITUDE = 10 ** (OLD_GATE_RMS_DBFS / 20);
export const IMMEDIATE_CHANGE_MIDIS = [48, 52, 55];

const CHANNEL_COUNT = 1;
const BITS_PER_SAMPLE = 16;
const NORMAL_RMS_DBFS = -24;
const QUIET_RMS_DBFS = -60;
const FULL_RANGE_SEGMENT_SECONDS = 0.3;
const QUIET_LOW_SEGMENT_SECONDS = 0.4;
const OPENING_SEGMENT_SECONDS = 1.25;
const IMMEDIATE_CHANGE_SEGMENT_SECONDS = 0.7;

export const IMMEDIATE_CHANGE_SEGMENT_SAMPLES = Math.round(
  SAMPLE_RATE * IMMEDIATE_CHANGE_SEGMENT_SECONDS,
);

const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

export function noteLabel(midi) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export const EXPECTED_NOTES = Array.from(
  { length: HIGHEST_SUPPORTED_MIDI - LOWEST_SUPPORTED_MIDI + 1 },
  (_unused, index) => {
    const midi = LOWEST_SUPPORTED_MIDI + index;
    return { midi, label: noteLabel(midi) };
  },
);
export const QUIET_LOW_NOTES = EXPECTED_NOTES.filter(({ midi }) => midi <= 47);
export const EXPECTED_MIDIS = new Set(EXPECTED_NOTES.map(({ midi }) => midi));
export const EXPECTED_LABELS = new Set(EXPECTED_NOTES.map(({ label }) => label));
export const QUIET_LOW_MIDIS = new Set(QUIET_LOW_NOTES.map(({ midi }) => midi));
export const QUIET_LOW_LABELS = new Set(QUIET_LOW_NOTES.map(({ label }) => label));

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

const STANDARD_MICROPHONE_SEGMENTS = Object.freeze([
    // A stable opening note gives the real Pitch Mirror prompt time to run.
    { midi: LOWEST_SUPPORTED_MIDI, durationSeconds: OPENING_SEGMENT_SECONDS, rmsDbfs: NORMAL_RMS_DBFS },
    // Each change is correlated by exact production endSample with the first
    // detector frame and the DOM mutation that rendered it. Long stable tones
    // make this an admission-delay proof without asking one 85 ms window to
    // identify physically incompatible one-hop-duration notes.
    ...IMMEDIATE_CHANGE_MIDIS.map((midi) => ({
      midi,
      durationSeconds: IMMEDIATE_CHANGE_SEGMENT_SECONDS,
      rmsDbfs: NORMAL_RMS_DBFS,
    })),
    // Every semitone fully enclosed by the production 45-1200 Hz profile.
    ...EXPECTED_NOTES.map(({ midi }) => ({
      midi,
      durationSeconds: FULL_RANGE_SEGMENT_SECONDS,
      rmsDbfs: NORMAL_RMS_DBFS,
      dominantSecond: midi <= 47,
    })),
    // The configured detector boundaries are not tempered semitones, so they
    // get literal frequency segments in addition to the enclosed MIDI sweep.
    { frequencyHz: SUPPORTED_MIN_FREQUENCY_HZ, durationSeconds: 0.45, rmsDbfs: NORMAL_RMS_DBFS },
    { frequencyHz: SUPPORTED_MAX_FREQUENCY_HZ, durationSeconds: 0.45, rmsDbfs: NORMAL_RMS_DBFS },
    // A known voiced bridge is long enough to finish the user-owned trace,
    // visit a view with no microphone consumer, and mount Hum Lab before the
    // quiet sweep begins. This keeps the no-consumer continuity proof from
    // stealing UI-render coverage from the quiet low-register proof.
    { midi: 60, durationSeconds: 8.2, rmsDbfs: NORMAL_RMS_DBFS },
    // Repeat the complete low register quietly to reproduce the historical
    // meter-moving/no-note failure through Chromium's actual capture path.
    ...QUIET_LOW_NOTES.map(({ midi }) => ({
      midi,
      durationSeconds: QUIET_LOW_SEGMENT_SECONDS,
      rmsDbfs: QUIET_RMS_DBFS,
      dominantSecond: true,
    })),
    { midi: 60, durationSeconds: 1.2, rmsDbfs: QUIET_RMS_DBFS },
    // Browser-path negative controls: the live meter must distinguish real
    // silence and loud non-periodic evidence without manufacturing a note.
    { kind: "silence", durationSeconds: 1.2, rmsDbfs: Number.NEGATIVE_INFINITY },
    // Leave ample non-periodic tail for the deterministic AudioContext
    // suspend/resume exercise so Chromium never loops back to the first note.
    { kind: "noise", durationSeconds: 10, rmsDbfs: NOISE_RMS_DBFS, noiseSeed: 0x4e_4f_49_53 },
]);

export const SUSTAINED_NOTE_SECONDS = 8.5;
export const SUSTAINED_FIXTURE_SECONDS = 38;
export const SUSTAINED_NOTE_MIDIS = Object.freeze([
  LOWEST_SUPPORTED_MIDI,
  48,
  60,
  HIGHEST_SUPPORTED_MIDI,
]);

const SUSTAINED_MICROPHONE_SEGMENTS = Object.freeze([
  { kind: "silence", durationSeconds: 0.5, rmsDbfs: Number.NEGATIVE_INFINITY },
  { midi: LOWEST_SUPPORTED_MIDI, durationSeconds: SUSTAINED_NOTE_SECONDS, rmsDbfs: -42, dominantSecond: true, voiceLike: true },
  { kind: "silence", durationSeconds: 0.5, rmsDbfs: Number.NEGATIVE_INFINITY },
  { midi: 48, durationSeconds: SUSTAINED_NOTE_SECONDS, rmsDbfs: QUIET_RMS_DBFS, dominantSecond: true, voiceLike: true },
  { kind: "silence", durationSeconds: 0.5, rmsDbfs: Number.NEGATIVE_INFINITY },
  { midi: 60, durationSeconds: SUSTAINED_NOTE_SECONDS, rmsDbfs: NORMAL_RMS_DBFS, voiceLike: true },
  { kind: "silence", durationSeconds: 0.5, rmsDbfs: Number.NEGATIVE_INFINITY },
  { midi: HIGHEST_SUPPORTED_MIDI, durationSeconds: SUSTAINED_NOTE_SECONDS, rmsDbfs: NORMAL_RMS_DBFS, voiceLike: true },
  { kind: "silence", durationSeconds: 2, rmsDbfs: Number.NEGATIVE_INFINITY },
]);

function encodeMicrophoneSegments(segments) {
  const segmentSampleCounts = segments.map(({ durationSeconds }) =>
    Math.round(SAMPLE_RATE * durationSeconds));
  const sampleCount = segmentSampleCounts.reduce((sum, count) => sum + count, 0);
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataByteLength = sampleCount * CHANNEL_COUNT * bytesPerSample;
  const wav = Buffer.alloc(44 + dataByteLength);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataByteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(CHANNEL_COUNT, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * CHANNEL_COUNT * bytesPerSample, 28);
  wav.writeUInt16LE(CHANNEL_COUNT * bytesPerSample, 32);
  wav.writeUInt16LE(BITS_PER_SAMPLE, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataByteLength, 40);

  const edgeSamples = Math.round(SAMPLE_RATE * 0.008);
  const harmonicPhases = [0.1, 0.7, 1.3, 2.1];
  let outputSample = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const segmentSamples = segmentSampleCounts[segmentIndex];
    const frequency = segment.kind ? null : segment.frequencyHz ?? midiToFrequency(segment.midi);
    const targetRms = segment.kind === "silence" ? 0 : 10 ** (segment.rmsDbfs / 20);
    const harmonicWeights = segment.dominantSecond
      ? [segment.midi % 2 === 0 ? 0.08 : 0.2, 1, 0.24, 0.12]
      : [1, 0.35, 0.173333];
    const unitRms = Math.sqrt(
      harmonicWeights.reduce((sum, weight) => sum + weight ** 2, 0) / 2,
    );
    const amplitudeScale = targetRms / unitRms;
    let noiseState = segment.noiseSeed ?? 0;
    let voiceNoiseState = (0x53_55_53_54 ^ Math.imul(segmentIndex + 1, 0x9e_37_79_b1)) >>> 0;
    let voicePhase = 0;
    for (let segmentSample = 0; segmentSample < segmentSamples; segmentSample += 1) {
      const time = segmentSample / SAMPLE_RATE;
      const edgeGain = Math.min(
        1,
        segmentSample / edgeSamples,
        (segmentSamples - 1 - segmentSample) / edgeSamples,
      );
      let value = 0;
      if (segment.kind === "noise") {
        noiseState = (Math.imul(noiseState, 1_664_525) + 1_013_904_223) >>> 0;
        const uniformNoise = noiseState / 0x1_0000_0000 * 2 - 1;
        value = uniformNoise * Math.sqrt(3) * targetRms * edgeGain;
      } else if (segment.kind !== "silence") {
        const vibratoCents = segment.voiceLike
          ? 14 * Math.sin(2 * Math.PI * 5.1 * time)
            + 3 * Math.sin(2 * Math.PI * 0.37 * time)
          : 0;
        voicePhase += 2 * Math.PI * frequency * 2 ** (vibratoCents / 1_200) / SAMPLE_RATE;
        const harmonicSignal = harmonicWeights.reduce((sum, weight, harmonicIndex) =>
          sum + weight * Math.sin(
            voicePhase * (harmonicIndex + 1) + harmonicPhases[harmonicIndex],
          ), 0);
        const amplitudeMotion = segment.voiceLike
          ? 0.72 + 0.2 * Math.sin(2 * Math.PI * 1.7 * time)
            + 0.08 * Math.sin(2 * Math.PI * 3.1 * time + 0.4)
          : 1;
        if (segment.voiceLike) {
          voiceNoiseState = (Math.imul(voiceNoiseState, 1_664_525) + 1_013_904_223) >>> 0;
        }
        const breathNoise = segment.voiceLike
          ? (voiceNoiseState / 0x1_0000_0000 * 2 - 1)
            * Math.sqrt(3) * targetRms * 10 ** (-34 / 20)
          : 0;
        value = (harmonicSignal * amplitudeScale * amplitudeMotion + breathNoise) * edgeGain;
      }
      value = Math.max(-1, Math.min(1, value));
      wav.writeInt16LE(Math.round(value * 0x7fff), 44 + outputSample * bytesPerSample);
      outputSample += 1;
    }
  }

  return wav;
}

export function generatedMicrophoneWav() {
  return encodeMicrophoneSegments(STANDARD_MICROPHONE_SEGMENTS);
}

export function generatedSustainedMicrophoneWav() {
  return encodeMicrophoneSegments(SUSTAINED_MICROPHONE_SEGMENTS);
}
