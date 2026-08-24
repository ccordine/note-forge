import { useCallback, useEffect, useRef } from "react";
import type { ActiveVoice } from "@/audio/synth";

export const BRIEF_REFERENCE_SECONDS = 0.5;
export const BRIEF_COMPARISON_SECONDS = 0.42;

export async function attachVoiceToScope(
  signal: AbortSignal,
  start: (signal: AbortSignal) => Promise<ActiveVoice>,
): Promise<void> {
  const voice = await start(signal);
  if (signal.aborted) {
    voice.stop(0);
    return;
  }
  signal.addEventListener("abort", () => voice.stop(0.03), { once: true });
}

export interface SessionEffectScope {
  /** End the previous scope and establish one authority for the next attempt. */
  readonly restart: () => AbortSignal;
  /** End the current attempt and every asynchronous effect attached to it. */
  readonly abort: () => void;
  /** Play one explicit reference; replay atomically replaces the prior reference. */
  readonly playReference: (
    label: string,
    start: (signal: AbortSignal) => Promise<ActiveVoice>,
  ) => void;
}

export function useSessionEffectScope(): SessionEffectScope {
  const controllerRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const restart = useCallback(() => {
    abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller.signal;
  }, [abort]);

  const playReference = useCallback((
    label: string,
    start: (signal: AbortSignal) => Promise<ActiveVoice>,
  ) => {
    const signal = restart();
    void attachVoiceToScope(signal, start).catch((error) => {
      if (!signal.aborted) console.error(`${label} failed.`, error);
    });
  }, [restart]);

  useEffect(() => abort, [abort]);

  return { restart, abort, playReference };
}
