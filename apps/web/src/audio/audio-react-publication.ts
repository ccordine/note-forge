export const AUDIO_REACT_MAXIMUM_PRESENTATION_HZ = 30;

export interface AudioPresentationScheduler {
  readonly request: (callback: (timestampMs: number) => void) => number;
  readonly cancel: (handle: number) => void;
  readonly now: () => number;
}

export interface AudioReactPublisher {
  readonly publishPitch: () => void;
  readonly publishAuxiliary: () => void;
}

const browserScheduler: AudioPresentationScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
  now: () => performance.now(),
};

/**
 * Coalesces ordinary external-store publication without delaying categorical
 * pitch transitions. Immediate pitch publication does not reset the shared
 * stable clock, so changed notes cannot starve counters or telemetry.
 */
export class AudioReactPublication {
  private readonly minimumIntervalMs = 1_000 / AUDIO_REACT_MAXIMUM_PRESENTATION_HZ;
  private scheduledHandle: number | null = null;
  private pitchPending = false;
  private auxiliaryPending = false;
  private lastPitchPublicationMs: number;
  private lastStablePublicationMs: number;

  constructor(
    private readonly publisher: AudioReactPublisher,
    private readonly scheduler: AudioPresentationScheduler = browserScheduler,
  ) {
    const initialTime = scheduler.now() - this.minimumIntervalMs;
    this.lastPitchPublicationMs = initialTime;
    this.lastStablePublicationMs = initialTime;
  }

  schedulePitch(): void {
    this.pitchPending = true;
    this.reconcileSchedule();
  }

  scheduleAuxiliary(): void {
    this.auxiliaryPending = true;
    this.reconcileSchedule();
  }

  publishPitchTransition(): void {
    this.pitchPending = false;
    this.lastPitchPublicationMs = this.scheduler.now();
    this.publisher.publishPitch();
    this.reconcileSchedule();
  }

  reset(): void {
    if (this.scheduledHandle !== null) {
      this.scheduler.cancel(this.scheduledHandle);
      this.scheduledHandle = null;
    }
    this.pitchPending = false;
    this.auxiliaryPending = false;
    const resetAt = this.scheduler.now();
    this.lastPitchPublicationMs = resetAt;
    this.lastStablePublicationMs = resetAt;
  }

  private readonly present = (timestampMs: number): void => {
    this.scheduledHandle = null;
    if (timestampMs - this.lastStablePublicationMs >= this.minimumIntervalMs) {
      let published = false;
      if (
        this.pitchPending
        && timestampMs - this.lastPitchPublicationMs >= this.minimumIntervalMs
      ) {
        this.pitchPending = false;
        this.lastPitchPublicationMs = timestampMs;
        this.publisher.publishPitch();
        published = true;
      }
      if (this.auxiliaryPending) {
        this.auxiliaryPending = false;
        this.publisher.publishAuxiliary();
        published = true;
      }
      if (published) this.lastStablePublicationMs = timestampMs;
    }
    this.reconcileSchedule();
  };

  private reconcileSchedule(): void {
    const pending = this.pitchPending || this.auxiliaryPending;
    if (!pending) {
      if (this.scheduledHandle !== null) {
        this.scheduler.cancel(this.scheduledHandle);
        this.scheduledHandle = null;
      }
      return;
    }
    if (this.scheduledHandle === null) {
      this.scheduledHandle = this.scheduler.request(this.present);
    }
  }
}
