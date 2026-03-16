import { useState, useMemo } from "react";
import type { Chain, Asset } from "../shared/types";
import type { AccountRow } from "../lib/accountRows";
import { ToggleSwitch } from "./ToggleSwitch";

export function ManageDisplayPanel({
  rows,
  displayPrefs,
  defaultChains,
  onToggle,
}: {
  rows: AccountRow[];
  displayPrefs: Record<string, boolean> | null;
  defaultChains: string[] | null;
  onToggle: (key: string, visible: boolean) => void;
}) {
  const [search, setSearch] = useState("");
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
              className="flex items-center justify-between px-4 py-2 hover:bg-surface-tertiary/30 transition-colors"
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
                  className="flex items-center justify-between px-4 py-2 hover:bg-surface-tertiary/30 transition-colors"
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
    </div>
  );
}
