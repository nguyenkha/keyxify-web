import { useState, useEffect } from "react";
import { useExpertMode } from "../context/ExpertModeContext";
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
import { isTokenVisible, findNewTokens } from "../lib/displayPrefs";
import { explorerLink } from "../shared/utils";
import { useHideBalances, maskBalance } from "../context/HideBalancesContext";

const DEFAULT_POLL_INTERVAL = 60_000;

export function AccountRowView({
  row,
  displayPrefs,
  pollInterval = DEFAULT_POLL_INTERVAL,
  onTokenDecision,
}: {
  row: AccountRow;
  displayPrefs: Record<string, boolean> | null;
  pollInterval?: number;
  onTokenDecision?: (assetId: string, visible: boolean) => void;
}) {
  const navigate = useNavigate();
  const expert = useExpertMode();
  const { hidden } = useHideBalances();
  const [nativeBalance, setNativeBalance] = useState<BalanceResult | null>(null);
  const [nativeState, setNativeState] = useState<"loading" | "loaded" | "error">("loading");
  const [tokenBalances, setTokenBalances] = useState<BalanceResult[]>([]);
  const [tokenState, setTokenState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [copied, setCopied] = useState(false);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [dismissedTokens, setDismissedTokens] = useState<Set<string>>(new Set());

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
        className="flex items-center h-[68px] px-3 md:px-5 hover:bg-surface-tertiary/40 transition-colors group cursor-pointer"
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
                <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold">devnet</span>
              ) : /testnet|sepolia/i.test(row.chain.name) ? (
                <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold">testnet</span>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span
                className={`text-[11px] text-text-muted font-mono transition-colors ${expert ? "cursor-pointer hover:text-text-tertiary" : ""}`}
                onClick={expert ? copyAddress : undefined}
                title={expert ? row.address : undefined}
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

      {/* Token rows — indented with smaller icon to show hierarchy */}
      {tokenState === "loaded" && tokenBalances.length > 0 &&
        tokenBalances
          .filter((b) => isTokenVisible(b.asset.id, displayPrefs, b.formatted))
          .map((b) => {
            const tokenUsd = getUsdValue(b.formatted, b.asset.symbol, prices);
            return (
              <div
                key={b.asset.id}
                className="flex items-center h-14 pl-8 md:pl-12 pr-3 md:pr-5 hover:bg-surface-tertiary/40 transition-colors cursor-pointer group"
                onClick={() =>
                  navigate(`/accounts/${row.keyId}/${row.chain.name.toLowerCase()}/${b.asset.symbol}${row.btcAddrType ? `/${row.btcAddrType}` : ""}`)
                }
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  {b.asset.iconUrl ? (
                    <img
                      src={b.asset.iconUrl}
                      alt={b.asset.symbol}
                      className="w-7 h-7 rounded-full bg-surface-tertiary shrink-0"
                    />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-surface-tertiary shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-text-secondary leading-tight flex items-center gap-1.5">
                      {b.asset.name.replace(/\s*\(?\s*(testnet|devnet)\s*\)?\s*/gi, " ").trim()}
                      {/devnet/i.test(row.chain.name) ? (
                        <span className="text-[8px] px-0.5 py-px rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold leading-none">devnet</span>
                      ) : /testnet|sepolia/i.test(row.chain.name) ? (
                        <span className="text-[8px] px-0.5 py-px rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold leading-none">testnet</span>
                      ) : null}
                    </div>
                  </div>
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
                  <svg className="w-4 h-4 text-text-muted/30 group-hover:text-text-muted transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            );
          })
      }

      {/* Token discovery prompts */}
      {tokenState === "loaded" && onTokenDecision && (() => {
        const newTokens = findNewTokens(tokenBalances, displayPrefs)
          .filter((t) => !dismissedTokens.has(t.id));
        if (newTokens.length === 0) return null;
        return newTokens.map((token) => (
          <div
            key={token.id}
            className="px-3 md:px-5 py-2.5 border-t border-border-secondary"
          >
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-text-muted">
                <span className="text-text-secondary font-medium">{token.symbol}</span>
                {" "}found
                <span className="tabular-nums ml-1">({maskBalance(token.balance, hidden)})</span>
              </p>
              <div className="flex items-center gap-3 shrink-0 mr-8">
                <button
                  onClick={() => onTokenDecision(token.id, false)}
                  className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                  </svg>
                  Hide
                </button>
                <button
                  onClick={() => setDismissedTokens((prev) => new Set(prev).add(token.id))}
                  className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Later
                </button>
                <button
                  onClick={() => onTokenDecision(token.id, true)}
                  className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Show
                </button>
              </div>
            </div>
          </div>
        ));
      })()}

    </div>
  );
}
