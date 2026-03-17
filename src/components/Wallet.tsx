import { useState, useEffect, useMemo } from "react";
import type { KeyShare } from "../shared/types";
import { fetchChains, fetchAssets, fetchSettings, type Chain, type Asset } from "../lib/api";
import { getMe } from "../lib/auth";
import { getUserOverrides } from "../lib/userOverrides";
import { setCacheTtl } from "../lib/dataCache";
import { authHeaders } from "../lib/auth";
import { apiUrl } from "../lib/apiBase";
import { fetchPasskeys } from "../lib/passkey";
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

/** Default polling interval for balance/price refresh (ms) — overridden by server setting */
const DEFAULT_POLL_INTERVAL = 60_000;

function formatLastUpdated(date: Date): string {
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function Wallet() {
  const frozen = useFrozen();
  const expert = useExpertMode();
  const { isRecovery, recoveryKeys } = useRecovery();
  const [keys, setKeys] = useState<KeyShare[]>([]);
  const [chainsData, setChainsData] = useState<Chain[]>([]);
  const [assetsData, setAssetsData] = useState<Asset[]>([]);
  const [defaultChains, setDefaultChains] = useState<string[] | null>(null);
  const [pollInterval, setPollInterval] = useState(DEFAULT_POLL_INTERVAL);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [, setTick] = useState(0);

  // Re-render every 10s to update the "last updated" label
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(iv);
  }, []);

  function loadData() {
    const keysPromise = isRecovery
      ? Promise.resolve(recoveryKeys)
      : fetch(apiUrl("/api/keys"), { headers: authHeaders() })
          .then((r) => r.json())
          .then((d) => d.keys || []);

    Promise.all([keysPromise, fetchChains(), fetchAssets(), fetchSettings(), getMe()])
      .then(([k, c, a, s, me]) => {
        setKeys(k);

        // Apply user config overrides (RPC, explorer, preferences)
        const overrides = getUserOverrides(me?.id);
        const showTestnet = overrides.preferences?.show_testnet ?? false;
        const mergedChains = c
          .filter((ch: Chain) => showTestnet || !/testnet|sepolia|devnet/i.test(ch.name))
          .map((ch: Chain) => {
            const o = overrides.chains?.[ch.name];
            if (!o) return ch;
            return { ...ch, ...o };
          });
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

  const [policyKeyId, setPolicyKeyId] = useState<string | null>(null);
  const [manageDisplayKeyId, setManageDisplayKeyId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
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

  async function guardedAction(action: () => void) {
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
      map[k.id] = getStoredDisplay(k.id);
    }
    setDisplayMap(map);
  }, [keys]);

  function handleDisplayChange(keyId: string, prefKey: string, visible: boolean) {
    setDisplayMap((prev) => {
      const existing = prev[keyId] ?? {};
      const updated = { ...existing, [prefKey]: visible };
      setStoredDisplay(keyId, updated);
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
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="w-14 h-14 rounded-full bg-surface-tertiary flex items-center justify-center mb-5">
          <svg
            className="w-7 h-7 text-text-muted"
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
        <p className="text-sm font-medium text-text-secondary mb-1">No accounts yet</p>
        <p className="text-xs text-text-muted mb-4">
          Create your first account to start managing crypto assets.
        </p>
        <button
          onClick={() => guardedAction(() => setShowCreateDialog(true))}
          disabled={frozen}
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-2 rounded-lg font-medium transition-colors disabled:bg-surface-tertiary disabled:text-text-muted disabled:cursor-not-allowed"
        >
          ✨ Add Your First Account
        </button>
        {showCreateDialog && (
          <CreateAccountDialog
            keyCount={0}
            onClose={() => setShowCreateDialog(false)}
            onCreated={loadData}
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
      {keyGroups.map((group) => (
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
                  Self-custody
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
              You hold both key shares and can recover your wallet without our server.
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
                Account Info
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
                Manage Display
              </button>
              {!isRecovery && expert && (
                <button
                  onClick={() => { setPolicyKeyId(group.keyId); setMenuKeyId(null); }}
                  className="w-full px-4 py-2.5 text-sm text-text-secondary hover:bg-surface-tertiary transition-colors flex items-center gap-3"
                >
                  <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                  </svg>
                  Policy Rules
                </button>
              )}
              {!isRecovery && !expert && (
                <div className="px-4 py-2.5 flex items-center gap-3">
                  <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                  </svg>
                  <span className="text-sm text-text-muted">Protected by default</span>
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
                  Disable Account
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
                // Reload assets to include newly added custom token
                fetchAssets().then(a => setAssetsData(a));
              }}
            />
            </div>
          )}

          <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden divide-y divide-border-secondary">
            {group.rows
              .filter((row) => isChainVisible(row.chain.name, displayMap[group.keyId] ?? null, defaultChains))
              .map((row) => (
              <AccountRowView
                key={`${row.keyId}:${row.chain.id}:${row.address}`}
                row={row}
                displayPrefs={displayMap[group.keyId] ?? null}
                pollInterval={pollInterval}
                onTokenDecision={(assetId, visible) => handleDisplayChange(group.keyId, assetId, visible)}
              />
            ))}
          </div>
        </div>
      ))}

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
          onClick={() => guardedAction(() => setShowCreateDialog(true))}
          disabled={frozen}
          className="w-full border border-dashed border-border-primary rounded-lg py-3 text-sm text-text-muted hover:text-text-secondary hover:border-border-secondary transition-colors flex items-center justify-center gap-1.5 disabled:text-text-muted disabled:cursor-not-allowed disabled:hover:border-border-primary"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Account
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
            {incompleteKeys.length} key
            {incompleteKeys.length !== 1 ? "s" : ""} with incomplete generation.
          </p>
        </div>
      )}

      {disabledKeys.length > 0 && (
        <div>
          <h3 className="text-[10px] text-text-muted uppercase tracking-wider font-semibold mb-2 px-1">
            Disabled
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

      {showCreateDialog && (
        <CreateAccountDialog
          keyCount={keys.length}
          onClose={() => setShowCreateDialog(false)}
          onCreated={loadData}
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

      {/* Last updated indicator */}
      {lastUpdated && (
        <div className="flex flex-col gap-0.5 px-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-muted tabular-nums">
              Updated {formatLastUpdated(lastUpdated)}
            </span>
            <button
              onClick={loadData}
              className="text-text-muted hover:text-text-secondary transition-colors p-0.5 rounded hover:bg-surface-tertiary"
              title="Refresh"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
