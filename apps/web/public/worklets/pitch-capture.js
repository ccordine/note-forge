class PitchCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.bufferSize = options.processorOptions?.bufferSize ?? 4096;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    let sourceIndex = 0;
    while (sourceIndex < channel.length) {
      const count = Math.min(channel.length - sourceIndex, this.bufferSize - this.writeIndex);
      this.buffer.set(channel.subarray(sourceIndex, sourceIndex + count), this.writeIndex);
      this.writeIndex += count;
      sourceIndex += count;

      if (this.writeIndex === this.bufferSize) {
        this.port.postMessage({ samples: this.buffer, capturedAt: currentTime }, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.bufferSize);
        this.writeIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor("pitch-capture", PitchCaptureProcessor);
