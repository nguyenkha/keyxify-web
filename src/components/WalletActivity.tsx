import { useState, useEffect, useCallback } from "react";
import type { Transaction } from "../shared/types";
import type { AccountRow } from "../lib/accountRows";
import { fetchTransactions } from "../lib/transactions";
import { getStaleCache, setCache, txCacheKey, evictTxCaches } from "../lib/dataCache";
import { TxRow } from "./TxRow";
import { Spinner } from "./ui";

interface ChainTxResult {
  chainName: string;
  chainIcon: string | null;
  explorerUrl: string;
  txs: Transaction[];
  hasMore: boolean;
  page: number;
  error: boolean;
}

/** Deduplicate accountRows by address+chainId (same address appears once per chain) */
function uniqueAddressChains(rows: AccountRow[]) {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.address}:${r.chain.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatLastUpdated(date: Date): string {
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

interface WalletActivityProps {
  accountRows: AccountRow[];
  pollInterval: number;
}

export function WalletActivity({ accountRows, pollInterval }: WalletActivityProps) {
  const [results, setResults] = useState<Map<string, ChainTxResult>>(new Map());
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [, setTick] = useState(0);

  const uniqueRows = uniqueAddressChains(accountRows);

  // Re-render every 10s to update "last updated" label
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(iv);
  }, []);

  // Load stale cache immediately on mount
  useEffect(() => {
    const initial = new Map<string, ChainTxResult>();
    let hasStale = false;
    for (const row of uniqueAddressChains(accountRows)) {
      const key = `${row.address}:${row.chain.id}`;
      const cacheK = txCacheKey(row.address, row.chain.id);
      const cached = getStaleCache<Transaction[]>(cacheK);
      if (cached) {
        hasStale = true;
        initial.set(key, {
          chainName: row.chain.displayName,
          chainIcon: row.chain.iconUrl,
          explorerUrl: row.chain.explorerUrl,
          txs: cached.data,
          hasMore: false,
          page: 1,
          error: false,
        });
      }
    }
    if (hasStale) {
      setResults(initial);
      setLoading(false); // Show stale data immediately, fetch fresh in background
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchAll = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);

    const fetches = uniqueRows.map(async (row) => {
      const key = `${row.address}:${row.chain.id}`;
      const nativeAsset = row.assets.find((a) => a.isNative) ?? row.assets[0];
      if (!nativeAsset) return;
      try {
        const { transactions, hasMore } = await fetchTransactions(row.address, row.chain, nativeAsset, 1);
        // Cache the fetched transactions
        setCache(txCacheKey(row.address, row.chain.id), transactions);
        setResults((prev) => {
          const next = new Map(prev);
          next.set(key, {
            chainName: row.chain.displayName,
            chainIcon: row.chain.iconUrl,
            explorerUrl: row.chain.explorerUrl,
            txs: transactions,
            hasMore,
            page: 1,
            error: false,
          });
          return next;
        });
      } catch {
        setResults((prev) => {
          const existing = prev.get(key);
          if (existing && isRefresh) return prev; // Keep stale data on refresh error
          const next = new Map(prev);
          next.set(key, {
            chainName: row.chain.displayName,
            chainIcon: row.chain.iconUrl,
            explorerUrl: row.chain.explorerUrl,
            txs: [],
            hasMore: false,
            page: 1,
            error: true,
          });
          return next;
        });
      }
    });

    await Promise.allSettled(fetches);
    evictTxCaches(50);
    setLoading(false);
    setLastUpdated(new Date());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountRows]);

  useEffect(() => {
    fetchAll();
    const iv = setInterval(() => fetchAll(true), pollInterval);
    return () => clearInterval(iv);
  }, [fetchAll, pollInterval]);

  // Merge all transactions sorted by timestamp desc, with chain context
  const merged = Array.from(results.entries()).flatMap(([, result]) =>
    result.txs.map((tx) => ({
      tx,
      chainName: result.chainName,
      chainIcon: result.chainIcon,
      explorerUrl: result.explorerUrl,
    }))
  ).sort((a, b) => b.tx.timestamp - a.tx.timestamp);

  const failedChains = Array.from(results.values()).filter((r) => r.error);
  const allEmpty = !loading && merged.length === 0 && failedChains.length === 0;

  return (
    <div>
      {/* Loading skeleton */}
      {loading && merged.length === 0 && (
        <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden divide-y divide-border-secondary">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center px-4 py-3.5 animate-pulse">
              <div className="w-8 h-8 rounded-full bg-surface-tertiary shrink-0 mr-3" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-24 bg-surface-tertiary rounded" />
                <div className="h-2.5 w-36 bg-surface-tertiary/60 rounded" />
              </div>
              <div className="space-y-1.5 text-right">
                <div className="h-3.5 w-16 bg-surface-tertiary rounded ml-auto" />
                <div className="h-2.5 w-10 bg-surface-tertiary/60 rounded ml-auto" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {allEmpty && (
        <div className="px-4 py-10 text-center">
          <svg className="w-8 h-8 text-text-muted mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
          </svg>
          <p className="text-sm text-text-tertiary">No transactions yet</p>
          <p className="text-xs text-text-muted mt-1">Activity across all your chains will appear here.</p>
        </div>
      )}

      {/* Failed chains retry */}
      {failedChains.length > 0 && merged.length === 0 && !loading && (
        <div className="px-4 py-6 text-center">
          <p className="text-xs text-text-tertiary mb-1">
            Failed to load from {failedChains.map((c) => c.chainName).join(", ")}
          </p>
          <button
            onClick={() => fetchAll()}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {/* Transaction list */}
      {merged.length > 0 && (
        <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden divide-y divide-border-secondary">
          {merged.map(({ tx, chainName, chainIcon, explorerUrl }, i) => (
            <div key={`${tx.hash}-${i}`} className="relative">
              {/* Chain badge — below tx row on mobile, top-right on desktop */}
              <div className="flex items-center gap-1 px-3 md:px-4 pt-1 md:pt-0 md:absolute md:top-2 md:right-2 md:z-10 md:px-1.5 md:py-0.5 md:rounded md:bg-surface-tertiary/80">
                {chainIcon && (
                  <img src={chainIcon} alt={chainName} className="w-3 h-3 rounded-full" />
                )}
                <span className="text-[9px] text-text-muted font-medium">{chainName}</span>
              </div>
              <TxRow tx={tx} explorerUrl={explorerUrl} />
            </div>
          ))}
        </div>
      )}

      {/* Partial errors banner */}
      {failedChains.length > 0 && merged.length > 0 && (
        <div className="mt-2 flex items-center gap-2 px-1">
          <span className="text-[10px] text-text-muted">
            Could not load: {failedChains.map((c) => c.chainName).join(", ")}
          </span>
          <button
            onClick={() => fetchAll()}
            className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading indicator during refresh */}
      {loading && merged.length > 0 && (
        <div className="flex items-center justify-center gap-2 mt-2">
          <Spinner size="xs" />
          <span className="text-[10px] text-text-muted">Updating...</span>
        </div>
      )}

      {/* Last updated indicator */}
      {lastUpdated && !loading && (
        <div className="flex items-center gap-1.5 px-1 mt-2">
          <span className="text-[10px] text-text-muted tabular-nums">
            Updated {formatLastUpdated(lastUpdated)}
          </span>
          <button
            onClick={() => fetchAll()}
            className="text-text-muted hover:text-text-secondary transition-colors p-0.5 rounded hover:bg-surface-tertiary"
            title="Refresh"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
