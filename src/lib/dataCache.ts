/**
 * LocalStorage-backed cache for balances and prices.
 * Respects a configurable TTL (from refresh_interval setting).
 * Navigating between pages reuses cached data until TTL expires.
 */

const STORAGE_PREFIX = "cache:";
const DEFAULT_TTL = 60_000; // 1 minute

let cacheTtl = DEFAULT_TTL;

/** Set the cache TTL (call once when refresh_interval setting is loaded). */
export function setCacheTtl(ms: number) {
  if (ms > 0) cacheTtl = ms;
}

export function getCacheTtl(): number {
  return cacheTtl;
}

interface CacheEntry<T> {
  data: T;
  ts: number;
}

function storageKey(key: string): string {
  return STORAGE_PREFIX + key;
}

/** Get cached value if it exists and hasn't expired. */
export function getCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (Date.now() - entry.ts > cacheTtl) return null;
    return entry.data;
  } catch {
    return null;
  }
}

/** Get cached value even if expired (for showing stale data while refreshing). */
export function getStaleCache<T>(key: string): { data: T; fresh: boolean } | null {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    return { data: entry.data, fresh: Date.now() - entry.ts <= cacheTtl };
  } catch {
    return null;
  }
}

/** Store a value in cache with the current timestamp. */
export function setCache<T>(key: string, data: T) {
  try {
    const entry: CacheEntry<T> = { data, ts: Date.now() };
    localStorage.setItem(storageKey(key), JSON.stringify(entry));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

/** Remove a specific cache entry. */
export function clearCache(key: string) {
  try {
    localStorage.removeItem(storageKey(key));
  } catch {
    // ignore
  }
}

// ── Convenience keys ──────────────────────────────────────────────

export function balanceCacheKey(address: string, chainId: string, assetId: string): string {
  return `bal:${address}:${chainId}:${assetId}`;
}

export function tokenBalancesCacheKey(address: string, chainId: string): string {
  return `tokbal:${address}:${chainId}`;
}

/** Clear all token balance caches (e.g. after adding a custom token). */
export function clearAllTokenBalanceCaches() {
  try {
    const prefix = STORAGE_PREFIX + "tokbal:";
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) keysToRemove.push(k);
    }
    for (const k of keysToRemove) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

export const PRICES_CACHE_KEY = "prices";
