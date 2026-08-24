import { useEffect, useState } from "react";
import { SKILL_CATALOG } from "@noteforge/trainer-core";
import { useAudioInputStatus, type AudioInputController } from "@/audio/use-audio-input";
import { playSafely, playTone } from "@/audio/synth";
import { recentAttempts, type LocalAttempt } from "@/storage/database";
import { useLab, type ViewId } from "@/state/LabContext";
import { continuousMidiToHz, noteLabel, pitchClassLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";

const modes: { id: ViewId; icon: Parameters<typeof Icon>[0]["name"]; title: string; detail: string; accent: string }[] = [
  { id: "sound", icon: "sound", title: "Sound Lab", detail: "Touch pitch, harmony, and tension directly.", accent: "lime" },
  { id: "mirror", icon: "mirror", title: "Pitch Mirror", detail: "Turn an internal sound into a measured gesture.", accent: "coral" },
  { id: "range-map", icon: "loop", title: "Range Simulator", detail: "Find a comfortable baseline and map your range progressively.", accent: "blue" },
  { id: "arcade", icon: "arcade", title: "Voice Arcade", detail: "Train continuous, sustained, timed, in-song, and acoustic-field control from guided to game-first play.", accent: "lime" },
  { id: "intervals", icon: "interval", title: "Interval Lab", detail: "Hear, name, reproduce, and transform distance.", accent: "blue" },
  { id: "harmony", icon: "harmony", title: "Harmony Lab", detail: "Navigate chord tones, tensions, and resolutions.", accent: "violet" }
];

const sessionBlocks = [
  { minutes: 4, label: "Cold attacks", skill: "pitch.match.cold_attack", color: "lime" },
  { minutes: 4, label: "Pitch + dynamics", skill: "pitch.hold.stability", color: "coral" },
  { minutes: 4, label: "Intervals", skill: "interval.produce", color: "blue" },
  { minutes: 4, label: "Chord tones", skill: "chord_tone.produce", color: "violet" },
  { minutes: 4, label: "Copy a contour", skill: "melody.echo", color: "cream" }
];

const canonicalSkillIds = new Set(SKILL_CATALOG.map((skill) => skill.skillId));
for (const block of sessionBlocks) {
  if (!canonicalSkillIds.has(block.skill)) throw new Error(`Unknown starter-circuit skill: ${block.skill}`);
}

function SignalGlyph({ input }: { input: AudioInputController }) {
  const frame = input.state === "running" ? input.liveFrame : undefined;
  const detectedFrame = frame?.voiced === true && frame.nearestMidi !== null && frame.frequencyHz !== null
    ? frame
    : null;
  const detectedNote = detectedFrame?.nearestMidi ?? null;
  const detectedFrequency = detectedFrame?.frequencyHz ?? null;
  const detected = detectedNote !== null && detectedFrequency !== null;
  const label = input.state === "disabled"
    ? "MIC OFF"
    : input.state === "opening"
      ? "OPENING"
      : input.state === "error"
        ? "MIC ERROR"
        : detectedNote !== null
          ? noteLabel(detectedNote)
          : "LISTENING";
  const detail = input.state === "disabled"
    ? "enable input in a microphone lab"
    : input.state === "opening"
      ? "requesting browser input"
      : input.state === "error"
        ? input.error || "microphone unavailable"
        : detectedFrequency !== null
          ? `${detectedFrequency.toFixed(2)} Hz · current PCM result`
          : frame?.reason ?? "no observation yet";
  return (
    <div className={`hero-signal ${input.state} ${detected ? "voiced" : ""}`} role="status" aria-live="polite">
      <div className="signal-note"><b>{label}</b><small>{detail}</small></div>
    </div>
  );
}

export function Home() {
  const { setView, selectedMidi, centsOffset, timbre } = useLab();
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
            <ActionButton className="primary" onClick={() => setView("mirror")}><Icon name="mic" size={18} /> Begin a match</ActionButton>
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
        <button className="text-button" onClick={() => setView("skills")}>See the skill map <Icon name="arrow" size={16} /></button>
      </div>

      <div className="mode-grid">
        {modes.map((mode, index) => (
          <button key={mode.id} className={`mode-card accent-${mode.accent}`} onClick={() => setView(mode.id)}>
            <span className="mode-number">{String(index + 1).padStart(2, "0")}</span>
            <span className="mode-icon"><Icon name={mode.icon} size={28} /></span>
            <strong>{mode.title}</strong>
            <span>{mode.detail}</span>
            <i><Icon name="arrow" size={18} /></i>
          </button>
        ))}
      </div>

      <div className="home-lower-grid">
        <Panel className="session-card">
          <div className="panel-heading"><div><Eyebrow>Fixed starter circuit</Eyebrow><h2>Twenty useful minutes</h2></div><span className="time-chip">20:00</span></div>
          <div className="session-timeline">
            {sessionBlocks.map((block, index) => (
              <button key={block.label} onClick={() => setView(index === 0 ? "mirror" : index === 1 ? "control" : index === 2 ? "intervals" : index === 3 ? "harmony" : "melody")}>
                <span className={`timeline-marker ${block.color}`}>{block.minutes}</span>
                <span><b>{block.label}</b><small>{block.skill}</small></span>
                <Icon name="arrow" size={16} />
              </button>
            ))}
          </div>
          <ActionButton className="wide primary" onClick={() => setView("mirror")}><Icon name="arrow" size={18} /> Start with cold attacks</ActionButton>
        </Panel>

        <Panel className="history-card">
          <div className="panel-heading"><div><Eyebrow>Stored on this device</Eyebrow><h2>Recent signals</h2></div><span className="local-badge">Local only</span></div>
          {historyState === "error" ? (
            <div className="empty-history error"><h3>Local history is unavailable.</h3><p>NoteForge could not read this browser’s IndexedDB storage. New attempts may not persist until local storage is available.</p></div>
          ) : historyState === "loading" ? (
            <div className="empty-history"><h3>Reading local history…</h3><p>Checking this device for recent measured attempts.</p></div>
          ) : attempts.length ? (
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
              <p>Derived attempt metrics can be retained here. Audio is recorded only when you explicitly start a voice take.</p>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
