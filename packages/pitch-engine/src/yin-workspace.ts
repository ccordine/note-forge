/**
 * @internal
 *
 * Private mutable storage for one YIN detector instance.
 *
 * Buffers only grow and callers receive neither the arrays nor views into them.
 * Every algorithm loop must therefore use its active length, never capacity.
 */
export class YinScratchWorkspace {
  private differenceStorage: Float64Array | null = null;
  private normalizedDifferenceStorage: Float64Array | null = null;
  private harmonicScoreStorage: Float64Array | null = null;
  private hannStorage: Float64Array | null = null;
  private hannLength = 0;
  private allocationCount = 0;

  prepareLagBuffers(activeLength: number): void {
    if (this.differenceStorage === null || this.differenceStorage.length < activeLength) {
      this.differenceStorage = new Float64Array(activeLength);
      this.normalizedDifferenceStorage = new Float64Array(activeLength);
      this.allocationCount += 2;
    }
  }

  differenceBuffer(): Float64Array {
    if (this.differenceStorage === null) throw new Error("Lag buffers are not prepared.");
    return this.differenceStorage;
  }

  normalizedDifferenceBuffer(): Float64Array {
    if (this.normalizedDifferenceStorage === null) {
      throw new Error("Lag buffers are not prepared.");
    }
    return this.normalizedDifferenceStorage;
  }

  harmonicScores(activeLength: number): Float64Array {
    if (
      this.harmonicScoreStorage === null
      || this.harmonicScoreStorage.length < activeLength
    ) {
      this.harmonicScoreStorage = new Float64Array(activeLength);
      this.allocationCount += 1;
    }
    return this.harmonicScoreStorage;
  }

  hannWindow(activeLength: number): Float64Array {
    if (this.hannStorage === null || this.hannStorage.length < activeLength) {
      this.hannStorage = new Float64Array(activeLength);
      this.allocationCount += 1;
    }
    if (this.hannLength === activeLength) return this.hannStorage;

    for (let index = 0; index < activeLength; index += 1) {
      this.hannStorage[index] = activeLength === 1
        ? 1
        : 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (activeLength - 1));
    }
    this.hannLength = activeLength;
    return this.hannStorage;
  }

  get typedArrayAllocationCount(): number {
    return this.allocationCount;
  }
}
