import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  RealtimeSessionStore,
  type RealtimePresentationPolicy,
  type RealtimeReducer,
} from "./realtime-session-store";

export interface RealtimeSession<State, Action> {
  readonly state: State;
  readonly dispatch: (action: Readonly<Action>) => void;
  readonly observe: (action: Readonly<Action>) => void;
  readonly getCurrent: () => State;
}

/**
 * Creates one external session store for a mounted game. The detector calls
 * `observe`; controls call `dispatch`; React reads only the bounded snapshot.
 */
export function useRealtimeSession<State, Action>(
  reducer: RealtimeReducer<State, Action>,
  createInitialState: () => State,
  maximumPresentationHz = 30,
  presentationPolicy: RealtimePresentationPolicy<State, Action> = {},
): RealtimeSession<State, Action> {
  const storeRef = useRef<RealtimeSessionStore<State, Action> | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new RealtimeSessionStore(
      reducer,
      createInitialState(),
      maximumPresentationHz,
      undefined,
      presentationPolicy,
    );
  }
  const store = storeRef.current;
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  useEffect(() => () => store.cancelPending(), [store]);
  return {
    state,
    dispatch: store.dispatch,
    observe: store.observe,
    getCurrent: store.getCurrent,
  };
}
