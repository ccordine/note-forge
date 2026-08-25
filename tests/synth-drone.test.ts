import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureAudioReady } = vi.hoisted(() => ({
  ensureAudioReady: vi.fn(),
}));

vi.mock("../apps/web/src/audio/audio-context", () => ({ ensureAudioReady }));

import { Drone } from "../apps/web/src/audio/synth";

interface FakeOscillator {
  onended: (() => void) | null;
  readonly frequency: FakeAudioParam;
  readonly detune: FakeAudioParam;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
}

interface FakeAudioParam {
  value: number;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
}

function fakeAudioParam(value = 1): FakeAudioParam {
  return {
    value,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(function (this: FakeAudioParam, next: number) {
      this.value = next;
    }),
    exponentialRampToValueAtTime: vi.fn(function (this: FakeAudioParam, next: number) {
      this.value = next;
    }),
    linearRampToValueAtTime: vi.fn(function (this: FakeAudioParam, next: number) {
      this.value = next;
    }),
  };
}

function fakeAudioContext() {
  const oscillators: FakeOscillator[] = [];
  const gainRamps: number[] = [];
  const context = {
    currentTime: 0,
    destination: {},
    createGain: vi.fn(() => ({
      gain: (() => {
        const parameter = fakeAudioParam();
        parameter.exponentialRampToValueAtTime = vi.fn(function (this: FakeAudioParam, value: number) {
          this.value = value;
          gainRamps.push(value);
        });
        return parameter;
      })(),
      connect: vi.fn((destination: unknown) => destination),
      disconnect: vi.fn(),
    })),
    createDynamicsCompressor: vi.fn(() => ({
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      connect: vi.fn((destination: unknown) => destination),
      disconnect: vi.fn(),
    })),
    createOscillator: vi.fn(() => {
      const oscillator = {
        type: "sine" as OscillatorType,
        frequency: fakeAudioParam(),
        detune: fakeAudioParam(0),
        connect: vi.fn((destination: unknown) => destination),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      oscillators.push(oscillator);
      return oscillator;
    }),
  };
  return { context, gainRamps, oscillators };
}

describe("Sound Lab tonic drone", () => {
  beforeEach(() => {
    ensureAudioReady.mockReset();
  });

  it("has no scheduled end and stops every oscillator only on explicit Stop", async () => {
    const audio = fakeAudioContext();
    ensureAudioReady.mockResolvedValue(audio.context);
    const drone = new Drone();

    await drone.start(220, "piano", 0.18);

    expect(audio.oscillators).toHaveLength(4);
    expect(audio.oscillators.every((oscillator) => oscillator.start.mock.calls.length === 1))
      .toBe(true);
    expect(audio.oscillators.every((oscillator) => oscillator.stop.mock.calls.length === 0))
      .toBe(true);
    expect(audio.gainRamps).toEqual([0.18]);

    audio.context.currentTime = 7_200;
    expect(audio.oscillators.every((oscillator) => oscillator.stop.mock.calls.length === 0))
      .toBe(true);

    drone.stop();
    expect(audio.oscillators.every((oscillator) => oscillator.stop.mock.calls.length === 1))
      .toBe(true);
  });

  it("updates tonic and timbre inside one still-running drone session", async () => {
    const audio = fakeAudioContext();
    ensureAudioReady.mockResolvedValue(audio.context);
    const drone = new Drone();

    await drone.start(220, "sine", 0.18);
    const originalOscillators = [...audio.oscillators];
    drone.update(261.63, "piano", 0.2);
    await drone.start(293.66, "voice", 0.16);

    expect(audio.oscillators).toEqual(originalOscillators);
    expect(audio.oscillators).toHaveLength(4);
    expect(audio.oscillators.every((oscillator) => oscillator.stop.mock.calls.length === 0))
      .toBe(true);
    expect(audio.oscillators[0]!.frequency.exponentialRampToValueAtTime)
      .toHaveBeenLastCalledWith(293.66, 0.045);

    drone.stop();
    expect(audio.oscillators.every((oscillator) => oscillator.stop.mock.calls.length === 1))
      .toBe(true);
  });

  it("stops a voice that arrives after an explicit off during async startup", async () => {
    let resolveContext!: (context: ReturnType<typeof fakeAudioContext>["context"]) => void;
    const contextReady = new Promise<ReturnType<typeof fakeAudioContext>["context"]>((resolve) => {
      resolveContext = resolve;
    });
    ensureAudioReady.mockReturnValue(contextReady);
    const audio = fakeAudioContext();
    const drone = new Drone();

    const starting = drone.start(220, "sine", 0.18);
    drone.stop();
    resolveContext(audio.context);

    await expect(starting).resolves.toBe(false);
    expect(audio.oscillators).toHaveLength(4);
    expect(audio.oscillators.every((oscillator) => oscillator.start.mock.calls.length === 1))
      .toBe(true);
    expect(audio.oscillators.every((oscillator) => oscillator.stop.mock.calls.length === 1))
      .toBe(true);
  });

  it("cannot regress to a long scheduled tone masquerading as an indefinite drone", () => {
    const source = readFileSync(
      new URL("../apps/web/src/audio/synth.ts", import.meta.url),
      "utf8",
    );
    const sustainedStart = source.indexOf("async function playUserOwnedSustainedTone");
    const droneEnd = source.indexOf("export async function playPitchContour", sustainedStart);
    const implementation = source.slice(sustainedStart, droneEnd);

    expect(sustainedStart).toBeGreaterThan(0);
    expect(implementation).not.toMatch(/playTone\s*\(|duration\s*:|3_600|setTimeout/);
    expect(implementation).toContain("oscillator.start(startAt)");
    expect(implementation).toContain("this.voice?.stop(0.09)");
    expect(implementation).not.toMatch(/async start[\s\S]{0,300}this\.stop\s*\(/);
  });

  it("keeps settings updates out of the React-owned Stop lifetime", () => {
    const source = readFileSync(
      new URL("../apps/web/src/features/sound-lab/SoundLab.tsx", import.meta.url),
      "utf8",
    );
    const updateEffect = source.slice(
      source.indexOf("if (droneEnabled) {"),
      source.indexOf("const toggleDrone"),
    );

    expect(updateEffect).toContain("drone.current.update");
    expect(updateEffect).not.toContain("drone.current.stop");
    expect(source).toContain("onClick={toggleDrone}");
  });
});
