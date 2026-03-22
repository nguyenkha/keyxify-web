import { createContext, useContext, useState, type ReactNode } from "react";
import { getUserOverrides, setUserOverrides } from "../lib/userOverrides";

const HideBalancesContext = createContext<{
  hidden: boolean;
  toggle: () => void;
}>({ hidden: false, toggle: () => {} });

export function HideBalancesProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(() => getUserOverrides().hide_balances === true);

  function toggle() {
    setHidden((prev) => {
      const next = !prev;
      const overrides = getUserOverrides();
      if (next) overrides.hide_balances = true;
      else delete overrides.hide_balances;
      setUserOverrides(overrides);
      return next;
    });
  }

  return (
    <HideBalancesContext.Provider value={{ hidden, toggle }}>
      {children}
    </HideBalancesContext.Provider>
  );
}

export function useHideBalances() {
  return useContext(HideBalancesContext);
}

/** Mask a balance string when hidden */
export function maskBalance(value: string, hidden: boolean): string {
  if (!hidden) return value;
  return "••••";
}
