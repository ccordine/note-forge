import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import {
  sustainedNotePlayback,
  type SustainedNotePlaybackStatus,
  type SustainedNotePlaybackStore,
  type SustainedNoteSpec,
} from "./sustained-note-playback";

const SustainedNotePlaybackContext = createContext<SustainedNotePlaybackStore | null>(null);

export function SustainedNotePlaybackProvider({
  children,
  store = sustainedNotePlayback,
}: PropsWithChildren<{ readonly store?: SustainedNotePlaybackStore }>) {
  return createElement(SustainedNotePlaybackContext.Provider, { value: store }, children);
}

export interface SustainedNoteControl {
  readonly status: SustainedNotePlaybackStatus;
  readonly playing: boolean;
  readonly error: string;
  readonly toggle: () => void;
}

/**
 * Bind one stable feature owner to the app-owned isolated-note lane.
 * Keep this hook at the feature root so presentation-stage swaps do not
 * impersonate the user's Off command.
 */
export function useSustainedNote(
  requestedSpec: Readonly<SustainedNoteSpec>,
): Readonly<SustainedNoteControl> {
  const store = useContext(SustainedNotePlaybackContext);
  if (store === null) {
    throw new Error("useSustainedNote must be used inside SustainedNotePlaybackProvider");
  }
  const owner = useMemo(() => Symbol("NoteForge sustained note owner"), []);
  const spec = useMemo<Readonly<SustainedNoteSpec>>(() => Object.freeze({
    frequencyHz: requestedSpec.frequencyHz,
    timbre: requestedSpec.timbre,
    amplitude: requestedSpec.amplitude,
  }), [requestedSpec.amplitude, requestedSpec.frequencyHz, requestedSpec.timbre]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const ownedStatus = snapshot.owner === owner ? snapshot.status : "off";
  const playing = ownedStatus === "starting" || ownedStatus === "on";
  const error = snapshot.owner === owner ? snapshot.error : "";

  useEffect(() => {
    store.update(owner, spec);
  }, [owner, spec, store]);

  useEffect(() => () => store.release(owner), [owner, store]);

  const toggle = useCallback(() => store.toggle(owner, spec), [owner, spec, store]);
  return useMemo(() => Object.freeze({
    status: ownedStatus,
    playing,
    error,
    toggle,
  }), [error, ownedStatus, playing, toggle]);
}
