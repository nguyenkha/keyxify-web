import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { getMe, getIdentityId } from "../lib/auth";
import { getUserOverrides } from "../lib/userOverrides";

const ExpertModeContext = createContext<{ expert: boolean; setExpert: (v: boolean) => void }>({ expert: false, setExpert: () => {} });

export const useExpertMode = () => useContext(ExpertModeContext).expert;
export const useSetExpertMode = () => useContext(ExpertModeContext).setExpert;

export function ExpertModeProvider({ children }: { children: ReactNode }) {
  const [expert, setExpertState] = useState(false);

  useEffect(() => {
    getMe().then((me) => {
      const uid = me?.id ?? getIdentityId() ?? undefined;
      const overrides = getUserOverrides(uid);
      setExpertState(overrides.preferences?.expert_mode ?? false);
    });
  }, []);

  const setExpert = useCallback((v: boolean) => {
    setExpertState(v);
  }, []);

  return (
    <ExpertModeContext.Provider value={{ expert, setExpert }}>
      {children}
    </ExpertModeContext.Provider>
  );
}
