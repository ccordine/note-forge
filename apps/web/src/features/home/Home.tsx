import { useEffect, useState } from "react";
import {
  useAudioInputStatus,
  useAudioPitchSnapshot,
  useAudioTransportSnapshot,
  type AudioInputController,
} from "@/audio/use-audio-input";
import { playSafely, playTone } from "@/audio/synth";
import { recentAttempts, type LocalAttempt } from "@/storage/database";
import { useMusicalState } from "@/state/MusicalContext";
import { DEFAULT_ROUTES, appRoutePath, type AppRoute } from "@/navigation";
import { continuousMidiToHz, noteLabel, pitchClassLabel } from "@/lib/music-display";
import { Eyebrow, Panel, PlayButton, RouteLink } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";

const modes: { route: AppRoute; icon: Parameters<typeof Icon>[0]["name"]; title: string; detail: string; accent: string }[] = [
  { route: DEFAULT_ROUTES.pitchMatch, icon: "mirror", title: "Practice", detail: "Pitch match, sustain, recognize, and connect musical structures.", accent: "coral" },
  { route: DEFAULT_ROUTES.arcade, icon: "arcade", title: "Arcade", detail: "Turn continuous vocal control into motion, timing, drawing, and play.", accent: "lime" },
  { route: DEFAULT_ROUTES.sound, icon: "sound", title: "Explore", detail: "Touch pitch, harmony, and tension directly.", accent: "blue" },
  { route: DEFAULT_ROUTES.songs, icon: "song", title: "Songs", detail: "Bring pitch work into phrases and real music.", accent: "violet" },
  { route: DEFAULT_ROUTES.rangeMap, icon: "loop", title: "Progress", detail: "Map your usable range and review measured growth.", accent: "blue" },
];

function SignalGlyph({ input }: { input: AudioInputController }) {
  const transport = useAudioTransportSnapshot(input);
  const pitch = useAudioPitchSnapshot(input);
  const frame = transport.state === "running" ? pitch.liveFrame : undefined;
  const detectedFrame = frame?.voiced === true && frame.nearestMidi !== null && frame.frequencyHz !== null
    ? frame
    : null;
  const detectedNote = detectedFrame?.nearestMidi ?? null;
  const detectedFrequency = detectedFrame?.frequencyHz ?? null;
  const detected = detectedNote !== null && detectedFrequency !== null;
  const label = transport.state === "disabled"
    ? "MIC OFF"
    : transport.state === "opening"
      ? "OPENING"
      : transport.state === "error"
        ? "MIC ERROR"
        : detectedNote !== null
          ? noteLabel(detectedNote)
          : "LISTENING";
  const detail = transport.state === "disabled"
    ? "enable voice in the global control above"
    : transport.state === "opening"
      ? "requesting browser input"
      : transport.state === "error"
        ? transport.error || "microphone unavailable"
        : detectedFrequency !== null
          ? `${detectedFrequency.toFixed(2)} Hz · current PCM result`
          : frame?.reason ?? "no observation yet";
  return (
    <div className={`hero-signal ${transport.state} ${detected ? "voiced" : ""}`} role="status" aria-live="polite">
      <div className="signal-note"><b>{label}</b><small>{detail}</small></div>
    </div>
  );
}

function RecentSignals({
  attempts,
  state,
}: {
  attempts: readonly LocalAttempt[];
  state: "loading" | "ready" | "error";
}) {
  if (state === "error") {
    return <div className="empty-history error"><h3>Local history is unavailable.</h3><p>NoteForge could not read this browser’s IndexedDB storage. New attempts may not persist until local storage is available.</p></div>;
  }
  if (state === "loading") {
    return <div className="empty-history"><h3>Reading local history…</h3><p>Checking this device for recent measured attempts.</p></div>;
  }
  if (attempts.length === 0) {
    return (
      <div className="empty-history">
        <div className="mini-ribbon"><span /><span /><span /><span /><span /></div>
        <h3>Your traces will live here.</h3>
        <p>Derived attempt metrics can be retained here. Audio is recorded only when you explicitly start a voice take.</p>
      </div>
    );
  }
  return (
    <div className="attempt-list">
      {attempts.map((attempt) => (
        <div key={attempt.id} className="attempt-row">
          <span className="attempt-orb" />
          <span><b>{attempt.exerciseType.replaceAll(".", " ")}</b><small>{new Date(attempt.completedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></span>
          <strong>{attempt.metrics.medianErrorCents == null ? "—" : `${Math.abs(attempt.metrics.medianErrorCents).toFixed(0)}¢`}</strong>
        </div>
      ))}
    </div>
  );
}

export function Home() {
  const { selectedMidi, centsOffset, timbre } = useMusicalState();
  const input = useAudioInputStatus();
  const [attempts, setAttempts] = useState<LocalAttempt[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;
    recentAttempts(4)
      .then((next) => {
        if (!active) return;
        setAttempts(next);
        setHistoryState("ready");
      })
      .catch(() => {
        if (active) setHistoryState("error");
      });
    return () => { active = false; };
  }, []);

  return (
    <div className="page home-page">
      <Panel className="hero-panel">
        <div className="hero-copy">
          <Eyebrow>auditory–motor laboratory</Eyebrow>
          <h1>HEAR IT.<br /><span>KNOW IT.</span><br />SING IT.</h1>
          <p>Forge one shared coordinate system between sound, body, name, and harmonic purpose.</p>
          <div className="hero-actions">
            <RouteLink className="action-button primary" route={{ surface: "practice", activity: "pitch-match", mode: "cold" }}><Icon name="mic" size={18} /> Start cold attacks</RouteLink>
            <PlayButton label={`Hear ${noteLabel(selectedMidi)}`} onClick={() => playSafely(playTone({ frequencyHz: continuousMidiToHz(selectedMidi, centsOffset), timbre }), "Home reference tone")} />
          </div>
        </div>
        <SignalGlyph input={input} />
        <div className="hero-coordinate">
          <span>ACTIVE OBJECT</span>
          <strong>{noteLabel(selectedMidi)}</strong>
          <em>{pitchClassLabel(selectedMidi)} · {continuousMidiToHz(selectedMidi, centsOffset).toFixed(2)} Hz · {centsOffset >= 0 ? "+" : ""}{centsOffset}¢</em>
        </div>
      </Panel>

      <div className="section-heading">
        <div><Eyebrow>One instrument · many views</Eyebrow><h2>Enter the forge</h2></div>
        <RouteLink className="text-button" route={{ surface: "practice", activity: "intervals", mode: "production" }}>Open interval production <Icon name="arrow" size={16} /></RouteLink>
      </div>

      <div className="mode-grid">
        {modes.map((mode, index) => (
          <RouteLink key={appRoutePath(mode.route)} route={mode.route} className={`mode-card accent-${mode.accent}`}>
            <span className="mode-number">{String(index + 1).padStart(2, "0")}</span>
            <span className="mode-icon"><Icon name={mode.icon} size={28} /></span>
            <strong>{mode.title}</strong>
            <span>{mode.detail}</span>
            <i><Icon name="arrow" size={18} /></i>
          </RouteLink>
        ))}
      </div>

      <div className="home-lower-grid history-only">
        <Panel className="history-card">
          <div className="panel-heading"><div><Eyebrow>Stored on this device</Eyebrow><h2>Recent signals</h2></div><span className="local-badge">Local only</span></div>
          <RecentSignals attempts={attempts} state={historyState} />
        </Panel>
      </div>
    </div>
  );
}
