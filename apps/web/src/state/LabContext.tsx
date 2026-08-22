import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import type { Timbre } from "@/audio/synth";

export type ViewId = "home" | "sound" | "mirror" | "hum" | "control" | "ear" | "intervals" | "harmony" | "melody" | "song" | "skills";
export type PlaybackMode = "simultaneous" | "sequential";

interface LabContextValue {
  view: ViewId;
  setView: (view: ViewId) => void;
  selectedMidi: number;
  setSelectedMidi: (midi: number) => void;
  centsOffset: number;
  setCentsOffset: (cents: number) => void;
  compareMidi: number;
  setCompareMidi: (midi: number) => void;
  compareCents: number;
  setCompareCents: (cents: number) => void;
  tonicPitchClass: number;
  setTonicPitchClass: (pitchClass: number) => void;
  scaleId: string;
  setScaleId: (scaleId: string) => void;
  chordQuality: string;
  setChordQuality: (quality: string) => void;
  timbre: Timbre;
  setTimbre: (timbre: Timbre) => void;
  playbackMode: PlaybackMode;
  setPlaybackMode: (mode: PlaybackMode) => void;
  labelsHidden: boolean;
  setLabelsHidden: (hidden: boolean) => void;
  toleranceCents: number;
  setToleranceCents: (cents: number) => void;
  expertMode: boolean;
  setExpertMode: (enabled: boolean) => void;
}

const LabContext = createContext<LabContextValue | null>(null);

function viewFromHash(): ViewId {
  const value = window.location.hash.slice(1) as ViewId;
  return ["home", "sound", "mirror", "hum", "control", "ear", "intervals", "harmony", "melody", "song", "skills"].includes(value)
    ? value
    : "home";
}

export function LabProvider({ children }: PropsWithChildren) {
  const [view, setViewState] = useState<ViewId>(viewFromHash);
  const [selectedMidi, setSelectedMidi] = useState(60);
  const [centsOffset, setCentsOffset] = useState(0);
  const [compareMidi, setCompareMidi] = useState(62);
  const [compareCents, setCompareCents] = useState(0);
  const [tonicPitchClass, setTonicPitchClass] = useState(0);
  const [scaleId, setScaleId] = useState("major");
  const [chordQuality, setChordQuality] = useState("major");
  const [timbre, setTimbre] = useState<Timbre>("sine");
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("sequential");
  const [labelsHidden, setLabelsHidden] = useState(false);
  const [toleranceCents, setToleranceCents] = useState(20);
  const [expertMode, setExpertMode] = useState(false);

  useEffect(() => {
    const handleHash = () => setViewState(viewFromHash());
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  const setView = (next: ViewId) => {
    setViewState(next);
    window.history.pushState(null, "", `#${next}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const value = useMemo<LabContextValue>(() => ({
    view, setView, selectedMidi, setSelectedMidi, centsOffset, setCentsOffset, compareMidi, setCompareMidi,
    compareCents, setCompareCents, tonicPitchClass, setTonicPitchClass, scaleId, setScaleId, chordQuality,
    setChordQuality, timbre, setTimbre, playbackMode, setPlaybackMode, labelsHidden, setLabelsHidden,
    toleranceCents, setToleranceCents, expertMode, setExpertMode
  }), [view, selectedMidi, centsOffset, compareMidi, compareCents, tonicPitchClass, scaleId, chordQuality, timbre,
    playbackMode, labelsHidden, toleranceCents, expertMode]);

  return <LabContext.Provider value={value}>{children}</LabContext.Provider>;
}

export function useLab(): LabContextValue {
  const context = useContext(LabContext);
  if (!context) throw new Error("useLab must be used inside LabProvider");
  return context;
}
