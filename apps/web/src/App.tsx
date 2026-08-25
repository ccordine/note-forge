import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type RefObject,
} from "react";
import { Navigate } from "react-router";
import { useUserPreferences } from "@/state/UserPreferencesContext";
import { useAppNavigation } from "@/routing/use-app-navigation";
import { Icon } from "@/ui/Icon";
import {
  DEFAULT_ROUTES,
  NAVIGATION,
  PAGE_TITLES,
  appRoutePath,
  appRouteScreen,
  type AppRoute,
  type AppScreenId,
} from "@/navigation";
import { useAudioInputStatus, type AudioInputController } from "@/audio/use-audio-input";
import { RouteLink } from "@/ui/Controls";

const SURFACES = {
  home: lazy(() => import("@/features/home/Home").then((module) => ({ default: module.Home }))),
  practice: lazy(() => import("@/features/practice/Practice").then((module) => ({ default: module.Practice }))),
  arcade: lazy(() => import("@/features/voice-arcade/VoiceArcade").then((module) => ({ default: module.VoiceArcade }))),
  explore: lazy(() => import("@/features/sound-lab/SoundLab").then((module) => ({ default: module.SoundLab }))),
  songs: lazy(() => import("@/features/song-lab/SongLab").then((module) => ({ default: module.SongLab }))),
  progress: lazy(() => import("@/features/range-simulator/RangeSimulator").then((module) => ({ default: module.RangeSimulator }))),
} satisfies Record<AppRoute["surface"], LazyExoticComponent<ComponentType>>;

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

function NavigationContents({ route, onNavigate }: {
  route: AppRoute;
  onNavigate?: () => void;
}) {
  return (
    <>
      <RouteLink className="brand" route={DEFAULT_ROUTES.home} onClick={onNavigate} aria-label="NoteForge home">
        <span className="brand-mark">N<span /></span><span><b>NOTE</b>FORGE<small>auditory · motor · harmonic</small></span>
      </RouteLink>
      <nav aria-label="Product">
        <div className="nav-group">
          <span>Workspaces</span>
          {NAVIGATION.map((item) => {
            const active = route.surface === item.surface;
            return (
              <RouteLink key={item.surface} route={item.route} className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={onNavigate}>
                <Icon name={item.icon} size={19} /><span>{item.label}</span>{active && <i />}
              </RouteLink>
            );
          })}
        </div>
      </nav>
      <div className="sidebar-foot">
        <div className="offline-status"><span /> LOCAL-FIRST · NO RAW AUDIO UPLOAD</div>
        <p>No account. Raw voice audio stays on this device. Remote derived diagnostics are off unless you explicitly enable them.</p>
      </div>
    </>
  );
}

function MobileNavigationDialog({ open, onDismiss, route, returnFocusRef }: {
  open: boolean;
  onDismiss: () => void;
  route: AppRoute;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const close = useCallback(() => dialogRef.current?.close(), []);
  return (
    <dialog
      ref={dialogRef}
      className="sidebar mobile-sidebar"
      aria-label="NoteForge navigation"
      onClose={() => {
        onDismiss();
        window.requestAnimationFrame(() => returnFocusRef.current?.focus({ preventScroll: true }));
      }}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <NavigationContents route={route} onNavigate={close} />
    </dialog>
  );
}

function SettingsDialog({ onDismiss, returnFocusRef }: {
  onDismiss: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const {
    remotePitchDiagnosticsEnabled,
    setRemotePitchDiagnosticsEnabled,
    toleranceCents,
    setToleranceCents,
  } = useUserPreferences();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, []);
  const close = useCallback(() => dialogRef.current?.close(), []);
  return (
    <dialog
      ref={dialogRef}
      className="drawer-backdrop open"
      aria-labelledby="settings-title"
      onClose={() => {
        onDismiss();
        window.requestAnimationFrame(() => returnFocusRef.current?.focus({ preventScroll: true }));
      }}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section className="settings-drawer">
        <div className="drawer-header"><div><span>Instrument</span><h2 id="settings-title">Training settings</h2></div><button onClick={close} aria-label="Close settings">×</button></div>
        <label className="settings-block"><span>Pitch tolerance <b>±{toleranceCents} cents</b></span><input type="range" min="5" max="50" step="5" value={toleranceCents} onChange={(event) => setToleranceCents(Number(event.target.value))} /><small>Beginner 35¢ · Developing 20¢ · Precise 10¢</small></label>
        <label className="settings-block diagnostic-consent"><span>Share derived pitch diagnostics <b>{remotePitchDiagnosticsEnabled ? "ON" : "OFF"}</b></span><input data-remote-pitch-diagnostics-toggle type="checkbox" checked={remotePitchDiagnosticsEnabled} onChange={(event) => setRemotePitchDiagnosticsEnabled(event.target.checked)} /><small>Explicit troubleshooting opt-in. Sends bounded detector/sample facts to this NoteForge server; never microphone PCM or exercise targets.</small></label>
        <div className="privacy-note"><Icon name="record" size={18} /><span><b>Recording is separately opt-in.</b> Raw microphone audio stays local.</span></div>
      </section>
    </dialog>
  );
}

function Topbar({ screen, onMenu, onSettings, menuButtonRef, settingsButtonRef }: {
  screen: AppScreenId;
  onMenu: () => void;
  onSettings: () => void;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
  settingsButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const input = useAudioInputStatus();
  const title = PAGE_TITLES[screen];
  const status = {
    disabled: "Voice input off",
    opening: "Opening microphone",
    running: "Microphone active",
    error: "Microphone error",
  }[input.state];
  return (
    <header className="topbar">
      <button ref={menuButtonRef} className="mobile-menu" onClick={onMenu} aria-label="Open menu"><span /><span /></button>
      <div className="page-title"><span>{title.eyebrow}</span><h2>{title.title}</h2></div>
      <div className={`global-mic-control ${input.state}`} role="status" aria-live="polite" title={input.error || undefined}>
        <span><i /> {status}</span>
        <MicrophoneAction input={input} />
      </div>
      <button ref={settingsButtonRef} data-settings-open className="icon-button" onClick={onSettings} aria-label="Settings"><Icon name="settings" size={20} /></button>
    </header>
  );
}

function MicrophoneAction({ input }: { input: AudioInputController }) {
  switch (input.state) {
    case "disabled":
      return <button type="button" data-global-mic-enable onClick={() => { void input.enable(); }}>Enable voice</button>;
    case "opening":
      return null;
    case "running":
      return <button type="button" data-global-mic-disable onClick={input.disable}>Disable voice</button>;
    case "error":
      return <button type="button" data-global-mic-enable onClick={() => { void input.enable(); }}>Retry voice</button>;
  }
}

export function App() {
  const { route, valid } = useAppNavigation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const compactSidebar = useCompactSidebar();
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  if (!valid) return <Navigate to={appRoutePath(DEFAULT_ROUTES.home)} replace />;

  const screen = appRouteScreen(route);
  const Surface = SURFACES[route.surface];
  return (
    <div className="app-shell">
      {compactSidebar
        ? <MobileNavigationDialog open={menuOpen} onDismiss={closeMenu} route={route} returnFocusRef={menuButtonRef} />
        : <aside className="sidebar" inert={settingsOpen}><NavigationContents route={route} /></aside>}
      <main className="workspace" inert={settingsOpen || (compactSidebar && menuOpen)}>
        <Topbar screen={screen} onMenu={() => setMenuOpen(true)} onSettings={() => setSettingsOpen(true)} menuButtonRef={menuButtonRef} settingsButtonRef={settingsButtonRef} />
        <Suspense fallback={<RouteLoading title={PAGE_TITLES[screen].title} />}><Surface /></Suspense>
      </main>
      {settingsOpen && <SettingsDialog onDismiss={closeSettings} returnFocusRef={settingsButtonRef} />}
    </div>
  );
}
