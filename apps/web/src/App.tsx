import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent, type RefObject } from "react";
import { useLab } from "@/state/LabContext";
import { noteLabel, pitchClassLabel, SCALE_PRESETS, CHORD_PRESETS } from "@/lib/music-display";
import { Icon } from "@/ui/Icon";
import { NAVIGATION, VIEW_TITLES, type ViewId } from "@/navigation";
import { useAudioInputStatus } from "@/audio/use-audio-input";

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex='-1'])";

const SCREENS = {
  home: lazy(() => import("@/features/home/Home").then((module) => ({ default: module.Home }))),
  sound: lazy(() => import("@/features/sound-lab/SoundLab").then((module) => ({ default: module.SoundLab }))),
  mirror: lazy(() => import("@/features/pitch-mirror/PitchMirror").then((module) => ({ default: module.PitchMirror }))),
  hum: lazy(() => import("@/features/hum-lab/HumLab").then((module) => ({ default: module.HumLab }))),
  "range-map": lazy(() => import("@/features/range-simulator/RangeSimulator").then((module) => ({ default: module.RangeSimulator }))),
  loop: lazy(() => import("@/features/range-loop/RangeLoop").then((module) => ({ default: module.RangeLoop }))),
  arcade: lazy(() => import("@/features/voice-arcade/VoiceArcade").then((module) => ({ default: module.VoiceArcade }))),
  control: lazy(() => import("@/features/pitch-control/PitchControl").then((module) => ({ default: module.PitchControl }))),
  ear: lazy(() => import("@/features/ear-training/EarLab").then((module) => ({ default: module.EarLab }))),
  intervals: lazy(() => import("@/features/intervals/IntervalLab").then((module) => ({ default: module.IntervalLab }))),
  harmony: lazy(() => import("@/features/harmony/HarmonyLab").then((module) => ({ default: module.HarmonyLab }))),
  melody: lazy(() => import("@/features/melody/MelodyLab").then((module) => ({ default: module.MelodyLab }))),
  song: lazy(() => import("@/features/song-lab/SongLab").then((module) => ({ default: module.SongLab }))),
  skills: lazy(() => import("@/features/skills/SkillMap").then((module) => ({ default: module.SkillMap }))),
} satisfies Record<ViewId, LazyExoticComponent<ComponentType>>;

function RouteLoading({ title }: { title: string }) {
  return <div className="route-loading" role="status"><span /> Loading {title}…</div>;
}

function useCompactSidebar(): boolean {
  const [compact, setCompact] = useState(() => typeof window !== "undefined"
    && window.matchMedia("(max-width: 1040px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1040px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

function Sidebar({ open, onClose, inactive, asideRef }: {
  open: boolean;
  onClose: () => void;
  inactive: boolean;
  asideRef: RefObject<HTMLElement | null>;
}) {
  const { view, setView } = useLab();
  return (
    <aside ref={asideRef} className={`sidebar ${open ? "open" : ""}`} inert={inactive} aria-hidden={inactive} role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label={open ? "NoteForge navigation" : undefined} tabIndex={-1}>
      <button className="brand" onClick={() => { setView("home"); onClose(); }} aria-label="NoteForge home">
        <span className="brand-mark">N<span /></span><span><b>NOTE</b>FORGE<small>auditory · motor · harmonic</small></span>
      </button>
      <nav>
        {NAVIGATION.map((group) => (
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
        <div className="offline-status"><span /> LOCAL-FIRST · NO RAW AUDIO UPLOAD</div>
        <p>No account. Raw voice audio stays on this device; bounded derived pitch diagnostics go only to this NoteForge server.</p>
      </div>
    </aside>
  );
}

function SettingsDrawer({ onClose, returnFocusRef }: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const { toleranceCents, setToleranceCents, expertMode, setExpertMode } = useLab();
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = priorOverflow;
      returnFocusRef.current?.focus({ preventScroll: true });
    };
  }, [onClose, returnFocusRef]);
  return (
    <div className="drawer-backdrop open" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside ref={dialogRef} className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
        <div className="drawer-header"><div><span>Instrument</span><h2 id="settings-title">Training settings</h2></div><button onClick={onClose} aria-label="Close settings">×</button></div>
        <label className="settings-block"><span>Pitch tolerance <b>±{toleranceCents} cents</b></span><input type="range" min="5" max="50" step="5" value={toleranceCents} onChange={(event) => setToleranceCents(Number(event.target.value))} /><small>Beginner 35¢ · Developing 20¢ · Precise 10¢</small></label>
        <label className="settings-toggle"><span><b>Expert / debug view</b><small>Raw frequency, confidence, RMS, and detection evidence.</small></span><input type="checkbox" checked={expertMode} onChange={(event) => setExpertMode(event.target.checked)} /></label>
        <div className="privacy-note"><Icon name="record" size={18} /><span><b>Recording is opt-in.</b> Standard sessions send bounded derived pitch diagnostics for troubleshooting, never microphone PCM.</span></div>
      </aside>
    </div>
  );
}

function Topbar({ onMenu, onSettings, menuButtonRef, settingsButtonRef }: {
  onMenu: () => void;
  onSettings: () => void;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
  settingsButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { view, selectedMidi, centsOffset, tonicPitchClass, scaleId, chordQuality, labelsHidden } = useLab();
  const input = useAudioInputStatus();
  const title = VIEW_TITLES[view];
  return (
    <header className="topbar">
      <button ref={menuButtonRef} className="mobile-menu" onClick={onMenu} aria-label="Open menu"><span /><span /></button>
      <div className="page-title"><span>{title.eyebrow}</span><h2>{title.title}</h2></div>
      <div className="coordinate-strip" aria-label="Shared musical context">
        {view === "ear"
          ? <div className="wide"><small>Prompt</small><b>Hidden until answer</b></div>
          : <div><small>Target</small><b>{labelsHidden ? "Hidden" : noteLabel(selectedMidi)}</b>{!labelsHidden && <em>{centsOffset >= 0 ? "+" : ""}{centsOffset}¢</em>}</div>}
        <div><small>Tonic</small><b>{pitchClassLabel(tonicPitchClass)}</b></div>
        <div className="wide"><small>Context</small><b>{SCALE_PRESETS[scaleId]?.label ?? scaleId} · {CHORD_PRESETS[chordQuality]?.label ?? chordQuality}</b></div>
      </div>
      {input.state !== "disabled" && (
        <div className={`global-mic-control ${input.state}`} role="status" aria-live="polite">
          <span><i /> Microphone {input.state === "running" ? "active" : input.state === "opening" ? "opening" : "needs attention"}</span>
          <button type="button" onClick={input.disable}>Stop</button>
        </div>
      )}
      <button ref={settingsButtonRef} className="icon-button" onClick={onSettings} aria-label="Settings"><Icon name="settings" size={20} /></button>
    </header>
  );
}

export function App() {
  const { view } = useLab();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const compactSidebar = useCompactSidebar();
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    if (compactSidebar) menuButtonRef.current?.focus({ preventScroll: true });
  }, [compactSidebar]);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  useEffect(() => {
    if (!compactSidebar || !menuOpen) return;
    sidebarRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key !== "Tab" || !sidebarRef.current) return;
      const focusable = [...sidebarRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        sidebarRef.current.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === sidebarRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeMenu, compactSidebar, menuOpen]);
  const Screen = SCREENS[view];

  return (
    <div className="app-shell">
      <Sidebar open={compactSidebar && menuOpen} onClose={closeMenu} inactive={settingsOpen || (compactSidebar && !menuOpen)} asideRef={sidebarRef} />
      {compactSidebar && menuOpen && <button className="menu-scrim" aria-label="Close menu" onClick={closeMenu} />}
      <main className="workspace" inert={settingsOpen || (compactSidebar && menuOpen)}>
        <Topbar onMenu={() => setMenuOpen(true)} onSettings={() => setSettingsOpen(true)} menuButtonRef={menuButtonRef} settingsButtonRef={settingsButtonRef} />
        <Suspense fallback={<RouteLoading title={VIEW_TITLES[view].title} />}><Screen /></Suspense>
      </main>
      {settingsOpen && <SettingsDrawer onClose={closeSettings} returnFocusRef={settingsButtonRef} />}
    </div>
  );
}
