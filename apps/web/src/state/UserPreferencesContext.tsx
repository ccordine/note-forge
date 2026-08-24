import { createContext, useContext, useMemo, useState, type PropsWithChildren } from "react";

export interface UserPreferences {
  labelsHidden: boolean;
  setLabelsHidden: (hidden: boolean) => void;
  toleranceCents: number;
  setToleranceCents: (cents: number) => void;
}

const UserPreferencesContext = createContext<UserPreferences | null>(null);

export function UserPreferencesProvider({ children }: PropsWithChildren) {
  const [labelsHidden, setLabelsHidden] = useState(false);
  const [toleranceCents, setToleranceCents] = useState(20);
  const value = useMemo<UserPreferences>(() => ({
    labelsHidden,
    setLabelsHidden,
    toleranceCents,
    setToleranceCents,
  }), [labelsHidden, toleranceCents]);
  return <UserPreferencesContext.Provider value={value}>{children}</UserPreferencesContext.Provider>;
}

export function useUserPreferences(): UserPreferences {
  const context = useContext(UserPreferencesContext);
  if (!context) throw new Error("useUserPreferences must be used inside UserPreferencesProvider");
  return context;
}
