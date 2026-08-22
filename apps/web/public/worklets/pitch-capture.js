class PitchCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.bufferSize = options.processorOptions?.bufferSize ?? 4096;
    this.meterSize = options.processorOptions?.meterSize ?? 1024;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
    this.meterCount = 0;
    this.meterSum = 0;
    this.meterSumSquares = 0;
    this.meterPeak = 0;
    this.meterClipped = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    let sourceIndex = 0;
    while (sourceIndex < channel.length) {
      const count = Math.min(
        channel.length - sourceIndex,
        this.bufferSize - this.writeIndex,
        this.meterSize - this.meterCount
      );
      this.buffer.set(channel.subarray(sourceIndex, sourceIndex + count), this.writeIndex);
      for (let index = sourceIndex; index < sourceIndex + count; index += 1) {
        const sample = channel[index];
        const absolute = Math.abs(sample);
        this.meterSum += sample;
        this.meterSumSquares += sample * sample;
        this.meterPeak = Math.max(this.meterPeak, absolute);
        if (absolute >= 0.999) this.meterClipped += 1;
      }
      this.writeIndex += count;
      this.meterCount += count;
      sourceIndex += count;

      const windowEndTime = currentTime + sourceIndex / sampleRate;

      if (this.meterCount === this.meterSize) {
        const rms = Math.sqrt(this.meterSumSquares / this.meterCount);
        const peak = this.meterPeak;
        this.port.postMessage({
          type: "level",
          capturedAt: Math.max(0, windowEndTime - this.meterCount / (2 * sampleRate)),
          rms,
          peak,
          rmsDbfs: 20 * Math.log10(Math.max(rms, 1e-6)),
          peakDbfs: 20 * Math.log10(Math.max(peak, 1e-6)),
          dcOffset: this.meterSum / this.meterCount,
          clippedSampleCount: this.meterClipped,
          clipRatio: this.meterClipped / this.meterCount,
          sampleCount: this.meterCount
        });
        this.meterCount = 0;
        this.meterSum = 0;
        this.meterSumSquares = 0;
        this.meterPeak = 0;
        this.meterClipped = 0;
      }

      if (this.writeIndex === this.bufferSize) {
        this.port.postMessage({
          type: "samples",
          samples: this.buffer,
          capturedAt: Math.max(0, windowEndTime - this.bufferSize / (2 * sampleRate))
        }, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.bufferSize);
        this.writeIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor("pitch-capture", PitchCaptureProcessor);
