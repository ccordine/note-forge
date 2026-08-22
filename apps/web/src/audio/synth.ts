import { ensureAudioReady } from "./audio-context";

export const TIMBRES = ["sine", "triangle", "piano", "guitar", "bass", "flute", "voice", "rich synth"] as const;
export type Timbre = (typeof TIMBRES)[number];

export interface ToneSpec {
  frequencyHz: number;
  duration?: number;
  amplitude?: number;
  timbre?: Timbre;
  attack?: number;
  release?: number;
  when?: number;
}

export interface ActiveVoice {
  stop: (releaseSeconds?: number) => void;
}

type Partial = { ratio: number; gain: number; type?: OscillatorType; detune?: number };

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
  const context = await ensureAudioReady();
  const timbre = spec.timbre ?? "sine";
  const duration = spec.duration ?? 1.2;
  const amplitude = Math.max(0.001, Math.min(spec.amplitude ?? 0.28, 0.8));
  const startAt = spec.when ?? context.currentTime + 0.012;
  const release = spec.release ?? 0.08;
  const env = envelopeFor(timbre, duration);
  const output = context.createGain();
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 12;
  compressor.ratio.value = 5;
  output.connect(compressor).connect(context.destination);

  output.gain.setValueAtTime(0.0001, startAt);
  output.gain.exponentialRampToValueAtTime(amplitude, startAt + (spec.attack ?? env.attack));
  output.gain.exponentialRampToValueAtTime(Math.max(0.0001, amplitude * env.sustain), startAt + env.attack + env.decay);
  output.gain.setValueAtTime(Math.max(0.0001, amplitude * env.sustain), startAt + duration);
  output.gain.exponentialRampToValueAtTime(0.0001, startAt + duration + release);

  const oscillators = PARTIALS[timbre].map((partial) => {
    const oscillator = context.createOscillator();
    const partialGain = context.createGain();
    oscillator.type = partial.type ?? "sine";
    oscillator.frequency.setValueAtTime(spec.frequencyHz * partial.ratio, startAt);
    oscillator.detune.setValueAtTime(partial.detune ?? 0, startAt);
    partialGain.gain.value = partial.gain;
    oscillator.connect(partialGain).connect(output);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + release + 0.05);
    return oscillator;
  });

  let stopped = false;
  return {
    stop: (releaseSeconds = 0.06) => {
      if (stopped) return;
      stopped = true;
      const now = context.currentTime;
      output.gain.cancelScheduledValues(now);
      output.gain.setValueAtTime(Math.max(0.0001, output.gain.value), now);
      output.gain.exponentialRampToValueAtTime(0.0001, now + releaseSeconds);
      oscillators.forEach((oscillator) => {
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
  const context = await ensureAudioReady();
  const duration = options.duration ?? 0.9;
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

export class Drone {
  private voice: ActiveVoice | null = null;

  async start(frequencyHz: number, timbre: Timbre, amplitude = 0.18): Promise<void> {
    this.stop();
    this.voice = await playTone({ frequencyHz, timbre, amplitude, duration: 3_600, release: 0.12 });
  }

  stop(): void {
    this.voice?.stop(0.09);
    this.voice = null;
  }
}

export async function playPitchContour(midiPoints: readonly number[], duration = 2.5, amplitude = 0.2): Promise<void> {
  if (midiPoints.length < 2) return;
  const context = await ensureAudioReady();
  const startAt = context.currentTime + 0.025;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(440 * 2 ** ((midiPoints[0] - 69) / 12), startAt);
  midiPoints.slice(1).forEach((midi, index) => {
    oscillator.frequency.linearRampToValueAtTime(440 * 2 ** ((midi - 69) / 12), startAt + ((index + 1) / (midiPoints.length - 1)) * duration);
  });
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(amplitude, startAt + 0.04);
  gain.gain.setValueAtTime(amplitude, startAt + duration);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration + 0.08);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.1);
}
