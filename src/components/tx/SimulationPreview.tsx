// Shared simulation result display for Send/WC preview
// Uses same visual format as BalancePreview for consistency

import type { SimulationResult } from "../../lib/txSimulation";
import { getUsdValue, formatUsd } from "../../lib/prices";

export function SimulationPreview({ simResult, prices }: { simResult: SimulationResult; prices?: Record<string, number> }) {
  if (simResult.changes.length === 0) return null;

  return (
    <div>
      <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
        {simResult.changes.map((c, i) => {
          const usd = prices ? getUsdValue(c.amount, c.asset.symbol, prices) : null;
          return (
            <div key={i} className={i > 0 ? "border-t border-border-secondary" : ""}>
              <div className="px-3 py-2 flex items-center justify-between">
                <span className="text-xs text-text-muted">{c.asset.symbol}</span>
                <div className="text-right">
                  <div className={`text-[11px] tabular-nums font-medium ${c.direction === "out" ? "text-red-400" : "text-green-400"}`}>
                    {c.direction === "out" ? "-" : "+"}{c.amount} {c.asset.symbol}
                  </div>
                  {usd != null && usd > 0 && (
                    <div className="text-[10px] text-text-muted tabular-nums">
                      {formatUsd(usd)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-text-muted/50 mt-1.5 text-right">
        Simulated via {simResult.provider.charAt(0).toUpperCase() + simResult.provider.slice(1)}
      </p>
    </div>
  );
}
