// Per-user config overrides stored in localStorage

export interface ChainOverride {
  rpcUrl?: string;
  explorerUrl?: string;
}

export interface UserOverrides {
  chains?: Record<string, ChainOverride>;
  preferences?: {
    refresh_interval?: number;
    default_chains?: string[];
    show_testnet?: boolean;
    expert_mode?: boolean;
    evm_gas_buffer_pct?: number;
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
