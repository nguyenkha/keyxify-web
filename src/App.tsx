import { useState, useEffect, useRef } from "react";
import * as Sentry from "@sentry/react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation, Outlet } from "react-router-dom";
import { Wallet } from "./components/Wallet";
import { AccountDetail } from "./components/AccountDetail";
import { Sign } from "./components/Sign";
import { Passkeys } from "./components/Passkeys";
import { Login } from "./components/Login";
import { VerifyToken } from "./components/VerifyToken";
import { getMe, hasAnyToken, clearToken, type MeUser } from "./lib/auth";
import { apiUrl } from "./lib/apiBase";
import { FrozenBanner } from "./components/FrozenBanner";
import { FrozenProvider } from "./context/FrozenContext";
import { getStoredTheme, setTheme } from "./lib/theme";
import { HideBalancesProvider, useHideBalances } from "./context/HideBalancesContext";
import { ExpertModeProvider } from "./context/ExpertModeContext";
import { KeyShareManager } from "./components/KeyShareManager";
import { RecoveryChecklist } from "./components/RecoveryChecklist";
import { RecoveryGuide } from "./components/RecoveryGuide";
import { useExpertMode } from "./context/ExpertModeContext";

function BackupRecoveryPage() {
  const expert = useExpertMode();
  return (
    <div className="space-y-6">
      {expert ? (
        <>
          <KeyShareManager />
          <RecoveryGuide />
        </>
      ) : (
        <RecoveryChecklist />
      )}
    </div>
  );
}
import { ActivityLogPage } from "./components/AuditLog";
import { ConfigPage } from "./components/ConfigPage";
import { WalletConnect as WalletConnectPage } from "./components/WalletConnect";
import { WalletConnectProvider } from "./context/WalletConnectContext";
import { IdleLockProvider } from "./context/IdleLockContext";
import { LockScreen } from "./components/LockScreen";
import { useTranslation } from "react-i18next";
import { usePullToRefresh } from "./lib/use-pull-to-refresh";
import { useSwipeSidebar } from "./lib/use-swipe-sidebar";
import { notifyBalanceRefresh, clearAllTokenBalanceCaches, clearAllTxCaches } from "./lib/dataCache";
import { ToastProvider } from "./context/ToastContext";
import { WCRequestQueue } from "./components/WCRequestQueue";
import { FreezeAccount } from "./components/FreezeAccount";
import { RecoveryImport } from "./components/RecoveryImport";
import { StandaloneKeygen } from "./components/StandaloneKeygen";
import { LangSwitcher } from "./components/LangSwitcher";
import { setLanguage } from "./i18n/i18n";
import { Broadcast as BroadcastPage } from "./components/Broadcast";
import { RecoveryProvider } from "./context/RecoveryContext";
import { isRecoveryMode, getRecoveryKeys, exitRecoveryMode } from "./lib/recovery";
import { isStandaloneJwt, getIdentityId } from "./lib/auth";

const WalletConnectIcon = () => (
  <svg className="w-4 h-4 inline-block align-[-2px] mr-1" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6.09 9.6c3.26-3.2 8.56-3.2 11.82 0l.39.39c.16.16.16.42 0 .58l-1.34 1.31c-.08.08-.21.08-.3 0l-.54-.53c-2.28-2.23-5.97-2.23-8.24 0l-.58.56c-.08.08-.21.08-.3 0L5.67 10.6c-.16-.16-.16-.42 0-.58l.42-.42Zm14.6 2.72 1.19 1.17c.16.16.16.42 0 .58l-5.38 5.27c-.16.16-.43.16-.59 0l-3.82-3.74c-.04-.04-.1-.04-.15 0l-3.82 3.74c-.16.16-.43.16-.59 0L2.15 14.07c-.16-.16-.16-.42 0-.58l1.19-1.17c.16-.16.43-.16.59 0l3.82 3.74c.04.04.1.04.15 0l3.82-3.74c.16-.16.43-.16.59 0l3.82 3.74c.04.04.1.04.15 0l3.82-3.74c.16-.16.43-.16.59 0Z" />
  </svg>
);

const mainNavItems = [
  { path: "/accounts", labelKey: "nav.accounts", emoji: "💼" },
  { path: "/walletconnect", labelKey: "nav.walletconnect", icon: WalletConnectIcon },
];

const advancedNavItems: { path: string; labelKey: string; emoji?: string; expertOnly?: boolean }[] = [
  { path: "/backup-recovery", labelKey: "nav.backupRecovery", emoji: "🗄️" },
  { path: "/activity", labelKey: "nav.activityLog", emoji: "📋" },
  { path: "/config", labelKey: "nav.config", emoji: "⚙️" },
  { path: "/passkeys", labelKey: "nav.passkeys", emoji: "🔑" },
  { path: "/sign", labelKey: "nav.rawSigning", emoji: "✍️", expertOnly: true },
  { path: "/broadcast", labelKey: "nav.broadcastTx", emoji: "📡", expertOnly: true },
];


function ThemeToggle() {
  const [current, setCurrent] = useState(getStoredTheme);

  function toggle() {
    const next = current === "dark" ? "light" : "dark";
    setTheme(next);
    setCurrent(next);
  }

  return (
    <button
      onClick={toggle}
      className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary transition-colors"
      title={`Switch to ${current === "dark" ? "light" : "dark"} mode`}
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

function HideBalancesToggle() {
  const { hidden, toggle } = useHideBalances();
  return (
    <button
      onClick={toggle}
      className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary transition-colors"
      title={hidden ? "Show balances" : "Hide balances"}
    >
      {hidden ? (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      )}
    </button>
  );
}

function ServerStatus() {
  const { t } = useTranslation();
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);

  useEffect(() => {
    fetch(apiUrl("/api/health"))
      .then((r) => { if (r.ok) setServerOnline(true); else setServerOnline(false); })
      .catch(() => setServerOnline(false));
  }, []);

  if (serverOnline === null) return null;

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`w-1.5 h-1.5 rounded-full ${serverOnline ? "bg-green-500" : "bg-text-muted"}`}
      />
      {serverOnline ? (
        <a href="/login" className="text-[10px] text-text-muted hover:text-text-secondary">
          {t("common.serverOnline")}
        </a>
      ) : (
        <span className="text-[10px] text-text-muted">{t("common.offline")}</span>
      )}
    </div>
  );
}

function RecoveryBanner() {
  const { t } = useTranslation();
  return (
    <div className="mb-6">
      <div className="recovery-accent bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-3">
        <p className="text-xs text-yellow-400 recovery-accent font-medium">{t("recovery.banner")}</p>
        <p className="text-[11px] text-yellow-400/70 mt-1 leading-relaxed">
          {t("recovery.bannerDesc")}
          <span className="text-red-400 font-medium"> {t("recovery.bannerWarning")}</span>
          <span className="text-yellow-400/90 font-medium"> {t("recovery.bannerKeep")}</span> {t("recovery.bannerKeepDesc")}
        </p>
      </div>
    </div>
  );
}

declare const __GIT_HASH__: string;
declare const __GIT_TAG__: string;

const CLIENT_VERSION = __GIT_TAG__ || (__GIT_HASH__ ? `Build ${__GIT_HASH__}` : "Build dev");

function DashboardLayout() {
  const recovery = isRecoveryMode();
  const standalone = isStandaloneJwt();
  const [user, setUser] = useState<MeUser | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useSwipeSidebar(sidebarOpen, setSidebarOpen);
  const mainRef = useRef<HTMLElement>(null);
  const { pulling, pullDistance, refreshing } = usePullToRefresh(async () => {
    clearAllTokenBalanceCaches();
    clearAllTxCaches();
    notifyBalanceRefresh();
    // Small delay so the spinner shows
    await new Promise((r) => setTimeout(r, 800));
  }, mainRef);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  function refreshUser() {
    if (recovery) return;
    getMe().then((u) => setUser(u));
  }

  useEffect(() => {
    refreshUser();
    if (!recovery) {
      fetch(apiUrl("/api/health")).then((r) => r.json()).then((d) => setServerVersion(d.version ?? null)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.title = recovery ? "[Recovery Mode] kexify" : "kexify";
  }, [recovery]);

  const email = recovery ? "" : standalone ? "" : (user?.email || "");

  const expert = useExpertMode();

  // In recovery mode, hide server-dependent nav items; hide expert-only items when not expert
  const filteredAdvanced = advancedNavItems
    .filter((item) => !recovery || item.path === "/sign" || item.path === "/broadcast" || item.path === "/config")
    .filter((item) => !item.expertOnly || expert);
  const filteredAll = [...mainNavItems, ...filteredAdvanced];

  const [advancedOpen, setAdvancedOpen] = useState(() =>
    filteredAdvanced.some((item) => location.pathname.startsWith(item.path)),
  );

  // Derive active nav item from current path
  const activeNav = filteredAll.find((item) =>
    location.pathname.startsWith(item.path)
  );
  const { t } = useTranslation();
  const pageTitle = activeNav ? t(activeNav.labelKey) : t("nav.accounts");

  function selectNav(path: string) {
    setSidebarOpen(false);
    navigate(path);
  }

  return (
    <RecoveryProvider value={{ isRecovery: recovery, recoveryKeys: recovery ? getRecoveryKeys() : [] }}>
    <FrozenProvider value={!standalone && !!user?.frozenAt}>
    <div className="min-h-dvh bg-surface-primary text-text-primary flex">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — off-canvas on mobile, static on md+ */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-40 w-60 bg-surface-secondary border-r border-border-primary flex flex-col shrink-0
          pb-[env(safe-area-inset-bottom)]
          transform transition-transform duration-200 ease-in-out
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
          md:sticky md:top-0 md:h-dvh md:translate-x-0
        `}
      >
        <div className="px-5 pb-6 pt-[calc(1.5rem+env(safe-area-inset-top))] border-b border-border-primary flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">kexify</h1>
            <p className="text-[11px] text-text-muted mt-0.5">
              <span className={recovery ? "text-orange-400 recovery-accent" : ""}>keys simplified</span>
            </p>
          </div>
          {/* Close on mobile */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary transition-colors md:hidden"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <nav className="flex-1 p-3 overflow-y-auto">
          <div className="space-y-0.5">
            {mainNavItems.map((item) => {
              const isActive = location.pathname.startsWith(item.path);
              return (
                <button
                  key={item.path}
                  onClick={() => selectNav(item.path)}
                  className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors ${
                    isActive
                      ? "bg-blue-600/10 text-blue-500 font-medium"
                      : "text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary"
                  }`}
                >
                  {item.icon ? <><item.icon />{t(item.labelKey)}</> : `${item.emoji ?? ""} ${t(item.labelKey)}`}
                </button>
              );
            })}
          </div>

          {/* Advanced section */}
          <div className="mt-4 pt-3 border-t border-border-secondary">
            <button
              onClick={() => setAdvancedOpen((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] text-text-muted uppercase tracking-wider hover:text-text-tertiary transition-colors"
            >
              {t("nav.advanced")}
              <svg
                className={`w-3 h-3 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {advancedOpen && (
              <div className="mt-1 space-y-0.5">
                {filteredAdvanced.map((item) => {
                  const isActive = location.pathname.startsWith(item.path);
                  return (
                    <button
                      key={item.path}
                      onClick={() => selectNav(item.path)}
                      className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors ${
                        isActive
                          ? "bg-blue-600/10 text-blue-500 font-medium"
                          : "text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary"
                      }`}
                    >
                      {item.emoji ?? ""} {t(item.labelKey)}
                    </button>
                  );
                })}
                {user && !user.frozenAt && !standalone && (
                  <FrozenBanner user={user} onUpdate={refreshUser} />
                )}
              </div>
            )}
          </div>
        </nav>

        {recovery ? (
          <div className="p-4 border-t border-border-primary flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-orange-400 recovery-accent truncate">{t("nav.recoveryMode")}</p>
              <button
                onClick={() => { exitRecoveryMode(); navigate("/login"); }}
                className="text-xs text-text-muted hover:text-text-secondary mt-1"
              >
                {t("nav.exitRecovery")}
              </button>
            </div>
            <HideBalancesToggle />
          </div>
        ) : (email || standalone) ? (<>
          <div className="px-4 py-1.5 text-[10px] text-text-muted/40 font-mono space-y-0.5">
            <p>Client: {CLIENT_VERSION}</p>
            <p>Server: {serverVersion ?? "..."}</p>
          </div>
          <div className="p-4 border-t border-border-primary flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-text-tertiary truncate" title={email || t("nav.anonymousMode")}>
                {email || `${t("nav.anonymousMode")} ${(getIdentityId() || "").slice(0, 6)}`}
              </p>
              <button
                onClick={() => {
                  clearToken();
                  window.location.href = "/login";
                }}
                className="text-xs text-text-muted hover:text-text-secondary mt-1"
              >
                {t("nav.signOut")}
              </button>
            </div>
            <HideBalancesToggle />
            <ThemeToggle />
          </div>
        </>) : null}
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="border-b border-border-primary flex items-center px-4 md:px-8 shrink-0 gap-3 h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]">
          {/* Hamburger on mobile */}
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 -ml-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary transition-colors md:hidden"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
          <h2 className="text-sm font-medium text-text-secondary">
            {pageTitle}
          </h2>
          <div className="ml-auto flex items-center gap-3">
            {recovery && <ServerStatus />}
            {/* Toggle buttons visible on mobile header */}
            <div className="flex items-center gap-0.5 md:hidden">
              <button
                onClick={() => navigate("/walletconnect?scan=1")}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary transition-colors"
                title="Scan WalletConnect QR"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7V5a2 2 0 012-2h2m10 0h2a2 2 0 012 2v2m0 10v2a2 2 0 01-2 2h-2M3 17v2a2 2 0 002 2h2" />
                  <rect x="7" y="7" width="4" height="4" rx="0.5" />
                  <rect x="13" y="7" width="4" height="4" rx="0.5" />
                  <rect x="7" y="13" width="4" height="4" rx="0.5" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 13h4v4h-4" />
                </svg>
              </button>
              <LangSwitcher />
              <HideBalancesToggle />
              {!recovery && <ThemeToggle />}
            </div>
          </div>
        </header>

        {/* Content area — tighter padding on mobile */}
        <main ref={mainRef} className="flex-1 p-4 md:p-8 overflow-auto">
          {/* Pull-to-refresh indicator */}
          {(pulling || refreshing) && (
            <div
              className="flex justify-center transition-all duration-150 overflow-hidden"
              style={{ height: pullDistance, opacity: Math.min(pullDistance / 60, 1) }}
            >
              <svg
                className={`w-5 h-5 text-text-muted ${refreshing ? "animate-spin" : ""}`}
                style={{ transform: refreshing ? undefined : `rotate(${Math.min(pullDistance / 80 * 360, 360)}deg)` }}
                viewBox="0 0 24 24" fill="none"
              >
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
                <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            </div>
          )}
          {recovery && <RecoveryBanner />}
          {user?.frozenAt && !standalone && <FrozenBanner user={user} onUpdate={refreshUser} />}
          <Outlet />
        </main>
        <div className="shrink-0 px-4 md:px-8 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] flex items-center justify-between">
          <div id="footer-left" />
          <span className="text-[10px] text-text-muted tabular-nums ml-auto">&copy; {new Date().getFullYear()} Kha Do</span>
        </div>
      </div>

      {/* WalletConnect request overlay — always mounted */}
      <WCRequestQueue />
    </div>
    </FrozenProvider>
    </RecoveryProvider>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!hasAnyToken() && !isRecoveryMode()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

const SUPPORTED_LANGS = ["en", "vi"];

function LangFromUrl() {
  const location = useLocation();
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    if (applied) return;
    const params = new URLSearchParams(location.search);
    const lang = params.get("lang");
    if (lang && SUPPORTED_LANGS.includes(lang)) {
      setLanguage(lang);
    }
    setApplied(true);
  }, [location.search, applied]);

  return null;
}

function App() {
  return (
    <Sentry.ErrorBoundary fallback={<p>Something went wrong.</p>}>
    <BrowserRouter>
      <LangFromUrl />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/standalone" element={<StandaloneKeygen />} />
        <Route path="/recovery" element={<RecoveryImport />} />
        <Route path="/auth/verify" element={<VerifyToken />} />
        <Route path="/auth/freeze" element={<FreezeAccount />} />
        <Route
          element={
            <RequireAuth>
              <ExpertModeProvider>
              <HideBalancesProvider>
              <ToastProvider>
              <WalletConnectProvider>
              <IdleLockProvider>
                <DashboardLayout />
                <LockScreen />
              </IdleLockProvider>
              </WalletConnectProvider>
              </ToastProvider>
              </HideBalancesProvider>
              </ExpertModeProvider>
            </RequireAuth>
          }
        >
          <Route path="/accounts" element={<Wallet />} />
          <Route path="/accounts/:keyId/:chainName/:assetSymbol/:btcAddrType?" element={<AccountDetail />} />
          <Route path="/passkeys" element={<Passkeys />} />
          <Route path="/backup-recovery" element={<BackupRecoveryPage />} />
          <Route path="/activity" element={<ActivityLogPage />} />
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/walletconnect" element={<WalletConnectPage />} />
          <Route path="/sign" element={<Sign />} />
          <Route path="/broadcast" element={<BroadcastPage />} />
          <Route path="/" element={<Navigate to="/accounts" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </Sentry.ErrorBoundary>
  );
}

export default App;
