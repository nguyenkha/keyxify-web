import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { authenticatePasskey, type PasskeyAuthResult } from "../lib/passkey";

/**
 * Modal that prompts passkey authentication before a sensitive action proceeds.
 * Shows a "Verify" button — WebAuthn must be triggered by user gesture (Safari requirement).
 */
export function PasskeyChallenge({
  onAuthenticated,
  onCancel,
  withPrf,
  autoStart,
}: {
  onAuthenticated: (result: PasskeyAuthResult) => void;
  onCancel: () => void;
  withPrf?: boolean;
  /** Start authentication immediately on mount (caller must ensure user gesture context). */
  autoStart?: boolean;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const [authenticating, setAuthenticating] = useState(!!autoStart);
  const startedRef = useRef(false);

  async function doAuth() {
    setAuthenticating(true);
    setError("");
    try {
      const result = await authenticatePasskey({ withPrf });
      onAuthenticated(result);
    } catch (err) {
      setError(String(err));
      setAuthenticating(false);
    }
  }

  useEffect(() => {
    if (autoStart && !startedRef.current) {
      startedRef.current = true;
      doAuth(); // eslint-disable-line react-hooks/set-state-in-effect -- intentional: auto-start passkey on mount
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !authenticating) onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [authenticating, onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={!authenticating ? onCancel : undefined} />
      <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <h3 className="text-sm font-semibold text-text-primary">🔑 {t("passkey.challenge.title")}</h3>
          {!authenticating && (
            <button
              onClick={onCancel}
              className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-5">
          <div className="text-center py-4">
            {error ? (
              <>
                <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-text-primary mb-1">Authentication Failed</p>
                <p className="text-xs text-red-400 break-all mb-5">{error}</p>
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={onCancel}
                    className="px-4 py-2.5 rounded-lg text-xs font-medium bg-surface-tertiary text-text-secondary hover:bg-border-primary transition-colors"
                  >
                    {t("passkey.challenge.cancel")}
                  </button>
                  <button
                    onClick={doAuth}
                    className="px-4 py-2.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                  >
                    {t("common.retry")}
                  </button>
                </div>
              </>
            ) : authenticating ? (
              <>
                {/* Fingerprint icon — waiting for browser prompt */}
                <div className="w-14 h-14 rounded-full bg-blue-500/10 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-7 h-7 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004 10.5a7.464 7.464 0 01-1.15 3.993m1.989 3.559A11.209 11.209 0 008.25 10.5a3.75 3.75 0 117.5 0c0 .527-.021 1.049-.064 1.565M12 10.5a14.94 14.94 0 01-3.6 9.75m6.633-4.596a18.666 18.666 0 01-2.485 5.33" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-text-primary mb-1">{t("passkey.challenge.title")}</p>
                <p className="text-xs text-text-muted">{t("passkey.challenge.desc")}</p>
              </>
            ) : (
              <>
                {/* Fingerprint icon — ready to verify */}
                <div className="w-14 h-14 rounded-full bg-blue-500/10 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-7 h-7 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004 10.5a7.464 7.464 0 01-1.15 3.993m1.989 3.559A11.209 11.209 0 008.25 10.5a3.75 3.75 0 117.5 0c0 .527-.021 1.049-.064 1.565M12 10.5a14.94 14.94 0 01-3.6 9.75m6.633-4.596a18.666 18.666 0 01-2.485 5.33" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-text-primary mb-2">{t("passkey.challenge.title")}</p>
                <p className="text-xs text-text-muted mb-5">{t("passkey.challenge.desc")}</p>
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={onCancel}
                    className="px-4 py-2.5 rounded-lg text-xs font-medium bg-surface-tertiary text-text-secondary hover:bg-border-primary transition-colors"
                  >
                    {t("passkey.challenge.cancel")}
                  </button>
                  <button
                    onClick={doAuth}
                    className="px-5 py-2.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                  >
                    {t("passkey.challenge.confirm")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
