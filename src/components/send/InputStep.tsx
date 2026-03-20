import { maskBalance } from "../../context/HideBalancesContext";
import { formatUsd } from "../../lib/prices";
import { truncateBalance } from "../sendTypes";
import type { InputStepProps } from "./types";
import { KeyShareSection } from "./KeyShareSection";
import { AddressSection } from "./AddressSection";
import { ExpertOverrides, ExpertFeeLevelSelector } from "./ExpertOverrides";

export function InputStep({
  chain,
  asset,
  address,
  balance,
  expert,
  recovery,
  speedUpData,
  keyFile,
  setKeyFile,
  pendingEncrypted,
  setPendingEncrypted,
  fileInputRef,
  browserShareMode,
  setBrowserShareMode,
  browserShareLoading,
  browserShareError,
  showBrowserPassphrase,
  keyId,
  to,
  setTo,
  resolving,
  resolvedName,
  showAddrScanner,
  setShowAddrScanner,
  showSuggestions,
  setShowSuggestions,
  savingToBook,
  setSavingToBook,
  bookmarkLabel,
  setBookmarkLabel,
  toTouched: _toTouched,
  setToTouched,
  toValid,
  toSelf,
  toError,
  placeholder,
  destinationTag,
  setDestinationTag,
  xlmMemo,
  setXlmMemo,
  amount,
  setAmount,
  amountTouched: _amountTouched,
  setAmountTouched,
  amountCheck: _amountCheck,
  amountError,
  amountUsd,
  maxSendable,
  balancesHidden,
  feeLevel,
  setFeeLevel,
  feeDisplay,
  feeCountdown,
  btcFeeRates,
  ltcFeeRates,
  bchFeeRates,
  baseGasPrice,
  gasPrice,
  defaultGasLimit,
  nonceOverride,
  setNonceOverride,
  gasLimitOverride,
  setGasLimitOverride,
  maxFeeOverride,
  setMaxFeeOverride,
  priorityFeeOverride,
  setPriorityFeeOverride,
  btcFeeRateOverride,
  setBtcFeeRateOverride,
  rbfEnabled,
  setRbfEnabled,
  currentNonce,
  showUtxoPicker,
  setShowUtxoPicker,
  availableUtxos,
  selectedUtxoKeys,
  setSelectedUtxoKeys,
  utxoLoading,
  hasBackup,
  backupGateError,
  setBackupGateError,
  totalUsd: _totalUsd,
  canReview,
  policyChecking,
  handleFileSelect,
  loadBrowserShare,
  onPreview,
  t,
  handleFetchUtxosCallback,
}: InputStepProps) {
  return (
    <>
      {/* Body — Input step */}
      <div className="px-5 pt-3 pb-5 space-y-4">
        <KeyShareSection
          recovery={recovery}
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
          keyId={keyId}
          loadBrowserShare={loadBrowserShare}
          handleFileSelect={handleFileSelect}
          t={t}
        />

        {/* From */}
        <div>
          <label className="block text-xs text-text-muted mb-1.5">{t("send.from")}</label>
          <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5">
            <p className="text-xs font-mono text-text-tertiary truncate">{address}</p>
            <p className="text-[10px] text-text-muted mt-0.5">
              {t("send.balance")}: {maskBalance(truncateBalance(balance), balancesHidden)} {asset.symbol} &middot; {chain.displayName}
            </p>
          </div>
        </div>

        {/* Speed-up banner */}
        {speedUpData && (
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
            <p className="text-xs text-yellow-400 font-medium">{t("send.rbfBanner")}</p>
            <p className="text-[11px] text-yellow-400/70 mt-0.5">{t("send.rbfDesc")}</p>
          </div>
        )}

        <AddressSection
          chain={chain}
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
          setToTouched={setToTouched}
          toValid={toValid}
          toSelf={toSelf}
          toError={toError}
          placeholder={placeholder}
          destinationTag={destinationTag}
          setDestinationTag={setDestinationTag}
          xlmMemo={xlmMemo}
          setXlmMemo={setXlmMemo}
          speedUpData={speedUpData}
          t={t}
        />

        {/* Amount */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs text-text-muted">{t("send.amount")}</label>
            <button
              onClick={() => { setAmount(maxSendable); setAmountTouched(true); }}
              className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              {t("send.max")}
            </button>
          </div>
          <div className="relative">
            <input
              type="text"
              value={amount}
              onChange={(e) => { if (!speedUpData) setAmount(e.target.value); }}
              onBlur={() => setAmountTouched(true)}
              placeholder="0.00"
              readOnly={!!speedUpData}
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

        {/* Fee level selector */}
        {feeDisplay.hasLevelSelector && (
          expert ? (
            <ExpertFeeLevelSelector
              chain={chain}
              feeLevel={feeLevel}
              setFeeLevel={setFeeLevel}
              btcFeeRates={btcFeeRates}
              ltcFeeRates={ltcFeeRates}
              baseGasPrice={baseGasPrice}
            />
          ) : (
            <div className="flex items-center justify-between px-3 py-2 bg-surface-primary border border-border-primary rounded-lg">
              <span className="text-xs text-text-muted">{t("send.networkFee")}</span>
              <span className="text-xs tabular-nums text-text-secondary">
                {feeDisplay.usd != null && feeDisplay.usd > 0
                  ? formatUsd(feeDisplay.usd)
                  : feeDisplay.formatted != null
                    ? `${feeDisplay.formatted} ${feeDisplay.symbol}`
                    : t("common.estimating")}
              </span>
            </div>
          )
        )}

        {/* Expert overrides */}
        {expert && (
          <ExpertOverrides
            chain={chain}
            asset={asset}
            feeLevel={feeLevel}
            nonceOverride={nonceOverride}
            setNonceOverride={setNonceOverride}
            gasLimitOverride={gasLimitOverride}
            setGasLimitOverride={setGasLimitOverride}
            maxFeeOverride={maxFeeOverride}
            setMaxFeeOverride={setMaxFeeOverride}
            priorityFeeOverride={priorityFeeOverride}
            setPriorityFeeOverride={setPriorityFeeOverride}
            currentNonce={currentNonce}
            defaultGasLimit={defaultGasLimit}
            gasPrice={gasPrice}
            baseGasPrice={baseGasPrice}
            btcFeeRates={btcFeeRates}
            ltcFeeRates={ltcFeeRates}
            bchFeeRates={bchFeeRates}
            btcFeeRateOverride={btcFeeRateOverride}
            setBtcFeeRateOverride={setBtcFeeRateOverride}
            rbfEnabled={rbfEnabled}
            setRbfEnabled={setRbfEnabled}
            showUtxoPicker={showUtxoPicker}
            setShowUtxoPicker={setShowUtxoPicker}
            availableUtxos={availableUtxos}
            selectedUtxoKeys={selectedUtxoKeys}
            setSelectedUtxoKeys={setSelectedUtxoKeys}
            utxoLoading={utxoLoading}
            handleFetchUtxosCallback={handleFetchUtxosCallback}
            t={t}
          />
        )}

        {/* Fee summary */}
        <div className="flex items-center justify-between px-1">
          <span className="text-[10px] text-text-muted flex items-center gap-1">
            {t("send.estFee")}
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
            <span className="text-[10px] text-text-muted animate-pulse">{t("common.estimating")}</span>
          )}
        </div>
      </div>

      {/* Footer — Input step */}
      <div className="px-5 py-4 border-t border-border-secondary shrink-0">
        {backupGateError && (
          <p className="text-[11px] text-yellow-400 mb-2">{backupGateError}</p>
        )}
        <button
          disabled={!canReview || policyChecking}
          onClick={async () => {
            if (hasBackup === false && (amountUsd ?? 0) > 100) {
              setBackupGateError(t("send.backupRequired"));
              return;
            }
            setBackupGateError(null);
            await onPreview();
          }}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
        >
          {policyChecking ? t("wc.checking") : t("send.previewButton")}
        </button>
      </div>
    </>
  );
}
