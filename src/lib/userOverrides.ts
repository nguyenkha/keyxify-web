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

export interface UserOverrides {
  chains?: Record<string, ChainOverride>;
  customTokens?: CustomToken[];
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

/** Get a preference value from any user override entry (scans localStorage if no userId) */
export function getPreference<K extends keyof NonNullable<UserOverrides["preferences"]>>(
  key: K,
  userId?: string,
): NonNullable<UserOverrides["preferences"]>[K] | undefined {
  if (userId) return getUserOverrides(userId).preferences?.[key] as any;
  // No userId — scan for any kexify:config:* key
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("kexify:config:")) {
      try {
        const parsed = JSON.parse(localStorage.getItem(k)!) as UserOverrides;
        if (parsed.preferences?.[key] !== undefined) return parsed.preferences[key] as any;
      } catch { /* skip */ }
    }
  }
  return undefined;
}
