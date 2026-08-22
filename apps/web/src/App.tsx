import { useState } from "react";
import { Home } from "@/features/home/Home";
import { useLab, type ViewId } from "@/state/LabContext";
import { noteLabel, pitchClassLabel, SCALE_PRESETS, CHORD_PRESETS } from "@/lib/music-display";
import { Icon } from "@/ui/Icon";
import { SoundLab } from "@/features/sound-lab/SoundLab";
import { PitchMirror } from "@/features/pitch-mirror/PitchMirror";
import { HumLab } from "@/features/hum-lab/HumLab";
import { PitchControl } from "@/features/pitch-control/PitchControl";
import { EarLab } from "@/features/ear-training/EarLab";
import { IntervalLab } from "@/features/intervals/IntervalLab";
import { HarmonyLab } from "@/features/harmony/HarmonyLab";
import { MelodyLab } from "@/features/melody/MelodyLab";
import { SongLab } from "@/features/song-lab/SongLab";
import { SkillMap } from "@/features/skills/SkillMap";

const navigation: { label: string; items: { id: ViewId; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] }[] = [
  { label: "Forge", items: [
    { id: "home", label: "Overview", icon: "forge" },
    { id: "sound", label: "Sound Laboratory", icon: "sound" }
  ] },
  { label: "Train", items: [
    { id: "mirror", label: "Pitch Mirror", icon: "mirror" },
    { id: "hum", label: "Hum Laboratory", icon: "hum" },
    { id: "control", label: "Pitch & Dynamics", icon: "control" },
    { id: "ear", label: "Note Recognition", icon: "ear" },
    { id: "intervals", label: "Intervals", icon: "interval" },
    { id: "harmony", label: "Harmony", icon: "harmony" },
    { id: "melody", label: "Melody", icon: "melody" }
  ] },
  { label: "Integrate", items: [
    { id: "song", label: "Song Laboratory", icon: "song" },
    { id: "skills", label: "Skill Map", icon: "skills" }
  ] }
];

const titles: Record<ViewId, { eyebrow: string; title: string }> = {
  home: { eyebrow: "NoteForge", title: "The Forge" },
  sound: { eyebrow: "Explore", title: "Sound Laboratory" },
  mirror: { eyebrow: "Produce", title: "Pitch Mirror" },
  hum: { eyebrow: "Produce", title: "Hum Laboratory" },
  control: { eyebrow: "Produce", title: "Pitch & Dynamic Control" },
  ear: { eyebrow: "Perceive", title: "Note Recognition" },
  intervals: { eyebrow: "Relate", title: "Interval Laboratory" },
  harmony: { eyebrow: "Understand", title: "Chord & Harmony Laboratory" },
  melody: { eyebrow: "Remember", title: "Melody & Phrase Laboratory" },
  song: { eyebrow: "Integrate", title: "Song Laboratory" },
  skills: { eyebrow: "Navigate", title: "Trainable Skill Graph" }
};

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { view, setView } = useLab();
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <button className="brand" onClick={() => { setView("home"); onClose(); }} aria-label="NoteForge home">
        <span className="brand-mark">N<span /></span><span><b>NOTE</b>FORGE<small>auditory · motor · harmonic</small></span>
      </button>
      <nav>
        {navigation.map((group) => (
          <div className="nav-group" key={group.label}>
            <span>{group.label}</span>
            {group.items.map((item) => (
              <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); onClose(); }}>
                <Icon name={item.icon} size={19} /><span>{item.label}</span>{view === item.id && <i />}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="offline-status"><span /> LOCAL · OFFLINE READY</div>
        <p>No account. No cloud. Your voice stays here.</p>
      </div>
    </aside>
  );
}

function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toleranceCents, setToleranceCents, expertMode, setExpertMode } = useLab();
  return (
    <div className={`drawer-backdrop ${open ? "open" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="settings-drawer" aria-hidden={!open}>
        <div className="drawer-header"><div><span>Instrument</span><h2>Training settings</h2></div><button onClick={onClose} aria-label="Close settings">×</button></div>
        <label className="settings-block"><span>Pitch tolerance <b>±{toleranceCents} cents</b></span><input type="range" min="5" max="50" step="5" value={toleranceCents} onChange={(event) => setToleranceCents(Number(event.target.value))} /><small>Beginner 35¢ · Developing 20¢ · Precise 10¢</small></label>
        <label className="settings-toggle"><span><b>Expert / debug view</b><small>Raw frequency, confidence, RMS, and detection evidence.</small></span><input type="checkbox" checked={expertMode} onChange={(event) => setExpertMode(event.target.checked)} /></label>
        <div className="privacy-note"><Icon name="record" size={18} /><span><b>Recording is opt-in.</b> Standard sessions retain contours and metrics, not microphone audio.</span></div>
      </aside>
    </div>
  );
}

function Topbar({ onMenu, onSettings }: { onMenu: () => void; onSettings: () => void }) {
  const { view, selectedMidi, centsOffset, tonicPitchClass, scaleId, chordQuality, labelsHidden } = useLab();
  const title = titles[view];
  return (
    <header className="topbar">
      <button className="mobile-menu" onClick={onMenu} aria-label="Open menu"><span /><span /></button>
      <div className="page-title"><span>{title.eyebrow}</span><h2>{title.title}</h2></div>
      <div className="coordinate-strip" aria-label="Shared musical context">
        <div><small>Target</small><b>{labelsHidden ? "Hidden" : noteLabel(selectedMidi)}</b>{!labelsHidden && <em>{centsOffset >= 0 ? "+" : ""}{centsOffset}¢</em>}</div>
        <div><small>Tonic</small><b>{pitchClassLabel(tonicPitchClass)}</b></div>
        <div className="wide"><small>Context</small><b>{SCALE_PRESETS[scaleId]?.label ?? scaleId} · {CHORD_PRESETS[chordQuality]?.label ?? chordQuality}</b></div>
      </div>
      <button className="icon-button" onClick={onSettings} aria-label="Settings"><Icon name="settings" size={20} /></button>
    </header>
  );
}

export function App() {
  const { view } = useLab();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const screen = {
    home: <Home />, sound: <SoundLab />, mirror: <PitchMirror />, hum: <HumLab />, control: <PitchControl />, ear: <EarLab />,
    intervals: <IntervalLab />, harmony: <HarmonyLab />, melody: <MelodyLab />, song: <SongLab />, skills: <SkillMap />
  }[view];

  return (
    <div className="app-shell">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      {menuOpen && <button className="menu-scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />}
      <main className="workspace">
        <Topbar onMenu={() => setMenuOpen(true)} onSettings={() => setSettingsOpen(true)} />
        {screen}
      </main>
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
