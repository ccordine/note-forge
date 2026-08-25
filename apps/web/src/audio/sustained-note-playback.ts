import { Drone, SYNTH_LIMITS, TIMBRES, type Timbre } from "./synth";

export type SustainedNotePlaybackStatus = "off" | "starting" | "on" | "error";
export type SustainedNoteOwner = symbol;

/**
 * One isolated pitch requested by a visible user-owned toggle.
 *
 * There is deliberately no duration, deadline, schedule time, or envelope
 * lifetime here. The lane sounds until its current owner turns it off or the
 * owning surface unmounts.
 */
export interface SustainedNoteSpec {
  readonly frequencyHz: number;
  readonly timbre: Timbre;
  readonly amplitude: number;
}

export interface SustainedNotePlaybackSnapshot {
  readonly status: SustainedNotePlaybackStatus;
  readonly owner: SustainedNoteOwner | null;
  readonly spec: Readonly<SustainedNoteSpec> | null;
  readonly error: string;
}

export interface SustainedNoteLane {
  readonly start: (spec: Readonly<SustainedNoteSpec>) => Promise<boolean>;
  readonly update: (spec: Readonly<SustainedNoteSpec>) => void;
  readonly stop: () => void;
}

function createSynthLane(): SustainedNoteLane {
  const voice = new Drone();
  return {
    start: ({ frequencyHz, timbre, amplitude }) => voice.start(frequencyHz, timbre, amplitude),
    update: ({ frequencyHz, timbre, amplitude }) => voice.update(frequencyHz, timbre, amplitude),
    stop: () => voice.stop(),
  };
}

function playbackError(error: unknown): string {
  return error instanceof Error ? error.message : "The note could not start.";
}

function freezeSpec(spec: Readonly<SustainedNoteSpec>): Readonly<SustainedNoteSpec> {
  if (
    !Number.isFinite(spec.frequencyHz)
    || spec.frequencyHz < SYNTH_LIMITS.minimumFrequencyHz
    || spec.frequencyHz > SYNTH_LIMITS.maximumFrequencyHz
  ) {
    throw new RangeError(
      `Note frequency must be from ${SYNTH_LIMITS.minimumFrequencyHz} through ${SYNTH_LIMITS.maximumFrequencyHz} Hz.`,
    );
  }
  if (
    !Number.isFinite(spec.amplitude)
    || spec.amplitude <= 0
    || spec.amplitude > SYNTH_LIMITS.maximumAmplitude
  ) {
    throw new RangeError(
      `Note amplitude must be greater than 0 and no greater than ${SYNTH_LIMITS.maximumAmplitude}.`,
    );
  }
  if (!(TIMBRES as readonly string[]).includes(spec.timbre)) {
    throw new RangeError(`Unsupported note timbre: ${String(spec.timbre)}.`);
  }
  return Object.freeze({
    frequencyHz: spec.frequencyHz,
    timbre: spec.timbre,
    amplitude: spec.amplitude,
  });
}

function sameSpec(
  left: Readonly<SustainedNoteSpec> | null,
  right: Readonly<SustainedNoteSpec>,
): boolean {
  return left?.frequencyHz === right.frequencyHz
    && left.timbre === right.timbre
    && left.amplitude === right.amplitude;
}

const OFF_SNAPSHOT: Readonly<SustainedNotePlaybackSnapshot> = Object.freeze({
  status: "off",
  owner: null,
  spec: null,
  error: "",
});

/**
 * App-lifetime authority for the one isolated-note playback lane.
 *
 * Feature/session state never owns the oscillator. A different visible owner
 * may take the lane by retuning the existing voice; only the current owner may
 * turn it off. Async starts are generation-checked so an old completion cannot
 * resurrect playback after Off.
 */
export class SustainedNotePlaybackStore {
  private readonly lane: SustainedNoteLane;
  private readonly listeners = new Set<() => void>();
  private snapshot: Readonly<SustainedNotePlaybackSnapshot> = OFF_SNAPSHOT;
  private generation = 0;

  constructor(lane: SustainedNoteLane = createSynthLane()) {
    this.lane = lane;
  }

  readonly getSnapshot = (): Readonly<SustainedNotePlaybackSnapshot> => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  toggle(owner: SustainedNoteOwner, requestedSpec: Readonly<SustainedNoteSpec>): void {
    if (
      this.snapshot.owner === owner
      && (this.snapshot.status === "starting" || this.snapshot.status === "on")
    ) {
      this.release(owner);
      return;
    }

    let spec: Readonly<SustainedNoteSpec>;
    try {
      spec = freezeSpec(requestedSpec);
    } catch (error) {
      this.fail(owner, requestedSpec, error);
      return;
    }

    if (this.snapshot.status === "starting" || this.snapshot.status === "on") {
      try {
        this.lane.update(spec);
      } catch (error) {
        this.fail(owner, spec, error);
        return;
      }
      this.publish(Object.freeze({
        status: this.snapshot.status,
        owner,
        spec,
        error: "",
      }));
      return;
    }

    this.start(owner, spec);
  }

  update(owner: SustainedNoteOwner, requestedSpec: Readonly<SustainedNoteSpec>): void {
    if (
      this.snapshot.owner !== owner
      || (this.snapshot.status !== "starting" && this.snapshot.status !== "on")
    ) return;

    let spec: Readonly<SustainedNoteSpec>;
    try {
      spec = freezeSpec(requestedSpec);
      if (sameSpec(this.snapshot.spec, spec)) return;
      this.lane.update(spec);
    } catch (error) {
      this.fail(owner, requestedSpec, error);
      return;
    }
    this.publish(Object.freeze({ ...this.snapshot, spec, error: "" }));
  }

  release(owner: SustainedNoteOwner): void {
    if (this.snapshot.owner !== owner) return;
    this.generation += 1;
    this.lane.stop();
    this.publish(OFF_SNAPSHOT);
  }

  dispose(): void {
    this.generation += 1;
    this.lane.stop();
    this.publish(OFF_SNAPSHOT);
  }

  private start(owner: SustainedNoteOwner, spec: Readonly<SustainedNoteSpec>): void {
    this.generation += 1;
    const generation = this.generation;
    if (this.snapshot.status === "error") this.lane.stop();
    this.publish(Object.freeze({ status: "starting", owner, spec, error: "" }));
    void this.lane.start(spec).then((started) => {
      if (
        generation !== this.generation
        || this.snapshot.status !== "starting"
      ) return;
      if (!started) {
        this.fail(this.snapshot.owner ?? owner, this.snapshot.spec ?? spec, new Error("The note did not start."));
        return;
      }
      this.publish(Object.freeze({ ...this.snapshot, status: "on", error: "" }));
    }).catch((error) => {
      if (generation !== this.generation || this.snapshot.status !== "starting") return;
      this.fail(this.snapshot.owner ?? owner, this.snapshot.spec ?? spec, error);
    });
  }

  private fail(
    owner: SustainedNoteOwner,
    requestedSpec: Readonly<SustainedNoteSpec>,
    error: unknown,
  ): void {
    this.generation += 1;
    this.lane.stop();
    const spec = (() => {
      try {
        return freezeSpec(requestedSpec);
      } catch {
        return null;
      }
    })();
    this.publish(Object.freeze({
      status: "error",
      owner,
      spec,
      error: playbackError(error),
    }));
  }

  private publish(snapshot: Readonly<SustainedNotePlaybackSnapshot>): void {
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

export const sustainedNotePlayback = new SustainedNotePlaybackStore();
