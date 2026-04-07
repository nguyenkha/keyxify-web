import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { authHeaders } from "../lib/auth";
import { apiUrl } from "../lib/apiBase";
import { useExpertMode } from "../context/ExpertModeContext";
import { getStaleCache, setCache } from "../lib/dataCache";
import { getIdentityId } from "../lib/auth";
import { EmptyState } from "./ui";
import Prism from "prismjs";
import "prismjs/components/prism-json";
import { Check, X, Shield, Download, Upload, KeyRound, LogIn, Send, Fingerprint, Ban, Clock, Trash2 } from "lucide-react";

interface AuditEntry {
  id: string;
  action: string;
  keyShareId?: string | null;
  keyName?: string | null;
  ip?: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/** Actions to hide from the UI — internal steps not meaningful to users */
const HIDDEN_ACTIONS = new Set([
  "generate.init",
  "generate-eddsa.init",
  "generate-eddsa.complete",
  "sign.complete",
]);

// ── Icons (SVG components) ──────────────────────────────────

const CheckIcon = Check;
const XIcon = X;
const ShieldIcon = Shield;
const DownloadIcon = Download;
const UploadIcon = Upload;
const KeyIcon = KeyRound;
const LoginIcon = LogIn;
const SendIcon = Send;
const FingerprintIcon = Fingerprint;
const FreezeIcon = Ban;
const ClockIcon = Clock;
const TrashIcon = Trash2;

// ── Entry description ───────────────────────────────────────

type TFn = (key: string, opts?: Record<string, unknown>) => string;

interface EntryDesc {
  title: string;
  subtitle: string;
  detail: string;
  icon: (props: { className?: string }) => React.ReactNode;
  iconBg: string;
  iconColor: string;
}

function describeEntry(entry: AuditEntry, t: TFn): EntryDesc {
  const meta = entry.meta ?? {};
  const reason = meta.reason as string | undefined;
  const chainType = meta.chainType as string | undefined;
  const transfer = meta.transfer as Record<string, string> | undefined;

  switch (entry.action) {
    case "auth.login":
    case "auth.standalone_login": {
      const device = meta.device as string | undefined;
      const location = meta.location as string | undefined;
      const subtitleParts: string[] = [];
      if (device) subtitleParts.push(device);
      if (location) subtitleParts.push(location);
      if (entry.ip && entry.ip !== "unknown") subtitleParts.push(entry.ip);
      return {
        title: t("activity.login"),
        subtitle: subtitleParts.join(" · "),
        detail: t("activity.loginDetail"),
        icon: LoginIcon,
        iconBg: "bg-blue-500/10",
        iconColor: "text-blue-400",
      };
    }
    case "sign.init":
      return {
        title: t("activity.txSigned"),
        subtitle: buildSubtitle(chainType, transfer, meta, t),
        detail: describeTransaction(meta, t),
        icon: SendIcon,
        iconBg: "bg-green-500/10",
        iconColor: "text-green-500",
      };
    case "sign.reject":
      return describeRejection(reason, meta, t);
    case "generate.complete":
      return {
        title: t("activity.accountCreated"),
        subtitle: "",
        detail: t("activity.accountCreatedDetail"),
        icon: CheckIcon,
        iconBg: "bg-green-500/10",
        iconColor: "text-green-500",
      };
    case "backup.upload":
      return {
        title: t("activity.backupSaved"),
        subtitle: "",
        detail: t("activity.backupSavedDetail"),
        icon: UploadIcon,
        iconBg: "bg-blue-500/10",
        iconColor: "text-blue-400",
      };
    case "backup.download":
      return {
        title: t("activity.backupDownloaded"),
        subtitle: "",
        detail: t("activity.backupDownloadedDetail"),
        icon: DownloadIcon,
        iconBg: "bg-yellow-500/10",
        iconColor: "text-yellow-400",
      };
    case "backup.server_share_export":
      return {
        title: t("activity.selfCustodyExport"),
        subtitle: "",
        detail: t("activity.selfCustodyExportDetail"),
        icon: KeyIcon,
        iconBg: "bg-orange-500/10",
        iconColor: "text-orange-400",
      };
    case "passkey.register":
      return {
        title: t("activity.passkeyRegistered"),
        subtitle: "",
        detail: t("activity.passkeyRegisteredDetail"),
        icon: FingerprintIcon,
        iconBg: "bg-purple-500/10",
        iconColor: "text-purple-400",
      };
    case "passkey.delete":
      return {
        title: t("activity.passkeyDeleted"),
        subtitle: "",
        detail: t("activity.passkeyDeletedDetail"),
        icon: TrashIcon,
        iconBg: "bg-red-500/10",
        iconColor: "text-red-400",
      };
    case "account.freeze":
      return {
        title: t("activity.accountFrozen"),
        subtitle: "",
        detail: t("activity.accountFrozenDetail"),
        icon: FreezeIcon,
        iconBg: "bg-red-500/10",
        iconColor: "text-red-400",
      };
    case "account.unfreeze.schedule":
      return {
        title: t("activity.unfreezeScheduled"),
        subtitle: "",
        detail: t("activity.unfreezeScheduledDetail"),
        icon: ClockIcon,
        iconBg: "bg-yellow-500/10",
        iconColor: "text-yellow-400",
      };
    case "account.unfreeze.cancel":
      return {
        title: t("activity.unfreezeCancelled"),
        subtitle: "",
        detail: t("activity.unfreezeCancelledDetail"),
        icon: FreezeIcon,
        iconBg: "bg-orange-500/10",
        iconColor: "text-orange-400",
      };
    case "generate.register_auth":
      return {
        title: t("activity.authRegistered"),
        subtitle: "",
        detail: t("activity.authRegisteredDetail"),
        icon: ShieldIcon,
        iconBg: "bg-green-500/10",
        iconColor: "text-green-500",
      };
    case "generate.init":
    case "generate.standalone_init":
      return {
        title: t("activity.keyGenStarted"),
        subtitle: "",
        detail: t("activity.keyGenStartedDetail"),
        icon: KeyIcon,
        iconBg: "bg-blue-500/10",
        iconColor: "text-blue-400",
      };
    case "generate-eddsa.init":
      return {
        title: t("activity.eddsaKeyGenStarted"),
        subtitle: "",
        detail: t("activity.eddsaKeyGenStartedDetail"),
        icon: KeyIcon,
        iconBg: "bg-blue-500/10",
        iconColor: "text-blue-400",
      };
    case "generate-eddsa.complete":
      return {
        title: t("activity.eddsaAccountCreated"),
        subtitle: "",
        detail: t("activity.eddsaAccountCreatedDetail"),
        icon: CheckIcon,
        iconBg: "bg-green-500/10",
        iconColor: "text-green-500",
      };
    case "sign.complete":
      return {
        title: t("activity.txCompleted"),
        subtitle: buildSubtitle(chainType, transfer, meta, t),
        detail: t("activity.txCompletedDetail"),
        icon: CheckIcon,
        iconBg: "bg-green-500/10",
        iconColor: "text-green-500",
      };
    case "backup.server_share_hkdf":
      return {
        title: t("activity.serverBackupSaved"),
        subtitle: "",
        detail: t("activity.serverBackupSavedDetail"),
        icon: UploadIcon,
        iconBg: "bg-blue-500/10",
        iconColor: "text-blue-400",
      };
    default:
      return {
        title: entry.action,
        subtitle: "",
        detail: "",
        icon: CheckIcon,
        iconBg: "bg-surface-tertiary",
        iconColor: "text-text-muted",
      };
  }
}

function buildSubtitle(chainType: string | undefined, transfer: Record<string, string> | undefined, meta: Record<string, unknown> | undefined, t: TFn): string {
  const parts: string[] = [];
  if (chainType) parts.push(chainType.toUpperCase());
  if (transfer) {
    const symbol = transfer.nativeSymbol || "";
    if (symbol) parts.push(symbol);
    if (transfer.to) parts.push(`to ${shortenAddress(transfer.to)}`);
  } else if (meta?.type === "raw_message") {
    parts.push(t("activity.messageSigning"));
  }
  return parts.join(" \u00b7 ");
}

function describeTransaction(meta: Record<string, unknown>, t: TFn): string {
  const chainType = meta.chainType as string | undefined;
  const transfer = meta.transfer as Record<string, string> | undefined;
  if (transfer) {
    const symbol = transfer.nativeSymbol || "tokens";
    return t("activity.sentTo", { symbol, address: shortenAddress(transfer.to), chain: chainType?.toUpperCase() || "?" });
  }
  if (meta.type === "raw_message") return t("activity.signedMessage");
  return t("activity.txInitiated");
}

function describeRejection(reason: string | undefined, meta: Record<string, unknown>, t: TFn): EntryDesc {
  const chainType = meta.chainType as string | undefined;
  const transfer = meta.transfer as Record<string, string> | undefined;
  const baseIcon = { icon: XIcon, iconBg: "bg-red-500/10", iconColor: "text-red-400" };

  switch (reason) {
    case "key_disabled":
      return { ...baseIcon, title: t("activity.blockedDisabled"), subtitle: "", detail: t("activity.blockedDisabledDetail") };
    case "not_owner":
      return { ...baseIcon, title: t("activity.blockedUnauthorized"), subtitle: "", detail: t("activity.blockedUnauthorizedDetail") };
    case "sighash_mismatch":
      return { ...baseIcon, title: t("activity.blockedInvalid"), subtitle: "", detail: t("activity.blockedInvalidDetail") };
    case "unsupported_asset":
      return { ...baseIcon, title: t("activity.blockedUnsupported"), subtitle: "", detail: t("activity.blockedUnsupportedDetail") };
    case "policy": {
      const fraudCheck = meta.fraudCheck as { flagged?: boolean; flags?: string[]; level?: string; address?: string } | undefined;
      if (fraudCheck?.flagged) {
        const flagLabels = (fraudCheck.flags || []).map(humanizeFlag).join(", ");
        return {
          icon: ShieldIcon, iconBg: "bg-red-500/10", iconColor: "text-red-400",
          title: t("activity.blockedRisky"),
          subtitle: buildSubtitle(chainType, transfer, meta, t),
          detail: t("activity.blockedRiskyDetail", { address: shortenAddress(fraudCheck.address || ""), flags: flagLabels, level: levelLabel(fraudCheck.level) }),
        };
      }
      const priority = meta.rulePriority;
      if (priority === "default_deny") {
        return { ...baseIcon, title: t("activity.blockedNoRule"), subtitle: buildSubtitle(chainType, transfer, meta, t), detail: t("activity.blockedNoRuleDetail") };
      }
      return { ...baseIcon, title: t("activity.blockedPolicy"), subtitle: buildSubtitle(chainType, transfer, meta, t), detail: t("activity.blockedPolicyDetail", { priority: String(priority) }) };
    }
    default:
      return {
        ...baseIcon,
        title: t("activity.txRejected"),
        subtitle: "",
        detail: reason ? t("activity.txRejectedReason", { reason }) : t("activity.txNotApproved"),
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

// ── Time formatting ─────────────────────────────────────────

function formatTime(iso: string, t: TFn): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t("activity.justNow");
  if (diffMin < 60) return t("activity.minutesAgo", { count: diffMin });
  if (diffHr < 24) return t("activity.hoursAgo", { count: diffHr });
  if (diffDay < 7) return t("activity.daysAgo", { count: diffDay });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDateHeader(iso: string, t: TFn): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const entryDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((today.getTime() - entryDate.getTime()) / 86400000);

  if (diffDays === 0) return t("activity.today");
  if (diffDays === 1) return t("activity.yesterday");
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function getDateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// ── Entry Row ───────────────────────────────────────────────

function EntryRow({ entry, showAccount, expert }: { entry: AuditEntry; showAccount?: boolean; expert?: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const desc = describeEntry(entry, t);
  const Icon = desc.icon;

  return (
    <button
      type="button"
      className="w-full text-left px-3 py-3 flex items-start gap-3 hover:bg-surface-tertiary/50 transition-colors"
      onClick={() => setExpanded(!expanded)}
    >
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${desc.iconBg}`}>
        <Icon className={`w-4 h-4 ${desc.iconColor}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-text-primary truncate">
            {desc.title}
          </span>
          <span
            className="text-[10px] text-text-muted shrink-0"
            title={new Date(entry.createdAt).toLocaleString()}
          >
            {formatTime(entry.createdAt, t)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          {showAccount && entry.keyName && (
            <span className="text-[10px] text-text-secondary">{entry.keyName}</span>
          )}
          {showAccount && entry.keyName && desc.subtitle && (
            <span className="text-[10px] text-text-muted/40">{"\u00b7"}</span>
          )}
          {desc.subtitle && (
            <span className="text-[10px] text-text-muted font-mono truncate">{desc.subtitle}</span>
          )}
          {expert && (
            <span className="text-[10px] text-text-muted/40 font-mono">{entry.action}</span>
          )}
        </div>
        {expanded && desc.detail && (
          <p className="text-[11px] text-text-muted mt-2 leading-relaxed bg-surface-primary/50 rounded-lg px-2.5 py-2 border border-border-secondary">
            {desc.detail}
          </p>
        )}
        {expanded && expert && entry.meta && Object.keys(entry.meta).length > 0 && (
          <pre
            className="text-[10px] font-mono mt-1.5 bg-surface-primary/50 rounded-lg px-2.5 py-2 border border-border-secondary overflow-auto max-h-40 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: Prism.highlight(JSON.stringify(entry.meta, null, 2), Prism.languages.json, "json") }}
          />
        )}
      </div>
    </button>
  );
}

// ── Page Component ──────────────────────────────────────────

function auditCacheKey(): string {
  const id = getIdentityId();
  return id ? `audit:${id}` : "audit:anon";
}

/** Merge fresh logs into existing list, dedup by id, keep chronological order */
function mergeLogs(existing: AuditEntry[], incoming: AuditEntry[]): AuditEntry[] {
  const seen = new Set(existing.map((e) => e.id));
  const merged = [...existing];
  for (const entry of incoming) {
    if (!seen.has(entry.id)) {
      merged.push(entry);
      seen.add(entry.id);
    }
  }
  return merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Full-page activity log for all accounts (used in Advanced menu) */
export function ActivityLogPage() {
  const { t } = useTranslation();
  const expert = useExpertMode();
  const [logs, setLogs] = useState<AuditEntry[]>(() => {
    const cached = getStaleCache<AuditEntry[]>(auditCacheKey());
    return cached?.data ?? [];
  });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const isCacheHit = useRef(false);

  const fetchLogs = useCallback(async (p: number) => {
    setLoading(true);
    const res = await fetch(apiUrl(`/api/account/audit?page=${p}&limit=20`), {
      headers: authHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      setLogs((prev) => {
        const updated = p === 1 ? mergeLogs(prev, data.logs) : mergeLogs(prev, data.logs);
        setCache(auditCacheKey(), updated);
        return updated;
      });
      setHasMore(data.hasMore);
      setPage(p);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // If we have cached data, show it immediately and still refresh
    const cached = getStaleCache<AuditEntry[]>(auditCacheKey());
    if (cached?.data?.length) {
      isCacheHit.current = true;
      setLoading(false); // don't show skeleton, we have data
    }
    fetchLogs(1);
  }, [fetchLogs]);

  const filtered = expert ? logs : logs.filter((e) => !HIDDEN_ACTIONS.has(e.action));

  // Group by date
  const groups: { dateKey: string; label: string; entries: AuditEntry[] }[] = [];
  for (const entry of filtered) {
    const key = getDateKey(entry.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.dateKey === key) {
      last.entries.push(entry);
    } else {
      groups.push({ dateKey: key, label: formatDateHeader(entry.createdAt, t), entries: [entry] });
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">{t("activity.title")}</h2>
        <p className="text-xs text-text-muted mt-1">
          {t("activity.description")}
        </p>
      </div>

      {loading && logs.length === 0 ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-start gap-3 px-3 py-3 animate-pulse">
              <div className="w-8 h-8 rounded-full bg-surface-tertiary shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-32 bg-surface-tertiary rounded" />
                <div className="h-2.5 w-48 bg-surface-tertiary/60 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={t("activity.noActivityYet")}
          description={t("activity.noActivityDesc")}
        />
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.dateKey}>
              <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold mb-1.5 px-1">
                {group.label}
              </p>
              <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden divide-y divide-border-secondary">
                {group.entries.map((entry) => (
                  <EntryRow key={entry.id} entry={entry} showAccount expert={expert} />
                ))}
              </div>
            </div>
          ))}

          {hasMore && (
            <button
              onClick={() => fetchLogs(page + 1)}
              disabled={loading}
              className="w-full text-xs text-blue-400 hover:text-blue-300 py-2.5 rounded-lg border border-dashed border-border-primary hover:border-blue-500/30 transition-colors disabled:opacity-50"
            >
              {loading ? t("activity.loading") : t("activity.loadMore")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
