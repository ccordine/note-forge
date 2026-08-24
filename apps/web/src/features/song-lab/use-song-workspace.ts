import { useEffect, useReducer, useRef, type ChangeEvent, type MouseEvent } from "react";
import { useAudioInput } from "@/audio/use-audio-input";
import {
  INITIAL_SONG_WORKSPACE,
  reduceSongWorkspace,
  type SongWorkspaceAction,
  type SongWorkspaceStage,
} from "./song-workspace";
import {
  SongWorkspaceRuntime,
  type SongPlaybackRequest,
} from "./song-workspace-runtime";

export function useSongWorkspace() {
  const [state, dispatch] = useReducer(reduceSongWorkspace, INITIAL_SONG_WORKSPACE);
  const input = useAudioInput();
  const audioRef = useRef<HTMLAudioElement>(null);
  const runtimeRef = useRef<SongWorkspaceRuntime | null>(null);
  if (runtimeRef.current === null) runtimeRef.current = new SongWorkspaceRuntime(dispatch);
  const runtime = runtimeRef.current;

  useEffect(() => {
    runtime.activate();
    return () => runtime.dispose();
  }, [runtime]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    element.playbackRate = state.speed * 2 ** (state.transpose / 12);
    element.preservesPitch = state.transpose === 0;
  }, [state.audioUrl, state.speed, state.transpose]);

  const playbackRequest = (): SongPlaybackRequest => ({
    element: audioRef.current,
    loopEnabled: state.loopEnabled,
    loopStart: state.loopStart,
    loopEnd: state.loopEnd,
  });

  const setStage = (stage: SongWorkspaceStage) => {
    if (runtime.recordingActive && stage !== "practice") return;
    dispatch({ type: "stage-changed", stage });
  };

  const loadFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void runtime.loadFile({
      ...playbackRequest(),
      file,
      previousAudioUrl: state.audioUrl,
      takes: state.takes,
    });
  };

  const onMetadata = () => {
    dispatch({ type: "metadata-loaded", duration: audioRef.current?.duration ?? 0 });
  };

  const onTime = () => {
    const element = audioRef.current;
    if (!element) return;
    if (state.loopEnabled && state.loopEnd > state.loopStart && element.currentTime >= state.loopEnd) {
      element.currentTime = state.loopStart;
    }
    dispatch({ type: "time-updated", time: element.currentTime });
  };

  const seekFromWaveform = (event: MouseEvent<HTMLDivElement>) => {
    const element = audioRef.current;
    if (!element || !state.duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    element.currentTime = (event.clientX - rect.left) / rect.width * state.duration;
    dispatch({ type: "time-updated", time: element.currentTime });
  };

  const startRecording = () => runtime.startRecording({
    ...playbackRequest(),
    inputRunning: input.state === "running",
    createRecorder: input.createRecorder,
    takes: state.takes,
  });

  const act = (action: SongWorkspaceAction) => dispatch(action);

  return {
    state,
    input,
    audioRef,
    act,
    setStage,
    loadFile,
    onMetadata,
    onTime,
    onPlay: () => runtime.onPlay(),
    onPause: () => runtime.onPause(),
    onEnded: () => runtime.onEnded(),
    onAudioError: () => runtime.onAudioError(),
    togglePlayback: () => runtime.togglePlayback(playbackRequest()),
    stopPlayback: () => runtime.stopPlayback(audioRef.current),
    seekFromWaveform,
    startRecording,
    stopRecording: () => runtime.stopRecording(),
    clearTakes: () => runtime.clearTakes(state.takes),
  } as const;
}
