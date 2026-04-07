import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useTokenRefresh } from "../lib/use-token-refresh";
import { fetchPasskeys } from "../lib/passkey";
import { clearToken, getToken, wasAuthenticated, getTokenTtl, getIdentityId } from "../lib/auth";
import { isRecoveryMode } from "../lib/recovery";

const LS_HAS_PASSKEYS = "idleLock.hasPasskeys";

interface IdleLockContextValue {
  locked: boolean;
  /** Identity ID from the JWT (for passkey unlock) */
  ownerId: string | null;
  hasPasskeys: boolean;
  unlock: () => void;
}

const IdleLockContext = createContext<IdleLockContextValue>({
  locked: false,
  ownerId: null,
  hasPasskeys: false,
  unlock: () => {},
});

export const useIdleLock = () => useContext(IdleLockContext);

/** Read cached passkey status (survives app restart / JWT expiry) */
function getCachedHasPasskeys(): boolean {
  return localStorage.getItem(LS_HAS_PASSKEYS) === "true";
}

export function IdleLockProvider({ children }: { children: ReactNode }) {
  const [hasPasskeys, setHasPasskeys] = useState(getCachedHasPasskeys);

  // On mount: if no valid session JWT but refresh token exists → need passkey
  const [locked, setLocked] = useState(() => {
    if (isRecoveryMode()) return false;
    const hasSession = getToken() && getTokenTtl() > 0;
    if (hasSession) return false;
    if (wasAuthenticated() && getCachedHasPasskeys()) return true;
    return false;
  });

  // Compute ownerId synchronously from locked state (no effect needed)
  const [ownerId, setOwnerId] = useState<string | null>(() =>
    locked ? getIdentityId() : null
  );

  // Fetch passkeys when session JWT is valid and cache the result
  useEffect(() => {
    if (!getToken() || isRecoveryMode()) return;
    if (getTokenTtl() <= 0) return;
    fetchPasskeys()
      .then((list) => {
        const has = list.length > 0;
        setHasPasskeys(has);
        localStorage.setItem(LS_HAS_PASSKEYS, String(has));
      })
      .catch(() => {});
  }, [locked]); // Re-fetch after unlock (new session JWT available)

  // Handle session JWT expiry during active use
  const handleExpired = useCallback(() => {
    if (isRecoveryMode()) return;

    const id = getIdentityId();
    setOwnerId(id);

    if (getCachedHasPasskeys() && id) {
      setLocked(true);
    } else {
      clearToken();
      window.location.href = "/login";
    }
  }, []);

  // Auto-refresh session JWT while active (uses valid session JWT)
  useTokenRefresh({ onExpired: handleExpired });

  const unlock = useCallback(() => {
    setLocked(false);
    setOwnerId(null);
  }, []);

  return (
    <IdleLockContext.Provider value={{ locked, ownerId, hasPasskeys, unlock }}>
      {children}
    </IdleLockContext.Provider>
  );
}
