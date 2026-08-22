import { useEffect, useState } from "react";
import { playTone } from "@/audio/synth";
import { recentAttempts, type LocalAttempt } from "@/storage/database";
import { useLab, type ViewId } from "@/state/LabContext";
import { continuousMidiToHz, noteLabel, pitchClassLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";

const modes: { id: ViewId; icon: Parameters<typeof Icon>[0]["name"]; title: string; detail: string; accent: string }[] = [
  { id: "sound", icon: "sound", title: "Sound Lab", detail: "Touch pitch, harmony, and tension directly.", accent: "lime" },
  { id: "mirror", icon: "mirror", title: "Pitch Mirror", detail: "Turn an internal sound into a measured gesture.", accent: "coral" },
  { id: "intervals", icon: "interval", title: "Interval Lab", detail: "Hear, name, reproduce, and transform distance.", accent: "blue" },
  { id: "harmony", icon: "harmony", title: "Harmony Lab", detail: "Navigate chord tones, tensions, and resolutions.", accent: "violet" }
];

const sessionBlocks = [
  { minutes: 4, label: "Cold attacks", skill: "pitch.match.cold_attack", color: "lime" },
  { minutes: 4, label: "Pitch + dynamics", skill: "pitch.hold.stability", color: "coral" },
  { minutes: 4, label: "Intervals", skill: "interval.produce.P5", color: "blue" },
  { minutes: 4, label: "Chord tones", skill: "chord_tone.produce.third", color: "violet" },
  { minutes: 4, label: "Copy · analyze · mutate", skill: "melody.mutate", color: "cream" }
];

function SignalGlyph() {
  const bars = [28, 44, 62, 34, 78, 52, 88, 40, 68, 94, 58, 30, 74, 48, 82, 38, 64, 26, 50];
  return (
    <div className="hero-signal" aria-hidden="true">
      {bars.map((height, index) => <span key={index} style={{ height: `${height}%`, animationDelay: `${index * -55}ms` }} />)}
      <div className="signal-note"><b>C4</b><small>261.63 Hz</small></div>
    </div>
  );
}

export function Home() {
  const { setView, selectedMidi, centsOffset, timbre } = useLab();
  const [attempts, setAttempts] = useState<LocalAttempt[]>([]);

  useEffect(() => { recentAttempts(4).then(setAttempts).catch(() => undefined); }, []);

  return (
    <div className="page home-page">
      <Panel className="hero-panel">
        <div className="hero-copy">
          <Eyebrow><span className="live-dot" /> auditory–motor laboratory</Eyebrow>
          <h1>HEAR IT.<br /><span>KNOW IT.</span><br />SING IT.</h1>
          <p>Forge one shared coordinate system between sound, body, name, and harmonic purpose.</p>
          <div className="hero-actions">
            <ActionButton className="primary" onClick={() => setView("mirror")}><Icon name="mic" size={18} /> Begin a match</ActionButton>
            <PlayButton label={`Hear ${noteLabel(selectedMidi)}`} onClick={() => playTone({ frequencyHz: continuousMidiToHz(selectedMidi, centsOffset), timbre })} />
          </div>
        </div>
        <SignalGlyph />
        <div className="hero-coordinate">
          <span>ACTIVE OBJECT</span>
          <strong>{noteLabel(selectedMidi)}</strong>
          <em>{pitchClassLabel(selectedMidi)} · {continuousMidiToHz(selectedMidi, centsOffset).toFixed(2)} Hz · {centsOffset >= 0 ? "+" : ""}{centsOffset}¢</em>
        </div>
      </Panel>

      <div className="section-heading">
        <div><Eyebrow>One instrument · many views</Eyebrow><h2>Enter the forge</h2></div>
        <button className="text-button" onClick={() => setView("skills")}>See the skill map <Icon name="arrow" size={16} /></button>
      </div>

      <div className="mode-grid">
        {modes.map((mode, index) => (
          <button key={mode.id} className={`mode-card accent-${mode.accent}`} onClick={() => setView(mode.id)}>
            <span className="mode-number">0{index + 1}</span>
            <span className="mode-icon"><Icon name={mode.icon} size={28} /></span>
            <strong>{mode.title}</strong>
            <span>{mode.detail}</span>
            <i><Icon name="arrow" size={18} /></i>
          </button>
        ))}
      </div>

      <div className="home-lower-grid">
        <Panel className="session-card">
          <div className="panel-heading"><div><Eyebrow>Adaptive session</Eyebrow><h2>Twenty useful minutes</h2></div><span className="time-chip">20:00</span></div>
          <div className="session-timeline">
            {sessionBlocks.map((block, index) => (
              <button key={block.label} onClick={() => setView(index === 0 ? "mirror" : index === 1 ? "control" : index === 2 ? "intervals" : index === 3 ? "harmony" : "melody")}>
                <span className={`timeline-marker ${block.color}`}>{block.minutes}</span>
                <span><b>{block.label}</b><small>{block.skill}</small></span>
                <Icon name="arrow" size={16} />
              </button>
            ))}
          </div>
          <ActionButton className="wide primary" onClick={() => setView("mirror")}><Icon name="spark" size={18} /> Generate today’s session</ActionButton>
        </Panel>

        <Panel className="history-card">
          <div className="panel-heading"><div><Eyebrow>Stored on this device</Eyebrow><h2>Recent signals</h2></div><span className="local-badge">Local only</span></div>
          {attempts.length ? (
            <div className="attempt-list">
              {attempts.map((attempt) => (
                <div key={attempt.id} className="attempt-row">
                  <span className="attempt-orb" />
                  <span><b>{attempt.exerciseType.replaceAll(".", " ")}</b><small>{new Date(attempt.completedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></span>
                  <strong>{attempt.metrics.medianErrorCents == null ? "—" : `${Math.abs(attempt.metrics.medianErrorCents).toFixed(0)}¢`}</strong>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-history">
              <div className="mini-ribbon"><span /><span /><span /><span /><span /></div>
              <h3>Your traces will live here.</h3>
              <p>Pitch contours and metrics are retained. Audio is not recorded unless you explicitly ask for it.</p>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
