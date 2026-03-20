import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { MeUser } from "../lib/auth";
import { PasskeyChallenge } from "./PasskeyChallenge";
import { sensitiveHeaders } from "../lib/passkey";
import { apiUrl } from "../lib/apiBase";
import { ErrorBox, Button } from "./ui";

type Action = "idle" | "freeze-confirm" | "unfreeze-challenge" | "cancel-challenge";

export function FrozenBanner({
  user,
  onUpdate,
}: {
  user: MeUser;
  onUpdate: () => void;
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState<Action>("idle");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [, setTick] = useState(0);

  function formatCountdown(target: string): string {
    const diff = new Date(target).getTime() - Date.now();
    if (diff <= 0) return t("freeze.unfreeze") + "…";
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    return `${h}h ${m}m`;
  }

  const frozen = !!user.frozenAt;
  const pendingUnfreeze = frozen && !!user.unfreezeAt;

  const dismiss = useCallback(() => {
    if (!loading) setAction("idle");
  }, [loading]);

  // Escape key dismisses dialogs
  useEffect(() => {
    if (action === "idle") return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [action, dismiss]);

  // Refresh countdown every 30s
  useEffect(() => {
    if (!pendingUnfreeze) return;
    const iv = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(iv);
  }, [pendingUnfreeze]);

  async function confirmFreeze() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiUrl("/api/account/freeze"), {
        method: "POST",
        headers: sensitiveHeaders(),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t("freeze.failedToFreeze"));
      }
      onUpdate();
      setAction("idle");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function doUnfreeze() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiUrl("/api/account/unfreeze"), {
        method: "POST",
        headers: sensitiveHeaders(),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t("freeze.failedToUnfreeze"));
      }
      onUpdate();
      setAction("idle");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function doCancelUnfreeze() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiUrl("/api/account/unfreeze"), {
        method: "DELETE",
        headers: sensitiveHeaders(),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t("freeze.failedToCancelUnfreeze"));
      }
      onUpdate();
      setAction("idle");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  // Non-frozen: show freeze button in sidebar
  if (!frozen) {
    return (
      <>
        {action === "freeze-confirm" && createPortal(
          <div className="fixed inset-0 z-50 bg-surface-primary flex items-center justify-center p-4">
            <div className="max-w-sm w-full text-center">
              <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-text-primary mb-1">kexify</h1>
              <p className="text-[11px] text-text-muted mb-6">keys simplified</p>
              <p className="text-sm text-text-secondary mb-2">
                {t("freeze.title")}
              </p>
              <p className="text-xs text-text-muted mb-6 leading-relaxed">
                {t("freeze.description")}
              </p>

              {error && <ErrorBox className="mb-4">{error}</ErrorBox>}

              <Button variant="danger" fullWidth onClick={confirmFreeze} disabled={loading}>
                {loading ? t("freeze.freezing") : `🥶 ${t("freeze.freezeMyAccount")}`}
              </Button>
              <div className="mt-3">
                <Button variant="secondary" fullWidth onClick={dismiss} disabled={loading}>
                  {t("freeze.cancel")}
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}
        <button
          onClick={() => setAction("freeze-confirm")}
          className="w-full text-left px-3 py-2 rounded-md text-xs text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary transition-colors"
          title={t("freeze.freezeTooltip")}
        >
          🥶 {t("freeze.freezeAccount")}
        </button>
      </>
    );
  }

  // Frozen state
  return (
    <>
      {/* Unfreeze passkey challenge */}
      {action === "unfreeze-challenge" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={dismiss} />
          <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
            <div className="px-5 py-4 border-b border-border-primary flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">🔓 {t("freeze.unfreezeAccount")}</h3>
              <button
                onClick={dismiss}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-5 space-y-4">
              <p className="text-sm text-text-secondary">
                {t("freeze.unfreezePasskeyDesc")}
              </p>
              <PasskeyChallenge
                onAuthenticated={() => doUnfreeze()}
                onCancel={dismiss}
              />
            </div>
          </div>
        </div>
      )}

      {/* Cancel unfreeze passkey challenge */}
      {action === "cancel-challenge" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={dismiss} />
          <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
            <div className="px-5 py-4 border-b border-border-primary flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">🥶 {t("freeze.cancelUnfreeze")}</h3>
              <button
                onClick={dismiss}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-5 space-y-4">
              <p className="text-sm text-text-secondary">
                {t("freeze.cancelUnfreezePasskeyDesc")}
              </p>
              <PasskeyChallenge
                onAuthenticated={() => doCancelUnfreeze()}
                onCancel={dismiss}
              />
            </div>
          </div>
        </div>
      )}

      {/* Frozen banner */}
      <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5 mb-4">
        <div className="flex items-start gap-2">
          <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-red-400 leading-relaxed">
              {t("freeze.accountFrozenBanner")}
              {pendingUnfreeze && (
                <span className="text-text-tertiary"> {t("freeze.unfreezeIn", { time: formatCountdown(user.unfreezeAt!) })}</span>
              )}
            </p>
            {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
          </div>
          <div className="shrink-0">
            {pendingUnfreeze ? (
              <button
                onClick={() => setAction("cancel-challenge")}
                disabled={loading}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:text-text-muted disabled:cursor-not-allowed"
              >
                {t("freeze.cancel")}
              </button>
            ) : (
              <button
                onClick={() => setAction("unfreeze-challenge")}
                disabled={loading}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:text-text-muted disabled:cursor-not-allowed"
              >
                {t("freeze.unfreeze")}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
