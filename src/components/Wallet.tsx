import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { KeyShare } from "../shared/types";
import { fetchChains, fetchAssets, fetchSettings, type Chain, type Asset, type Settings } from "../lib/api";
import staticConfig from "../config.json";
import { getMe, getIdentityId } from "../lib/auth";
import { getUserOverrides, applyChainOverrides, getPreference } from "../lib/userOverrides";
import { setCacheTtl, clearAllTokenBalanceCaches, notifyBalanceRefresh } from "../lib/dataCache";
import { authHeaders } from "../lib/auth";
import { apiUrl } from "../lib/apiBase";
import { fetchPasskeys, isWithinPasskeyGrace } from "../lib/passkey";
import { PasskeyGate } from "./PasskeyGate";
import { PasskeyChallenge } from "./PasskeyChallenge";
import { PolicyRules } from "./PolicyRules";
import { useExpertMode } from "../context/ExpertModeContext";
import { getStoredDisplay, setStoredDisplay, isChainVisible } from "../lib/displayPrefs";
import { buildAccountRows, type AccountRow } from "../lib/accountRows";
import { SkeletonRow } from "./SkeletonRow";
import { DisabledKeyRow } from "./DisabledKeyRow";
import { KeyNameLabel } from "./KeyNameLabel";
import { AccountInfoDialog } from "./AccountInfoDialog";
import { useFrozen } from "../context/FrozenContext";
import { useRecovery } from "../context/RecoveryContext";
import { ManageDisplayPanel } from "./ManageDisplayPanel";
import { AccountRowView } from "./AccountRowView";
import { CreateAccountDialog } from "./CreateAccountDialog";
import { BackupReminder } from "./backup-reminder";
import { WalletTutorial } from "./WalletTutorial";
import { usePrices } from "../lib/use-prices";
import { WalletActivity } from "./WalletActivity";
import { PortfolioHeader } from "./PortfolioHeader";

/** Default polling interval for balance/price refresh (ms) — overridden by server setting */
const DEFAULT_POLL_INTERVAL = 60_000;

export function Wallet() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const frozen = useFrozen();
  const expert = useExpertMode();

  function formatLastUpdated(date: Date): string {
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diffSec < 10) return t("wallet.updatedJustNow");
    if (diffSec < 60) return t("wallet.updatedSecondsAgo", { count: diffSec });
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return t("wallet.updatedMinutesAgo", { count: diffMin });
    return t("wallet.updated", { time: date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) });
  }
  const { isRecovery, recoveryKeys } = useRecovery();
  const [keys, setKeys] = useState<KeyShare[]>([]);
  const [chainsData, setChainsData] = useState<Chain[]>([]);
  const [assetsData, setAssetsData] = useState<Asset[]>([]);
  const [defaultChains, setDefaultChains] = useState<string[] | null>(null);
  const [pollInterval, setPollInterval] = useState(DEFAULT_POLL_INTERVAL);
  const prices = usePrices(pollInterval);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | undefined>();
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [, setTick] = useState(0);

  // Re-render every 10s to update the "last updated" label
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(iv);
  }, []);

  function loadData() {
    if (isRecovery) {
      // Recovery mode: use static config only, never call server APIs
      const overrides = getUserOverrides();
      const showTestnet = getPreference("show_testnet");
      const c = (staticConfig.chains as Chain[]).filter(
        (ch) => showTestnet || !/testnet|sepolia|devnet/i.test(ch.name),
      );
      setKeys(recoveryKeys);
      setChainsData(c);
      setAssetsData(staticConfig.assets as Asset[]);
      setDefaultChains(overrides.preferences?.default_chains ?? (staticConfig.preferences as Settings).default_chains ?? null);
      setLastUpdated(new Date());
      setLoading(false);
      return;
    }

    Promise.all([
      fetch(apiUrl("/api/keys"), { headers: authHeaders() }).then((r) => r.json()).then((d) => d.keys || []).catch(() => []),
      fetchChains(),
      fetchAssets(),
      fetchSettings(),
      getMe(),
    ])
      .then(([k, c, a, s, me]) => {
        setKeys(k);
        setUserId(me?.id);

        // Apply user config overrides (RPC, explorer, preferences)
        const uid = me?.id ?? getIdentityId() ?? undefined;
        const overrides = getUserOverrides(uid);
        const showTestnet = getPreference("show_testnet", uid);
        const mergedChains = applyChainOverrides(
          c.filter((ch: Chain) => showTestnet || !/testnet|sepolia|devnet|preprod/i.test(ch.name)),
          uid,
        );
        setChainsData(mergedChains);
        setAssetsData(a);

        const defaultChainsVal = overrides.preferences?.default_chains ?? (s.default_chains as string[]) ?? null;
        setDefaultChains(defaultChainsVal);

        const refreshSec = overrides.preferences?.refresh_interval
          ?? (typeof s.refresh_interval === "number" ? s.refresh_interval : null);
        if (refreshSec && refreshSec > 0) {
          const ms = refreshSec * 1000;
          setPollInterval(ms);
          setCacheTtl(ms);
        }
        setLastUpdated(new Date());
      })
      .finally(() => setLoading(false));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadData(); }, []);

  const accountRows = useMemo(
    () => buildAccountRows(keys, chainsData, assetsData),
    [keys, chainsData, assetsData]
  );

  const disabledKeys = useMemo(
    () => keys.filter((k) => !k.enabled),
    [keys]
  );

  const incompleteKeys = useMemo(
    () => keys.filter((k) => k.enabled && !k.publicKey),
    [keys]
  );

  const [activeTab, setActiveTab] = useState<"accounts" | "activity">(
    () => window.location.hash === "#activity" ? "activity" : "accounts"
  );

  // Sync tab state with URL hash
  function switchTab(tab: "accounts" | "activity") {
    setActiveTab(tab);
    history.replaceState(null, "", tab === "activity" ? "#activity" : window.location.pathname + window.location.search);
  }
  // Portfolio total aggregation
  const [balanceMap, setBalanceMap] = useState<Map<string, number>>(new Map());
  const handleBalanceUpdate = (rowKey: string, usdTotal: number) => {
    setBalanceMap((prev) => {
      if (prev.get(rowKey) === usdTotal) return prev;
      const next = new Map(prev);
      next.set(rowKey, usdTotal);
      return next;
    });
  };
  const portfolioTotal = useMemo(
    () => [...balanceMap.values()].reduce((a, b) => a + b, 0),
    [balanceMap]
  );

  const [policyKeyId, setPolicyKeyId] = useState<string | null>(null);
  const [manageDisplayKeyId, setManageDisplayKeyId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);

  // Allow restarting tutorial via console: window.dispatchEvent(new Event("start-tutorial"))
  useEffect(() => {
    function onStart() {
      localStorage.removeItem("kxi:tutorial-done");
      setShowTutorial(true);
    }
    window.addEventListener("start-tutorial", onStart);
    return () => window.removeEventListener("start-tutorial", onStart);
  }, []);

  // Auto-open create dialog for first-time users once loading completes
  useEffect(() => {
    if (!loading && keys.length === 0 && !isRecovery) {
      setShowCreateDialog(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);
  const [infoKeyId, setInfoKeyId] = useState<string | null>(null);
  const [badgeExplain, setBadgeExplain] = useState<string | null>(null);
  const [menuKeyId, setMenuKeyId] = useState<string | null>(null);
  // Close menu on click outside
  useEffect(() => {
    if (!menuKeyId) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("[data-gear-menu]") || target.closest("[data-gear-btn]")) return;
      setMenuKeyId(null);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuKeyId]);

  // Close display panel on click outside
  useEffect(() => {
    if (!manageDisplayKeyId) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("[data-display-panel]")) return;
      setManageDisplayKeyId(null);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [manageDisplayKeyId]);

  // Passkey guard state
  const [passkeyGuard, setPasskeyGuard] = useState<"idle" | "gate" | "challenge">("idle");
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  async function guardedAction(action: () => void, skipPasskeyGate?: boolean) {
    // If the action handles its own passkey flow (e.g. CreateAccountDialog), skip the gate
    if (skipPasskeyGate) {
      action();
      return;
    }
    // Skip re-challenge if passkey was verified recently (grace period)
    if (isWithinPasskeyGrace()) {
      action();
      return;
    }
    try {
      const list = await fetchPasskeys();
      if (list.length === 0) {
        setPendingAction(() => action);
        setPasskeyGuard("gate");
      } else {
        setPendingAction(() => action);
        setPasskeyGuard("challenge");
      }
    } catch {
      action();
    }
  }

  // Per-key display prefs: keyId → { "chain:NAME" → bool, assetId → bool }
  const [displayMap, setDisplayMap] = useState<Record<string, Record<string, boolean> | null>>({});

  useEffect(() => {
    const map: Record<string, Record<string, boolean> | null> = {};
    for (const k of keys) {
      map[k.id] = getStoredDisplay(k.id, userId);
    }
    setDisplayMap(map);
  }, [keys, userId]);

  function handleDisplayChange(keyId: string, prefKey: string, visible: boolean) {
    setDisplayMap((prev) => {
      const existing = prev[keyId] ?? {};
      const updated = { ...existing, [prefKey]: visible };
      setStoredDisplay(keyId, updated, userId);
      return { ...prev, [keyId]: updated };
    });
  }

  // Group account rows by key
  const keyGroups = useMemo(() => {
    const groups: { keyId: string; keyName: string | null; selfCustody: boolean; backedUp: boolean; rows: AccountRow[] }[] = [];
    for (const row of accountRows) {
      const existing = groups.find((g) => g.keyId === row.keyId);
      if (existing) {
        existing.rows.push(row);
      } else {
        const key = keys.find((k) => k.id === row.keyId);
        groups.push({ keyId: row.keyId, keyName: key?.name ?? null, selfCustody: !!key?.selfCustodyAt, backedUp: !!key?.hasClientBackup, rows: [row] });
      }
    }
    return groups;
  }, [accountRows, keys]);

  async function toggleKey(id: string, enabled: boolean) {
    const res = await fetch(apiUrl(`/api/keys/${id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ enabled }),
    });
    const data = await res.json();
    if (enabled && data.enableAt) {
      // 24h cooling period — key stays disabled, enableAt is set
      setKeys((prev) =>
        prev.map((k) => (k.id === id ? { ...k, enableAt: data.enableAt } : k))
      );
    } else {
      setKeys((prev) =>
        prev.map((k) => (k.id === id ? { ...k, enabled, enableAt: null } : k))
      );
    }
  }

  async function cancelEnable(id: string) {
    await fetch(apiUrl(`/api/keys/${id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ cancelEnable: true }),
    });
    setKeys((prev) =>
      prev.map((k) => (k.id === id ? { ...k, enableAt: null } : k))
    );
  }

  async function renameKey(id: string, name: string) {
    await fetch(apiUrl(`/api/keys/${id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name: name || null }),
    });
    setKeys((prev) =>
      prev.map((k) => (k.id === id ? { ...k, name: name || null } : k))
    );
  }

  // ── Loading state ──
  if (loading) {
    return (
      <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden divide-y divide-border-secondary">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }

  if (keys.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        {/* Wallet icon */}
        <div className="w-16 h-16 rounded-full bg-blue-500/10 flex items-center justify-center mb-5">
          <svg
            className="w-8 h-8 text-blue-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"
            />
          </svg>
        </div>
        <p className="text-base font-medium text-text-primary mb-1.5">{t("wallet.welcome")}</p>
        <p className="text-sm text-text-muted mb-6 max-w-xs leading-relaxed">
          {t("wallet.welcomeDesc")}
        </p>
        <button
          onClick={() => guardedAction(() => setShowCreateDialog(true), true)}
          disabled={frozen}
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-6 py-2.5 rounded-lg font-medium transition-colors disabled:bg-surface-tertiary disabled:text-text-muted disabled:cursor-not-allowed mb-8"
        >
          {t("wallet.createWallet")}
        </button>

        {/* How it works — quick overview for new users */}
        <div className="w-full max-w-sm space-y-3 text-left">
          <p className="text-[10px] text-text-tertiary font-semibold uppercase tracking-wider px-1">{t("wallet.howItWorks")}</p>
          {[
            { icon: "M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z", label: t("wallet.secureKeyGen"), desc: t("wallet.secureKeyGenDesc") },
            { icon: "M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004 10.5a7.464 7.464 0 01-1.15 3.993m1.989 3.559A11.209 11.209 0 008.25 10.5a3.75 3.75 0 117.5 0c0 .527-.021 1.049-.064 1.565M12 10.5a14.94 14.94 0 01-3.6 9.75m6.633-4.596a18.666 18.666 0 01-2.485 5.33", label: t("wallet.passkeyProtection"), desc: t("wallet.passkeyProtectionDesc") },
            { icon: "M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z", label: t("wallet.fraudProtection"), desc: t("wallet.fraudProtectionDesc") },
          ].map(({ icon, label, desc }) => (
            <div key={label} className="flex items-start gap-3 bg-surface-secondary border border-border-primary rounded-lg px-3.5 py-3">
              <div className="w-8 h-8 rounded-full bg-surface-tertiary flex items-center justify-center shrink-0 mt-0.5">
                <svg className="w-4 h-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
                </svg>
              </div>
              <div>
                <p className="text-xs font-medium text-text-secondary">{label}</p>
                <p className="text-[11px] text-text-muted leading-relaxed mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {showCreateDialog && (
          <CreateAccountDialog
            keyCount={0}
            onClose={() => setShowCreateDialog(false)}
            onCreated={() => {
              loadData();
              if (!localStorage.getItem("kxi:tutorial-done")) {
                setShowTutorial(true);
              }
            }}
          />
        )}

        {/* Passkey guard dialogs */}
        {passkeyGuard === "gate" && (
          <PasskeyGate
            onRegistered={() => {
              setPasskeyGuard("idle");
              pendingAction?.();
              setPendingAction(null);
            }}
            onCancel={() => {
              setPasskeyGuard("idle");
              setPendingAction(null);
            }}
          />
        )}
        {passkeyGuard === "challenge" && (
          <PasskeyChallenge
            autoStart
            onAuthenticated={() => {
              setPasskeyGuard("idle");
              pendingAction?.();
              setPendingAction(null);
            }}
            withPrf
            onCancel={() => {
              setPasskeyGuard("idle");
              setPendingAction(null);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Portfolio total */}
      {keyGroups.length > 0 && (
        <PortfolioHeader totalUsd={portfolioTotal} loading={loading} />
      )}

      {/* Accounts / Activity tab bar */}
      {keyGroups.length > 0 && (
        <div className="flex gap-1 bg-surface-secondary rounded-lg border border-border-primary p-1">
          {(["accounts", "activity"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => switchTab(tab)}
              className={`flex-1 text-xs font-medium py-2 rounded-md transition-colors ${
                activeTab === tab
                  ? "bg-surface-tertiary text-text-primary shadow-sm"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {tab === "accounts" ? t("common.accounts") : t("common.activity")}
            </button>
          ))}
        </div>
      )}

      {/* Activity tab */}
      {activeTab === "activity" && keyGroups.length > 0 && (
        <WalletActivity accountRows={accountRows} pollInterval={pollInterval} />
      )}

      {/* Accounts tab */}
      {activeTab === "accounts" && keyGroups.map((group) => (
        <div key={group.keyId}>
          <div className="flex items-center justify-between mb-2 px-1">
            <KeyNameLabel
              keyId={group.keyId}
              name={group.keyName}
              onRename={(name) => renameKey(group.keyId, name)}
              disabled={isRecovery}
            />
            <div className="flex items-center gap-1.5">
              {group.selfCustody && (
                <button
                  onClick={() => setBadgeExplain(badgeExplain === `sc-${group.keyId}` ? null : `sc-${group.keyId}`)}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors whitespace-nowrap shrink-0"
                >
                  {t("wallet.selfCustody")}
                </button>
              )}
            <button
              data-gear-btn
              onClick={() => setMenuKeyId(menuKeyId === group.keyId ? null : group.keyId)}
              className={`p-1.5 rounded-md transition-colors ${
                menuKeyId === group.keyId
                  ? "text-text-secondary bg-surface-tertiary"
                  : "text-text-muted hover:text-text-secondary hover:bg-surface-tertiary"
              }`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            </div>
          </div>

          {/* Badge explanations */}
          {badgeExplain === `sc-${group.keyId}` && (
            <p className="text-right px-1 mb-2 text-[10px] text-purple-400/80 leading-relaxed">
              {t("wallet.selfCustodyDesc")}
            </p>
          )}

          {/* Account menu */}
          {menuKeyId === group.keyId && (
            <div data-gear-menu className="mb-2 bg-surface-secondary border border-border-primary rounded-lg overflow-hidden divide-y divide-border-secondary">
              <button
                onClick={() => { setInfoKeyId(group.keyId); setMenuKeyId(null); }}
                className="w-full px-4 py-2.5 text-sm text-text-secondary hover:bg-surface-tertiary transition-colors flex items-center gap-3"
              >
                <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                </svg>
                {t("wallet.accountInfo")}
              </button>
              <button
                onClick={() => {
                  setManageDisplayKeyId(manageDisplayKeyId === group.keyId ? null : group.keyId);
                  setMenuKeyId(null);
                }}
                className="w-full px-4 py-2.5 text-sm text-text-secondary hover:bg-surface-tertiary transition-colors flex items-center gap-3"
              >
                <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {t("wallet.manageDisplay")}
              </button>
              {!isRecovery && expert && (
                <button
                  onClick={() => { setPolicyKeyId(group.keyId); setMenuKeyId(null); }}
                  className="w-full px-4 py-2.5 text-sm text-text-secondary hover:bg-surface-tertiary transition-colors flex items-center gap-3"
                >
                  <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                  </svg>
                  {t("wallet.policyRules")}
                </button>
              )}
              {!isRecovery && !expert && (
                <div className="px-4 py-2.5 flex items-center gap-3">
                  <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                  </svg>
                  <span className="text-sm text-text-muted">{t("wallet.protectedByDefault")}</span>
                </div>
              )}
              {!isRecovery && (
                <button
                  onClick={() => { toggleKey(group.keyId, false); setMenuKeyId(null); }}
                  disabled={frozen}
                  className="w-full px-4 py-2.5 text-sm text-red-400/70 hover:bg-red-500/5 transition-colors flex items-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                >
                  <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                  {t("wallet.disableAccount")}
                </button>
              )}
            </div>
          )}

          {/* Manage display panel */}
          {manageDisplayKeyId === group.keyId && (
            <div data-display-panel>
            <ManageDisplayPanel
              rows={group.rows}
              displayPrefs={displayMap[group.keyId] ?? null}
              defaultChains={defaultChains}
              onToggle={(prefKey, visible) =>
                handleDisplayChange(group.keyId, prefKey, visible)
              }
              onTokenAdded={() => {
                // Clear stale token balance caches, reload assets, and re-mount AccountRowViews
                clearAllTokenBalanceCaches();
                fetchAssets().then(a => { setAssetsData(a); setRefreshKey(k => k + 1); });
              }}
            />
            </div>
          )}

          <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden divide-y divide-border-secondary">
            {group.rows
              .filter((row) => isChainVisible(row.chain.name, displayMap[group.keyId] ?? null, defaultChains))
              .map((row) => (
              <AccountRowView
                key={`${row.keyId}:${row.chain.id}:${row.address}:${refreshKey}`}
                row={row}
                displayPrefs={displayMap[group.keyId] ?? null}
                pollInterval={pollInterval}
                prices={prices}
                onTokenDecision={(assetId, visible) => handleDisplayChange(group.keyId, assetId, visible)}
                onBalanceUpdate={handleBalanceUpdate}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Elements below only shown on Accounts tab */}
      {activeTab === "accounts" && (
        <>
      {/* Backup reminder for keys without backup */}
      {keyGroups.some(g => !g.backedUp && !g.selfCustody) && !isRecovery && (
        <BackupReminder onBackup={() => navigate("/backup-recovery")} />
      )}

      {policyKeyId && (
        <PolicyRules
          keyId={policyKeyId}
          keyName={keys.find((k) => k.id === policyKeyId)?.name}
          onClose={() => setPolicyKeyId(null)}
        />
      )}

      {infoKeyId && (() => {
        const key = keys.find((k) => k.id === infoKeyId);
        return key ? (
          <AccountInfoDialog keyShare={key} onClose={() => setInfoKeyId(null)} />
        ) : null;
      })()}

      {!isRecovery && (
        <button
          onClick={() => guardedAction(() => setShowCreateDialog(true), true)}
          disabled={frozen}
          className="w-full border border-dashed border-border-primary rounded-lg py-3 text-sm text-text-muted hover:text-text-secondary hover:border-border-secondary transition-colors flex items-center justify-center gap-1.5 disabled:text-text-muted disabled:cursor-not-allowed disabled:hover:border-border-primary"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {t("wallet.addAccount")}
        </button>
      )}

      {incompleteKeys.length > 0 && (
        <div className="bg-yellow-500/5 border border-yellow-500/15 rounded-lg px-4 py-3 flex items-start gap-3">
          <svg
            className="w-4 h-4 text-yellow-500/70 shrink-0 mt-0.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
          <p className="text-xs text-yellow-500/80 leading-relaxed">
            {t(incompleteKeys.length !== 1 ? "wallet.incompleteKeys_plural" : "wallet.incompleteKeys", { count: incompleteKeys.length })}
          </p>
        </div>
      )}

      {disabledKeys.length > 0 && (
        <div>
          <h3 className="text-[10px] text-text-muted uppercase tracking-wider font-semibold mb-2 px-1">
            {t("wallet.disabled")}
          </h3>
          <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden divide-y divide-border-secondary">
            {disabledKeys.map((key) => (
              <DisabledKeyRow
                key={key.id}
                keyShare={key}
                onToggle={toggleKey}
                onCancelEnable={cancelEnable}
                frozen={frozen}
              />
            ))}
          </div>
        </div>
      )}

        </>
      )}

      {showCreateDialog && (
        <CreateAccountDialog
          keyCount={keys.length}
          onClose={() => setShowCreateDialog(false)}
          onCreated={() => {
            const isFirst = keys.length === 0;
            loadData();
            if (isFirst && !localStorage.getItem("kxi:tutorial-done")) {
              setShowTutorial(true);
            }
          }}
        />
      )}

      {showTutorial && <WalletTutorial onComplete={() => setShowTutorial(false)} />}

      {/* Passkey guard dialogs */}
      {passkeyGuard === "gate" && (
        <PasskeyGate
          onRegistered={() => {
            setPasskeyGuard("idle");
            pendingAction?.();
            setPendingAction(null);
          }}
          onCancel={() => {
            setPasskeyGuard("idle");
            setPendingAction(null);
          }}
        />
      )}
      {passkeyGuard === "challenge" && (
        <PasskeyChallenge
          autoStart
          onAuthenticated={() => {
            setPasskeyGuard("idle");
            pendingAction?.();
            setPendingAction(null);
          }}
          withPrf
          onCancel={() => {
            setPasskeyGuard("idle");
            setPendingAction(null);
          }}
        />
      )}

      {/* Last updated indicator — portaled into shared footer */}
      {lastUpdated && document.getElementById("footer-left") &&
        createPortal(
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-muted tabular-nums">
              {formatLastUpdated(lastUpdated)}
            </span>
            <button
              onClick={() => {
                clearAllTokenBalanceCaches();
                notifyBalanceRefresh();
                loadData();
              }}
              className="text-text-muted hover:text-text-secondary transition-colors p-0.5 rounded hover:bg-surface-tertiary"
              title={t("common.refresh")}
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>,
          document.getElementById("footer-left")!,
        )
      }

    </div>
  );
}
