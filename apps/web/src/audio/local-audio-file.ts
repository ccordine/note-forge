export const MAX_LOCAL_AUDIO_FILE_BYTES = 40 * 1024 * 1024;
export const MIN_LOCAL_AUDIO_DURATION_SECONDS = 1;
export const MAX_LOCAL_AUDIO_DURATION_SECONDS = 6 * 60;
export const MAX_LOCAL_AUDIO_CHANNELS = 8;
export const MAX_LOCAL_AUDIO_SAMPLE_RATE = 192_000;
/** 40 million decoded samples = 160 MB of Float32 PCM before app copies. */
export const MAX_LOCAL_AUDIO_DECODED_SAMPLES = 40_000_000;

const ACCEPTED_AUDIO_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "oga",
  "ogg",
  "wav",
  "webm",
]);

export function formatFileSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function fileLooksLikeAudio(file: File): boolean {
  if (file.type.toLowerCase().startsWith("audio/")) return true;
  const extension = file.name.toLowerCase().split(".").at(-1) ?? "";
  return ACCEPTED_AUDIO_EXTENSIONS.has(extension);
}

export function validateLocalAudioFile(file: File): void {
  if (!fileLooksLikeAudio(file)) {
    throw new TypeError("Choose an MP3 or another browser-decodable audio file.");
  }
  if (file.size === 0 || file.size > MAX_LOCAL_AUDIO_FILE_BYTES) {
    throw new RangeError(`Audio must be non-empty and no larger than ${formatFileSize(MAX_LOCAL_AUDIO_FILE_BYTES)}.`);
  }
}

export function validateDecodedLocalAudio(buffer: AudioBuffer): void {
  if (
    !Number.isFinite(buffer.duration)
    || buffer.duration < MIN_LOCAL_AUDIO_DURATION_SECONDS
    || buffer.duration > MAX_LOCAL_AUDIO_DURATION_SECONDS
  ) {
    throw new RangeError(
      `Choose audio from ${MIN_LOCAL_AUDIO_DURATION_SECONDS} second to ${Math.round(MAX_LOCAL_AUDIO_DURATION_SECONDS / 60)} minutes long.`,
    );
  }
  if (buffer.numberOfChannels < 1 || buffer.length === 0) {
    throw new Error("The decoded file did not contain an audio channel.");
  }
  if (buffer.numberOfChannels > MAX_LOCAL_AUDIO_CHANNELS) {
    throw new RangeError(`Decoded audio may contain at most ${MAX_LOCAL_AUDIO_CHANNELS} channels.`);
  }
  if (!Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0 || buffer.sampleRate > MAX_LOCAL_AUDIO_SAMPLE_RATE) {
    throw new RangeError(`Decoded audio sample rate may not exceed ${MAX_LOCAL_AUDIO_SAMPLE_RATE.toLocaleString()} Hz.`);
  }
  const decodedSamples = buffer.length * buffer.numberOfChannels;
  if (!Number.isSafeInteger(decodedSamples) || decodedSamples > MAX_LOCAL_AUDIO_DECODED_SAMPLES) {
    throw new RangeError("Decoded audio is too large to process safely in this browser tab.");
  }
}
