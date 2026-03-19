import { formatUsd } from "../lib/prices";
import { useHideBalances } from "../context/HideBalancesContext";

interface PortfolioHeaderProps {
  totalUsd: number;
  loading: boolean;
}

/** Displays total portfolio value in USD at the top of the wallet overview */
export function PortfolioHeader({ totalUsd, loading }: PortfolioHeaderProps) {
  const { hidden } = useHideBalances();

  return (
    <div className="text-center py-4">
      <p className="text-[11px] text-text-muted uppercase tracking-wider font-semibold mb-1">
        Portfolio Value
      </p>
      {loading && totalUsd === 0 ? (
        <div className="h-8 w-32 bg-surface-tertiary rounded animate-pulse mx-auto" />
      ) : (
        <p className="text-2xl font-semibold text-text-primary tabular-nums">
          {hidden ? "••••••" : formatUsd(totalUsd)}
        </p>
      )}
    </div>
  );
}
