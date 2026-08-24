/// <reference lib="webworker" />

import type { SongLaneAnalysis, SongLaneAnalysisOptions } from "./song-lane-types";
import { analyzeSongLanes } from "./song-lanes";

interface SongAnalysisRequest {
  samples: Float32Array;
  sampleRate: number;
  options: SongLaneAnalysisOptions;
}

type SongAnalysisResponse =
  | { ok: true; analysis: SongLaneAnalysis }
  | { ok: false; error: string };

self.onmessage = (event: MessageEvent<SongAnalysisRequest>) => {
  try {
    const analysis = analyzeSongLanes(
      event.data.samples,
      event.data.sampleRate,
      event.data.options,
    );
    self.postMessage({ ok: true, analysis } satisfies SongAnalysisResponse);
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : "Song analysis failed.",
    } satisfies SongAnalysisResponse);
  }
};

export {};
