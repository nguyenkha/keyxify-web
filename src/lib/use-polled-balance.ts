import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { AccountRow } from "./accountRows";
import type { BalanceResult } from "../shared/types";
import {
  fetchNativeBalance,
  fetchTokenBalances,
  getCachedNativeBalance,
  getCachedTokenBalances,
} from "./balance";
import { clearCache, balanceCacheKey, tokenBalancesCacheKey } from "./dataCache";
import { notify } from "./notify";

const DEFAULT_POLL_INTERVAL = 60_000;

type LoadState = "loading" | "loaded" | "error";

export function usePolledBalance(
  row: AccountRow,
  pollInterval = DEFAULT_POLL_INTERVAL
) {
  const { t } = useTranslation();
  const [nativeBalance, setNativeBalance] = useState<BalanceResult | null>(null);
  const [nativeState, setNativeState] = useState<LoadState>("loading");
  const [tokenBalances, setTokenBalances] = useState<BalanceResult[]>([]);
  const [tokenState, setTokenState] = useState<"idle" | LoadState>("idle");

  // Track previous balance for change detection (animation)
  const prevNativeRef = useRef<string | null>(null);
  const prevTokenRef = useRef<Map<string, string>>(new Map());
  const [nativeChanged, setNativeChanged] = useState<"up" | "down" | null>(null);
  const [tokenChanges, setTokenChanges] = useState<Map<string, "up" | "down">>(new Map());

  // Detect balance direction change and trigger brief flash
  function detectChange(prev: string | null, next: string): "up" | "down" | null {
    if (prev === null || prev === next) return null;
    const p = parseFloat(prev);
    const n = parseFloat(next);
    if (isNaN(p) || isNaN(n) || p === n) return null;
    return n > p ? "up" : "down";
  }

  // Native balance polling
  useEffect(() => {
    let cancelled = false;

    const cached = getCachedNativeBalance(row.address, row.chain, row.assets);
    if (cached) {
      setNativeBalance(cached.data);
      setNativeState("loaded");
      prevNativeRef.current = cached.data.formatted;
      if (cached.fresh) {
        const iv = setInterval(() => doFetchNative(false), pollInterval);
        return () => { cancelled = true; clearInterval(iv); };
      }
    } else {
      setNativeState("loading");
    }

    doFetchNative(true);
    const iv = setInterval(() => doFetchNative(false), pollInterval);
    return () => { cancelled = true; clearInterval(iv); };

    function doFetchNative(isInitial: boolean) {
      fetchNativeBalance(row.address, row.chain, row.assets)
        .then((result) => {
          if (cancelled) return;
          if (result) {
            const dir = detectChange(prevNativeRef.current, result.formatted);
            if (dir) {
              setNativeChanged(dir);
              setTimeout(() => setNativeChanged(null), 1200);
              const nativeAsset = row.assets.find((a) => a.isNative);
              const symbol = nativeAsset?.symbol || row.chain.displayName;
              const suffix = row.btcAddrType ? `/${row.btcAddrType}` : "";
              notify({
                title: t(dir === "up" ? "notify.balanceUp" : "notify.balanceDown"),
                body: `${symbol}: ${result.formatted}`,
                path: `/accounts/${row.keyId}/${row.chain.name.toLowerCase()}/${symbol}${suffix}`,
                tag: `bal-${row.address}-${symbol}-${result.formatted}`,
              });
            }
            prevNativeRef.current = result.formatted;
          }
          setNativeBalance(result);
          setNativeState("loaded");
        })
        .catch(() => {
          if (!cancelled && isInitial && !cached) setNativeState("error");
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.address, row.chain, row.assets]);

  // Token balance polling — waits for native to load
  const hasTokenAssets = row.assets.some((a) => !a.isNative && a.contractAddress);
  useEffect(() => {
    if (nativeState !== "loaded" || !hasTokenAssets) return;
    let cancelled = false;

    const cached = getCachedTokenBalances(row.address, row.chain);
    if (cached) {
      setTokenBalances(cached.data);
      setTokenState("loaded");
      for (const b of cached.data) prevTokenRef.current.set(b.asset.id, b.formatted);
      if (cached.fresh) {
        const iv = setInterval(() => doFetchTokens(false), pollInterval);
        return () => { cancelled = true; clearInterval(iv); };
      }
    } else {
      setTokenState("loading");
    }

    doFetchTokens(true);
    const iv = setInterval(() => doFetchTokens(false), pollInterval);
    return () => { cancelled = true; clearInterval(iv); };

    function doFetchTokens(isInitial: boolean) {
      fetchTokenBalances(row.address, row.chain, row.assets)
        .then((results) => {
          if (cancelled) return;
          const changes = new Map<string, "up" | "down">();
          for (const b of results) {
            const dir = detectChange(prevTokenRef.current.get(b.asset.id) ?? null, b.formatted);
            if (dir) changes.set(b.asset.id, dir);
            prevTokenRef.current.set(b.asset.id, b.formatted);
          }
          if (changes.size > 0) {
            setTokenChanges(changes);
            setTimeout(() => setTokenChanges(new Map()), 1200);
            // Notify for each changed token — click opens token detail
            const suffix = row.btcAddrType ? `/${row.btcAddrType}` : "";
            for (const [assetId, dir] of changes) {
              const b = results.find((r) => r.asset.id === assetId);
              if (b) {
                notify({
                  title: t(dir === "up" ? "notify.balanceUp" : "notify.balanceDown"),
                  body: `${b.asset.symbol}: ${b.formatted}`,
                  path: `/accounts/${row.keyId}/${row.chain.name.toLowerCase()}/${b.asset.symbol}${suffix}`,
                  tag: `bal-${row.address}-${b.asset.symbol}-${b.formatted}`,
                });
              }
            }
          }
          setTokenBalances(results);
          setTokenState("loaded");
        })
        .catch(() => {
          if (!cancelled && isInitial && !cached) setTokenState("error");
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeState, row.address, row.chain, row.assets, hasTokenAssets]);

  // Refresh without blanking existing data (stale-while-revalidate)
  const refresh = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    const nativeAsset = row.assets.find((a) => a.isNative);
    if (nativeAsset) clearCache(balanceCacheKey(row.address, row.chain.id, nativeAsset.id));
    clearCache(tokenBalancesCacheKey(row.address, row.chain.id));

    // Keep showing current data while fetching (no blanking)
    fetchNativeBalance(row.address, row.chain, row.assets)
      .then((result) => {
        setNativeBalance(result);
        setNativeState("loaded");
      })
      .catch(() => setNativeState("error"));

    if (hasTokenAssets) {
      fetchTokenBalances(row.address, row.chain, row.assets)
        .then((results) => {
          setTokenBalances(results);
          setTokenState("loaded");
        })
        .catch(() => {});
    }
  }, [row, hasTokenAssets]);

  // Listen for external balance refresh events (e.g. after WC signing)
  useEffect(() => {
    function onRefresh() { refresh(); }
    window.addEventListener("balance-refresh", onRefresh);
    return () => window.removeEventListener("balance-refresh", onRefresh);
  }, [refresh]);

  return {
    nativeBalance,
    nativeState,
    tokenBalances,
    tokenState,
    nativeChanged,
    tokenChanges,
    refresh,
  };
}
