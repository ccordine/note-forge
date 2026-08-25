import {
  formatNegotiatedAudioSwitch,
  formatReportedLatency,
} from "@/audio/audio-environment-display";
import {
  useAudioInputStatus,
  useAudioMonitoring,
} from "@/audio/use-audio-input";
import { Icon } from "./Icon";

function monitoringStatus(effective: boolean, enabled: boolean): string {
  if (effective) return "LIVE";
  return enabled ? "READY" : "OFF";
}

export function AudioSettings() {
  const input = useAudioInputStatus();
  const monitoring = useAudioMonitoring();
  const info = input.microphoneInfo;
  const latency = info?.latency;
  const contextInfo = monitoring.contextInfo;
  return (
    <section className="audio-settings" aria-labelledby="audio-settings-title">
      <div className="audio-settings-heading">
        <div><span>Audio environment</span><h3 id="audio-settings-title">Vocal monitoring</h3></div>
        <b>{monitoringStatus(monitoring.effective, monitoring.enabled)}</b>
      </div>
      <label className="settings-toggle">
        <span><b>Direct monitoring</b><small>Routes the raw microphone directly through the browser audio graph. It never waits for pitch detection or React.</small></span>
        <input
          data-settings-monitor-toggle
          type="checkbox"
          checked={monitoring.enabled}
          disabled={!monitoring.ready}
          onChange={(event) => monitoring.setEnabled(event.target.checked)}
        />
      </label>
      <label className="settings-block monitor-level-setting">
        <span>Monitor level <b>{Math.round(monitoring.level * 100)}%</b></span>
        <input
          data-monitor-level
          type="range"
          min="0"
          max="100"
          step="1"
          value={Math.round(monitoring.level * 100)}
          disabled={!monitoring.ready}
          onChange={(event) => monitoring.setLevel(Number(event.target.value) / 100)}
        />
        <small>Changing this level never changes detector or scoring input.</small>
      </label>
      <div className="monitor-warning">
        <Icon name="headphones" size={19} />
        <span><b>Use wired headphones.</b> Speaker monitoring can feed back. Bluetooth can add noticeable delay.</span>
      </div>
      <div className="audio-device-row">
        <span><small>Input</small><b>{info?.label?.trim() || (input.state === "running" ? "Default microphone" : "Available after voice is enabled")}</b></span>
      </div>
      <div className="audio-device-row">
        <span><small>Audio output</small><b data-audio-output-label>{monitoring.outputLabel}</b></span>
        {monitoring.outputSelectionSupported && (
          <button
            type="button"
            data-audio-output-select
            disabled={!monitoring.ready || monitoring.outputState === "selecting"}
            onClick={() => { void monitoring.selectOutput(); }}
          >
            {monitoring.outputState === "selecting" ? "Choosing…" : "Choose output"}
          </button>
        )}
      </div>
      {monitoring.outputError && <p className="audio-output-error" role="alert">{monitoring.outputError}</p>}
      <details className="audio-diagnostics">
        <summary>Audio diagnostics</summary>
        <dl>
          <div><dt>Requested latency hint</dt><dd>Interactive</dd></div>
          <div><dt>Context sample rate</dt><dd>{contextInfo ? `${contextInfo.sampleRate.toLocaleString()} Hz` : "Not reported"}</dd></div>
          <div><dt>WebAudio base latency</dt><dd>{formatReportedLatency(contextInfo?.baseSeconds)}</dd></div>
          <div><dt>Reported output latency</dt><dd>{formatReportedLatency(contextInfo?.outputSeconds)}</dd></div>
          <div><dt>Reported input latency</dt><dd>{formatReportedLatency(latency?.inputSeconds)}</dd></div>
          <div><dt>Echo cancellation</dt><dd>{formatNegotiatedAudioSwitch(info?.settings.echoCancellation)}</dd></div>
          <div><dt>Noise suppression</dt><dd>{formatNegotiatedAudioSwitch(info?.settings.noiseSuppression)}</dd></div>
          <div><dt>Automatic gain</dt><dd>{formatNegotiatedAudioSwitch(info?.settings.autoGainControl)}</dd></div>
        </dl>
        <p>Latency values are browser-reported estimates, not measured microphone-to-ear round-trip latency.</p>
      </details>
      {monitoring.persistenceState === "error" && <p className="audio-output-error" role="status">Monitoring still works, but this browser could not save the setting.</p>}
    </section>
  );
}
