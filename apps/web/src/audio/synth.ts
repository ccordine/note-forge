import { ensureAudioReady } from "./audio-context";
import { midiToFrequency } from "@noteforge/music-core";
import { clamp } from "@/lib/numeric";

export const TIMBRES = Object.freeze(["sine", "triangle", "piano", "guitar", "bass", "flute", "voice", "rich synth"] as const);
export type Timbre = (typeof TIMBRES)[number];

export const SYNTH_LIMITS = Object.freeze({
  minimumFrequencyHz: 20,
  maximumFrequencyHz: 24_000,
  maximumAmplitude: 0.8,
  maximumToneDurationSeconds: 3_600,
  maximumEnvelopeSeconds: 10,
  maximumScheduleAheadSeconds: 3_600,
  maximumSequenceDurationSeconds: 600,
  maximumToneCount: 128,
  maximumContourPointCount: 512,
  maximumContourDurationSeconds: 60,
});

export interface ToneSpec {
  frequencyHz: number;
  duration?: number;
  amplitude?: number;
  timbre?: Timbre;
  attack?: number;
  release?: number;
  when?: number;
}

/** One independently voiced item in a sequential playback gesture. */
export interface ToneSequenceItem extends Omit<ToneSpec, "when"> {
  /** Silence after this item before the next item begins. */
  gapAfter?: number;
}

/** Defaults shared by items that do not specify their own synthesis values. */
export interface ToneSequenceOptions extends Omit<ToneSpec, "frequencyHz" | "when"> {
  /** Silence between items unless an item supplies `gapAfter`. */
  gap?: number;
  /** Scheduling headroom before the first item. */
  startDelay?: number;
}

export type ScheduledToneSpec = ToneSpec & { duration: number; when: number };

export interface ActiveVoice {
  stop: (releaseSeconds?: number) => void;
}

interface SustainedVoice extends ActiveVoice {
  update: (frequencyHz: number, timbre: Timbre, amplitude?: number) => void;
}

/** Terminate intentionally fire-and-forget playback without hiding failures. */
export function playSafely(operation: Promise<unknown>, label = "Audio playback"): void {
  void operation.catch((error) => console.error(`${label} failed.`, error));
}

type Partial = { ratio: number; gain: number; type?: OscillatorType; detune?: number };

function requireFiniteRange(label: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a finite number from ${minimum} through ${maximum}.`);
  }
}

function validateFrequency(frequencyHz: number): void {
  requireFiniteRange(
    "Tone frequency",
    frequencyHz,
    SYNTH_LIMITS.minimumFrequencyHz,
    SYNTH_LIMITS.maximumFrequencyHz,
  );
}

function validateToneValues(spec: Omit<ToneSpec, "frequencyHz"> & { frequencyHz?: number }): void {
  if (spec.frequencyHz !== undefined) validateFrequency(spec.frequencyHz);
  if (spec.duration !== undefined) {
    requireFiniteRange("Tone duration", spec.duration, Number.EPSILON, SYNTH_LIMITS.maximumToneDurationSeconds);
  }
  if (spec.amplitude !== undefined) requireFiniteRange("Tone amplitude", spec.amplitude, Number.EPSILON, SYNTH_LIMITS.maximumAmplitude);
  if (spec.attack !== undefined) requireFiniteRange("Tone attack", spec.attack, 0, SYNTH_LIMITS.maximumEnvelopeSeconds);
  if (spec.release !== undefined) requireFiniteRange("Tone release", spec.release, 0, SYNTH_LIMITS.maximumEnvelopeSeconds);
  if (spec.when !== undefined) requireFiniteRange("Tone start time", spec.when, 0, Number.MAX_SAFE_INTEGER);
  if (spec.timbre !== undefined && !(TIMBRES as readonly string[]).includes(spec.timbre)) {
    throw new RangeError(`Unsupported timbre: ${String(spec.timbre)}.`);
  }
}

function validateCollectionSize(label: string, length: number, maximum: number): void {
  if (length > maximum) throw new RangeError(`${label} supports at most ${maximum} items.`);
}

const PARTIALS: Record<Timbre, Partial[]> = {
  sine: [{ ratio: 1, gain: 1, type: "sine" }],
  triangle: [{ ratio: 1, gain: 0.92, type: "triangle" }],
  piano: [
    { ratio: 1, gain: 0.8, type: "sine" },
    { ratio: 2, gain: 0.25, type: "sine", detune: 1.8 },
    { ratio: 3, gain: 0.12, type: "sine", detune: -1.1 },
    { ratio: 4, gain: 0.05, type: "sine" }
  ],
  guitar: [
    { ratio: 1, gain: 0.75, type: "triangle" },
    { ratio: 2, gain: 0.22, type: "sine" },
    { ratio: 3, gain: 0.12, type: "sine" },
    { ratio: 5, gain: 0.05, type: "sine" }
  ],
  bass: [
    { ratio: 1, gain: 0.86, type: "sine" },
    { ratio: 2, gain: 0.18, type: "triangle" },
    { ratio: 0.5, gain: 0.1, type: "sine" }
  ],
  flute: [
    { ratio: 1, gain: 0.9, type: "sine" },
    { ratio: 2, gain: 0.1, type: "sine" },
    { ratio: 3, gain: 0.035, type: "sine" }
  ],
  voice: [
    { ratio: 1, gain: 0.7, type: "sawtooth" },
    { ratio: 2, gain: 0.16, type: "sine" },
    { ratio: 3, gain: 0.1, type: "sine" },
    { ratio: 4, gain: 0.06, type: "sine" }
  ],
  "rich synth": [
    { ratio: 1, gain: 0.56, type: "sawtooth", detune: -5 },
    { ratio: 1, gain: 0.52, type: "sawtooth", detune: 5 },
    { ratio: 2, gain: 0.12, type: "square" }
  ]
};

function envelopeFor(timbre: Timbre, duration: number): { attack: number; decay: number; sustain: number } {
  if (timbre === "piano") return { attack: 0.008, decay: Math.min(1.1, duration * 0.7), sustain: 0.08 };
  if (timbre === "guitar") return { attack: 0.004, decay: Math.min(0.75, duration * 0.55), sustain: 0.05 };
  if (timbre === "flute" || timbre === "voice") return { attack: 0.08, decay: 0.12, sustain: 0.82 };
  return { attack: 0.018, decay: 0.08, sustain: 0.78 };
}

export async function playTone(spec: ToneSpec): Promise<ActiveVoice> {
  validateFrequency(spec.frequencyHz);
  validateToneValues(spec);
  const context = await ensureAudioReady();
  const timbre = spec.timbre ?? "sine";
  const duration = spec.duration ?? 1.2;
  const amplitude = spec.amplitude ?? 0.28;
  const startAt = spec.when ?? context.currentTime + 0.012;
  const release = spec.release ?? 0.08;
  const env = envelopeFor(timbre, duration);
  const attack = Math.min(spec.attack ?? env.attack, duration);
  const decay = clamp(env.decay, 0, duration - attack);
  if (startAt > context.currentTime + SYNTH_LIMITS.maximumScheduleAheadSeconds) {
    throw new RangeError(`Tone start time cannot be more than ${SYNTH_LIMITS.maximumScheduleAheadSeconds} seconds ahead.`);
  }
  const output = context.createGain();
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 12;
  compressor.ratio.value = 5;
  output.connect(compressor).connect(context.destination);

  output.gain.setValueAtTime(Number.EPSILON, startAt);
  output.gain.exponentialRampToValueAtTime(amplitude, startAt + attack);
  output.gain.exponentialRampToValueAtTime(Math.max(Number.EPSILON, amplitude * env.sustain), startAt + attack + decay);
  output.gain.setValueAtTime(Math.max(Number.EPSILON, amplitude * env.sustain), startAt + duration);
  output.gain.exponentialRampToValueAtTime(Number.EPSILON, startAt + duration + release);

  let activeOscillators = PARTIALS[timbre].length;
  const oscillatorNodes = PARTIALS[timbre].map((partial) => {
    const oscillator = context.createOscillator();
    const partialGain = context.createGain();
    oscillator.type = partial.type ?? "sine";
    oscillator.frequency.setValueAtTime(spec.frequencyHz * partial.ratio, startAt);
    oscillator.detune.setValueAtTime(partial.detune ?? 0, startAt);
    partialGain.gain.value = partial.gain;
    oscillator.connect(partialGain).connect(output);
    oscillator.onended = () => {
      oscillator.disconnect();
      partialGain.disconnect();
      activeOscillators -= 1;
      if (activeOscillators === 0) {
        output.disconnect();
        compressor.disconnect();
      }
    };
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + release + 0.05);
    return { oscillator };
  });

  let stopped = false;
  return {
    stop: (releaseSeconds = 0.06) => {
      requireFiniteRange("Stop release", releaseSeconds, 0, SYNTH_LIMITS.maximumEnvelopeSeconds);
      if (stopped) return;
      stopped = true;
      const now = context.currentTime;
      output.gain.cancelScheduledValues(now);
      output.gain.setValueAtTime(Math.max(Number.EPSILON, output.gain.value), now);
      output.gain.exponentialRampToValueAtTime(Number.EPSILON, now + releaseSeconds);
      oscillatorNodes.forEach(({ oscillator }) => {
        try { oscillator.stop(now + releaseSeconds + 0.02); } catch { /* already stopped */ }
      });
    }
  };
}

export async function playFrequencies(
  frequencies: readonly number[],
  mode: "simultaneous" | "sequential",
  options: Omit<ToneSpec, "frequencyHz" | "when"> = {}
): Promise<void> {
  validateCollectionSize("Frequency playback", frequencies.length, SYNTH_LIMITS.maximumToneCount);
  frequencies.forEach(validateFrequency);
  validateToneValues(options);
  const duration = options.duration ?? 0.9;
  if (mode !== "simultaneous" && mode !== "sequential") throw new RangeError(`Unsupported playback mode: ${String(mode)}.`);
  const gestureDuration = mode === "sequential" ? frequencies.length * (duration + 0.12) : duration;
  if (gestureDuration > SYNTH_LIMITS.maximumSequenceDurationSeconds) {
    throw new RangeError(`Frequency playback cannot exceed ${SYNTH_LIMITS.maximumSequenceDurationSeconds} seconds.`);
  }
  const context = await ensureAudioReady();
  const now = context.currentTime + 0.025;
  await Promise.all(
    frequencies.map((frequencyHz, index) =>
      playTone({
        ...options,
        frequencyHz,
        amplitude: (options.amplitude ?? 0.3) / Math.max(1, Math.sqrt(frequencies.length)),
        when: mode === "simultaneous" ? now : now + index * (duration + 0.12)
      })
    )
  );
}

/**
 * Resolve a heterogeneous tone sequence into absolute Web Audio start times.
 * Kept pure so sequence timing can be verified without constructing an
 * AudioContext in tests.
 */
export function createToneSequenceSchedule(
  tones: readonly ToneSequenceItem[],
  startAt: number,
  options: ToneSequenceOptions = {}
): ScheduledToneSpec[] {
  validateCollectionSize("Tone sequence", tones.length, SYNTH_LIMITS.maximumToneCount);
  requireFiniteRange(
    "Sequence start time",
    startAt,
    0,
    Number.MAX_SAFE_INTEGER - SYNTH_LIMITS.maximumSequenceDurationSeconds,
  );
  validateToneValues(options);
  if (options.gap !== undefined) requireFiniteRange("Sequence gap", options.gap, 0, SYNTH_LIMITS.maximumEnvelopeSeconds);
  if (options.startDelay !== undefined) {
    requireFiniteRange("Sequence start delay", options.startDelay, 0, SYNTH_LIMITS.maximumEnvelopeSeconds);
  }
  const {
    gap: defaultGap = 0.12,
    startDelay: _startDelay,
    duration: defaultDuration = 0.9,
    ...toneDefaults
  } = options;
  let when = startAt;

  const schedule = tones.map((item) => {
    const { gapAfter, duration = defaultDuration, ...tone } = item;
    validateFrequency(item.frequencyHz);
    validateToneValues({ ...toneDefaults, ...tone, duration });
    const resolvedGap = gapAfter ?? defaultGap;
    requireFiniteRange("Tone gap", resolvedGap, 0, SYNTH_LIMITS.maximumEnvelopeSeconds);
    const scheduled: ScheduledToneSpec = {
      ...toneDefaults,
      ...tone,
      duration,
      when
    };
    when += duration + resolvedGap;
    return scheduled;
  });
  if (when - startAt > SYNTH_LIMITS.maximumSequenceDurationSeconds) {
    throw new RangeError(`Tone sequence cannot exceed ${SYNTH_LIMITS.maximumSequenceDurationSeconds} seconds.`);
  }
  return schedule;
}

/**
 * Play a sequential gesture whose tones may have different timbres, envelopes,
 * amplitudes, durations, and following gaps.
 */
export async function playToneSequence(
  tones: readonly ToneSequenceItem[],
  options: ToneSequenceOptions = {}
): Promise<ActiveVoice> {
  validateCollectionSize("Tone sequence", tones.length, SYNTH_LIMITS.maximumToneCount);
  validateToneValues(options);
  if (options.gap !== undefined) requireFiniteRange("Sequence gap", options.gap, 0, SYNTH_LIMITS.maximumEnvelopeSeconds);
  if (options.startDelay !== undefined) {
    requireFiniteRange("Sequence start delay", options.startDelay, 0, SYNTH_LIMITS.maximumEnvelopeSeconds);
  }
  tones.forEach((item) => {
    validateFrequency(item.frequencyHz);
    validateToneValues(item);
    if (item.gapAfter !== undefined) requireFiniteRange("Tone gap", item.gapAfter, 0, SYNTH_LIMITS.maximumEnvelopeSeconds);
  });
  if (tones.length === 0) return { stop: () => undefined };
  const context = await ensureAudioReady();
  const startAt = context.currentTime + (options.startDelay ?? 0.025);
  const schedule = createToneSequenceSchedule(tones, startAt, options);
  const voices = await Promise.all(schedule.map((tone) => playTone(tone)));
  let stopped = false;
  return {
    stop: (releaseSeconds = 0.05) => {
      if (stopped) return;
      stopped = true;
      voices.forEach((voice) => voice.stop(releaseSeconds));
    },
  };
}

/**
 * Start an oscillator voice with no scheduled end. Only the returned stop
 * action owns its lifetime; this is intentionally separate from timed prompts.
 */
async function playUserOwnedSustainedTone(
  frequencyHz: number,
  timbre: Timbre,
  amplitude: number,
): Promise<SustainedVoice> {
  validateFrequency(frequencyHz);
  validateToneValues({ timbre, amplitude });
  const context = await ensureAudioReady();
  const startAt = context.currentTime + 0.012;
  const attack = Math.min(0.08, envelopeFor(timbre, 1).attack);
  const output = context.createGain();
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 12;
  compressor.ratio.value = 5;
  output.connect(compressor).connect(context.destination);
  output.gain.setValueAtTime(Number.EPSILON, startAt);
  output.gain.exponentialRampToValueAtTime(amplitude, startAt + attack);

  const oscillatorCount = Math.max(...Object.values(PARTIALS).map((partials) => partials.length));
  let activeOscillators = oscillatorCount;
  const oscillators = Array.from({ length: oscillatorCount }, (_, index) => {
    const partial = PARTIALS[timbre][index];
    const oscillator = context.createOscillator();
    const partialGain = context.createGain();
    oscillator.type = partial?.type ?? "sine";
    oscillator.frequency.setValueAtTime(frequencyHz * (partial?.ratio ?? 1), startAt);
    oscillator.detune.setValueAtTime(partial?.detune ?? 0, startAt);
    partialGain.gain.value = partial?.gain ?? 0;
    oscillator.connect(partialGain).connect(output);
    oscillator.onended = () => {
      oscillator.disconnect();
      partialGain.disconnect();
      activeOscillators -= 1;
      if (activeOscillators === 0) {
        output.disconnect();
        compressor.disconnect();
      }
    };
    oscillator.start(startAt);
    return { oscillator, partialGain };
  });

  let stopped = false;
  return {
    update: (nextFrequencyHz, nextTimbre, nextAmplitude = amplitude) => {
      validateFrequency(nextFrequencyHz);
      validateToneValues({ timbre: nextTimbre, amplitude: nextAmplitude });
      if (stopped) return;
      const now = context.currentTime;
      const transitionEnd = now + 0.045;
      output.gain.cancelScheduledValues(now);
      output.gain.setValueAtTime(Math.max(Number.EPSILON, output.gain.value), now);
      output.gain.exponentialRampToValueAtTime(nextAmplitude, transitionEnd);
      oscillators.forEach(({ oscillator, partialGain }, index) => {
        const partial = PARTIALS[nextTimbre][index];
        oscillator.type = partial?.type ?? "sine";
        oscillator.frequency.cancelScheduledValues(now);
        oscillator.frequency.setValueAtTime(oscillator.frequency.value, now);
        oscillator.frequency.exponentialRampToValueAtTime(
          nextFrequencyHz * (partial?.ratio ?? 1),
          transitionEnd,
        );
        oscillator.detune.cancelScheduledValues(now);
        oscillator.detune.setValueAtTime(partial?.detune ?? 0, transitionEnd);
        partialGain.gain.cancelScheduledValues(now);
        partialGain.gain.setValueAtTime(partialGain.gain.value, now);
        partialGain.gain.linearRampToValueAtTime(partial?.gain ?? 0, transitionEnd);
      });
    },
    stop: (releaseSeconds = 0.06) => {
      requireFiniteRange("Stop release", releaseSeconds, 0, SYNTH_LIMITS.maximumEnvelopeSeconds);
      if (stopped) return;
      stopped = true;
      const now = context.currentTime;
      output.gain.cancelScheduledValues(now);
      output.gain.setValueAtTime(Math.max(Number.EPSILON, output.gain.value), now);
      output.gain.exponentialRampToValueAtTime(Number.EPSILON, now + releaseSeconds);
      oscillators.forEach(({ oscillator }) => {
        try { oscillator.stop(now + releaseSeconds + 0.02); } catch { /* already stopped */ }
      });
    },
  };
}

export class Drone {
  private voice: SustainedVoice | null = null;
  private generation = 0;
  private desired: Readonly<{ frequencyHz: number; timbre: Timbre; amplitude: number }> | null = null;

  async start(frequencyHz: number, timbre: Timbre, amplitude = 0.18): Promise<boolean> {
    validateFrequency(frequencyHz);
    validateToneValues({ timbre, amplitude });
    this.desired = Object.freeze({ frequencyHz, timbre, amplitude });
    if (this.voice) {
      this.voice.update(frequencyHz, timbre, amplitude);
      return true;
    }
    const generation = this.generation;
    const voice = await playUserOwnedSustainedTone(frequencyHz, timbre, amplitude);
    if (generation !== this.generation) {
      voice.stop(0);
      return false;
    }
    const desired = this.desired;
    if (
      desired
      && (
        desired.frequencyHz !== frequencyHz
        || desired.timbre !== timbre
        || desired.amplitude !== amplitude
      )
    ) {
      voice.update(desired.frequencyHz, desired.timbre, desired.amplitude);
    }
    this.voice = voice;
    return true;
  }

  update(frequencyHz: number, timbre: Timbre, amplitude = 0.18): void {
    validateFrequency(frequencyHz);
    validateToneValues({ timbre, amplitude });
    this.desired = Object.freeze({ frequencyHz, timbre, amplitude });
    this.voice?.update(frequencyHz, timbre, amplitude);
  }

  stop(): void {
    this.generation += 1;
    this.desired = null;
    this.voice?.stop(0.09);
    this.voice = null;
  }
}

export async function playPitchContour(midiPoints: readonly number[], duration = 2.5, amplitude = 0.2): Promise<void> {
  validateCollectionSize("Pitch contour", midiPoints.length, SYNTH_LIMITS.maximumContourPointCount);
  requireFiniteRange("Pitch contour duration", duration, Number.EPSILON, SYNTH_LIMITS.maximumContourDurationSeconds);
  requireFiniteRange("Pitch contour amplitude", amplitude, Number.EPSILON, SYNTH_LIMITS.maximumAmplitude);
  const frequencies = midiPoints.map((midi) => {
    if (!Number.isFinite(midi)) throw new RangeError("Pitch contour points must be finite MIDI coordinates.");
    const frequencyHz = midiToFrequency(midi);
    validateFrequency(frequencyHz);
    return frequencyHz;
  });
  if (midiPoints.length < 2) return;
  const context = await ensureAudioReady();
  const startAt = context.currentTime + 0.025;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequencies[0]!, startAt);
  frequencies.slice(1).forEach((frequencyHz, index) => {
    oscillator.frequency.linearRampToValueAtTime(frequencyHz, startAt + ((index + 1) / (midiPoints.length - 1)) * duration);
  });
  gain.gain.setValueAtTime(Number.EPSILON, startAt);
  gain.gain.exponentialRampToValueAtTime(amplitude, startAt + 0.04);
  gain.gain.setValueAtTime(amplitude, startAt + duration);
  gain.gain.exponentialRampToValueAtTime(Number.EPSILON, startAt + duration + 0.08);
  oscillator.connect(gain).connect(context.destination);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.1);
}
