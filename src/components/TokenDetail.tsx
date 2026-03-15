import { useState, useEffect, useRef } from "react";
import type { Chain, Asset } from "../lib/api";
import { explorerLink, bytesToHex, hexToBytes } from "../shared/utils";
import { fetchTransactions, type Transaction } from "../lib/transactions";
import { fetchNativeBalance, fetchTokenBalances, getCachedNativeBalance, getCachedTokenBalances } from "../lib/balance";
import { clearCache, balanceCacheKey, tokenBalancesCacheKey } from "../lib/dataCache";
import { fetchPrices, formatUsd, getUsdValue } from "../lib/prices";
import { toBase64, performMpcSign, clientKeys, restoreKeyHandles } from "../lib/mpc";
import { authHeaders } from "../lib/auth";
import { apiUrl } from "../lib/apiBase";
import { fetchPasskeys, sensitiveHeaders } from "../lib/passkey";
import { PasskeyGate } from "./PasskeyGate";
import { PasskeyChallenge } from "./PasskeyChallenge";
import {
  buildTransaction,
  serializeForSigning,
  hashForSigning,
  parseDerSignature,
  recoverV,
  assembleSignedTx,
  broadcastTransaction,
  waitForReceipt,
  encodeErc20Transfer,
  parseUnits,
  type UnsignedTx,
} from "../lib/chains/evmTx";
import { getChainAdapter } from "../lib/chains/adapter";
import { useFrozen } from "../context/FrozenContext";
import {
  fetchUtxos,
  fetchFeeRates,
  mempoolApiUrl,
  buildBtcTransaction,
  bip143Sighash,
  legacySighash,
  detectAddressType,
  getCompressedPublicKey,
  pubKeyHash,
  makeP2WPKHWitness,
  makeP2PKHScriptSig,
  serializeWitnessTx,
  serializeLegacyTx,
  computeTxid,
  computeLegacyTxid,
  broadcastBtcTx,
  waitForBtcConfirmation,
  estimateFee as estimateBtcFee,
  formatBtcFee,
} from "../lib/chains/btcTx";
import {
  buildSolanaTransferMessage,
  buildSplTransferMessage,
  assembleSolanaTransaction,
  getLatestBlockhash,
  broadcastSolanaTransaction,
  waitForSolanaConfirmation,
  checkAtaExists,
  findAssociatedTokenAddress,
  SOLANA_BASE_FEE,
  formatLamports,
} from "../lib/chains/solanaTx";
import {
  getAccountInfo as getXrpAccountInfo,
  getCurrentLedgerIndex,
  hashForSigning as xrpHashForSigning,
  assembleSignedTx as xrpAssembleSignedTx,
  broadcastXrpTransaction,
  waitForXrpConfirmation,
  XRP_BASE_FEE,
  formatDrops,
  type XrpPaymentParams,
} from "../lib/chains/xrpTx";
import {
  fetchUtxos as fetchBchUtxos,
  fetchFeeRates as fetchBchFeeRates,
  bchApiUrl,
  buildBchTransaction,
  bchSighash,
  getCompressedPublicKey as getBchCompressedPublicKey,
  pubKeyHash as bchPubKeyHash,
  makeP2PKHScriptSig as makeBchP2PKHScriptSig,
  serializeBchTx,
  computeTxid as computeBchTxid,
  broadcastBchTx,
  waitForBchConfirmation,
  estimateFee as estimateBchFee,
  formatBchFee,
} from "../lib/chains/bchTx";
import { cashAddrToLegacy } from "../lib/chains/bchAdapter";
import { base58 } from "@scure/base";
import { QRCodeSVG } from "qrcode.react";
import { isEncryptedKeyFile, decryptKeyFile, type KeyFileData } from "../lib/crypto";
import { BalancePreview, type BalanceChange } from "./BalancePreview";
import { Scanner } from "@yudiel/react-qr-scanner";
import { PassphraseInput } from "./PassphraseInput";
import {
  hasKeyShare as hasStoredKeyShare,
  getKeyShareMode,
  getKeyShareWithPrf,
  getKeyShareWithPassphrase,
} from "../lib/keystore";
import { useHideBalances, maskBalance } from "../context/HideBalancesContext";
import { authenticatePasskey } from "../lib/passkey";
import { isRecoveryMode, getRecoveryKeyFile } from "../lib/recovery";
import {
  strKeyToPublicKey,
  eddsaPubKeyToXlmAddress,
  buildXlmTransactionXdr,
  buildXlmCreateAccountXdr,
  checkXlmAccountExists,
  buildXlmChangeTrustXdr,
  xlmHashForSigning,
  assembleXlmSignedTx,
  getXlmAccountInfo,
  broadcastXlmTransaction,
  waitForXlmConfirmation,
} from "../lib/chains/xlmTx";

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

function QrModal({ address, asset, chain, onClose }: { address: string; asset: Asset; chain: Chain; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  function copyAddr() {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-xs shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <h3 className="text-sm font-semibold text-text-primary">📱 Receive</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-5 flex flex-col items-center gap-4">
          <div className="bg-white rounded-xl p-4 relative">
            <QRCodeSVG value={address} size={200} level="M" />
            {(asset.iconUrl || chain.iconUrl) && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="bg-white rounded-full p-1">
                  <img
                    src={asset.iconUrl || chain.iconUrl!}
                    alt={asset.symbol}
                    className="w-8 h-8 rounded-full"
                  />
                </div>
              </div>
            )}
          </div>
          <button
            onClick={copyAddr}
            className="w-full max-w-[280px] rounded-lg bg-surface-primary/60 border border-border-secondary px-2 py-2 text-[9px] font-mono text-center hover:bg-surface-tertiary/50 transition-colors cursor-pointer truncate"
            title="Copy address"
          >
            {copied ? <span className="text-green-500">Copied!</span> : <span className="text-text-secondary">{address}</span>}
          </button>
        </div>
      </div>
    </div>
  );
}

function shortAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}


function TxRow({ tx, explorerUrl }: { tx: Transaction; explorerUrl: string }) {
  const isPending = !tx.confirmed;
  const isFailed = !!tx.failed;
  const dirColor = isFailed
    ? "text-red-400"
    : isPending
      ? "text-yellow-400"
      : tx.direction === "in"
        ? "text-green-500"
        : tx.direction === "out"
          ? (tx.isApprove ? "text-blue-400" : tx.isContractCall ? "text-orange-400" : "text-red-400")
          : "text-text-muted";
  const dirLabel = isFailed
    ? "Failed"
    : isPending
      ? "Pending"
      : tx.label ?? (tx.direction === "in" ? "Received" : tx.direction === "out" ? (tx.isApprove ? "Approved" : tx.isContractCall ? "Executed Contract" : "Sent") : "Self");
  const dirSign = tx.direction === "in" ? "+" : tx.direction === "out" ? "-" : "";

  return (
    <a
      href={explorerLink(explorerUrl, `/tx/${tx.hash}`)}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center px-3 md:px-4 py-3.5 hover:bg-surface-tertiary/50 transition-colors group ${isPending ? "animate-pulse" : ""}`}
    >
      {/* Direction icon */}
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 mr-3 ${
        isFailed
          ? "bg-red-400/10"
          : isPending
            ? "bg-yellow-400/10"
            : tx.direction === "in"
              ? "bg-green-500/10"
              : tx.direction === "out"
                ? (tx.isApprove ? "bg-blue-400/10" : tx.isContractCall ? "bg-orange-400/10" : "bg-red-400/10")
                : "bg-surface-tertiary"
      }`}>
        {isFailed ? (
          <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : isPending ? (
          <svg className="w-4 h-4 text-yellow-400 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : tx.direction === "in" ? (
          <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        ) : tx.direction === "out" && tx.isApprove ? (
          <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ) : tx.direction === "out" && tx.isContractCall ? (
          <svg className="w-4 h-4 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        ) : tx.direction === "out" ? (
          <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
        ) : (
          <svg className="w-4 h-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
        )}
      </div>

      {/* Label + counterparty + time */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium ${isFailed ? "text-red-400" : isPending ? "text-yellow-400" : "text-text-primary"}`}>{dirLabel}</span>
          <span className="text-[11px] text-text-muted">{isPending ? "just now" : formatTime(tx.timestamp)}</span>
        </div>
        <div className="text-[11px] text-text-muted font-mono truncate">
          {tx.direction === "in" ? `From ${shortAddr(tx.from)}` : `To ${shortAddr(tx.to)}`}
          <span className="text-text-muted/50 ml-1.5 hidden sm:inline">{shortAddr(tx.hash)}</span>
        </div>
      </div>

      {/* Amount */}
      <div className="text-right shrink-0 ml-3">
        <div className={`text-sm tabular-nums font-medium ${dirColor}`}>
          {dirSign}{tx.formatted}
        </div>
        <div className="text-[11px] text-text-muted">{tx.symbol}</div>
      </div>

      {/* External link icon on hover — hidden on mobile */}
      <div className="w-5 justify-end shrink-0 ml-2 hidden md:flex">
        <svg
          className="w-3 h-3 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </div>
    </a>
  );
}

/** Default polling interval for transactions/prices refresh (ms) — overridden by server setting */
const DEFAULT_POLL_INTERVAL = 60_000;

// ── Send Dialog ─────────────────────────────────────────────────

// Gas limit: 21000 for native ETH transfer, 65000 for ERC-20 transfer
const GAS_LIMIT_NATIVE = 21_000n;
const GAS_LIMIT_ERC20 = 65_000n;

function formatGwei(wei: bigint): string {
  const gwei = Number(wei) / 1e9;
  return gwei < 0.01 ? "< 0.01" : gwei.toFixed(2);
}

function formatEthFee(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  if (eth === 0) return "0";
  if (eth < 0.000001) return "< 0.000001";
  return eth.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}


function isValidAmount(val: string, balance: string): { valid: boolean; error?: string } {
  if (!val) return { valid: false };
  const num = parseFloat(val);
  if (isNaN(num) || num <= 0) return { valid: false, error: "Enter a valid amount" };
  if (num > parseFloat(balance)) return { valid: false, error: "Insufficient balance" };
  return { valid: true };
}

function shortAddrPreview(addr: string): string {
  if (addr.length <= 20) return addr;
  return `${addr.slice(0, 10)}...${addr.slice(-8)}`;
}

interface KeyFile {
  id: string;
  peer: number;
  share: string;
  publicKey: string;
  eddsaShare: string;
  eddsaPublicKey: string;
}

type FeeLevel = "low" | "medium" | "high";

const FEE_LABELS: Record<FeeLevel, string> = { low: "Slow", medium: "Standard", high: "Fast" };

// EVM gas price multipliers per fee level
const EVM_FEE_MULTIPLIER: Record<FeeLevel, number> = { low: 0.8, medium: 1.0, high: 1.3 };

type SendStep = "input" | "preview" | "signing" | "result";

type SigningPhase =
  | "loading-keyshare"
  | "building-tx"
  | "mpc-signing"
  | "broadcasting"
  | "polling";

interface TxResult {
  status: "success" | "failed" | "pending";
  txHash: string;
  blockNumber?: string | number;
}


function SendDialog({
  keyId,
  asset,
  chain,
  address,
  balance,
  onClose,
  onTxSubmitted,
  onTxConfirmed,
}: {
  keyId: string;
  asset: Asset;
  chain: Chain;
  address: string;
  balance: string;
  onClose: () => void;
  onTxSubmitted?: (txHash: string, toAddr: string, amount: string) => void;
  onTxConfirmed?: (txHash: string) => void;
}) {
  const { hidden: balancesHidden } = useHideBalances();
  const [step, setStep] = useState<SendStep>("input");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [toTouched, setToTouched] = useState(false);
  const [amountTouched, setAmountTouched] = useState(false);
  const [showAddrScanner, setShowAddrScanner] = useState(false);
  const [baseGasPrice, setBaseGasPrice] = useState<bigint | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [feeLevel, setFeeLevel] = useState<FeeLevel>("medium");

  // BTC-specific state — store all rates
  const [btcFeeRates, setBtcFeeRates] = useState<{ low: number; medium: number; high: number } | null>(null);
  // BCH-specific state
  const [bchFeeRates, setBchFeeRates] = useState<{ low: number; medium: number; high: number } | null>(null);
  // XLM-specific state (stroops per operation)
  const [xlmFeeRates, setXlmFeeRates] = useState<{ low: number; medium: number; high: number } | null>(null);
  const [xlmDestExists, setXlmDestExists] = useState<boolean | null>(null);
  const [feeCountdown, setFeeCountdown] = useState(10);

  // Keyshare file
  const [keyFile, setKeyFile] = useState<KeyFile | null>(null);
  const [pendingEncrypted, setPendingEncrypted] = useState<KeyFileData | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Browser-stored key share
  const [browserShareMode, setBrowserShareMode] = useState<"prf" | "passphrase" | null>(null);
  const [browserShareLoading, setBrowserShareLoading] = useState(false);
  const [browserShareError, setBrowserShareError] = useState("");
  const [showBrowserPassphrase, setShowBrowserPassphrase] = useState(false);

  // Signing state
  // XRP destination tag
  const [destinationTag, setDestinationTag] = useState("");

  const [signingPhase, setSigningPhase] = useState<SigningPhase>("loading-keyshare");
  const [signingError, setSigningError] = useState<string | null>(null);
  const [txResult, setTxResult] = useState<TxResult | null>(null);
  const [pendingTxHash, setPendingTxHash] = useState<string | null>(null);

  // Passkey guard (triggered on confirm, not on dialog open)
  const [passkeyGuard, setPasskeyGuard] = useState<"idle" | "gate" | "challenge">("idle");
  const pendingSignRef = useRef<(() => void) | null>(null);

  async function guardedSign(action: () => void) {
    // In recovery mode, skip passkey entirely — no server to verify
    if (isRecoveryMode()) {
      action();
      return;
    }
    try {
      const list = await fetchPasskeys();
      if (list.length === 0) {
        pendingSignRef.current = action;
        setPasskeyGuard("gate");
      } else {
        pendingSignRef.current = action;
        setPasskeyGuard("challenge");
      }
    } catch {
      // If passkey check fails, proceed anyway (backend will enforce)
      action();
    }
  }

  function onPasskeyComplete(_result?: any) {
    setPasskeyGuard("idle");
    pendingSignRef.current?.();
    pendingSignRef.current = null;
  }

  // Check for browser-stored key share on mount (or load recovery key)
  useEffect(() => {
    if (isRecoveryMode()) {
      const rkf = getRecoveryKeyFile();
      if (rkf) setKeyFile(rkf as KeyFile);
      return;
    }
    if (hasStoredKeyShare(keyId)) {
      setBrowserShareMode(getKeyShareMode(keyId));
    }
  }, [keyId]);

  async function loadBrowserShare() {
    setBrowserShareLoading(true);
    setBrowserShareError("");
    try {
      const mode = getKeyShareMode(keyId);
      if (mode === "prf") {
        const result = await authenticatePasskey({ withPrf: true });
        if (result.prfKey) {
          const data = await getKeyShareWithPrf(keyId, result.prfKey);
          if (data) {
            setKeyFile(data as KeyFile);
            setBrowserShareLoading(false);
            return;
          }
          setBrowserShareError("Could not decrypt. Wrong passkey?");
        } else {
          setBrowserShareError("Passkey does not support encryption. Use file upload.");
        }
      } else if (mode === "passphrase") {
        setShowBrowserPassphrase(true);
      }
    } catch (err) {
      setBrowserShareError(String(err));
    }
    setBrowserShareLoading(false);
  }


  // Fetch gas price (EVM) or fee rates (BTC) and USD prices, poll every 10s
  useEffect(() => {
    fetchPrices().then(setPrices);

    function refreshFees() {
      if (chain.type === "btc") {
        const btcApi = mempoolApiUrl(chain.explorerUrl);
        fetchFeeRates(btcApi)
          .then((rates) => {
            setBtcFeeRates({
              low: rates.hourFee,
              medium: rates.halfHourFee,
              high: rates.fastestFee,
            });
          })
          .catch(() => {});
      } else if (chain.type === "bch") {
        fetchBchFeeRates()
          .then((rates) => {
            setBchFeeRates({
              low: rates.suggested,
              medium: rates.suggested,
              high: rates.suggested,
            });
          })
          .catch(() => {});
      } else if (chain.type === "evm") {
        if (!chain.rpcUrl) return;
        fetch(chain.rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.result) setBaseGasPrice(BigInt(data.result));
          })
          .catch(() => {});
      }
      else if (chain.type === "xlm") {
        if (!chain.rpcUrl) return;
        fetch(`${chain.rpcUrl}/fee_stats`)
          .then((r) => r.json())
          .then((data) => {
            const p10 = parseInt(data.fee_charged?.p10 ?? "100", 10);
            const p50 = parseInt(data.fee_charged?.p50 ?? "100", 10);
            const p90 = parseInt(data.fee_charged?.p90 ?? "100", 10);
            setXlmFeeRates({ low: p10, medium: p50, high: p90 });
          })
          .catch(() => {});
      }
      // Solana / XRP: fixed fee, no polling needed
    }

    refreshFees();
    setFeeCountdown(10);
    const feeIv = setInterval(() => { refreshFees(); setFeeCountdown(10); }, 10_000);
    const countIv = setInterval(() => setFeeCountdown((c) => Math.max(0, c - 1)), 1_000);
    return () => { clearInterval(feeIv); clearInterval(countIv); };
  }, [chain.rpcUrl, chain.explorerUrl, chain.type]);

  // Effective fee values based on selected level
  const gasPrice = baseGasPrice != null
    ? BigInt(Math.round(Number(baseGasPrice) * EVM_FEE_MULTIPLIER[feeLevel]))
    : null;
  const btcFeeRate = btcFeeRates?.[feeLevel] ?? null;
  const btcEstimatedFee = btcFeeRate != null ? estimateBtcFee(1, btcFeeRate, true, detectAddressType(address)) : null;
  const bchFeeRate = bchFeeRates?.[feeLevel] ?? null;
  const bchEstimatedFee = bchFeeRate != null ? estimateBchFee(1, bchFeeRate, true) : null;

  const gasLimit = asset.isNative ? GAS_LIMIT_NATIVE : GAS_LIMIT_ERC20;
  const estimatedFeeWei = gasPrice != null ? gasPrice * gasLimit : null;

  // Unified fee display: { formatted, symbol, usd, rateLabel? }
  const feeDisplay = (() => {
    if (chain.type === "solana") {
      return {
        formatted: formatLamports(SOLANA_BASE_FEE),
        symbol: "SOL",
        usd: getUsdValue(String(Number(SOLANA_BASE_FEE) / 1e9), "SOL", prices),
        rateLabel: null as string | null,
        hasLevelSelector: false,
        isFixed: true,
      };
    }
    if (chain.type === "xrp") {
      return {
        formatted: formatDrops(XRP_BASE_FEE),
        symbol: "XRP",
        usd: getUsdValue(String(Number(XRP_BASE_FEE) / 1e6), "XRP", prices),
        rateLabel: null as string | null,
        hasLevelSelector: false,
        isFixed: true,
      };
    }
    if (chain.type === "xlm") {
      const xlmFeeRate = xlmFeeRates?.[feeLevel] ?? null;
      const feeXlm = xlmFeeRate != null ? (xlmFeeRate / 1e7).toFixed(7).replace(/\.?0+$/, "") : null;
      return {
        formatted: feeXlm,
        symbol: "XLM",
        usd: feeXlm != null ? getUsdValue(feeXlm, "XLM", prices) : null,
        rateLabel: xlmFeeRate != null ? `${xlmFeeRate} stroops` : null,
        hasLevelSelector: false,
        isFixed: false,
      };
    }
    if (chain.type === "bch") {
      return {
        formatted: bchEstimatedFee != null ? formatBchFee(bchEstimatedFee) : null,
        symbol: "BCH",
        usd: bchEstimatedFee != null ? getUsdValue(String(Number(bchEstimatedFee) / 1e8), "BCH", prices) : null,
        rateLabel: bchFeeRate != null ? `${bchFeeRate} sat/B` : null,
        hasLevelSelector: false,
        isFixed: true,
      };
    }
    if (chain.type === "btc") {
      return {
        formatted: btcEstimatedFee != null ? formatBtcFee(btcEstimatedFee) : null,
        symbol: "BTC",
        usd: btcEstimatedFee != null ? getUsdValue(String(Number(btcEstimatedFee) / 1e8), "BTC", prices) : null,
        rateLabel: btcFeeRate != null ? `${btcFeeRate} sat/vB` : null,
        hasLevelSelector: true,
        isFixed: false,
      };
    }
    // evm
    const feeEth = estimatedFeeWei != null ? formatEthFee(estimatedFeeWei) : null;
    return {
      formatted: feeEth,
      symbol: "ETH",
      usd: estimatedFeeWei != null ? getUsdValue(String(Number(estimatedFeeWei) / 1e18), "ETH", prices) : null,
      rateLabel: gasPrice != null ? `${formatGwei(gasPrice)} Gwei` : null,
      hasLevelSelector: true,
      isFixed: false,
    };
  })();

  // Validation
  const adapter = getChainAdapter(chain.type);
  const toValid = to.length > 0 && adapter.isValidAddress(to);
  const toError = toTouched && to.length > 0 && !toValid ? "Invalid address" : null;
  const toSelf = toValid && (chain.type === "solana" ? to === address : to.toLowerCase() === address.toLowerCase());
  const amountCheck = isValidAmount(amount, balance);
  const amountError = amountTouched && amount.length > 0 && !amountCheck.valid ? amountCheck.error : null;
  const amountUsd = amount ? getUsdValue(amount, asset.symbol, prices) : null;

  const destTagValid = chain.type !== "xrp" || destinationTag === "" || (/^\d+$/.test(destinationTag) && Number(destinationTag) <= 4294967295);
  const canReview = toValid && !toSelf && amountCheck.valid && keyFile != null && destTagValid;

  // Max sendable: for native tokens, subtract estimated fee from balance (using BigInt for precision)
  const maxSendable = (() => {
    if (!asset.isNative) return balance;
    let feeBaseUnits: bigint | null = null;
    if (chain.type === "evm" && estimatedFeeWei != null) {
      feeBaseUnits = estimatedFeeWei;
    } else if (chain.type === "solana") {
      feeBaseUnits = SOLANA_BASE_FEE;
    } else if (chain.type === "xrp") {
      feeBaseUnits = XRP_BASE_FEE;
    } else if (chain.type === "btc" && btcEstimatedFee != null) {
      feeBaseUnits = BigInt(btcEstimatedFee);
    } else if (chain.type === "xlm" && xlmFeeRates != null) {
      feeBaseUnits = BigInt(xlmFeeRates[feeLevel]);
    }
    if (feeBaseUnits == null) return balance;
    // Convert human balance to base units via BigInt
    const [intPart, fracPart = ""] = balance.split(".");
    const padded = fracPart.padEnd(asset.decimals, "0").slice(0, asset.decimals);
    const balanceBase = BigInt(intPart + padded);
    const net = balanceBase - feeBaseUnits;
    if (net <= 0n) return "0";
    // Convert back to human-readable
    const netStr = net.toString().padStart(asset.decimals + 1, "0");
    const netInt = netStr.slice(0, netStr.length - asset.decimals) || "0";
    const netFrac = netStr.slice(netStr.length - asset.decimals).replace(/0+$/, "");
    return netFrac ? `${netInt}.${netFrac}` : netInt;
  })();

  const ADDR_PLACEHOLDER: Record<string, string> = { btc: "bc1q...", bch: "bitcoincash:q...", solana: "So1ana...", evm: "0x" + "0".repeat(40), xrp: "r..." };
  const placeholder = ADDR_PLACEHOLDER[chain.type] ?? "Address";

  const totalUsd = (() => {
    const sendUsd = amountUsd ?? 0;
    return sendUsd + (feeDisplay.usd ?? 0);
  })();

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        if (!data.id || !data.share || !data.publicKey) return;
        if (isEncryptedKeyFile(data)) {
          setPendingEncrypted(data);
          setKeyFile(null);
        } else {
          setKeyFile(data as KeyFile);
          setPendingEncrypted(null);
        }
      } catch {
        // ignore invalid files
      }
    };
    reader.readAsText(file);
  }

  // ── Full signing flow (EVM) ───────────────────────────────────
  async function executeSigningFlow() {
    if (!keyFile || !chain.rpcUrl) return;

    setStep("signing");
    setSigningPhase("building-tx");
    setSigningError(null);

    try {
      // Restore key handles if not in memory
      if (!clientKeys.has(keyFile.id)) {
        await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
      }

      // 1. Build unsigned transaction
      const chainId = await getChainId(chain.rpcUrl);
      const amountWei = parseUnits(amount, asset.decimals);

      let unsignedTx: UnsignedTx;
      if (asset.isNative) {
        unsignedTx = await buildTransaction({
          rpcUrl: chain.rpcUrl, from: address, to, value: amountWei,
          gasLimit: GAS_LIMIT_NATIVE, chainId, gasPrice: gasPrice ?? undefined,
        });
      } else {
        const calldata = encodeErc20Transfer(to, amountWei);
        unsignedTx = await buildTransaction({
          rpcUrl: chain.rpcUrl, from: address, to: asset.contractAddress!,
          value: 0n, data: calldata, gasLimit: GAS_LIMIT_ERC20, chainId,
          gasPrice: gasPrice ?? undefined,
        });
      }

      // 2. MPC signing
      setSigningPhase("mpc-signing");
      const sighash = hashForSigning(unsignedTx);
      const serializedTx = serializeForSigning(unsignedTx);

      const { signature: sigRaw, sessionId } = await performMpcSign({
        algorithm: "ecdsa",
        keyId: keyFile.id,
        hash: sighash,
        initPayload: { id: keyFile.id, unsignedTx: toBase64(serializedTx), from: address },
        headers: sensitiveHeaders(),
      });

      // 3. Parse DER signature, determine recovery param, assemble signed tx
      const { r, s } = parseDerSignature(sigRaw);
      const pubKeyRaw = hexToBytes(keyFile.publicKey);
      const recoveryBit = recoverV(sighash, r, s, pubKeyRaw);
      const signedTx = assembleSignedTx(unsignedTx, r, s, recoveryBit);

      // 4. Broadcast
      setSigningPhase("broadcasting");
      const txHash = await broadcastTransaction(chain.rpcUrl, signedTx.rawTransaction);

      fetch(apiUrl("/api/sign/broadcast"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ keyShareId: keyFile.id, sessionId, txHash, chainId: chain.id }),
      }).catch(() => {});

      onTxSubmitted?.(txHash, to, amount);

      // 5. Poll for receipt
      setPendingTxHash(txHash);
      setSigningPhase("polling");
      const receipt = await waitForReceipt(chain.rpcUrl, txHash, () => {}, 60, 3000);

      setTxResult({ status: receipt.status, txHash, blockNumber: receipt.blockNumber });
      if (receipt.status === "success") onTxConfirmed?.(txHash);
      setStep("result");

    } catch (err: any) {
      console.error("[send] Error:", err);
      setSigningError(err.message || String(err));
    }
  }

  // ── BTC signing flow ──────────────────────────────────────────
  async function executeBtcSigningFlow() {
    if (!keyFile || !btcFeeRate) return;

    setStep("signing");
    setSigningPhase("building-tx");
    setSigningError(null);

    const btcApi = mempoolApiUrl(chain.explorerUrl);
    try {
      // Restore key handles if not in memory
      if (!clientKeys.has(keyFile.id)) {
        await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
      }

      // 1. Fetch UTXOs and build transaction
      const utxos = await fetchUtxos(address, btcApi);
      const amountSats = parseUnits(amount, asset.decimals);
      const addrType = detectAddressType(address);
      const btcTx = buildBtcTransaction(to, amountSats, utxos, btcFeeRate, address, addrType);
      // 2. Get compressed public key and hash
      setSigningPhase("mpc-signing");
      const pubKeyRaw = hexToBytes(keyFile.publicKey);
      const compressedPubKey = getCompressedPublicKey(
        Array.from(pubKeyRaw).map((b) => b.toString(16).padStart(2, "0")).join("")
      );
      const pkHash = pubKeyHash(compressedPubKey);
      const isLegacy = addrType === "p2pkh";

      // BTC tx payload for server-side verification
      const btcTxPayload = {
        version: btcTx.version,
        inputs: btcTx.inputs.map((inp) => ({
          txid: inp.txid, vout: inp.vout, value: inp.value.toString(), sequence: inp.sequence,
        })),
        outputs: btcTx.outputs.map((out) => ({
          value: out.value.toString(), scriptPubKey: bytesToHex(out.scriptPubKey),
        })),
        locktime: btcTx.locktime,
      };

      // 3. Sign each input via MPC
      const witnesses: Uint8Array[][] = [];
      const scriptSigs: Uint8Array[] = [];

      for (let i = 0; i < btcTx.inputs.length; i++) {
        const sighash = isLegacy ? legacySighash(btcTx, i, pkHash) : bip143Sighash(btcTx, i, pkHash);

        const { signature: sigRaw } = await performMpcSign({
          algorithm: "ecdsa",
          keyId: keyFile.id,
          hash: sighash,
          initPayload: {
            id: keyFile.id, chainType: "btc", btcTx: btcTxPayload,
            inputIndex: i, pubKeyHash: toBase64(pkHash), from: address,
          },
          headers: sensitiveHeaders(),
        });

        const { r: sigR, s: sigS } = parseDerSignature(sigRaw);
        if (isLegacy) {
          scriptSigs.push(makeP2PKHScriptSig(sigR, sigS, compressedPubKey));
        } else {
          witnesses.push(makeP2WPKHWitness(sigR, sigS, compressedPubKey));
        }
      }

      // 4. Assemble and serialize
      let rawHex: string;
      let txid: string;
      if (isLegacy) {
        rawHex = bytesToHex(serializeLegacyTx(btcTx, scriptSigs));
        txid = computeLegacyTxid(btcTx, scriptSigs);
      } else {
        rawHex = bytesToHex(serializeWitnessTx(btcTx, witnesses));
        txid = computeTxid(btcTx);
      }

      // 5. Broadcast
      setSigningPhase("broadcasting");
      const broadcastTxid = await broadcastBtcTx(rawHex, btcApi);

      fetch(apiUrl("/api/sign/broadcast"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ keyShareId: keyFile.id, txHash: broadcastTxid || txid, chainId: chain.id }),
      }).catch(() => {});

      onTxSubmitted?.(broadcastTxid || txid, to, amount);

      // 6. Wait for confirmation
      setPendingTxHash(broadcastTxid || txid);
      setSigningPhase("polling");
      const result = await waitForBtcConfirmation(broadcastTxid || txid, () => {}, 60, 5000, btcApi);

      setTxResult({
        status: result.confirmed ? "success" : "pending",
        txHash: broadcastTxid || txid,
        blockNumber: result.blockHeight,
      });
      if (result.confirmed) onTxConfirmed?.(broadcastTxid || txid);
      setStep("result");

    } catch (err: any) {
      console.error("[send] BTC Error:", err);
      setSigningError(err.message || String(err));
    }
  }

  // ── BCH signing flow ──────────────────────────────────────
  async function executeBchSigningFlow() {
    if (!keyFile || !bchFeeRate) return;

    setStep("signing");
    setSigningPhase("building-tx");
    setSigningError(null);

    const api = bchApiUrl();
    try {
      if (!clientKeys.has(keyFile.id)) {
        await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
      }

      // 1. Fetch UTXOs and build transaction
      const utxos = await fetchBchUtxos(address, api);
      const amountSats = parseUnits(amount, asset.decimals);
      const bchTx = buildBchTransaction(to, amountSats, utxos, bchFeeRate, address);

      // 2. Get compressed public key and hash
      setSigningPhase("mpc-signing");
      const pubKeyRaw = hexToBytes(keyFile.publicKey);
      const compressedPubKey = getBchCompressedPublicKey(
        Array.from(pubKeyRaw).map((b) => b.toString(16).padStart(2, "0")).join("")
      );
      const pkHash = bchPubKeyHash(compressedPubKey);

      // BCH tx payload for server-side verification
      const bchTxPayload = {
        version: bchTx.version,
        inputs: bchTx.inputs.map((inp) => ({
          txid: inp.txid, vout: inp.vout, value: inp.value.toString(), sequence: inp.sequence,
        })),
        outputs: bchTx.outputs.map((out) => ({
          value: out.value.toString(), scriptPubKey: bytesToHex(out.scriptPubKey),
        })),
        locktime: bchTx.locktime,
      };

      // 3. Sign each input via MPC (BCH uses SIGHASH_FORKID)
      const scriptSigs: Uint8Array[] = [];

      for (let i = 0; i < bchTx.inputs.length; i++) {
        const sighash = bchSighash(bchTx, i, pkHash);

        const { signature: sigRaw } = await performMpcSign({
          algorithm: "ecdsa",
          keyId: keyFile.id,
          hash: sighash,
          initPayload: {
            id: keyFile.id, chainType: "bch", bchTx: bchTxPayload,
            inputIndex: i, pubKeyHash: toBase64(pkHash), from: address,
          },
          headers: sensitiveHeaders(),
        });

        const { r: sigR, s: sigS } = parseDerSignature(sigRaw);
        scriptSigs.push(makeBchP2PKHScriptSig(sigR, sigS, compressedPubKey));
      }

      // 4. Assemble and serialize
      const rawHex = bytesToHex(serializeBchTx(bchTx, scriptSigs));
      const txid = computeBchTxid(bchTx, scriptSigs);

      // 5. Broadcast
      setSigningPhase("broadcasting");
      const broadcastTxid = await broadcastBchTx(rawHex, api);

      fetch(apiUrl("/api/sign/broadcast"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ keyShareId: keyFile.id, txHash: broadcastTxid || txid, chainId: chain.id }),
      }).catch(() => {});

      onTxSubmitted?.(broadcastTxid || txid, to, amount);

      // 6. Wait for confirmation
      setPendingTxHash(broadcastTxid || txid);
      setSigningPhase("polling");
      const result = await waitForBchConfirmation(broadcastTxid || txid, () => {}, 60, 5000, api);

      setTxResult({
        status: result.confirmed ? "success" : "pending",
        txHash: broadcastTxid || txid,
        blockNumber: result.blockHeight,
      });
      if (result.confirmed) onTxConfirmed?.(broadcastTxid || txid);
      setStep("result");

    } catch (err: any) {
      console.error("[send] BCH Error:", err);
      setSigningError(err.message || String(err));
    }
  }

  // ── Solana signing flow ──────────────────────────────────────
  async function executeSolanaSigningFlow() {
    if (!keyFile || !chain.rpcUrl) return;

    setStep("signing");
    setSigningPhase("building-tx");
    setSigningError(null);

    try {
      // Restore key handles if not in memory
      if (!clientKeys.has(keyFile.id)) {
        await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
      }

      // 1. Build unsigned transaction message
      const fromPubKey = base58.decode(address);
      const toPubKey = base58.decode(to);
      const tokenAmount = parseUnits(amount, asset.decimals);
      const recentBlockhash = await getLatestBlockhash(chain.rpcUrl);

      let message: Uint8Array;
      if (!asset.isNative && asset.contractAddress) {
        const mint = base58.decode(asset.contractAddress);
        const destAta = findAssociatedTokenAddress(toPubKey, mint);
        const needsCreateAta = !(await checkAtaExists(chain.rpcUrl, base58.encode(destAta)));
message = buildSplTransferMessage({
          from: fromPubKey, to: toPubKey, mint, amount: tokenAmount,
          decimals: asset.decimals, recentBlockhash, createAta: needsCreateAta,
        });
      } else {
        message = buildSolanaTransferMessage({ from: fromPubKey, to: toPubKey, lamports: tokenAmount, recentBlockhash });
      }

      // 2. MPC EdDSA signing
      setSigningPhase("mpc-signing");

      const { signature: sigRaw, sessionId } = await performMpcSign({
        algorithm: "eddsa",
        keyId: keyFile.id,
        hash: message,
        initPayload: { id: keyFile.id, algorithm: "eddsa", from: address, chainType: "solana", unsignedTx: toBase64(message) },
        headers: sensitiveHeaders(),
      });

      // 3. Assemble signed transaction
      const signedTxBase58 = assembleSolanaTransaction(message, sigRaw);

      // 4. Broadcast
      setSigningPhase("broadcasting");
      const txSig = await broadcastSolanaTransaction(chain.rpcUrl, signedTxBase58);

      fetch(apiUrl("/api/sign/broadcast"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ keyShareId: keyFile.id, sessionId, txHash: txSig, chainId: chain.id }),
      }).catch(() => {});

      onTxSubmitted?.(txSig, to, amount);

      // 5. Poll for confirmation
      setPendingTxHash(txSig);
      setSigningPhase("polling");
      const result = await waitForSolanaConfirmation(chain.rpcUrl, txSig, () => {}, 60, 2000);

      setTxResult({
        status: result.confirmed ? "success" : "pending",
        txHash: txSig,
        blockNumber: result.slot,
      });
      if (result.confirmed) onTxConfirmed?.(txSig);
      setStep("result");

    } catch (err: any) {
      console.error("[send] Solana Error:", err);
      setSigningError(err.message || String(err));
    }
  }

  // ── XRP signing flow ────────────────────────────────────────────
  async function executeXrpSigningFlow() {
    if (!keyFile || !chain.rpcUrl) return;

    setStep("signing");
    setSigningPhase("building-tx");
    setSigningError(null);

    try {
      // Restore key handles if not in memory
      if (!clientKeys.has(keyFile.id)) {
        await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
      }

      // 1. Build payment params
      const acctInfo = await getXrpAccountInfo(chain.rpcUrl, address);
      const ledgerIndex = await getCurrentLedgerIndex(chain.rpcUrl);
      const amountDrops = BigInt(Math.round(parseFloat(amount) * 1e6));

      const pubKeyRaw = hexToBytes(keyFile.publicKey);
      const compressed = getCompressedPublicKey(
        Array.from(pubKeyRaw).map((b) => b.toString(16).padStart(2, "0")).join("")
      );

      const params: XrpPaymentParams = {
        from: address,
        to,
        amountDrops,
        fee: XRP_BASE_FEE,
        sequence: acctInfo.sequence,
        lastLedgerSequence: ledgerIndex + 20,
        destinationTag: destinationTag ? Number(destinationTag) : undefined,
        signingPubKey: compressed,
      };

      // 2. MPC signing
      setSigningPhase("mpc-signing");
      const sighash = xrpHashForSigning(params);

      const { signature: sigRaw, sessionId } = await performMpcSign({
        algorithm: "ecdsa",
        keyId: keyFile.id,
        hash: sighash,
        initPayload: {
          id: keyFile.id,
          chainType: "xrp",
          xrpTx: {
            from: address,
            to,
            amountDrops: amountDrops.toString(),
            fee: XRP_BASE_FEE.toString(),
            sequence: params.sequence,
            lastLedgerSequence: params.lastLedgerSequence,
            destinationTag: params.destinationTag,
            signingPubKey: bytesToHex(compressed),
          },
          from: address,
        },
        headers: sensitiveHeaders(),
      });

      // 3. Parse DER signature (low-S normalized) and re-encode for XRP
      const { r, s } = parseDerSignature(sigRaw);
      const rHex = r.toString(16).padStart(64, "0");
      const sHex = s.toString(16).padStart(64, "0");
      const rBytes = hexToBytes(rHex);
      const sBytes = hexToBytes(sHex);
      // DER encode: 30 <len> 02 <rlen> <r> 02 <slen> <s>
      const rDer = rBytes[0] >= 0x80 ? new Uint8Array([0, ...rBytes]) : rBytes;
      const sDer = sBytes[0] >= 0x80 ? new Uint8Array([0, ...sBytes]) : sBytes;
      const derLen = 2 + rDer.length + 2 + sDer.length;
      const sigDer = new Uint8Array(2 + derLen);
      sigDer[0] = 0x30; sigDer[1] = derLen;
      sigDer[2] = 0x02; sigDer[3] = rDer.length; sigDer.set(rDer, 4);
      sigDer[4 + rDer.length] = 0x02; sigDer[5 + rDer.length] = sDer.length; sigDer.set(sDer, 6 + rDer.length);
      const signedTxHex = xrpAssembleSignedTx(params, sigDer);

      // 4. Broadcast
      setSigningPhase("broadcasting");
      const txHash = await broadcastXrpTransaction(chain.rpcUrl, signedTxHex);

      fetch(apiUrl("/api/sign/broadcast"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ keyShareId: keyFile.id, sessionId, txHash, chainId: chain.id }),
      }).catch(() => {});

      onTxSubmitted?.(txHash, to, amount);

      // 5. Wait for confirmation
      setPendingTxHash(txHash);
      setSigningPhase("polling");
      const result = await waitForXrpConfirmation(chain.rpcUrl, txHash, () => {}, 30, 3000);

      setTxResult({
        status: result.confirmed ? "success" : "pending",
        txHash,
        blockNumber: result.ledgerIndex,
      });
      if (result.confirmed) onTxConfirmed?.(txHash);
      setStep("result");

    } catch (err: any) {
      console.error("[send] XRP Error:", err);
      setSigningError(err.message || String(err));
    }
  }

  // ── XLM signing flow ────────────────────────────────────────────
  async function executeXlmSigningFlow() {
    if (!keyFile || !chain.rpcUrl) return;

    setStep("signing");
    setSigningPhase("building-tx");
    setSigningError(null);

    try {
      if (!clientKeys.has(keyFile.id)) {
        await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
      }

      // 1. Derive the correct source address from keyFile.eddsaPublicKey.
      // cb-mpc's ecKey2pInfo() returns different publicKey values for party 0 (client)
      // vs party 1 (server). The signature verifies against party 0's key (client).
      // The server DB stores party 1's key (wrong for address derivation).
      // So we always derive fromAddress from keyFile.eddsaPublicKey here.
      const fromAddress = eddsaPubKeyToXlmAddress(keyFile.eddsaPublicKey);
      const fromPubKey = strKeyToPublicKey(fromAddress);

      const { sequence } = await getXlmAccountInfo(chain.rpcUrl, fromAddress);
      const feeStroops = xlmFeeRates?.[feeLevel] ?? 100;
      const amountStroops = BigInt(Math.round(parseFloat(amount) * 1e7));
      const isTestnet = chain.rpcUrl.includes("testnet");

      // 2. Check if destination exists; use CREATE_ACCOUNT for new native XLM accounts
      const destExists = await checkXlmAccountExists(chain.rpcUrl, to);
      if (!destExists && !asset.isNative) {
        throw new Error("Destination account is not activated. Send XLM first to activate it.");
      }

      const txXdr = destExists
        ? buildXlmTransactionXdr({
            from: fromAddress, to, amountStroops, feeStroops,
            sequence: sequence + 1n,
            asset: asset.isNative ? undefined : { code: asset.symbol, issuer: asset.contractAddress! },
          })
        : buildXlmCreateAccountXdr({
            from: fromAddress, to, amountStroops, feeStroops,
            sequence: sequence + 1n,
          });

      // 3. MPC EdDSA sign
      setSigningPhase("mpc-signing");
      const signingHash = await xlmHashForSigning(txXdr, isTestnet);

      const { signature: sigRaw, sessionId } = await performMpcSign({
        algorithm: "eddsa",
        keyId: keyFile.id,
        hash: signingHash,
        initPayload: {
          id: keyFile.id,
          algorithm: "eddsa",
          from: fromAddress,
          chainType: "xlm",
          unsignedTx: toBase64(txXdr),
          // Send client-computed eddsaPublicKey so the server can correct its DB
          eddsaPublicKey: keyFile.eddsaPublicKey,
          xlmTx: {
            to,
            amount: amount,
            asset: asset.isNative ? "XLM" : asset.symbol,
          },
        },
        headers: sensitiveHeaders(),
      });

      // 4. Assemble signed envelope
      const txBase64 = assembleXlmSignedTx(txXdr, fromPubKey, sigRaw);

      // 5. Broadcast
      setSigningPhase("broadcasting");
      const txHash = await broadcastXlmTransaction(chain.rpcUrl, txBase64);

      fetch(apiUrl("/api/sign/broadcast"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ keyShareId: keyFile.id, sessionId, txHash, chainId: chain.id }),
      }).catch(() => {});

      onTxSubmitted?.(txHash, to, amount);

      // 6. Poll for confirmation
      setPendingTxHash(txHash);
      setSigningPhase("polling");
      const result = await waitForXlmConfirmation(chain.rpcUrl, txHash, () => {}, 30, 3000);

      setTxResult({
        status: result.confirmed ? "success" : "pending",
        txHash,
        blockNumber: result.ledger,
      });
      if (result.confirmed) onTxConfirmed?.(txHash);
      setStep("result");

    } catch (err: any) {
      console.error("[send] XLM Error:", err);
      setSigningError(err.message || String(err));
    }
  }

  const recovery = isRecoveryMode();
  const signLabel = recovery ? "Local signing" : "MPC signing";
  const phaseLabels: Record<SigningPhase, string> = {
    "loading-keyshare": "Build transaction",
    "building-tx": "Build transaction",
    "mpc-signing": signLabel,
    "broadcasting": "Broadcast",
    "polling": "Confirming",
  };

  // Map internal phases to 4 display steps: Build (0) → Sign (1) → Broadcast (2) → Confirming (3)
  const phaseIndex: Record<SigningPhase, number> = {
    "loading-keyshare": 0,
    "building-tx": 0,
    "mpc-signing": 1,
    "broadcasting": 2,
    "polling": 3,
  };

  const canClose = step === "input" || step === "preview" || step === "result" || signingError != null
    || (step === "signing" && (signingPhase === "polling" || signingPhase === "broadcasting"));

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && canClose) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canClose, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={canClose ? onClose : undefined} />

      {/* Dialog */}
      <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          {step === "preview" ? (
            <button
              onClick={() => setStep("input")}
              className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              Edit
            </button>
          ) : step === "signing" ? (
            <h3 className="text-sm font-semibold text-text-primary">⏳ Signing</h3>
          ) : step === "result" ? (
            <h3 className="text-sm font-semibold text-text-primary">
              {txResult?.status === "success" ? "✅ Success" : txResult?.status === "pending" ? "📡 Broadcast" : "❌ Failed"}
            </h3>
          ) : (
            <h3 className="text-sm font-semibold text-text-primary">
              📤 Send {asset.symbol}
            </h3>
          )}
          {step === "preview" && (
            <h3 className="text-sm font-semibold text-text-primary absolute left-1/2 -translate-x-1/2">
              👀 Review
            </h3>
          )}
          {canClose && (
            <button
              onClick={onClose}
              className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-tertiary transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {step === "input" && (
          <>
            {/* Body — Input step */}
            <div className="p-5 space-y-4">
              {/* Key share file */}
              <div>
                <label className="block text-xs text-text-muted mb-1.5">Key Share</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                {keyFile ? (
                  <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-green-500/10 flex items-center justify-center flex-shrink-0">
                      <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-text-secondary truncate">
                        {keyFile.id.slice(0, 8)}...{keyFile.id.slice(-4)}
                      </p>
                      <p className="text-[10px] text-text-muted font-mono truncate">{keyFile.publicKey.slice(0, 24)}...</p>
                    </div>
                    <button
                      onClick={() => !recovery && setKeyFile(null)}
                      disabled={recovery}
                      className={`p-1 rounded-md transition-colors ${recovery ? "opacity-40 cursor-not-allowed" : "hover:bg-surface-tertiary"}`}
                      title={recovery ? "Key loaded from recovery" : "Change key share"}
                    >
                      <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                      </svg>
                    </button>
                  </div>
                ) : browserShareMode && !showBrowserPassphrase ? (
                  <div className="space-y-2">
                    <button
                      onClick={loadBrowserShare}
                      disabled={browserShareLoading}
                      className="w-full bg-surface-primary border border-blue-500/30 rounded-lg px-3 py-2.5 flex items-center gap-2.5 hover:border-blue-500/50 transition-colors text-left disabled:opacity-50 animate-pulse"
                    >
                      <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a9 9 0 11-18 0V5.25" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-text-secondary truncate">{keyId.slice(0, 8)}...</p>
                        <p className="text-[10px] text-text-muted">{browserShareMode === "prf" ? "Passkey encrypted" : "Passphrase encrypted"} · ECDSA + EdDSA</p>
                      </div>
                      {browserShareLoading ? (
                        <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
                      ) : (
                        <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                        </svg>
                      )}
                    </button>
                    {browserShareError && (
                      <p className="text-[11px] text-red-400 text-center">{browserShareError}</p>
                    )}
                    <button
                      onClick={() => { setBrowserShareMode(null); }}
                      className="w-full text-[11px] text-text-muted hover:text-text-tertiary transition-colors"
                    >
                      Or upload a file instead
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full bg-surface-primary border border-border-primary border-dashed rounded-lg px-3 py-3 flex items-center justify-center gap-2 hover:border-blue-500/50 transition-colors text-left"
                    >
                      <svg className="w-4 h-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                      </svg>
                      <span className="text-xs text-text-muted">Upload key share file (.json)</span>
                    </button>
                    <p className="text-[10px] text-text-muted text-center">
                      To restore from a server backup, go to Backup & Recovery.
                    </p>
                  </div>
                )}
              </div>

              {/* Passphrase prompt for encrypted files */}
              {pendingEncrypted && !keyFile && (
                <div className="bg-surface-primary border border-border-primary rounded-lg p-3">
                  <p className="text-xs text-text-muted mb-2">
                    <span className="font-mono text-text-tertiary">{pendingEncrypted.id.slice(0, 8)}...</span> — Enter your passphrase to unlock
                  </p>
                  <PassphraseInput
                    mode="enter"
                    submitLabel="Decrypt"
                    onSubmit={async (passphrase) => {
                      const decrypted = await decryptKeyFile(pendingEncrypted, passphrase);
                      setKeyFile(decrypted as KeyFile);
                      setPendingEncrypted(null);
                    }}
                  />
                </div>
              )}

              {/* Browser-stored share passphrase prompt */}
              {showBrowserPassphrase && !keyFile && (
                <div className="bg-surface-primary border border-border-primary rounded-lg p-3">
                  <p className="text-xs text-text-muted mb-2">
                    Enter your passphrase to unlock this key share
                  </p>
                  <PassphraseInput
                    mode="enter"
                    submitLabel="Decrypt"
                    onSubmit={async (passphrase) => {
                      const data = await getKeyShareWithPassphrase(keyId, passphrase);
                      if (data) {
                        setKeyFile(data as KeyFile);
                        setShowBrowserPassphrase(false);
                      }
                    }}
                  />
                </div>
              )}

              {/* From */}
              <div>
                <label className="block text-xs text-text-muted mb-1.5">From</label>
                <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5">
                  <p className="text-xs font-mono text-text-tertiary truncate">{address}</p>
                  <p className="text-[10px] text-text-muted mt-0.5">
                    Balance: {maskBalance(truncateBalance(balance), balancesHidden)} {asset.symbol} &middot; {chain.displayName}
                  </p>
                </div>
              </div>

              {/* To */}
              <div>
                <label className="block text-xs text-text-muted mb-1.5">To</label>
                <div className={`relative flex items-center bg-surface-primary border rounded-lg ${
                  toError
                    ? "border-red-500/50 focus-within:border-red-500"
                    : toSelf
                      ? "border-yellow-500/50 focus-within:border-yellow-500"
                      : "border-border-primary focus-within:border-blue-500"
                }`}>
                  <input
                    type="text"
                    value={to}
                    onChange={(e) => setTo(e.target.value.trim())}
                    onBlur={() => setToTouched(true)}
                    placeholder={placeholder}
                    className="flex-1 min-w-0 bg-transparent px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none font-mono"
                  />
                  {/* Paste button — mobile only */}
                  <button
                    type="button"
                    className="md:hidden p-1.5 mr-0.5 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-tertiary transition-colors shrink-0"
                    onClick={async () => {
                      try {
                        const text = await navigator.clipboard.readText();
                        if (text) setTo(text.trim());
                      } catch { /* clipboard denied */ }
                    }}
                    title="Paste"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                  </button>
                  {/* Scan QR button */}
                  <button
                    type="button"
                    className="p-1.5 mr-1 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-tertiary transition-colors shrink-0"
                    onClick={() => setShowAddrScanner((v) => !v)}
                    title="Scan QR"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7V5a2 2 0 012-2h2m10 0h2a2 2 0 012 2v2m0 10v2a2 2 0 01-2 2h-2M3 17v2a2 2 0 002 2h2" />
                      <rect x="7" y="7" width="4" height="4" rx="0.5" />
                      <rect x="13" y="7" width="4" height="4" rx="0.5" />
                      <rect x="7" y="13" width="4" height="4" rx="0.5" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 13h4v4h-4" />
                    </svg>
                  </button>
                </div>
                {showAddrScanner && (
                  <div className="mt-2 rounded-xl overflow-hidden border border-border-primary">
                    <Scanner
                      onScan={(results) => {
                        if (results.length > 0) {
                          let raw = results[0].rawValue;
                          // Strip common URI prefixes (ethereum:, solana:, bitcoin:)
                          const colonIdx = raw.indexOf(":");
                          if (colonIdx > 0 && colonIdx < 10) raw = raw.slice(colonIdx + 1);
                          // Strip query params
                          const qIdx = raw.indexOf("?");
                          if (qIdx > 0) raw = raw.slice(0, qIdx);
                          setTo(raw.trim());
                          setShowAddrScanner(false);
                        }
                      }}
                      onError={() => setShowAddrScanner(false)}
                      formats={["qr_code"]}
                      components={{ finder: true }}
                      styles={{ container: { width: "100%" } }}
                    />
                  </div>
                )}
                {toError && (
                  <p className="text-[10px] text-red-400 mt-1">{toError}</p>
                )}
                {toSelf && (
                  <p className="text-[10px] text-yellow-400 mt-1">This is your own address</p>
                )}
              </div>

              {/* Destination Tag (XRP only) */}
              {chain.type === "xrp" && (
              <div>
                <label className="block text-xs text-text-muted mb-1.5">Destination Tag <span className="text-text-muted/50">(optional)</span></label>
                <input
                  type="text"
                  value={destinationTag}
                  onChange={(e) => setDestinationTag(e.target.value.replace(/\D/g, ""))}
                  placeholder="e.g. 12345"
                  className={`w-full bg-surface-primary border rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none tabular-nums ${
                    destinationTag && !destTagValid
                      ? "border-red-500/50 focus:border-red-500"
                      : "border-border-primary focus:border-blue-500"
                  }`}
                />
                {destinationTag && !destTagValid && (
                  <p className="text-[10px] text-red-400 mt-1">Must be 0–4,294,967,295</p>
                )}
              </div>
              )}

              {/* Amount */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-text-muted">Amount</label>
                  <button
                    onClick={() => { setAmount(maxSendable); setAmountTouched(true); }}
                    className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Max
                  </button>
                </div>
                <div className="relative">
                  <input
                    type="text"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    onBlur={() => setAmountTouched(true)}
                    placeholder="0.00"
                    className={`w-full bg-surface-primary border rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none tabular-nums pr-16 ${
                      amountError
                        ? "border-red-500/50 focus:border-red-500"
                        : "border-border-primary focus:border-blue-500"
                    }`}
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-muted">
                    {asset.symbol}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-1">
                  {amountError ? (
                    <p className="text-[10px] text-red-400">{amountError}</p>
                  ) : amountUsd != null ? (
                    <p className="text-[10px] text-text-muted tabular-nums">{formatUsd(amountUsd)}</p>
                  ) : (
                    <span />
                  )}
                </div>
              </div>

              {/* Fee level selector (not shown for fixed-fee chains) */}
              {feeDisplay.hasLevelSelector && (
              <div className="bg-surface-primary border border-border-primary rounded-lg p-1.5">
                <div className="grid grid-cols-3 gap-1">
                  {(["low", "medium", "high"] as FeeLevel[]).map((level) => {
                    const isActive = feeLevel === level;
                    const feeText = chain.type === "btc"
                      ? (btcFeeRates?.[level] != null ? `${btcFeeRates[level]} sat/vB` : "...")
                      : (baseGasPrice != null ? `${formatGwei(BigInt(Math.round(Number(baseGasPrice) * EVM_FEE_MULTIPLIER[level])))} Gwei` : "...");
                    return (
                      <button
                        key={level}
                        onClick={() => setFeeLevel(level)}
                        className={`flex flex-col items-center py-2 px-1 rounded-md transition-all ${
                          isActive
                            ? "bg-surface-tertiary ring-1 ring-blue-500/40"
                            : "hover:bg-surface-tertiary/50"
                        }`}
                      >
                        <span className={`text-[11px] font-medium ${isActive ? "text-text-primary" : "text-text-muted"}`}>
                          {FEE_LABELS[level]}
                        </span>
                        <span className={`text-[10px] tabular-nums mt-0.5 ${isActive ? "text-text-secondary" : "text-text-muted/70"}`}>
                          {feeText}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              )}

              {/* Fee summary */}
              <div className="flex items-center justify-between px-1">
                <span className="text-[10px] text-text-muted flex items-center gap-1">
                  Est. fee
                  {!feeDisplay.isFixed && (
                  <span className="text-text-muted/40 tabular-nums">
                    {feeCountdown > 0 ? `\u00b7 ${feeCountdown}s` : "\u00b7 \u27f3"}
                  </span>
                  )}
                </span>
                {feeDisplay.formatted != null ? (
                  <span className="text-[11px] tabular-nums text-text-secondary">
                    {feeDisplay.formatted} {feeDisplay.symbol}
                    {feeDisplay.usd != null && feeDisplay.usd > 0 && (
                      <span className="text-text-muted ml-1">({formatUsd(feeDisplay.usd)})</span>
                    )}
                  </span>
                ) : (
                  <span className="text-[10px] text-text-muted animate-pulse">Estimating...</span>
                )}
              </div>
            </div>

            {/* Footer — Input step */}
            <div className="px-5 py-4 border-t border-border-secondary">
              <button
                disabled={!canReview}
                onClick={async () => {
                  if (chain.type === "xlm" && chain.rpcUrl) {
                    setXlmDestExists(null);
                    const exists = await checkXlmAccountExists(chain.rpcUrl, to);
                    setXlmDestExists(exists);
                  }
                  setStep("preview");
                }}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                👀 Review Transaction
              </button>
            </div>
          </>
        )}

        {step === "preview" && (
          <>
            {/* Body — Preview step */}
            <div className="p-5 space-y-5">
              {/* Amount hero */}
              <div className="text-center py-2">
                <p className="text-2xl font-semibold tabular-nums text-text-primary">
                  {amount} <span className="text-text-tertiary text-base">{asset.symbol}</span>
                </p>
                {amountUsd != null && (
                  <p className="text-sm text-text-muted tabular-nums mt-0.5">{formatUsd(amountUsd)}</p>
                )}
              </div>

              {/* From → To */}
              <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
                <div className="px-3 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-text-muted">From</span>
                  <span className="text-xs font-mono text-text-secondary">{shortAddrPreview(address)}</span>
                </div>
                <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-text-muted">To</span>
                  <span className="text-xs font-mono text-text-secondary">{shortAddrPreview(to)}</span>
                </div>
                {destinationTag && (
                <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-text-muted">Destination Tag</span>
                  <span className="text-xs tabular-nums text-text-secondary">{destinationTag}</span>
                </div>
                )}
              </div>
              {chain.type === "xlm" && xlmDestExists === false && (
                <p className="text-[10px] text-yellow-400 -mt-3">New account — a Create Account operation will be used to activate this address.</p>
              )}

              {/* Details */}
              <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
                <div className="px-3 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-text-muted">Network</span>
                  <span className="text-xs text-text-secondary">{chain.displayName}</span>
                </div>
                <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-text-muted">Estimated fee</span>
                  <div className="text-right">
                    <span className="text-xs tabular-nums text-text-secondary font-medium">
                      {(feeDisplay.formatted ?? "—") + " " + feeDisplay.symbol}
                    </span>
                    {feeDisplay.usd != null && (
                      <span className="text-[10px] text-text-muted ml-1.5 tabular-nums">
                        ({formatUsd(feeDisplay.usd)})
                      </span>
                    )}
                  </div>
                </div>
                {feeDisplay.rateLabel != null && (
                  <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                    <span className="text-xs text-text-muted">{chain.type === "btc" || chain.type === "bch" ? "Fee rate" : chain.type === "xlm" ? "Base fee" : "Gas price"}</span>
                    <span className="text-xs tabular-nums text-text-muted">{feeDisplay.rateLabel}</span>
                  </div>
                )}
                <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-text-muted font-medium">Total cost</span>
                  <span className="text-xs tabular-nums text-text-primary font-semibold">
                    {totalUsd > 0 ? formatUsd(totalUsd) : "—"}
                  </span>
                </div>
              </div>

              {/* Balance changes */}
              {(() => {
                const changes: BalanceChange[] = [];
                const amountBase = amount ? parseUnits(amount, asset.decimals) : 0n;
                const balanceBase = parseUnits(balance, asset.decimals);

                if (asset.isNative) {
                  // Native: balance decreases by amount + fee
                  let feeCost = 0n;
                  if (chain.type === "evm" && estimatedFeeWei != null) feeCost = estimatedFeeWei;
                  else if (chain.type === "solana") feeCost = SOLANA_BASE_FEE;
                  else if (chain.type === "xrp") feeCost = XRP_BASE_FEE;
                  else if (chain.type === "btc" && btcEstimatedFee != null) feeCost = BigInt(btcEstimatedFee);
                  else if (chain.type === "bch" && bchEstimatedFee != null) feeCost = bchEstimatedFee;
                  changes.push({
                    symbol: asset.symbol,
                    decimals: asset.decimals,
                    currentBalance: balanceBase.toString(),
                    delta: -(amountBase + feeCost),
                  });
                } else {
                  // Token: token balance decreases by amount
                  changes.push({
                    symbol: asset.symbol,
                    decimals: asset.decimals,
                    currentBalance: balanceBase.toString(),
                    delta: -amountBase,
                  });
                  // Native: fee only (need to fetch separately — use feeDisplay info)
                  // We don't have the native balance here, so omit if unavailable
                }

                return <BalancePreview changes={changes} prices={prices} />;
              })()}
            </div>

            {/* Footer — Preview step */}
            <div className="px-5 py-4 border-t border-border-secondary">
              <button
                onClick={() => {
                  const flows: Record<string, () => void> = { solana: executeSolanaSigningFlow, btc: executeBtcSigningFlow, bch: executeBchSigningFlow, evm: executeSigningFlow, xrp: executeXrpSigningFlow, xlm: executeXlmSigningFlow };
                  const flow = flows[chain.type];
                  if (flow) guardedSign(flow);
                  else setSigningError(`Send is not yet supported for ${chain.displayName}.`);
                }}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                🔐 Confirm &amp; Sign
              </button>
            </div>
          </>
        )}

        {step === "signing" && (
          <div className="p-5">
            {signingError ? (
              /* Error state */
              <div className="text-center py-6">
                <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-text-primary mb-1">Transaction Failed</p>
                <p className="text-xs text-red-400 break-all mb-5">{signingError}</p>
                <div className="flex gap-3">
                  <button
                    onClick={onClose}
                    className="flex-1 bg-surface-tertiary hover:bg-border-primary text-text-secondary text-sm font-medium py-2.5 rounded-lg transition-colors"
                  >
                    Close
                  </button>
                  <button
                    onClick={() => {
                      setSigningError(null);
                      setStep("preview");
                    }}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
                  >
                    Try Again
                  </button>
                </div>
              </div>
            ) : (
              /* Progress state */
              <div className="py-6">
                {/* Spinner */}
                <div className="flex justify-center mb-6">
                  <div className="relative w-16 h-16">
                    <svg className="w-16 h-16 animate-spin" viewBox="0 0 50 50" fill="none">
                      <circle cx="25" cy="25" r="20" stroke="currentColor" strokeWidth="3" className="text-surface-tertiary" />
                      <path
                        d="M25 5 A20 20 0 0 1 45 25"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        className="text-blue-500"
                      />
                    </svg>
                  </div>
                </div>

                {/* Phase label */}
                <p className="text-sm font-medium text-text-primary text-center mb-2">
                  {phaseLabels[signingPhase]}
                </p>
                <p className="text-[11px] text-text-muted text-center mb-6">
                  {amount} {asset.symbol} to {shortAddrPreview(to)}
                </p>

                {/* Progress steps */}
                <div className="space-y-2 max-w-[260px] mx-auto">
                  {([
                    { idx: 0, label: "Build transaction" },
                    { idx: 1, label: signLabel },
                    { idx: 2, label: "Broadcast" },
                    { idx: 3, label: "Confirming" },
                  ]).map(({ idx, label }) => {
                    const currentIdx = phaseIndex[signingPhase];
                    const isDone = currentIdx > idx;
                    const isCurrent = currentIdx === idx;
                    return (
                      <div key={idx} className="flex items-center gap-2.5">
                        {isDone ? (
                          <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        ) : isCurrent ? (
                          <div className="w-4 h-4 shrink-0 flex items-center justify-center">
                            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                          </div>
                        ) : (
                          <div className="w-4 h-4 shrink-0 flex items-center justify-center">
                            <div className="w-1.5 h-1.5 rounded-full bg-surface-tertiary" />
                          </div>
                        )}
                        <span className={`text-xs ${isDone ? "text-text-tertiary" : isCurrent ? "text-text-primary font-medium" : "text-text-muted"}`}>
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Tx hash card (visible during Confirming step) */}
                {pendingTxHash && signingPhase === "polling" && (
                  <a
                    href={explorerLink(chain.explorerUrl, `/tx/${pendingTxHash}`)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between mt-5 mx-auto max-w-[260px] px-3 py-2.5 rounded-lg bg-surface-primary/60 border border-border-secondary hover:border-blue-500/30 transition-colors group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[11px] text-text-muted shrink-0">Tx</span>
                      <span className="text-xs font-mono text-text-secondary truncate">{shortAddrPreview(pendingTxHash)}</span>
                    </div>
                    <svg className="w-3.5 h-3.5 text-text-muted group-hover:text-blue-400 shrink-0 ml-2 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        {step === "result" && txResult && (
          <div className="p-5">
            <div className="text-center py-6">
              {txResult.status === "success" ? (
                <>
                  <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
                    <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="text-lg font-semibold text-text-primary mb-1">Transaction Confirmed</p>
                  <p className="text-sm text-text-muted tabular-nums">
                    {amount} {asset.symbol}
                  </p>
                </>
              ) : txResult.status === "pending" ? (
                <>
                  <div className="w-14 h-14 rounded-full bg-yellow-500/10 flex items-center justify-center mx-auto mb-4">
                    <svg className="w-7 h-7 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <p className="text-lg font-semibold text-text-primary mb-1">Transaction Broadcast</p>
                  <p className="text-sm text-text-muted tabular-nums mb-1">
                    {amount} {asset.symbol}
                  </p>
                  <p className="text-[11px] text-text-muted">Waiting for network confirmation...</p>
                </>
              ) : (
                <>
                  <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                    <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </div>
                  <p className="text-lg font-semibold text-text-primary mb-1">Transaction Failed</p>
                  <p className="text-sm text-text-muted">The transaction was reverted on-chain.</p>
                </>
              )}

              {/* Transaction details card */}
              <div className="mt-5 mx-auto max-w-[280px] rounded-lg bg-surface-primary/60 border border-border-secondary overflow-hidden">
                <a
                  href={explorerLink(chain.explorerUrl, `/tx/${txResult.txHash}`)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between px-3 py-2.5 hover:bg-surface-tertiary/50 transition-colors group"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] text-text-muted shrink-0">Tx</span>
                    <span className="text-xs font-mono text-text-secondary truncate">{shortAddrPreview(txResult.txHash)}</span>
                  </div>
                  <svg className="w-3.5 h-3.5 text-text-muted group-hover:text-blue-400 shrink-0 ml-2 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
                {txResult.blockNumber && (
                  <div className="flex items-center px-3 py-2 border-t border-border-secondary">
                    <span className="text-[11px] text-text-muted shrink-0">Block</span>
                    <span className="text-xs font-mono text-text-secondary tabular-nums ml-2">
                      {(typeof txResult.blockNumber === "number" ? txResult.blockNumber : parseInt(txResult.blockNumber, 16)).toLocaleString()}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-border-secondary pt-4">
              <button
                onClick={onClose}
                className="w-full bg-surface-tertiary hover:bg-border-primary text-text-secondary text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Passkey guard dialogs */}
      {passkeyGuard === "gate" && (
        <PasskeyGate
          onRegistered={onPasskeyComplete}
          onCancel={() => { setPasskeyGuard("idle"); pendingSignRef.current = null; }}
        />
      )}
      {passkeyGuard === "challenge" && (
        <PasskeyChallenge
          onAuthenticated={onPasskeyComplete}
          onCancel={() => { setPasskeyGuard("idle"); pendingSignRef.current = null; }}
          withPrf
          autoStart
        />
      )}
    </div>
  );
}

// ── XLM Trustline Dialog ─────────────────────────────────────────────
function XlmTrustlineDialog({
  keyId, address, balance, chain, chainAssets, prices, onClose,
}: {
  keyId: string; address: string; balance: string; chain: Chain; chainAssets: Asset[]; prices: Record<string, number>; onClose: () => void;
}) {
  const [step, setStep] = useState<"select" | "input" | "preview" | "signing" | "result">("select");
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [keyFile, setKeyFile] = useState<KeyFile | null>(null);
  const [pendingEncrypted, setPendingEncrypted] = useState<KeyFileData | null>(null);
  const [browserShareMode, setBrowserShareMode] = useState<"prf" | "passphrase" | null>(null);
  const [browserShareLoading, setBrowserShareLoading] = useState(false);
  const [browserShareError, setBrowserShareError] = useState("");
  const [showBrowserPassphrase, setShowBrowserPassphrase] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [signingPhase, setSigningPhase] = useState<SigningPhase>("building-tx");
  const [signingError, setSigningError] = useState<string | null>(null);
  const [txResult, setTxResult] = useState<TxResult | null>(null);
  const [pendingTxHash, setPendingTxHash] = useState<string | null>(null);
  const [passkeyGuard, setPasskeyGuard] = useState<"idle" | "gate" | "challenge">("idle");
  const pendingSignRef = useRef<(() => void) | null>(null);
  const [xlmFeeRate, setXlmFeeRate] = useState(100);
  const [enabledAssets, setEnabledAssets] = useState<Set<string>>(new Set());
  const recovery = isRecoveryMode();
  const signLabel = recovery ? "Local signing" : "MPC signing";

  const phaseIndex: Record<SigningPhase, number> = {
    "loading-keyshare": 0, "building-tx": 0,
    "mpc-signing": 1, "broadcasting": 2, "polling": 3,
  };

  useEffect(() => {
    if (isRecoveryMode()) {
      const rkf = getRecoveryKeyFile();
      if (rkf) setKeyFile(rkf as KeyFile);
      return;
    }
    if (hasStoredKeyShare(keyId)) setBrowserShareMode(getKeyShareMode(keyId));
    if (chain.rpcUrl) {
      fetch(`${chain.rpcUrl}/fee_stats`).then(r => r.json()).then(data => {
        const p50 = parseInt(data.fee_charged?.p50 ?? "100", 10);
        setXlmFeeRate(p50);
      }).catch(() => {});
    }
  }, [keyId, chain.rpcUrl]);

  // Fetch existing trustlines so we can indicate which tokens are already enabled
  useEffect(() => {
    if (!chain.rpcUrl || !address) return;
    fetch(`${chain.rpcUrl}/accounts/${address}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.balances) return;
        const codes = new Set<string>(
          (data.balances as { asset_type: string; asset_code?: string; asset_issuer?: string }[])
            .filter(b => b.asset_code)
            .map(b => `${b.asset_code}:${b.asset_issuer}`)
        );
        setEnabledAssets(codes);
      })
      .catch(() => {});
  }, [chain.rpcUrl, address]);

  async function loadBrowserShare() {
    setBrowserShareLoading(true);
    setBrowserShareError("");
    try {
      const mode = getKeyShareMode(keyId);
      if (mode === "prf") {
        const result = await authenticatePasskey({ withPrf: true });
        if (result.prfKey) {
          const data = await getKeyShareWithPrf(keyId, result.prfKey);
          if (data) { setKeyFile(data as KeyFile); setBrowserShareLoading(false); return; }
          setBrowserShareError("Could not decrypt. Wrong passkey?");
        } else {
          setBrowserShareError("Passkey does not support encryption. Use file upload.");
        }
      } else if (mode === "passphrase") {
        setShowBrowserPassphrase(true);
      }
    } catch (err) { setBrowserShareError(String(err)); }
    setBrowserShareLoading(false);
  }

  async function guardedSign(action: () => void) {
    if (isRecoveryMode()) { action(); return; }
    try {
      const list = await fetchPasskeys();
      if (list.length === 0) { pendingSignRef.current = action; setPasskeyGuard("gate"); }
      else { pendingSignRef.current = action; setPasskeyGuard("challenge"); }
    } catch { action(); }
  }

  function onPasskeyComplete() {
    setPasskeyGuard("idle");
    pendingSignRef.current?.();
    pendingSignRef.current = null;
  }

  async function executeTrustlineFlow() {
    if (!keyFile || !chain.rpcUrl || !selectedAsset?.contractAddress) return;
    setStep("signing");
    setSigningPhase("building-tx");
    setSigningError(null);
    try {
      if (!clientKeys.has(keyFile.id)) {
        await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
      }
      const fromAddress = eddsaPubKeyToXlmAddress(keyFile.eddsaPublicKey);
      const fromPubKey = strKeyToPublicKey(fromAddress);
      const { sequence } = await getXlmAccountInfo(chain.rpcUrl, fromAddress);
      const isTestnet = chain.rpcUrl.includes("testnet");
      const txXdr = buildXlmChangeTrustXdr({
        from: fromAddress,
        feeStroops: xlmFeeRate,
        sequence: sequence + 1n,
        asset: { code: selectedAsset.symbol, issuer: selectedAsset.contractAddress },
      });
      setSigningPhase("mpc-signing");
      const signingHash = await xlmHashForSigning(txXdr, isTestnet);
      const { signature: sigRaw, sessionId } = await performMpcSign({
        algorithm: "eddsa",
        keyId: keyFile.id,
        hash: signingHash,
        initPayload: {
          id: keyFile.id,
          algorithm: "eddsa",
          from: fromAddress,
          chainType: "xlm",
          unsignedTx: toBase64(txXdr),
          eddsaPublicKey: keyFile.eddsaPublicKey,
          xlmTx: { type: "change_trust", asset: selectedAsset.symbol },
        },
        headers: sensitiveHeaders(),
      });
      const txBase64 = assembleXlmSignedTx(txXdr, fromPubKey, sigRaw);
      setSigningPhase("broadcasting");
      const txHash = await broadcastXlmTransaction(chain.rpcUrl, txBase64);
      fetch(apiUrl("/api/sign/broadcast"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ keyShareId: keyFile.id, sessionId, txHash, chainId: chain.id }),
      }).catch(() => {});
      setPendingTxHash(txHash);
      setSigningPhase("polling");
      const result = await waitForXlmConfirmation(chain.rpcUrl, txHash, () => {}, 30, 3000);
      setTxResult({ status: result.confirmed ? "success" : "pending", txHash, blockNumber: result.ledger });
      setStep("result");
    } catch (err: any) {
      setSigningError(err.message || String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={step === "signing" ? undefined : onClose} />
      <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-sm shadow-xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <div className="flex items-center gap-2">
            {(step === "input" || step === "preview") && (
              <button onClick={() => setStep(step === "preview" ? "input" : "select")} className="text-text-muted hover:text-text-secondary transition-colors mr-1">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <h3 className="text-sm font-semibold text-text-primary">
              {step === "select" ? "Enable Token"
                : step === "input" ? `Enable ${selectedAsset?.symbol}`
                : step === "preview" ? "👀 Review"
                : step === "result" ? "Done"
                : `Enable ${selectedAsset?.symbol}`}
            </h3>
          </div>
          {step !== "signing" && (
            <button onClick={onClose} className="text-text-muted hover:text-text-secondary transition-colors">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Select step */}
        {step === "select" && (
          <div className="p-5">
            <p className="text-xs text-text-muted mb-3">Select a token to enable on your Stellar account.</p>
            <div className="space-y-2">
              {chainAssets.map((a) => {
                const isEnabled = enabledAssets.has(`${a.symbol}:${a.contractAddress}`);
                return (
                  <button
                    key={a.id}
                    onClick={() => { setSelectedAsset(a); setStep("input"); }}
                    className="w-full flex items-center gap-3 px-3 py-3 bg-surface-primary border border-border-primary rounded-xl hover:border-blue-500/40 transition-colors text-left"
                  >
                    {a.iconUrl ? (
                      <img src={a.iconUrl} alt={a.symbol} className="w-8 h-8 rounded-full bg-surface-tertiary shrink-0" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-surface-tertiary shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-text-primary">{a.symbol}</p>
                      <p className="text-[11px] text-text-muted truncate">{a.name.replace(/\s*\(?\s*(testnet|devnet)\s*\)?\s*/gi, " ").trim()}</p>
                    </div>
                    {isEnabled ? (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-500 shrink-0">Enabled</span>
                    ) : (
                      <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Input step — key share + from + fee (mirrors Send input step) */}
        {step === "input" && selectedAsset && (
          <>
            <div className="p-5 space-y-4">
              <input
                ref={fileInputRef} type="file" accept=".json" className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const parsed = JSON.parse(await file.text()) as KeyFileData;
                  if (isEncryptedKeyFile(parsed)) setPendingEncrypted(parsed);
                  else setKeyFile(parsed as KeyFile);
                  e.target.value = "";
                }}
              />

              {/* Key Share */}
              <div>
                <label className="block text-xs text-text-muted mb-1.5">Key Share</label>
                {keyFile ? (
                  <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-green-500/10 flex items-center justify-center flex-shrink-0">
                      <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-text-secondary truncate">{keyFile.id.slice(0, 8)}...{keyFile.id.slice(-4)}</p>
                      <p className="text-[10px] text-text-muted font-mono truncate">{keyFile.eddsaPublicKey.slice(0, 24)}...</p>
                    </div>
                    <button
                      onClick={() => !recovery && setKeyFile(null)} disabled={recovery}
                      className={`p-1 rounded-md transition-colors ${recovery ? "opacity-40 cursor-not-allowed" : "hover:bg-surface-tertiary"}`}
                      title={recovery ? "Key loaded from recovery" : "Change key share"}
                    >
                      <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                      </svg>
                    </button>
                  </div>
                ) : browserShareMode && !showBrowserPassphrase ? (
                  <div className="space-y-2">
                    <button
                      onClick={loadBrowserShare} disabled={browserShareLoading}
                      className="w-full bg-surface-primary border border-blue-500/30 rounded-lg px-3 py-2.5 flex items-center gap-2.5 hover:border-blue-500/50 transition-colors text-left disabled:opacity-50 animate-pulse"
                    >
                      <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a9 9 0 11-18 0V5.25" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-text-secondary truncate">{keyId.slice(0, 8)}...</p>
                        <p className="text-[10px] text-text-muted">{browserShareMode === "prf" ? "Passkey encrypted" : "Passphrase encrypted"} · ECDSA + EdDSA</p>
                      </div>
                      {browserShareLoading
                        ? <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
                        : <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" /></svg>
                      }
                    </button>
                    {browserShareError && <p className="text-[11px] text-red-400 text-center">{browserShareError}</p>}
                    <button onClick={() => setBrowserShareMode(null)} className="w-full text-[11px] text-text-muted hover:text-text-tertiary transition-colors">
                      Or upload a file instead
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full bg-surface-primary border border-border-primary border-dashed rounded-lg px-3 py-3 flex items-center justify-center gap-2 hover:border-blue-500/50 transition-colors text-left"
                    >
                      <svg className="w-4 h-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                      </svg>
                      <span className="text-xs text-text-muted">Upload key share file (.json)</span>
                    </button>
                  </div>
                )}
              </div>

              {pendingEncrypted && !keyFile && (
                <div className="bg-surface-primary border border-border-primary rounded-lg p-3">
                  <p className="text-xs text-text-muted mb-2">
                    <span className="font-mono text-text-tertiary">{pendingEncrypted.id.slice(0, 8)}...</span> — Enter your passphrase to unlock
                  </p>
                  <PassphraseInput mode="enter" submitLabel="Decrypt" onSubmit={async (passphrase) => {
                    const decrypted = await decryptKeyFile(pendingEncrypted, passphrase);
                    setKeyFile(decrypted as KeyFile);
                    setPendingEncrypted(null);
                  }} />
                </div>
              )}
              {showBrowserPassphrase && !keyFile && (
                <div className="bg-surface-primary border border-border-primary rounded-lg p-3">
                  <p className="text-xs text-text-muted mb-2">Enter your passphrase to unlock this key share</p>
                  <PassphraseInput mode="enter" submitLabel="Decrypt" onSubmit={async (passphrase) => {
                    const data = await getKeyShareWithPassphrase(keyId, passphrase);
                    if (data) { setKeyFile(data as KeyFile); setShowBrowserPassphrase(false); }
                  }} />
                </div>
              )}

              {/* From */}
              <div>
                <label className="block text-xs text-text-muted mb-1.5">From</label>
                <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5">
                  <p className="text-xs font-mono text-text-tertiary truncate">{address}</p>
                  <p className="text-[10px] text-text-muted mt-0.5">{chain.displayName}</p>
                </div>
              </div>

              {/* Token being enabled */}
              <div>
                <label className="block text-xs text-text-muted mb-1.5">Token</label>
                <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 flex items-center gap-2.5">
                  {selectedAsset.iconUrl ? (
                    <img src={selectedAsset.iconUrl} alt={selectedAsset.symbol} className="w-7 h-7 rounded-full bg-surface-tertiary shrink-0" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-surface-tertiary shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-text-primary">{selectedAsset.symbol}</p>
                    <p className="text-[10px] text-text-muted truncate">{selectedAsset.name.replace(/\s*\(?\s*(testnet|devnet)\s*\)?\s*/gi, " ").trim()}</p>
                  </div>
                </div>
              </div>

              {/* Fee summary — matches Send dialog bottom */}
              <div className="flex items-center justify-between px-1">
                <span className="text-[10px] text-text-muted">Est. fee</span>
                {xlmFeeRate > 0 ? (
                  <span className="text-[11px] tabular-nums text-text-secondary">
                    {(xlmFeeRate / 1e7).toFixed(7)} XLM
                  </span>
                ) : (
                  <span className="text-[10px] text-text-muted animate-pulse">Estimating...</span>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-border-secondary">
              <button
                disabled={!keyFile}
                onClick={() => setStep("preview")}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                👀 Review
              </button>
            </div>
          </>
        )}

        {/* Preview step — review summary (mirrors Send review step) */}
        {step === "preview" && selectedAsset && (
          <>
            <div className="p-5 space-y-5">
              {/* Hero — matches Send review style */}
              <div className="text-center py-2">
                <div className="flex items-center justify-center gap-2 mb-1">
                  {selectedAsset.iconUrl && (
                    <img src={selectedAsset.iconUrl} alt={selectedAsset.symbol} className="w-6 h-6 rounded-full bg-surface-tertiary shrink-0" />
                  )}
                  <p className="text-2xl font-semibold text-text-primary">
                    Enable <span className="text-text-tertiary text-base">{selectedAsset.symbol}</span>
                  </p>
                </div>
                <p className="text-sm text-text-muted">Establish trustline</p>
              </div>

              {/* Account — mirrors From/To in Send review */}
              <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
                <div className="px-3 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-text-muted">Account</span>
                  <span className="text-xs font-mono text-text-secondary">{address.slice(0, 8)}...{address.slice(-6)}</span>
                </div>
              </div>

              {/* Details — mirrors Network/fee/gas/total block in Send review */}
              {(() => {
                const feeXlm = xlmFeeRate / 1e7;
                const feeStr = feeXlm.toFixed(7);
                const feeUsd = getUsdValue(feeStr, "XLM", prices);
                return (
                  <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
                    <div className="px-3 py-2.5 flex items-center justify-between">
                      <span className="text-xs text-text-muted">Network</span>
                      <span className="text-xs text-text-secondary">{chain.displayName}</span>
                    </div>
                    <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                      <span className="text-xs text-text-muted">Estimated fee</span>
                      <div className="text-right">
                        <span className="text-xs tabular-nums text-text-secondary font-medium">{feeStr} XLM</span>
                        {feeUsd != null && <span className="text-[10px] text-text-muted ml-1.5">({formatUsd(feeUsd)})</span>}
                      </div>
                    </div>
                    <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                      <span className="text-xs text-text-muted">Base fee</span>
                      <span className="text-xs tabular-nums text-text-muted">{xlmFeeRate} stroops</span>
                    </div>
                    <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                      <span className="text-xs text-text-muted font-medium">Total cost</span>
                      <span className="text-xs tabular-nums text-text-primary font-semibold">
                        {feeUsd != null ? formatUsd(feeUsd) : `${feeStr} XLM`}
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* Balance change — mirrors BalancePreview in Send review */}
              {(() => {
                const feeXlm = xlmFeeRate / 1e7;
                const bal = parseFloat(balance) || 0;
                const newBal = bal - feeXlm;
                const feeUsd = getUsdValue(feeXlm.toFixed(7), "XLM", prices);
                return (
                  <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
                    <div className="px-3 py-2.5 flex items-center justify-between">
                      <span className="text-xs text-text-muted">XLM</span>
                      <span className="text-xs tabular-nums text-text-secondary">
                        {bal.toFixed(5)} <span className="text-text-muted">→</span> <span className="font-medium text-text-primary">{newBal.toFixed(5)}</span>
                      </span>
                    </div>
                    <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                      <span className="text-xs text-text-muted">Change</span>
                      <span className="text-xs tabular-nums text-red-400 font-medium">
                        -{feeXlm.toFixed(7)} XLM{feeUsd != null ? ` (${formatUsd(feeUsd)})` : ""}
                      </span>
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="px-5 py-4 border-t border-border-secondary">
              <button
                onClick={() => guardedSign(executeTrustlineFlow)}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                🔐 Confirm &amp; Enable
              </button>
            </div>
          </>
        )}
        {/* Signing step */}
        {step === "signing" && (
          <div className="p-5">
            {signingError ? (
              <div className="text-center py-6">
                <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-text-primary mb-1">Transaction Failed</p>
                <p className="text-xs text-red-400 break-all mb-5">{signingError}</p>
                <div className="flex gap-3">
                  <button onClick={onClose} className="flex-1 bg-surface-tertiary hover:bg-border-primary text-text-secondary text-sm font-medium py-2.5 rounded-lg transition-colors">Close</button>
                  <button onClick={() => { setSigningError(null); setStep("preview"); }} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2.5 rounded-lg transition-colors">Try Again</button>
                </div>
              </div>
            ) : (
              <div className="py-6">
                {/* Spinner */}
                <div className="flex justify-center mb-6">
                  <div className="relative w-16 h-16">
                    <svg className="w-16 h-16 animate-spin" viewBox="0 0 50 50" fill="none">
                      <circle cx="25" cy="25" r="20" stroke="currentColor" strokeWidth="3" className="text-surface-tertiary" />
                      <path d="M25 5 A20 20 0 0 1 45 25" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="text-blue-500" />
                    </svg>
                  </div>
                </div>

                {/* Phase label */}
                <p className="text-sm font-medium text-text-primary text-center mb-2">
                  {signingPhase === "mpc-signing" ? signLabel : signingPhase === "broadcasting" ? "Broadcast" : signingPhase === "polling" ? "Confirming" : "Build transaction"}
                </p>
                <p className="text-[11px] text-text-muted text-center mb-6">
                  Enable {selectedAsset?.symbol} trustline
                </p>

                {/* Progress steps */}
                <div className="space-y-2 max-w-[260px] mx-auto">
                  {([
                    { idx: 0, label: "Build transaction" },
                    { idx: 1, label: signLabel },
                    { idx: 2, label: "Broadcast" },
                    { idx: 3, label: "Confirming" },
                  ]).map(({ idx, label }) => {
                    const currentIdx = phaseIndex[signingPhase];
                    const isDone = currentIdx > idx;
                    const isCurrent = currentIdx === idx;
                    return (
                      <div key={idx} className="flex items-center gap-2.5">
                        {isDone ? (
                          <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        ) : isCurrent ? (
                          <div className="w-4 h-4 shrink-0 flex items-center justify-center">
                            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                          </div>
                        ) : (
                          <div className="w-4 h-4 shrink-0 flex items-center justify-center">
                            <div className="w-1.5 h-1.5 rounded-full bg-surface-tertiary" />
                          </div>
                        )}
                        <span className={`text-xs ${isDone ? "text-text-tertiary" : isCurrent ? "text-text-primary font-medium" : "text-text-muted"}`}>
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Tx hash card (visible during Confirming step) */}
                {pendingTxHash && signingPhase === "polling" && (
                  <a
                    href={explorerLink(chain.explorerUrl, `/tx/${pendingTxHash}`)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between mt-5 mx-auto max-w-[260px] px-3 py-2.5 rounded-lg bg-surface-primary/60 border border-border-secondary hover:border-blue-500/30 transition-colors group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[11px] text-text-muted shrink-0">Tx</span>
                      <span className="text-xs font-mono text-text-secondary truncate">{pendingTxHash.slice(0, 16)}...</span>
                    </div>
                    <svg className="w-3.5 h-3.5 text-text-muted group-hover:text-blue-400 shrink-0 ml-2 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        {/* Result step */}
        {step === "result" && txResult && (
          <div className="p-5">
            <div className="text-center py-6">
              {txResult.status === "success" ? (
                <>
                  <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
                    <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="text-lg font-semibold text-text-primary mb-1">{selectedAsset?.symbol} Enabled</p>
                  <p className="text-sm text-text-muted">You can now receive {selectedAsset?.symbol} on Stellar</p>
                </>
              ) : (
                <>
                  <div className="w-14 h-14 rounded-full bg-yellow-500/10 flex items-center justify-center mx-auto mb-4">
                    <svg className="w-7 h-7 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <p className="text-lg font-semibold text-text-primary mb-1">Transaction Broadcast</p>
                  <p className="text-[11px] text-text-muted">Waiting for confirmation...</p>
                </>
              )}
              <div className="mt-4 mx-auto max-w-[280px] rounded-lg bg-surface-primary/60 border border-border-secondary overflow-hidden">
                <a href={explorerLink(chain.explorerUrl, `/tx/${txResult.txHash}`)} target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-between px-3 py-2.5 hover:bg-surface-tertiary/50 transition-colors group"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] text-text-muted shrink-0">Tx</span>
                    <span className="text-xs font-mono text-text-secondary truncate">{txResult.txHash.slice(0, 16)}...</span>
                  </div>
                  <svg className="w-3.5 h-3.5 text-text-muted group-hover:text-blue-400 shrink-0 ml-2 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              </div>
            </div>
            <div className="border-t border-border-secondary pt-4">
              <button onClick={onClose} className="w-full bg-surface-tertiary hover:bg-border-primary text-text-secondary text-sm font-medium py-2.5 rounded-lg transition-colors">Done</button>
            </div>
          </div>
        )}
      </div>

      {passkeyGuard === "gate" && (
        <PasskeyGate onRegistered={onPasskeyComplete} onCancel={() => { setPasskeyGuard("idle"); pendingSignRef.current = null; }} />
      )}
      {passkeyGuard === "challenge" && (
        <PasskeyChallenge onAuthenticated={onPasskeyComplete} onCancel={() => { setPasskeyGuard("idle"); pendingSignRef.current = null; }} withPrf autoStart />
      )}
    </div>
  );
}

async function getChainId(rpcUrl: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const data = await res.json();
  return parseInt(data.result, 16);
}

/** Truncate a balance string to at most `maxDecimals` decimal places */
function truncateBalance(val: string, maxDecimals = 8): string {
  if (!val.includes(".")) return val;
  const [int, frac] = val.split(".");
  const trimmed = frac.slice(0, maxDecimals).replace(/0+$/, "");
  return trimmed ? `${int}.${trimmed}` : int;
}

// ── Token Detail ────────────────────────────────────────────────

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
            <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold">devnet</span>
          ) : /testnet|sepolia/i.test(chain.name) ? (
            <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-500 uppercase font-semibold">testnet</span>
          ) : null}
        </h3>
        <p className="text-[11px] text-text-muted mt-0.5">{chain.displayName}</p>
        <button
          onClick={() => setShowFullBalance(!showFullBalance)}
          className="text-2xl font-semibold tabular-nums text-text-primary mt-3 break-all cursor-pointer hover:text-text-secondary transition-colors"
        >
          {maskBalance(showFullBalance ? balance : truncateBalance(balance), balancesHidden)} <span className="text-text-tertiary text-base">{asset.symbol}</span>
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
      <div className="flex items-center justify-center gap-2 text-[11px] text-text-muted">
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

        <div className="bg-surface-secondary rounded-xl border border-border-primary overflow-hidden">
          {/* Pending transactions — always shown at top */}
          {transactions.filter((t) => !t.confirmed).length > 0 && (
            <div className="divide-y divide-border-secondary">
              {transactions.filter((t) => !t.confirmed).map((tx, i) => (
                <TxRow key={`pending-${tx.hash}-${i}`} tx={tx} explorerUrl={chain.explorerUrl} />
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
              <svg className="w-8 h-8 text-text-muted mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
              </svg>
              <p className="text-sm text-text-tertiary">No transactions yet</p>
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
                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
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
          onClose={() => setShowSend(false)}
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
