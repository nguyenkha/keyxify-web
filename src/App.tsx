import { useState, useEffect } from "react";
import * as Sentry from "@sentry/react";
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation, Outlet } from "react-router-dom";
import { Wallet } from "./components/Wallet";
import { AccountDetail } from "./components/AccountDetail";
import { Sign } from "./components/Sign";
import { Passkeys } from "./components/Passkeys";
import { Login } from "./components/Login";
import { VerifyToken } from "./components/VerifyToken";
import { getMe, getToken, clearToken, type MeUser } from "./lib/auth";
import { apiUrl } from "./lib/apiBase";
import { FrozenBanner } from "./components/FrozenBanner";
import { FrozenProvider } from "./context/FrozenContext";
import { getStoredTheme, setTheme } from "./lib/theme";
import { HideBalancesProvider, useHideBalances } from "./context/HideBalancesContext";
import { KeyShareManager } from "./components/KeyShareManager";
import { ActivityLogPage } from "./components/AuditLog";
import { WalletConnect as WalletConnectPage } from "./components/WalletConnect";
import { WalletConnectProvider } from "./context/WalletConnectContext";
import { WCRequestQueue } from "./components/WCRequestQueue";
import { FreezeAccount } from "./components/FreezeAccount";
import { RecoveryImport } from "./components/RecoveryImport";
import { RecoveryProvider } from "./context/RecoveryContext";
import { isRecoveryMode, getRecoveryKeys, exitRecoveryMode } from "./lib/recovery";

const mainNavItems = [
  { path: "/accounts", label: "💼 Accounts" },
  { path: "/walletconnect", label: "🔗 WalletConnect" },
];

const advancedNavItems = [
  { path: "/backup-recovery", label: "🗄️ Backup & Recovery" },
  { path: "/activity", label: "📋 Activity Log" },
  { path: "/passkeys", label: "🔑 Passkeys" },
  { path: "/sign", label: "✍️ Raw Signing" },
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
          Server online
        </a>
      ) : (
        <span className="text-[10px] text-text-muted">Offline</span>
      )}
    </div>
  );
}

function RecoveryBanner() {
  return (
    <div className="mb-6">
      <div className="recovery-accent bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-3">
        <p className="text-xs text-yellow-400 recovery-accent font-medium">Both key shares are loaded locally</p>
        <p className="text-[11px] text-text-muted mt-1 leading-relaxed">
          You can send transactions directly or use WalletConnect to connect to any dApp.
          For private key export, please use the CLI tool.
          For maximum security, transfer funds to a new wallet after recovery.
          Always keep both key share files stored in a safe, separate location.
        </p>
      </div>
    </div>
  );
}

function DashboardLayout() {
  const recovery = isRecoveryMode();
  const [user, setUser] = useState<MeUser | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  function refreshUser() {
    if (recovery) return;
    getMe().then((u) => setUser(u));
  }

  useEffect(() => {
    refreshUser();
  }, []);

  useEffect(() => {
    document.title = recovery ? "[Recovery Mode] kexify" : "kexify";
  }, [recovery]);

  const email = recovery ? "" : (user?.email || "");

  // In recovery mode, hide server-dependent nav items
  const filteredAdvanced = recovery
    ? advancedNavItems.filter((item) => item.path === "/sign")
    : advancedNavItems;
  const filteredAll = [...mainNavItems, ...filteredAdvanced];

  const [advancedOpen, setAdvancedOpen] = useState(() =>
    filteredAdvanced.some((item) => location.pathname.startsWith(item.path)),
  );

  // Derive active nav item from current path
  const activeNav = filteredAll.find((item) =>
    location.pathname.startsWith(item.path)
  );
  const pageTitle = activeNav?.label ?? "Accounts";

  function selectNav(path: string) {
    setSidebarOpen(false);
    navigate(path);
  }

  return (
    <RecoveryProvider value={{ isRecovery: recovery, recoveryKeys: recovery ? getRecoveryKeys() : [] }}>
    <FrozenProvider value={!!user?.frozenAt}>
    <div className="min-h-screen bg-surface-primary text-text-primary flex">
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
          transform transition-transform duration-200 ease-in-out
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
          md:sticky md:top-0 md:h-screen md:translate-x-0
        `}
      >
        <div className="px-5 py-6 border-b border-border-primary flex items-center justify-between">
          <div>
            <div>
              <p className="text-[10px] text-text-muted/40 font-mono">{(import.meta.env.VITE_GIT_HASH as string | undefined)?.slice(0, 7) ?? "dev"}</p>
              <h1 className="text-3xl font-bold tracking-tight">kexify</h1>
              <p className="text-[11px] text-text-muted mt-0.5">
                <span className={recovery ? "text-orange-400 recovery-accent" : ""}>keys simplified</span>
              </p>
            </div>
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
                  {item.label}
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
              Advanced
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
                      className={`w-full text-left px-3 py-2 rounded-md text-[13px] transition-colors ${
                        isActive
                          ? "bg-blue-600/10 text-blue-500 font-medium"
                          : "text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary"
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
                {user && !user.frozenAt && (
                  <FrozenBanner user={user} onUpdate={refreshUser} />
                )}
              </div>
            )}
          </div>
        </nav>

        {recovery ? (
          <div className="p-4 border-t border-border-primary flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-orange-400 recovery-accent truncate">Recovery Mode</p>
              <button
                onClick={() => { exitRecoveryMode(); navigate("/login"); }}
                className="text-xs text-text-muted hover:text-text-secondary mt-1"
              >
                Exit
              </button>
            </div>
            <HideBalancesToggle />
          </div>
        ) : email ? (
          <div className="p-4 border-t border-border-primary flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-text-tertiary truncate" title={email}>
                {email}
              </p>
              <button
                onClick={() => {
                  clearToken();
                  window.location.href = "/login";
                }}
                className="text-xs text-text-muted hover:text-text-secondary mt-1"
              >
                Logout
              </button>
            </div>
            <HideBalancesToggle />
            <ThemeToggle />
          </div>
        ) : null}
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-14 border-b border-border-primary flex items-center px-4 md:px-8 shrink-0 gap-3">
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
              <HideBalancesToggle />
              {!recovery && <ThemeToggle />}
            </div>
          </div>
        </header>

        {/* Content area — tighter padding on mobile */}
        <main className="flex-1 p-4 md:p-8 overflow-auto">
          {recovery && <RecoveryBanner />}
          {user?.frozenAt && <FrozenBanner user={user} onUpdate={refreshUser} />}
          <Outlet />
        </main>
      </div>

      {/* WalletConnect request overlay — always mounted */}
      <WCRequestQueue />
    </div>
    </FrozenProvider>
    </RecoveryProvider>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken() && !isRecoveryMode()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function App() {
  return (
    <Sentry.ErrorBoundary fallback={<p>Something went wrong.</p>}>
    <HashRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/recovery" element={<RecoveryImport />} />
        <Route path="/auth/verify" element={<VerifyToken />} />
        <Route path="/auth/freeze" element={<FreezeAccount />} />
        <Route
          element={
            <RequireAuth>
              <HideBalancesProvider>
              <WalletConnectProvider>
                <DashboardLayout />
              </WalletConnectProvider>
              </HideBalancesProvider>
            </RequireAuth>
          }
        >
          <Route path="/accounts" element={<Wallet />} />
          <Route path="/accounts/:keyId/:chainName/:assetSymbol/:btcAddrType?" element={<AccountDetail />} />
          <Route path="/passkeys" element={<Passkeys />} />
          <Route path="/backup-recovery" element={<KeyShareManager />} />
          <Route path="/activity" element={<ActivityLogPage />} />
          <Route path="/walletconnect" element={<WalletConnectPage />} />
          <Route path="/sign" element={<Sign />} />
          <Route path="/" element={<Navigate to="/accounts" replace />} />
        </Route>
      </Routes>
    </HashRouter>
    </Sentry.ErrorBoundary>
  );
}

export default App;
