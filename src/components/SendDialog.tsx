import { useState, useEffect, useRef } from "react";
import type { Chain, Asset } from "../lib/api";
import { explorerLink, hexToBytes, bytesToHex } from "../shared/utils";
import { simulateEvmTransaction } from "../lib/txSimulation";
import { useExpertMode } from "../context/ExpertModeContext";
import { PolicyWarning, ExpertWarnings, SimulationPreview, SigningError } from "./tx";
import { fetchPrices, formatUsd, getUsdValue } from "../lib/prices";
import { toBase64, performMpcSign, clientKeys, restoreKeyHandles, clearClientKey } from "../lib/mpc";
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
  estimateGas,
  getTransactionCount,
  type UnsignedTx,
} from "../lib/chains/evmTx";
import { getChainAdapter } from "../lib/chains/adapter";
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
import {
  fetchUtxos as fetchLtcUtxos,
  fetchFeeRates as fetchLtcFeeRates,
  ltcApiUrl,
  buildLtcTransaction,
  detectAddressType as detectLtcAddressType,
  broadcastLtcTx,
  waitForLtcConfirmation,
  estimateFee as estimateLtcFee,
  formatLtcFee,
} from "../lib/chains/ltcTx";
import { base58 } from "@scure/base";
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
  xlmHashForSigning,
  assembleXlmSignedTx,
  getXlmAccountInfo,
  broadcastXlmTransaction,
  waitForXlmConfirmation,
} from "../lib/chains/xlmTx";
import type { KeyFile, FeeLevel, SendStep, SigningPhase, TxResult } from "./sendTypes";
import {
  FEE_LABELS,
  EVM_FEE_MULTIPLIER,
  GAS_LIMIT_NATIVE,
  GAS_LIMIT_ERC20,
  formatGwei,
  formatEthFee,
  isValidAmount,
  shortAddrPreview,
  getChainId,
  truncateBalance,
} from "./sendTypes";

export function SendDialog({
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
  const expert = useExpertMode();
  const [step, setStep] = useState<SendStep>("input");

  // Expert mode overrides
  const [nonceOverride, setNonceOverride] = useState("");
  const [gasLimitOverride, setGasLimitOverride] = useState("");
  const [maxFeeOverride, setMaxFeeOverride] = useState("");
  const [priorityFeeOverride, setPriorityFeeOverride] = useState("");
  const [btcFeeRateOverride, setBtcFeeRateOverride] = useState("");
  const [rbfEnabled, setRbfEnabled] = useState(true);

  // Estimated gas and nonce from node
  const [estimatedGas, setEstimatedGas] = useState<bigint | null>(null);
  const [gasEstimateError, setGasEstimateError] = useState<string | null>(null);
  const [currentNonce, setCurrentNonce] = useState<number | null>(null);
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
  // LTC-specific state
  const [ltcFeeRates, setLtcFeeRates] = useState<{ low: number; medium: number; high: number } | null>(null);
  // XLM-specific state (stroops per operation)
  const [xlmFeeRates, setXlmFeeRates] = useState<{ low: number; medium: number; high: number } | null>(null);
  const [xlmDestExists, setXlmDestExists] = useState<boolean | null>(null);
  const [xlmMemo, setXlmMemo] = useState("");
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

  // Policy pre-check
  const [policyCheck, setPolicyCheck] = useState<{
    allowed: boolean;
    reason?: string;
    fraudCheck?: { flagged: boolean; flags: string[]; level: string; address: string };
  } | null>(null);
  const [policyChecking, setPolicyChecking] = useState(false);

  // Transaction simulation
  const [simResult, setSimResult] = useState<import("../lib/txSimulation").SimulationResult | null>(null);

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

  // Clear deserialized key handles from memory when dialog closes or keyFile changes
  useEffect(() => {
    return () => { if (keyFile) clearClientKey(keyFile.id); };
  }, [keyFile?.id]);

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
      } else if (chain.type === "ltc") {
        const ltcApi = ltcApiUrl(chain.explorerUrl);
        fetchLtcFeeRates(ltcApi)
          .then((rates) => {
            setLtcFeeRates({
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

  // Fetch estimated gas and nonce for EVM chains
  useEffect(() => {
    if (chain.type !== "evm" || !chain.rpcUrl || !to || !amount) return;
    const adapter = getChainAdapter(chain.type);
    if (!adapter.isValidAddress(to)) return;

    // Nonce
    getTransactionCount(chain.rpcUrl, address).then(setCurrentNonce).catch(() => {});

    // Gas estimate
    const value = asset.isNative ? "0x" + parseUnits(amount, asset.decimals).toString(16) : "0x0";
    const data = !asset.isNative && asset.contractAddress
      ? "0x" + bytesToHex(encodeErc20Transfer(to, parseUnits(amount, asset.decimals)) as Uint8Array)
      : undefined;
    const txTo = !asset.isNative && asset.contractAddress ? asset.contractAddress : to;
    setGasEstimateError(null);
    estimateGas(chain.rpcUrl, { from: address, to: txTo, value, data })
      .then((gas) => { setEstimatedGas(gas); setGasEstimateError(null); })
      .catch((err) => { setEstimatedGas(null); setGasEstimateError(err?.message || "Gas estimation failed — transaction may revert"); });
  }, [chain.type, chain.rpcUrl, address, to, amount, asset]);

  // Effective fee values based on selected level + expert overrides
  const gasPrice = maxFeeOverride && /^\d+(\.\d+)?$/.test(maxFeeOverride)
    ? BigInt(Math.round(parseFloat(maxFeeOverride) * 1e9))
    : baseGasPrice != null
      ? BigInt(Math.round(Number(baseGasPrice) * EVM_FEE_MULTIPLIER[feeLevel]))
      : null;
  const effectiveBtcFeeRate = btcFeeRateOverride && /^\d+/.test(btcFeeRateOverride)
    ? parseInt(btcFeeRateOverride)
    : btcFeeRates?.[feeLevel] ?? null;
  const btcFeeRate = effectiveBtcFeeRate;
  const btcEstimatedFee = btcFeeRate != null ? estimateBtcFee(1, btcFeeRate, true, detectAddressType(address)) : null;
  const effectiveLtcFeeRate = btcFeeRateOverride && /^\d+/.test(btcFeeRateOverride)
    ? parseInt(btcFeeRateOverride)
    : ltcFeeRates?.[feeLevel] ?? null;
  const ltcFeeRate = effectiveLtcFeeRate;
  const ltcEstimatedFee = ltcFeeRate != null ? estimateLtcFee(1, ltcFeeRate, true, detectLtcAddressType(address)) : null;
  const effectiveBchFeeRate = btcFeeRateOverride && /^\d+/.test(btcFeeRateOverride)
    ? parseInt(btcFeeRateOverride)
    : bchFeeRates?.[feeLevel] ?? null;
  const bchFeeRate = effectiveBchFeeRate;
  const bchEstimatedFee = bchFeeRate != null ? estimateBchFee(1, bchFeeRate, true) : null;

  const defaultGasLimit = estimatedGas ?? (asset.isNative ? GAS_LIMIT_NATIVE : GAS_LIMIT_ERC20);
  const gasLimit = gasLimitOverride && /^\d+$/.test(gasLimitOverride)
    ? BigInt(gasLimitOverride)
    : defaultGasLimit;
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
    if (chain.type === "ltc") {
      return {
        formatted: ltcEstimatedFee != null ? formatLtcFee(ltcEstimatedFee) : null,
        symbol: "LTC",
        usd: ltcEstimatedFee != null ? getUsdValue(String(Number(ltcEstimatedFee) / 1e8), "LTC", prices) : null,
        rateLabel: ltcFeeRate != null ? `${ltcFeeRate} sat/vB` : null,
        hasLevelSelector: true,
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
    } else if (chain.type === "ltc" && ltcEstimatedFee != null) {
      feeBaseUnits = BigInt(ltcEstimatedFee);
    } else if (chain.type === "xlm" && xlmFeeRates != null) {
      feeBaseUnits = BigInt(xlmFeeRates[feeLevel]);
    }
    if (feeBaseUnits == null) return balance;
    // Convert human balance to base units via BigInt (strip thousands separators first)
    const [intPart, fracPart = ""] = balance.replace(/,/g, "").split(".");
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

  const ADDR_PLACEHOLDER: Record<string, string> = { btc: "bc1q...", ltc: "ltc1q...", bch: "bitcoincash:q...", solana: "So1ana...", evm: "0x" + "0".repeat(40), xrp: "r..." };
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
          gasLimit: gasLimit, chainId, gasPrice: gasPrice ?? undefined,
        });
      } else {
        const calldata = encodeErc20Transfer(to, amountWei);
        unsignedTx = await buildTransaction({
          rpcUrl: chain.rpcUrl, from: address, to: asset.contractAddress!,
          value: 0n, data: calldata, gasLimit: gasLimit, chainId,
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
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");

    } catch (err: any) {
      console.error("[send] Error:", err);
      setSigningError(err.message || String(err));
    } finally {
      clearClientKey(keyFile.id);
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
      const btcTx = buildBtcTransaction(to, amountSats, utxos, btcFeeRate, address, addrType, rbfEnabled);
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
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");

    } catch (err: any) {
      console.error("[send] BTC Error:", err);
      setSigningError(err.message || String(err));
    } finally {
      clearClientKey(keyFile.id);
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
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");

    } catch (err: any) {
      console.error("[send] BCH Error:", err);
      setSigningError(err.message || String(err));
    } finally {
      clearClientKey(keyFile.id);
    }
  }

  // ── LTC signing flow ──────────────────────────────────────────
  async function executeLtcSigningFlow() {
    if (!keyFile || !ltcFeeRate) return;

    setStep("signing");
    setSigningPhase("building-tx");
    setSigningError(null);

    const ltcApi = ltcApiUrl(chain.explorerUrl);
    try {
      if (!clientKeys.has(keyFile.id)) {
        await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
      }

      // 1. Fetch UTXOs and build transaction
      const utxos = await fetchLtcUtxos(address, ltcApi);
      const amountSats = parseUnits(amount, asset.decimals);
      const addrType = detectLtcAddressType(address);
      const ltcTx = buildLtcTransaction(to, amountSats, utxos, ltcFeeRate, address, addrType, rbfEnabled);

      // 2. Get compressed public key and hash
      setSigningPhase("mpc-signing");
      const pubKeyRaw = hexToBytes(keyFile.publicKey);
      const compressedPubKey = getCompressedPublicKey(
        Array.from(pubKeyRaw).map((b) => b.toString(16).padStart(2, "0")).join("")
      );
      const pkHash = pubKeyHash(compressedPubKey);
      const isLegacy = addrType === "p2pkh";

      // LTC tx payload for server-side verification
      const ltcTxPayload = {
        version: ltcTx.version,
        inputs: ltcTx.inputs.map((inp) => ({
          txid: inp.txid, vout: inp.vout, value: inp.value.toString(), sequence: inp.sequence,
        })),
        outputs: ltcTx.outputs.map((out) => ({
          value: out.value.toString(), scriptPubKey: bytesToHex(out.scriptPubKey),
        })),
        locktime: ltcTx.locktime,
      };

      // 3. Sign each input via MPC
      const witnesses: Uint8Array[][] = [];
      const scriptSigs: Uint8Array[] = [];

      for (let i = 0; i < ltcTx.inputs.length; i++) {
        const sighash = isLegacy ? legacySighash(ltcTx, i, pkHash) : bip143Sighash(ltcTx, i, pkHash);

        const { signature: sigRaw } = await performMpcSign({
          algorithm: "ecdsa",
          keyId: keyFile.id,
          hash: sighash,
          initPayload: {
            id: keyFile.id, chainType: "ltc", ltcTx: ltcTxPayload,
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
        rawHex = bytesToHex(serializeLegacyTx(ltcTx, scriptSigs));
        txid = computeLegacyTxid(ltcTx, scriptSigs);
      } else {
        rawHex = bytesToHex(serializeWitnessTx(ltcTx, witnesses));
        txid = computeTxid(ltcTx);
      }

      // 5. Broadcast
      setSigningPhase("broadcasting");
      const broadcastTxid = await broadcastLtcTx(rawHex, ltcApi);

      fetch(apiUrl("/api/sign/broadcast"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ keyShareId: keyFile.id, txHash: broadcastTxid || txid, chainId: chain.id }),
      }).catch(() => {});

      onTxSubmitted?.(broadcastTxid || txid, to, amount);

      // 6. Wait for confirmation
      setPendingTxHash(broadcastTxid || txid);
      setSigningPhase("polling");
      const result = await waitForLtcConfirmation(broadcastTxid || txid, () => {}, 60, 5000, ltcApi);

      setTxResult({
        status: result.confirmed ? "success" : "pending",
        txHash: broadcastTxid || txid,
        blockNumber: result.blockHeight,
      });
      if (result.confirmed) onTxConfirmed?.(broadcastTxid || txid);
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");

    } catch (err: any) {
      console.error("[send] LTC Error:", err);
      setSigningError(err.message || String(err));
    } finally {
      clearClientKey(keyFile.id);
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
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");

    } catch (err: any) {
      console.error("[send] Solana Error:", err);
      setSigningError(err.message || String(err));
    } finally {
      clearClientKey(keyFile.id);
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
      const amountDrops = BigInt(Math.round(parseFloat(amount.replace(/,/g, "")) * 1e6));

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
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");

    } catch (err: any) {
      console.error("[send] XRP Error:", err);
      setSigningError(err.message || String(err));
    } finally {
      clearClientKey(keyFile.id);
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
      const amountStroops = BigInt(Math.round(parseFloat(amount.replace(/,/g, "")) * 1e7));
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
            memo: xlmMemo || undefined,
          })
        : buildXlmCreateAccountXdr({
            from: fromAddress, to, amountStroops, feeStroops,
            sequence: sequence + 1n,
            memo: xlmMemo || undefined,
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
            ...(xlmMemo ? { memo: xlmMemo } : {}),
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
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");

    } catch (err: any) {
      console.error("[send] XLM Error:", err);
      setSigningError(err.message || String(err));
    } finally {
      clearClientKey(keyFile.id);
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
    || (step === "signing" && (signingPhase === "broadcasting" || signingPhase === "polling"))
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
                  <div className="mt-2 rounded-lg overflow-hidden border border-border-primary">
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

              {/* Memo (XLM only) */}
              {chain.type === "xlm" && (
              <div>
                <label className="block text-xs text-text-muted mb-1.5">Memo <span className="text-text-muted/50">(optional, max 28 chars)</span></label>
                <input
                  type="text"
                  value={xlmMemo}
                  onChange={(e) => setXlmMemo(e.target.value.slice(0, 28))}
                  placeholder="e.g. exchange deposit ID"
                  className="w-full bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-blue-500"
                />
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
                <div className="flex items-center justify-end mt-1">
                  {amountError ? (
                    <p className="text-[10px] text-red-400">{amountError}</p>
                  ) : amountUsd != null ? (
                    <p className="text-[10px] text-text-muted tabular-nums">{formatUsd(amountUsd)}</p>
                  ) : null}
                </div>
              </div>

              {/* Fee level selector (not shown for fixed-fee chains) */}
              {feeDisplay.hasLevelSelector && (
              <div className="bg-surface-primary border border-border-primary rounded-lg p-1.5">
                <div className="grid grid-cols-3 gap-1">
                  {(["low", "medium", "high"] as FeeLevel[]).map((level) => {
                    const isActive = feeLevel === level;
                    const feeText = chain.type === "btc" || chain.type === "ltc"
                      ? ((chain.type === "btc" ? btcFeeRates : ltcFeeRates)?.[level] != null ? `${(chain.type === "btc" ? btcFeeRates : ltcFeeRates)![level]} sat/vB` : "...")
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

              {/* Expert mode: advanced tx overrides */}
              {expert && chain.type === "evm" && (
                <div className="space-y-2">
                  <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">Advanced</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Nonce</label>
                      <input
                        value={nonceOverride}
                        onChange={(e) => setNonceOverride(e.target.value)}
                        placeholder={currentNonce != null ? currentNonce.toString() : "..."}
                        className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Gas limit</label>
                      <input
                        value={gasLimitOverride}
                        onChange={(e) => setGasLimitOverride(e.target.value)}
                        placeholder={defaultGasLimit.toString()}
                        className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Max fee (Gwei)</label>
                      <input
                        value={maxFeeOverride}
                        onChange={(e) => setMaxFeeOverride(e.target.value)}
                        placeholder={gasPrice != null ? formatGwei(gasPrice) : "Auto"}
                        className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Priority fee (Gwei)</label>
                      <input
                        value={priorityFeeOverride}
                        onChange={(e) => setPriorityFeeOverride(e.target.value)}
                        placeholder={baseGasPrice != null ? formatGwei(baseGasPrice / 10n) : "Auto"}
                        className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                      />
                    </div>
                  </div>
                </div>
              )}

              {expert && (chain.type === "btc" || chain.type === "ltc" || chain.type === "bch") && (
                <div className="space-y-2">
                  <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">Advanced</p>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Fee rate (sat/vB)</label>
                    <input
                      value={btcFeeRateOverride}
                      onChange={(e) => setBtcFeeRateOverride(e.target.value)}
                      placeholder={chain.type === "btc" ? (btcFeeRates?.[feeLevel]?.toString() ?? "Auto") : chain.type === "ltc" ? (ltcFeeRates?.[feeLevel]?.toString() ?? "Auto") : (bchFeeRates?.[feeLevel]?.toString() ?? "Auto")}
                      className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                    />
                  </div>
                  {(chain.type === "btc" || chain.type === "ltc") && (
                    <button
                      type="button"
                      onClick={() => setRbfEnabled((v) => !v)}
                      className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg bg-surface-primary border border-border-primary hover:border-border-secondary transition-colors"
                    >
                      <div className={`w-7 h-4 rounded-full transition-colors relative ${rbfEnabled ? "bg-blue-500" : "bg-surface-tertiary"}`}>
                        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${rbfEnabled ? "left-3.5" : "left-0.5"}`} />
                      </div>
                      <span className="text-xs text-text-secondary">RBF (Replace-By-Fee)</span>
                    </button>
                  )}
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
                disabled={!canReview || policyChecking}
                onClick={async () => {
                  if (chain.type === "xlm" && chain.rpcUrl) {
                    setXlmDestExists(null);
                    const exists = await checkXlmAccountExists(chain.rpcUrl, to);
                    setXlmDestExists(exists);
                  }
                  // Policy pre-check (skip in recovery mode — no server)
                  if (!isRecoveryMode()) {
                    setPolicyChecking(true);
                    setPolicyCheck(null);
                    try {
                      const baseUnits = parseUnits(amount, asset.decimals).toString();
                      const res = await fetch(apiUrl(`/api/keys/${keyId}/rules/check`), {
                        method: "POST",
                        headers: { ...authHeaders(), "Content-Type": "application/json" },
                        body: JSON.stringify({
                          to,
                          amount: baseUnits,
                          nativeSymbol: asset.isNative ? asset.symbol : undefined,
                          contractAddress: asset.contractAddress || undefined,
                          chainId: chain.evmChainId ?? undefined,
                        }),
                      });
                      if (res.ok) {
                        const result = await res.json();
                        setPolicyCheck(result);
                      }
                    } catch {
                      // Fail-open: if pre-check fails, still show preview
                    }
                    setPolicyChecking(false);
                  }
                  // EVM transaction simulation (non-blocking)
                  if (chain.type === "evm" && chain.rpcUrl) {
                    setSimResult(null);
                    const value = asset.isNative ? "0x" + parseUnits(amount, asset.decimals).toString(16) : "0x0";
                    const dataBytes = !asset.isNative && asset.contractAddress
                      ? encodeErc20Transfer(to, parseUnits(amount, asset.decimals))
                      : null;
                    const data = dataBytes ? "0x" + bytesToHex(dataBytes as Uint8Array) : "0x";
                    const txTo = !asset.isNative && asset.contractAddress ? asset.contractAddress : to;
                    simulateEvmTransaction(chain.rpcUrl, { from: address, to: txTo, value, data }).then((r) => {
                      if (r) setSimResult(r);
                    });
                  }
                  setStep("preview");
                }}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                {policyChecking ? "Checking..." : "👀 Review Transaction"}
              </button>
            </div>
          </>
        )}

        {step === "preview" && (
          <>
            {/* Body — Preview step */}
            <div className="p-5 space-y-5">
              <PolicyWarning policyCheck={policyCheck} />

              {chain.type === "evm" && gasEstimateError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  <p className="text-xs text-red-400 leading-relaxed">
                    Gas estimation failed: {gasEstimateError}. This transaction is likely to revert.
                  </p>
                </div>
              )}

              {/* Amount hero */}
              <div className="text-center py-2">
                <p className="text-2xl font-semibold tabular-nums text-text-primary">
                  {amount} <span className="text-text-tertiary text-sm">{asset.symbol}</span>
                </p>
                {amountUsd != null && (
                  <p className="text-sm text-text-muted tabular-nums mt-0.5">{formatUsd(amountUsd)}</p>
                )}
              </div>

              {/* From → To */}
              <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
                <div className="px-3 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-text-muted">From</span>
                  <span className={`${expert ? "text-[9px]" : "text-xs"} font-mono text-text-secondary`}>{expert ? address : shortAddrPreview(address)}</span>
                </div>
                <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-text-muted">To</span>
                    {!asset.isNative && asset.contractAddress && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 font-medium">Contract</span>
                    )}
                  </div>
                  <span className={`${expert ? "text-[9px]" : "text-xs"} font-mono text-text-secondary`}>
                    {!asset.isNative && asset.contractAddress
                      ? (expert ? asset.contractAddress : shortAddrPreview(asset.contractAddress))
                      : (expert ? to : shortAddrPreview(to))}
                  </span>
                </div>
                {!asset.isNative && asset.contractAddress && expert && (
                  <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                    <span className="text-xs text-text-muted">Recipient</span>
                    <span className="text-[9px] font-mono text-text-secondary">{to}</span>
                  </div>
                )}
                {!asset.isNative && asset.contractAddress && (
                  <div className="border-t border-border-secondary px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-muted">Data</span>
                      <span className={`text-xs font-mono text-text-muted ${expert ? "" : "truncate max-w-[200px]"}`}>
                        {expert
                          ? null
                          : (() => { const d = "0x" + bytesToHex(encodeErc20Transfer(to, parseUnits(amount, asset.decimals)) as Uint8Array); return d.length > 20 ? d.slice(0, 20) + "..." : d; })()
                        }
                      </span>
                    </div>
                    {expert && (
                      <pre className="text-[10px] font-mono text-text-muted break-all mt-1 leading-relaxed max-h-20 overflow-auto">
                        {"0x" + bytesToHex(encodeErc20Transfer(to, parseUnits(amount, asset.decimals)) as Uint8Array)}
                      </pre>
                    )}
                  </div>
                )}
                {destinationTag && (
                <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-text-muted">Destination Tag</span>
                  <span className="text-xs tabular-nums text-text-secondary">{destinationTag}</span>
                </div>
                )}
                {chain.type === "xlm" && xlmMemo && (
                <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-text-muted">Memo</span>
                  <span className="text-xs text-text-secondary">{xlmMemo}</span>
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
                  <span className="text-xs tabular-nums text-text-secondary font-medium">
                    {(feeDisplay.formatted ?? "—") + " " + feeDisplay.symbol}
                  </span>
                </div>
                {feeDisplay.rateLabel != null && (
                  <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                    <span className="text-xs text-text-muted">{chain.type === "btc" || chain.type === "ltc" || chain.type === "bch" ? "Fee rate" : chain.type === "xlm" ? "Base fee" : "Gas price"}</span>
                    <span className="text-xs tabular-nums text-text-muted">{feeDisplay.rateLabel}</span>
                  </div>
                )}
                {chain.type === "evm" && (
                  <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                    <span className="text-xs text-text-muted">Gas limit</span>
                    <span className="text-xs tabular-nums text-text-muted">{gasLimit.toLocaleString()}</span>
                  </div>
                )}
                {(chain.type === "btc" || chain.type === "ltc") && (
                  <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                    <span className="text-xs text-text-muted">RBF</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${rbfEnabled ? "bg-blue-500/10 text-blue-400" : "bg-surface-tertiary text-text-muted"}`}>
                      {rbfEnabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                )}
                <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-text-muted font-medium">Total cost</span>
                  <span className="text-xs tabular-nums text-text-primary font-semibold">
                    {totalUsd > 0 ? formatUsd(totalUsd) : "—"}
                  </span>
                </div>
              </div>

              {/* Expert warnings */}
              {expert && chain.type === "evm" && (
                <ExpertWarnings
                  gasLimitOverride={gasLimitOverride}
                  maxFeeOverride={maxFeeOverride}
                  estimatedGas={estimatedGas}
                  baseGasPrice={baseGasPrice}
                  lowMultiplier={EVM_FEE_MULTIPLIER.low}
                />
              )}


              {/* Balance changes — simulation or static fallback */}
              {simResult && simResult.changes.length > 0 ? (
                <SimulationPreview simResult={simResult} prices={prices} />
              ) : (() => {
                const changes: BalanceChange[] = [];
                const amountBase = amount ? parseUnits(amount, asset.decimals) : 0n;
                const balanceBase = parseUnits(balance, asset.decimals);

                if (asset.isNative) {
                  let feeCost = 0n;
                  if (chain.type === "evm" && estimatedFeeWei != null) feeCost = estimatedFeeWei;
                  else if (chain.type === "solana") feeCost = SOLANA_BASE_FEE;
                  else if (chain.type === "xrp") feeCost = XRP_BASE_FEE;
                  else if (chain.type === "btc" && btcEstimatedFee != null) feeCost = BigInt(btcEstimatedFee);
                  else if (chain.type === "ltc" && ltcEstimatedFee != null) feeCost = BigInt(ltcEstimatedFee);
                  else if (chain.type === "bch" && bchEstimatedFee != null) feeCost = bchEstimatedFee;
                  changes.push({
                    symbol: asset.symbol,
                    decimals: asset.decimals,
                    currentBalance: balanceBase.toString(),
                    delta: -(amountBase + feeCost),
                  });
                } else {
                  changes.push({
                    symbol: asset.symbol,
                    decimals: asset.decimals,
                    currentBalance: balanceBase.toString(),
                    delta: -amountBase,
                  });
                }

                return <BalancePreview changes={changes} prices={prices} />;
              })()}
            </div>

            {/* Footer — Preview step */}
            <div className="px-5 py-4 border-t border-border-secondary">
              <button
                disabled={policyCheck?.allowed === false}
                onClick={() => {
                  const flows: Record<string, () => void> = { solana: executeSolanaSigningFlow, btc: executeBtcSigningFlow, ltc: executeLtcSigningFlow, bch: executeBchSigningFlow, evm: executeSigningFlow, xrp: executeXrpSigningFlow, xlm: executeXlmSigningFlow };
                  const flow = flows[chain.type];
                  if (flow) guardedSign(flow);
                  else setSigningError(`Send is not yet supported for ${chain.displayName}.`);
                }}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                {policyCheck?.allowed === false ? "\u26D4 Blocked by Policy" : "\uD83D\uDD10 Confirm & Sign"}
              </button>
            </div>
          </>
        )}

        {step === "signing" && (
          <div className="p-5">
            {signingError ? (
              <SigningError
                error={signingError}
                onClose={onClose}
                onRetry={() => { setSigningError(null); setStep("preview"); }}
              />
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
