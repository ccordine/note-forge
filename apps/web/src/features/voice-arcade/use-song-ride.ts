import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type RefCallback,
} from "react";
import { useAudioInput, type AudioInputController } from "@/audio/use-audio-input";
import {
  SongRideRuntime,
  type SongRideRuntimeSpec,
} from "./song-ride-runtime";
import type { SongRideSession } from "./song-ride-session";
import type { ArcadeGameProps } from "./types";

export interface SongRideController {
  readonly session: Readonly<SongRideSession>;
  readonly input: AudioInputController;
  readonly audioRef: RefCallback<HTMLAudioElement>;
  readonly loadFile: (file: File) => Promise<void>;
  readonly clearTrack: () => void;
  readonly start: () => Promise<void>;
  readonly pause: () => void;
  readonly resume: () => Promise<void>;
  readonly finish: (completed: boolean) => void;
  readonly syncProgress: () => void;
}

export function formatSongTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${Math.floor(safe % 60).toString().padStart(2, "0")}`;
}

export function useSongRide({
  difficulty,
  curriculumStage,
  voiceRange,
  onComplete,
}: Omit<ArcadeGameProps, "onExit">): SongRideController {
  const spec = useMemo<SongRideRuntimeSpec>(() => ({
    difficulty,
    curriculumStage,
    voiceRange: Object.freeze({ ...voiceRange }),
  }), [
    curriculumStage,
    difficulty,
    voiceRange.baselineMidi,
    voiceRange.highMidi,
    voiceRange.lowMidi,
  ]);
  const runtime = useMemo(
    () => new SongRideRuntime(spec, onComplete),
    [onComplete, spec],
  );
  const session = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const input = useAudioInput({ onFrame: runtime.observe });

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") runtime.pauseHidden();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      runtime.dispose();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [runtime]);

  return Object.freeze({
    session,
    input,
    audioRef: runtime.attachAudio,
    loadFile: runtime.loadFile,
    clearTrack: runtime.clearTrack,
    start: runtime.start,
    pause: runtime.pause,
    resume: runtime.resume,
    finish: runtime.finish,
    syncProgress: runtime.syncProgress,
  });
}
