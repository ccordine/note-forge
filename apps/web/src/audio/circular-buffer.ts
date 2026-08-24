export class CircularBuffer<T> {
  private readonly storage: (T | undefined)[];
  private writeIndex = 0;
  private length = 0;
  private cached: readonly T[] = Object.freeze([]) as readonly T[];
  private dirty = false;

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("Circular buffer capacity must be a positive integer.");
    }
    this.storage = new Array<T | undefined>(capacity);
  }

  push(value: T): void {
    this.storage[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.length = Math.min(this.capacity, this.length + 1);
    this.dirty = true;
  }

  clear(): void {
    this.storage.fill(undefined);
    this.writeIndex = 0;
    this.length = 0;
    this.cached = Object.freeze([]) as readonly T[];
    this.dirty = false;
  }

  snapshot(): readonly T[] {
    if (!this.dirty) return this.cached;
    const start = (this.writeIndex - this.length + this.capacity) % this.capacity;
    const next = Array.from({ length: this.length }, (_, index) => (
      this.storage[(start + index) % this.capacity]!
    ));
    this.cached = Object.freeze(next);
    this.dirty = false;
    return this.cached;
  }
}
