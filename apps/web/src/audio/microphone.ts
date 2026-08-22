import { ensureAudioReady } from "./audio-context";

export interface CapturedSamples {
  samples: Float32Array;
  capturedAt: number;
  sampleRate: number;
}

export interface MicrophoneInfo {
  settings: MediaTrackSettings;
  constraints: MediaTrackConstraints;
  sampleRate: number;
}

const REQUESTED_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: { ideal: false },
  noiseSuppression: { ideal: false },
  autoGainControl: { ideal: false }
};

export class MicrophoneCapture {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silentOutput: GainNode | null = null;

  async start(onSamples: (chunk: CapturedSamples) => void, bufferSize = 4096): Promise<MicrophoneInfo> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not supported in this browser.");
    }
    this.stop();
    const context = await ensureAudioReady();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: REQUESTED_CONSTRAINTS });
    await context.audioWorklet.addModule("/worklets/pitch-capture.js");

    this.source = context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(context, "pitch-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { bufferSize }
    });
    this.silentOutput = context.createGain();
    this.silentOutput.gain.value = 0;
    this.worklet.port.onmessage = (event: MessageEvent<{ samples: Float32Array; capturedAt: number }>) => {
      onSamples({ ...event.data, sampleRate: context.sampleRate });
    };
    this.source.connect(this.worklet).connect(this.silentOutput).connect(context.destination);

    const track = this.stream.getAudioTracks()[0];
    return {
      settings: track?.getSettings() ?? {},
      constraints: track?.getConstraints() ?? REQUESTED_CONSTRAINTS,
      sampleRate: context.sampleRate
    };
  }

  stop(): void {
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.silentOutput?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.worklet = null;
    this.source = null;
    this.silentOutput = null;
    this.stream = null;
  }
}
