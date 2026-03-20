import {
  EVM_FEE_MULTIPLIER,
  FEE_LABELS,
  formatGwei,
} from "../sendTypes";
import type { FeeLevel } from "../sendTypes";
import type { Chain, Asset } from "../../lib/api";
import type { UTXO } from "../../lib/chains/btcTx";

interface ExpertOverridesProps {
  chain: Chain;
  asset: Asset;
  feeLevel: FeeLevel;
  // EVM overrides
  nonceOverride: string;
  setNonceOverride: (v: string) => void;
  gasLimitOverride: string;
  setGasLimitOverride: (v: string) => void;
  maxFeeOverride: string;
  setMaxFeeOverride: (v: string) => void;
  priorityFeeOverride: string;
  setPriorityFeeOverride: (v: string) => void;
  currentNonce: number | null;
  defaultGasLimit: bigint;
  gasPrice: bigint | null;
  baseGasPrice: bigint | null;
  btcFeeRates: { low: number; medium: number; high: number } | null;
  ltcFeeRates: { low: number; medium: number; high: number } | null;
  bchFeeRates: { low: number; medium: number; high: number } | null;
  // UTXO overrides
  btcFeeRateOverride: string;
  setBtcFeeRateOverride: (v: string) => void;
  rbfEnabled: boolean;
  setRbfEnabled: (v: boolean | ((prev: boolean) => boolean)) => void;
  showUtxoPicker: boolean;
  setShowUtxoPicker: (v: boolean | ((prev: boolean) => boolean)) => void;
  availableUtxos: UTXO[] | null;
  selectedUtxoKeys: Set<string>;
  setSelectedUtxoKeys: (v: Set<string>) => void;
  utxoLoading: boolean;
  handleFetchUtxosCallback: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

export function ExpertOverrides({
  chain,
  asset,
  feeLevel,
  nonceOverride,
  setNonceOverride,
  gasLimitOverride,
  setGasLimitOverride,
  maxFeeOverride,
  setMaxFeeOverride,
  priorityFeeOverride,
  setPriorityFeeOverride,
  currentNonce,
  defaultGasLimit,
  gasPrice,
  baseGasPrice,
  btcFeeRates,
  ltcFeeRates,
  bchFeeRates,
  btcFeeRateOverride,
  setBtcFeeRateOverride,
  rbfEnabled,
  setRbfEnabled,
  showUtxoPicker,
  setShowUtxoPicker,
  availableUtxos,
  selectedUtxoKeys,
  setSelectedUtxoKeys,
  utxoLoading,
  handleFetchUtxosCallback,
  t,
}: ExpertOverridesProps) {
  return (
    <>
      {/* Expert mode: advanced EVM tx overrides */}
      {chain.type === "evm" && (
        <div className="space-y-2">
          <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">{t("common.advanced")}</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-text-muted mb-1">{t("send.nonce")}</label>
              <input
                value={nonceOverride}
                onChange={(e) => setNonceOverride(e.target.value)}
                placeholder={currentNonce != null ? currentNonce.toString() : "..."}
                className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">{t("send.gasLimit")}</label>
              <input
                value={gasLimitOverride}
                onChange={(e) => setGasLimitOverride(e.target.value)}
                placeholder={defaultGasLimit.toString()}
                className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">{t("send.maxFee")}</label>
              <input
                value={maxFeeOverride}
                onChange={(e) => setMaxFeeOverride(e.target.value)}
                placeholder={gasPrice != null ? formatGwei(gasPrice) : "Auto"}
                className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">{t("send.priorityFee")}</label>
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

      {/* Expert mode: advanced UTXO chain overrides */}
      {(chain.type === "btc" || chain.type === "ltc" || chain.type === "bch") && (
        <div className="space-y-2">
          <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">{t("common.advanced")}</p>
          <div>
            <label className="block text-xs text-text-muted mb-1">{t("send.feeRate")}</label>
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
              <span className="text-xs text-text-secondary">{t("send.rbf")}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => { setShowUtxoPicker(v => !v); if (!availableUtxos && !utxoLoading) handleFetchUtxosCallback(); }}
            className="w-full text-left px-2.5 py-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors rounded-lg bg-surface-primary border border-border-primary hover:border-border-secondary"
          >
            {selectedUtxoKeys.size > 0
              ? t("send.utxosSelected", { count: selectedUtxoKeys.size })
              : t("send.selectUtxos")}
          </button>
          {showUtxoPicker && (
            <div className="bg-surface-primary border border-border-primary rounded-xl p-3 space-y-2 max-h-52 overflow-y-auto">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">{t("send.utxos")}</span>
                <div className="flex items-center gap-2">
                  {selectedUtxoKeys.size > 0 && (
                    <button type="button" onClick={() => setSelectedUtxoKeys(new Set())} className="text-[10px] text-text-muted hover:text-text-secondary">
                      {t("send.clear")}
                    </button>
                  )}
                  <button type="button" onClick={handleFetchUtxosCallback} disabled={utxoLoading} className="text-[10px] text-blue-400 hover:text-blue-300 disabled:text-text-muted">
                    {utxoLoading ? t("common.loading") : t("common.refresh")}
                  </button>
                </div>
              </div>
              {utxoLoading && !availableUtxos && (
                <p className="text-[10px] text-text-muted animate-pulse py-2 text-center">{t("send.fetchingUtxos")}</p>
              )}
              {availableUtxos && availableUtxos.length === 0 && (
                <p className="text-[10px] text-text-muted py-2 text-center">{t("send.noUtxos")}</p>
              )}
              {availableUtxos && availableUtxos.length > 0 && (
                <>
                  <div className="flex items-center justify-between text-[10px] text-text-muted">
                    <span>{availableUtxos.length} {t("send.available")}</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedUtxoKeys.size === availableUtxos.length)
                          setSelectedUtxoKeys(new Set());
                        else
                          setSelectedUtxoKeys(new Set(availableUtxos.map(u => `${u.txid}:${u.vout}`)));
                      }}
                      className="text-blue-400 hover:text-blue-300"
                    >
                      {selectedUtxoKeys.size === availableUtxos.length ? t("send.deselectAll") : t("send.selectAll")}
                    </button>
                  </div>
                  {[...availableUtxos].sort((a, b) => b.value - a.value).map((utxo) => {
                    const key = `${utxo.txid}:${utxo.vout}`;
                    const checked = selectedUtxoKeys.has(key);
                    const val = (utxo.value / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
                    return (
                      <label key={key} className={`flex items-start gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${checked ? "bg-blue-500/5" : "hover:bg-surface-secondary"}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const next = new Set(selectedUtxoKeys);
                            if (checked) next.delete(key); else next.add(key);
                            setSelectedUtxoKeys(next);
                          }}
                          className="mt-0.5 accent-blue-500"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-mono text-text-primary truncate max-w-[160px]">
                              {utxo.txid.slice(0, 8)}...{utxo.txid.slice(-6)}:{utxo.vout}
                            </span>
                            <span className="text-[10px] font-mono text-text-secondary ml-2 whitespace-nowrap tabular-nums">
                              {val} {asset.symbol}
                            </span>
                          </div>
                          <span className={`text-[9px] ${utxo.status.confirmed ? "text-green-400" : "text-yellow-400"}`}>
                            {utxo.status.confirmed ? t("send.confirmed") : t("send.unconfirmed")}
                          </span>
                        </div>
                      </label>
                    );
                  })}
                  {selectedUtxoKeys.size > 0 && (
                    <div className="flex items-center justify-between pt-1.5 border-t border-border-primary text-[10px]">
                      <span className="text-text-muted">{t("send.utxosSelected", { count: selectedUtxoKeys.size })}</span>
                      <span className="font-mono text-text-secondary tabular-nums">
                        {(availableUtxos.filter(u => selectedUtxoKeys.has(`${u.txid}:${u.vout}`)).reduce((s, u) => s + u.value, 0) / 1e8)
                          .toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} {asset.symbol}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// Fee level selector used in InputStep (expert 3-grid variant)
interface FeeLevelSelectorProps {
  chain: Chain;
  feeLevel: FeeLevel;
  setFeeLevel: (l: FeeLevel) => void;
  btcFeeRates: { low: number; medium: number; high: number } | null;
  ltcFeeRates: { low: number; medium: number; high: number } | null;
  baseGasPrice: bigint | null;
}

export function ExpertFeeLevelSelector({
  chain,
  feeLevel,
  setFeeLevel,
  btcFeeRates,
  ltcFeeRates,
  baseGasPrice,
}: FeeLevelSelectorProps) {
  return (
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
  );
}
