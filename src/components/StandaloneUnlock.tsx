// Returning standalone user unlock dialog
// PRF mode: passkey → decrypt share → share-auth → JWT
// Passphrase mode: passphrase input → decrypt share → share-auth → JWT

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getKeyShareWithPassphrase, getKeyShareWithPrf, getKeyShareMode, listKeyShares } from "../lib/keystore";
import { localPrfAuthenticate } from "../lib/passkey";
import { performShareAuth } from "../lib/share-auth";
import { ErrorBox, Spinner } from "./ui";

interface StandaloneUnlockProps {
  keyId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function StandaloneUnlock({ keyId, onClose, onSuccess }: StandaloneUnlockProps) {
  const { t } = useTranslation();
  const mode = getKeyShareMode(keyId);
  const [passphrase, setPassphrase] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPassphraseFallback, setShowPassphraseFallback] = useState(false);

  // PRF mode: don't auto-trigger — let user tap the button explicitly

  // Get credentialId from stored share for local PRF auth
  const shares = listKeyShares();
  const shareInfo = shares.find((s) => s.keyId === keyId);
  const credentialId = shareInfo?.credentialId;

  async function handlePrfUnlock() {
    setLoading(true);
    setError("");

    try {
      if (!credentialId) {
        setShowPassphraseFallback(true);
        setLoading(false);
        return;
      }

      // Local-only PRF auth (no server call — no JWT needed)
      const prfKey = await localPrfAuthenticate(credentialId);

      // Decrypt share with PRF key
      const keyData = await getKeyShareWithPrf(keyId, prfKey);
      if (!keyData) {
        setError(t("standalone.unlockFailed"));
        setLoading(false);
        return;
      }

      // Perform share-derived auth (challenge-response → JWT)
      await performShareAuth(keyData.share);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  async function handlePassphraseUnlock(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const keyData = await getKeyShareWithPassphrase(keyId, passphrase);
      if (!keyData) {
        setError(t("standalone.unlockFailed"));
        setLoading(false);
        return;
      }

      await performShareAuth(keyData.share);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  // PRF mode: show loading state while passkey authenticates
  if (mode === "prf" && !showPassphraseFallback) {
    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={loading ? undefined : onClose}>
        <div className="bg-surface-secondary border border-border-primary rounded-xl p-6 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-sm font-medium mb-4">{t("standalone.unlockTitle")}</h3>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-4">
              <Spinner className="w-5 h-5" />
              <p className="text-xs text-text-muted">{t("standalone.authenticating")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {error && <ErrorBox>{error}</ErrorBox>}
              <button
                onClick={handlePrfUnlock}
                className="w-full bg-blue-600 hover:bg-blue-700 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors text-white"
              >
                {t("standalone.unlockWithPasskey")}
              </button>
              <button
                onClick={onClose}
                className="w-full text-xs text-text-muted hover:text-text-secondary transition-colors py-1"
              >
                {t("common.cancel")}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Passphrase mode (or PRF fallback)
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface-secondary border border-border-primary rounded-xl p-6 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-medium mb-4">{t("standalone.unlockTitle")}</h3>

        <form onSubmit={handlePassphraseUnlock} className="space-y-3">
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={t("standalone.passphrasePlaceholder")}
            autoFocus
            className="w-full bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
          />

          <button
            type="submit"
            disabled={!passphrase || loading}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors text-white"
          >
            {loading ? t("common.loading") : t("standalone.unlock")}
          </button>

          {error && <ErrorBox>{error}</ErrorBox>}
        </form>
      </div>
    </div>
  );
}
