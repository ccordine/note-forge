import {
  MAX_LOCAL_AUDIO_DECODED_SAMPLES,
  MAX_LOCAL_AUDIO_SAMPLE_RATE,
  validateDecodedLocalAudio,
} from "./local-audio-file";

let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new AudioContext({ latencyHint: "interactive" });
  }
  return sharedContext;
}

export async function ensureAudioReady(): Promise<AudioContext> {
  const context = getAudioContext();
  if (context.state === "suspended") await context.resume();
  return context;
}

/** Decode local media without creating a competing realtime AudioContext. */
export async function decodeAudioFile(encoded: ArrayBuffer): Promise<AudioBuffer> {
  return getAudioContext().decodeAudioData(encoded.slice(0));
}

/** Downmix and resample through the browser audio renderer, outside UI JS work. */
export async function renderAudioBufferToMono(
  buffer: AudioBuffer,
  sampleRate: number,
): Promise<Float32Array> {
  validateDecodedLocalAudio(buffer);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > MAX_LOCAL_AUDIO_SAMPLE_RATE) {
    throw new RangeError(`Offline render sample rate must be positive and no greater than ${MAX_LOCAL_AUDIO_SAMPLE_RATE.toLocaleString()} Hz.`);
  }
  const length = Math.ceil(buffer.duration * sampleRate);
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_LOCAL_AUDIO_DECODED_SAMPLES) {
    throw new RangeError("Offline mono render is too large to process safely in this browser tab.");
  }
  const context = new OfflineAudioContext(1, length, sampleRate);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0).slice();
}
