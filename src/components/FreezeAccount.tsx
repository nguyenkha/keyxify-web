import { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiUrl } from "../lib/apiBase";
import { Spinner, Button } from "./ui";
import { Snowflake } from "lucide-react";

export function FreezeAccount() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token");
  const [status, setStatus] = useState<"confirm" | "loading" | "success" | "error">(
    token ? "confirm" : "error"
  );
  const [error, setError] = useState(token ? "" : "No freeze token provided");

  async function handleFreeze() {
    setStatus("loading");
    try {
      const res = await fetch(apiUrl(`/api/auth/freeze?token=${encodeURIComponent(token!)}`));
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to freeze account");
      }
      setStatus("success");
    } catch (err: unknown) {
      setStatus("error");
      setError((err as { message?: string })?.message || "Failed to freeze account");
    }
  }

  return (
    <div className="min-h-dvh bg-surface-primary flex items-center justify-center p-4">
      <div className="max-w-sm w-full text-center">
        {status === "confirm" && (
          <>
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
            <Button variant="danger" fullWidth onClick={handleFreeze}>
              <Snowflake className="w-4 h-4 inline-block align-[-2px] mr-1" />{t("freeze.freezeMyAccount")}
            </Button>
            <div className="mt-3">
              <Button variant="secondary" fullWidth onClick={() => navigate("/login")}>
                {t("freeze.cancel")}
              </Button>
            </div>
          </>
        )}

        {status === "loading" && (
          <>
            <div className="flex justify-center mb-4">
              <Spinner size="lg" />
            </div>
            <p className="text-sm font-medium text-text-secondary">{t("freeze.freezing")}</p>
            <p className="text-xs text-text-muted mt-1">{t("freeze.mayTakeSeconds")}</p>
          </>
        )}

        {status === "success" && (
          <>
            <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
            </div>
            <p className="text-lg font-semibold text-text-primary mb-1">{t("freeze.accountFrozen")}</p>
            <p className="text-xs text-text-muted mb-6">
              {t("freeze.frozenDescription")}
            </p>
            <button
              onClick={() => navigate("/accounts")}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
            >
              {t("freeze.goToDashboard")}
            </button>
          </>
        )}

        {status === "error" && (
          <>
            <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="text-sm font-medium text-text-primary mb-1">{t("freeze.couldntFreeze")}</p>
            <p className="text-xs text-red-400 break-all mb-5">{error}</p>
            <Button variant="secondary" onClick={() => navigate("/login")}>
              {t("freeze.goToLogin")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
