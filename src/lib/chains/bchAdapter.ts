import type { ChainAdapter, BalanceResult, Transaction } from "../../shared/types";
import { hexToBytes, bytesToHex } from "../../shared/utils";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58check } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const PAGE_SIZE = 10;
const b58check = base58check(sha256);

// ── CashAddr encoding ──────────────────────────────────────────────

const CASHADDR_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function cashAddrPolymod(values: number[]): bigint {
  const generators = [
    0x98f2bc8e61n,
    0x79b76d99e2n,
    0xf33e5fb3c4n,
    0xae2eabe2a8n,
    0x1e4f43e470n,
  ];
  let c = 1n;
  for (const v of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) {
      if ((c0 >> BigInt(i)) & 1n) {
        c ^= generators[i];
      }
    }
  }
  return c ^ 1n;
}

function prefixExpand(prefix: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < prefix.length; i++) {
    result.push(prefix.charCodeAt(i) & 0x1f);
  }
  result.push(0); // separator
  return result;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxv);
    }
  }
  return result;
}

/**
 * Encode a hash160 as a CashAddr string.
 * type: 0 = P2PKH, 1 = P2SH
 */
export function encodeCashAddr(prefix: string, type: number, hash: Uint8Array): string {
  // Version byte: type (upper 4 bits) + size (lower 4 bits)
  // For 20-byte hash: size = 0
  const versionByte = (type << 3) | 0;
  const payload = new Uint8Array(hash.length + 1);
  payload[0] = versionByte;
  payload.set(hash, 1);

  const payloadBits = convertBits(payload, 8, 5, true);
  const prefixData = prefixExpand(prefix);
  const checksumInput = [...prefixData, ...payloadBits, 0, 0, 0, 0, 0, 0, 0, 0];
  const checksum = cashAddrPolymod(checksumInput);

  const checksumBits: number[] = [];
  for (let i = 0; i < 8; i++) {
    checksumBits.push(Number((checksum >> BigInt(5 * (7 - i))) & 0x1fn));
  }

  const encoded = [...payloadBits, ...checksumBits]
    .map((b) => CASHADDR_CHARSET[b])
    .join("");

  return `${prefix}:${encoded}`;
}

/**
 * Decode a CashAddr string, returning prefix, type, and hash.
 */
export function decodeCashAddr(address: string): { prefix: string; type: number; hash: Uint8Array } {
  let prefix: string;
  let data: string;

  if (address.includes(":")) {
    const parts = address.split(":");
    prefix = parts[0].toLowerCase();
    data = parts[1].toLowerCase();
  } else {
    // Try default prefix
    prefix = "bitcoincash";
    data = address.toLowerCase();
  }

  const values: number[] = [];
  for (const c of data) {
    const idx = CASHADDR_CHARSET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid CashAddr character: ${c}`);
    values.push(idx);
  }

  // Verify checksum
  const prefixData = prefixExpand(prefix);
  if (cashAddrPolymod([...prefixData, ...values]) !== 0n) {
    throw new Error("Invalid CashAddr checksum");
  }

  // Remove 8 checksum bytes
  const payloadBits = values.slice(0, -8);
  const payloadBytes = convertBits(new Uint8Array(payloadBits), 5, 8, false);

  const versionByte = payloadBytes[0];
  const type = (versionByte >> 3) & 0x1f;
  const hash = new Uint8Array(payloadBytes.slice(1));

  return { prefix, type, hash };
}

/**
 * Convert a CashAddr to legacy BTC-style P2PKH address.
 * Uses the hash160 already embedded in the CashAddr.
 */
export function cashAddrToLegacy(cashAddr: string, testnet = false): string {
  const { hash } = decodeCashAddr(cashAddr);
  const version = testnet ? 0x6f : 0x00;
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(hash, 1);
  return b58check.encode(payload);
}

export function isValidCashAddr(address: string): boolean {
  try {
    decodeCashAddr(address);
    return true;
  } catch {
    return false;
  }
}

// ── Private helpers ──────────────────────────────────────────────────

function extractPublicKeyFromDER(pubKeyHex: string): string {
  const der = hexToBytes(pubKeyHex);
  for (let i = 0; i < der.length - 2; i++) {
    if (der[i] === 0x03 && der[i + 2] === 0x00) {
      const len = der[i + 1];
      const raw = der.slice(i + 3, i + 2 + len);
      return bytesToHex(raw);
    }
  }
  return pubKeyHex;
}

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

function getCompressedKey(rawHex: string): Uint8Array {
  const point = secp256k1.Point.fromHex(rawHex);
  return hexToBytes(point.toHex(true));
}

// ── Exported address derivation ──────────────────────────────────────

/**
 * BCH CashAddr (P2PKH) address from a DER-encoded secp256k1 public key.
 * Mainnet: bitcoincash:qp..., Testnet: bchtest:qp...
 */
export function publicKeyToBchCashAddr(
  pubKeyHex: string,
  testnet = false,
): string {
  const compressed = getCompressedKey(extractPublicKeyFromDER(pubKeyHex));
  const h = hash160(compressed);
  const prefix = testnet ? "bchtest" : "bitcoincash";
  return encodeCashAddr(prefix, 0, h);
}

/**
 * BCH Legacy (P2PKH) address — same format as BTC legacy.
 * Mainnet: starts with "1", Testnet: starts with "m" or "n"
 */
export function publicKeyToBchLegacyAddress(
  pubKeyHex: string,
  testnet = false,
): string {
  const compressed = getCompressedKey(extractPublicKeyFromDER(pubKeyHex));
  const h = hash160(compressed);
  const version = testnet ? 0x6f : 0x00;
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(h, 1);
  return b58check.encode(payload);
}

// ── Adapter helpers ──────────────────────────────────────────────────

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

/** Derive Blockchair API URL from chain rpcUrl or explorerUrl */
function bchApiUrl(chain: { rpcUrl: string; explorerUrl: string }): string {
  // rpcUrl stores the API base for BCH (e.g. "https://api.blockchair.com/bitcoin-cash")
  if (chain.rpcUrl) return chain.rpcUrl.replace(/\/+$/, "");
  return "https://api.blockchair.com/bitcoin-cash";
}

// ── Chain adapter ────────────────────────────────────────────────────

export const bchAdapter: ChainAdapter = {
  type: "bch",
  signingAlgorithm: "ecdsa",

  deriveAddress(pubKeyHex: string, opts?: { testnet?: boolean }): string {
    return publicKeyToBchCashAddr(pubKeyHex, opts?.testnet);
  },

  isValidAddress(address: string): boolean {
    // Accept CashAddr or legacy P2PKH
    if (isValidCashAddr(address)) return true;
    // Legacy addresses (same format as BTC)
    try {
      if (address.startsWith("1") || address.startsWith("m") || address.startsWith("n")) {
        b58check.decode(address);
        return true;
      }
    } catch { /* invalid */ }
    return false;
  },

  async fetchNativeBalance(address, chain, nativeAsset): Promise<BalanceResult | null> {
    try {
      const api = bchApiUrl(chain);
      // Convert CashAddr to plain format (strip prefix) for API compatibility
      const queryAddr = address.includes(":") ? address : address;
      const res = await fetch(`${api}/dashboards/address/${queryAddr}`);
      if (!res.ok) return null;
      const data = await res.json();
      const addrKey = Object.keys(data.data || {})[0];
      if (!addrKey) return null;
      const balance = BigInt(data.data[addrKey]?.address?.balance ?? 0);
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
    // BCH has SLP/CashTokens but we don't support them yet
    return [];
  },

  async fetchTransactions(address, chain, asset, page) {
    try {
      const api = bchApiUrl(chain);
      const queryAddr = address.includes(":") ? address : address;
      const offset = (page - 1) * PAGE_SIZE;
      const res = await fetch(`${api}/dashboards/address/${queryAddr}?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) return { transactions: [], hasMore: false };
      const data = await res.json();
      const addrKey = Object.keys(data.data || {})[0];
      if (!addrKey) return { transactions: [], hasMore: false };

      const addrData = data.data[addrKey];
      const txHashes: string[] = addrData?.transactions || [];

      if (txHashes.length === 0) return { transactions: [], hasMore: false };

      // Fetch transaction details with inputs/outputs
      const txRes = await fetch(`${api}/dashboards/transactions/${txHashes.join(",")}`);
      if (!txRes.ok) return { transactions: [], hasMore: false };
      const txData = await txRes.json();

      // Normalize query address: strip prefix for comparison
      const bareAddr = address.includes(":") ? address.split(":")[1] : address;

      const txs: Transaction[] = txHashes.map((txid) => {
        const txEntry = txData.data?.[txid];
        const tx = txEntry?.transaction;
        if (!tx) {
          return {
            hash: txid,
            from: address,
            to: "...",
            value: "0",
            formatted: "0",
            symbol: asset.symbol,
            timestamp: Math.floor(Date.now() / 1000),
            direction: "out" as const,
            confirmed: false,
          };
        }

        const inputs: { recipient: string; value: number }[] = txEntry.inputs ?? [];
        const outputs: { recipient: string; value: number }[] = txEntry.outputs ?? [];

        // Check if our address appears in inputs/outputs (compare bare addresses)
        const matchAddr = (r: string) => {
          const bare = r.includes(":") ? r.split(":")[1] : r;
          return bare === bareAddr;
        };
        const inputSum = inputs.filter((i) => matchAddr(i.recipient)).reduce((s, i) => s + BigInt(i.value), 0n);
        const outputSum = outputs.filter((o) => matchAddr(o.recipient)).reduce((s, o) => s + BigInt(o.value), 0n);

        const isInInput = inputSum > 0n;
        const isInOutput = outputSum > 0n;
        const direction: "in" | "out" | "self" =
          isInInput && isInOutput && inputSum > outputSum ? "out"
            : isInInput && !isInOutput ? "out"
              : !isInInput && isInOutput ? "in"
                : isInInput && isInOutput ? "self"
                  : "in";

        let displayValue: bigint;
        if (direction === "in") {
          displayValue = outputSum;
        } else if (direction === "out") {
          // Net sent = what we put in minus change back to us
          displayValue = inputSum - outputSum;
        } else {
          displayValue = BigInt(tx.fee ?? 0);
        }

        return {
          hash: txid,
          from: direction === "in" ? "..." : address,
          to: direction === "out" ? "..." : address,
          value: displayValue.toString(),
          formatted: formatTxValue(displayValue.toString(), asset.decimals),
          symbol: asset.symbol,
          timestamp: tx.time ? Math.floor(new Date(tx.time).getTime() / 1000) : Math.floor(Date.now() / 1000),
          direction,
          confirmed: tx.block_id > 0,
        };
      });

      const totalTxCount = addrData?.address?.transaction_count ?? 0;
      return { transactions: txs, hasMore: offset + PAGE_SIZE < totalTxCount };
    } catch {
      return { transactions: [], hasMore: false };
    }
  },
};
