import { useCallback, useLayoutEffect, useReducer, useRef } from "react";
import {
  useAudioInput,
  type AudioInputController,
} from "@/audio/use-audio-input";
import {
  configureToneMapVoiceAnswer,
  createToneMapVoiceAnswerState,
  observeToneMapVoiceAnswer,
  toneMapVoiceAnswerMidi,
  toneMapVoiceAnswerSnapshot,
  type ToneMapVoiceAnswerSnapshot,
  type ToneMapVoiceAnswerState,
  type ToneMapVoiceTrialContext,
} from "./tone-map-voice-answer";

export interface ToneMapVoiceAnswerController {
  readonly input: AudioInputController;
  readonly snapshot: Readonly<ToneMapVoiceAnswerSnapshot>;
  /** Reads exact current evidence at click time. It never commits by itself. */
  readonly readCommittedMidi: () => number | null;
}

function snapshotsEqual(
  left: Readonly<ToneMapVoiceAnswerSnapshot>,
  right: Readonly<ToneMapVoiceAnswerSnapshot>,
): boolean {
  return left.status === right.status && left.ready === right.ready;
}

export function useToneMapVoiceAnswer(
  context: Readonly<ToneMapVoiceTrialContext>,
): ToneMapVoiceAnswerController {
  const contextRef = useRef(context);
  contextRef.current = context;
  const stateRef = useRef<ToneMapVoiceAnswerState>(createToneMapVoiceAnswerState());
  const publishedRef = useRef<Readonly<ToneMapVoiceAnswerSnapshot>>(
    toneMapVoiceAnswerSnapshot(stateRef.current),
  );
  const [snapshot, publish] = useReducer(
    (_current: Readonly<ToneMapVoiceAnswerSnapshot>, next: Readonly<ToneMapVoiceAnswerSnapshot>) => next,
    publishedRef.current,
  );

  const update = useCallback((next: ToneMapVoiceAnswerState) => {
    if (next === stateRef.current) return;
    stateRef.current = next;
    const nextSnapshot = toneMapVoiceAnswerSnapshot(next);
    if (snapshotsEqual(publishedRef.current, nextSnapshot)) return;
    publishedRef.current = nextSnapshot;
    publish(nextSnapshot);
  }, []);

  useLayoutEffect(() => {
    update(configureToneMapVoiceAnswer(stateRef.current, context));
  }, [context, update]);

  const input = useAudioInput({
    onFrame: (observation) => {
      const configured = configureToneMapVoiceAnswer(
        stateRef.current,
        contextRef.current,
      );
      update(observeToneMapVoiceAnswer(configured, observation));
    },
  });

  const readCommittedMidi = useCallback((): number | null => {
    const configured = configureToneMapVoiceAnswer(
      stateRef.current,
      contextRef.current,
    );
    update(configured);
    if (input.state !== "running") return null;
    return toneMapVoiceAnswerMidi(configured);
  }, [input, update]);

  return { input, snapshot, readCommittedMidi };
}
