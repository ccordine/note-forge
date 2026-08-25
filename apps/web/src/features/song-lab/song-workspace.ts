export type SongWorkspaceStage = "configure" | "practice" | "review";
export type PracticePass = "shadow" | "understand" | "mutate";
export type SongMarkerKind = "breath" | "phrase";
export type RecordingStatus = "idle" | "opening" | "active" | "finalizing";

export interface SongMarker {
  readonly time: number;
  readonly type: SongMarkerKind;
}

export interface VoiceTake {
  readonly id: string;
  readonly url: string;
  readonly createdAt: Date;
}

export interface LoadedSong {
  readonly url: string;
  readonly fileName: string;
  readonly duration: number;
  readonly peaks: readonly number[];
}

export interface SongWorkspaceState {
  readonly stage: SongWorkspaceStage;
  readonly audioUrl?: string;
  readonly fileName: string;
  readonly duration: number;
  readonly currentTime: number;
  readonly playing: boolean;
  readonly loopEnabled: boolean;
  readonly loopStart: number;
  readonly loopEnd: number;
  readonly speed: number;
  readonly transpose: number;
  readonly peaks: readonly number[];
  readonly loadingFile: boolean;
  readonly loadError: string;
  readonly practicePass: PracticePass;
  readonly chords: string;
  readonly phraseNote: string;
  readonly markers: readonly SongMarker[];
  readonly recordingStatus: RecordingStatus;
  readonly takes: readonly VoiceTake[];
  readonly recordError: string;
}

export const INITIAL_SONG_WORKSPACE: Readonly<SongWorkspaceState> = Object.freeze({
  stage: "configure",
  fileName: "",
  duration: 0,
  currentTime: 0,
  playing: false,
  loopEnabled: true,
  loopStart: 0,
  loopEnd: 0,
  speed: 0.85,
  transpose: 0,
  peaks: Object.freeze([]),
  loadingFile: false,
  loadError: "",
  practicePass: "shadow",
  chords: "C | Am | F | G",
  phraseNote: "",
  markers: Object.freeze([]),
  recordingStatus: "idle",
  takes: Object.freeze([]),
  recordError: "",
});

export type SongWorkspaceAction =
  | { readonly type: "load-started" }
  | { readonly type: "load-failed"; readonly message: string }
  | { readonly type: "song-loaded"; readonly song: LoadedSong }
  | { readonly type: "metadata-loaded"; readonly duration: number }
  | { readonly type: "time-updated"; readonly time: number }
  | { readonly type: "playing-changed"; readonly playing: boolean }
  | { readonly type: "loop-toggled" }
  | { readonly type: "loop-start-changed"; readonly time: number }
  | { readonly type: "loop-end-changed"; readonly time: number }
  | { readonly type: "speed-changed"; readonly speed: number }
  | { readonly type: "transpose-changed"; readonly semitones: number }
  | { readonly type: "stage-changed"; readonly stage: SongWorkspaceStage }
  | { readonly type: "pass-changed"; readonly pass: PracticePass }
  | { readonly type: "chords-changed"; readonly chords: string }
  | { readonly type: "phrase-note-changed"; readonly phraseNote: string }
  | { readonly type: "marker-added"; readonly marker: SongMarker; readonly maximum: number }
  | { readonly type: "recording-starting" }
  | { readonly type: "recording-started" }
  | { readonly type: "recording-degraded"; readonly message: string }
  | { readonly type: "recording-finalizing" }
  | { readonly type: "recording-stopped" }
  | { readonly type: "recording-failed"; readonly message: string }
  | { readonly type: "take-added"; readonly take: VoiceTake; readonly maximum: number }
  | { readonly type: "takes-cleared" };

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function freezeState(state: SongWorkspaceState): SongWorkspaceState {
  return Object.freeze(state);
}

export function reduceSongWorkspace(
  state: Readonly<SongWorkspaceState>,
  action: Readonly<SongWorkspaceAction>,
): SongWorkspaceState {
  switch (action.type) {
    case "load-started":
      return freezeState({ ...state, loadingFile: true, loadError: "" });
    case "load-failed":
      return freezeState({ ...state, loadingFile: false, loadError: action.message });
    case "song-loaded": {
      const duration = finiteNonNegative(action.song.duration);
      return freezeState({
        ...state,
        stage: "configure",
        audioUrl: action.song.url,
        fileName: action.song.fileName,
        duration,
        currentTime: 0,
        playing: false,
        loopStart: 0,
        loopEnd: Math.min(duration, 8),
        peaks: Object.freeze([...action.song.peaks]),
        loadingFile: false,
        loadError: "",
        practicePass: "shadow",
        phraseNote: "",
        markers: Object.freeze([]),
        recordingStatus: "idle",
        takes: Object.freeze([]),
        recordError: "",
      });
    }
    case "metadata-loaded": {
      const duration = finiteNonNegative(action.duration);
      return freezeState({
        ...state,
        duration,
        loopStart: 0,
        loopEnd: Math.min(duration, 8),
      });
    }
    case "time-updated":
      return freezeState({ ...state, currentTime: finiteNonNegative(action.time) });
    case "playing-changed":
      return freezeState({ ...state, playing: action.playing });
    case "loop-toggled":
      return freezeState({ ...state, loopEnabled: !state.loopEnabled });
    case "loop-start-changed":
      return freezeState({
        ...state,
        loopStart: Math.min(finiteNonNegative(action.time), Math.max(0, state.loopEnd - 0.1)),
      });
    case "loop-end-changed":
      return freezeState({
        ...state,
        loopEnd: Math.min(
          state.duration,
          Math.max(finiteNonNegative(action.time), state.loopStart + 0.1),
        ),
      });
    case "speed-changed":
      return freezeState({ ...state, speed: action.speed });
    case "transpose-changed":
      return freezeState({ ...state, transpose: action.semitones });
    case "stage-changed":
      if (state.recordingStatus !== "idle" && action.stage !== "practice") return state as SongWorkspaceState;
      return freezeState({ ...state, stage: action.stage });
    case "pass-changed":
      return freezeState({ ...state, practicePass: action.pass });
    case "chords-changed":
      return freezeState({ ...state, chords: action.chords });
    case "phrase-note-changed":
      return freezeState({ ...state, phraseNote: action.phraseNote });
    case "marker-added":
      return state.markers.length >= action.maximum
        ? state as SongWorkspaceState
        : freezeState({ ...state, markers: Object.freeze([...state.markers, action.marker]) });
    case "recording-starting":
      return freezeState({ ...state, recordingStatus: "opening", recordError: "" });
    case "recording-started":
      return freezeState({ ...state, recordingStatus: "active" });
    case "recording-degraded":
      return freezeState({
        ...state,
        recordingStatus: "active",
        recordError: action.message,
      });
    case "recording-finalizing":
      return freezeState({ ...state, recordingStatus: "finalizing" });
    case "recording-stopped":
      return freezeState({ ...state, recordingStatus: "idle" });
    case "recording-failed":
      return freezeState({
        ...state,
        recordingStatus: "idle",
        recordError: action.message,
      });
    case "take-added":
      return freezeState({
        ...state,
        stage: "review",
        recordingStatus: "idle",
        takes: Object.freeze([action.take, ...state.takes].slice(0, action.maximum)),
      });
    case "takes-cleared":
      return freezeState({ ...state, takes: Object.freeze([]) });
  }
}
