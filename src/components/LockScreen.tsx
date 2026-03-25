import { useState, useEffect, useRef } from "react";
import { useIdleLock } from "../context/IdleLockContext";
import { fetchUnlockChallenge, completePasskeyUnlock, clearPasskeyToken, type UnlockChallenge } from "../lib/passkey";
import { setTokens, clearToken } from "../lib/auth";
import { useTranslation } from "react-i18next";
import { getMe } from "../lib/auth";

const MAX_FAILURES = 3;

export function LockScreen() {
  const { locked, ownerId } = useIdleLock();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [failures, setFailures] = useState(0);
  const [email, setEmail] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const challengeRef = useRef<UnlockChallenge | null>(null);

  // Pre-fetch challenge on lock screen mount so WebAuthn fires instantly on click
  useEffect(() => {
    if (locked && ownerId) {
      setError("");
      setFailures(0);
      setLoading(false);
      challengeRef.current = null;
      // Pre-fetch challenge options
      fetchUnlockChallenge(ownerId)
        .then((c) => { challengeRef.current = c; })
        .catch(() => {}); // Will retry on click if pre-fetch fails
      // Try to get email (may fail with expired JWT)
      getMe().then((me) => setEmail(me?.email ?? "")).catch(() => {});
    }
  }, [locked, ownerId]);

  // Focus trap
  useEffect(() => {
    if (locked) buttonRef.current?.focus();
  }, [locked, loading]);

  if (!locked) return null;

  async function handleUnlock() {
    if (!ownerId) return;
    setLoading(true);
    setError("");
    try {
      // Use pre-fetched challenge, or fetch now if it wasn't ready
      let challenge = challengeRef.current;
      if (!challenge) {
        challenge = await fetchUnlockChallenge(ownerId);
      }
      challengeRef.current = null; // Consume the challenge (single-use)

      const result = await completePasskeyUnlock(challenge);
      setTokens(result.token, result.refreshToken);
      window.location.href = window.location.pathname;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setFailures((f) => f + 1);
      // Pre-fetch a fresh challenge for the next attempt
      if (ownerId) {
        fetchUnlockChallenge(ownerId)
          .then((c) => { challengeRef.current = c; })
          .catch(() => {});
      }
    } finally {
      setLoading(false);
    }
  }

  function handleSignOut() {
    clearPasskeyToken();
    clearToken();
    window.location.href = "/login";
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xl"
      role="dialog"
      aria-modal="true"
      aria-label={t("idleLock.title")}
    >
      <div className="flex flex-col items-center gap-4 max-w-sm px-6 text-center">
        {/* Lock icon */}
        <svg className="w-12 h-12 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
        </svg>

        <h2 className="text-lg font-semibold text-text-primary">{t("idleLock.title")}</h2>
        <p className="text-sm text-text-muted">{t("idleLock.description")}</p>
        {email && <p className="text-xs text-text-tertiary">{email}</p>}

        {/* Unlock button */}
        <button
          ref={buttonRef}
          onClick={handleUnlock}
          disabled={loading}
          className="w-full mt-2 px-4 py-3 rounded-lg bg-blue-600 text-white font-medium text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
                <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
              {t("idleLock.unlocking")}
            </span>
          ) : (
            t("idleLock.unlock")
          )}
        </button>

        {/* Error message */}
        {error && <p className="text-xs text-red-400">{t("idleLock.failed")}</p>}

        {/* Sign out escape hatch after 3 failures */}
        {failures >= MAX_FAILURES && (
          <div className="mt-2">
            <p className="text-xs text-text-muted mb-2">{t("idleLock.signOutHint")}</p>
            <button
              onClick={handleSignOut}
              className="text-xs text-red-400 hover:text-red-300 underline transition-colors"
            >
              {t("idleLock.signOut")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
