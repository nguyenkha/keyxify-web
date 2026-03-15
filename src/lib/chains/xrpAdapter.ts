import type { ChainAdapter, BalanceResult, Transaction } from "../../shared/types";
import { hexToBytes } from "../../shared/utils";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const PAGE_SIZE = 10;

// XRP uses a different base58 alphabet than Bitcoin
const XRP_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

// ── XRP Base58 ──────────────────────────────────────────────────

function xrpBase58Encode(data: Uint8Array): string {
  let num = 0n;
  for (const b of data) num = (num << 8n) | BigInt(b);

  const chars: string[] = [];
  while (num > 0n) {
    chars.push(XRP_ALPHABET[Number(num % 58n)]);
    num /= 58n;
  }
  // Preserve leading zeros
  for (const b of data) {
    if (b !== 0) break;
    chars.push(XRP_ALPHABET[0]);
  }
  return chars.reverse().join("");
}

function xrpBase58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const c of str) {
    const i = XRP_ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`Invalid XRP base58 character: ${c}`);
    num = num * 58n + BigInt(i);
  }
  // Count leading zeros
  let leadingZeros = 0;
  for (const c of str) {
    if (c !== XRP_ALPHABET[0]) break;
    leadingZeros++;
  }
  // Convert bigint to bytes
  const hex = num === 0n ? "" : num.toString(16).padStart(2, "0");
  const bytes = hexToBytes(hex.length % 2 ? "0" + hex : hex);
  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);
  return result;
}

function xrpBase58CheckEncode(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(checksum, payload.length);
  return xrpBase58Encode(full);
}

function xrpBase58CheckDecode(str: string): Uint8Array | null {
  try {
    const full = xrpBase58Decode(str);
    if (full.length < 5) return null;
    const payload = full.slice(0, full.length - 4);
    const checksum = full.slice(full.length - 4);
    const computed = sha256(sha256(payload)).slice(0, 4);
    for (let i = 0; i < 4; i++) {
      if (checksum[i] !== computed[i]) return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// ── Address derivation ──────────────────────────────────────────



function getCompressedKey(rawHex: string): Uint8Array {
  const point = secp256k1.Point.fromHex(rawHex);
  return hexToBytes(point.toHex(true));
}

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/**
 * Derive an XRP address from a DER-encoded secp256k1 public key.
 * XRP uses ripemd160(sha256(compressed_pubkey)) with version byte 0x00
 * and XRP's custom base58 alphabet.
 */
export function publicKeyToXrpAddress(pubKeyHex: string): string {
  // pubKeyHex is SEC1 uncompressed (04 || x || y) from cb-mpc
  const compressed = getCompressedKey(pubKeyHex);
  const h = hash160(compressed);
  const payload = new Uint8Array(21);
  payload[0] = 0x00; // XRP account version
  payload.set(h, 1);
  return xrpBase58CheckEncode(payload);
}

export function isValidXrpAddress(address: string): boolean {
  if (!address.startsWith("r")) return false;
  const decoded = xrpBase58CheckDecode(address);
  if (!decoded) return false;
  return decoded.length === 21 && decoded[0] === 0x00;
}

// ── Helpers ─────────────────────────────────────────────────────

function formatBalance(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";
  const str = raw.toString().padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const fracPart = str.slice(str.length - decimals).replace(/0+$/, "");
  const fmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart ? `${fmt}.${fracPart}` : fmt;
}

function formatTxValue(raw: string, decimals: number): string {
  if (!raw || raw === "0") return "0";
  const str = raw.padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const fracPart = str.slice(str.length - decimals).replace(/0+$/, "");
  const fmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart ? `${fmt}.${fracPart}` : fmt;
}

async function xrpRpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const data = await res.json();
  return data.result;
}

// XRP Ledger epoch: 2000-01-01 00:00:00 UTC
const RIPPLE_EPOCH = 946684800;

// ── Chain adapter ───────────────────────────────────────────────

export const xrpAdapter: ChainAdapter = {
  type: "xrp",
  signingAlgorithm: "ecdsa",

  deriveAddress(pubKeyHex: string): string {
    return publicKeyToXrpAddress(pubKeyHex);
  },

  isValidAddress(address: string): boolean {
    return isValidXrpAddress(address);
  },

  async fetchNativeBalance(address, chain, nativeAsset): Promise<BalanceResult | null> {
    try {
      const result = await xrpRpc(chain.rpcUrl, "account_info", [
        { account: address, ledger_index: "validated" },
      ]) as { account_data?: { Balance?: string }; error?: string } | null;

      if (result?.error === "actNotFound") {
        return { asset: nativeAsset, chain, balance: "0", formatted: "0" };
      }

      const balance = BigInt(result?.account_data?.Balance ?? "0");
      return {
        asset: nativeAsset,
        chain,
        balance: balance.toString(),
        formatted: formatBalance(balance, nativeAsset.decimals),
      };
    } catch {
      return null;
    }
  },

  async fetchTokenBalances(): Promise<BalanceResult[]> {
    // XRP issued currencies/trust lines not implemented yet
    return [];
  },

  async fetchTransactions(address, chain, asset, page) {
    try {
      const result = await xrpRpc(chain.rpcUrl, "account_tx", [
        { account: address, limit: PAGE_SIZE * page + 1, forward: false, ledger_index_min: -1, ledger_index_max: -1 },
      ]) as { transactions?: Record<string, unknown>[] } | null;

      const allTxs = result?.transactions || [];
      const start = (page - 1) * PAGE_SIZE;
      const slice = allTxs.slice(start, start + PAGE_SIZE);

      const txs: Transaction[] = [];
      for (const entry of slice) {
        const tx = entry.tx as Record<string, unknown> | undefined;
        const meta = entry.meta as Record<string, unknown> | undefined;
        if (!tx || tx.TransactionType !== "Payment") continue;

        const hash = (tx.hash as string) || "";
        const from = tx.Account as string;
        const txTo = tx.Destination as string;

        // delivered_amount can be string (drops) or object (issued currency)
        const delivered = meta?.delivered_amount;
        const dropsStr = typeof delivered === "string" ? delivered : (typeof (tx.Amount) === "string" ? tx.Amount as string : "0");
        const drops = BigInt(dropsStr);

        const direction: "in" | "out" | "self" =
          from === address && txTo === address ? "self"
          : txTo === address ? "in"
          : "out";

        const timestamp = ((tx.date as number) || 0) + RIPPLE_EPOCH;

        txs.push({
          hash,
          from,
          to: txTo,
          value: drops.toString(),
          formatted: formatTxValue(drops.toString(), asset.decimals),
          symbol: asset.symbol,
          timestamp,
          direction,
          confirmed: (entry.validated as boolean) ?? true,
        });
      }

      return { transactions: txs, hasMore: start + PAGE_SIZE < allTxs.length };
    } catch {
      return { transactions: [], hasMore: false };
    }
  },
};
