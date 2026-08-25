import { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from "react";
import { pitchDiagnostics } from "@/diagnostics/pitch-diagnostics";

export interface UserPreferences {
  labelsHidden: boolean;
  setLabelsHidden: (hidden: boolean) => void;
  toleranceCents: number;
  setToleranceCents: (cents: number) => void;
  remotePitchDiagnosticsEnabled: boolean;
  setRemotePitchDiagnosticsEnabled: (enabled: boolean) => void;
}

const UserPreferencesContext = createContext<UserPreferences | null>(null);

export function UserPreferencesProvider({ children }: PropsWithChildren) {
  const [labelsHidden, setLabelsHidden] = useState(false);
  const [toleranceCents, setToleranceCents] = useState(20);
  const [remotePitchDiagnosticsEnabled, setRemoteDiagnosticsState] = useState(false);
  const setRemotePitchDiagnosticsEnabled = useCallback((enabled: boolean) => {
    pitchDiagnostics.setEnabled(enabled);
    setRemoteDiagnosticsState(enabled);
  }, []);
  const value = useMemo<UserPreferences>(() => ({
    labelsHidden,
    setLabelsHidden,
    toleranceCents,
    setToleranceCents,
    remotePitchDiagnosticsEnabled,
    setRemotePitchDiagnosticsEnabled,
  }), [labelsHidden, remotePitchDiagnosticsEnabled, setRemotePitchDiagnosticsEnabled, toleranceCents]);
  return <UserPreferencesContext.Provider value={value}>{children}</UserPreferencesContext.Provider>;
}

export function useUserPreferences(): UserPreferences {
  const context = useContext(UserPreferencesContext);
  if (!context) throw new Error("useUserPreferences must be used inside UserPreferencesProvider");
  return context;
}
