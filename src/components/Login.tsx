import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { requestMagicLink, verifyCode, setToken } from "../lib/auth";
import { getStoredTheme, setTheme } from "../lib/theme";
import { ErrorBox } from "./ui";
import { LangSwitcher } from "./LangSwitcher";

export function Login() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await requestMagicLink(email);
      setSent(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    setVerifying(true);
    setError("");
    try {
      const jwt = await verifyCode(email, code);
      setToken(jwt);
      navigate("/", { replace: true });
    } catch (err) {
      setError(String(err));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="min-h-dvh bg-surface-primary text-text-primary flex items-start justify-center pt-[30vh]">
      <div className="max-w-sm w-full px-4">
        {/* Logo + branding */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight">kexify</h1>
          <p className="text-[11px] text-text-muted mt-0.5">keys simplified</p>
        </div>

        {sent ? (
          <div className="space-y-4">
            <div className="bg-surface-secondary border border-border-primary rounded-lg p-4">
              <p className="text-green-400 text-sm font-medium mb-1">{t("login.checkEmail")}</p>
              <p className="text-text-tertiary text-xs">
                {t("login.sentTo")} <span className="text-text-primary">{email}</span>
              </p>
            </div>

            {/* Code input for PWA users */}
            <form onSubmit={handleCodeSubmit} className="space-y-3">
              <p className="text-text-muted text-xs text-center">{t("login.codePrompt")}</p>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
                className="w-full bg-surface-secondary border border-border-primary rounded-lg px-3 py-2.5 text-center text-2xl font-mono tracking-[0.3em] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                type="submit"
                disabled={code.length !== 6 || verifying}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors text-white"
              >
                {verifying ? t("login.verifying") : t("login.verifyCode")}
              </button>
              {error && <ErrorBox>{error}</ErrorBox>}
            </form>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-xs text-text-muted mb-1.5">
                {t("login.email")}
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full bg-surface-secondary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                placeholder={t("login.emailPlaceholder")}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors text-white"
            >
              {loading ? t("login.sending") : `✉️ ${t("login.sendMagicLink")}`}
            </button>

            {error && <ErrorBox>{error}</ErrorBox>}
          </form>
        )}

        {/* Recovery Mode link */}
        <div className="mt-8 pt-6 border-t border-border-primary text-center">
          <Link
            to="/recovery"
            className="text-xs text-text-muted hover:text-orange-400 transition-colors"
          >
            {t("login.recoveryMode")}
          </Link>
          <p className="text-[10px] text-text-muted/60 mt-1">
            {t("login.recoveryDesc")}
          </p>
        </div>
      </div>

      {/* Theme & language toggle - bottom left */}
      <div className="fixed bottom-4 left-4 flex items-center gap-1">
        <ThemeToggle />
        <LangSwitcher />
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(getStoredTheme);

  function toggle() {
    const next = current === "dark" ? "light" : "dark";
    setTheme(next);
    setCurrent(next);
  }

  return (
    <button
      onClick={toggle}
      className="p-2 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-tertiary transition-colors"
      title={current === "dark" ? t("login.switchToLight") : t("login.switchToDark")}
    >
      {current === "dark" ? (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
        </svg>
      )}
    </button>
  );
}
