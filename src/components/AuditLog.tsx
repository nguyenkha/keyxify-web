import { useState, useEffect } from "react";
import { authHeaders } from "../lib/auth";
import { apiUrl } from "../lib/apiBase";

interface AuditEntry {
  id: string;
  action: string;
  keyShareId?: string | null;
  keyName?: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/** Human-readable explanation of an audit log entry */
function describeEntry(entry: AuditEntry): { title: string; detail: string; icon: string; color: string } {
  const meta = entry.meta ?? {};
  const reason = meta.reason as string | undefined;

  switch (entry.action) {
    case "sign.init":
      return {
        title: "Transaction signed",
        detail: describeTransaction(meta),
        icon: "\u2713", // ✓
        color: "text-green-400",
      };
    case "sign.complete":
      return {
        title: "Signature completed",
        detail: "Transaction co-signed successfully.",
        icon: "\u2713",
        color: "text-green-400",
      };
    case "sign.reject":
      return describeRejection(reason, meta);
    case "generate.init":
    case "generate-eddsa.init":
      return {
        title: "Key generation started",
        detail: "A new account key is being created.",
        icon: "\u26A1",
        color: "text-blue-400",
      };
    case "generate.complete":
    case "generate-eddsa.complete":
      return {
        title: "Key created",
        detail: "Your account key was successfully generated.",
        icon: "\u2713",
        color: "text-green-400",
      };
    case "backup.upload":
      return {
        title: "Backup saved",
        detail: "Your encrypted key backup was uploaded.",
        icon: "\uD83D\uDCBE",
        color: "text-blue-400",
      };
    case "backup.download":
      return {
        title: "Backup downloaded",
        detail: "Your encrypted key backup was downloaded.",
        icon: "\u2B07",
        color: "text-yellow-400",
      };
    case "server-share.hkdf-download":
      return {
        title: "Server share downloaded",
        detail: "The server's key share was exported with encryption.",
        icon: "\u2B07",
        color: "text-yellow-400",
      };
    case "server-share.export":
      return {
        title: "Self-custody export",
        detail: "The server's key share was exported. You now have full self-custody.",
        icon: "\uD83D\uDD11",
        color: "text-orange-400",
      };
    default:
      return {
        title: entry.action,
        detail: "",
        icon: "\u2022",
        color: "text-text-muted",
      };
  }
}

function describeTransaction(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  const chainType = meta.chainType as string | undefined;
  if (chainType) parts.push(`on ${chainType.toUpperCase()}`);

  const transfer = meta.transfer as Record<string, string> | undefined;
  if (transfer) {
    const to = transfer.to;
    const symbol = transfer.nativeSymbol || "tokens";
    parts.push(`sent ${symbol} to ${shortenAddress(to)}`);
  } else if (meta.type === "raw_message") {
    return "Signed a message.";
  }

  return parts.length > 0 ? parts.join(" ") : "Transaction initiated.";
}

function describeRejection(reason: string | undefined, meta: Record<string, unknown>): {
  title: string; detail: string; icon: string; color: string;
} {
  const base = { icon: "\u2717", color: "text-red-400" }; // ✗

  switch (reason) {
    case "key_disabled":
      return {
        ...base,
        title: "Blocked \u2014 account disabled",
        detail: "This transaction was rejected because your account is disabled. You can re-enable it in account settings.",
      };
    case "not_owner":
      return {
        ...base,
        title: "Blocked \u2014 unauthorized",
        detail: "Someone tried to sign with your key from a different account.",
      };
    case "sighash_mismatch":
      return {
        ...base,
        title: "Blocked \u2014 invalid transaction",
        detail: "The transaction data didn't match its hash. This could indicate tampering.",
      };
    case "unsupported_asset":
      return {
        ...base,
        title: "Blocked \u2014 unsupported token",
        detail: "The token being transferred is not supported by this wallet.",
      };
    case "policy": {
      const fraudCheck = meta.fraudCheck as { flagged?: boolean; flags?: string[]; level?: string; address?: string } | undefined;
      if (fraudCheck?.flagged) {
        const flagLabels = (fraudCheck.flags || []).map(humanizeFlag).join(", ");
        return {
          ...base,
          title: "Blocked \u2014 risky address detected",
          detail: `The recipient address ${shortenAddress(fraudCheck.address || "")} was flagged for: ${flagLabels}. This is based on your fraud check setting (${levelLabel(fraudCheck.level)}).`,
        };
      }

      const priority = meta.rulePriority;
      if (priority === "default_deny") {
        return {
          ...base,
          title: "Blocked \u2014 no matching rule",
          detail: "No policy rule matched this transaction. By default, unmatched transactions are blocked. You can add a rule in Policy Rules settings.",
        };
      }
      return {
        ...base,
        title: "Blocked \u2014 policy rule",
        detail: `Your policy rule #${priority} blocked this transaction. You can adjust your rules in Policy Rules settings.`,
      };
    }
    default:
      return {
        ...base,
        title: "Transaction rejected",
        detail: reason ? `Reason: ${reason}` : "This transaction was not approved.",
      };
  }
}

function humanizeFlag(flag: string): string {
  const labels: Record<string, string> = {
    sanctioned: "sanctioned entity",
    cybercrime: "cybercrime",
    stealing_attack: "theft/exploit",
    blackmail_activities: "blackmail",
    money_laundering: "money laundering",
    financial_crime: "financial crime",
    phishing_activities: "phishing",
    darkweb_transactions: "darkweb activity",
    mixer: "mixing service",
    honeypot_related_address: "honeypot related",
    malicious_mining_activities: "malicious mining",
  };
  return labels[flag] || flag.replace(/_/g, " ");
}

function levelLabel(level?: string): string {
  if (level === "high") return "Standard";
  if (level === "medium") return "Strict";
  if (level === "low") return "Maximum";
  return level || "unknown";
}

function shortenAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function EntryRow({ entry, showAccount }: { entry: AuditEntry; showAccount?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const desc = describeEntry(entry);
  return (
    <div
      className="px-3 py-2.5 bg-surface-primary rounded-lg border border-border-secondary cursor-pointer hover:border-border-primary transition-colors"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2">
        <span className={`${desc.color} text-sm shrink-0 w-5 text-center`}>
          {desc.icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-text-primary">
              {desc.title}
              {showAccount && entry.keyName && (
                <span className="text-text-muted font-normal"> — {entry.keyName}</span>
              )}
            </span>
            <span className="text-[10px] text-text-muted shrink-0">
              {formatTime(entry.createdAt)}
            </span>
          </div>
          {expanded && desc.detail && (
            <p className="text-[11px] text-text-muted mt-1 leading-relaxed">
              {desc.detail}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Full-page activity log for all accounts (used in Advanced menu) */
export function ActivityLogPage() {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    fetchLogs(1);
  }, []);

  async function fetchLogs(p: number) {
    setLoading(true);
    const res = await fetch(apiUrl(`/api/account/audit?page=${p}&limit=20`), {
      headers: authHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      if (p === 1) {
        setLogs(data.logs);
      } else {
        setLogs((prev) => [...prev, ...data.logs]);
      }
      setHasMore(data.hasMore);
      setPage(p);
    }
    setLoading(false);
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-text-muted">
        Signing activity, security events, and policy blocks across all accounts.
      </p>

      {loading && logs.length === 0 ? (
        <div className="text-xs text-text-muted text-center py-8">Loading...</div>
      ) : logs.length === 0 ? (
        <div className="text-xs text-text-muted text-center py-8">No activity yet</div>
      ) : (
        <div className="space-y-2">
          {logs.map((entry) => (
            <EntryRow key={entry.id} entry={entry} showAccount />
          ))}

          {hasMore && (
            <button
              onClick={() => fetchLogs(page + 1)}
              disabled={loading}
              className="w-full text-xs text-blue-400 hover:text-blue-300 py-2 rounded-lg border border-dashed border-border-secondary hover:border-blue-500/30 transition-colors disabled:opacity-50"
            >
              {loading ? "Loading..." : "Load more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
