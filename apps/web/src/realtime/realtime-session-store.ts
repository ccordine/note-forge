export type RealtimeReducer<State, Action> = (
  state: Readonly<State>,
  action: Readonly<Action>,
) => State;

export interface PresentationScheduler {
  readonly request: (callback: (timestampMs: number) => void) => number;
  readonly cancel: (handle: number) => void;
  readonly now: () => number;
}

export interface RealtimePresentationPolicy<State, Action> {
  /** Semantic transitions that must reach presentation on their exact reduced action. */
  readonly shouldPublishImmediately?: (
    previous: Readonly<State>,
    next: Readonly<State>,
    action: Readonly<Action>,
  ) => boolean;
}

const browserScheduler: PresentationScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
  now: () => performance.now(),
};

type Listener = () => void;

/**
 * Realtime sensor reducer with separate processing and presentation clocks.
 *
 * `observe` reduces every sensor action immediately and never drops evidence.
 * Its latest authoritative state remains readable synchronously. React-facing
 * subscribers receive a coalesced immutable snapshot at a bounded frame rate.
 * User commands use `dispatch`, which publishes immediately.
 */
export class RealtimeSessionStore<State, Action> {
  private current: State;
  private published: State;
  private readonly listeners = new Set<Listener>();
  private scheduledHandle: number | null = null;
  private lastPublishedAtMs: number;
  private readonly minimumPresentationIntervalMs: number;

  constructor(
    private readonly reducer: RealtimeReducer<State, Action>,
    initialState: State,
    maximumPresentationHz = 30,
    private readonly scheduler: PresentationScheduler = browserScheduler,
    private readonly presentationPolicy: RealtimePresentationPolicy<State, Action> = {},
  ) {
    if (!Number.isFinite(maximumPresentationHz) || maximumPresentationHz <= 0 || maximumPresentationHz > 120) {
      throw new RangeError("maximumPresentationHz must be between 0 and 120.");
    }
    this.current = initialState;
    this.published = initialState;
    this.minimumPresentationIntervalMs = 1_000 / maximumPresentationHz;
    this.lastPublishedAtMs = scheduler.now() - this.minimumPresentationIntervalMs;
  }

  readonly getSnapshot = (): State => this.published;

  /** Latest fully reduced sensor state; intended for imperative game loops. */
  readonly getCurrent = (): State => this.current;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A user/system command changes and publishes state synchronously. */
  readonly dispatch = (action: Readonly<Action>): void => {
    const next = this.reducer(this.current, action);
    if (next === this.current) return;
    this.current = next;
    this.cancelPending();
    this.publish(this.scheduler.now());
  };

  /** A realtime sensor action is fully reduced now and presented later. */
  readonly observe = (action: Readonly<Action>): void => {
    const previous = this.current;
    const next = this.reducer(previous, action);
    if (next === previous) return;
    this.current = next;
    if (this.presentationPolicy.shouldPublishImmediately?.(previous, next, action)) {
      this.cancelPending();
      this.publish(this.scheduler.now());
      return;
    }
    this.schedulePresentation();
  };

  /**
   * Publishes the latest fully reduced state at an explicit presentation
   * boundary. This is not a sensor or session transition: it only prevents a
   * pre-boundary observation that was already reduced from appearing later as
   * though it occurred after the user's command.
   */
  readonly flushPresentation = (): void => {
    this.cancelPending();
    this.publish(this.scheduler.now());
  };

  /** Cancels presentation work only; authoritative state is preserved. */
  cancelPending(): void {
    if (this.scheduledHandle === null) return;
    this.scheduler.cancel(this.scheduledHandle);
    this.scheduledHandle = null;
  }

  private schedulePresentation(): void {
    if (this.scheduledHandle !== null) return;
    this.scheduledHandle = this.scheduler.request(this.present);
  }

  private readonly present = (timestampMs: number): void => {
    this.scheduledHandle = null;
    if (this.published === this.current) return;
    if (timestampMs - this.lastPublishedAtMs < this.minimumPresentationIntervalMs) {
      this.schedulePresentation();
      return;
    }
    this.publish(timestampMs);
  };

  private publish(timestampMs: number): void {
    if (this.published === this.current) return;
    this.published = this.current;
    this.lastPublishedAtMs = timestampMs;
    for (const listener of this.listeners) listener();
  }
}
