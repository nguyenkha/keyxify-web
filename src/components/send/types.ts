// Shared prop interfaces for SendDialog step components
import type { Chain, Asset } from "../../lib/api";
import type { UTXO } from "../../lib/chains/btcTx";
import type { KeyFile, FeeLevel, TxResult, SigningPhase } from "../sendTypes";
import type { KeyFileData } from "../../lib/crypto";
import type { AddressEntry } from "../../lib/addressBook";
import type { SimulationResult } from "../../lib/txSimulation";

export type { AddressEntry };

export interface FeeDisplay {
  formatted: string | null;
  symbol: string;
  usd: number | null;
  rateLabel: string | null;
  hasLevelSelector: boolean;
  isFixed: boolean;
}

export interface InputStepProps {
  // Chain / asset context
  chain: Chain;
  asset: Asset;
  address: string;
  balance: string;
  expert: boolean;
  recovery: boolean;
  speedUpData?: {
    originalTxid: string;
    to: string;
    amountSats: bigint;
    utxos: { txid: string; vout: number; value: number }[];
    minFeeRate: number;
  };

  // Key share state
  keyFile: KeyFile | null;
  setKeyFile: (kf: KeyFile | null) => void;
  pendingEncrypted: KeyFileData | null;
  setPendingEncrypted: (d: KeyFileData | null) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  browserShareMode: "prf" | "passphrase" | null;
  setBrowserShareMode: (m: "prf" | "passphrase" | null) => void;
  browserShareLoading: boolean;
  browserShareError: string;
  showBrowserPassphrase: boolean;
  setShowBrowserPassphrase: (v: boolean) => void;
  keyId: string;

  // Address / to state
  to: string;
  setTo: (v: string) => void;
  resolving: boolean;
  resolvedName: { input: string; address: string; source: string } | null;
  showAddrScanner: boolean;
  setShowAddrScanner: (v: boolean | ((prev: boolean) => boolean)) => void;
  showSuggestions: boolean;
  setShowSuggestions: (v: boolean | ((prev: boolean) => boolean)) => void;
  savingToBook: boolean;
  setSavingToBook: (v: boolean) => void;
  bookmarkLabel: string;
  setBookmarkLabel: (v: string) => void;
  toTouched: boolean;
  setToTouched: (v: boolean) => void;
  toValid: boolean;
  toSelf: boolean;
  toError: string | null;
  placeholder: string;

  // Destination tag / memo
  destinationTag: string;
  setDestinationTag: (v: string) => void;
  xlmMemo: string;
  setXlmMemo: (v: string) => void;

  // Amount state
  amount: string;
  setAmount: (v: string) => void;
  amountTouched: boolean;
  setAmountTouched: (v: boolean) => void;
  amountCheck: { valid: boolean; error?: string };
  amountError: string | null | undefined;
  amountUsd: number | null;
  maxSendable: string;
  balancesHidden: boolean;

  // Fee state
  feeLevel: FeeLevel;
  setFeeLevel: (l: FeeLevel) => void;
  feeDisplay: FeeDisplay;
  feeCountdown: number;
  btcFeeRates: { low: number; medium: number; high: number } | null;
  ltcFeeRates: { low: number; medium: number; high: number } | null;
  bchFeeRates: { low: number; medium: number; high: number } | null;
  baseGasPrice: bigint | null;
  gasPrice: bigint | null;
  defaultGasLimit: bigint;

  // Expert overrides
  nonceOverride: string;
  setNonceOverride: (v: string) => void;
  gasLimitOverride: string;
  setGasLimitOverride: (v: string) => void;
  maxFeeOverride: string;
  setMaxFeeOverride: (v: string) => void;
  priorityFeeOverride: string;
  setPriorityFeeOverride: (v: string) => void;
  btcFeeRateOverride: string;
  setBtcFeeRateOverride: (v: string) => void;
  rbfEnabled: boolean;
  setRbfEnabled: (v: boolean | ((prev: boolean) => boolean)) => void;
  currentNonce: number | null;

  // UTXO picker
  showUtxoPicker: boolean;
  setShowUtxoPicker: (v: boolean | ((prev: boolean) => boolean)) => void;
  availableUtxos: UTXO[] | null;
  selectedUtxoKeys: Set<string>;
  setSelectedUtxoKeys: (v: Set<string>) => void;
  utxoLoading: boolean;

  // Backup gate
  hasBackup: boolean | null;
  backupGateError: string | null;
  setBackupGateError: (v: string | null) => void;

  // Misc
  totalUsd: number;
  canReview: boolean;
  policyChecking: boolean;

  // Callbacks
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  loadBrowserShare: () => void;
  guardedSign: (action: () => void) => void;
  onClose: () => void;
  onPreview: () => Promise<void>;

  // i18n
  t: (key: string, opts?: Record<string, unknown>) => string;

  // UTXO fetch
  handleFetchUtxosCallback: () => void;
}

export interface PreviewStepProps {
  chain: Chain;
  asset: Asset;
  address: string;
  to: string; // effectiveTo
  amount: string;
  expert: boolean;

  feeDisplay: FeeDisplay;
  gasLimit: bigint;
  gasLimitOverride: string;
  maxFeeOverride: string;
  estimatedGas: bigint | null;
  baseGasPrice: bigint | null;
  gasEstimateError: string | null;
  estimatedFeeWei: bigint | null;

  xlmDestExists: boolean | null;
  destinationTag: string;
  xlmMemo: string;

  policyCheck: {
    allowed: boolean;
    reason?: string;
    fraudCheck?: { flagged: boolean; flags: string[]; level: string; address: string };
  } | null;
  simResult: SimulationResult | null;

  manualUtxos: UTXO[] | null;
  rbfEnabled: boolean;
  currentNonce: number | null;

  totalUsd: number;
  amountUsd: number | null;
  balancesHidden: boolean;

  // Fee-related for balance preview
  btcEstimatedFee: bigint | null;
  ltcEstimatedFee: bigint | null;
  bchEstimatedFee: bigint | null;
  prices: Record<string, number>;
  balance: string;

  setStep: (step: import("../sendTypes").SendStep) => void;
  guardedSign: (action: () => void) => void;
  signingFlows: {
    executeEvm: () => void;
    executeBtc: () => void;
    executeLtc: () => void;
    executeBch: () => void;
    executeSolana: () => void;
    executeXrp: () => void;
    executeXlm: () => void;
    executeTron: () => void;
  };
  setSigningError: (e: string | null) => void;

  t: (key: string, opts?: Record<string, unknown>) => string;
}

export interface ResultStepProps {
  chain: Chain;
  asset: Asset;
  to: string;
  amount: string;

  txResult: TxResult;
  signedRawTx: string | null;
  confirmBeforeBroadcast: boolean;

  onClose: () => void;
  onTxSubmitted?: (txHash: string, toAddr: string, amount: string) => void;
  onTxConfirmed?: (txHash: string) => void;

  // Broadcast state setters
  setSignedRawTx: (v: string | null) => void;
  setTxResult: (v: TxResult | null) => void;
  setStep: (step: import("../sendTypes").SendStep) => void;
  setSigningPhase: (p: SigningPhase) => void;
  setSigningError: (e: string | null) => void;
  setPendingTxHash: (h: string | null) => void;

  t: (key: string, opts?: Record<string, unknown>) => string;
}
