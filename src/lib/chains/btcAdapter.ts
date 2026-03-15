import type { ChainAdapter, BalanceResult, Transaction } from "../../shared/types";
import { hexToBytes, bytesToHex } from "../../shared/utils";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58check, bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { isValidBtcAddress } from "./btcTx";

const PAGE_SIZE = 10;
const b58check = base58check(sha256);

// ── Private helpers ──────────────────────────────────────────────────

/**
 * Extract raw SEC1 public key hex from a DER SubjectPublicKeyInfo hex string.
 * Extracts raw SEC1 public key from a DER SubjectPublicKeyInfo hex string.
 * (compressed 33 bytes or uncompressed 65 bytes).
 */
function extractPublicKeyFromDER(pubKeyHex: string): string {
  const der = hexToBytes(pubKeyHex);

  // Find BIT STRING tag (0x03) followed by unused-bits byte (0x00)
  for (let i = 0; i < der.length - 2; i++) {
    if (der[i] === 0x03 && der[i + 2] === 0x00) {
      const len = der[i + 1];
      // Skip tag + length + unused-bits byte
      const raw = der.slice(i + 3, i + 2 + len);
      return bytesToHex(raw);
    }
  }

  // Fallback: assume it's already raw SEC1
  return pubKeyHex;
}

/** hash160 = RIPEMD160(SHA256(data)) */
function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/** Compress a secp256k1 public key (handles both compressed and uncompressed input) */
function getCompressedKey(rawHex: string): Uint8Array {
  const point = secp256k1.Point.fromHex(rawHex);
  return hexToBytes(point.toHex(true));
}

// ── Exported address derivation ──────────────────────────────────────

/**
 * BTC Legacy (P2PKH) address from a DER-encoded secp256k1 public key.
 * Mainnet: starts with "1", Testnet: starts with "m" or "n"
 */
export function publicKeyToBtcLegacyAddress(
  pubKeyHex: string,
  testnet = false
): string {
  const compressed = getCompressedKey(extractPublicKeyFromDER(pubKeyHex));
  const h = hash160(compressed);
  const version = testnet ? 0x6f : 0x00;
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(h, 1);
  return b58check.encode(payload);
}

/**
 * BTC Native SegWit (P2WPKH) address from a DER-encoded secp256k1 public key.
 * Mainnet: starts with "bc1q", Testnet: starts with "tb1q"
 */
export function publicKeyToBtcSegwitAddress(
  pubKeyHex: string,
  testnet = false
): string {
  const compressed = getCompressedKey(extractPublicKeyFromDER(pubKeyHex));
  const h = hash160(compressed);
  const hrp = testnet ? "tb" : "bc";
  const words = bech32.toWords(h);
  // Witness version 0 prefix
  return bech32.encode(hrp, [0, ...words]);
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

// ── Chain adapter ────────────────────────────────────────────────────

export const btcAdapter: ChainAdapter = {
  type: "btc",
  signingAlgorithm: "ecdsa",

  deriveAddress(pubKeyHex: string, opts?: { testnet?: boolean }): string {
    return publicKeyToBtcSegwitAddress(pubKeyHex, opts?.testnet);
  },

  isValidAddress(address: string): boolean {
    return isValidBtcAddress(address);
  },

  async fetchNativeBalance(address, chain, nativeAsset): Promise<BalanceResult | null> {
    try {
      const apiBase = chain.explorerUrl.replace(/\/+$/, "") + "/api";
      const res = await fetch(`${apiBase}/address/${address}`);
      if (!res.ok) return null;
      const data = await res.json();
      const funded = BigInt(data.chain_stats?.funded_txo_sum ?? 0);
      const spent = BigInt(data.chain_stats?.spent_txo_sum ?? 0);
      const balance = funded - spent;
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
    // BTC has no token standard
    return [];
  },

  async fetchTransactions(address, chain, asset, page) {
    const apiBase = chain.explorerUrl.replace(/\/+$/, "") + "/api";
    const res = await fetch(`${apiBase}/address/${address}/txs`);
    if (!res.ok) return { transactions: [], hasMore: false };
    const allTxs: Record<string, unknown>[] = await res.json();

    const start = (page - 1) * PAGE_SIZE;
    const slice = allTxs.slice(start, start + PAGE_SIZE);
    const addrLower = address.toLowerCase();

    const txs: Transaction[] = slice.map((tx) => {
      const txid = tx.txid as string;
      const status = tx.status as Record<string, unknown>;
      const confirmed = status?.confirmed === true;
      const timestamp = (status?.block_time as number) || Math.floor(Date.now() / 1000);

      const vout = (tx.vout as { scriptpubkey_address?: string; value: number }[]) || [];
      const vin = (tx.vin as { prevout?: { scriptpubkey_address?: string; value: number } }[]) || [];

      let received = 0;
      let sent = 0;
      for (const o of vout) {
        if (o.scriptpubkey_address?.toLowerCase() === addrLower) received += o.value;
      }
      for (const i of vin) {
        if (i.prevout?.scriptpubkey_address?.toLowerCase() === addrLower) sent += i.prevout.value;
      }

      const net = received - sent;
      const direction: "in" | "out" | "self" =
        net > 0 ? "in" : net < 0 ? "out" : "self";

      return {
        hash: txid,
        from: direction === "in" ? "..." : address,
        to: direction === "out" ? "..." : address,
        value: Math.abs(net).toString(),
        formatted: formatTxValue(Math.abs(net).toString(), asset.decimals),
        symbol: asset.symbol,
        timestamp,
        direction,
        confirmed,
      };
    });

    return { transactions: txs, hasMore: start + PAGE_SIZE < allTxs.length };
  },
};
