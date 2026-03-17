import { useState, useEffect } from "react";
import { Spinner } from "./ui";
import type { Chain, Asset } from "../lib/api";
import { explorerLink } from "../shared/utils";
import { fetchTransactions, type Transaction } from "../lib/transactions";
import { fetchNativeBalance, fetchTokenBalances, getCachedNativeBalance, getCachedTokenBalances } from "../lib/balance";
import { clearCache, balanceCacheKey, tokenBalancesCacheKey } from "../lib/dataCache";
import { fetchPrices, formatUsd, getUsdValue } from "../lib/prices";
import { useFrozen } from "../context/FrozenContext";
import { useHideBalances, maskBalance } from "../context/HideBalancesContext";
import { cashAddrToLegacy } from "../lib/chains/bchAdapter";
import { QrModal } from "./QrModal";
import { TxRow } from "./TxRow";
import { SendDialog } from "./SendDialog";
import { XlmTrustlineDialog } from "./XlmTrustlineDialog";
import { truncateBalance } from "./sendTypes";
import type { SpeedUpData } from "./sendTypes";
import { mempoolApiUrl, fetchFeeRates } from "../lib/chains/btcTx";
import { useExpertMode } from "../context/ExpertModeContext";

export interface PendingTxFromNavigation {
  hash: string;
  from: string;
  to: string;
  value: string;
  symbol: string;
  timestamp: number;
}

interface TokenDetailProps {
  keyId: string;
  address: string;
  chain: Chain;
  asset: Asset;
  onBack: () => void;
  pollInterval?: number; // ms, from server settings
  pendingTx?: PendingTxFromNavigation;
  chainAssets?: Asset[];
}

/** Default polling interval for transactions/prices refresh (ms) — overridden by server setting */
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

export function TokenDetail({ keyId, address, chain, asset, onBack, pollInterval: pollIntervalProp, pendingTx, chainAssets }: TokenDetailProps) {
  const frozen = useFrozen();
  const expert = useExpertMode();
  const pollInterval = pollIntervalProp ?? DEFAULT_POLL_INTERVAL;
  const [balance, setBalance] = useState<string>(() => {
    // Show cached balance instantly
    if (asset.isNative) {
      const cached = getCachedNativeBalance(address, chain, [asset]);
      return cached ? cached.data.formatted : "";
    }
    const cached = getCachedTokenBalances(address, chain);
    if (cached) {
      const match = cached.data.find((b) => b.asset.id === asset.id);
      if (match) return match.formatted;
    }
    return "";
  });
  const [showFullBalance, setShowFullBalance] = useState(false);
  const { hidden: balancesHidden } = useHideBalances();

  // Fetch balance from network, respecting cache TTL
  useEffect(() => {
    let cancelled = false;

    function fetchBalance() {
      if (asset.isNative) {
        fetchNativeBalance(address, chain, [asset])
          .then((result) => {
            if (!cancelled && result) setBalance(result.formatted);
          })
          .catch(() => {});
      } else {
        fetchTokenBalances(address, chain, [asset])
          .then((results) => {
            if (cancelled) return;
            const match = results.find((b) => b.asset.id === asset.id);
            if (match) setBalance(match.formatted);
          })
          .catch(() => {});
      }
    }

    fetchBalance();
    const iv = setInterval(fetchBalance, pollInterval);
    return () => { cancelled = true; clearInterval(iv); };
  }, [address, chain, asset, pollInterval]);

  const [transactions, setTransactions] = useState<Transaction[]>(() => {
    if (pendingTx) {
      return [{
        hash: pendingTx.hash,
        from: pendingTx.from,
        to: pendingTx.to,
        value: pendingTx.value,
        formatted: pendingTx.value,
        symbol: pendingTx.symbol,
        direction: "out" as const,
        timestamp: pendingTx.timestamp,
        confirmed: false,
      }];
    }
    return [];
  });
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [speedUpData, setSpeedUpData] = useState<SpeedUpData | undefined>();
  const [showXlmTrustline, setShowXlmTrustline] = useState(false);
  const [prices, setPrices] = useState<Record<string, number>>({});

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [, setTick] = useState(0);

  // Re-render every 10s to update the "last updated" label
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    fetchPrices().then(setPrices);
    const iv = setInterval(() => fetchPrices().then(setPrices), pollInterval);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const usdValue = getUsdValue(balance, asset.symbol, prices);

  useEffect(() => {
    setLoading(true);
    setError(false);
    setPage(1);
    fetchTransactions(address, chain, asset, 1)
      .then(({ transactions: txs, hasMore: more }) => {
        setTransactions((prev) => {
          const fetchedHashes = new Set(txs.map((t) => t.hash));
          const staleThreshold = Date.now() / 1000 - 1800; // 30 min
          const pending = prev.filter(
            (t) => !t.confirmed && !fetchedHashes.has(t.hash) && t.timestamp > staleThreshold
          );
          return [...pending, ...txs];
        });
        setHasMore(more);
        setLastUpdated(new Date());
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));

    // Poll transactions every POLL_INTERVAL
    const iv = setInterval(() => {
      fetchTransactions(address, chain, asset, 1)
        .then(({ transactions: txs, hasMore: more }) => {
          setTransactions((prev) => {
            const fetchedHashes = new Set(txs.map((t) => t.hash));
            const staleThreshold = Date.now() / 1000 - 1800;
            const pending = prev.filter(
              (t) => !t.confirmed && !fetchedHashes.has(t.hash) && t.timestamp > staleThreshold
            );
            return [...pending, ...txs];
          });
          setHasMore(more);
          setLastUpdated(new Date());
        })
        .catch(() => {});
    }, pollInterval);

    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chain, asset]);

  function loadMore() {
    const nextPage = page + 1;
    setLoadingMore(true);
    fetchTransactions(address, chain, asset, nextPage)
      .then(({ transactions: txs, hasMore: more }) => {
        setTransactions((prev) => [...prev, ...txs]);
        setHasMore(more);
        setPage(nextPage);
      })
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  }

  function retry() {
    setLoading(true);
    setError(false);
    fetchTransactions(address, chain, asset, 1)
      .then(({ transactions: txs, hasMore: more }) => {
        setTransactions((prev) => {
          const fetchedHashes = new Set(txs.map((t) => t.hash));
          const staleThreshold = Date.now() / 1000 - 1800; // 30 min
          const pending = prev.filter(
            (t) => !t.confirmed && !fetchedHashes.has(t.hash) && t.timestamp > staleThreshold
          );
          return [...pending, ...txs];
        });
        setHasMore(more);
        setPage(1);
        setLastUpdated(new Date());
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }

  async function handleSpeedUp(txHash: string) {
    const apiBase = mempoolApiUrl(chain.explorerUrl);
    try {
      const [txRes, feeRates] = await Promise.all([
        fetch(`${apiBase}/tx/${txHash}`).then(r => r.json()),
        fetchFeeRates(apiBase),
      ]);
      // Extract original inputs as UTXOs
      type TxInput = { txid: string; vout: number; prevout?: { value: number } };
      type TxOutput = { scriptpubkey_address: string; value: number };
      const utxos = (txRes.vin as TxInput[]).map((inp) => ({
        txid: inp.txid,
        vout: inp.vout,
        value: inp.prevout?.value as number,
      }));
      // Find recipient output (first output that isn't the sender's address)
      const vout = txRes.vout as TxOutput[];
      const recipientOut = vout.find((o) => o.scriptpubkey_address !== address) ?? vout[0];
      const recipientAddr = recipientOut.scriptpubkey_address as string;
      const amountSats = BigInt(recipientOut.value);
      // Calculate original fee rate and require higher
      const txWeight = txRes.weight as number;
      const txFee = txRes.fee as number;
      const originalFeeRate = txFee / (txWeight / 4);
      const minFeeRate = Math.max(
        Math.ceil(originalFeeRate) + 1,
        feeRates.halfHourFee,
        1,
      );
      setSpeedUpData({ originalTxid: txHash, to: recipientAddr, amountSats, utxos, minFeeRate });
      setShowSend(true);
    } catch (err) {
      console.error("[speed-up] Failed to fetch tx:", err);
    }
  }

  function copyAddress() {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-5">
      {/* Back button */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors group"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Accounts
      </button>

      {/* Hero: centered icon + name + balance */}
      <div className="flex flex-col items-center text-center pt-4 pb-2">
        {asset.iconUrl ? (
          <img src={asset.iconUrl} alt={asset.symbol} className="w-14 h-14 rounded-full bg-surface-tertiary" />
        ) : chain.iconUrl ? (
          <img src={chain.iconUrl} alt={chain.displayName} className="w-14 h-14 rounded-full bg-surface-tertiary" />
        ) : (
          <div className="w-14 h-14 rounded-full bg-surface-tertiary" />
        )}
        <h3 className="text-lg font-semibold text-text-primary mt-3 flex items-center gap-2">
          {asset.name.replace(/\s*\(?\s*(testnet|devnet)\s*\)?\s*/gi, " ").trim()}
          {/devnet/i.test(chain.name) ? (
            <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold">devnet</span>
          ) : /testnet|sepolia/i.test(chain.name) ? (
            <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold">testnet</span>
          ) : null}
        </h3>
        <p className="text-[11px] text-text-muted mt-0.5">{chain.displayName}</p>
        <button
          onClick={() => setShowFullBalance(!showFullBalance)}
          className="text-2xl font-semibold tabular-nums text-text-primary mt-3 break-all cursor-pointer hover:text-text-secondary transition-colors"
        >
          {maskBalance(showFullBalance ? balance : truncateBalance(balance), balancesHidden)} <span className="text-text-tertiary text-sm">{asset.symbol}</span>
        </button>
        {usdValue != null && (
          <p className="text-sm text-text-muted tabular-nums mt-0.5">{balancesHidden ? "••••" : formatUsd(usdValue)}</p>
        )}

        {/* Action buttons */}
        <div className="flex items-center justify-center gap-6 mt-5">
          <button
            onClick={() => setShowSend(true)}
            disabled={frozen}
            className="flex flex-col items-center gap-1.5 group disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <div className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors shadow-md ${frozen ? "bg-surface-tertiary shadow-none" : "bg-blue-600 group-hover:bg-blue-500 group-active:bg-blue-700 shadow-blue-600/25"}`}>
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
              </svg>
            </div>
            <span className="text-[11px] text-text-muted group-hover:text-text-secondary transition-colors">Send</span>
          </button>
          <button
            onClick={() => setShowQr(true)}
            className="flex flex-col items-center gap-1.5 group"
          >
            <div className="w-11 h-11 rounded-full bg-surface-tertiary group-hover:bg-border-primary group-active:bg-border-secondary flex items-center justify-center transition-colors">
              <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </div>
            <span className="text-[11px] text-text-muted group-hover:text-text-secondary transition-colors">Receive</span>
          </button>
          <button
            onClick={copyAddress}
            className="flex flex-col items-center gap-1.5 group"
          >
            <div className="w-11 h-11 rounded-full bg-surface-tertiary group-hover:bg-border-primary group-active:bg-border-secondary flex items-center justify-center transition-colors">
              {copied ? (
                <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              ) : (
                <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
                </svg>
              )}
            </div>
            <span className="text-[11px] text-text-muted group-hover:text-text-secondary transition-colors">{copied ? "Copied" : "Copy"}</span>
          </button>
          {chain.type === "xlm" && asset.isNative && chainAssets && chainAssets.some(a => !a.isNative) && (
            <button
              onClick={() => setShowXlmTrustline(true)}
              disabled={frozen}
              className="flex flex-col items-center gap-1.5 group disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <div className="w-11 h-11 rounded-full bg-surface-tertiary group-hover:bg-border-primary group-active:bg-border-secondary flex items-center justify-center transition-colors">
                <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
              </div>
              <span className="text-[11px] text-text-muted group-hover:text-text-secondary transition-colors">Enable</span>
            </button>
          )}
        </div>
      </div>

      {/* Address + explorer link */}
      <div className="flex items-center justify-center gap-2 text-[11px] text-text-muted" title="Your wallet address — share it to receive funds">
        <span className="font-mono">{address.slice(0, 10)}...{address.slice(-8)}</span>
        <a
          href={explorerLink(chain.explorerUrl, `/address/${address}`)}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-text-secondary transition-colors shrink-0"
          title="View on explorer"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
        {chain.type === "evm" && !asset.isNative && (
          <a
            href={`https://revoke.cash/address/${address}?chainId=${chain.evmChainId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text-secondary transition-colors shrink-0"
            title="Revoke token approvals"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          </a>
        )}
      </div>

      {/* BCH Legacy address */}
      {chain.type === "bch" && (() => {
        const testnet = chain.displayName.toLowerCase().includes("testnet");
        const legacyAddr = cashAddrToLegacy(address, testnet);
        return (
          <div className="flex items-center justify-center gap-2 text-[10px] text-text-muted/70 -mt-3">
            <span className="text-text-muted/50">Legacy:</span>
            <span className="font-mono">{legacyAddr.slice(0, 8)}...{legacyAddr.slice(-6)}</span>
            <button
              onClick={() => { navigator.clipboard.writeText(legacyAddr); }}
              className="hover:text-text-secondary transition-colors"
              title="Copy legacy address"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
              </svg>
            </button>
          </div>
        );
      })()}

      {/* QR Code Modal */}
      {showQr && (
        <QrModal address={address} asset={asset} chain={chain} onClose={() => setShowQr(false)} />
      )}

      {showXlmTrustline && chainAssets && (
        <XlmTrustlineDialog
          keyId={keyId}
          address={address}
          balance={balance}
          chain={chain}
          chainAssets={chainAssets.filter(a => !a.isNative)}
          prices={prices}
          onClose={() => setShowXlmTrustline(false)}
        />
      )}

      {/* Transactions */}
      <div>
        <div className="flex items-center justify-between mb-2 px-1">
          <h4 className="text-xs text-text-muted uppercase tracking-wider font-semibold">
            Activity
          </h4>
          {transactions.length > 0 && !loading && (
            <span className="text-[10px] text-text-muted tabular-nums">
              {transactions.length} transaction{transactions.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden">
          {/* Pending transactions — always shown at top */}
          {transactions.filter((t) => !t.confirmed).length > 0 && (
            <div className="divide-y divide-border-secondary">
              {transactions.filter((t) => !t.confirmed).map((tx, i) => (
                <TxRow
                  key={`pending-${tx.hash}-${i}`}
                  tx={tx}
                  explorerUrl={chain.explorerUrl}
                  onSpeedUp={(chain.type === "btc" || chain.type === "ltc") && !frozen && expert ? () => handleSpeedUp(tx.hash) : undefined}
                />
              ))}
            </div>
          )}

          {/* Loading skeletons */}
          {loading && (
            <div className="divide-y divide-border-secondary">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="flex items-center px-4 py-3.5 animate-pulse">
                  <div className="w-8 h-8 rounded-full bg-surface-tertiary shrink-0 mr-3" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 w-20 bg-surface-tertiary rounded" />
                    <div className="h-2.5 w-32 bg-surface-tertiary/60 rounded" />
                  </div>
                  <div className="space-y-1.5 text-right">
                    <div className="h-3.5 w-16 bg-surface-tertiary rounded ml-auto" />
                    <div className="h-2.5 w-10 bg-surface-tertiary/60 rounded ml-auto" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {!loading && error && (
            <div className="px-4 py-6 text-center">
              <p className="text-xs text-text-tertiary mb-1">Failed to load history</p>
              <button
                onClick={retry}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                Try again
              </button>
            </div>
          )}

          {/* Empty */}
          {!loading && !error && transactions.length === 0 && (
            <div className="px-4 py-10 text-center">
              {(!balance || balance === "0") && asset.isNative ? (
                /* Zero-balance welcome guidance */
                <div className="space-y-4">
                  <div>
                    <p className="text-sm font-medium text-text-secondary mb-1">Welcome to your wallet</p>
                    <p className="text-xs text-text-muted leading-relaxed">
                      Fund it to get started — send crypto from an exchange or another wallet.
                    </p>
                  </div>
                  <div className="bg-surface-primary border border-border-primary rounded-lg px-3.5 py-3 text-left">
                    <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold mb-1.5">Your receive address</p>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-text-secondary flex-1 break-all">{address}</span>
                      <button
                        onClick={copyAddress}
                        className="shrink-0 p-1.5 rounded hover:bg-surface-tertiary transition-colors"
                        title="Copy address"
                      >
                        {copied ? (
                          <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                          </svg>
                        ) : (
                          <svg className="w-3.5 h-3.5 text-text-muted hover:text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-center">
                    <button
                      onClick={() => setShowQr(true)}
                      className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                      </svg>
                      Show QR code
                    </button>
                  </div>
                </div>
              ) : (
                /* Standard empty state */
                <>
                  <svg className="w-8 h-8 text-text-muted mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
                  </svg>
                  <p className="text-sm text-text-tertiary">No transactions yet</p>
                  {!expert && !frozen && (
                    <p className="text-xs text-text-muted mt-2">Tap <span className="text-blue-400 font-medium">Send</span> to transfer funds, or <span className="text-text-secondary font-medium">Receive</span> to get your address.</p>
                  )}
                </>
              )}
            </div>
          )}

          {/* Confirmed transaction list */}
          {!loading && !error && transactions.filter((t) => t.confirmed).length > 0 && (
            <div className="divide-y divide-border-secondary">
              {transactions.filter((t) => t.confirmed).map((tx, i) => (
                <TxRow key={`${tx.hash}-${i}`} tx={tx} explorerUrl={chain.explorerUrl} />
              ))}
            </div>
          )}

          {/* Load more */}
          {hasMore && !loading && !error && (
            <div className="border-t border-border-secondary">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="w-full text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary/30 transition-colors py-3 disabled:opacity-50"
              >
                {loadingMore ? (
                  <span className="flex items-center justify-center gap-2">
                    <Spinner size="xs" />
                    Loading...
                  </span>
                ) : (
                  "Load more"
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Send dialog */}
      {showSend && (
        <SendDialog
          keyId={keyId}
          asset={asset}
          chain={chain}
          address={address}
          balance={balance}
          speedUpData={speedUpData}
          onClose={() => { setShowSend(false); setSpeedUpData(undefined); }}
          onTxSubmitted={(txHash, toAddr, txAmount) => {
            // Add pending tx to the list
            const pendingTx: Transaction = {
              hash: txHash,
              from: address,
              to: toAddr,
              value: "0",
              formatted: txAmount,
              symbol: asset.symbol,
              direction: "out",
              timestamp: Math.floor(Date.now() / 1000),
              confirmed: false,
            };
            setTransactions((prev) => [pendingTx, ...prev]);
          }}
          onTxConfirmed={(txHash) => {
            setTransactions((prev) =>
              prev.map((t) => t.hash === txHash ? { ...t, confirmed: true } : t)
            );
            // Invalidate balance cache and re-fetch immediately
            if (asset.isNative) {
              clearCache(balanceCacheKey(address, chain.id, asset.id));
              fetchNativeBalance(address, chain, [asset]).then((r) => { if (r) setBalance(r.formatted); });
            } else {
              clearCache(tokenBalancesCacheKey(address, chain.id));
              fetchTokenBalances(address, chain, [asset]).then((results) => {
                const match = results.find((b) => b.asset.id === asset.id);
                if (match) setBalance(match.formatted);
              });
            }
          }}
        />
      )}

      {/* Last updated indicator */}
      {lastUpdated && (
        <div className="flex items-center gap-1.5 px-1">
          <span className="text-[10px] text-text-muted tabular-nums">
            Updated {formatLastUpdated(lastUpdated)}
          </span>
          <button
            onClick={retry}
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
