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

  get typedArrayAllocationCount(): number {
    return this.allocationCount;
  }
}
