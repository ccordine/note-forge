import { ensureAudioReady } from "./audio-context";

export interface CapturedSamples {
  samples: Float32Array;
  capturedAt: number;
  sampleRate: number;
}

export interface CapturedLevel {
  capturedAt: number;
  rms: number;
  peak: number;
  rmsDbfs: number;
  peakDbfs: number;
  dcOffset: number;
  clippedSampleCount: number;
  clipRatio: number;
  sampleCount: number;
}

export interface MicrophoneInfo {
  label?: string;
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

  /**
   * The owned stream, exposed so a caller such as Song Lab can record the same
   * input that feeds diagnostics and pitch analysis. Callers must not stop its
   * tracks directly; `stop()` remains the single lifecycle owner.
   */
  getStream(): MediaStream | null {
    return this.stream;
  }

  async start(
    onSamples: (chunk: CapturedSamples) => void,
    bufferSize = 4096,
    onLevel?: (level: CapturedLevel) => void
  ): Promise<MicrophoneInfo> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not supported in this browser.");
    }
    this.stop();
    const context = await ensureAudioReady();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: REQUESTED_CONSTRAINTS });
    try {
      await context.audioWorklet.addModule("/worklets/pitch-capture.js");

      this.source = context.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(context, "pitch-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { bufferSize, meterSize: 1024 }
      });
      this.silentOutput = context.createGain();
      this.silentOutput.gain.value = 0;
      this.worklet.port.onmessage = (event: MessageEvent<
        ({ type: "samples"; samples: Float32Array; capturedAt: number })
        | ({ type: "level" } & CapturedLevel)
      >) => {
        if (event.data.type === "level") {
          onLevel?.(event.data);
          return;
        }
        onSamples({ samples: event.data.samples, capturedAt: event.data.capturedAt, sampleRate: context.sampleRate });
      };
      this.source.connect(this.worklet).connect(this.silentOutput).connect(context.destination);

      const track = this.stream.getAudioTracks()[0];
      return {
        label: track?.label,
        settings: track?.getSettings() ?? {},
        constraints: track?.getConstraints() ?? REQUESTED_CONSTRAINTS,
        sampleRate: context.sampleRate
      };
    } catch (error) {
      this.stop();
      throw error;
    }
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
