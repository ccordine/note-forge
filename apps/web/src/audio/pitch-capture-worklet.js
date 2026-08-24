const MAX_WINDOW_SIZE = 262144;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

function windowSize(options, name, fallback) {
  const value = options?.processorOptions?.[name] ?? fallback;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_WINDOW_SIZE) {
    throw new RangeError(`${name} must be an integer between 1 and ${MAX_WINDOW_SIZE}.`);
  }
  return value;
}

function counter(options, name, fallback = 0) {
  const value = options?.processorOptions?.[name] ?? fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

class PitchCaptureProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    this.windowSize = windowSize(options, "windowSize", 4096);
    this.hopSize = windowSize(options, "hopSize", 960);
    this.meterSize = windowSize(options, "meterSize", 1024);
    if (this.hopSize > this.windowSize) {
      throw new RangeError("hopSize must be no greater than windowSize.");
    }

    this.captureEpoch = counter(options, "captureEpoch");
    this.continuityEpoch = counter(options, "continuityEpoch");
    this.graphGeneration = counter(options, "graphGeneration");
    this.processCount = counter(options, "processCount");
    this.processedSampleCount = counter(options, "processedSampleCount");

    this.analysisRing = new Float32Array(this.windowSize);
    this.analysisWriteIndex = 0;
    this.analysisSampleCount = 0;
    this.nextWindowEndSample = this.processedSampleCount + this.windowSize;
    // The first complete window establishes a new capture/graph authority.
    this.nextWindowIsDiscontinuity = true;

    this.meterCount = 0;
    this.meterSum = 0;
    this.meterSumSquares = 0;
    this.meterPeak = 0;
    this.meterClipped = 0;
    this.mixBuffer = new Float32Array(0);

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type !== "discontinuity") return;
      const nextContinuityEpoch = message.continuityEpoch;
      if (
        !Number.isSafeInteger(nextContinuityEpoch)
        || nextContinuityEpoch <= this.continuityEpoch
      ) {
        return;
      }
      this.continuityEpoch = nextContinuityEpoch;
      this.resetAnalysisRing();
    };
  }

  resetAnalysisRing() {
    this.analysisRing.fill(0);
    this.analysisWriteIndex = 0;
    this.analysisSampleCount = 0;
    this.nextWindowEndSample = this.processedSampleCount + this.windowSize;
    this.nextWindowIsDiscontinuity = true;
  }

  monoInput(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return null;
    if (channels.length === 1) return channels[0] ?? null;

    let sampleCount = 0;
    for (const channel of channels) sampleCount = Math.max(sampleCount, channel?.length ?? 0);
    if (sampleCount === 0) return null;
    if (this.mixBuffer.length !== sampleCount) {
      this.mixBuffer = new Float32Array(sampleCount);
    } else {
      this.mixBuffer.fill(0);
    }
    for (const channel of channels) {
      if (!channel) continue;
      for (let index = 0; index < channel.length; index += 1) {
        this.mixBuffer[index] += channel[index] / channels.length;
      }
    }
    return this.mixBuffer;
  }

  emitAnalysisWindow() {
    const samples = new Float32Array(this.windowSize);
    const tailLength = this.windowSize - this.analysisWriteIndex;
    samples.set(this.analysisRing.subarray(this.analysisWriteIndex), 0);
    if (this.analysisWriteIndex > 0) {
      samples.set(this.analysisRing.subarray(0, this.analysisWriteIndex), tailLength);
    }

    const endSample = this.processedSampleCount;
    const startSample = endSample - this.windowSize;
    this.port.postMessage({
      type: "samples",
      samples,
      startSample,
      endSample,
      capturedAt: (startSample + endSample) / (2 * sampleRate),
      captureEpoch: this.captureEpoch,
      continuityEpoch: this.continuityEpoch,
      graphGeneration: this.graphGeneration,
      processCount: this.processCount,
      processedSampleCount: this.processedSampleCount,
      discontinuity: this.nextWindowIsDiscontinuity,
    }, [samples.buffer]);
    this.nextWindowIsDiscontinuity = false;
    this.nextWindowEndSample += this.hopSize;
  }

  emitMeterWindow() {
    const rms = Math.sqrt(this.meterSumSquares / this.meterCount);
    const peak = this.meterPeak;
    this.port.postMessage({
      type: "level",
      capturedAt: Math.max(
        0,
        (this.processedSampleCount - this.meterCount / 2) / sampleRate,
      ),
      rms,
      peak,
      rmsDbfs: 20 * Math.log10(Math.max(rms, 1e-6)),
      peakDbfs: 20 * Math.log10(Math.max(peak, 1e-6)),
      dcOffset: this.meterSum / this.meterCount,
      clippedSampleCount: this.meterClipped,
      clipRatio: this.meterClipped / this.meterCount,
      sampleCount: this.meterCount,
    });
    this.meterCount = 0;
    this.meterSum = 0;
    this.meterSumSquares = 0;
    this.meterPeak = 0;
    this.meterClipped = 0;
  }

  process(inputs) {
    if (this.processCount >= MAX_COUNTER) {
      throw new RangeError("processCount exceeded the safe integer range.");
    }
    this.processCount += 1;
    const channel = this.monoInput(inputs);
    if (!channel || channel.length === 0) return true;
    if (this.processedSampleCount > MAX_COUNTER - channel.length) {
      throw new RangeError("processedSampleCount exceeded the safe integer range.");
    }

    for (let sourceIndex = 0; sourceIndex < channel.length; sourceIndex += 1) {
      const sample = channel[sourceIndex];
      this.analysisRing[this.analysisWriteIndex] = sample;
      this.analysisWriteIndex = (this.analysisWriteIndex + 1) % this.windowSize;
      this.analysisSampleCount = Math.min(
        this.windowSize,
        this.analysisSampleCount + 1,
      );

      const absolute = Math.abs(sample);
      this.meterSum += sample;
      this.meterSumSquares += sample * sample;
      this.meterPeak = Math.max(this.meterPeak, absolute);
      if (absolute >= 0.999) this.meterClipped += 1;
      this.meterCount += 1;
      this.processedSampleCount += 1;

      if (this.meterCount === this.meterSize) this.emitMeterWindow();
      if (
        this.analysisSampleCount === this.windowSize
        && this.processedSampleCount === this.nextWindowEndSample
      ) {
        this.emitAnalysisWindow();
      }
    }
    return true;
  }
}

registerProcessor("pitch-capture", PitchCaptureProcessor);
