import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { registerPasskey, authenticatePasskey } from "../lib/passkey";
import { ErrorBox } from "./ui";

/**
 * Blocking dialog shown when a user with zero passkeys attempts a sensitive operation.
 * Forces registration of at least one passkey before proceeding.
 *
 * Props:
 *  - inline: if true, renders as an inline card instead of a modal overlay (for embedding in other dialogs)
 */
export function PasskeyGate({
  onRegistered,
  onCancel,
  inline,
  onRegisteredWithPrf,
}: {
  onRegistered: () => void;
  onCancel: () => void;
  inline?: boolean;
  /** If provided, called with PRF key + credentialId after register+auth (avoids extra passkey prompt) */
  onRegisteredWithPrf?: (prfKey: CryptoKey, credentialId: string) => void;
}) {
  const { t } = useTranslation();
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState("");

  async function handleRegister() {
    setRegistering(true);
    setError("");
    try {
      await registerPasskey();
      // After registration, authenticate immediately to get a token + PRF key
      const auth = await authenticatePasskey({ withPrf: true });
      if (onRegisteredWithPrf && auth.prfKey && auth.credentialId) {
        onRegisteredWithPrf(auth.prfKey, auth.credentialId);
      } else {
        onRegistered();
      }
    } catch (err) {
      setError(String(err));
      setRegistering(false);
    }
  }

  useEffect(() => {
    if (inline) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !registering) onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [registering, onCancel, inline]);

  const content = (
    <div className="text-center py-4">
      {/* Fingerprint icon */}
      <div className="w-14 h-14 rounded-full bg-blue-500/10 flex items-center justify-center mx-auto mb-4">
        <svg className="w-7 h-7 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004 10.5a7.464 7.464 0 01-1.15 3.993m1.989 3.559A11.209 11.209 0 008.25 10.5a3.75 3.75 0 117.5 0c0 .527-.021 1.049-.064 1.565M12 10.5a14.94 14.94 0 01-3.6 9.75m6.633-4.596a18.666 18.666 0 01-2.485 5.33" />
        </svg>
      </div>
      <p className="text-sm font-medium text-text-primary mb-2">
        {inline ? t("passkey.gate.inlineTitle") : t("passkey.gate.title")}
      </p>
      <p className="text-xs text-text-muted leading-relaxed mb-2 max-w-[300px] mx-auto">
        {inline ? t("passkey.gate.inlineDesc") : t("passkey.gate.desc")}
      </p>

      {error && <ErrorBox className="mb-4">{error}</ErrorBox>}

      <div className="flex gap-3 justify-center">
        {!inline && (
          <button
            onClick={onCancel}
            disabled={registering}
            className="px-4 py-2.5 rounded-lg text-xs font-medium bg-surface-tertiary text-text-secondary hover:bg-border-primary transition-colors disabled:opacity-40"
          >
            {t("passkey.gate.cancel")}
          </button>
        )}
        <button
          onClick={handleRegister}
          disabled={registering}
          className={`px-5 py-2.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-60 ${inline ? "w-full" : ""}`}
        >
          {registering ? t("passkey.gate.authenticating") : t("passkey.gate.authenticate")}
        </button>
      </div>
      {inline && (
        <button
          onClick={onCancel}
          disabled={registering}
          className="mt-3 text-xs text-text-muted hover:text-text-tertiary transition-colors disabled:opacity-40"
        >
          {t("passkey.gate.cancel")}
        </button>
      )}
    </div>
  );

  if (inline) return content;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={!registering ? onCancel : undefined} />
      <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <h3 className="text-sm font-semibold text-text-primary">{t("passkey.gate.title")}</h3>
        </div>

        {/* Body */}
        <div className="px-5 py-5">
          {content}
        </div>
      </div>
    </div>
  );
}
