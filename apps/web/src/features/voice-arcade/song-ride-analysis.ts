import { decodeAudioFile, renderAudioBufferToMono } from "@/audio/audio-context";
import {
  validateDecodedLocalAudio,
  validateLocalAudioFile,
} from "@/audio/local-audio-file";
import { noteLabel } from "@/lib/music-display";
import { createSongAnalysisChunks } from "./song-analysis-pcm";
import type {
  SongLaneAnalysis,
  SongLaneAnalysisOptions,
} from "./song-lane-types";
import type { ArcadeDifficultyId, ArcadeVoiceRange } from "./types";

export interface SongAnalysisTask {
  readonly promise: Promise<SongLaneAnalysis>;
  readonly cancel: () => void;
}

function beginWorkerAnalysis(
  samples: Float32Array,
  sampleRate: number,
  options: SongLaneAnalysisOptions,
): SongAnalysisTask {
  const worker = new Worker(
    new URL("./song-analysis.worker.ts", import.meta.url),
    { type: "module", name: "noteforge-song-analysis" },
  );
  let settled = false;
  let rejectTask: (reason: unknown) => void = () => undefined;
  const finish = () => {
    if (settled) return false;
    settled = true;
    worker.terminate();
    return true;
  };
  const promise = new Promise<SongLaneAnalysis>((resolve, reject) => {
    rejectTask = reject;
    worker.onmessage = (event: MessageEvent<
      | { ok: true; analysis: SongLaneAnalysis }
      | { ok: false; error: string }
    >) => {
      if (!finish()) return;
      if (event.data.ok) resolve(event.data.analysis);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      if (finish()) reject(new Error(event.message || "The song-analysis worker failed."));
    };
    worker.onmessageerror = () => {
      if (finish()) reject(new Error("The song-analysis worker returned an unreadable result."));
    };
    try {
      worker.postMessage({ samples, sampleRate, options }, [samples.buffer]);
    } catch (error) {
      finish();
      reject(error);
    }
  });
  return {
    promise,
    cancel: () => {
      if (finish()) rejectTask(new DOMException("Song analysis was cancelled.", "AbortError"));
    },
  };
}

function difficultyOptions(difficulty: ArcadeDifficultyId): Pick<
  SongLaneAnalysisOptions,
  "minimumLaneSeconds" | "mergeGapSeconds"
> {
  switch (difficulty) {
    case "easy": return { minimumLaneSeconds: 0.24, mergeGapSeconds: 0.16 };
    case "medium": return { minimumLaneSeconds: 0.15, mergeGapSeconds: 0.1 };
    case "hard": return { minimumLaneSeconds: 0.09, mergeGapSeconds: 0.06 };
  }
}

export interface PreparedSongAnalysis {
  readonly task: SongAnalysisTask;
  readonly workUnits: number;
  readonly analysisRate: number;
}

/** Decodes and resamples locally, then returns a cancellable worker task. */
export async function prepareSongAnalysis(
  file: File,
  difficulty: ArcadeDifficultyId,
  voiceRange: Readonly<ArcadeVoiceRange>,
  reportStatus: (status: string) => void,
): Promise<PreparedSongAnalysis> {
  validateLocalAudioFile(file);
  const encoded = await file.arrayBuffer();
  const decoded = await decodeAudioFile(encoded);
  validateDecodedLocalAudio(decoded);
  const analysisRate = Math.min(decoded.sampleRate, 6_000);
  reportStatus("Downmixing and resampling through the browser audio renderer…");
  const mono = await renderAudioBufferToMono(decoded, analysisRate);
  const sharedOptions: SongLaneAnalysisOptions = {
    analysisSampleRate: analysisRate,
    frameSizeSamples: 512,
    hopSizeSamples: 256,
    minFrequencyHz: 55,
    maxFrequencyHz: Math.min(1_200, analysisRate * 0.45),
    minimumConfidence: 0.72,
    rmsThreshold: 0.008,
    ...difficultyOptions(difficulty),
    difficulty,
    vocalRange: { minMidi: voiceRange.lowMidi, maxMidi: voiceRange.highMidi },
  };
  const workUnits = createSongAnalysisChunks(mono.length, analysisRate, sharedOptions).length;
  reportStatus(
    `Generating ${workUnits.toLocaleString()} local pitch windows and fitting them to ${noteLabel(voiceRange.lowMidi)}–${noteLabel(voiceRange.highMidi)}…`,
  );
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  return {
    task: beginWorkerAnalysis(mono, analysisRate, sharedOptions),
    workUnits,
    analysisRate,
  };
}
