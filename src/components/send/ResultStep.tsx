import { explorerLink } from "../../shared/utils";
import { shortAddrPreview } from "../sendTypes";
import { mempoolApiUrl, broadcastBtcTx, waitForBtcConfirmation } from "../../lib/chains/btcTx";
import { broadcastTransaction, waitForReceipt } from "../../lib/chains/evmTx";
import { broadcastSolanaTransaction, waitForSolanaConfirmation } from "../../lib/chains/solanaTx";
import { broadcastXrpTransaction, waitForXrpConfirmation } from "../../lib/chains/xrpTx";
import { broadcastXlmTransaction, waitForXlmConfirmation } from "../../lib/chains/xlmTx";
import { broadcastTronTransaction, waitForTronConfirmation } from "../../lib/chains/tronTx";
import { friendlyError } from "./signing-flows";
import type { ResultStepProps } from "./types";
import type { Chain } from "../../lib/api";
import type { TxResult, SigningPhase } from "../sendTypes";

async function broadcastAndConfirm(
  rawTx: string,
  chain: Chain,
  to: string,
  amount: string,
  callbacks: {
    onTxSubmitted?: (txHash: string, toAddr: string, amount: string) => void;
    onTxConfirmed?: (txHash: string) => void;
    setSigningPhase: (p: SigningPhase) => void;
    setTxResult: (v: TxResult | null) => void;
    setStep: (step: import("../sendTypes").SendStep) => void;
    setPendingTxHash: (h: string | null) => void;
    setSigningError: (e: string | null) => void;
    setSignedRawTx: (v: string | null) => void;
    t: (key: string, opts?: Record<string, unknown>) => string;
  },
): Promise<void> {
  const {
    onTxSubmitted, onTxConfirmed,
    setSigningPhase, setTxResult, setStep, setPendingTxHash, setSigningError, setSignedRawTx, t,
  } = callbacks;

  // Transition back to signing step with broadcast → confirm progress
  setSignedRawTx(null);
  setTxResult(null);
  setStep("signing");
  setSigningPhase("broadcasting");
  setSigningError(null);

  try {
    let txHash: string;

    if (chain.type === "btc") {
      txHash = await broadcastBtcTx(rawTx, mempoolApiUrl(chain.explorerUrl));
    } else if (chain.type === "ltc") {
      const ltcTx = await import("../../lib/chains/ltcTx");
      txHash = await ltcTx.broadcastLtcTx(rawTx, ltcTx.ltcApiUrl(chain.explorerUrl));
    } else if (chain.type === "bch") {
      const bchTx = await import("../../lib/chains/bchTx");
      txHash = await bchTx.broadcastBchTx(rawTx, bchTx.bchApiUrl());
    } else if (chain.type === "evm") {
      txHash = await broadcastTransaction(chain.rpcUrl, rawTx);
    } else if (chain.type === "solana") {
      txHash = await broadcastSolanaTransaction(chain.rpcUrl, rawTx);
    } else if (chain.type === "xrp") {
      txHash = await broadcastXrpTransaction(chain.rpcUrl, rawTx);
    } else if (chain.type === "xlm") {
      txHash = await broadcastXlmTransaction(chain.rpcUrl, rawTx);
    } else if (chain.type === "tron") {
      txHash = await broadcastTronTransaction(chain.rpcUrl, rawTx);
    } else {
      throw new Error(`Unsupported chain type: ${chain.type}`);
    }

    onTxSubmitted?.(txHash, to, amount);
    setPendingTxHash(txHash);
    setSigningPhase("polling");

    let confirmed = false;
    let blockHeight: number | undefined;

    if (chain.type === "btc") {
      const r = await waitForBtcConfirmation(txHash, () => {}, 60, 5000, mempoolApiUrl(chain.explorerUrl));
      confirmed = r.confirmed; blockHeight = r.blockHeight;
    } else if (chain.type === "ltc") {
      const ltcTx = await import("../../lib/chains/ltcTx");
      const r = await ltcTx.waitForLtcConfirmation(txHash, () => {}, 60, 5000, ltcTx.ltcApiUrl(chain.explorerUrl));
      confirmed = r.confirmed; blockHeight = r.blockHeight;
    } else if (chain.type === "bch") {
      const bchTx = await import("../../lib/chains/bchTx");
      const r = await bchTx.waitForBchConfirmation(txHash, () => {}, 60, 5000, bchTx.bchApiUrl());
      confirmed = r.confirmed; blockHeight = r.blockHeight;
    } else if (chain.type === "evm") {
      const r = await waitForReceipt(chain.rpcUrl, txHash, () => {}, 60, 3000);
      confirmed = r.status === "success"; blockHeight = r.blockNumber ? parseInt(String(r.blockNumber)) : undefined;
    } else if (chain.type === "solana") {
      const r = await waitForSolanaConfirmation(chain.rpcUrl, txHash, () => {}, 60, 2000);
      confirmed = r.confirmed;
    } else if (chain.type === "xrp") {
      const r = await waitForXrpConfirmation(chain.rpcUrl, txHash, () => {}, 30, 3000);
      confirmed = r.confirmed;
    } else if (chain.type === "xlm") {
      const r = await waitForXlmConfirmation(chain.rpcUrl, txHash, () => {}, 30, 3000);
      confirmed = r.confirmed;
    } else if (chain.type === "tron") {
      const r = await waitForTronConfirmation(chain.rpcUrl, txHash, () => {}, 30, 3000);
      confirmed = r.confirmed; blockHeight = r.blockNumber;
    }

    setTxResult({
      status: confirmed ? "success" : "pending",
      txHash,
      blockNumber: blockHeight,
    });
    if (confirmed) onTxConfirmed?.(txHash);
    setStep("result");
  } catch (err: unknown) {
    setSigningError(friendlyError(err, t));
  }
}

export function ResultStep({
  chain,
  asset,
  to,
  amount,
  txResult,
  signedRawTx,
  confirmBeforeBroadcast,
  onClose,
  onTxSubmitted,
  onTxConfirmed,
  setSignedRawTx,
  setTxResult,
  setStep,
  setSigningPhase,
  setSigningError,
  setPendingTxHash,
  t,
}: ResultStepProps) {
  return (
    <div className="p-5">
      <div className="text-center py-6">
        {confirmBeforeBroadcast && signedRawTx ? (
          <>
            <div className="w-14 h-14 rounded-full bg-blue-500/10 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-lg font-semibold text-text-primary mb-1">{t("send.rawTx")}</p>
            <p className="text-xs text-text-muted mb-3">
              {t("send.copyRaw")}
            </p>
            <div className="text-left bg-surface-secondary rounded-lg border border-border-primary p-3 max-h-32 overflow-auto">
              <p className="text-[11px] font-mono text-text-secondary break-all select-all">{signedRawTx}</p>
            </div>
            <div className="flex items-center justify-center gap-3 mt-3">
              <button
                onClick={() => { navigator.clipboard.writeText(signedRawTx); }}
                className="text-xs text-text-muted hover:text-text-secondary transition-colors font-medium"
              >
                {t("common.copy")}
              </button>
              {confirmBeforeBroadcast && (
                <button
                  onClick={() => broadcastAndConfirm(signedRawTx, chain, to, amount, {
                    onTxSubmitted,
                    onTxConfirmed,
                    setSigningPhase,
                    setTxResult,
                    setStep,
                    setPendingTxHash,
                    setSigningError,
                    setSignedRawTx,
                    t,
                  })}
                  className="px-4 py-1.5 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  📡 {t("send.broadcast")}
                </button>
              )}
            </div>
          </>
        ) : txResult.status === "success" ? (
          <>
            <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-lg font-semibold text-text-primary mb-1">{t("send.txSuccess")}</p>
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
            <p className="text-lg font-semibold text-text-primary mb-1">{t("send.txBroadcast")}</p>
            <p className="text-sm text-text-muted tabular-nums mb-1">
              {amount} {asset.symbol}
            </p>
            <p className="text-[11px] text-text-muted">{t("send.confirming")}...</p>
          </>
        ) : (
          <>
            <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="text-lg font-semibold text-text-primary mb-1">{t("send.txFailed")}</p>
            <p className="text-sm text-text-muted">{t("send.failed")}</p>
          </>
        )}

        {/* Transaction details card */}
        {!confirmBeforeBroadcast && (
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
                <span className="text-[11px] text-text-muted shrink-0">{t("wc.block")}</span>
                <span className="text-xs font-mono text-text-secondary tabular-nums ml-2">
                  {(typeof txResult.blockNumber === "number" ? txResult.blockNumber : parseInt(txResult.blockNumber, 16)).toLocaleString()}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-border-secondary pt-4">
        <button
          onClick={onClose}
          className="w-full bg-surface-tertiary hover:bg-border-primary text-text-secondary text-sm font-medium py-2.5 rounded-lg transition-colors"
        >
          {t("common.done")}
        </button>
      </div>
    </div>
  );
}
