import type { ChainAdapter, BalanceResult, Transaction } from "../../shared/types";
import { hexToBytes, bytesToHex } from "../../shared/utils";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const PAGE_SIZE = 10;

// ── Bitcoin-style Base58 (standard alphabet) ────────────────────

const BTC_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(data: Uint8Array): string {
  let num = 0n;
  for (const b of data) num = (num << 8n) | BigInt(b);

  const chars: string[] = [];
  while (num > 0n) {
    chars.push(BTC_ALPHABET[Number(num % 58n)]);
    num /= 58n;
  }
  // Preserve leading zeros
  for (const b of data) {
    if (b !== 0) break;
    chars.push(BTC_ALPHABET[0]);
  }
  return chars.reverse().join("");
}

function base58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const c of str) {
    const i = BTC_ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`Invalid base58 character: ${c}`);
    num = num * 58n + BigInt(i);
  }
  // Count leading zeros
  let leadingZeros = 0;
  for (const c of str) {
    if (c !== BTC_ALPHABET[0]) break;
    leadingZeros++;
  }
  // Convert bigint to bytes
  const hex = num === 0n ? "" : num.toString(16).padStart(2, "0");
  const bytes = hexToBytes(hex.length % 2 ? "0" + hex : hex);
  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);
  return result;
}

export function tronBase58CheckEncode(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(checksum, payload.length);
  return base58Encode(full);
}

export function tronBase58CheckDecode(str: string): Uint8Array | null {
  try {
    const full = base58Decode(str);
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

// ── Address helpers ─────────────────────────────────────────────

/**
 * Convert a base58 TRON address to hex format (including 0x41 prefix).
 * Example: "T..." -> "41..."
 */
export function tronAddressToHex(address: string): string {
  const decoded = tronBase58CheckDecode(address);
  if (!decoded || decoded.length !== 21 || decoded[0] !== 0x41) {
    throw new Error(`Invalid TRON address: ${address}`);
  }
  return bytesToHex(decoded);
}

/**
 * Convert a hex TRON address (with 0x41 prefix) back to base58.
 * Example: "41..." -> "T..."
 */
export function tronHexToAddress(hex: string): string {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 21 || bytes[0] !== 0x41) {
    throw new Error(`Invalid TRON hex address: ${hex}`);
  }
  return tronBase58CheckEncode(bytes);
}

// ── Address derivation ──────────────────────────────────────────

/**
 * Derive a TRON address from a DER-encoded secp256k1 public key.
 * TRON: keccak256(uncompressed_pubkey_without_04_prefix) -> last 20 bytes -> prepend 0x41 -> base58check
 */
export function publicKeyToTronAddress(pubKeyHex: string): string {
  // Get uncompressed public key bytes (04 || x || y)
  const uncompressedHex = secp256k1.Point.fromHex(pubKeyHex).toHex(false);
  const rawBytes = hexToBytes(uncompressedHex);
  // Hash without the 0x04 prefix
  const hash = keccak_256(rawBytes.slice(1));
  // Take last 20 bytes
  const addrBytes = hash.slice(hash.length - 20);
  // Prepend 0x41 (TRON mainnet prefix)
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(addrBytes, 1);
  return tronBase58CheckEncode(payload);
}

export function isValidTronAddress(address: string): boolean {
  if (!address.startsWith("T")) return false;
  const decoded = tronBase58CheckDecode(address);
  if (!decoded) return false;
  return decoded.length === 21 && decoded[0] === 0x41;
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

// ── Chain adapter ───────────────────────────────────────────────

export const tronAdapter: ChainAdapter = {
  type: "tron",
  signingAlgorithm: "ecdsa",

  deriveAddress(pubKeyHex: string): string {
    return publicKeyToTronAddress(pubKeyHex);
  },

  isValidAddress(address: string): boolean {
    return isValidTronAddress(address);
  },

  async fetchNativeBalance(address, chain, nativeAsset): Promise<BalanceResult | null> {
    try {
      const res = await fetch(`${chain.rpcUrl}/wallet/getaccount`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, visible: true }),
      });
      const data = await res.json();
      const balance = BigInt(data.balance ?? 0);
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

  async fetchTokenBalances(address, chain, tokenAssets): Promise<BalanceResult[]> {
    const results: BalanceResult[] = [];

    for (const asset of tokenAssets) {
      if (asset.isNative || !asset.contractAddress) continue;

      try {
        // Convert addresses to hex form for the API call
        const addressHex = tronAddressToHex(address);
        const contractAddressHex = tronAddressToHex(asset.contractAddress);

        // The parameter is the 20-byte address (without 0x41 prefix) left-padded to 32 bytes
        const addrBytes20 = addressHex.slice(2); // strip "41" prefix -> 40 hex chars (20 bytes)
        const parameter = addrBytes20.padStart(64, "0");

        const res = await fetch(`${chain.rpcUrl}/wallet/triggerconstantcontract`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner_address: addressHex,
            contract_address: contractAddressHex,
            function_selector: "balanceOf(address)",
            parameter,
            visible: false,
          }),
        });
        const data = await res.json();

        const constantResult = data.constant_result;
        if (constantResult && constantResult.length > 0) {
          const balance = BigInt("0x" + (constantResult[0] || "0"));
          results.push({
            asset,
            chain,
            balance: balance.toString(),
            formatted: formatBalance(balance, asset.decimals),
          });
        }
      } catch {
        // Skip failed token balance fetches
      }
    }

    return results;
  },

  async fetchTransactions(address, chain, asset, page) {
    try {
      const marker = page > 1 ? `&fingerprint=${page}` : "";
      const res = await fetch(
        `${chain.rpcUrl}/v1/accounts/${address}/transactions?limit=${PAGE_SIZE}${marker}`,
      );
      const data = await res.json();
      const rawTxs = data.data || [];
      const fingerprint = data.meta?.fingerprint;

      const txs: Transaction[] = [];
      for (const tx of rawTxs) {
        const txId = tx.txID || "";
        const rawData = tx.raw_data;
        if (!rawData?.contract?.[0]) continue;

        const contract = rawData.contract[0];
        const type = contract.type;
        const param = contract.parameter?.value;
        if (!param) continue;

        let from = "";
        let to = "";
        let value = "0";

        if (type === "TransferContract") {
          // Native TRX transfer
          from = param.owner_address || "";
          to = param.to_address || "";
          value = String(param.amount ?? "0");
        } else if (type === "TriggerSmartContract") {
          // TRC-20 token transfer (simplified)
          from = param.owner_address || "";
          to = param.contract_address || "";
          value = "0";
        } else {
          continue;
        }

        // TronGrid returns hex addresses — convert to base58 for comparison & display
        try {
          if (from) from = tronHexToAddress(from);
          if (to) to = tronHexToAddress(to);
        } catch {
          // keep raw hex if conversion fails
        }

        const direction: "in" | "out" | "self" =
          from === address && to === address ? "self"
          : to === address ? "in"
          : "out";

        const timestamp = Math.floor((rawData.timestamp || 0) / 1000);
        const ret = tx.ret?.[0];
        const failed = ret?.contractRet !== "SUCCESS";

        txs.push({
          hash: txId,
          from,
          to,
          value,
          formatted: formatTxValue(value, asset.decimals),
          symbol: asset.symbol,
          timestamp,
          direction,
          confirmed: true,
          failed,
        });
      }

      return { transactions: txs, hasMore: !!fingerprint };
    } catch {
      return { transactions: [], hasMore: false };
    }
  },
};
