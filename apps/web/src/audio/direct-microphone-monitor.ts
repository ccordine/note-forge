import {
  MICROPHONE_MONITOR_RAMP_SECONDS,
  requireMonitorLevel,
} from "./microphone-environment";

/**
 * Capture-lifetime microphone-to-output branch. Its only runtime mutation is
 * AudioParam automation; toggles never rebuild, reconnect, or touch analysis.
 */
export class DirectMicrophoneMonitor {
  private readonly output: GainNode;

  constructor(private readonly context: AudioContext) {
    this.output = context.createGain();
    this.output.gain.value = 0;
    this.output.connect(context.destination);
  }

  connect(source: MediaStreamAudioSourceNode): void {
    source.connect(this.output);
  }

  set(enabled: boolean, level: number): void {
    requireMonitorLevel(level);
    const gain = this.output.gain;
    const now = this.context.currentTime;
    const target = enabled ? level : 0;
    if (typeof gain.cancelAndHoldAtTime === "function") {
      gain.cancelAndHoldAtTime(now);
    } else {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
    }
    gain.linearRampToValueAtTime(
      target,
      now + MICROPHONE_MONITOR_RAMP_SECONDS,
    );
  }

  dispose(): void {
    this.output.disconnect();
  }
}
