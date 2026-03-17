// Detect API provider from URL hostname.
// Used for REST-based chains (BTC, BCH, XLM) and EVM simulation providers.

// ── EVM simulation provider detection ──

export type EvmSimProvider = "alchemy" | "tenderly" | "infura" | "none";

export function detectEvmSimProvider(rpcUrl: string): EvmSimProvider {
  try {
    const host = new URL(rpcUrl).hostname;
    if (host.includes("alchemy.com")) return "alchemy";
    if (host.includes("tenderly.co")) return "tenderly";
    if (host.includes("infura.io")) return "infura";
  } catch { /* invalid URL */ }
  return "none";
}

// ── REST chain provider detection ──

export type BtcProvider = "mempool" | "blockstream" | "blockchair" | "unknown";
export type BchProvider = "blockchair" | "unknown";
export type XlmProvider = "horizon" | "unknown";

export function detectBtcProvider(url: string): BtcProvider {
  try {
    const host = new URL(url).hostname;
    if (host.includes("mempool.space")) return "mempool";
    if (host.includes("blockstream.info")) return "blockstream";
    if (host.includes("blockchair.com")) return "blockchair";
  } catch { /* invalid URL */ }
  return "unknown";
}

export function detectBchProvider(url: string): BchProvider {
  try {
    const host = new URL(url).hostname;
    if (host.includes("blockchair.com")) return "blockchair";
  } catch { /* invalid URL */ }
  return "unknown";
}

export function detectXlmProvider(url: string): XlmProvider {
  try {
    const host = new URL(url).hostname;
    if (host.includes("stellar.org") || host.includes("stellar.expert")) return "horizon";
  } catch { /* invalid URL */ }
  return "unknown";
}

// ── Health check per provider ──

export async function checkBtcHealth(url: string, signal?: AbortSignal): Promise<boolean> {
  const provider = detectBtcProvider(url);
  try {
    switch (provider) {
      case "mempool":
      case "blockstream": {
        // Both use the same API format
        const base = url.replace(/\/+$/, "");
        const res = await fetch(`${base}/blocks/tip/height`, { signal });
        return res.ok;
      }
      case "blockchair": {
        const base = url.replace(/\/+$/, "");
        const res = await fetch(`${base}/stats`, { signal });
        return res.ok;
      }
      default: {
        const res = await fetch(url, { signal });
        return res.ok;
      }
    }
  } catch {
    return false;
  }
}

export async function checkBchHealth(url: string, signal?: AbortSignal): Promise<boolean> {
  const provider = detectBchProvider(url);
  try {
    switch (provider) {
      case "blockchair": {
        const base = url.replace(/\/+$/, "");
        const res = await fetch(`${base}/stats`, { signal });
        return res.ok;
      }
      default: {
        const res = await fetch(url, { signal });
        return res.ok;
      }
    }
  } catch {
    return false;
  }
}

export async function checkXlmHealth(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(url, { signal });
    return res.ok;
  } catch {
    return false;
  }
}
