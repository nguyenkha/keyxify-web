// Per-user config overrides stored in localStorage

export interface ChainOverride {
  rpc_url?: string;
  explorer_url?: string;
}

export interface CustomToken {
  id: string;           // "custom:{chain_id}:{contract_address}"
  symbol: string;
  name: string;
  decimals: number;
  contract_address: string;
  icon_url: string | null;
  chain_id: string;
  added_at: number;      // timestamp
}

export interface AddressBookEntry {
  address: string;
  label: string;
  chain?: string;
  added_at: number;
}

export interface RecentRecipientEntry {
  address: string;
  chain: string;
  asset: string;
  timestamp: number;
}

export interface UserOverrides {
  chains?: Record<string, ChainOverride>;
  custom_tokens?: CustomToken[];
  address_book?: AddressBookEntry[];
  recent_recipients?: RecentRecipientEntry[];
  hide_balances?: boolean;
  display?: Record<string, Record<string, boolean>>;
  preferences?: {
    refresh_interval?: number;
    default_chains?: string[];
    show_testnet?: boolean;
    expert_mode?: boolean;
    evm_gas_buffer_pct?: number;
    confirm_before_broadcast?: boolean;
    [key: string]: unknown;
  };
}

function storageKey(userId?: string): string {
  return userId ? `kexify:config:${userId}` : "kexify:config";
}

/** Migrate legacy camelCase keys to snake_case (one-time, backward compat) */
function migrate(data: Record<string, unknown>): UserOverrides {
  const d = data as Record<string, unknown>;

  // Top-level keys
  if (d["customTokens"] !== undefined && d["custom_tokens"] === undefined) {
    d["custom_tokens"] = d["customTokens"];
  }
  if (d["addressBook"] !== undefined && d["address_book"] === undefined) {
    d["address_book"] = d["addressBook"];
  }
  if (d["recentRecipients"] !== undefined && d["recent_recipients"] === undefined) {
    d["recent_recipients"] = d["recentRecipients"];
  }
  if (d["hideBalances"] !== undefined && d["hide_balances"] === undefined) {
    d["hide_balances"] = d["hideBalances"];
  }

  // ChainOverride sub-keys
  if (d["chains"] && typeof d["chains"] === "object") {
    const chains = d["chains"] as Record<string, Record<string, unknown>>;
    for (const name of Object.keys(chains)) {
      const c = chains[name];
      if (c["rpcUrl"] !== undefined && c["rpc_url"] === undefined) c["rpc_url"] = c["rpcUrl"];
      if (c["explorerUrl"] !== undefined && c["explorer_url"] === undefined) c["explorer_url"] = c["explorerUrl"];
    }
  }

  // CustomToken sub-keys
  if (Array.isArray(d["custom_tokens"])) {
    for (const t of d["custom_tokens"] as Record<string, unknown>[]) {
      if (t["contractAddress"] !== undefined && t["contract_address"] === undefined) t["contract_address"] = t["contractAddress"];
      if (t["iconUrl"] !== undefined && t["icon_url"] === undefined) t["icon_url"] = t["iconUrl"];
      if (t["chainId"] !== undefined && t["chain_id"] === undefined) t["chain_id"] = t["chainId"];
      if (t["addedAt"] !== undefined && t["added_at"] === undefined) t["added_at"] = t["addedAt"];
    }
  }

  // AddressBookEntry sub-keys
  if (Array.isArray(d["address_book"])) {
    for (const e of d["address_book"] as Record<string, unknown>[]) {
      if (e["addedAt"] !== undefined && e["added_at"] === undefined) e["added_at"] = e["addedAt"];
    }
  }

  return d as UserOverrides;
}

export function getUserOverrides(userId?: string): UserOverrides {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const migrated = migrate(parsed);
    // Persist migrated version so future reads are already snake_case
    localStorage.setItem(storageKey(userId), JSON.stringify(migrated));
    return migrated;
  } catch {
    return {};
  }
}

export function setUserOverrides(overrides: UserOverrides, userId?: string): void {
  localStorage.setItem(storageKey(userId), JSON.stringify(overrides));
}

export function clearUserOverrides(userId?: string): void {
  localStorage.removeItem(storageKey(userId));
}

/** Extract userId from JWT in localStorage (synchronous, no network call) */
function currentUserId(): string | undefined {
  try {
    const token = localStorage.getItem("secretkey_token");
    if (!token) return undefined;
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.sub;
  } catch { return undefined; }
}

/** Find the current user's overrides — by userId, JWT, or scanning localStorage */
function findOverrides(userId?: string): UserOverrides {
  // 1. Explicit userId
  if (userId) return getUserOverrides(userId);
  // 2. Derive from JWT token
  const jwtId = currentUserId();
  if (jwtId) return getUserOverrides(jwtId);
  // 3. Fallback: scan localStorage
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("kexify:config:")) {
      try { return JSON.parse(localStorage.getItem(k)!) as UserOverrides; } catch { /* skip */ }
    }
  }
  return {};
}

/** Apply chain overrides (RPC/explorer URL) — only in expert mode */
export function applyChainOverrides<T extends { name: string; rpcUrl: string; explorerUrl: string }>(
  chains: T[],
  userId?: string,
): T[] {
  const overrides = findOverrides(userId);
  if (!overrides.preferences?.expert_mode) return chains;
  return chains.map(ch => {
    const o = overrides.chains?.[ch.name];
    if (!o) return ch;
    return { ...ch, ...(o.rpc_url ? { rpcUrl: o.rpc_url } : {}), ...(o.explorer_url ? { explorerUrl: o.explorer_url } : {}) };
  });
}

/** Get all custom tokens from any user override entry */
export function getCustomTokens(): CustomToken[] {
  const overrides = findOverrides();
  return overrides.custom_tokens ?? [];
}

// Expert-only preferences: return their default value when expert_mode is off,
// regardless of what is stored in localStorage.
const EXPERT_PREF_DEFAULTS: Partial<Record<string, unknown>> = {
  show_testnet: false,
  confirm_before_broadcast: false,
  evm_gas_buffer_pct: 10,
};

/** Get a preference value, gated by expert mode for expert-only preferences.
 *  When expert_mode is off, expert-only prefs return their default value. */
export function getPreference<K extends keyof NonNullable<UserOverrides["preferences"]>>(
  key: K,
  userId?: string,
): NonNullable<UserOverrides["preferences"]>[K] {
  const overrides = findOverrides(userId);
  const defaultVal = EXPERT_PREF_DEFAULTS[key as string];
  const isExpertOnly = key as string in EXPERT_PREF_DEFAULTS;

  // Expert-only prefs: return default when expert mode is off
  if (isExpertOnly && !overrides.preferences?.expert_mode) {
    return defaultVal as NonNullable<UserOverrides["preferences"]>[K];
  }

  return (overrides.preferences?.[key] ?? defaultVal) as NonNullable<UserOverrides["preferences"]>[K];
}
