import { beforeEach, describe, expect, it, vi } from "vitest";

const outputRouting = vi.hoisted(() => ({
  routeSharedAudioOutput: vi.fn(),
  selectSharedAudioOutput: vi.fn(),
  supportsSharedAudioOutputSelection: vi.fn(),
}));

vi.mock("../apps/web/src/audio/audio-output-routing", () => outputRouting);

import { AudioMonitoring } from "../apps/web/src/audio/audio-monitoring";
import type { AudioMonitoringSettings } from "../apps/web/src/audio/audio-monitoring-settings";
import type { MicrophoneCapture } from "../apps/web/src/audio/microphone";

const CONTEXT_INFO = Object.freeze({
  requestedLatencyHint: "interactive" as const,
  sampleRate: 48_000,
  baseSeconds: 0.005,
  outputSeconds: 0.008,
});

function createMonitoring(): AudioMonitoring {
  return new AudioMonitoring({
    setMonitoring: vi.fn(),
    getInfo: () => null,
  } as unknown as MicrophoneCapture);
}

describe("preferred shared audio output persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outputRouting.supportsSharedAudioOutputSelection.mockReturnValue(true);
    outputRouting.routeSharedAudioOutput.mockResolvedValue(CONTEXT_INFO);
  });

  it("persists a chosen device and restores its sink only after voice is enabled", async () => {
    outputRouting.selectSharedAudioOutput.mockResolvedValue({
      deviceId: "usb-headphones-id",
      label: "USB Headphones",
      contextInfo: CONTEXT_INFO,
    });
    const firstRun = createMonitoring();
    const persisted = vi.fn<(settings: AudioMonitoringSettings) => void>();
    firstRun.controller.subscribePreferredOutput(persisted);

    await firstRun.controller.selectOutput();

    expect(persisted).toHaveBeenCalledOnce();
    const saved = persisted.mock.calls[0]![0];
    expect(saved).toEqual({
      version: 2,
      enabled: false,
      level: 0.65,
      preferredOutput: {
        deviceId: "usb-headphones-id",
        label: "USB Headphones",
      },
    });

    const reloaded = createMonitoring();
    reloaded.controller.configure(saved);
    expect(reloaded.controller.getSnapshot()).toMatchObject({
      outputLabel: "USB Headphones",
      preferredOutput: saved.preferredOutput,
    });
    expect(outputRouting.routeSharedAudioOutput).not.toHaveBeenCalled();

    reloaded.setInputRunning(true);
    await vi.waitFor(() => {
      expect(outputRouting.routeSharedAudioOutput).toHaveBeenCalledWith("usb-headphones-id");
      expect(reloaded.controller.getSnapshot()).toMatchObject({
        outputState: "idle",
        outputError: "",
        contextInfo: CONTEXT_INFO,
      });
    });
  });

  it("clears a missing saved device and falls back truthfully to System default", async () => {
    outputRouting.routeSharedAudioOutput.mockRejectedValue(new Error("device missing"));
    const monitoring = createMonitoring();
    const persisted = vi.fn<(settings: AudioMonitoringSettings) => void>();
    monitoring.controller.subscribePreferredOutput(persisted);
    monitoring.controller.configure({
      version: 2,
      enabled: true,
      level: 0.73,
      preferredOutput: { deviceId: "missing-id", label: "Old headphones" },
    });

    monitoring.setInputRunning(true);

    await vi.waitFor(() => {
      expect(monitoring.controller.getSnapshot()).toMatchObject({
        outputLabel: "System default",
        outputState: "error",
        preferredOutput: null,
      });
      expect(persisted).toHaveBeenLastCalledWith(expect.objectContaining({
        preferredOutput: null,
      }));
    });
  });

  it("clears an unsupported saved preference without opening audio", () => {
    outputRouting.supportsSharedAudioOutputSelection.mockReturnValue(false);
    const monitoring = createMonitoring();
    const persisted = vi.fn<(settings: AudioMonitoringSettings) => void>();
    monitoring.controller.subscribePreferredOutput(persisted);

    monitoring.controller.configure({
      version: 2,
      enabled: false,
      level: 0.65,
      preferredOutput: { deviceId: "saved-id", label: "Saved output" },
    });

    expect(monitoring.controller.getSnapshot()).toMatchObject({
      outputSelectionSupported: false,
      outputLabel: "System default",
      outputState: "error",
      preferredOutput: null,
    });
    expect(persisted).toHaveBeenCalledWith(expect.objectContaining({ preferredOutput: null }));
    expect(outputRouting.routeSharedAudioOutput).not.toHaveBeenCalled();
  });
});
