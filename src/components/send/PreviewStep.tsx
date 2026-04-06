import { PolicyWarning, ExpertWarnings, SimulationPreview } from "../tx";
import { BalancePreview, type BalanceChange } from "../BalancePreview";
import { formatUsd } from "../../lib/prices";
import { bytesToHex } from "../../shared/utils";
import { encodeErc20Transfer, parseUnits } from "../../lib/chains/evmTx";
import { SOLANA_BASE_FEE } from "../../lib/chains/solanaTx";
import { XRP_BASE_FEE } from "../../lib/chains/xrpTx";
import { EVM_FEE_MULTIPLIER } from "../sendTypes";
import type { PreviewStepProps } from "./types";
import { Lock } from "lucide-react";

export function PreviewStep({
  chain,
  asset,
  address,
  to,
  amount,
  expert,
  feeDisplay,
  gasLimit,
  gasLimitOverride,
  maxFeeOverride,
  estimatedGas,
  baseGasPrice,
  gasEstimateError,
  estimatedFeeWei,
  xlmDestExists,
  destinationTag,
  xlmMemo,
  policyCheck,
  simResult,
  manualUtxos,
  rbfEnabled,
  currentNonce: _currentNonce,
  totalUsd,
  amountUsd,
  balancesHidden: _balancesHidden,
  btcEstimatedFee,
  ltcEstimatedFee,
  bchEstimatedFee,
  prices,
  balance,
  setStep: _setStep,
  guardedSign,
  signingFlows,
  setSigningError,
  confirmBeforeBroadcast,
  t,
}: PreviewStepProps) {
  return (
    <>
      {/* Body — Preview step */}
      <div className="p-5 space-y-5">
        <PolicyWarning policyCheck={policyCheck} />

        {chain.type === "evm" && gasEstimateError && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            <p className="text-xs text-red-400 leading-relaxed">
              {t("send.gasEstFailed")}: {gasEstimateError}
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
            <span className="text-xs text-text-muted">{t("send.from")}</span>
            <span className="text-[9px] font-mono text-text-secondary">{address}</span>
          </div>
          <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-text-muted">{t("send.to")}</span>
              {expert && !asset.isNative && asset.contractAddress && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 font-medium">{t("send.contract")}</span>
              )}
            </div>
            <span className="text-[9px] font-mono text-text-secondary">
              {expert && !asset.isNative && asset.contractAddress
                ? asset.contractAddress
                : to}
            </span>
          </div>
          {expert && !asset.isNative && asset.contractAddress && (
            <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
              <span className="text-xs text-text-muted">{t("send.to")}</span>
              <span className="text-[9px] font-mono text-text-secondary">{to}</span>
            </div>
          )}
          {expert && !asset.isNative && asset.contractAddress && (
            <div className="border-t border-border-secondary px-3 py-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">{t("send.data")}</span>
              </div>
              <pre className="text-[10px] font-mono text-text-muted break-all mt-1 leading-relaxed max-h-20 overflow-auto">
                {"0x" + bytesToHex(encodeErc20Transfer(to, parseUnits(amount, asset.decimals)) as Uint8Array)}
              </pre>
            </div>
          )}
          {destinationTag && (
            <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
              <span className="text-xs text-text-muted">{t("send.destinationTag")}</span>
              <span className="text-xs tabular-nums text-text-secondary">{destinationTag}</span>
            </div>
          )}
          {chain.type === "xlm" && xlmMemo && (
            <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
              <span className="text-xs text-text-muted">{t("send.memo")}</span>
              <span className="text-xs text-text-secondary">{xlmMemo}</span>
            </div>
          )}
        </div>
        {chain.type === "xlm" && xlmDestExists === false && (
          <p className="text-[10px] text-yellow-400 -mt-3">{t("send.xlmDestNotActive")}</p>
        )}

        {/* Details */}
        <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
          <div className="px-3 py-2.5 flex items-center justify-between">
            <span className="text-xs text-text-muted">{t("send.network")}</span>
            <span className="text-xs text-text-secondary">{chain.displayName}</span>
          </div>
          <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
            <span className="text-xs text-text-muted">{t("send.networkFee")}</span>
            <span className="text-xs tabular-nums text-text-secondary font-medium">
              {feeDisplay.usd != null && feeDisplay.usd > 0
                ? formatUsd(feeDisplay.usd)
                : (feeDisplay.formatted ?? "—") + " " + feeDisplay.symbol}
            </span>
          </div>
          {expert && feeDisplay.rateLabel != null && (
            <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
              <span className="text-xs text-text-muted">
                {chain.type === "btc" || chain.type === "ltc" || chain.type === "bch"
                  ? t("send.feeRate")
                  : chain.type === "xlm"
                    ? t("send.baseFee")
                    : t("send.maxFee")}
              </span>
              <span className="text-xs tabular-nums text-text-muted">{feeDisplay.rateLabel}</span>
            </div>
          )}
          {expert && chain.type === "evm" && (
            <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
              <span className="text-xs text-text-muted">{t("send.gasLimit")}</span>
              <span className="text-xs tabular-nums text-text-muted">{gasLimit.toLocaleString()}</span>
            </div>
          )}
          {expert && manualUtxos && (chain.type === "btc" || chain.type === "ltc" || chain.type === "bch") && (
            <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
              <span className="text-xs text-text-muted">{t("send.utxos")}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-blue-500/10 text-blue-400">
                {t("send.utxosSelected", { count: manualUtxos.length })}
              </span>
            </div>
          )}
          {expert && (chain.type === "btc" || chain.type === "ltc") && (
            <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
              <span className="text-xs text-text-muted">{t("send.rbf")}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${rbfEnabled ? "bg-blue-500/10 text-blue-400" : "bg-surface-tertiary text-text-muted"}`}>
                {rbfEnabled ? t("xlm.enabled") : t("wallet.disabled")}
              </span>
            </div>
          )}
          <div className="border-t border-border-secondary px-3 py-2.5 flex items-center justify-between">
            <span className="text-xs text-text-muted font-medium">{t("send.total")}</span>
            <span className="text-xs tabular-nums text-text-primary font-semibold">
              {totalUsd > 0 ? formatUsd(totalUsd) : `${amount} ${asset.symbol}`}
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
            else if (chain.type === "btc" && btcEstimatedFee != null) feeCost = btcEstimatedFee;
            else if (chain.type === "ltc" && ltcEstimatedFee != null) feeCost = ltcEstimatedFee;
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
      <div className="px-5 py-4 border-t border-border-secondary shrink-0">
        <button
          disabled={policyCheck?.allowed === false}
          onClick={() => {
            const { executeEvm, executeBtc, executeLtc, executeBch, executeSolana, executeXrp, executeXlm, executeTron, executeTon, executeAlgo, executeAda } = signingFlows;
            const flows: Record<string, () => void> = {
              solana: executeSolana,
              btc: executeBtc,
              ltc: executeLtc,
              bch: executeBch,
              evm: executeEvm,
              xrp: executeXrp,
              xlm: executeXlm,
              tron: executeTron,
              ton: executeTon,
              algo: executeAlgo,
              ada: executeAda,
            };
            const flow = flows[chain.type];
            if (flow) guardedSign(flow);
            else setSigningError(`Send is not yet supported for ${chain.displayName}.`);
          }}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
        >
          {policyCheck?.allowed === false ? <><Lock className="w-4 h-4 inline-block align-[-2px] mr-1" />{t("send.blockedByPolicy")}</> : <><Lock className="w-4 h-4 inline-block align-[-2px] mr-1" />{t(confirmBeforeBroadcast ? "send.confirmSign" : "send.confirmSend")}</>}
        </button>
      </div>
    </>
  );
}
