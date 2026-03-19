import { useState, useMemo } from "react";
import type { Chain, Asset } from "../shared/types";
import type { AccountRow } from "../lib/accountRows";
import { ToggleSwitch } from "./ToggleSwitch";
import { Button } from "./ui";
import { fetchTokenMetadata } from "../lib/tokenMetadata";
import { getUserOverrides, setUserOverrides, type CustomToken } from "../lib/userOverrides";
import { getMe } from "../lib/auth";
import staticConfig from "../config.json";

export function ManageDisplayPanel({
  rows,
  displayPrefs,
  defaultChains,
  onToggle,
  onTokenAdded,
}: {
  rows: AccountRow[];
  displayPrefs: Record<string, boolean> | null;
  defaultChains: string[] | null;
  onToggle: (key: string, visible: boolean) => void;
  onTokenAdded?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [showAddToken, setShowAddToken] = useState(false);
  const [addChainId, setAddChainId] = useState("");
  const [addContract, setAddContract] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState("");
  const [addPreview, setAddPreview] = useState<{ symbol: string; name: string; decimals: number; iconUrl: string | null } | null>(null);
  const [addSuccess, setAddSuccess] = useState("");
  const query = search.toLowerCase().trim();

  const uniqueChains = useMemo(() => {
    const seen = new Set<string>();
    const result: { chain: Chain }[] = [];
    for (const row of rows) {
      if (seen.has(row.chain.name)) continue;
      seen.add(row.chain.name);
      result.push({ chain: row.chain });
    }
    return result;
  }, [rows]);

  const tokenAssets = useMemo(() => {
    const seen = new Set<string>();
    const result: { asset: Asset; chainLabel: string }[] = [];
    for (const row of rows) {
      for (const asset of row.assets) {
        if (asset.isNative) continue;
        if (seen.has(asset.id)) continue;
        seen.add(asset.id);
        result.push({ asset, chainLabel: row.label });
      }
    }
    return result;
  }, [rows]);

  const filteredChains = query
    ? uniqueChains.filter(({ chain }) => chain.displayName.toLowerCase().includes(query) || chain.name.toLowerCase().includes(query))
    : uniqueChains;

  const filteredTokens = query
    ? tokenAssets.filter(({ asset, chainLabel }) =>
        asset.symbol.toLowerCase().includes(query) ||
        asset.name.toLowerCase().includes(query) ||
        chainLabel.toLowerCase().includes(query))
    : tokenAssets;

  const showSearch = uniqueChains.length + tokenAssets.length > 8;

  return (
    <div className="mb-2 bg-surface-secondary rounded-lg border border-border-primary overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border-secondary">
        <p className="text-[11px] text-text-muted">
          Choose which chains and tokens to display.
        </p>
      </div>

      {showSearch && (
        <div className="px-3 py-2 border-b border-border-secondary">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter..."
            className="w-full bg-surface-primary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>
      )}

      <div className="divide-y divide-border-secondary max-h-64 overflow-auto">
        {filteredChains.map(({ chain }) => {
          const key = `chain:${chain.name}`;
          const isOn = displayPrefs?.[key] ?? (defaultChains ? defaultChains.includes(chain.name) : true);
          return (
            <div
              key={key}
              onClick={() => onToggle(key, !isOn)}
              className="flex items-center justify-between px-4 py-2 hover:bg-surface-tertiary/30 transition-colors cursor-pointer select-none"
            >
              <div className="flex items-center gap-2.5">
                {chain.iconUrl ? (
                  <img
                    src={chain.iconUrl}
                    alt={chain.displayName}
                    className="w-5 h-5 rounded-full bg-surface-tertiary shrink-0"
                  />
                ) : (
                  <div className="w-5 h-5 rounded-full bg-surface-tertiary shrink-0" />
                )}
                <span className="text-xs text-text-primary font-medium">{chain.displayName}</span>
              </div>
              <ToggleSwitch on={isOn} onToggle={() => onToggle(key, !isOn)} />
            </div>
          );
        })}

        {filteredTokens.length > 0 && (
          <>
            {(!query || filteredChains.length > 0) && (
              <div className="px-4 py-1.5 bg-surface-tertiary/20">
                <span className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">Tokens</span>
              </div>
            )}
            {filteredTokens.map(({ asset, chainLabel }) => {
              const isOn = displayPrefs?.[asset.id] ?? false;
              return (
                <div
                  key={asset.id}
                  onClick={() => onToggle(asset.id, !isOn)}
                  className="flex items-center justify-between px-4 py-2 hover:bg-surface-tertiary/30 transition-colors cursor-pointer select-none"
                >
                  <div className="flex items-center gap-2.5">
                    {asset.iconUrl ? (
                      <img
                        src={asset.iconUrl}
                        alt={asset.symbol}
                        className="w-5 h-5 rounded-full bg-surface-tertiary shrink-0"
                      />
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-surface-tertiary shrink-0" />
                    )}
                    <div>
                      <span className="text-xs text-text-primary font-medium">
                        {asset.symbol}
                      </span>
                      <span className="text-[10px] text-text-muted ml-1.5">
                        {asset.name}
                      </span>
                      <span className="text-[10px] text-text-muted/50 ml-1.5">
                        {chainLabel}
                      </span>
                    </div>
                  </div>
                  <ToggleSwitch on={isOn} onToggle={() => onToggle(asset.id, !isOn)} />
                </div>
              );
            })}
          </>
        )}

        {query && filteredChains.length === 0 && filteredTokens.length === 0 && (
          <div className="px-4 py-4 text-center">
            <p className="text-xs text-text-muted">No matches</p>
          </div>
        )}
      </div>

      {/* Add custom token */}
      <div className="border-t border-border-secondary">
        {addSuccess && (
          <div className="px-4 py-2 text-xs text-green-400">{addSuccess}</div>
        )}
        {!showAddToken ? (
          <button
            onClick={() => { setShowAddToken(true); setAddSuccess(""); }}
            className="w-full px-4 py-2.5 text-xs text-blue-400 hover:text-blue-300 hover:bg-surface-tertiary/30 transition-colors text-left"
          >
            + Add custom token
          </button>
        ) : (
          <div className="px-4 py-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">Add Token</span>
              <button onClick={() => { setShowAddToken(false); setAddPreview(null); setAddError(""); setAddContract(""); }} className="text-[10px] text-text-muted hover:text-text-secondary">Cancel</button>
            </div>

            {/* Chain selector */}
            <select
              value={addChainId}
              onChange={(e) => { setAddChainId(e.target.value); setAddPreview(null); setAddError(""); }}
              className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-blue-500 transition-colors"
            >
              <option value="">Select network...</option>
              {uniqueChains
                .filter(({ chain }) => chain.type === "evm" || chain.type === "solana" || chain.type === "xlm" || chain.type === "tron")
                .map(({ chain }) => (
                  <option key={chain.id} value={chain.id}>{chain.displayName}</option>
                ))}
            </select>

            {/* Contract address input */}
            <input
              value={addContract}
              onChange={(e) => { setAddContract(e.target.value); setAddPreview(null); setAddError(""); }}
              placeholder={addChainId && uniqueChains.find(c => c.chain.id === addChainId)?.chain.type === "xlm" ? "CODE:ISSUER_ADDRESS" : addChainId && uniqueChains.find(c => c.chain.id === addChainId)?.chain.type === "tron" ? "TRC-20 contract address (T...)" : "Contract address"}
              className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
            />

            {/* Fetch button */}
            <Button
              size="sm"
              fullWidth
              onClick={async () => {
                const chain = uniqueChains.find(c => c.chain.id === addChainId)?.chain;
                if (!chain || !addContract.trim()) return;
                setAddLoading(true);
                setAddError("");
                setAddPreview(null);
                try {
                  const meta = await fetchTokenMetadata(chain.type, addContract.trim(), chain.rpcUrl, chain.evmChainId);
                  // Check for symbol conflict with config.json on same chain
                  const configAssets = (staticConfig.assets as Asset[]).filter(a => a.chainId === chain.id);
                  const conflict = configAssets.find(a => a.symbol.toUpperCase() === meta.symbol.toUpperCase());
                  if (conflict) {
                    setAddError(`Symbol "${meta.symbol}" already exists on ${chain.displayName} as a built-in token.`);
                    return;
                  }
                  setAddPreview(meta);
                } catch (err: unknown) {
                  setAddError((err as { message?: string })?.message || "Failed to fetch token info");
                } finally {
                  setAddLoading(false);
                }
              }}
              disabled={!addChainId || !addContract.trim() || addLoading}
            >
              {addLoading ? "Fetching..." : "Fetch token info"}
            </Button>

            {addError && <p className="text-[11px] text-red-400">{addError}</p>}

            {/* Preview + confirm */}
            {addPreview && (
              <div className="bg-surface-primary border border-border-primary rounded-lg p-2.5 space-y-1.5">
                <div className="flex items-center gap-2">
                  {addPreview.iconUrl ? (
                    <img src={addPreview.iconUrl} alt="" className="w-5 h-5 rounded-full bg-surface-tertiary" />
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-surface-tertiary" />
                  )}
                  <span className="text-xs font-medium text-text-primary">{addPreview.symbol}</span>
                  <span className="text-[10px] text-text-muted">{addPreview.name}</span>
                </div>
                <p className="text-[10px] text-text-muted">Decimals: {addPreview.decimals}</p>
                <Button
                  size="sm"
                  fullWidth
                  className="bg-green-600 hover:bg-green-500"
                  onClick={async () => {
                    const chain = uniqueChains.find(c => c.chain.id === addChainId)?.chain;
                    if (!chain || !addPreview) return;
                    const me = await getMe();
                    const overrides = getUserOverrides(me?.id);
                    const existing = overrides.customTokens ?? [];
                    const tokenId = `custom:${chain.id}:${addContract.trim().toLowerCase()}`;
                    // Skip if already added
                    if (existing.some(t => t.id === tokenId)) {
                      setAddError("This token is already added.");
                      return;
                    }
                    const newToken: CustomToken = {
                      id: tokenId,
                      symbol: addPreview.symbol,
                      name: addPreview.name,
                      decimals: addPreview.decimals,
                      contractAddress: addContract.trim(),
                      iconUrl: addPreview.iconUrl,
                      chainId: chain.id,
                      addedAt: Date.now(),
                    };
                    setUserOverrides({ ...overrides, customTokens: [...existing, newToken] }, me?.id);
                    // Auto-enable display
                    onToggle(tokenId, true);
                    setShowAddToken(false);
                    setAddPreview(null);
                    setAddContract("");
                    setAddChainId("");
                    setAddSuccess(`${addPreview.symbol} added — balance will appear shortly`);
                    setTimeout(() => setAddSuccess(""), 4000);
                    onTokenAdded?.();
                  }}
                >
                  Add {addPreview.symbol}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
