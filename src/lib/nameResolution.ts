// Name resolution for ENS (.eth) and Unstoppable Domains
// Uses public JSON-RPC / APIs — no additional dependencies beyond @noble/hashes

import { keccak_256 } from "@noble/hashes/sha3";

/**
 * Attempts to resolve a human-readable name to a blockchain address.
 * Returns null if the name cannot be resolved or is not a recognized domain.
 */
export async function resolveName(
  name: string,
  chainType: string,
  rpcUrl?: string,
): Promise<{ address: string; source: string } | null> {
  const lower = name.toLowerCase().trim();

  // ENS (.eth) — resolve via EVM RPC
  if (lower.endsWith(".eth") && chainType === "evm" && rpcUrl) {
    return resolveEns(lower, rpcUrl);
  }

  // Unstoppable Domains (.crypto, .nft, .x, .wallet, .blockchain, .bitcoin, .dao, .888)
  const udExtensions = [".crypto", ".nft", ".x", ".wallet", ".blockchain", ".bitcoin", ".dao", ".888"];
  if (udExtensions.some((ext) => lower.endsWith(ext))) {
    return resolveUnstoppable(lower, chainType);
  }

  return null;
}

/** Check if a string looks like a resolvable domain name */
export function isResolvableName(input: string): boolean {
  const lower = input.toLowerCase().trim();
  if (lower.endsWith(".eth")) return true;
  const udExtensions = [".crypto", ".nft", ".x", ".wallet", ".blockchain", ".bitcoin", ".dao", ".888"];
  if (udExtensions.some((ext) => lower.endsWith(ext))) return true;
  return false;
}

// ── ENS Resolution via eth_call ──────────────────────────────────

async function resolveEns(
  name: string,
  rpcUrl: string,
): Promise<{ address: string; source: string } | null> {
  try {
    const node = namehash(name);
    const registryAddr = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
    // resolver(bytes32 node) → address — selector 0x0178b8bf
    const resolverCalldata = "0x0178b8bf" + node.slice(2);

    const resolverRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: registryAddr, data: resolverCalldata }, "latest"],
      }),
    });
    const resolverData = await resolverRes.json();
    if (!resolverData.result || resolverData.result === "0x" + "0".repeat(64)) return null;

    const resolverAddr = "0x" + resolverData.result.slice(26);
    if (resolverAddr === "0x" + "0".repeat(40)) return null;

    // addr(bytes32 node) → address — selector 0x3b3b57de
    const addrCalldata = "0x3b3b57de" + node.slice(2);
    const addrRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "eth_call",
        params: [{ to: resolverAddr, data: addrCalldata }, "latest"],
      }),
    });
    const addrData = await addrRes.json();
    if (!addrData.result || addrData.result === "0x" + "0".repeat(64)) return null;

    const address = "0x" + addrData.result.slice(26);
    if (address === "0x" + "0".repeat(40)) return null;

    return { address, source: "ENS" };
  } catch {
    return null;
  }
}

// ── Unstoppable Domains Resolution ───────────────────────────────

async function resolveUnstoppable(
  name: string,
  chainType: string,
): Promise<{ address: string; source: string } | null> {
  try {
    const res = await fetch(`https://resolve.unstoppabledomains.com/domains/${name}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const records = data?.records;
    if (!records) return null;

    const keyMap: Record<string, string[]> = {
      evm: ["crypto.ETH.address"],
      btc: ["crypto.BTC.address"],
      solana: ["crypto.SOL.address"],
      xrp: ["crypto.XRP.address"],
      xlm: ["crypto.XLM.address"],
      ltc: ["crypto.LTC.address"],
      bch: ["crypto.BCH.address"],
    };

    const keys = keyMap[chainType] ?? [];
    for (const key of keys) {
      if (records[key]) return { address: records[key], source: "Unstoppable Domains" };
    }
    return null;
  } catch {
    return null;
  }
}

// ── ENS Namehash ─────────────────────────────────────────────────

function namehash(name: string): string {
  let node: Uint8Array = new Uint8Array(32); // 0x00...00
  if (!name) return "0x" + toHexLocal(node);

  const labels = name.split(".").reverse();
  for (const label of labels) {
    const labelHash = Uint8Array.from(keccak_256(new TextEncoder().encode(label)));
    const combined = new Uint8Array(64);
    combined.set(node, 0);
    combined.set(labelHash, 32);
    node = Uint8Array.from(keccak_256(combined));
  }
  return "0x" + toHexLocal(node);
}

function toHexLocal(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
