import { createContext, useContext, useMemo, useState, type PropsWithChildren } from "react";
import type { Timbre } from "@/audio/synth";
import type { ChordPresetId, ScalePresetId } from "@/lib/music-display";

export type PlaybackMode = "simultaneous" | "sequential";

export interface MusicalState {
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
  scaleId: ScalePresetId;
  setScaleId: (scaleId: ScalePresetId) => void;
  chordQuality: ChordPresetId;
  setChordQuality: (quality: ChordPresetId) => void;
  timbre: Timbre;
  setTimbre: (timbre: Timbre) => void;
  playbackMode: PlaybackMode;
  setPlaybackMode: (mode: PlaybackMode) => void;
}

const MusicalContext = createContext<MusicalState | null>(null);

export function MusicalProvider({ children }: PropsWithChildren) {
  const [selectedMidi, setSelectedMidi] = useState(60);
  const [centsOffset, setCentsOffset] = useState(0);
  const [compareMidi, setCompareMidi] = useState(62);
  const [compareCents, setCompareCents] = useState(0);
  const [tonicPitchClass, setTonicPitchClass] = useState(0);
  const [scaleId, setScaleId] = useState<ScalePresetId>("major");
  const [chordQuality, setChordQuality] = useState<ChordPresetId>("major");
  const [timbre, setTimbre] = useState<Timbre>("sine");
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("sequential");
  const value = useMemo<MusicalState>(() => ({
    selectedMidi, setSelectedMidi, centsOffset, setCentsOffset, compareMidi, setCompareMidi,
    compareCents, setCompareCents, tonicPitchClass, setTonicPitchClass, scaleId, setScaleId,
    chordQuality, setChordQuality, timbre, setTimbre, playbackMode, setPlaybackMode,
  }), [selectedMidi, centsOffset, compareMidi, compareCents, tonicPitchClass, scaleId, chordQuality, timbre, playbackMode]);
  return <MusicalContext.Provider value={value}>{children}</MusicalContext.Provider>;
}

export function useMusicalState(): MusicalState {
  const context = useContext(MusicalContext);
  if (!context) throw new Error("useMusicalState must be used inside MusicalProvider");
  return context;
}
