import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { PendingRequest } from "../context/WalletConnectContext";
import type { KeyShare, Chain, Asset } from "../shared/types";
import { authHeaders, getMe } from "../lib/auth";
import { apiUrl } from "../lib/apiBase";
import { fetchChains, fetchAssets } from "../lib/api";
import { applyChainOverrides } from "../lib/userOverrides";
import { getChainAdapter } from "../lib/chains/adapter";
import { PasskeyChallenge } from "./PasskeyChallenge";
import { PassphraseInput } from "./PassphraseInput";
import type { PasskeyAuthResult } from "../lib/passkey";
import { authenticatePasskey } from "../lib/passkey";
import { hasKeyShare, getKeyShareMode, getKeyShareWithPrf, getKeyShareWithPassphrase } from "../lib/keystore";
import { decryptKeyFile, isEncryptedKeyFile, type KeyFileData } from "../lib/crypto";
import { isRecoveryMode, getRecoveryKeys, getRecoveryKeyFile } from "../lib/recovery";
import { wcPersonalSign, wcEthSign, wcSignTypedData, wcSendTransaction, wcSolanaSignTransaction, wcSolanaSignAndSendTransaction, wcSolanaSignMessage, type WcSignPhase } from "../lib/wcSigning";
import { waitForReceipt, estimateGas, getTransactionCount } from "../lib/chains/evmTx";
import { decodeSolanaTransaction, formatLamports, formatTokenAmount as formatSplAmount, waitForSolanaConfirmation, type DecodedSolanaTx } from "../lib/chains/solanaTx";
import { fetchPrices, getUsdValue, formatUsd } from "../lib/prices";
import { fetchNativeBalance, getCachedNativeBalance, fetchTokenBalances } from "../lib/balance";
import { clearCache, tokenBalancesCacheKey } from "../lib/dataCache";
import type { BalanceResult } from "../lib/balance";
import { explorerLink } from "../shared/utils";
import { BalancePreview, type BalanceChange } from "./BalancePreview";
import { simulateEvmTransaction, type SimulationResult } from "../lib/txSimulation";
import { useExpertMode } from "../context/ExpertModeContext";
import { PolicyWarning, ExpertWarnings, SimulationPreview, SigningError } from "./tx";

interface Props {
  request: PendingRequest;
  onApprove: (result: unknown) => void;
  onReject: () => void;
  onDismiss?: () => void;
}

interface ResolvedAccount {
  keyId: string;
  address: string;
  keyName: string;
  hasStored: boolean;
  storedMode: "prf" | "passphrase" | null;
}

// ── Fee constants ────────────────────────────────────────────────
type FeeLevel = "low" | "medium" | "high";
const FEE_LABELS: Record<FeeLevel, string> = { low: "Slow", medium: "Standard", high: "Fast" };
const FEE_MULTIPLIER: Record<FeeLevel, number> = { low: 0.8, medium: 1.0, high: 1.3 };
const GAS_LIMIT_DEFAULT = 21_000n;
const GAS_LIMIT_CONTRACT = 200_000n;

// ERC-20 approve detection
const APPROVE_SELECTOR = "0x095ea7b3";
const MAX_UINT256 = 2n ** 256n - 1n;

function parseApproveData(data: string): { spender: string; amount: bigint } | null {
  if (!data || data.length < 10) return null;
  if (data.slice(0, 10).toLowerCase() !== APPROVE_SELECTOR) return null;
  if (data.length < 138) return null; // 10 + 64 + 64
  const spender = "0x" + data.slice(34, 74); // skip selector (10) + 12 bytes zero-padding (24)
  const amount = BigInt("0x" + data.slice(74, 138));
  return { spender, amount };
}

function encodeApproveData(spender: string, amount: bigint): string {
  const addr = spender.toLowerCase().replace("0x", "").padStart(64, "0");
  const amt = amount.toString(16).padStart(64, "0");
  return APPROVE_SELECTOR + addr + amt;
}

function formatTokenAmount(amount: bigint, decimals: number): string {
  if (amount === MAX_UINT256) return "Unlimited";
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

function parseTokenAmount(input: string, decimals: number): bigint | null {
  if (input.toLowerCase() === "unlimited" || input === "") return MAX_UINT256;
  const parts = input.split(".");
  if (parts.length > 2) return null;
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  try {
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac);
  } catch {
    return null;
  }
}

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

// ── Component ────────────────────────────────────────────────────

export function WCRequestApproval({ request, onApprove, onReject, onDismiss }: Props) {
  const navigate = useNavigate();
  const expert = useExpertMode();
  // Phases: review → preview → passkey (#2) → signing → done
  // Browser share decrypt uses inline authenticatePasskey (passkey #1)
  // Confirm & Sign triggers PasskeyChallenge overlay (passkey #2)
  const [phase, setPhase] = useState<"review" | "preview" | "passkey" | "signing" | "done" | "error">("review");
  const [error, setError] = useState("");
  const [txResult, setTxResult] = useState<{ txHash: string; status: "success" | "pending" | "failed"; blockNumber?: string } | null>(null);
  const [account, setAccount] = useState<ResolvedAccount | null>(null);
  const [chains, setChains] = useState<Chain[]>([]);
  const [keyFile, setKeyFile] = useState<KeyFileData | null>(null);
  const [pendingEncrypted, setPendingEncrypted] = useState<KeyFileData | null>(null);
  const [browserShareLoading, setBrowserShareLoading] = useState(false);
  const [browserShareError, setBrowserShareError] = useState("");
  const [showBrowserPassphrase, setShowBrowserPassphrase] = useState(false);
  const [signingStepIdx, setSigningStepIdx] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fee state (for eth_sendTransaction)
  const [baseGasPrice, setBaseGasPrice] = useState<bigint | null>(null);
  const [feeLevel, setFeeLevel] = useState<FeeLevel>("medium");
  const [feeCountdown, setFeeCountdown] = useState(10);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [gasLimitInput, setGasLimitInput] = useState<string>("");
  const [maxFeeOverride, setMaxFeeOverride] = useState("");
  const [priorityFeeOverride, setPriorityFeeOverride] = useState("");
  const [approveAmountInput, setApproveAmountInput] = useState<string>("");
  const [approveToken, setApproveToken] = useState<{ symbol: string; decimals: number } | null>(null);
  const [nativeBalance, setNativeBalance] = useState<string | null>(null); // raw wei as string
  const [tokenBalances, setTokenBalances] = useState<BalanceResult[]>([]);

  const isSolana = request.method.startsWith("solana_");
  const isSolanaTx = request.method === "solana_signTransaction" || request.method === "solana_signAndSendTransaction";
  const isTx = request.method === "eth_sendTransaction" || isSolanaTx;
  const isContractCall = !isSolana && isTx && request.params[0]?.data && request.params[0].data !== "0x";

  // Decode Solana transaction for display
  const [decodedSolTx, setDecodedSolTx] = useState<DecodedSolanaTx | null>(null);
  useEffect(() => {
    if (!isSolanaTx) return;
    try {
      const txBase64 = request.params?.transaction;
      if (txBase64) setDecodedSolTx(decodeSolanaTransaction(txBase64));
    } catch {
      // If decode fails, show raw
    }
  }, [isSolanaTx, request.params?.transaction]);

  // Resolve which chain this request targets
  const namespace = request.chainId?.split(":")[0] || "eip155";
  const chainId = namespace === "eip155" ? parseInt(request.chainId?.split(":")[1] || "1") : 0;
  const chain = isSolana
    ? chains.find((c) => c.type === "solana")
    : chains.find((c) => c.evmChainId === chainId);

  // Resolve SPL token info (symbol, decimals) from chain assets
  const [solTokenInfo, setSolTokenInfo] = useState<{ symbol: string; decimals: number } | null>(null);
  useEffect(() => {
    if (!decodedSolTx?.mint || !chain) return;
    fetchAssets(chain.id).then((assets) => {
      const token = assets.find(
        (a) => a.contractAddress?.toLowerCase() === decodedSolTx.mint!.toLowerCase()
      );
      if (token) setSolTokenInfo({ symbol: token.symbol, decimals: token.decimals });
    });
  }, [decodedSolTx?.mint, chain?.id]);

  // Gas limit: use user override, estimated, dApp's value, or heuristic
  const txParams = isTx ? request.params[0] : null;
  const dappGasLimit = txParams?.gasLimit
    ? BigInt(txParams.gasLimit)
    : txParams?.gas
      ? BigInt(txParams.gas)
      : (txParams?.data && txParams.data !== "0x" ? GAS_LIMIT_CONTRACT : GAS_LIMIT_DEFAULT);

  const [estimatedGasLimit, setEstimatedGasLimit] = useState<bigint | null>(null);
  const [currentNonce, setCurrentNonce] = useState<number | null>(null);

  // Fetch estimated gas and nonce for EVM transactions
  useEffect(() => {
    if (isSolana || !isTx || !txParams?.to || !chain?.rpcUrl || !account) return;
    estimateGas(chain.rpcUrl, {
      from: account.address,
      to: txParams.to,
      value: txParams.value || "0x0",
      data: txParams.data || undefined,
    }).then(setEstimatedGasLimit).catch(() => {});
    getTransactionCount(chain.rpcUrl, account.address).then(setCurrentNonce).catch(() => {});
  }, [isTx, isSolana, txParams?.to, txParams?.value, txParams?.data, chain?.rpcUrl, account?.address]);

  const defaultGasLimit = estimatedGasLimit ?? dappGasLimit;
  const gasLimit = gasLimitInput && /^\d+$/.test(gasLimitInput) ? BigInt(gasLimitInput) : defaultGasLimit;

  // ERC-20 approve detection
  const approveData = txParams?.data ? parseApproveData(txParams.data) : null;
  const isApprove = approveData !== null;

  const gasPrice = maxFeeOverride && /^\d+(\.\d+)?$/.test(maxFeeOverride)
    ? BigInt(Math.round(parseFloat(maxFeeOverride) * 1e9))
    : baseGasPrice != null
      ? BigInt(Math.round(Number(baseGasPrice) * FEE_MULTIPLIER[feeLevel]))
    : null;
  const estimatedFeeWei = gasPrice != null ? gasPrice * gasLimit : null;
  const feeEth = estimatedFeeWei != null ? formatEthFee(estimatedFeeWei) : null;
  const feeUsd = estimatedFeeWei != null ? getUsdValue(String(Number(estimatedFeeWei) / 1e18), "ETH", prices) : null;

  // Resolve account from request
  useEffect(() => {
    const address = getRequestAddress(request);
    if (!address) return;

    const keysPromise = isRecoveryMode()
      ? Promise.resolve(getRecoveryKeys())
      : fetch(apiUrl("/api/keys"), { headers: authHeaders() })
          .then((r) => r.json())
          .then((d) => (d.keys || []) as KeyShare[]);

    Promise.all([keysPromise, fetchChains(), getMe()]).then(async ([keys, allChains, me]) => {
      // Apply user config overrides (expert-only: custom RPC URLs)
      const mergedChains = applyChainOverrides(allChains, me?.id);
      setChains(mergedChains);

      for (const key of keys) {
        if (!key.enabled) continue;

        let derived: string | null = null;
        if (isSolana) {
          if (!key.eddsaPublicKey) continue;
          const solanaAdapter = getChainAdapter("solana");
          derived = solanaAdapter.deriveAddress(key.eddsaPublicKey);
        } else {
          if (!key.publicKey) continue;
          const evmAdapter = getChainAdapter("evm");
          derived = evmAdapter.deriveAddress(key.publicKey);
        }

        if (derived && derived.toLowerCase() === address.toLowerCase()) {
          if (isRecoveryMode()) {
            // In recovery mode, key file is already in memory
            setAccount({
              keyId: key.id,
              address: derived,
              keyName: key.name || `Key ${key.id.slice(0, 8)}`,
              hasStored: true,
              storedMode: null,
            });
            setKeyFile(getRecoveryKeyFile());
          } else {
            const stored = await hasKeyShare(key.id);
            const mode = stored ? await getKeyShareMode(key.id) : null;
            setAccount({
              keyId: key.id,
              address: derived,
              keyName: key.name || `Key ${key.id.slice(0, 8)}`,
              hasStored: stored,
              storedMode: mode,
            });
          }
          return;
        }
      }
    });
  }, [request]);

  // Resolve token info for ERC-20 approve calls
  useEffect(() => {
    if (!isApprove || !txParams?.to || !chain) return;
    fetchAssets(chain.id).then((assets) => {
      const token = assets.find(
        (a) => a.contractAddress?.toLowerCase() === txParams.to.toLowerCase()
      );
      if (token) {
        setApproveToken({ symbol: token.symbol, decimals: token.decimals });
        if (approveData) {
          setApproveAmountInput(formatTokenAmount(approveData.amount, token.decimals));
        }
      } else {
        // Unknown token — show raw with 18 decimals as fallback
        setApproveToken({ symbol: "tokens", decimals: 18 });
        if (approveData) {
          setApproveAmountInput(formatTokenAmount(approveData.amount, 18));
        }
      }
    });
  }, [isApprove, txParams?.to, chain?.id]);

  // Fetch native + token balances for preview
  useEffect(() => {
    if (!account || !chain) return;
    fetchAssets(chain.id).then((assets) => {
      // Try cached first for instant display
      const cached = getCachedNativeBalance(account.address, chain, assets);
      if (cached) setNativeBalance(cached.data.balance);
      // Fetch fresh native
      fetchNativeBalance(account.address, chain, assets).then((result) => {
        if (result) setNativeBalance(result.balance);
      });
      // Fetch token balances
      fetchTokenBalances(account.address, chain, assets).then((results) => {
        setTokenBalances(results);
      });
    });
  }, [account?.address, chain?.id]);

  // Fetch gas price and USD prices (for fee estimation)
  useEffect(() => {
    if (!isTx) return;

    fetchPrices().then(setPrices);

    // Gas price polling is EVM-only
    if (!chain || chain.type !== "evm") return;

    function refreshGasPrice() {
      const rpcUrl = chain?.rpcUrl;
      if (!rpcUrl) return;
      fetch(rpcUrl, {
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

    refreshGasPrice();
    setFeeCountdown(10);
    const feeIv = setInterval(() => { refreshGasPrice(); setFeeCountdown(10); }, 10_000);
    const countIv = setInterval(() => setFeeCountdown((c) => Math.max(0, c - 1)), 1_000);
    return () => { clearInterval(feeIv); clearInterval(countIv); };
  }, [isTx, isSolana, chain?.rpcUrl]);

  function getRequestAddress(req: PendingRequest): string | null {
    switch (req.method) {
      case "eth_sendTransaction":
        return req.params?.[0]?.from || null;
      case "personal_sign":
        return req.params?.[1] || null;
      case "eth_sign":
        return req.params?.[0] || null;
      case "eth_signTypedData_v4":
        return req.params?.[0] || null;
      case "solana_signTransaction":
      case "solana_signAndSendTransaction":
        // Address comes from the session account, extract from chainId
        return req.params?.account || null;
      case "solana_signMessage":
        return req.params?.pubkey || req.params?.account || null;
      default:
        return null;
    }
  }

  // ── Key share loading (passkey #1 for decrypt) ─────────────────

  /** Load browser-stored key share — triggers passkey #1 for PRF decrypt */
  async function loadBrowserShare() {
    if (!account) return;
    setBrowserShareLoading(true);
    setBrowserShareError("");
    try {
      if (account.storedMode === "prf") {
        const result = await authenticatePasskey({ withPrf: true });
        if (result.prfKey) {
          const data = await getKeyShareWithPrf(account.keyId, result.prfKey);
          if (data) {
            setKeyFile(data);
            setBrowserShareLoading(false);
            return;
          }
          setBrowserShareError("Could not decrypt. Wrong passkey?");
        } else {
          setBrowserShareError("Passkey does not support encryption. Use file upload.");
        }
      } else if (account.storedMode === "passphrase") {
        setShowBrowserPassphrase(true);
      }
    } catch (err) {
      setBrowserShareError(String(err));
    }
    setBrowserShareLoading(false);
  }


  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as KeyFileData;
        if (!data.id || !data.share || !data.publicKey) return;
        if (isEncryptedKeyFile(data)) {
          setPendingEncrypted(data);
          setKeyFile(null);
        } else {
          setKeyFile(data);
          setPendingEncrypted(null);
        }
      } catch {
        // ignore invalid files
      }
    };
    reader.readAsText(file);
  }

  // Policy pre-check
  const [policyCheck, setPolicyCheck] = useState<{
    allowed: boolean;
    reason?: string;
    fraudCheck?: { flagged: boolean; flags: string[]; level: string; address: string };
  } | null>(null);
  const [policyChecking, setPolicyChecking] = useState(false);

  // Transaction simulation
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);

  // ── Approve flow (passkey #2 for MPC signing) ──────────────────

  /** Approve button: key must already be loaded → pre-check policy → go to preview */
  async function handleApproveClick() {
    if (!account || !keyFile) return;

    // Policy pre-check for transactions (skip in recovery mode and for message signing)
    if (isTx && !isRecoveryMode()) {
      setPolicyChecking(true);
      setPolicyCheck(null);
      try {
        let to = "";
        let amount = "0";
        let nativeSymbol: string | undefined;
        let contractAddress: string | undefined;
        let reqChainId: number | undefined;

        if (isSolana && decodedSolTx) {
          to = decodedSolTx.to || "";
          amount = decodedSolTx.amount || "0";
          nativeSymbol = decodedSolTx.mint ? undefined : "SOL";
          contractAddress = decodedSolTx.mint || undefined;
        } else if (txParams) {
          to = txParams.to || "";
          amount = txParams.value ? BigInt(txParams.value).toString() : "0";
          nativeSymbol = (!txParams.data || txParams.data === "0x") ? "ETH" : undefined;
          reqChainId = chainId || undefined;
        }

        if (to) {
          const res = await fetch(apiUrl(`/api/keys/${account.keyId}/rules/check`), {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ to, amount, nativeSymbol, contractAddress, chainId: reqChainId }),
          });
          if (res.ok) {
            setPolicyCheck(await res.json());
          }
        }
      } catch {
        // Fail-open
      }
      setPolicyChecking(false);
    }

    // EVM transaction simulation (non-blocking)
    if (!isSolana && isTx && txParams && chain?.rpcUrl) {
      setSimResult(null);
      simulateEvmTransaction(chain.rpcUrl, {
        from: account.address,
        to: txParams.to || "",
        value: txParams.value || "0x0",
        data: txParams.data || "0x",
        gas: txParams.gas || txParams.gasLimit,
      }).then((r) => { if (r) setSimResult(r); });
    }

    setPhase("preview");
  }

  /** Passkey #2 completed → start signing */
  async function onPasskeyAuth(_result: PasskeyAuthResult) {
    setPhase("signing");
    setSigningStepIdx(0);

    try {
      if (!keyFile) {
        setError("Key share not available.");
        setPhase("error");
        return;
      }
      await executeSign(keyFile);
    } catch (err: any) {
      setError(err.message || String(err));
      setPhase("error");
    }
  }

  /** Browser passphrase submitted → decrypt key share */
  async function handleBrowserPassphraseSubmit(pw: string) {
    if (!account) return;
    try {
      const kf = await getKeyShareWithPassphrase(account.keyId, pw);
      if (!kf) {
        setBrowserShareError("Failed to decrypt. Wrong passphrase?");
        return;
      }
      setKeyFile(kf);
      setShowBrowserPassphrase(false);
    } catch (err: any) {
      setBrowserShareError(err.message || String(err));
    }
  }

  async function executeSign(kf: KeyFileData) {
    try {
      const rpcUrl = chain?.rpcUrl;

      let result: unknown;
      switch (request.method) {
        case "personal_sign": {
          setSigningStepIdx(0); // Prepare
          const message = request.params[0];
          setSigningStepIdx(1); // MPC signing
          result = await wcPersonalSign(message, kf, account!.address);
          setSigningStepIdx(2); // Verify
          break;
        }
        case "eth_sign": {
          setSigningStepIdx(0);
          const hash = request.params[1];
          setSigningStepIdx(1);
          result = await wcEthSign(hash, kf, account!.address);
          setSigningStepIdx(2);
          break;
        }
        case "eth_signTypedData_v4": {
          setSigningStepIdx(0);
          const typedData = request.params[1];
          setSigningStepIdx(1);
          result = await wcSignTypedData(typedData, kf, account!.address);
          setSigningStepIdx(2);
          break;
        }
        case "eth_sendTransaction": {
          if (!rpcUrl) throw new Error("No RPC URL for chain " + chainId);
          // Override gas price and gas limit with user-selected values
          const txWithFee = { ...request.params[0] };
          if (gasPrice != null) {
            txWithFee.gasPrice = "0x" + gasPrice.toString(16);
          }
          txWithFee.gasLimit = "0x" + gasLimit.toString(16);
          // Override ERC-20 approve amount if user edited it
          if (isApprove && approveData && approveToken) {
            const newAmount = parseTokenAmount(approveAmountInput, approveToken.decimals);
            if (newAmount !== null && newAmount !== approveData.amount) {
              txWithFee.data = encodeApproveData(approveData.spender, newAmount);
            }
          }
          result = await wcSendTransaction(
            txWithFee, rpcUrl, chainId, kf, account!.address,
            (p) => setSigningStepIdx(txPhaseIndex[p]),
          );
          break;
        }
        case "solana_signTransaction": {
          const txBase64 = request.params?.transaction;
          if (!txBase64) throw new Error("Missing transaction data");
          const solResult = await wcSolanaSignTransaction(
            txBase64, kf, account!.address, chain?.rpcUrl ?? "",
            (p) => setSigningStepIdx(txPhaseIndex[p]),
          );
          result = solResult;
          break;
        }
        case "solana_signAndSendTransaction": {
          const txBase64ss = request.params?.transaction;
          if (!txBase64ss) throw new Error("Missing transaction data");
          const txSig = await wcSolanaSignAndSendTransaction(
            txBase64ss, kf, account!.address, chain?.rpcUrl ?? "",
            (p) => setSigningStepIdx(txPhaseIndex[p]),
          );
          result = { signature: txSig };
          break;
        }
        case "solana_signMessage": {
          setSigningStepIdx(0);
          const msgBase64 = request.params?.message;
          if (!msgBase64) throw new Error("Missing message data");
          setSigningStepIdx(1);
          const msgResult = await wcSolanaSignMessage(msgBase64, kf, account!.address);
          setSigningStepIdx(2);
          result = { signature: msgResult.signature };
          break;
        }
        default:
          throw new Error("Unsupported method: " + request.method);
      }

      onApprove(result);

      if (isTx && typeof result === "string") {
        // EVM transaction — poll for receipt
        setSigningStepIdx(3);
        setTxResult({ txHash: result, status: "pending" });

        if (account && chain) {
          const prefix = `cache:bal:${account.address}:${chain.id}:`;
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k?.startsWith(prefix)) localStorage.removeItem(k);
          }
          clearCache(tokenBalancesCacheKey(account.address, chain.id));
        }

        const rpcUrl = chain?.rpcUrl;
        if (rpcUrl) {
          try {
            const receipt = await waitForReceipt(rpcUrl, result, () => {}, 60, 3000);
            setTxResult({ txHash: result, status: receipt.status, blockNumber: receipt.blockNumber });
          } catch {
            // Polling timed out — show done as pending
          }
        }
        setPhase("done");
      } else if (isSolanaTx && typeof result === "object" && result !== null) {
        // Solana transaction — poll for confirmation (dApp broadcasts)
        const sig = (result as { signature: string }).signature;
        setSigningStepIdx(3);
        setTxResult({ txHash: sig, status: "pending" });

        if (account && chain) {
          const prefix = `cache:bal:${account.address}:${chain.id}:`;
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k?.startsWith(prefix)) localStorage.removeItem(k);
          }
          clearCache(tokenBalancesCacheKey(account.address, chain.id));
        }

        const rpcUrl = chain?.rpcUrl;
        if (rpcUrl) {
          try {
            const conf = await waitForSolanaConfirmation(rpcUrl, sig, () => {}, 60, 2000);
            setTxResult({ txHash: sig, status: conf.confirmed ? "success" : "pending", blockNumber: conf.slot?.toString() });
          } catch {
            // Polling timed out — show as success (dApp handled broadcast)
            setTxResult({ txHash: sig, status: "success" });
          }
        }
        setPhase("done");
      } else {
        // For signing methods, show done immediately
        setTxResult({ txHash: "", status: "success" });
        setPhase("done");
      }
    } catch (err: any) {
      setError(err.message || String(err));
      setPhase("error");
    }
  }

  // Format request for display
  const requestDisplay = formatRequest(request, expert);

  const shortAddr = (addr: string) => expert ? addr : `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  // Signing progress steps
  // 4-step for transactions, 3-step for message signing
  const signLabel = isRecoveryMode() ? "Local signing" : "MPC signing";
  const displaySteps = isTx
    ? [{ label: "Build transaction" }, { label: signLabel }, { label: "Broadcast" }, { label: "Confirming" }]
    : [{ label: "Prepare" }, { label: signLabel }, { label: "Verify" }];

  const txPhaseIndex: Record<WcSignPhase, number> = {
    "building-tx": 0,
    "mpc-signing": 1,
    "broadcasting": 2,
  };

  const canClose = phase === "review" || phase === "preview" || phase === "done" || phase === "error"
    || (phase === "signing" && signingStepIdx >= 2);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={canClose ? (phase === "done" ? (onDismiss ?? onReject) : onReject) : undefined} />
      <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary shrink-0">
          {phase === "preview" ? (
            <button
              onClick={() => setPhase("review")}
              className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              Edit
            </button>
          ) : (
            <h3 className="text-sm font-semibold text-text-primary">
              {phase === "signing"
                ? "⏳ Signing"
                : phase === "done"
                  ? (txResult?.status === "success" ? "✅ Success" : txResult?.status === "pending" ? "📡 Broadcast" : "❌ Failed")
                  : isTx
                    ? (isApprove ? "🔓 Token Approval" : "✍️ Sign Transaction")
                    : "✍️ Sign Message"}
            </h3>
          )}
          {phase === "preview" && (
            <h3 className="text-sm font-semibold text-text-primary absolute left-1/2 -translate-x-1/2">
              👀 Review
            </h3>
          )}
          {canClose && (
            <button
              onClick={phase === "done" ? (onDismiss ?? onReject) : onReject}
              className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4 overflow-y-auto flex-1 min-h-0">
          {/* ── Review phase ────────────────────────────────────── */}
          {phase === "review" && (
            <>
              {/* Key share section — top, consistent with transfer form */}
              {account && (
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
                        onClick={() => !isRecoveryMode() && setKeyFile(null)}
                        disabled={isRecoveryMode()}
                        className={`p-1 rounded-md transition-colors ${isRecoveryMode() ? "opacity-40 cursor-not-allowed" : "hover:bg-surface-tertiary"}`}
                        title={isRecoveryMode() ? "Key loaded from recovery" : "Change key share"}
                      >
                        <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                        </svg>
                      </button>
                    </div>
                  ) : account.hasStored && !showBrowserPassphrase ? (
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
                          <p className="text-xs text-text-secondary truncate">{account.keyId.slice(0, 8)}...</p>
                          <p className="text-[10px] text-text-muted">{account.storedMode === "prf" ? "Passkey encrypted" : "Passphrase encrypted"} · ECDSA + EdDSA</p>
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
                        onClick={() => fileInputRef.current?.click()}
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
              )}

              {/* Passphrase prompt for encrypted file upload */}
              {pendingEncrypted && !keyFile && (
                <div className="bg-surface-primary border border-border-primary rounded-lg p-3">
                  <p className="text-xs text-text-muted mb-2">
                    <span className="font-mono text-text-tertiary">{pendingEncrypted.id.slice(0, 8)}...</span> — Enter your passphrase to unlock
                  </p>
                  <PassphraseInput
                    mode="enter"
                    submitLabel="Decrypt"
                    onSubmit={async (pw) => {
                      const decrypted = await decryptKeyFile(pendingEncrypted, pw);
                      setKeyFile(decrypted);
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
                    onSubmit={handleBrowserPassphraseSubmit}
                  />
                  {browserShareError && (
                    <p className="text-[11px] text-red-400 mt-2">{browserShareError}</p>
                  )}
                </div>
              )}

              {isTx && !isSolana ? (
                <>
                  {/* From */}
                  <div>
                    <label className="block text-xs text-text-muted mb-1.5">From</label>
                    <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5">
                      <p className={`text-xs font-mono text-text-tertiary ${expert ? "text-[9px]" : "truncate"}`}>{account?.address ?? "—"}</p>
                      {chain && (
                        <p className="text-[10px] text-text-muted mt-0.5">{chain.displayName}</p>
                      )}
                    </div>
                  </div>

                  {/* To */}
                  {txParams?.to && (
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <label className="text-xs text-text-muted">To</label>
                        {isContractCall ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 font-medium">
                            Contract
                          </span>
                        ) : (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-medium">
                            Transfer
                          </span>
                        )}
                      </div>
                      <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5">
                        <p className={`text-xs font-mono text-text-tertiary ${expert ? "text-[9px]" : "truncate"}`}>{txParams.to}</p>
                      </div>
                    </div>
                  )}

                  {/* Amount (read-only, matches From/To style) */}
                  <div>
                    <label className="block text-xs text-text-muted mb-1.5">Amount</label>
                    <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 flex items-center justify-between">
                      <p className="text-sm text-text-tertiary tabular-nums">
                        {txParams?.value ? formatWei(BigInt(txParams.value)) : "0"}
                      </p>
                      <span className="text-xs text-text-muted shrink-0">ETH</span>
                    </div>
                  </div>

                  {/* Data (if contract call, but not approve — approve shows parsed UI below) */}
                  {!isApprove && txParams?.data && txParams.data !== "0x" && (
                    <div>
                      <label className="block text-xs text-text-muted mb-1.5">Data</label>
                      <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 overflow-auto max-h-20">
                        <p className={`text-xs font-mono text-text-muted ${expert ? "text-[9px]" : "truncate"}`}>
                          {expert ? txParams.data : (txParams.data.length > 66 ? txParams.data.slice(0, 66) + "..." : txParams.data)}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* ERC-20 Approve amount editor */}
                  {isApprove && approveData && (
                    <div>
                      <label className="block text-xs text-text-muted mb-1.5">
                        Approve Spender
                      </label>
                      <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5">
                        <p className="text-xs font-mono text-text-tertiary truncate">{approveData.spender}</p>
                      </div>
                      <label className="block text-xs text-text-muted mt-3 mb-1.5">
                        Approval Amount {approveToken ? `(${approveToken.symbol})` : ""}
                      </label>
                      <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 flex items-center gap-2">
                        <input
                          type="text"
                          value={approveAmountInput}
                          onChange={(e) => setApproveAmountInput(e.target.value)}
                          onFocus={() => { if (approveAmountInput === "Unlimited") setApproveAmountInput(""); }}
                          onBlur={() => { if (approveAmountInput.trim() === "") setApproveAmountInput("Unlimited"); }}
                          placeholder="Enter amount"
                          className="flex-1 text-sm text-text-primary bg-transparent outline-none tabular-nums"
                        />
                        {approveToken && (
                          <span className="text-xs text-text-muted shrink-0">{approveToken.symbol}</span>
                        )}
                      </div>
                      {approveData.amount === MAX_UINT256 && (
                        <p className="text-[10px] text-yellow-400 mt-1 px-1">
                          ⚠ dApp requested unlimited approval. Consider setting a specific amount.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Fee level selector */}
                  <div className="bg-surface-primary border border-border-primary rounded-lg p-1.5">
                    <div className="grid grid-cols-3 gap-1">
                      {(["low", "medium", "high"] as FeeLevel[]).map((level) => {
                        const isActive = feeLevel === level;
                        const gp = baseGasPrice != null
                          ? BigInt(Math.round(Number(baseGasPrice) * FEE_MULTIPLIER[level]))
                          : null;
                        const feeText = gp != null ? `${formatGwei(gp)} Gwei` : "...";
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

                  {/* Expert: advanced tx overrides */}
                  {expert && (
                    <div className="space-y-2">
                      <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">Advanced</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs text-text-muted mb-1">Nonce</label>
                          <input
                            value=""
                            readOnly
                            placeholder={currentNonce != null ? currentNonce.toString() : "..."}
                            className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-text-muted mb-1">Gas limit</label>
                          <input
                            value={gasLimitInput}
                            onChange={(e) => setGasLimitInput(e.target.value.replace(/[^0-9]/g, ""))}
                            placeholder={defaultGasLimit.toString()}
                            className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-text-muted mb-1">Max fee (Gwei)</label>
                          <input
                            value={maxFeeOverride}
                            onChange={(e) => setMaxFeeOverride(e.target.value)}
                            placeholder={gasPrice != null ? formatGwei(gasPrice) : "..."}
                            className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-text-muted mb-1">Priority fee (Gwei)</label>
                          <input
                            value={priorityFeeOverride}
                            onChange={(e) => setPriorityFeeOverride(e.target.value)}
                            placeholder={baseGasPrice != null ? formatGwei(baseGasPrice / 10n) : "..."}
                            className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
                          />
                        </div>
                      </div>

                      <ExpertWarnings
                        gasLimitOverride={gasLimitInput}
                        maxFeeOverride={maxFeeOverride}
                        estimatedGas={estimatedGasLimit}
                        baseGasPrice={baseGasPrice}
                        lowMultiplier={FEE_MULTIPLIER.low}
                      />
                    </div>
                  )}

                  {/* Fee summary */}
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] text-text-muted flex items-center gap-1">
                      Est. fee
                      <span className="text-text-muted/40 tabular-nums">
                        {feeCountdown > 0 ? `\u00b7 ${feeCountdown}s` : "\u00b7 \u27f3"}
                      </span>
                    </span>
                    {feeEth != null ? (
                      <span className="text-[11px] tabular-nums text-text-secondary">
                        {feeEth} ETH
                        {feeUsd != null && feeUsd > 0 && (
                          <span className="text-text-muted ml-1">({formatUsd(feeUsd)})</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-[10px] text-text-muted animate-pulse">Estimating...</span>
                    )}
                  </div>
                </>
              ) : isSolanaTx && decodedSolTx ? (
                <>
                  {/* From */}
                  <div>
                    <label className="block text-xs text-text-muted mb-1.5">From</label>
                    <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5">
                      <p className="text-xs font-mono text-text-tertiary truncate">{account?.address ?? decodedSolTx.from}</p>
                      {chain && (
                        <p className="text-[10px] text-text-muted mt-0.5">{chain.displayName}</p>
                      )}
                    </div>
                  </div>

                  {/* To */}
                  {decodedSolTx.to && (
                    <div>
                      <label className="block text-xs text-text-muted mb-1.5">To</label>
                      <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5">
                        <p className="text-xs font-mono text-text-tertiary truncate">{decodedSolTx.to}</p>
                      </div>
                    </div>
                  )}

                  {/* Amount */}
                  {decodedSolTx.amount && (
                    <div>
                      <label className="block text-xs text-text-muted mb-1.5">Amount</label>
                      <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 flex items-center justify-between">
                        <p className="text-sm text-text-tertiary tabular-nums">
                          {decodedSolTx.type === "sol_transfer"
                            ? formatLamports(BigInt(decodedSolTx.amount))
                            : decodedSolTx.formattedAmount
                              ? decodedSolTx.formattedAmount
                              : solTokenInfo
                                ? formatSplAmount(BigInt(decodedSolTx.amount), solTokenInfo.decimals)
                                : decodedSolTx.amount}
                        </p>
                        <span className="text-xs text-text-muted shrink-0">
                          {decodedSolTx.type === "sol_transfer" ? "SOL" : solTokenInfo?.symbol || "tokens"}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Mint (for SPL transfers) */}
                  {decodedSolTx.mint && (
                    <div>
                      <label className="block text-xs text-text-muted mb-1.5">Token Mint</label>
                      <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5">
                        <p className="text-xs font-mono text-text-muted truncate">{decodedSolTx.mint}</p>
                      </div>
                    </div>
                  )}

                  {/* Program (for contract calls) */}
                  {decodedSolTx.type === "contract_call" && decodedSolTx.programId && (
                    <div>
                      <label className="block text-xs text-text-muted mb-1.5">Program</label>
                      <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5">
                        {decodedSolTx.programLabel && (
                          <p className="text-xs text-text-secondary mb-0.5">{decodedSolTx.programLabel}</p>
                        )}
                        <p className="text-xs font-mono text-text-muted truncate">{decodedSolTx.programId}</p>
                      </div>
                    </div>
                  )}

                  {/* Fee info */}
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] text-text-muted">Est. fee</span>
                    <span className="text-[11px] tabular-nums text-text-secondary">0.000005 SOL</span>
                  </div>

                  {/* Instruction count */}
                  {expert && decodedSolTx.numInstructions > 1 && (
                    <div className="flex items-center justify-between px-1">
                      <span className="text-[10px] text-text-muted">Instructions</span>
                      <span className="text-[11px] tabular-nums text-text-secondary">{decodedSolTx.numInstructions}</span>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {/* Method badge + address */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 font-mono">
                      {request.method}
                    </span>
                    {account && (
                      <span className="text-[10px] text-text-muted font-mono">
                        {shortAddr(account.address)}
                      </span>
                    )}
                  </div>

                  {/* Request details */}
                  <div className="bg-surface-tertiary rounded-lg p-3 space-y-2 max-h-60 overflow-y-auto">
                    {requestDisplay.map(({ label, value }, i) => (
                      <div key={i}>
                        <p className="text-[10px] text-text-muted uppercase mb-0.5">{label}</p>
                        <p className="text-xs text-text-primary font-mono break-all">{value}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {/* ── Preview phase (review before signing) ─────────────── */}
          {phase === "preview" && (
            <>
              <PolicyWarning policyCheck={policyCheck} />

              {isTx && !isSolana ? (
                <div className="space-y-5">
                  {/* Value hero */}
                  {(() => {
                    const tx = request.params[0];
                    const val = tx.value ? formatWei(BigInt(tx.value)) : "0";
                    return (
                      <div className="text-center py-2">
                        <p className="text-2xl font-semibold tabular-nums text-text-primary">
                          {val} <span className="text-text-tertiary text-sm">ETH</span>
                        </p>
                      </div>
                    );
                  })()}

                  {/* From → To */}
                  <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
                    {expert && (
                      <div className="px-3 py-2.5 flex items-center justify-between">
                        <span className="text-xs text-text-muted">From</span>
                        <span className="text-xs font-mono text-text-secondary">{account ? shortAddr(account.address) : "—"}</span>
                      </div>
                    )}
                    {request.params[0]?.to && (
                      <div className={`${expert ? "border-t border-border-secondary " : ""}px-3 py-2.5 flex items-center justify-between`}>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-text-muted">To</span>
                          {expert && isContractCall && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 font-medium">
                              Contract
                            </span>
                          )}
                        </div>
                        <span className="text-xs font-mono text-text-secondary">{shortAddr(request.params[0].to)}</span>
                      </div>
                    )}
                    {isApprove && approveData && approveToken ? (
                      <>
                        <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                          <span className="text-xs text-text-muted">Spender</span>
                          <span className="text-xs font-mono text-text-secondary">{shortAddr(approveData.spender)}</span>
                        </div>
                        <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                          <span className="text-xs text-text-muted">Approval</span>
                          <span className="text-xs tabular-nums text-text-secondary">
                            {approveAmountInput || "Unlimited"} {approveToken.symbol}
                          </span>
                        </div>
                      </>
                    ) : expert && request.params[0]?.data && request.params[0].data !== "0x" ? (
                      <div className="border-t border-border-secondary px-3 py-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-text-muted">Data</span>
                        </div>
                        <pre className="text-[10px] font-mono text-text-muted break-all mt-1 leading-relaxed max-h-24 overflow-auto">
                          {request.params[0].data}
                        </pre>
                      </div>
                    ) : null}
                  </div>

                  {/* Details */}
                  <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
                    {expert && chain && (
                      <div className="px-3 py-2.5 flex items-center justify-between">
                        <span className="text-xs text-text-muted">Network</span>
                        <span className="text-xs text-text-secondary">{chain.displayName}</span>
                      </div>
                    )}
                    <div className={`${expert && chain ? "border-t border-border-secondary " : ""}px-3 py-2.5 flex items-center justify-between`}>
                      <span className="text-xs text-text-muted">Network fee</span>
                      <span className="text-xs tabular-nums text-text-secondary font-medium">
                        {(() => {
                          const feeUsd = feeEth ? getUsdValue(feeEth, "ETH", prices) : null;
                          return feeUsd != null && feeUsd > 0 ? formatUsd(feeUsd) : `${feeEth ?? "—"} ETH`;
                        })()}
                      </span>
                    </div>
                    {expert && gasPrice != null && (
                      <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                        <span className="text-xs text-text-muted">Gas price</span>
                        <span className="text-xs tabular-nums text-text-muted">{formatGwei(gasPrice)} Gwei</span>
                      </div>
                    )}
                    {expert && (
                      <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                        <span className="text-xs text-text-muted">Gas limit</span>
                        <span className="text-xs tabular-nums text-text-muted">{gasLimit.toLocaleString()}</span>
                      </div>
                    )}
                    {(() => {
                      const txValueWei = txParams?.value ? BigInt(txParams.value) : 0n;
                      const totalWei = txValueWei + (estimatedFeeWei ?? 0n);
                      const totalUsd = getUsdValue(String(Number(totalWei) / 1e18), "ETH", prices);
                      const totalEth = formatEthFee(totalWei);
                      return (
                        <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                          <span className="text-xs text-text-muted font-medium">Total cost</span>
                          <span className="text-xs tabular-nums text-text-primary font-semibold">
                            {totalUsd != null ? formatUsd(totalUsd) : `${totalEth} ETH`}
                          </span>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Balance preview — simulation or static fallback */}
                  {simResult && simResult.changes.length > 0 ? (
                    <SimulationPreview simResult={simResult} prices={prices} />
                  ) : nativeBalance != null ? (
                    (() => {
                      const txValue = txParams?.value ? BigInt(txParams.value) : 0n;
                      const feeCost = estimatedFeeWei ?? 0n;
                      const changes: BalanceChange[] = [];

                      changes.push({
                        symbol: "ETH",
                        decimals: 18,
                        currentBalance: nativeBalance,
                        delta: -(txValue + feeCost),
                      });

                      if (isApprove && approveToken && txParams?.to) {
                        const tokenBal = tokenBalances.find(
                          (b) => b.asset.contractAddress?.toLowerCase() === txParams.to.toLowerCase()
                        );
                        if (tokenBal) {
                          changes.push({
                            symbol: approveToken.symbol,
                            decimals: approveToken.decimals,
                            currentBalance: tokenBal.balance,
                            delta: 0n,
                          });
                        }
                      }

                      return <BalancePreview changes={changes} prices={prices} />;
                    })()
                  ) : null}
                </div>
              ) : isSolanaTx && decodedSolTx ? (
                <div className="space-y-5">
                  {/* Value hero */}
                  {decodedSolTx.amount && (decodedSolTx.type === "sol_transfer" || decodedSolTx.type === "spl_transfer") && (
                    <div className="text-center py-2">
                      <p className="text-2xl font-semibold tabular-nums text-text-primary">
                        {decodedSolTx.type === "sol_transfer"
                          ? formatLamports(BigInt(decodedSolTx.amount))
                          : decodedSolTx.formattedAmount
                            ? decodedSolTx.formattedAmount
                            : solTokenInfo
                              ? formatSplAmount(BigInt(decodedSolTx.amount), solTokenInfo.decimals)
                              : decodedSolTx.amount}
                        {" "}<span className="text-text-tertiary text-sm">
                          {decodedSolTx.type === "sol_transfer" ? "SOL" : solTokenInfo?.symbol || "tokens"}
                        </span>
                      </p>
                    </div>
                  )}

                  {/* From → To */}
                  <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
                    <div className="px-3 py-2.5 flex items-center justify-between">
                      <span className="text-xs text-text-muted">From</span>
                      <span className="text-xs font-mono text-text-secondary">{account ? shortAddr(account.address) : shortAddr(decodedSolTx.from)}</span>
                    </div>
                    {decodedSolTx.to && (
                      <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                        <span className="text-xs text-text-muted">To</span>
                        <span className="text-xs font-mono text-text-secondary">{shortAddr(decodedSolTx.to)}</span>
                      </div>
                    )}
                    {decodedSolTx.mint && (
                      <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                        <span className="text-xs text-text-muted">Token Mint</span>
                        <span className="text-xs font-mono text-text-muted truncate max-w-[200px]">{shortAddr(decodedSolTx.mint)}</span>
                      </div>
                    )}
                    {decodedSolTx.type === "spl_transfer" && decodedSolTx.amount && (
                      <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                        <span className="text-xs text-text-muted">Amount</span>
                        <span className="text-xs tabular-nums text-text-secondary">
                          {decodedSolTx.formattedAmount
                            ? decodedSolTx.formattedAmount
                            : solTokenInfo
                              ? formatSplAmount(BigInt(decodedSolTx.amount), solTokenInfo.decimals)
                              : decodedSolTx.amount}
                          {" "}{solTokenInfo?.symbol || "tokens"}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Details */}
                  <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
                    {chain && (
                      <div className="px-3 py-2.5 flex items-center justify-between">
                        <span className="text-xs text-text-muted">Network</span>
                        <span className="text-xs text-text-secondary">{chain.displayName}</span>
                      </div>
                    )}
                    {decodedSolTx.type === "contract_call" && decodedSolTx.programId && (
                      <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                        <span className="text-xs text-text-muted">Program</span>
                        <span className="text-xs text-text-secondary truncate max-w-[200px]">
                          {decodedSolTx.programLabel || shortAddr(decodedSolTx.programId)}
                        </span>
                      </div>
                    )}
                    <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                      <span className="text-xs text-text-muted">Estimated fee</span>
                      <div className="text-right">
                        <span className="text-xs tabular-nums text-text-secondary font-medium">0.000005 SOL</span>
                        {(() => { const u = getUsdValue("0.000005", "SOL", prices); return u != null ? <span className="text-[10px] text-text-muted ml-1.5">({formatUsd(u)})</span> : null; })()}
                      </div>
                    </div>
                    {expert && decodedSolTx.numInstructions > 1 && (
                      <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                        <span className="text-xs text-text-muted">Instructions</span>
                        <span className="text-xs tabular-nums text-text-muted">{decodedSolTx.numInstructions}</span>
                      </div>
                    )}
                    {(() => {
                      const fee = 5000n;
                      const solAmount = decodedSolTx.type === "sol_transfer" && decodedSolTx.amount ? BigInt(decodedSolTx.amount) : 0n;
                      const totalLamports = solAmount + fee;
                      const totalSol = Number(totalLamports) / 1e9;
                      const totalUsd = getUsdValue(String(totalSol), "SOL", prices);
                      return (
                        <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
                          <span className="text-xs text-text-muted font-medium">Total cost</span>
                          <span className="text-xs tabular-nums text-text-primary font-semibold">
                            {totalUsd != null ? formatUsd(totalUsd) : `${totalSol.toFixed(9)} SOL`}
                          </span>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Balance preview */}
                  {nativeBalance != null && (
                    (() => {
                      const fee = 5000n; // SOLANA_BASE_FEE in lamports
                      const changes: BalanceChange[] = [];

                      if (decodedSolTx.type === "sol_transfer" && decodedSolTx.amount) {
                        // SOL transfer: deduct amount + fee
                        changes.push({
                          symbol: "SOL",
                          decimals: 9,
                          currentBalance: nativeBalance,
                          delta: -(BigInt(decodedSolTx.amount) + fee),
                        });
                      } else if (decodedSolTx.type === "spl_transfer" && decodedSolTx.amount) {
                        // SPL transfer: SOL fee + token amount
                        changes.push({
                          symbol: "SOL",
                          decimals: 9,
                          currentBalance: nativeBalance,
                          delta: -fee,
                        });
                        const tokenSymbol = solTokenInfo?.symbol || "tokens";
                        const tokenDecimals = decodedSolTx.decimals ?? solTokenInfo?.decimals ?? 0;
                        const tokenBal = tokenBalances.find(
                          (b) => b.asset.contractAddress?.toLowerCase() === decodedSolTx.mint?.toLowerCase()
                        );
                        changes.push({
                          symbol: tokenSymbol,
                          decimals: tokenDecimals,
                          currentBalance: tokenBal?.balance || "0",
                          delta: -BigInt(decodedSolTx.amount),
                        });
                      } else {
                        // contract_call: only fee is known
                        changes.push({
                          symbol: "SOL",
                          decimals: 9,
                          currentBalance: nativeBalance,
                          delta: -fee,
                        });
                      }

                      return <BalancePreview changes={changes} prices={prices} />;
                    })()
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Method badge */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 font-mono">
                      {request.method}
                    </span>
                    {account && (
                      <span className="text-[10px] text-text-muted font-mono">
                        {shortAddr(account.address)}
                      </span>
                    )}
                  </div>

                  {/* Request details */}
                  <div className="bg-surface-tertiary rounded-lg p-3 space-y-2 max-h-60 overflow-y-auto">
                    {requestDisplay.map(({ label, value }, i) => (
                      <div key={i}>
                        <p className="text-[10px] text-text-muted uppercase mb-0.5">{label}</p>
                        <p className="text-xs text-text-primary font-mono break-all">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Signing phase ────────────────────────────────────── */}
          {phase === "signing" && (
            <div className="py-6">
              {/* Spinner */}
              <div className="flex justify-center mb-6">
                <div className="relative w-16 h-16">
                  <svg className="w-16 h-16 animate-spin" viewBox="0 0 50 50" fill="none">
                    <circle cx="25" cy="25" r="20" stroke="currentColor" strokeWidth="3" className="text-surface-tertiary" />
                    <path
                      d="M25 5 A20 20 0 0 1 45 25"
                      stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                      className="text-blue-500"
                    />
                  </svg>
                </div>
              </div>

              {/* Phase label */}
              <p className="text-sm font-medium text-text-primary text-center mb-2">
                {displaySteps[signingStepIdx]?.label ?? "Signing..."}
              </p>

              {/* Progress steps */}
              <div className="space-y-2 max-w-[260px] mx-auto mt-4">
                {displaySteps.map(({ label }, idx) => {
                  const isDone = signingStepIdx > idx;
                  const isCurrent = signingStepIdx === idx;
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
              {txResult?.txHash && chain && signingStepIdx >= 3 && (
                <a
                  href={explorerLink(chain.explorerUrl, `/tx/${txResult.txHash}`)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between mt-5 mx-auto max-w-[260px] px-3 py-2.5 rounded-lg bg-surface-primary/60 border border-border-secondary hover:border-blue-500/30 transition-colors group"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] text-text-muted shrink-0">Tx</span>
                    <span className="text-xs font-mono text-text-secondary truncate">{shortAddr(txResult.txHash)}</span>
                  </div>
                  <svg className="w-3.5 h-3.5 text-text-muted group-hover:text-blue-400 shrink-0 ml-2 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              )}
            </div>
          )}

          {/* ── Done phase ───────────────────────────────────────── */}
          {phase === "done" && txResult && (
            <div className="text-center py-6">
              {txResult.status === "success" ? (
                <>
                  <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
                    <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="text-lg font-semibold text-text-primary mb-1">
                    {isTx ? "Transaction Confirmed" : "Signed"}
                  </p>
                  {isTx && !isSolana && txParams?.value && (
                    <p className="text-sm text-text-muted tabular-nums">
                      {formatWei(BigInt(txParams.value))} {chain?.type === "evm" ? (chain.name?.includes("BASE") ? "ETH" : "ETH") : ""}
                    </p>
                  )}
                  {isSolanaTx && decodedSolTx?.amount && (decodedSolTx.type === "sol_transfer" || decodedSolTx.type === "spl_transfer") && (
                    <p className="text-sm text-text-muted tabular-nums">
                      {decodedSolTx.type === "sol_transfer"
                        ? `${formatLamports(BigInt(decodedSolTx.amount))} SOL`
                        : `${decodedSolTx.formattedAmount || decodedSolTx.amount} ${solTokenInfo?.symbol || "tokens"}`}
                    </p>
                  )}
                </>
              ) : txResult.status === "pending" ? (
                <>
                  <div className="w-14 h-14 rounded-full bg-yellow-500/10 flex items-center justify-center mx-auto mb-4">
                    <svg className="w-7 h-7 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <p className="text-lg font-semibold text-text-primary mb-1">Transaction Broadcast</p>
                  {txParams?.value && (
                    <p className="text-sm text-text-muted tabular-nums mb-1">
                      {formatWei(BigInt(txParams.value))} ETH
                    </p>
                  )}
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
              {txResult.txHash && chain && (
                <div className="mt-5 mx-auto max-w-[280px] rounded-lg bg-surface-primary/60 border border-border-secondary overflow-hidden">
                  <a
                    href={explorerLink(chain.explorerUrl, `/tx/${txResult.txHash}`)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between px-3 py-2.5 hover:bg-surface-tertiary/50 transition-colors group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[11px] text-text-muted shrink-0">Tx</span>
                      <span className="text-xs font-mono text-text-secondary truncate">{shortAddr(txResult.txHash)}</span>
                    </div>
                    <svg className="w-3.5 h-3.5 text-text-muted group-hover:text-blue-400 shrink-0 ml-2 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                  {txResult.blockNumber && (
                    <div className="flex items-center px-3 py-2 border-t border-border-secondary">
                      <span className="text-[11px] text-text-muted shrink-0">{isSolana ? "Slot" : "Block"}</span>
                      <span className="text-xs font-mono text-text-secondary tabular-nums ml-2">
                        {(isSolana ? Number(txResult.blockNumber) : parseInt(txResult.blockNumber, 16)).toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Done footer ────────────────────────────────────────── */}
          {phase === "done" && (
            <div className="px-5 pb-5">
              <button
                onClick={() => {
                  // Navigate to account detail with pending tx info
                  if (account && chain && isTx && txResult?.txHash) {
                    fetchAssets(chain.id).then((chainAssets) => {
                      const native = chainAssets.find((a: Asset) => a.isNative);
                      if (native) {
                        const tx = request.params[0];
                        const value = tx.value ? formatWei(BigInt(tx.value)) : "0";
                        navigate(
                          `/accounts/${account.keyId}/${chain.name.toLowerCase()}/${native.symbol}`,
                          { state: { pendingTx: { hash: txResult.txHash, from: account.address, to: tx.to || "", value, symbol: native.symbol, timestamp: Math.floor(Date.now() / 1000) } } },
                        );
                      }
                    });
                  }
                  (onDismiss ?? onReject)(); // remove from queue without re-rejecting
                }}
                className="w-full bg-surface-tertiary hover:bg-border-primary text-text-secondary text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {/* ── Error phase ──────────────────────────────────────── */}
          {phase === "error" && (
            <SigningError
              error={error}
              title={isTx ? "Transaction Failed" : "Signing Failed"}
              onClose={onReject}
              onRetry={() => { setError(""); setPhase("review"); }}
            />
          )}
        </div>

        {/* Footer — review phase */}
        {phase === "review" && (
          <div className="px-5 py-4 border-t border-border-secondary shrink-0">
            <button
              onClick={handleApproveClick}
              disabled={!account || !keyFile || policyChecking}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
            >
              {policyChecking ? "Checking..." : "👀 Review Transaction"}
            </button>
          </div>
        )}

        {/* Footer — preview phase */}
        {phase === "preview" && (
          <div className="px-5 py-4 border-t border-border-secondary shrink-0">
            <button
              disabled={policyCheck?.allowed === false}
              onClick={() => isRecoveryMode() ? onPasskeyAuth({} as PasskeyAuthResult) : setPhase("passkey")}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
            >
              {policyCheck?.allowed === false ? "\u26D4 Blocked by Policy" : isRecoveryMode() ? "Confirm & Sign" : "\uD83D\uDD10 Confirm & Sign"}
            </button>
          </div>
        )}
      </div>

      {/* Passkey challenge overlay — passkey #2 for MPC signing auth */}
      {phase === "passkey" && (
        <PasskeyChallenge
          onAuthenticated={onPasskeyAuth}
          onCancel={() => setPhase("preview")}
          withPrf={false}
          autoStart
        />
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function formatRequest(request: PendingRequest, expertMode = false): Array<{ label: string; value: string }> {
  switch (request.method) {
    case "personal_sign": {
      const msgHex = request.params[0];
      let decoded: string;
      try {
        const bytes = hexToUint8(msgHex);
        decoded = new TextDecoder().decode(bytes);
      } catch {
        decoded = msgHex;
      }
      return [{ label: "Message", value: decoded }];
    }
    case "eth_sign":
      return [{ label: "Hash", value: request.params[1] }];
    case "eth_signTypedData_v4": {
      const parsed = typeof request.params[1] === "string"
        ? JSON.parse(request.params[1])
        : request.params[1];
      const items: Array<{ label: string; value: string }> = [];
      if (parsed.domain?.name) items.push({ label: "Domain", value: parsed.domain.name });
      if (parsed.domain?.verifyingContract) items.push({ label: "Contract", value: parsed.domain.verifyingContract });
      if (parsed.primaryType) items.push({ label: "Type", value: parsed.primaryType });
      items.push({ label: "Message", value: JSON.stringify(parsed.message, null, 2) });
      return items;
    }
    case "eth_sendTransaction": {
      const tx = request.params[0];
      const items: Array<{ label: string; value: string }> = [];
      if (tx.to) items.push({ label: "To", value: tx.to });
      if (tx.value) {
        const wei = BigInt(tx.value);
        const ethStr = formatWei(wei);
        items.push({ label: "Value", value: `${ethStr} ETH` });
      }
      if (tx.data && tx.data !== "0x") {
        const dataDisplay = expertMode ? tx.data : (tx.data.length > 66 ? tx.data.slice(0, 66) + "..." : tx.data);
        items.push({ label: "Data", value: dataDisplay });
      }
      if (tx.gas || tx.gasLimit) items.push({ label: "Gas Limit", value: String(parseInt(tx.gas || tx.gasLimit, 16)) });
      return items;
    }
    case "solana_signTransaction":
    case "solana_signAndSendTransaction": {
      const items: Array<{ label: string; value: string }> = [];
      items.push({ label: "Transaction", value: request.params?.transaction?.slice(0, 60) + "..." });
      return items;
    }
    case "solana_signMessage": {
      const items: Array<{ label: string; value: string }> = [];
      try {
        const msgBytes = atob(request.params?.message || "");
        items.push({ label: "Message", value: msgBytes });
      } catch {
        items.push({ label: "Message (base64)", value: request.params?.message || "" });
      }
      return items;
    }
    default:
      return [{ label: "Method", value: request.method }, { label: "Params", value: JSON.stringify(request.params) }];
  }
}

function hexToUint8(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function formatWei(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  if (eth === 0) return "0";
  return eth < 0.0001 ? eth.toExponential(2) : eth.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
