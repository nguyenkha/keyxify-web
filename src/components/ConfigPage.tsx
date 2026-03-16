import { useState, useEffect, useRef, useMemo } from "react";
import { fetchChains, fetchAssets, fetchSettings, type Chain, type Asset } from "../lib/api";
import type { Settings } from "../shared/types";
import { getMe } from "../lib/auth";
import { getUserOverrides, setUserOverrides, clearUserOverrides, type UserOverrides } from "../lib/userOverrides";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import "prismjs/components/prism-json";

function highlightCode(code: string): string {
  return Prism.highlight(code, Prism.languages.json, "json");
}

import { checkBtcHealth, checkBchHealth, checkXlmHealth } from "../lib/providerDetect";

type RpcStatus = "checking" | "ok" | "error";

async function checkRpcHealth(rpcUrl: string, chainType: string): Promise<boolean> {
  if (!rpcUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    switch (chainType) {
      case "evm": {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
          signal: controller.signal,
        });
        if (!res.ok) return false;
        const data = await res.json();
        return !!data.result;
      }
      case "solana": {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }),
          signal: controller.signal,
        });
        if (!res.ok) return false;
        const data = await res.json();
        return data.result === "ok";
      }
      case "xrp": {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "server_info", params: [{}] }),
          signal: controller.signal,
        });
        return res.ok;
      }
      case "btc":
        return checkBtcHealth(rpcUrl, controller.signal);
      case "bch":
        return checkBchHealth(rpcUrl, controller.signal);
      case "xlm":
        return checkXlmHealth(rpcUrl, controller.signal);
      default: {
        const res = await fetch(rpcUrl, { signal: controller.signal });
        return res.ok;
      }
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const REFRESH_OPTIONS = [
  { label: "30s", value: 30 },
  { label: "1m", value: 60 },
  { label: "5m", value: 300 },
];

export function ConfigPage() {
  const [chains, setChains] = useState<Chain[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [serverSettings, setServerSettings] = useState<Settings>({});
  const [serverDefaults, setServerDefaults] = useState<string[]>([]);
  const [serverRefresh, setServerRefresh] = useState(60);
  const [overrides, setOverrides] = useState<UserOverrides>({});
  const [userId, setUserId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [expandedChain, setExpandedChain] = useState<string | null>(null);
  const [rpcStatus, setRpcStatus] = useState<Record<string, RpcStatus>>({});
  const [saved, setSaved] = useState(false);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonTab, setJsonTab] = useState<"edit" | "preview">("edit");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const healthCheckTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    Promise.all([fetchChains(), fetchAssets(), fetchSettings(), getMe()]).then(([c, a, s, me]) => {
      setChains(c);
      setAssets(a);
      setServerSettings(s);
      setServerDefaults((s.default_chains as string[]) ?? []);
      if (s.refresh_interval && typeof s.refresh_interval === "number") {
        setServerRefresh(s.refresh_interval);
      }
      const uid = me?.id;
      setUserId(uid);
      setOverrides(getUserOverrides(uid));
      setLoading(false);

      // Run health checks for all chains
      const userOvr = getUserOverrides(uid);
      for (const chain of c) {
        const url = userOvr.chains?.[chain.name]?.rpcUrl || chain.rpcUrl;
        if (!url) continue;
        setRpcStatus((prev) => ({ ...prev, [chain.name]: "checking" }));
        checkRpcHealth(url, chain.type).then((ok) => {
          setRpcStatus((prev) => ({ ...prev, [chain.name]: ok ? "ok" : "error" }));
        });
      }
    });
  }, []);

  function save(next: UserOverrides) {
    setOverrides(next);
    setUserOverrides(next, userId);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  // ── Chain overrides ──

  function setChainField(name: string, field: "rpcUrl" | "explorerUrl", value: string) {
    const prev = overrides.chains ?? {};
    const chain = { ...prev[name] };
    if (value) {
      chain[field] = value;
    } else {
      delete chain[field];
    }
    const hasOverrides = Object.keys(chain).some((k) => chain[k as keyof typeof chain]);
    const updatedChains = { ...prev };
    if (hasOverrides) updatedChains[name] = chain;
    else delete updatedChains[name];
    save({ ...overrides, chains: Object.keys(updatedChains).length ? updatedChains : undefined });

    // Re-check RPC health when URL changes (debounced — wait 1s after typing stops)
    if (field === "rpcUrl") {
      const chainData = chains.find((c) => c.name === name);
      const url = value || chainData?.rpcUrl || "";
      clearTimeout(healthCheckTimers.current[name]);
      if (url) {
        healthCheckTimers.current[name] = setTimeout(() => {
          setRpcStatus((prev) => ({ ...prev, [name]: "checking" }));
          checkRpcHealth(url, chainData?.type || "evm").then((ok) => {
            setRpcStatus((prev) => ({ ...prev, [name]: ok ? "ok" : "error" }));
          });
        }, 1000);
      }
    }
  }

  function getChainField(name: string, field: "rpcUrl" | "explorerUrl"): string {
    return overrides.chains?.[name]?.[field] ?? "";
  }

  // ── Preferences ──

  function getRefreshInterval(): number {
    return overrides.preferences?.refresh_interval ?? serverRefresh;
  }

  function setRefreshInterval(value: number) {
    const prefs = { ...overrides.preferences };
    if (value === serverRefresh) {
      delete prefs.refresh_interval;
    } else {
      prefs.refresh_interval = value;
    }
    save({ ...overrides, preferences: Object.keys(prefs).length ? prefs : undefined });
  }

  function getShowTestnet(): boolean {
    return overrides.preferences?.show_testnet ?? false;
  }

  function setShowTestnet(value: boolean) {
    const prefs = { ...overrides.preferences };
    if (!value) {
      delete prefs.show_testnet;
    } else {
      prefs.show_testnet = true;
    }
    save({ ...overrides, preferences: Object.keys(prefs).length ? prefs : undefined });
  }

  const isTestnet = (name: string) => /testnet|sepolia|devnet/i.test(name);
  const visibleChains = getShowTestnet() ? chains : chains.filter((c) => !isTestnet(c.name));

  function getDefaultChains(): string[] {
    return overrides.preferences?.default_chains ?? serverDefaults;
  }

  function toggleDefaultChain(name: string) {
    const current = getDefaultChains();
    const next = current.includes(name)
      ? current.filter((c) => c !== name)
      : [...current, name];
    const prefs = { ...overrides.preferences, default_chains: next };
    save({ ...overrides, preferences: prefs });
  }

  // ── Export / Import ──

  function exportConfig() {
    const json = JSON.stringify(overrides, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kexify-config.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyConfig() {
    navigator.clipboard.writeText(JSON.stringify(overrides, null, 2));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function importConfig(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        save(parsed);
      } catch {
        // invalid JSON
      }
    };
    reader.readAsText(file);
  }

  function resetConfig() {
    clearUserOverrides(userId);
    setOverrides({});
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  // ── JSON editor ──

  const pendingMergedConfig = useMemo(() => {
    if (jsonTab !== "preview") return null;
    try {
      const pending = JSON.parse(jsonText) as UserOverrides;
      const mergedChains = chains.map((c) => {
        const fields = pending.chains?.[c.name] ?? {};
        return Object.keys(fields).length ? { ...c, ...fields } : c;
      });
      return {
        chains: mergedChains,
        assets,
        preferences: {
          ...serverSettings,
          default_chains: pending.preferences?.default_chains ?? serverDefaults,
          refresh_interval: pending.preferences?.refresh_interval ?? serverRefresh,
          ...pending.preferences,
        },
      };
    } catch {
      return null;
    }
  }, [jsonText, jsonTab, chains, assets, serverSettings, serverDefaults, serverRefresh]);

  function openJsonEditor() {
    setJsonText(JSON.stringify(overrides, null, 2));
    setJsonError("");
    setJsonTab("edit");
    setJsonMode(true);
  }

  function saveJsonEditor() {
    try {
      const parsed = JSON.parse(jsonText);
      save(parsed);
      setJsonMode(false);
    } catch {
      setJsonError("Invalid JSON");
      setJsonTab("edit");
    }
  }

  function previewJsonEditor() {
    try {
      JSON.parse(jsonText);
      setJsonError("");
      setJsonTab("preview");
    } catch {
      setJsonError("Invalid JSON — fix before previewing");
    }
  }

  const hasOverrides = Object.keys(overrides).length > 0 &&
    (Object.keys(overrides.chains ?? {}).length > 0 || Object.keys(overrides.preferences ?? {}).length > 0);

  if (loading) {
    return (
      <div className="space-y-5">
        <h2 className="text-lg font-semibold text-text-primary">Config</h2>
        <div className="text-xs text-text-muted text-center py-8">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Config</h2>
          <p className="text-xs text-text-muted mt-1">
            Customize networks, preferences, and RPC endpoints. Changes apply instantly.
            {saved && <span className="text-green-400 ml-2">Saved</span>}
          </p>
        </div>
        <button
          onClick={openJsonEditor}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-text-muted hover:text-text-secondary hover:bg-surface-tertiary transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          JSON
        </button>
      </div>

      {/* ── Networks ── */}
      <div>
        <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold mb-2 px-1">
          Networks
        </p>
        <div className="bg-surface-secondary rounded-xl border border-border-primary overflow-hidden divide-y divide-border-secondary">
          {visibleChains.map((chain) => {
            const expanded = expandedChain === chain.name;
            const hasFieldOverrides = !!getChainField(chain.name, "rpcUrl") || !!getChainField(chain.name, "explorerUrl");

            return (
              <div key={chain.id}>
                <button
                  className="w-full flex items-center px-3 md:px-5 py-3 gap-3 text-left hover:bg-surface-tertiary/40 transition-colors"
                  onClick={() => setExpandedChain(expanded ? null : chain.name)}
                >
                  {chain.iconUrl ? (
                    <img src={chain.iconUrl} alt={chain.displayName} className="w-8 h-8 rounded-full bg-surface-tertiary shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-surface-tertiary shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary leading-tight flex items-center gap-1.5">
                      {chain.displayName}
                      {/devnet/i.test(chain.name) ? (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold">devnet</span>
                      ) : /testnet|sepolia/i.test(chain.name) ? (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold">testnet</span>
                      ) : null}
                      {hasFieldOverrides && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-400 font-medium">custom</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        rpcStatus[chain.name] === "ok" ? "bg-green-500 animate-heartbeat" :
                        rpcStatus[chain.name] === "error" ? "bg-red-400" :
                        rpcStatus[chain.name] === "checking" ? "bg-yellow-400 animate-pulse" :
                        "bg-surface-tertiary"
                      }`} />
                      <p className="text-[11px] text-text-muted font-mono truncate">
                        {getChainField(chain.name, "rpcUrl") || chain.rpcUrl || "—"}
                      </p>
                    </div>
                  </div>
                  <svg className={`w-4 h-4 text-text-muted shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {expanded && (
                  <div className="px-3 md:px-5 pb-4 pt-1 space-y-3">
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-xs text-text-muted">RPC URL</label>
                        {getChainField(chain.name, "rpcUrl") && (
                          <button
                            onClick={() => setChainField(chain.name, "rpcUrl", "")}
                            className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
                          >
                            Reset to default
                          </button>
                        )}
                      </div>
                      <div className="relative">
                        <input
                          value={getChainField(chain.name, "rpcUrl")}
                          onChange={(e) => setChainField(chain.name, "rpcUrl", e.target.value)}
                          placeholder={chain.rpcUrl || "No default RPC"}
                          className="w-full bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 pr-8 text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                        />
                        {getChainField(chain.name, "rpcUrl") && (
                          <button
                            onClick={() => setChainField(chain.name, "rpcUrl", "")}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-secondary transition-colors"
                            title="Clear"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-xs text-text-muted">Explorer URL</label>
                        {getChainField(chain.name, "explorerUrl") && (
                          <button
                            onClick={() => setChainField(chain.name, "explorerUrl", "")}
                            className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
                          >
                            Reset to default
                          </button>
                        )}
                      </div>
                      <div className="relative">
                        <input
                          value={getChainField(chain.name, "explorerUrl")}
                          onChange={(e) => setChainField(chain.name, "explorerUrl", e.target.value)}
                          placeholder={chain.explorerUrl}
                          className="w-full bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 pr-8 text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                        />
                        {getChainField(chain.name, "explorerUrl") && (
                          <button
                            onClick={() => setChainField(chain.name, "explorerUrl", "")}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-secondary transition-colors"
                            title="Clear"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Preferences ── */}
      <div>
        <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold mb-2 px-1">
          Preferences
        </p>
        <div className="bg-surface-secondary rounded-xl border border-border-primary overflow-hidden divide-y divide-border-secondary">
          {/* Show testnets */}
          <div className="px-3 md:px-5 py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">Show test networks</p>
                <p className="text-xs text-text-muted mt-0.5">Display testnet and devnet chains</p>
              </div>
              <button
                onClick={() => setShowTestnet(!getShowTestnet())}
                className={`relative w-8 h-[18px] rounded-full transition-colors shrink-0 ${
                  getShowTestnet() ? "bg-blue-500" : "bg-surface-tertiary"
                }`}
              >
                <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
                  getShowTestnet() ? "left-[16px]" : "left-[2px]"
                }`} />
              </button>
            </div>
          </div>

          {/* Refresh interval */}
          <div className="px-3 md:px-5 py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">Refresh interval</p>
                <p className="text-xs text-text-muted mt-0.5">How often balances and prices update</p>
              </div>
              <div className="flex bg-surface-primary border border-border-primary rounded-lg p-0.5 gap-0.5">
                {REFRESH_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setRefreshInterval(opt.value)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      getRefreshInterval() === opt.value
                        ? "bg-surface-tertiary text-text-primary shadow-sm"
                        : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Default chains */}
          <div className="px-3 md:px-5 py-4">
            <p className="text-sm font-medium text-text-primary">Default chains</p>
            <p className="text-xs text-text-muted mt-0.5 mb-3">Chains shown by default for new accounts</p>
            <div className="flex flex-wrap gap-2">
              {chains.filter((c) => !/testnet|sepolia|devnet/i.test(c.name)).map((chain) => {
                const selected = getDefaultChains().includes(chain.name);
                return (
                  <button
                    key={chain.id}
                    onClick={() => toggleDefaultChain(chain.name)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                      selected
                        ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
                        : "bg-surface-primary border-border-primary text-text-muted hover:text-text-secondary hover:border-border-secondary"
                    }`}
                  >
                    {chain.iconUrl && (
                      <img src={chain.iconUrl} alt="" className="w-4 h-4 rounded-full" />
                    )}
                    {chain.displayName}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── Backup & Restore ── */}
      <div>
        <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold mb-2 px-1">
          Backup & Restore
        </p>
        <div className="bg-surface-secondary rounded-xl border border-border-primary overflow-hidden divide-y divide-border-secondary">
          {/* Export */}
          <div className="px-3 md:px-5 py-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">Export config</p>
              <p className="text-xs text-text-muted mt-0.5">Download or copy your overrides</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={copyConfig}
                className="p-2 rounded-lg bg-surface-primary border border-border-primary hover:border-border-secondary text-text-muted hover:text-text-secondary transition-colors"
                title="Copy to clipboard"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
                </svg>
              </button>
              <button
                onClick={exportConfig}
                disabled={!hasOverrides}
                className="px-3 py-2 rounded-lg bg-surface-primary border border-border-primary hover:border-border-secondary text-xs font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Download
              </button>
            </div>
          </div>

          {/* Import */}
          <div className="px-3 md:px-5 py-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">Import config</p>
              <p className="text-xs text-text-muted mt-0.5">Upload a previously exported file</p>
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => { if (e.target.files?.[0]) importConfig(e.target.files[0]); }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-2 rounded-lg bg-surface-primary border border-border-primary hover:border-border-secondary text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
              >
                Upload
              </button>
            </div>
          </div>

          {/* Reset */}
          {hasOverrides && (
            <div className="px-3 md:px-5 py-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">Reset to defaults</p>
                <p className="text-xs text-text-muted mt-0.5">Clear all custom overrides</p>
              </div>
              <button
                onClick={resetConfig}
                className="px-3 py-2 rounded-lg text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors"
              >
                Reset
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── JSON Editor Modal ── */}
      {jsonMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setJsonMode(false)} />
          <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-lg shadow-xl flex flex-col max-h-[80vh]">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-primary">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-semibold text-text-primary">JSON Config</h3>
                <div className="flex bg-surface-primary border border-border-primary rounded-lg p-0.5 gap-0.5">
                  <button
                    onClick={() => setJsonTab("edit")}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                      jsonTab === "edit" ? "bg-surface-tertiary text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setJsonTab("preview")}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                      jsonTab === "preview" ? "bg-surface-tertiary text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    Preview
                  </button>
                </div>
              </div>
              <button
                onClick={() => setJsonMode(false)}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-5 flex-1 overflow-auto">
              {jsonTab === "edit" ? (
                <>
                  <p className="text-xs text-text-muted mb-2">Your overrides (changes only)</p>
                  <div className="w-full h-72 bg-surface-primary border border-border-primary rounded-lg overflow-auto focus-within:border-blue-500 transition-colors">
                    <Editor
                      value={jsonText}
                      onValueChange={(v) => { setJsonText(v); setJsonError(""); }}
                      highlight={highlightCode}
                      padding={12}
                      style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12, lineHeight: 1.6, minHeight: "100%" }}
                    />
                  </div>
                  {jsonError && (
                    <p className="text-xs text-red-400 mt-1.5">{jsonError}</p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-xs text-text-muted mb-2">Preview merged config — verify before saving</p>
                  {pendingMergedConfig ? (
                    <div className="w-full h-72 bg-surface-primary border border-border-primary rounded-lg overflow-auto">
                      <pre
                        className="px-3 py-2.5 text-xs font-mono leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: highlightCode(JSON.stringify(pendingMergedConfig, null, 2)) }}
                      />
                    </div>
                  ) : (
                    <div className="w-full h-72 bg-surface-primary border border-red-500/30 rounded-lg flex items-center justify-center">
                      <p className="text-xs text-red-400">Invalid JSON — go back to fix</p>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-border-primary flex justify-end gap-2">
              <button
                onClick={() => setJsonMode(false)}
                className="bg-surface-tertiary text-text-secondary hover:bg-border-primary px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              {jsonTab === "edit" ? (
                <button
                  onClick={previewJsonEditor}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
                >
                  👀 Preview
                </button>
              ) : (
                <>
                  <button
                    onClick={() => setJsonTab("edit")}
                    className="bg-surface-tertiary text-text-secondary hover:bg-border-primary px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={saveJsonEditor}
                    disabled={!pendingMergedConfig}
                    className="bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    Save
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
