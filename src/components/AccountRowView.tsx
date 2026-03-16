import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { AccountRow } from "../lib/accountRows";
import {
  fetchNativeBalance,
  fetchTokenBalances,
  getCachedNativeBalance,
  getCachedTokenBalances,
  type BalanceResult,
} from "../lib/balance";
import { clearCache, balanceCacheKey, tokenBalancesCacheKey } from "../lib/dataCache";
import { fetchPrices, formatUsd, getUsdValue } from "../lib/prices";
import { isTokenVisible } from "../lib/displayPrefs";
import { explorerLink } from "../shared/utils";
import { useHideBalances, maskBalance } from "../context/HideBalancesContext";

const DEFAULT_POLL_INTERVAL = 60_000;

export function AccountRowView({
  row,
  displayPrefs,
  pollInterval = DEFAULT_POLL_INTERVAL,
}: {
  row: AccountRow;
  displayPrefs: Record<string, boolean> | null;
  pollInterval?: number;
}) {
  const navigate = useNavigate();
  const { hidden } = useHideBalances();
  const [nativeBalance, setNativeBalance] = useState<BalanceResult | null>(null);
  const [nativeState, setNativeState] = useState<"loading" | "loaded" | "error">("loading");
  const [tokenBalances, setTokenBalances] = useState<BalanceResult[]>([]);
  const [tokenState, setTokenState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [copied, setCopied] = useState(false);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [tokensExpanded, setTokensExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Show cached balance instantly if available
    const cached = getCachedNativeBalance(row.address, row.chain, row.assets);
    if (cached) {
      setNativeBalance(cached.data);
      setNativeState("loaded");
      // If cache is fresh, skip initial fetch
      if (cached.fresh) {
        const iv = setInterval(() => {
          fetchNativeBalance(row.address, row.chain, row.assets)
            .then((result) => {
              if (!cancelled) {
                setNativeBalance(result);
                setNativeState("loaded");
              }
            })
            .catch(() => {});
        }, pollInterval);
        return () => { cancelled = true; clearInterval(iv); };
      }
    } else {
      setNativeState("loading");
    }

    // Fetch fresh data
    fetchNativeBalance(row.address, row.chain, row.assets)
      .then((result) => {
        if (cancelled) return;
        setNativeBalance(result);
        setNativeState("loaded");
      })
      .catch(() => {
        if (!cancelled && !cached) setNativeState("error");
      });

    const iv = setInterval(() => {
      fetchNativeBalance(row.address, row.chain, row.assets)
        .then((result) => {
          if (!cancelled) {
            setNativeBalance(result);
            setNativeState("loaded");
          }
        })
        .catch(() => {});
    }, pollInterval);

    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [row.address, row.chain, row.assets]);

  useEffect(() => {
    fetchPrices().then(setPrices);
    const iv = setInterval(() => fetchPrices().then(setPrices), pollInterval);
    return () => clearInterval(iv);
  }, []);

  const hasTokenAssets = row.assets.some((a) => !a.isNative && a.contractAddress);
  useEffect(() => {
    if (nativeState !== "loaded" || !hasTokenAssets) return;
    let cancelled = false;

    // Show cached token balances instantly if available
    const cached = getCachedTokenBalances(row.address, row.chain);
    if (cached) {
      setTokenBalances(cached.data);
      setTokenState("loaded");
      if (cached.fresh) {
        const iv = setInterval(() => {
          fetchTokenBalances(row.address, row.chain, row.assets)
            .then((results) => {
              if (!cancelled) {
                setTokenBalances(results);
                setTokenState("loaded");
              }
            })
            .catch(() => {});
        }, pollInterval);
        return () => { cancelled = true; clearInterval(iv); };
      }
    } else {
      setTokenState("loading");
    }

    fetchTokenBalances(row.address, row.chain, row.assets)
      .then((results) => {
        if (cancelled) return;
        setTokenBalances(results);
        setTokenState("loaded");
      })
      .catch(() => {
        if (!cancelled && !cached) setTokenState("error");
      });

    const iv = setInterval(() => {
      fetchTokenBalances(row.address, row.chain, row.assets)
        .then((results) => {
          if (!cancelled) {
            setTokenBalances(results);
            setTokenState("loaded");
          }
        })
        .catch(() => {});
    }, pollInterval);

    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [nativeState, row.address, row.chain, row.assets, hasTokenAssets]);

  function refreshAll(e?: React.MouseEvent) {
    e?.stopPropagation();
    // Clear cache so fetchNativeBalance/fetchTokenBalances hit the network
    const nativeAsset = row.assets.find((a) => a.isNative);
    if (nativeAsset) clearCache(balanceCacheKey(row.address, row.chain.id, nativeAsset.id));
    clearCache(tokenBalancesCacheKey(row.address, row.chain.id));
    setNativeState("loading");
    setTokenState("idle");
    setTokenBalances([]);
    fetchNativeBalance(row.address, row.chain, row.assets)
      .then((result) => {
        setNativeBalance(result);
        setNativeState("loaded");
      })
      .catch(() => {
        setNativeState("error");
      });
  }

  function copyAddress(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(row.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const shortAddr =
    row.address.length > 20
      ? `${row.address.slice(0, 8)}...${row.address.slice(-6)}`
      : row.address;

  const chainColor =
    row.addressType === "evm" ? "bg-blue-500" : row.addressType === "solana" ? "bg-purple-500" : "bg-orange-500";

  const nativeAsset = row.assets.find((a) => a.isNative);
  const nativeSymbol = nativeBalance?.asset.symbol || nativeAsset?.symbol || "";


  /** Truncate a formatted balance to at most ~10 visible digits */
  function truncateBalance(val: string): string {
    if (!val.includes(".")) return val;
    const [int, frac] = val.split(".");
    const maxFrac = Math.max(0, 10 - int.length);
    if (maxFrac === 0) return int;
    const trimmed = frac.slice(0, maxFrac).replace(/0+$/, "");
    return trimmed ? `${int}.${trimmed}` : int;
  }

  function handleNativeClick() {
    if (nativeState !== "loaded" || !nativeAsset) return;
    const suffix = row.btcAddrType ? `/${row.btcAddrType}` : "";
    navigate(`/accounts/${row.keyId}/${row.chain.name.toLowerCase()}/${nativeAsset.symbol}${suffix}`);
  }

  const nativeUsd = nativeBalance
    ? getUsdValue(nativeBalance.formatted, nativeSymbol, prices)
    : null;

  return (
    <div>
      {/* Main row */}
      <div
        className="relative flex items-center h-[68px] px-3 md:px-5 hover:bg-surface-tertiary/40 transition-colors group cursor-pointer"
        onClick={handleNativeClick}
      >
        {/* Left: icon + label + address */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {row.chain.iconUrl ? (
            <img
              src={row.chain.iconUrl}
              alt={row.label}
              className="w-9 h-9 rounded-full bg-surface-tertiary shrink-0"
            />
          ) : (
            <div
              className={`w-9 h-9 rounded-full ${chainColor} flex items-center justify-center text-xs font-bold text-white shrink-0`}
            >
              {row.addressType === "evm" ? "E" : row.addressType === "solana" ? "S" : "B"}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-primary leading-tight flex items-center gap-1.5">
              {row.label.replace(/\s*\(?\s*(testnet|devnet)\s*\)?\s*/gi, " ").trim()}
              {/devnet/i.test(row.chain.name) ? (
                <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold">devnet</span>
              ) : /testnet|sepolia/i.test(row.chain.name) ? (
                <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold">testnet</span>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span
                className="text-[11px] text-text-muted font-mono cursor-pointer hover:text-text-tertiary transition-colors"
                onClick={copyAddress}
                title={row.address}
              >
                {copied ? (
                  <span className="text-green-500">Copied!</span>
                ) : (
                  shortAddr
                )}
              </span>
              <a
                href={explorerLink(row.chain.explorerUrl, `/address/${row.address}`)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-text-muted/40 hover:text-text-tertiary transition-colors"
                title="View on explorer"
              >
                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            </div>
          </div>
        </div>

        {/* Center: token count badge — absolute center of row */}
        {tokenBalances.length > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setTokensExpanded((v) => !v);
            }}
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center text-[10px] font-medium rounded-full transition-all z-10 group/token ${
              tokensExpanded
                ? "bg-blue-500/10 text-blue-400"
                : "bg-surface-tertiary text-text-muted hover:text-text-tertiary"
            }`}
            title={tokensExpanded ? "Collapse tokens" : `${tokenBalances.length} tokens — click to expand`}
          >
            <span className="md:group-hover/token:hidden">{tokenBalances.length}</span>
            <svg className="w-3.5 h-3.5 hidden md:group-hover/token:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              {tokensExpanded
                ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                : <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              }
            </svg>
          </button>
        )}

        {/* Right: balance + chevron */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-right min-w-[4rem]">
            {nativeState === "loading" && (
              <div className="space-y-1.5">
                <div className="h-4 w-16 bg-surface-tertiary rounded animate-pulse" />
                <div className="h-3 w-10 bg-surface-tertiary/60 rounded animate-pulse ml-auto" />
              </div>
            )}
            {nativeState === "error" && (
              <button
                onClick={(e) => refreshAll(e)}
                className="text-xs text-red-500 hover:text-red-400"
              >
                Failed - retry
              </button>
            )}
            {nativeState === "loaded" && (
              <div>
                <div className="flex items-baseline justify-end gap-1 text-sm tabular-nums font-medium text-text-primary">
                  <span>{maskBalance(nativeBalance ? truncateBalance(nativeBalance.formatted) : "0", hidden)}</span>
                  <span className="text-[11px] text-text-muted font-normal">{nativeSymbol}</span>
                </div>
                {nativeUsd != null && (
                  <div className="text-[11px] text-text-muted tabular-nums">{hidden ? "••••" : formatUsd(nativeUsd)}</div>
                )}
              </div>
            )}
          </div>

          {/* Chevron */}
          <svg className="w-4 h-4 text-text-muted/30 group-hover:text-text-muted transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </div>

      {/* Token sub-rows */}
      {tokensExpanded && tokenState === "loaded" && tokenBalances.length > 0 &&
        tokenBalances
          .filter((b) => isTokenVisible(b.asset.id, displayPrefs, b.formatted))
          .map((b) => {
            const tokenUsd = getUsdValue(b.formatted, b.asset.symbol, prices);
            return (
              <div
                key={b.asset.id}
                className="flex items-center h-12 px-3 md:px-5 hover:bg-surface-tertiary/40 transition-colors cursor-pointer group"
                onClick={() =>
                  navigate(`/accounts/${row.keyId}/${row.chain.name.toLowerCase()}/${b.asset.symbol}${row.btcAddrType ? `/${row.btcAddrType}` : ""}`)
                }
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1 pl-[2.75rem]">
                  {b.asset.iconUrl ? (
                    <img
                      src={b.asset.iconUrl}
                      alt={b.asset.symbol}
                      className="w-6 h-6 rounded-full bg-surface-tertiary shrink-0"
                    />
                  ) : (
                    <div className="w-6 h-6 rounded-full bg-surface-tertiary shrink-0" />
                  )}
                  <span className="text-xs text-text-secondary truncate flex items-center gap-1">
                    {b.asset.name.replace(/\s*\(?\s*(testnet|devnet)\s*\)?\s*/gi, " ").trim()}
                    {/devnet/i.test(row.chain.name) ? (
                      <span className="text-[8px] px-0.5 py-px rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold leading-none">devnet</span>
                    ) : /testnet|sepolia/i.test(row.chain.name) ? (
                      <span className="text-[8px] px-0.5 py-px rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold leading-none">testnet</span>
                    ) : null}
                  </span>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-right min-w-[4rem]">
                    <div className="flex items-baseline justify-end gap-1 text-xs tabular-nums font-medium text-text-secondary">
                      <span>{maskBalance(truncateBalance(b.formatted), hidden)}</span>
                      <span className="text-text-muted font-normal">{b.asset.symbol}</span>
                    </div>
                    {tokenUsd != null && (
                      <div className="text-[10px] text-text-muted tabular-nums">{hidden ? "••••" : formatUsd(tokenUsd)}</div>
                    )}
                  </div>
                  <div className="w-[26px] hidden md:block" />
                  <div className="w-4 hidden sm:block" />
                </div>
              </div>
            );
          })
      }

    </div>
  );
}
