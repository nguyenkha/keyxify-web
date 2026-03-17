// Per-user config overrides stored in localStorage

export interface ChainOverride {
  rpcUrl?: string;
  explorerUrl?: string;
}

export interface CustomToken {
  id: string;           // "custom:{chainId}:{contractAddress}"
  symbol: string;
  name: string;
  decimals: number;
  contractAddress: string;
  iconUrl: string | null;
  chainId: string;
  addedAt: number;      // timestamp
}

export interface AddressBookEntry {
  address: string;
  label: string;
  chain?: string;
  addedAt: number;
}

export interface RecentRecipientEntry {
  address: string;
  chain: string;
  asset: string;
  timestamp: number;
}

export interface UserOverrides {
  chains?: Record<string, ChainOverride>;
  customTokens?: CustomToken[];
  addressBook?: AddressBookEntry[];
  recentRecipients?: RecentRecipientEntry[];
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

export function getUserOverrides(userId?: string): UserOverrides {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw ? JSON.parse(raw) : {};
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

/** Apply chain overrides (RPC/explorer URL) — only in expert mode */
export function applyChainOverrides<T extends { name: string; rpcUrl: string; explorerUrl: string }>(
  chains: T[],
  userId?: string,
): T[] {
  const overrides = userId ? getUserOverrides(userId) : (() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("kexify:config:")) {
        try { return JSON.parse(localStorage.getItem(k)!) as UserOverrides; } catch { /* skip */ }
      }
    }
    return {} as UserOverrides;
  })();
  if (!overrides.preferences?.expert_mode) return chains;
  return chains.map(ch => {
    const o = overrides.chains?.[ch.name];
    if (!o) return ch;
    return { ...ch, ...(o.rpcUrl ? { rpcUrl: o.rpcUrl } : {}), ...(o.explorerUrl ? { explorerUrl: o.explorerUrl } : {}) };
  });
}

/** Get all custom tokens from any user override entry */
export function getCustomTokens(): CustomToken[] {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("kexify:config:")) {
      try {
        const parsed = JSON.parse(localStorage.getItem(k)!) as UserOverrides;
        if (parsed.customTokens?.length) return parsed.customTokens;
      } catch { /* skip */ }
    }
  }
  return [];
}

// Preferences that only take effect in expert mode — return undefined (default) when non-expert
const EXPERT_ONLY_PREFS: Set<string> = new Set([
  "show_testnet",
  "confirm_before_broadcast",
  "evm_gas_buffer_pct",
]);

/** Get a preference value from any user override entry (scans localStorage if no userId).
 *  Expert-only preferences return undefined when expert_mode is off. */
export function getPreference<K extends keyof NonNullable<UserOverrides["preferences"]>>(
  key: K,
  userId?: string,
): NonNullable<UserOverrides["preferences"]>[K] | undefined {
  // Find the overrides (by userId or scanning)
  let overrides: UserOverrides | null = null;
  if (userId) {
    overrides = getUserOverrides(userId);
  } else {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("kexify:config:")) {
        try {
          const parsed = JSON.parse(localStorage.getItem(k)!) as UserOverrides;
          if (parsed.preferences?.[key] !== undefined) { overrides = parsed; break; }
        } catch { /* skip */ }
      }
    }
  }
  if (!overrides) return undefined;

  // Expert-only prefs: return undefined when expert mode is off
  if (EXPERT_ONLY_PREFS.has(key as string) && !overrides.preferences?.expert_mode) {
    return undefined;
  }

  return overrides.preferences?.[key] as any;
}
