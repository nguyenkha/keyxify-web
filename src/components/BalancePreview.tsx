import { getUsdValue, formatUsd } from "../lib/prices";

export interface BalanceChange {
  symbol: string;
  decimals: number;
  currentBalance: string; // raw base units as string
  delta: bigint;          // negative = outgoing, positive = incoming
}

function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  let result: string;
  if (frac === 0n) {
    result = whole.toString();
  } else {
    const fracStr = frac.toString().padStart(decimals, "0").slice(0, 8).replace(/0+$/, "");
    result = `${whole}.${fracStr}`;
  }
  return negative ? `-${result}` : result;
}

export function BalancePreview({
  changes,
  prices,
}: {
  changes: BalanceChange[];
  prices: Record<string, number>;
}) {
  if (changes.length === 0) return null;

  return (
    <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
      {changes.map((change, i) => {
        const currentBal = BigInt(change.currentBalance);
        const afterBal = currentBal + change.delta;
        const deltaFormatted = formatUnits(change.delta, change.decimals);
        const isNegative = change.delta < 0n;
        const isPositive = change.delta > 0n;
        const deltaUsd = (() => {
          const absDelta = change.delta < 0n ? -change.delta : change.delta;
          const absFormatted = formatUnits(absDelta, change.decimals);
          return getUsdValue(absFormatted, change.symbol, prices);
        })();

        return (
          <div key={change.symbol} className={i > 0 ? "border-t border-border-secondary" : ""}>
            <div className="px-3 py-2 flex items-center justify-between">
              <span className="text-xs text-text-muted">{change.symbol}</span>
              <div className="text-right">
                <div className={`text-[11px] tabular-nums font-medium ${isNegative ? "text-red-400" : isPositive ? "text-green-400" : "text-text-muted"}`}>
                  {isPositive ? "+" : ""}{deltaFormatted} {change.symbol}
                </div>
                {deltaUsd != null && deltaUsd > 0 && (
                  <div className="text-[10px] text-text-muted tabular-nums">
                    {formatUsd(deltaUsd)}
                  </div>
                )}
                {afterBal < 0n && (
                  <div className="text-[10px] text-red-400">Insufficient</div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
