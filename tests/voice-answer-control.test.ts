import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AudioInputController } from "../apps/web/src/audio/use-audio-input";
import { VoiceAnswerControl } from "../apps/web/src/features/ear-training/VoiceAnswerControl";
import type { ToneMapVoiceAnswerSnapshot } from "../apps/web/src/features/ear-training/tone-map-voice-answer";

function inputController(
  state: AudioInputController["state"] = "running",
): AudioInputController {
  let controller: AudioInputController;
  const subscribe = () => () => undefined;
  controller = {
    state,
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
    createRecorder: () => { throw new Error("Recorder unavailable in render test."); },
    subscribeTransport: subscribe,
    subscribePitch: subscribe,
    subscribeCounters: subscribe,
    subscribeTelemetry: subscribe,
    subscribeHistory: subscribe,
    getTransportSnapshot: () => ({
      state: controller.state,
      error: controller.error,
      microphoneInfo: controller.microphoneInfo,
      transportRepairCount: controller.transportRepairCount,
    }),
    getPitchSnapshot: () => ({ liveFrame: undefined, liveNote: null }),
    getCounterSnapshot: () => ({
      processedWindowCount: 0,
      processedSampleCount: 0,
      workletProcessCount: 0,
      captureEpoch: 0,
      continuityEpoch: 0,
      graphGeneration: 0,
    }),
    getTelemetrySnapshot: () => ({ telemetry: null }),
    getHistorySnapshot: () => ({ frames: [], telemetryHistory: [] }),
  };
  return controller;
}

function renderControl(options: Readonly<{
  inputState?: AudioInputController["state"];
  voiceAnswer?: ToneMapVoiceAnswerSnapshot;
  promptPlaying?: boolean;
  answered?: boolean;
}> = {}): string {
  return renderToStaticMarkup(createElement(VoiceAnswerControl, {
    input: inputController(options.inputState),
    voiceAnswer: options.voiceAnswer ?? {
      status: "listening",
      ready: false,
      statusAuthority: null,
    },
    promptPlaying: options.promptPlaying ?? false,
    answered: options.answered ?? false,
    onCommit: () => undefined,
    onUnreachable: () => undefined,
  }));
}

describe("explicit voice-answer control", () => {
  it("enables Commit only for exact ready evidence on a running, silent prompt lane", () => {
    const readyAnswer = {
      status: "ready" as const,
      ready: true,
      statusAuthority: null,
    };
    const ready = renderControl({ voiceAnswer: readyAnswer });
    const prompt = renderControl({
      voiceAnswer: readyAnswer,
      promptPlaying: true,
    });
    const disabled = renderControl({
      inputState: "disabled",
      voiceAnswer: readyAnswer,
    });

    expect(ready).toContain('data-answer-ready="true"');
    expect(ready).not.toMatch(/data-voice-answer-action="commit"[^>]*disabled/);
    expect(prompt).toContain('data-answer-ready="false"');
    expect(prompt).toContain("Stop the prompt, then let it clear before singing.");
    expect(prompt).toMatch(/data-voice-answer-action="commit"[^>]*disabled/);
    expect(disabled).toContain("Enable voice globally to answer by singing.");
    expect(disabled).toMatch(/data-voice-answer-action="commit"[^>]*disabled/);
  });

  it("hides detected pitch and explains the fresh release boundary", () => {
    const waiting = renderControl({
      voiceAnswer: { status: "awaiting-release", ready: false, statusAuthority: null },
    });
    const answered = renderControl({
      voiceAnswer: { status: "ready", ready: true, statusAuthority: null },
      answered: true,
    });

    expect(waiting).toContain("Let the prior sound clear, then sing.");
    expect(waiting).not.toMatch(/C4|261\.6256|data-midi=/);
    expect(answered).toContain("Answer recorded.");
    expect(answered.match(/disabled/g)).toHaveLength(2);
  });

  it("commits only from the user's visible Commit action", () => {
    const commit = vi.fn();
    const element = VoiceAnswerControl({
      input: inputController(),
      voiceAnswer: { status: "ready", ready: true, statusAuthority: null },
      promptPlaying: false,
      answered: false,
      onCommit: commit,
      onUnreachable: () => undefined,
    });
    const actions = element.props.children[1];
    const commitButton = actions.props.children[0];

    expect(commit).not.toHaveBeenCalled();
    commitButton.props.onClick();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("renders exact target-independent status provenance without pitch identity", () => {
    const markup = renderControl({
      voiceAnswer: {
        status: "ready",
        ready: true,
        statusAuthority: {
          sampleRate: 48_000,
          startSample: 12_480,
          endSample: 16_576,
          captureEpoch: 3,
          continuityEpoch: 2,
          graphGeneration: 1,
          processedSampleCount: 16_576,
          workletProcessCount: 130,
        },
      },
    });

    expect(markup).toContain('data-status-sample-rate="48000"');
    expect(markup).toContain('data-status-start-sample="12480"');
    expect(markup).toContain('data-status-end-sample="16576"');
    expect(markup).toContain('data-status-capture-epoch="3"');
    expect(markup).toContain('data-status-continuity-epoch="2"');
    expect(markup).toContain('data-status-graph-generation="1"');
    expect(markup).not.toMatch(/data-midi|frequency|cents/i);
  });

  it("has no detector, target, microphone-lifecycle, timer, or automatic-commit authority", () => {
    const source = readFileSync(
      new URL("../apps/web/src/features/ear-training/VoiceAnswerControl.tsx", import.meta.url),
      "utf8",
    );
    const hook = readFileSync(
      new URL("../apps/web/src/features/ear-training/use-tone-map-voice-answer.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/useAudioPitchSnapshot|liveNote|targetMidi|frequencyHz|midiFloat/);
    expect(source).not.toMatch(/getUserMedia|\.enable\(|\.disable\(|createRecorder/);
    expect(`${source}\n${hook}`).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|useEffect/);
    expect(source).toContain("onClick={onCommit}");
    expect(hook).toContain("useAudioInput({");
    expect(hook).toContain("onFrame: (observation)");
    expect(hook).toContain("observeToneMapVoiceAnswer(configured, observation)");
    expect(hook).not.toContain("useAudioPitchSnapshot");
  });
});
