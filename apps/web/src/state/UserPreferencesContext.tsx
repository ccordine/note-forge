import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { pitchDiagnostics } from "@/diagnostics/pitch-diagnostics";
import {
  SettingsPersistence,
  type SettingsPersistenceResult,
} from "@/storage/settings-persistence";
import {
  USER_PREFERENCES_STORAGE_KEY,
  UserPreferencesAuthority,
} from "./user-preferences-settings";

export interface UserPreferences {
  readonly labelsHidden: boolean;
  readonly setLabelsHidden: (hidden: boolean) => void;
  readonly toleranceCents: number;
  readonly setToleranceCents: (cents: number) => void;
  readonly remotePitchDiagnosticsEnabled: boolean;
  readonly setRemotePitchDiagnosticsEnabled: (enabled: boolean) => void;
  readonly preferencesReady: boolean;
  readonly preferencesPersistenceState: SettingsPersistenceResult | "loading";
}

const UserPreferencesContext = createContext<UserPreferences | null>(null);

export function UserPreferencesProvider({ children }: PropsWithChildren) {
  const authorityRef = useRef<UserPreferencesAuthority | null>(null);
  if (authorityRef.current === null) {
    authorityRef.current = new UserPreferencesAuthority(
      new SettingsPersistence([USER_PREFERENCES_STORAGE_KEY]),
      (enabled) => pitchDiagnostics.setEnabled(enabled),
    );
  }
  const authority = authorityRef.current;
  const snapshot = useSyncExternalStore(
    authority.subscribe,
    authority.getSnapshot,
    authority.getSnapshot,
  );
  useEffect(() => {
    authority.start();
    return () => authority.dispose();
  }, [authority]);
  const value = useMemo<UserPreferences>(() => ({
    labelsHidden: snapshot.labelsHidden,
    setLabelsHidden: authority.setLabelsHidden,
    toleranceCents: snapshot.toleranceCents,
    setToleranceCents: authority.setToleranceCents,
    remotePitchDiagnosticsEnabled: snapshot.remotePitchDiagnosticsEnabled,
    setRemotePitchDiagnosticsEnabled: authority.setRemotePitchDiagnosticsEnabled,
    preferencesReady: snapshot.preferencesReady,
    preferencesPersistenceState: snapshot.preferencesPersistenceState,
  }), [authority, snapshot]);
  return <UserPreferencesContext.Provider value={value}>{children}</UserPreferencesContext.Provider>;
}

export function useUserPreferences(): UserPreferences {
  const context = useContext(UserPreferencesContext);
  if (!context) throw new Error("useUserPreferences must be used inside UserPreferencesProvider");
  return context;
}
