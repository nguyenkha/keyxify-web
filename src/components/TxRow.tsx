import { useTranslation } from "react-i18next";
import type { Transaction } from "../lib/transactions";
import { explorerLink } from "../shared/utils";

export function shortAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function formatTxTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

export function TxRow({ tx, explorerUrl, onSpeedUp, chainName, chainIcon }: { tx: Transaction; explorerUrl: string; onSpeedUp?: () => void; chainName?: string; chainIcon?: string | null }) {
  const { t } = useTranslation();
  const isPending = !tx.confirmed;
  const isFailed = !!tx.failed;
  const dirColor = isFailed
    ? "text-red-400"
    : isPending
      ? "text-yellow-400"
      : tx.isDeployment
        ? "text-purple-400"
        : tx.direction === "in"
          ? "text-green-500"
          : tx.direction === "out"
            ? (tx.isApprove ? "text-blue-400" : tx.isContractCall ? "text-orange-400" : "text-red-400")
            : "text-text-muted";
  const dirLabel = isFailed
    ? t("tx.failed")
    : isPending
      ? t("tx.pending")
      : tx.label
        ? (tx.label.startsWith("enabled:") ? t("tx.enabled", { symbol: tx.label.slice(8) })
          : tx.label.startsWith("opt-in:") ? t("tx.optedIn", { symbol: tx.label.slice(7) })
          : tx.label)
        : (tx.isDeployment ? t("tx.deployedContract") : tx.direction === "in" ? t("tx.received") : tx.direction === "out" ? (tx.isApprove ? t("tx.approved") : tx.isContractCall ? t("tx.executedContract") : t("tx.sent")) : t("tx.self"));
  const dirSign = tx.direction === "in" ? "+" : tx.direction === "out" ? "-" : "";

  return (
    <a
      href={explorerLink(explorerUrl, `/tx/${tx.hash}`)}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center px-3 md:px-4 py-3.5 hover:bg-surface-tertiary/50 transition-colors group ${isPending ? "animate-pulse" : ""}`}
    >
      {/* Direction icon */}
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 mr-3 ${
        isFailed
          ? "bg-red-400/10"
          : isPending
            ? "bg-yellow-400/10"
            : tx.isDeployment
              ? "bg-purple-400/10"
              : tx.direction === "in"
                ? "bg-green-500/10"
                : tx.direction === "out"
                  ? (tx.isApprove ? "bg-blue-400/10" : tx.isContractCall ? "bg-orange-400/10" : "bg-red-400/10")
                  : "bg-surface-tertiary"
      }`}>
        {isFailed ? (
          <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : isPending ? (
          <svg className="w-4 h-4 text-yellow-400 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : tx.isDeployment ? (
          <svg className="w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        ) : tx.direction === "in" ? (
          <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        ) : tx.direction === "out" && tx.isApprove ? (
          <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ) : tx.direction === "out" && tx.isContractCall ? (
          <svg className="w-4 h-4 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        ) : tx.direction === "out" ? (
          <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
        ) : (
          <svg className="w-4 h-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
        )}
      </div>

      {/* Label + counterparty + time */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium ${isFailed ? "text-red-400" : isPending ? "text-yellow-400" : "text-text-primary"}`}>{dirLabel}</span>
          <span className="text-[11px] text-text-muted">{isPending ? "just now" : formatTxTime(tx.timestamp)}</span>
        </div>
        <div className="text-[11px] text-text-muted font-mono truncate">
          {tx.isDeployment && tx.createdContract
            ? <span>{t("tx.contractAddr")} <span className="text-purple-400/70">{shortAddr(tx.createdContract)}</span></span>
            : tx.direction === "in" ? `${t("tx.from")} ${shortAddr(tx.from)}` : `${t("tx.to")} ${shortAddr(tx.to)}`}
          <span className="text-text-muted/50 ml-1.5 hidden sm:inline">{shortAddr(tx.hash)}</span>
        </div>
      </div>

      {/* Amount + chain badge */}
      <div className="text-right shrink-0 ml-3">
        {chainName && (
          <div className="flex items-center gap-1 justify-end mb-0.5">
            {chainIcon && <img src={chainIcon} alt="" className="w-3 h-3 rounded-full" />}
            <span className="text-[9px] text-text-muted font-medium">{chainName}</span>
          </div>
        )}
        <div className={`text-sm tabular-nums font-medium ${dirColor}`}>
          {dirSign}{tx.formatted}
        </div>
        <div className="text-[11px] text-text-muted">{tx.symbol}</div>
        {onSpeedUp && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSpeedUp(); }}
            className="inline-flex items-center gap-1 text-[11px] text-yellow-400 hover:text-yellow-300 transition-colors font-medium mt-1"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            {t("tx.speedUp")}
          </button>
        )}
      </div>

      {/* External link icon on hover — hidden on mobile */}
      <div className="w-5 justify-end shrink-0 ml-2 hidden md:flex">
        <svg
          className="w-3 h-3 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </div>
    </a>
  );
}
