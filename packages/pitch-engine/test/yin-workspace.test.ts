import { describe, expect, it } from "vitest";

import {
  detectPitch,
  midiToFrequency,
  YinDetector,
  type YinOptions,
} from "../src";
import { YinScratchWorkspace } from "../src/yin-workspace";
import { generateSyntheticSignal } from "./synthetic-signals";

const SAMPLE_RATE = 48_000;
const LIVE_OPTIONS = Object.freeze({
  sampleRate: SAMPLE_RATE,
  minFrequency: 45,
  maxFrequency: 1_200,
  currentEdgeSpanSamples: 960,
});

function harmonicWindow(
  midi: number,
  sampleCount = 4_096,
  sampleRate = SAMPLE_RATE,
): Float32Array {
  return generateSyntheticSignal({
    sampleRate,
    durationSeconds: sampleCount / sampleRate,
    frequencyHz: midiToFrequency(midi),
    amplitude: 0.18,
    harmonics: [
      { multiple: 2, amplitude: 0.47, phaseRadians: 0.37 },
      { multiple: 3, amplitude: 0.23, phaseRadians: 1.13 },
      { multiple: 4, amplitude: 0.11, phaseRadians: 0.71 },
    ],
  });
}

describe("instance-owned YIN scratch", () => {
  it("is exactly equivalent to the allocating one-shot API", () => {
    const detector = new YinDetector();
    const noise = harmonicWindow(60);
    for (let index = 0; index < noise.length; index += 1) {
      noise[index] += 0.08 * Math.sin(index * 12.9898) % 0.08;
    }
    const fixtures = [
      harmonicWindow(48),
      harmonicWindow(86),
      noise,
      new Float32Array(4_096),
      harmonicWindow(30),
    ];

    for (const [index, samples] of fixtures.entries()) {
      const options = { ...LIVE_OPTIONS, timeSeconds: index * 0.02 };
      expect(detector.detectPitch(samples, options)).toEqual(
        detectPitch(samples, options),
      );
    }
  });

  it("keeps two interleaved detector instances independent", () => {
    const first = new YinDetector();
    const second = new YinDetector();
    const fixtures = [
      { samples: harmonicWindow(30), options: LIVE_OPTIONS },
      {
        samples: harmonicWindow(78, 3_072),
        options: { ...LIVE_OPTIONS, minFrequency: 180 },
      },
      { samples: harmonicWindow(48, 8_192), options: LIVE_OPTIONS },
    ] as const;

    const firstResults = [
      first.detectPitch(fixtures[0].samples, fixtures[0].options),
      first.detectPitch(fixtures[1].samples, fixtures[1].options),
      first.detectPitch(fixtures[2].samples, fixtures[2].options),
    ];
    const secondResults = [
      second.detectPitch(fixtures[2].samples, fixtures[2].options),
      second.detectPitch(fixtures[0].samples, fixtures[0].options),
      second.detectPitch(fixtures[1].samples, fixtures[1].options),
    ];

    expect(firstResults).toEqual(fixtures.map(({ samples, options }) =>
      detectPitch(samples, options)));
    expect(secondResults).toEqual([fixtures[2], fixtures[0], fixtures[1]].map(
      ({ samples, options }) => detectPitch(samples, options),
    ));
  });

  it("ignores stale capacity slots across long-short-long and grow-shrink reuse", () => {
    const detector = new YinDetector();
    const sequence = [
      {
        samples: harmonicWindow(48, 8_192),
        options: { ...LIVE_OPTIONS, minFrequency: 45 },
      },
      {
        samples: harmonicWindow(78, 3_072),
        options: { ...LIVE_OPTIONS, minFrequency: 180 },
      },
      {
        samples: harmonicWindow(55, 4_096),
        options: { ...LIVE_OPTIONS, minFrequency: 80 },
      },
      {
        samples: harmonicWindow(48, 8_192),
        options: { ...LIVE_OPTIONS, minFrequency: 45 },
      },
    ];

    const reused = sequence.map(({ samples, options }) =>
      detector.detectPitch(samples, options));
    const fresh = sequence.map(({ samples, options }) =>
      detectPitch(samples, options));

    expect(reused).toEqual(fresh);
    expect(reused.map((frame) => frame.nearestMidi)).toEqual([48, 78, 55, 48]);
  });

  it("never pools or mutates retained result evidence", () => {
    const detector = new YinDetector();
    const retained = detector.detectPitch(harmonicWindow(48), LIVE_OPTIONS);
    const snapshot = { ...retained };
    const changed = detector.detectPitch(harmonicWindow(55), LIVE_OPTIONS);

    expect(changed).not.toBe(retained);
    expect(retained).toEqual(snapshot);
    expect(retained.nearestMidi).toBe(48);
    expect(changed.nearestMidi).toBe(55);
  });

  it("releases its guard after invalid and reentrant calls", () => {
    const detector = new YinDetector();
    const samples = harmonicWindow(48);

    expect(() => detector.detectPitch(samples, {
      ...LIVE_OPTIONS,
      minFrequency: 500,
      maxFrequency: 100,
    })).toThrow(/minFrequency/);

    const reentrantOptions = {
      get sampleRate(): number {
        detector.detectPitch(samples, LIVE_OPTIONS);
        return SAMPLE_RATE;
      },
    } satisfies YinOptions;
    expect(() => detector.detectPitch(samples, reentrantOptions))
      .toThrow(/reentrantly/);
    expect(detector.detectPitch(samples, LIVE_OPTIONS)).toEqual(
      detectPitch(samples, LIVE_OPTIONS),
    );
  });
});

describe("YIN scratch allocation instrumentation", () => {
  it("allocates only when a private typed workspace must grow", () => {
    const workspace = new YinScratchWorkspace();
    expect(workspace.typedArrayAllocationCount).toBe(0);

    workspace.prepareLagBuffers(100);
    expect(workspace.typedArrayAllocationCount).toBe(2);
    workspace.prepareLagBuffers(100);
    workspace.prepareLagBuffers(40);
    expect(workspace.typedArrayAllocationCount).toBe(2);
    workspace.prepareLagBuffers(101);
    expect(workspace.typedArrayAllocationCount).toBe(4);

    workspace.hannWindow(4_096);
    workspace.hannWindow(4_096);
    workspace.hannWindow(1_024);
    workspace.hannWindow(4_096);
    expect(workspace.typedArrayAllocationCount).toBe(5);

    workspace.harmonicScores(65);
    workspace.harmonicScores(19);
    expect(workspace.typedArrayAllocationCount).toBe(6);
    workspace.harmonicScores(66);
    expect(workspace.typedArrayAllocationCount).toBe(7);
  });
});
