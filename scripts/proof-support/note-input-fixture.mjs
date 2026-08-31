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
export const PITCH_TRANSITION_CONFIRMATION_FRAMES = 4;

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
    // Exercise ordinary unvoiced evidence explicitly while the user-owned
    // Pitch Mirror trace is active. Detector quality must not be relied on to
    // manufacture incidental unvoiced frames between otherwise adjacent tones.
    { kind: "silence", durationSeconds: 0.5, rmsDbfs: Number.NEGATIVE_INFINITY },
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
/** Initial four-note survey used for detector/rendered sustain assertions. */
export const SUSTAINED_SURVEY_SECONDS = 42;
/** Survey plus six separated C3 attempts used by cumulative Range Loop. */
export const SUSTAINED_FIXTURE_SECONDS = 88;
export const SUSTAINED_NOTE_MIDIS = Object.freeze([
  LOWEST_SUPPORTED_MIDI,
  48,
  60,
  HIGHEST_SUPPORTED_MIDI,
]);

export const NOISY_RANGE_C3_MIDI = 48;
export const NOISY_RANGE_D3_MIDI = 50;
export const NOISY_RANGE_D3_SECONDS = 34;

const NOISY_RANGE_STAGE_DEFINITIONS = Object.freeze([
  {
    id: "noise-10-seed-20",
    label: "steady C3 + broadband noise at +10 dB SNR, red-team seed 20",
    durationSeconds: 2.2,
    noiseSnrDb: 10,
    noiseSeed: Math.imul(20, 0x9e_37_79_b1) >>> 0,
    vibratoDepthCents: 0,
  },
  { id: "clean", label: "clean C3", durationSeconds: 2.2 },
  { id: "noise-30", label: "C3 + broadband noise at +30 dB SNR", durationSeconds: 1, noiseSnrDb: 30 },
  { id: "noise-20", label: "C3 + broadband noise at +20 dB SNR", durationSeconds: 1, noiseSnrDb: 20 },
  { id: "noise-10", label: "C3 + broadband noise at +10 dB SNR", durationSeconds: 1.4, noiseSnrDb: 10 },
  { id: "noise-6", label: "C3 + broadband noise at +6 dB SNR", durationSeconds: 1.2, noiseSnrDb: 6 },
  { id: "noise-3", label: "C3 + broadband noise at +3 dB SNR", durationSeconds: 1.2, noiseSnrDb: 3 },
  {
    id: "transients",
    label: "C3 + short deterministic impulses",
    durationSeconds: 1.2,
    noiseSnrDb: 24,
    impulseAmplitude: 0.8,
  },
  {
    id: "dominant-second",
    label: "C3 + dominant second harmonic",
    durationSeconds: 1.2,
    noiseSnrDb: 24,
    fundamentalGain: 0.08,
    secondGain: 1,
    thirdGain: 0.24,
  },
  {
    id: "dominant-third",
    label: "C3 + dominant third harmonic",
    durationSeconds: 1.2,
    noiseSnrDb: 24,
    fundamentalGain: 0.15,
    secondGain: 0.2,
    thirdGain: 1,
  },
  {
    id: "amplitude-drops",
    label: "C3 + brief amplitude drops",
    durationSeconds: 1.2,
    noiseSnrDb: 16,
    amplitudeDrops: true,
  },
  {
    id: "changing-noise",
    label: "C3 + changing broadband noise amplitude",
    durationSeconds: 2,
    changingNoise: true,
  },
  { id: "clean-recovery", label: "clean C3 recovery and collective-credit tail", durationSeconds: 18 },
]);

let noisyRangeStageStartSample = 0;
export const NOISY_RANGE_C3_STAGES = Object.freeze(
  NOISY_RANGE_STAGE_DEFINITIONS.map((stage) => {
    const sampleCount = Math.round(stage.durationSeconds * SAMPLE_RATE);
    const scheduled = Object.freeze({
      ...stage,
      startSample: noisyRangeStageStartSample,
      endSample: noisyRangeStageStartSample + sampleCount,
    });
    noisyRangeStageStartSample += sampleCount;
    return scheduled;
  }),
);
export const NOISY_RANGE_D3_START_SAMPLE = noisyRangeStageStartSample;
export const NOISY_RANGE_FIXTURE_SAMPLES = NOISY_RANGE_D3_START_SAMPLE
  + Math.round(NOISY_RANGE_D3_SECONDS * SAMPLE_RATE);
export const NOISY_RANGE_FIXTURE_SECONDS = NOISY_RANGE_FIXTURE_SAMPLES / SAMPLE_RATE;

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
  // Range Loop begins during this tail. Six separate attempts prove that its
  // 30-second goal is collective: each breath pauses, but never erases, credit.
  ...Array.from({ length: 6 }, (_, index) => [
    { midi: 48, durationSeconds: 8, rmsDbfs: QUIET_RMS_DBFS, dominantSecond: true, voiceLike: true },
    ...(index < 5
      ? [{ kind: "silence", durationSeconds: 0.4, rmsDbfs: Number.NEGATIVE_INFINITY }]
      : []),
  ]).flat(),
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

/** Stable, device-path fixture for direct-monitor graph and continuity proofs. */
export function generatedMonitoringC3Wav() {
  return encodeMicrophoneSegments([{
    midi: 48,
    durationSeconds: 60,
    rmsDbfs: NORMAL_RMS_DBFS,
  }]);
}

function deterministicNoiseSample(state) {
  const nextState = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
  return {
    state: nextState,
    sample: nextState / 0x1_0000_0000 * 2 - 1,
  };
}

/**
 * A phase-continuous C3 whose interference changes without ever changing the
 * authored fundamental. The only pitch transition in the fixture is the final
 * persistent D3. Chromium consumes this WAV as its fake microphone device.
 */
export function generatedNoisyRangeLoopMicrophoneWav() {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataByteLength = NOISY_RANGE_FIXTURE_SAMPLES * CHANNEL_COUNT * bytesPerSample;
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

  const c3Frequency = midiToFrequency(NOISY_RANGE_C3_MIDI);
  const d3Frequency = midiToFrequency(NOISY_RANGE_D3_MIDI);
  const voiceRms = 10 ** (-24 / 20);
  const finalFadeSamples = Math.round(0.008 * SAMPLE_RATE);
  let noiseState = NOISY_RANGE_C3_STAGES[0]?.noiseSeed ?? 0x43_33_4e_4f;
  let phase = 0;
  let stageIndex = 0;
  for (let sampleIndex = 0; sampleIndex < NOISY_RANGE_FIXTURE_SAMPLES; sampleIndex += 1) {
    while (
      stageIndex < NOISY_RANGE_C3_STAGES.length - 1
      && sampleIndex >= NOISY_RANGE_C3_STAGES[stageIndex].endSample
    ) stageIndex += 1;

    const c3Active = sampleIndex < NOISY_RANGE_D3_START_SAMPLE;
    const stage = c3Active ? NOISY_RANGE_C3_STAGES[stageIndex] : null;
    const stageSample = stage ? sampleIndex - stage.startSample : sampleIndex - NOISY_RANGE_D3_START_SAMPLE;
    const stageProgress = stage
      ? stageSample / Math.max(1, stage.endSample - stage.startSample - 1)
      : stageSample / Math.max(1, Math.round(NOISY_RANGE_D3_SECONDS * SAMPLE_RATE) - 1);
    const vibratoCents = c3Active
      ? (stage?.vibratoDepthCents ?? 10)
        * Math.sin(2 * Math.PI * 5.2 * sampleIndex / SAMPLE_RATE)
      : 8 * Math.sin(2 * Math.PI * 5.05 * stageSample / SAMPLE_RATE);
    const frequency = c3Active ? c3Frequency : d3Frequency;
    phase += 2 * Math.PI * frequency * 2 ** (vibratoCents / 1_200) / SAMPLE_RATE;

    const fundamentalGain = stage?.fundamentalGain ?? 1;
    const secondGain = stage?.secondGain ?? 0.42;
    const thirdGain = stage?.thirdGain ?? 0.2;
    const unitRms = Math.sqrt(
      (fundamentalGain ** 2 + secondGain ** 2 + thirdGain ** 2) / 2,
    );
    const dropCycleSeconds = stageSample / SAMPLE_RATE % 0.16;
    const signalGain = stage?.amplitudeDrops && dropCycleSeconds < 0.035 ? 0.08 : 1;
    let value = signalGain * voiceRms / unitRms * (
      fundamentalGain * Math.sin(phase)
      + secondGain * Math.sin(2 * phase + 0.37)
      + thirdGain * Math.sin(3 * phase + 1.13)
    );

    let noiseSnrDb = stage?.noiseSnrDb;
    if (stage?.changingNoise) {
      const triangularStrength = stageProgress <= 0.5
        ? stageProgress * 2
        : (1 - stageProgress) * 2;
      noiseSnrDb = 30 - 22 * triangularStrength;
    }
    if (noiseSnrDb !== undefined) {
      const noise = deterministicNoiseSample(noiseState);
      noiseState = noise.state;
      const noiseRms = voiceRms / 10 ** (noiseSnrDb / 20);
      value += noise.sample * Math.sqrt(3) * noiseRms;
    }

    if (stage?.impulseAmplitude !== undefined) {
      const impulseLength = Math.round(0.0025 * SAMPLE_RATE);
      const impulsePosition = stageSample % Math.round(0.137 * SAMPLE_RATE);
      if (impulsePosition < impulseLength) {
        const polarity = deterministicNoiseSample(noiseState);
        noiseState = polarity.state;
        value += stage.impulseAmplitude
          * Math.sin(Math.PI * impulsePosition / impulseLength)
          * (polarity.sample >= 0 ? 1 : -1);
      }
    }

    if (!c3Active) {
      const samplesRemaining = NOISY_RANGE_FIXTURE_SAMPLES - sampleIndex - 1;
      value *= Math.min(1, samplesRemaining / finalFadeSamples);
    }
    value = Math.max(-1, Math.min(1, value));
    wav.writeInt16LE(Math.round(value * 0x7fff), 44 + sampleIndex * bytesPerSample);
  }
  return wav;
}
