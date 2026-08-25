import {
  useAudioInputStatus,
  useAudioMonitoring,
  type AudioInputController,
} from "@/audio/use-audio-input";
import { Icon } from "./Icon";

function MicrophoneAction({
  input,
}: {
  input: AudioInputController;
}) {
  switch (input.state) {
    case "disabled":
      return <button type="button" className="microphone-action" data-global-mic-enable onClick={() => { void input.enable(); }}>Enable voice</button>;
    case "opening":
      return null;
    case "running":
      return <button type="button" className="microphone-action" data-global-mic-disable onClick={input.disable}>Disable voice</button>;
    case "error":
      return <button type="button" className="microphone-action" data-global-mic-enable onClick={() => { void input.enable(); }}>Retry voice</button>;
  }
}

export function GlobalAudioControl() {
  const input = useAudioInputStatus();
  const monitoring = useAudioMonitoring();
  const status = {
    disabled: "Voice input off",
    opening: "Opening microphone",
    running: "Microphone active",
    error: "Microphone error",
  }[input.state];
  const monitorLabel = monitoring.enabled
    ? monitoring.effective ? "Monitoring on" : "Monitoring armed"
    : "Monitoring off";
  const monitorState = monitoring.enabled
    ? monitoring.effective ? "On" : "Armed"
    : "Off";
  const compactMonitorState = monitorState === "Armed" ? "Ready" : monitorState;
  return (
    <div
      className={`global-mic-control ${input.state}`}
      data-monitor-effective={monitoring.effective ? "true" : "false"}
      title={input.error || undefined}
    >
      <span role="status" aria-live="polite"><i /> {status}</span>
      <div className="global-audio-actions">
        {monitoring.ready && (
          <button
            type="button"
            className="monitor-toggle"
            data-global-monitor-toggle
            aria-pressed={monitoring.enabled}
            aria-label={`${monitoring.enabled ? "Disable" : "Enable"} vocal monitoring. Use headphones.`}
            title={`${monitorLabel}. Use wired headphones.`}
            onClick={() => monitoring.setEnabled(!monitoring.enabled)}
          >
            <Icon name="headphones" size={15} />
            <span className="monitor-toggle-long">Headphones only · {monitorState}</span>
            <span className="monitor-toggle-short">Only · {compactMonitorState}</span>
          </button>
        )}
        <MicrophoneAction input={input} />
      </div>
    </div>
  );
}
