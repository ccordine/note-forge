import type { PitchObservation } from "@/audio/note-input";
import {
  RealtimeSessionStore,
  type PresentationScheduler,
} from "@/realtime/realtime-session-store";
import { getDifficultyPreset } from "./model";
import {
  createPitchPongState,
  reducePitchPongState,
  type PitchPongAction,
  type PitchPongSpec,
  type PitchPongState,
} from "./pitch-pong-session";
import type { ArcadeOutcome } from "./types";

export interface PongDelayClock {
  readonly set: (callback: () => void, delayMs: number) => number;
  readonly clear: (handle: number) => void;
}

export interface PitchPongRuntimeOptions {
  readonly maximumPresentationHz?: number;
  readonly presentationScheduler?: PresentationScheduler;
  readonly delayClock?: PongDelayClock;
}

const COUNTDOWN_STEP_MS = 650;
const browserDelayClock: PongDelayClock = {
  set: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clear: (handle) => window.clearTimeout(handle),
};

function abortableDelay(
  clock: PongDelayClock,
  signal: AbortSignal,
  delayMs: number,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (completed: boolean) => {
      clock.clear(handle);
      signal.removeEventListener("abort", abort);
      resolve(completed);
    };
    const abort = () => settle(false);
    const handle = clock.set(() => settle(true), delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One authoritative sample-timed Pong runtime; React only sees bounded snapshots. */
export class PitchPongRuntime {
  private readonly store: RealtimeSessionStore<PitchPongState, PitchPongAction>;
  private readonly delayClock: PongDelayClock;
  private activeScope: AbortController | null = null;
  private lastReportedRound = 0;
  private disposed = false;

  constructor(
    spec: PitchPongSpec,
    private readonly onComplete: (outcome: ArcadeOutcome) => void,
    options: Readonly<PitchPongRuntimeOptions> = {},
  ) {
    this.delayClock = options.delayClock ?? browserDelayClock;
    this.store = new RealtimeSessionStore(
      reducePitchPongState,
      createPitchPongState(spec),
      options.maximumPresentationHz ?? 30,
      options.presentationScheduler,
    );
  }

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);
  readonly getSnapshot = (): PitchPongState => this.store.getSnapshot();
  readonly getCurrent = (): PitchPongState => this.store.getCurrent();

  readonly observe = (observation: Readonly<PitchObservation>): void => {
    if (this.disposed) return;
    this.store.observe({ type: "observation", observation });
    this.reportCompletion();
  };

  readonly start = (): void => {
    if (this.disposed || this.store.getCurrent().phase !== "setup") return;
    const signal = this.replaceScope();
    this.store.dispatch({ type: "start" });
    void this.runCountdown(signal);
  };

  readonly cancel = (): void => {
    this.abortActive();
    this.store.dispatch({ type: "cancel" });
  };

  readonly pause = (message = "Match paused. Your paddle and ball are frozen."): void => {
    if (this.store.getCurrent().phase !== "playing") return;
    this.abortActive();
    this.store.dispatch({ type: "pause", message });
  };

  readonly resume = (): void => {
    if (this.store.getCurrent().phase !== "paused") return;
    this.replaceScope();
    this.store.dispatch({ type: "resume" });
  };

  readonly finish = (): void => {
    this.abortActive();
    this.store.dispatch({
      type: "finish",
      message: "Round ended safely. Here is the control you demonstrated so far.",
    });
    this.reportCompletion();
  };

  readonly reset = (): void => {
    this.abortActive();
    this.store.dispatch({ type: "reset" });
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortActive();
    this.store.cancelPending();
  }

  private replaceScope(): AbortSignal {
    this.abortActive();
    this.activeScope = new AbortController();
    return this.activeScope.signal;
  }

  private abortActive(): void {
    this.activeScope?.abort();
    this.activeScope = null;
  }

  private async runCountdown(signal: AbortSignal): Promise<void> {
    for (const remaining of [2, 1, 0]) {
      if (!await abortableDelay(this.delayClock, signal, COUNTDOWN_STEP_MS)) return;
      if (this.disposed || signal.aborted) return;
      this.store.dispatch({ type: "countdown", remaining });
    }
  }

  private reportCompletion(): void {
    const state = this.store.getCurrent();
    if (state.phase !== "result" || state.result === null || state.roundNumber <= this.lastReportedRound) return;
    this.abortActive();
    this.lastReportedRound = state.roundNumber;
    const result = state.result;
    const preset = getDifficultyPreset(state.spec.difficulty);
    this.onComplete({
      mode: "pong",
      curriculumStage: state.spec.curriculumStage,
      variant: "continuous-axis",
      score: result.scorePercent,
      grade: result.grade,
      xp: Math.round(result.scorePercent * preset.scoreMultiplier),
      accuracy: result.returnRatePercent,
      bestCombo: result.maximumRally,
      durationMs: Math.round(result.durationSeconds * 1_000),
      details: {
        playerScore: result.playerScore,
        opponentScore: result.opponentScore,
        playerReturns: result.playerReturns,
        incomingShots: result.incomingShots,
        matchSharePercent: result.matchSharePercent,
        rangeCoveragePercent: result.rangeCoveragePercent,
        reliableFrames: state.stats.reliableFrames,
        voicedControlSeconds: state.stats.voicedControlSeconds,
      },
    });
  }
}
