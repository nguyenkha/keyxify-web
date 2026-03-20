import type { Chain, Asset } from "../../lib/api";
import type { KeyFile, FeeLevel, SendStep, SigningPhase, TxResult } from "../sendTypes";
import type { UTXO } from "../../lib/chains/btcTx";

export { type UTXO };

export const MAX_UTXO_INPUTS = 10;

export function friendlyError(err: unknown, t?: (key: string) => string): string {
  const msg = (err as { message?: string })?.message || String(err);
  if (msg === "passkey_auth_required") return t ? t("send.passkeySessionExpired") : "Passkey session expired. Please try again.";
  return msg;
}

export interface SigningContext {
  // Props
  keyFile: KeyFile;
  chain: Chain;
  asset: Asset;
  address: string;
  to: string; // resolved address (effectiveTo)
  amount: string;
  onTxSubmitted?: (txHash: string, toAddr: string, amount: string) => void;
  onTxConfirmed?: (txHash: string) => void;

  // Expert overrides
  gasPrice: bigint | null;
  gasLimit: bigint;
  confirmBeforeBroadcast: boolean;
  rbfEnabled: boolean;
  btcFeeRate: number | null;
  bchFeeRate: number | null;
  ltcFeeRate: number | null;
  manualUtxos: UTXO[] | null;
  destinationTag: string; // XRP
  xlmMemo: string; // XLM
  xlmFeeRates: { low: number; medium: number; high: number } | null; // XLM
  feeLevel: FeeLevel;

  // State setters
  setStep: (s: SendStep) => void;
  setSigningPhase: (p: SigningPhase) => void;
  setSignatureCount: (n: number) => void;
  setSigningError: (e: string | null) => void;
  setSignedRawTx: (tx: string | null) => void;
  setTxResult: (r: TxResult | null) => void;
  setPendingTxHash: (h: string | null) => void;
  setKeyFile: (k: KeyFile | null) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setPendingEncrypted: (d: any) => void;

  // i18n
  t: (key: string, opts?: Record<string, unknown>) => string;
}

export interface UtxoFetchContext {
  chain: Chain;
  address: string;
  setAvailableUtxos: (utxos: UTXO[] | null) => void;
  setUtxoLoading: (loading: boolean) => void;
}

export { executeSigningFlow } from "./sign-evm";
export { executeBtcSigningFlow, handleFetchUtxos } from "./sign-btc";
export { executeBchSigningFlow } from "./sign-bch";
export { executeLtcSigningFlow } from "./sign-ltc";
export { executeSolanaSigningFlow } from "./sign-solana";
export { executeXrpSigningFlow } from "./sign-xrp";
export { executeXlmSigningFlow } from "./sign-xlm";
export { executeTronSigningFlow } from "./sign-tron";
