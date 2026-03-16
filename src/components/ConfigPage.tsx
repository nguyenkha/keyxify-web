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
  const [saved, setSaved] = useState(false);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonTab, setJsonTab] = useState<"edit" | "preview">("edit");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    const chains = { ...prev };
    if (hasOverrides) chains[name] = chain;
    else delete chains[name];
    save({ ...overrides, chains: Object.keys(chains).length ? chains : undefined });
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
            Customize networks, preferences, and RPC endpoints.
            {saved && <span className="text-green-400 ml-2">Saved</span>}
          </p>
        </div>
        <button
          onClick={openJsonEditor}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-text-muted hover:text-text-secondary hover:bg-surface-tertiary transition-colors"
        >
          <span className="font-mono">{"{config:json}"}</span>
        </button>
      </div>

      {/* ── Networks ── */}
      <div>
        <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold mb-2 px-1">
          Networks
        </p>
        <div className="bg-surface-secondary rounded-xl border border-border-primary overflow-hidden divide-y divide-border-secondary">
          {chains.map((chain) => {
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
                    <p className="text-[11px] text-text-muted font-mono truncate mt-0.5">
                      {getChainField(chain.name, "rpcUrl") || chain.rpcUrl || "—"}
                    </p>
                  </div>
                  <svg className={`w-4 h-4 text-text-muted shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {expanded && (
                  <div className="px-3 md:px-5 pb-4 pt-1 space-y-3">
                    <div>
                      <label className="block text-xs text-text-muted mb-1.5">RPC URL</label>
                      <input
                        value={getChainField(chain.name, "rpcUrl")}
                        onChange={(e) => setChainField(chain.name, "rpcUrl", e.target.value)}
                        placeholder={chain.rpcUrl || "No default RPC"}
                        className="w-full bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1.5">Explorer URL</label>
                      <input
                        value={getChainField(chain.name, "explorerUrl")}
                        onChange={(e) => setChainField(chain.name, "explorerUrl", e.target.value)}
                        placeholder={chain.explorerUrl}
                        className="w-full bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                      />
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
