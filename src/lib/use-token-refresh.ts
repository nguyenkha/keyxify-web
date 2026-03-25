import { useEffect, useRef } from "react";
import { getToken, getTokenTtl, refreshToken } from "./auth";

const ACTIVITY_EVENTS = ["mousemove", "keydown", "touchstart", "scroll", "click"] as const;
const THROTTLE_MS = 5000;
const CHECK_INTERVAL_MS = 30_000; // Check token TTL every 30s

/**
 * Auto-refreshes the session JWT while the user is active.
 * Requires a valid session JWT — calls onExpired when it expires.
 * Does NOT use refresh tokens (passkey required for that).
 */
export function useTokenRefresh({ onExpired }: { onExpired: () => void }) {
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;
  const lastActivityRef = useRef(Date.now());
  const refreshingRef = useRef(false);

  useEffect(() => {
    if (!getToken()) return;

    function markActivity() {
      const now = Date.now();
      if (now - lastActivityRef.current < THROTTLE_MS) return;
      lastActivityRef.current = now;
    }

    async function checkAndRefresh() {
      if (refreshingRef.current) return;
      if (!getToken()) return;

      const ttl = getTokenTtl();

      // Session JWT expired — need passkey to get new one
      if (ttl <= 0) {
        onExpiredRef.current();
        return;
      }

      // Refresh at 50% of TTL remaining (minimum 30s before expiry)
      const halfTtl = ttl / 2;
      const shouldRefresh = halfTtl <= (CHECK_INTERVAL_MS / 1000) || ttl <= 60;

      // Only refresh if user was recently active (within 2x check interval)
      const timeSinceActivity = Date.now() - lastActivityRef.current;
      const isActive = timeSinceActivity < CHECK_INTERVAL_MS * 2;

      if (shouldRefresh && isActive) {
        refreshingRef.current = true;
        try {
          const result = await refreshToken();
          if (!result) {
            // Session JWT was rejected — expired between check and request
            onExpiredRef.current();
          }
        } finally {
          refreshingRef.current = false;
        }
      }
    }

    // Run check immediately then on interval
    checkAndRefresh();
    const interval = setInterval(checkAndRefresh, CHECK_INTERVAL_MS);

    for (const event of ACTIVITY_EVENTS) {
      document.addEventListener(event, markActivity, { passive: true });
    }

    // When tab becomes visible, check immediately
    function handleVisibility() {
      if (!document.hidden) checkAndRefresh();
    }
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(interval);
      for (const event of ACTIVITY_EVENTS) {
        document.removeEventListener(event, markActivity);
      }
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);
}
