import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AudioInputController } from "../apps/web/src/audio/use-audio-input";
import type { SustainedNoteControl } from "../apps/web/src/audio/use-sustained-note";
import { ToneMapSingleTrial } from "../apps/web/src/features/ear-training/ToneMapSingleTrial";
import { createToneMapCourse, type ToneMapTask } from "../apps/web/src/features/ear-training/tone-map-model";

const playback: SustainedNoteControl = {
  status: "off",
  playing: false,
  error: "",
  toggle: () => undefined,
};

function inputController(): AudioInputController {
  const subscribe = () => () => undefined;
  const controller = {
    state: "running" as const,
    error: "",
    microphoneInfo: null,
    liveFrame: undefined,
    liveNote: null,
    processedWindowCount: 0,
    processedSampleCount: 0,
    workletProcessCount: 0,
    captureEpoch: 0,
    continuityEpoch: 0,
    graphGeneration: 0,
    transportRepairCount: 0,
    telemetry: null,
    enable: async () => null,
    disable: () => undefined,
    createRecorder: () => { throw new Error("Recorder is unavailable in this render proof."); },
    subscribeTransport: subscribe,
    subscribePitch: subscribe,
    subscribeCounters: subscribe,
    subscribeTelemetry: subscribe,
    subscribeHistory: subscribe,
  } as unknown as AudioInputController;
  return Object.assign(controller, {
    getTransportSnapshot: () => ({ state: controller.state, error: "", microphoneInfo: null, transportRepairCount: 0 }),
    getPitchSnapshot: () => ({ liveFrame: undefined, liveNote: null }),
    getCounterSnapshot: () => ({ processedWindowCount: 0, processedSampleCount: 0, workletProcessCount: 0, captureEpoch: 0, continuityEpoch: 0, graphGeneration: 0 }),
    getTelemetrySnapshot: () => ({ telemetry: null }),
    getHistorySnapshot: () => ({ frames: [], telemetryHistory: [] }),
  });
}

function task(midi: number, cueVisibility: "guided" | "blind"): ToneMapTask {
  return {
    midi,
    skill: "identification",
    challengeKind: "keyboard-identification",
    cueVisibility,
  };
}

function renderTrial(midi: number, cueVisibility: "guided" | "blind", answerMidi: number | null = null) {
  const course = createToneMapCourse("presentation");
  const evidence = course.tones[midi]!.identification;
  return renderToStaticMarkup(createElement(ToneMapSingleTrial, {
    task: task(midi, cueVisibility),
    answer: answerMidi === null ? null : {
      kind: "midi",
      midi: answerMidi,
      correct: answerMidi === midi,
      attemptId: "presentation-attempt",
      committedAt: "2026-08-25T12:00:00.000Z",
    },
    evidence,
    input: inputController(),
    voiceAnswer: { status: "inactive", ready: false, statusAuthority: null },
    playback,
    onAnswerMidi: () => undefined,
    onCommitVoiceAnswer: () => undefined,
    onUnreachable: () => undefined,
    onNext: () => undefined,
    onRetryExcluded: () => undefined,
  }));
}

describe("tone-map commitment presentation", () => {
  it("renders byte-identical blind answer markup for distant hidden targets", () => {
    const low = renderTrial(24, "blind");
    const high = renderTrial(101, "blind");

    expect(low).toBe(high);
    expect(low).toContain("The target stays hidden until you commit");
    expect(low).toContain("Play prompt");
    expect(low.match(/data-midi=/gu)).toHaveLength(88);
    expect(low).not.toContain("data-tone-map-target-midi");
    expect(low).not.toContain("data-marker-role");
    expect(low.match(/piano-keyboard__label/gu)).toHaveLength(88);
  });

  it("keeps guided targets hidden while labeled keys provide context and review follows commitment", () => {
    const guidedLow = renderTrial(24, "guided");
    const guidedHigh = renderTrial(101, "guided");
    const reviewed = renderTrial(61, "blind", 60);

    expect(guidedLow).toBe(guidedHigh);
    expect(guidedLow).toContain("Use the labeled keys");
    expect(guidedLow.match(/piano-keyboard__label/gu)).toHaveLength(88);
    expect(guidedLow).not.toContain("data-tone-map-guided-label");
    expect(guidedLow).not.toContain("data-tone-map-review");
    expect(reviewed).toContain("data-tone-map-review");
    expect(reviewed).toContain('data-tone-map-target-midi="61"');
    expect(reviewed).toContain('data-marker-role="wrong"');
    expect(reviewed).toContain('data-marker-role="target"');
  });

  it("keeps the only Stop control mounted when voice scheduling has no task", () => {
    const playing: SustainedNoteControl = {
      status: "on",
      playing: true,
      error: "",
      toggle: () => undefined,
    };
    const markup = renderToStaticMarkup(createElement(ToneMapSingleTrial, {
      task: null,
      answer: null,
      evidence: null,
      input: inputController(),
      voiceAnswer: { status: "inactive", ready: false, statusAuthority: null },
      playback: playing,
      onAnswerMidi: () => undefined,
      onCommitVoiceAnswer: () => undefined,
      onUnreachable: () => undefined,
      onNext: () => undefined,
      onRetryExcluded: () => undefined,
    }));

    expect(markup).toContain("Stop last prompt");
    expect(markup).toContain('data-note-playback-toggle="true"');
    expect(markup).not.toMatch(/C4|261\.6256/);
  });

  it("uses shared audio authorities and contains no local capture, timeout, or stop action", () => {
    const trainer = readFileSync(new URL("../apps/web/src/features/ear-training/ToneMapTrainer.tsx", import.meta.url), "utf8");
    const session = readFileSync(new URL("../apps/web/src/features/ear-training/use-tone-map-session.ts", import.meta.url), "utf8");
    const single = readFileSync(new URL("../apps/web/src/features/ear-training/ToneMapSingleTrial.tsx", import.meta.url), "utf8");
    const sources = `${trainer}\n${session}\n${single}`;

    expect(session).toContain("useToneMapVoiceAnswer(voiceContext)");
    expect(session).toContain("readCommittedMidi()");
    expect(session).not.toContain("session.task?.midi ?? 60");
    expect(session).toContain("useSustainedNote({");
    expect(single).toContain('<NotePlaybackToggle label="prompt"');
    expect(sources).not.toMatch(/getUserMedia|createRecorder\(|setTimeout|setInterval/);
    expect(sources).not.toMatch(/\.disable\(|\.stop\(|durationSeconds|deadline|countdown/);
  });
});
