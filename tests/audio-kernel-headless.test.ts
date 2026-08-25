import { describe, expect, it } from "vitest";
import {
  AudioKernel,
  type AudioPresentationScheduler,
} from "../apps/web/src/audio/audio-kernel";
import type {
  CapturedLevel,
  CapturedSamples,
  CaptureTransportEvent,
  MicrophoneCapture,
  MicrophoneInfo,
} from "../apps/web/src/audio/microphone";

const SAMPLE_RATE = 48_000;
const WINDOW = 4_096;
const HOP = 960;
const TEN_MINUTE_WINDOWS = 10 * 60 * 50;

class DormantScheduler implements AudioPresentationScheduler {
  private nextHandle = 1;
  readonly request = (): number => this.nextHandle++;
  readonly cancel = (): void => undefined;
  readonly now = (): number => 0;
}

class HeadlessCapture {
  active = false;
  stopCount = 0;
  onSamples: ((window: CapturedSamples) => void) | null = null;
  readonly silence = new Float32Array(WINDOW);
  readonly info: MicrophoneInfo = {
    settings: {},
    constraints: {},
    sampleRate: SAMPLE_RATE,
    analysisWindowSize: WINDOW,
    analysisHopSize: HOP,
    meterWindowSize: 1_024,
    captureEpoch: 1,
  };

  async start(
    onSamples: (window: CapturedSamples) => void,
    _windowSize: number,
    _onLevel: (level: CapturedLevel) => void,
    _onEnded: () => void,
    _onTransport: (event: CaptureTransportEvent) => void,
  ): Promise<MicrophoneInfo> {
    this.active = true;
    this.onSamples = onSamples;
    return this.info;
  }

  isActive(): boolean { return this.active; }
  getInfo(): MicrophoneInfo | null { return this.active ? this.info : null; }
  getStream(): MediaStream | null { return null; }
  setMonitoring(_enabled: boolean, _level: number): void {}
  stop(): void { this.active = false; this.stopCount += 1; }

  emitSilence(index: number): void {
    const endSample = WINDOW + index * HOP;
    this.onSamples?.({
      samples: this.silence,
      capturedAt: (endSample - WINDOW / 2) / SAMPLE_RATE,
      sampleRate: SAMPLE_RATE,
      startSample: endSample - WINDOW,
      endSample,
      captureEpoch: 1,
      continuityEpoch: 0,
      graphGeneration: 0,
      processCount: Math.floor(endSample / 128),
      processedSampleCount: endSample,
      discontinuity: false,
    });
  }
}

describe("AudioKernel headless continuity", () => {
  it("processes ten minutes with no feature attachment or React subscriber", async () => {
    const capture = new HeadlessCapture();
    const kernel = new AudioKernel(
      capture as unknown as MicrophoneCapture,
      new DormantScheduler(),
    );
    await kernel.controller.enable();

    for (let index = 0; index < TEN_MINUTE_WINDOWS; index += 1) {
      capture.emitSilence(index);
    }

    const expectedEndSample = WINDOW + (TEN_MINUTE_WINDOWS - 1) * HOP;
    expect(kernel.controller.state).toBe("running");
    expect(kernel.controller.processedWindowCount).toBe(TEN_MINUTE_WINDOWS);
    expect(kernel.controller.processedSampleCount).toBe(expectedEndSample);
    expect(kernel.controller.liveFrame).toMatchObject({
      observationKind: "unvoiced",
      endSample: expectedEndSample,
    });
    expect(capture.active).toBe(true);
    expect(capture.stopCount).toBe(0);

    kernel.destroy();
    expect(capture.stopCount).toBe(1);
  });
});
