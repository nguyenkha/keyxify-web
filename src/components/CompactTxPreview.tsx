import type { Transaction } from "../shared/types";
import { explorerLink } from "../shared/utils";
import { formatTxTime, shortAddr } from "./TxRow";

/** Compact single-line tx preview for account row (max 3 shown) */
export function CompactTxPreview({ tx, explorerUrl }: { tx: Transaction; explorerUrl: string }) {
  const isPending = !tx.confirmed;
  const isFailed = !!tx.failed;
  const label = isFailed
    ? "Failed"
    : isPending
      ? "Pending"
      : tx.isDeployment
        ? "Deployed"
        : tx.isApprove
          ? "Approved"
          : tx.isContractCall
            ? "Contract"
            : tx.direction === "in" ? "Received" : tx.direction === "out" ? "Sent" : "Self";
  const color = isFailed
    ? "text-red-400"
    : isPending
      ? "text-yellow-400"
      : tx.isDeployment
        ? "text-purple-400"
        : tx.isApprove
          ? "text-blue-400"
          : tx.isContractCall
            ? "text-orange-400"
            : tx.direction === "in" ? "text-green-500" : "text-red-400";
  const dotColor = isFailed
    ? "bg-red-400"
    : isPending
      ? "bg-yellow-400"
      : tx.isDeployment
        ? "bg-purple-400"
        : tx.isApprove
          ? "bg-blue-400"
          : tx.isContractCall
            ? "bg-orange-400"
            : tx.direction === "in" ? "bg-green-500" : "bg-red-400";
  const sign = tx.isDeployment || tx.isApprove ? "" : tx.direction === "in" ? "+" : tx.direction === "out" ? "-" : "";

  // For deployments, show contract address; for others show counterparty
  const counterparty = tx.isDeployment && tx.createdContract
    ? shortAddr(tx.createdContract)
    : tx.direction === "in" ? `from ${shortAddr(tx.from)}` : `to ${shortAddr(tx.to)}`;

  // Hide "0 ETH" for deployments and approvals — show gas cost isn't useful here
  const showAmount = !tx.isDeployment && !tx.isApprove;

  return (
    <a
      href={explorerLink(explorerUrl, `/tx/${tx.hash}`)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-2 pl-8 md:pl-12 pr-3 md:pr-5 py-1.5 hover:bg-surface-tertiary/30 transition-colors"
    >
      {/* Direction dot */}
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />

      {/* Label + counterparty */}
      <span className="text-[11px] text-text-muted truncate flex-1">
        <span className={`font-medium ${color}`}>{label}</span>
        <span className="text-text-muted/60 ml-1.5">{counterparty}</span>
      </span>

      {/* Amount + time */}
      {showAmount && (
        <span className={`text-[11px] tabular-nums font-medium shrink-0 ${color}`}>
          {sign}{tx.formatted} {tx.symbol}
        </span>
      )}
      <span className="text-[10px] text-text-muted/50 shrink-0 w-12 text-right">
        {formatTxTime(tx.timestamp)}
      </span>
    </a>
  );
}
