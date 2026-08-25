import { useCallback, useEffect, useRef } from "react";
import type { ActiveVoice } from "@/audio/synth";

export const BRIEF_COMPARISON_SECONDS = 0.42;

export async function attachVoiceToScope(
  signal: AbortSignal,
  start: (signal: AbortSignal) => Promise<ActiveVoice>,
): Promise<ActiveVoice | null> {
  const voice = await start(signal);
  if (signal.aborted) {
    voice.stop(0);
    return null;
  }
  signal.addEventListener("abort", () => voice.stop(0.03), { once: true });
  return voice;
}

export interface SessionEffectScope {
  /** End the previous scope and establish one authority for the next attempt. */
  readonly restart: () => AbortSignal;
  /** End the current attempt and every asynchronous effect attached to it. */
  readonly abort: () => void;
  /** Play one authored time-domain gesture; replay replaces the prior gesture. */
  readonly playGesture: (
    label: string,
    start: (signal: AbortSignal) => Promise<ActiveVoice>,
  ) => Promise<boolean>;
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

  const playGesture = useCallback(async (
    label: string,
    start: (signal: AbortSignal) => Promise<ActiveVoice>,
  ) => {
    const signal = restart();
    try {
      const voice = await attachVoiceToScope(signal, start);
      if (voice?.finished === undefined) return false;
      await voice.finished;
      return !signal.aborted;
    } catch (error) {
      if (!signal.aborted) console.error(`${label} failed.`, error);
      return false;
    }
  }, [restart]);

  useEffect(() => abort, [abort]);

  return { restart, abort, playGesture };
}
