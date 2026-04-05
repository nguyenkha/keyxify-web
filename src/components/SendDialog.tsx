import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Chain, Asset } from "../lib/api";
import { explorerLink, bytesToHex } from "../shared/utils";
import { simulateEvmTransaction } from "../lib/txSimulation";
import { useExpertMode } from "../context/ExpertModeContext";
import { SigningError, SigningStepper } from "./tx";
import { fetchPrices, getUsdValue } from "../lib/prices";
import { clearClientKey } from "../lib/mpc";
import { authHeaders, isStandaloneJwt } from "../lib/auth";
import { apiUrl } from "../lib/apiBase";
import { fetchPasskeys, isWithinPasskeyGrace } from "../lib/passkey";
import { PasskeyGate } from "./PasskeyGate";
import { PasskeyChallenge } from "./PasskeyChallenge";
import {
  encodeErc20Transfer,
  parseUnits,
  estimateGas,
  getTransactionCount,
} from "../lib/chains/evmTx";
import { getChainAdapter } from "../lib/chains/adapter";
import {
  fetchFeeRates,
  mempoolApiUrl,
  type UTXO,
  detectAddressType,
  estimateFee as estimateBtcFee,
} from "../lib/chains/btcTx";
import {
  fetchFeeRates as fetchBchFeeRates,
  estimateFee as estimateBchFee,
} from "../lib/chains/bchTx";
import {
  fetchFeeRates as fetchLtcFeeRates,
  ltcApiUrl,
  detectAddressType as detectLtcAddressType,
  estimateFee as estimateLtcFee,
} from "../lib/chains/ltcTx";
import { isEncryptedKeyFile, type KeyFileData } from "../lib/crypto";
import {
  hasKeyShare as hasStoredKeyShare,
  getKeyShareMode,
  getKeyShareWithPrf,
} from "../lib/keystore";
import { useHideBalances } from "../context/HideBalancesContext";
import { authenticatePasskey } from "../lib/passkey";
import { isRecoveryMode, getRecoveryKeyFile } from "../lib/recovery";
import { getPreference } from "../lib/userOverrides";
import { getIdentityId } from "../lib/auth";
import { addRecentRecipient } from "../lib/addressBook";
import { resolveName, isResolvableName } from "../lib/nameResolution";
import { checkXlmAccountExists } from "../lib/chains/xlmTx";
import type { KeyFile, FeeLevel, SendStep, SigningPhase, TxResult, SpeedUpData } from "./sendTypes";
import { useSteppedProgress, signingDurationMs, ProgressBar } from "./ProgressBar";
import {
  EVM_FEE_MULTIPLIER,
  GAS_LIMIT_NATIVE,
  GAS_LIMIT_ERC20,
  isValidAmount,
  shortAddrPreview,
} from "./sendTypes";
import {
  executeSigningFlow,
  executeBtcSigningFlow,
  executeBchSigningFlow,
  executeLtcSigningFlow,
  executeSolanaSigningFlow,
  executeXrpSigningFlow,
  executeXlmSigningFlow,
  executeTronSigningFlow,
  executeTonSigningFlow,
  executeAlgoSigningFlow,
  executeAdaSigningFlow,
  handleFetchUtxos,
  type SigningContext,
  type UtxoFetchContext,
} from "./send/signing-flows";
import { InputStep } from "./send/InputStep";
import { PreviewStep } from "./send/PreviewStep";
import { ResultStep } from "./send/ResultStep";
import { computeFeeDisplay, computeMaxSendable } from "./send/fee-helpers";

export function SendDialog({
  keyId,
  asset,
  chain,
  address,
  balance,
  onClose,
  onTxSubmitted,
  onTxConfirmed,
  speedUpData,
}: {
  keyId: string;
  asset: Asset;
  chain: Chain;
  address: string;
  balance: string;
  onClose: () => void;
  onTxSubmitted?: (txHash: string, toAddr: string, amount: string) => void;
  onTxConfirmed?: (txHash: string) => void;
  speedUpData?: SpeedUpData;
}) {
  const { t } = useTranslation();
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
  // getPreference returns default (false) when expert_mode is off
  const confirmBeforeBroadcast = expert && !!getPreference("confirm_before_broadcast", getIdentityId() ?? undefined);

  // UTXO manual selection (expert mode)
  const [showUtxoPicker, setShowUtxoPicker] = useState(false);
  const [availableUtxos, setAvailableUtxos] = useState<UTXO[] | null>(null);
  const [selectedUtxoKeys, setSelectedUtxoKeys] = useState<Set<string>>(new Set());
  const [utxoLoading, setUtxoLoading] = useState(false);

  // Estimated gas and nonce from node
  const [estimatedGas, setEstimatedGas] = useState<bigint | null>(null);
  const [gasEstimateError, setGasEstimateError] = useState<string | null>(null);
  const [currentNonce, setCurrentNonce] = useState<number | null>(null);
  const [to, setTo] = useState(speedUpData?.to ?? "");
  const [amount, setAmount] = useState(speedUpData ? (Number(speedUpData.amountSats) / 10 ** asset.decimals).toString() : "");
  const [toTouched, setToTouched] = useState(false);
  const [amountTouched, setAmountTouched] = useState(false);
  const [showAddrScanner, setShowAddrScanner] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [savingToBook, setSavingToBook] = useState(false);
  const [bookmarkLabel, setBookmarkLabel] = useState("");
  const [resolvedName, setResolvedName] = useState<{ input: string; address: string; source: string } | null>(null);
  const [resolving, setResolving] = useState(false);
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

  // Backup status — gate large sends (>$100) on backup completion
  // Standalone mode: skip gate (escrow backup is impossible — can't re-auth without key share)
  const [hasBackup, setHasBackup] = useState<boolean | null>(isStandaloneJwt() ? true : null);
  const [backupGateError, setBackupGateError] = useState<string | null>(null);
  useEffect(() => {
    if (isStandaloneJwt()) return; // standalone: always treat as backed up
    fetch(apiUrl("/api/keys"), { headers: authHeaders() })
      .then((r) => r.json())
      .then(({ keys }) => {
        const key = (keys || []).find((k: { id: string }) => k.id === keyId);
        setHasBackup(key?.hasClientBackup ?? false);
      })
      .catch(() => setHasBackup(null)); // fail-open
  }, [keyId]);

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
  const [signedRawTx, setSignedRawTx] = useState<string | null>(null);
  const [signatureCount, setSignatureCount] = useState(1);

  // Passkey guard (triggered on confirm, not on dialog open)
  const [passkeyGuard, setPasskeyGuard] = useState<"idle" | "gate" | "challenge">("idle");
  const pendingSignRef = useRef<(() => void) | null>(null);

  async function guardedSign(action: () => void) {
    // In recovery mode, skip passkey entirely — no server to verify
    if (isRecoveryMode()) {
      action();
      return;
    }
    // Skip re-challenge if passkey was verified recently (grace period)
    if (isWithinPasskeyGrace()) {
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

  function onPasskeyComplete(_result?: unknown) {
    setPasskeyGuard("idle");
    pendingSignRef.current?.();
    pendingSignRef.current = null;
  }

  // Name resolution (ENS, Unstoppable Domains) with debounce
  useEffect(() => {
    if (!to || !isResolvableName(to)) {
      if (resolvedName && resolvedName.input !== to) setResolvedName(null);
      setResolving(false);
      return;
    }
    if (resolvedName?.input === to) return; // already resolved
    setResolving(true);
    const timer = setTimeout(async () => {
      const result = await resolveName(to, chain.type, chain.rpcUrl);
      if (result) {
        setResolvedName({ input: to, address: result.address, source: result.source });
      } else {
        setResolvedName(null);
      }
      setResolving(false);
    }, 500);
    return () => { clearTimeout(timer); setResolving(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, chain.type, chain.rpcUrl]);

  // The actual address to send to (resolved name address or raw input)
  const effectiveTo = resolvedName?.input === to ? resolvedName.address : to;

  // Track successful sends as recent recipients
  useEffect(() => {
    if (txResult && (txResult.status === "success" || txResult.status === "pending") && to) {
      addRecentRecipient(to, chain.type, asset.symbol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txResult?.status]);

  // Pre-fill form for RBF speed-up — intentionally runs once on mount
  useEffect(() => {
    if (!speedUpData) return;
    const utxos: UTXO[] = speedUpData.utxos.map(u => ({
      txid: u.txid, vout: u.vout, value: u.value,
      status: { confirmed: true },
    }));
    setAvailableUtxos(utxos);
    setSelectedUtxoKeys(new Set(utxos.map(u => `${u.txid}:${u.vout}`)));
    setBtcFeeRateOverride(String(speedUpData.minFeeRate));
    setRbfEnabled(true);
    setFeeLevel("high");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          setBrowserShareError(t("send.couldNotDecryptWrongPasskey"));
        } else {
          setBrowserShareError(t("send.passkeyNoEncryption"));
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
  const manualUtxos = selectedUtxoKeys.size > 0 && availableUtxos
    ? availableUtxos.filter(u => selectedUtxoKeys.has(`${u.txid}:${u.vout}`))
    : null;
  const utxoInputCount = manualUtxos?.length || 1;
  const effectiveBtcFeeRate = btcFeeRateOverride && /^\d+/.test(btcFeeRateOverride)
    ? parseInt(btcFeeRateOverride)
    : btcFeeRates?.[feeLevel] ?? null;
  const btcFeeRate = effectiveBtcFeeRate;
  const btcEstimatedFee = btcFeeRate != null ? estimateBtcFee(utxoInputCount, btcFeeRate, true, detectAddressType(address)) : null;
  const effectiveLtcFeeRate = btcFeeRateOverride && /^\d+/.test(btcFeeRateOverride)
    ? parseInt(btcFeeRateOverride)
    : ltcFeeRates?.[feeLevel] ?? null;
  const ltcFeeRate = effectiveLtcFeeRate;
  const ltcEstimatedFee = ltcFeeRate != null ? estimateLtcFee(utxoInputCount, ltcFeeRate, true, detectLtcAddressType(address)) : null;
  const effectiveBchFeeRate = btcFeeRateOverride && /^\d+/.test(btcFeeRateOverride)
    ? parseInt(btcFeeRateOverride)
    : bchFeeRates?.[feeLevel] ?? null;
  const bchFeeRate = effectiveBchFeeRate;
  const bchEstimatedFee = bchFeeRate != null ? estimateBchFee(utxoInputCount, bchFeeRate, true) : null;

  const defaultGasLimit = estimatedGas ?? (asset.isNative ? GAS_LIMIT_NATIVE : GAS_LIMIT_ERC20);
  const gasLimit = gasLimitOverride && /^\d+$/.test(gasLimitOverride)
    ? BigInt(gasLimitOverride)
    : defaultGasLimit;
  const estimatedFeeWei = gasPrice != null ? gasPrice * gasLimit : null;

  // Unified fee display
  const feeDisplay = computeFeeDisplay({
    chain, asset, feeLevel, prices,
    estimatedFeeWei, gasPrice,
    btcEstimatedFee, btcFeeRate,
    ltcEstimatedFee, ltcFeeRate,
    bchEstimatedFee, bchFeeRate,
    xlmFeeRates,
  });

  // Validation — use resolved address if name was resolved, otherwise raw input
  const adapter = getChainAdapter(chain.type);
  const toAddr = effectiveTo; // resolved name address or raw input
  const toValid = toAddr.length > 0 && adapter.isValidAddress(toAddr);
  const isNameInput = isResolvableName(to);
  const toError = toTouched && to.length > 0 && !toValid && !resolving && !isNameInput ? t("send.invalidAddress") : null;
  const toSelf = toValid && (chain.type === "solana" ? toAddr === address : toAddr.toLowerCase() === address.toLowerCase());
  const amountCheck = isValidAmount(amount, balance);
  const amountError = amountTouched && amount.length > 0 && !amountCheck.valid ? amountCheck.error : null;
  const amountUsd = amount ? getUsdValue(amount, asset.symbol, prices) : null;

  const destTagValid = chain.type !== "xrp" || destinationTag === "" || (/^\d+$/.test(destinationTag) && Number(destinationTag) <= 4294967295);
  const canReview = toValid && !toSelf && amountCheck.valid && keyFile != null && destTagValid;

  // Max sendable: for native tokens, subtract estimated fee from balance
  const maxSendable = computeMaxSendable({
    chain, asset, balance, feeLevel,
    estimatedFeeWei,
    btcEstimatedFee,
    ltcEstimatedFee,
    xlmFeeRates,
  });

  const ADDR_PLACEHOLDER: Record<string, string> = { btc: "bc1q...", ltc: "ltc1q...", bch: "bitcoincash:q...", solana: "So1ana...", evm: "0x" + "0".repeat(40), xrp: "r...", tron: "T..." };
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

  // Build signing context for delegating to signing-flows module
  function buildSigningCtx(): SigningContext {
    return {
      keyFile: keyFile!,
      chain,
      asset,
      address,
      to: effectiveTo,
      amount,
      onTxSubmitted,
      onTxConfirmed,
      gasPrice,
      gasLimit,
      confirmBeforeBroadcast,
      rbfEnabled,
      btcFeeRate,
      bchFeeRate,
      ltcFeeRate,
      manualUtxos,
      destinationTag,
      xlmMemo,
      xlmFeeRates,
      feeLevel,
      setStep,
      setSigningPhase,
      setSignatureCount,
      setSigningError,
      setSignedRawTx,
      setTxResult,
      setPendingTxHash,
      setKeyFile,
      setPendingEncrypted,
      t,
    };
  }

  function buildUtxoFetchCtx(): UtxoFetchContext {
    return { chain, address, setAvailableUtxos, setUtxoLoading };
  }

  // Map internal phases to 4 display steps: Build (0) → Sign (1) → Broadcast (2) → Confirming (3)
  const phaseIndex: Record<SigningPhase, number> = {
    "loading-keyshare": 0,
    "building-tx": 0,
    "mpc-signing": 1,
    "broadcasting": 2,
    "polling": 3,
  };

  // Stepped progress: 90% for MPC signing, 10% split across other steps (1s each)
  const stepsAfterMain = (confirmBeforeBroadcast && signingPhase !== "broadcasting" && signingPhase !== "polling") ? 0 : 2;
  const progress = useSteppedProgress(
    step === "signing" ? phaseIndex[signingPhase] : -1,
    1, // main step = MPC signing (index 1)
    stepsAfterMain,
    signingDurationMs(signatureCount),
    false,
  );

  const recovery = isRecoveryMode();
  const signLabel = recovery ? t("send.localSigning") : t("send.mpcSigning");
  // Show smooth percentage only during the main MPC signing step
  const signLabelActive = progress.phase === "main"
    ? `${signLabel} ${progress.pct}%`
    : signLabel;
  const phaseLabels: Record<SigningPhase, string> = {
    "loading-keyshare": t("send.buildTx"),
    "building-tx": t("send.buildTx"),
    "mpc-signing": signLabelActive,
    "broadcasting": t("send.broadcasting"),
    "polling": t("send.confirming"),
  };

  const isCompact = step === "signing" || step === "result";
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
    <div className={`fixed inset-0 z-50 ${isCompact ? "flex items-center justify-center p-4 bg-black/50" : "bg-surface-secondary overflow-y-auto md:bg-transparent md:overflow-hidden md:flex md:items-center md:justify-center md:p-4"}`}>
      {/* Backdrop */}
      {!isCompact && <div className="hidden md:block absolute inset-0 bg-black/50" onClick={canClose ? onClose : undefined} />}
      {isCompact && <div className="absolute inset-0" onClick={canClose ? onClose : undefined} />}

      {/* Dialog — compact popup for signing/result, full-screen for input/preview */}
      <div className={`relative bg-surface-secondary ${isCompact ? "w-full max-w-md rounded-2xl border border-border-primary shadow-xl max-h-[85vh] overflow-hidden" : "min-h-full pb-[env(safe-area-inset-bottom)] md:min-h-0 md:pb-0 md:max-h-[85vh] md:overflow-y-auto md:w-full md:max-w-md md:rounded-2xl md:border md:border-border-primary md:shadow-xl"}`}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b border-border-secondary shrink-0 ${!isCompact ? "pt-[calc(1rem+env(safe-area-inset-top))] md:pt-4" : ""}`}>
          {step === "preview" ? (
            <button
              onClick={() => setStep("input")}
              className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              {t("send.edit")}
            </button>
          ) : step === "signing" ? (
            <h3 className="text-sm font-semibold text-text-primary">⏳ {t("send.signing")}</h3>
          ) : step === "result" ? (
            <h3 className="text-sm font-semibold text-text-primary">
              {txResult?.status === "success" ? `✅ ${t("send.success")}` : txResult?.status === "pending" ? `📡 ${t("send.broadcast")}` : `❌ ${t("send.failed")}`}
            </h3>
          ) : (
            <h3 className="text-sm font-semibold text-text-primary">
              {speedUpData ? `⚡ ${t("send.speedUp", { symbol: asset.symbol })}` : `📤 ${t("send.title", { symbol: asset.symbol })}`}

            </h3>
          )}
          {step === "preview" && (
            <h3 className="text-sm font-semibold text-text-primary absolute left-1/2 -translate-x-1/2">
              👀 {t("send.review")}
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
          <InputStep
            chain={chain}
            asset={asset}
            address={address}
            balance={balance}
            expert={expert}
            recovery={recovery}
            speedUpData={speedUpData}
            keyFile={keyFile}
            setKeyFile={setKeyFile}
            pendingEncrypted={pendingEncrypted}
            setPendingEncrypted={setPendingEncrypted}
            fileInputRef={fileInputRef}
            browserShareMode={browserShareMode}
            setBrowserShareMode={setBrowserShareMode}
            browserShareLoading={browserShareLoading}
            browserShareError={browserShareError}
            showBrowserPassphrase={showBrowserPassphrase}
            setShowBrowserPassphrase={setShowBrowserPassphrase}
            keyId={keyId}
            to={to}
            setTo={setTo}
            resolving={resolving}
            resolvedName={resolvedName}
            showAddrScanner={showAddrScanner}
            setShowAddrScanner={setShowAddrScanner}
            showSuggestions={showSuggestions}
            setShowSuggestions={setShowSuggestions}
            savingToBook={savingToBook}
            setSavingToBook={setSavingToBook}
            bookmarkLabel={bookmarkLabel}
            setBookmarkLabel={setBookmarkLabel}
            toTouched={toTouched}
            setToTouched={setToTouched}
            toValid={toValid}
            toSelf={toSelf}
            toError={toError}
            placeholder={placeholder}
            destinationTag={destinationTag}
            setDestinationTag={setDestinationTag}
            xlmMemo={xlmMemo}
            setXlmMemo={setXlmMemo}
            amount={amount}
            setAmount={setAmount}
            amountTouched={amountTouched}
            setAmountTouched={setAmountTouched}
            amountCheck={amountCheck}
            amountError={amountError}
            amountUsd={amountUsd}
            maxSendable={maxSendable}
            balancesHidden={balancesHidden}
            feeLevel={feeLevel}
            setFeeLevel={setFeeLevel}
            feeDisplay={feeDisplay}
            feeCountdown={feeCountdown}
            btcFeeRates={btcFeeRates}
            ltcFeeRates={ltcFeeRates}
            bchFeeRates={bchFeeRates}
            baseGasPrice={baseGasPrice}
            gasPrice={gasPrice}
            defaultGasLimit={defaultGasLimit}
            nonceOverride={nonceOverride}
            setNonceOverride={setNonceOverride}
            gasLimitOverride={gasLimitOverride}
            setGasLimitOverride={setGasLimitOverride}
            maxFeeOverride={maxFeeOverride}
            setMaxFeeOverride={setMaxFeeOverride}
            priorityFeeOverride={priorityFeeOverride}
            setPriorityFeeOverride={setPriorityFeeOverride}
            btcFeeRateOverride={btcFeeRateOverride}
            setBtcFeeRateOverride={setBtcFeeRateOverride}
            rbfEnabled={rbfEnabled}
            setRbfEnabled={setRbfEnabled}
            currentNonce={currentNonce}
            showUtxoPicker={showUtxoPicker}
            setShowUtxoPicker={setShowUtxoPicker}
            availableUtxos={availableUtxos}
            selectedUtxoKeys={selectedUtxoKeys}
            setSelectedUtxoKeys={setSelectedUtxoKeys}
            utxoLoading={utxoLoading}
            hasBackup={hasBackup}
            backupGateError={backupGateError}
            setBackupGateError={setBackupGateError}
            totalUsd={totalUsd}
            canReview={canReview}
            policyChecking={policyChecking}
            handleFileSelect={handleFileSelect}
            loadBrowserShare={loadBrowserShare}
            guardedSign={guardedSign}
            onClose={onClose}
            onPreview={async () => {
              if (chain.type === "xlm" && chain.rpcUrl) {
                setXlmDestExists(null);
                const exists = await checkXlmAccountExists(chain.rpcUrl, to);
                setXlmDestExists(exists);
              }
              if (!isRecoveryMode()) {
                setPolicyChecking(true);
                setPolicyCheck(null);
                try {
                  const baseUnits = parseUnits(amount, asset.decimals).toString();
                  const res = await fetch(apiUrl(`/api/keys/${keyId}/rules/check`), {
                    method: "POST",
                    headers: { ...authHeaders(), "Content-Type": "application/json" },
                    body: JSON.stringify({
                      to: resolvedName?.input === to ? resolvedName.address : to,
                      amount: baseUnits,
                      nativeSymbol: asset.isNative ? asset.symbol : undefined,
                      contractAddress: asset.contractAddress || undefined,
                      chainId: chain.evmChainId ?? undefined,
                      ...(resolvedName?.input === to ? { resolvedFrom: to, resolvedVia: resolvedName.source } : {}),
                    }),
                  });
                  if (res.ok) {
                    const result = await res.json();
                    setPolicyCheck(result);
                  }
                } catch {
                  // fail-open
                }
                setPolicyChecking(false);
              }
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
              if (resolvedName?.input === to && resolvedName.address) {
                setTo(resolvedName.address);
              }
              setStep("preview");
            }}
            t={t}
            handleFetchUtxosCallback={() => handleFetchUtxos(buildUtxoFetchCtx())}
          />
        )}

        {step === "preview" && (
          <PreviewStep
            chain={chain}
            asset={asset}
            address={address}
            to={effectiveTo}
            amount={amount}
            expert={expert}
            feeDisplay={feeDisplay}
            gasLimit={gasLimit}
            gasLimitOverride={gasLimitOverride}
            maxFeeOverride={maxFeeOverride}
            estimatedGas={estimatedGas}
            baseGasPrice={baseGasPrice}
            gasEstimateError={gasEstimateError}
            estimatedFeeWei={estimatedFeeWei}
            xlmDestExists={xlmDestExists}
            destinationTag={destinationTag}
            xlmMemo={xlmMemo}
            policyCheck={policyCheck}
            simResult={simResult}
            manualUtxos={manualUtxos}
            rbfEnabled={rbfEnabled}
            currentNonce={currentNonce}
            totalUsd={totalUsd}
            amountUsd={amountUsd}
            balancesHidden={balancesHidden}
            btcEstimatedFee={btcEstimatedFee}
            ltcEstimatedFee={ltcEstimatedFee}
            bchEstimatedFee={bchEstimatedFee}
            prices={prices}
            balance={balance}
            setStep={setStep}
            guardedSign={guardedSign}
            signingFlows={{
              executeEvm: () => executeSigningFlow(buildSigningCtx()),
              executeBtc: () => executeBtcSigningFlow(buildSigningCtx()),
              executeLtc: () => executeLtcSigningFlow(buildSigningCtx()),
              executeBch: () => executeBchSigningFlow(buildSigningCtx()),
              executeSolana: () => executeSolanaSigningFlow(buildSigningCtx()),
              executeXrp: () => executeXrpSigningFlow(buildSigningCtx()),
              executeXlm: () => executeXlmSigningFlow(buildSigningCtx()),
              executeTron: () => executeTronSigningFlow(buildSigningCtx()),
              executeTon: () => executeTonSigningFlow(buildSigningCtx()),
              executeAlgo: () => executeAlgoSigningFlow(buildSigningCtx()),
              executeAda: () => executeAdaSigningFlow(buildSigningCtx()),
            }}
            setSigningError={setSigningError}
            t={t}
          />
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
              <div className="py-6">
                <p className="text-sm font-medium text-text-primary text-center mb-2">
                  {phaseLabels[signingPhase]}
                </p>
                <p className="text-[11px] text-text-muted text-center mb-4">
                  {amount} {asset.symbol} to {shortAddrPreview(to)}
                </p>
                <div className="mb-5">
                  <ProgressBar {...progress} />
                </div>
                <SigningStepper
                  steps={confirmBeforeBroadcast && signingPhase !== "broadcasting" && signingPhase !== "polling"
                    ? [{ label: t("send.buildTx") }, { label: signLabelActive }]
                    : [{ label: t("send.buildTx") }, { label: signLabelActive }, { label: t("send.broadcasting") }, { label: t("send.confirming") }]
                  }
                  currentIndex={phaseIndex[signingPhase]}
                />
                {pendingTxHash && signingPhase === "polling" && (
                  <a
                    href={explorerLink(chain.explorerUrl, `/tx/${pendingTxHash}`)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between mt-5 mx-auto max-w-[260px] px-3 py-2.5 rounded-lg bg-surface-primary/60 border border-border-secondary hover:border-blue-500/30 transition-colors group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[11px] text-text-muted shrink-0">{t("send.txHash")}</span>
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
          <ResultStep
            chain={chain}
            asset={asset}
            to={effectiveTo}
            amount={amount}
            txResult={txResult}
            signedRawTx={signedRawTx}
            confirmBeforeBroadcast={confirmBeforeBroadcast}
            onClose={onClose}
            onTxSubmitted={onTxSubmitted}
            onTxConfirmed={onTxConfirmed}
            setSignedRawTx={setSignedRawTx}
            setTxResult={setTxResult}
            setStep={setStep}
            setSigningPhase={setSigningPhase}
            setSigningError={setSigningError}
            setPendingTxHash={setPendingTxHash}
            t={t}
          />
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
