import type { YinOptions, YinPitchFrame } from "./types";
import { detectPitchWithWorkspace } from "./yin";
import { YinScratchWorkspace } from "./yin-workspace";

/** One independently reusable YIN detector and its private scratch storage. */
export class YinDetector {
  private readonly workspace = new YinScratchWorkspace();
  private inUse = false;

  detectPitch(samples: Float32Array, options: YinOptions): YinPitchFrame {
    if (this.inUse) {
      throw new Error("A YinDetector instance cannot be used reentrantly.");
    }
    this.inUse = true;
    try {
      return detectPitchWithWorkspace(samples, options, this.workspace);
    } finally {
      this.inUse = false;
    }
  }
}

/** Stateless one-shot API; persistent realtime callers own a YinDetector. */
export function detectPitch(
  samples: Float32Array,
  options: YinOptions,
): YinPitchFrame {
  return new YinDetector().detectPitch(samples, options);
}
