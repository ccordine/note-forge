import { useCallback, useEffect, useRef } from "react";
import type { PitchObservation } from "@/audio/note-input";
import type { ActiveVoice } from "@/audio/synth";
import { useRealtimeSession } from "@/realtime/use-realtime-session";
import {
  createIdleAttemptRunner,
  reduceAttemptRunner,
  type AttemptRunnerState,
  type CompletedAttempt,
} from "./attempt-runner";
import { useSessionEffectScope } from "./use-session-effect-scope";

export interface AttemptRunnerOptions<Configuration> {
  readonly onComplete: (
    attempt: Readonly<CompletedAttempt<Configuration>>,
    signal: AbortSignal,
  ) => void | Promise<void>;
  readonly onCompletionError?: (error: unknown) => void;
}

export interface AttemptRunner<Configuration> {
  readonly state: Readonly<AttemptRunnerState<Configuration>>;
  readonly observe: (observation: Readonly<PitchObservation>) => void;
  readonly begin: (configuration: Readonly<Configuration>, durationSeconds: number) => void;
  readonly finish: () => void;
  readonly reset: () => void;
  readonly playReference: (
    label: string,
    start: (signal: AbortSignal) => Promise<ActiveVoice>,
  ) => void;
}

export function useAttemptRunner<Configuration>(
  options: Readonly<AttemptRunnerOptions<Configuration>>,
): AttemptRunner<Configuration> {
  const completionRef = useRef(options.onComplete);
  const completionErrorRef = useRef(options.onCompletionError);
  completionRef.current = options.onComplete;
  completionErrorRef.current = options.onCompletionError;
  const effects = useSessionEffectScope();
  const session = useRealtimeSession(
    reduceAttemptRunner<Configuration>,
    createIdleAttemptRunner<Configuration>,
  );
  const state = session.state;

  useEffect(() => {
    if (state.status !== "complete") return;
    const signal = effects.restart();
    let completion: void | Promise<void>;
    try {
      completion = completionRef.current(state, signal);
    } catch (error) {
      if (!signal.aborted) completionErrorRef.current?.(error);
      return;
    }
    void Promise.resolve(completion).catch((error) => {
      if (!signal.aborted) completionErrorRef.current?.(error);
    });
  }, [effects.restart, state]);

  const observe = useCallback((observation: Readonly<PitchObservation>) => {
    session.observe({ type: "observation", observation });
  }, [session.observe]);

  const begin = useCallback((
    configuration: Readonly<Configuration>,
    durationSeconds: number,
  ) => {
    effects.restart();
    session.dispatch({
      type: "begin",
      configuration,
      durationSeconds,
      startedAt: new Date().toISOString(),
    });
  }, [effects.restart, session.dispatch]);

  const finish = useCallback(() => session.dispatch({ type: "finish" }), [session.dispatch]);
  const reset = useCallback(() => {
    effects.abort();
    session.dispatch({ type: "reset" });
  }, [effects.abort, session.dispatch]);

  return {
    state,
    observe,
    begin,
    finish,
    reset,
    playReference: effects.playReference,
  };
}
