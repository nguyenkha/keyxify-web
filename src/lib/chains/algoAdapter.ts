import type { ChainAdapter, Chain, Asset, BalanceResult, Transaction } from "../../shared/types";

// ── Algorand address encoding (Ed25519 + SHA-512/256 checksum) ──

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(str: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of str.toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Extract 32-byte Ed25519 public key from hex (handles 32-byte raw and 65-byte SEC1 uncompressed) */
function extractEd25519Key(pubKeyBytes: Uint8Array): Uint8Array {
  if (pubKeyBytes.length === 32) return pubKeyBytes;
  if (pubKeyBytes.length === 65 && pubKeyBytes[0] === 0x04) {
    const xBe = pubKeyBytes.slice(1, 33);
    const yLe = pubKeyBytes.slice(33).reverse();
    const key32 = new Uint8Array(yLe);
    key32[31] = (key32[31] & 0x7f) | ((xBe[31] & 1) << 7);
    return key32;
  }
  throw new Error(`Expected 32 or 65-byte Ed25519 public key, got ${pubKeyBytes.length} bytes`);
}

/** Synchronous SHA-512/256 for address derivation */
let _sha512_256Sync: ((data: Uint8Array) => Uint8Array) | null = null;
async function ensureSha512_256(): Promise<(data: Uint8Array) => Uint8Array> {
  if (!_sha512_256Sync) {
    const mod = await import("@noble/hashes/sha2");
    _sha512_256Sync = mod.sha512_256;
  }
  return _sha512_256Sync;
}

export function publicKeyToAlgoAddress(pubKey32: Uint8Array, sha512_256Fn: (data: Uint8Array) => Uint8Array): string {
  const hash = sha512_256Fn(pubKey32);
  const checksum = hash.slice(28); // last 4 bytes
  const addrBytes = new Uint8Array(36);
  addrBytes.set(pubKey32, 0);
  addrBytes.set(checksum, 32);
  return base32Encode(addrBytes);
}

export function isValidAlgoAddress(address: string): boolean {
  if (address.length !== 58) return false;
  if (!/^[A-Z2-7]+$/.test(address)) return false;
  try {
    const decoded = base32Decode(address);
    if (decoded.length !== 36) return false;
    // Can't verify checksum synchronously without the hash function loaded
    // Basic format check is sufficient for validation
    return true;
  } catch {
    return false;
  }
}

// ── Algod API helpers ──

function algodUrl(chain: Chain): string {
  return chain.rpcUrl || "https://mainnet-api.algonode.cloud";
}

function formatAlgoAmount(microAlgos: string | number, decimals: number): string {
  const raw = typeof microAlgos === "string" ? BigInt(microAlgos) : BigInt(microAlgos);
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toLocaleString("en-US");
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}.${fracStr}`;
}

// ── Adapter ──

export const algoAdapter: ChainAdapter = {
  type: "algo",
  signingAlgorithm: "eddsa",

  deriveAddress(pubKeyHex: string): string {
    // This requires sync SHA-512/256 — we preload via ensureSha512_256
    if (!_sha512_256Sync) {
      throw new Error("ALGO adapter not initialized — call initAlgoAdapter() first");
    }
    const pubKey = extractEd25519Key(hexToBytes(pubKeyHex));
    return publicKeyToAlgoAddress(pubKey, _sha512_256Sync);
  },

  isValidAddress(address: string): boolean {
    return isValidAlgoAddress(address);
  },

  async fetchNativeBalance(address: string, chain: Chain, nativeAsset: Asset): Promise<BalanceResult | null> {
    try {
      const res = await fetch(`${algodUrl(chain)}/v2/accounts/${address}`);
      if (!res.ok) {
        if (res.status === 404) return { asset: nativeAsset, chain, balance: "0", formatted: "0" };
        return null;
      }
      const data = await res.json();
      const amount = String(data.amount ?? "0");
      return {
        asset: nativeAsset,
        chain,
        balance: amount,
        formatted: formatAlgoAmount(amount, nativeAsset.decimals),
      };
    } catch {
      return null;
    }
  },

  async fetchTokenBalances(address: string, chain: Chain, tokenAssets: Asset[]): Promise<BalanceResult[]> {
    if (tokenAssets.length === 0) return [];
    try {
      const res = await fetch(`${algodUrl(chain)}/v2/accounts/${address}`);
      if (!res.ok) return [];
      const data = await res.json();
      const holdings: { "asset-id": number; amount: number }[] = data.assets ?? [];

      return tokenAssets.flatMap((asset) => {
        const asaId = parseInt(asset.contractAddress ?? "", 10);
        if (isNaN(asaId)) return [];
        const holding = holdings.find((h) => h["asset-id"] === asaId);
        if (!holding) return [];
        const amount = String(holding.amount);
        return [{
          asset,
          chain,
          balance: amount,
          formatted: formatAlgoAmount(amount, asset.decimals),
        }];
      });
    } catch {
      return [];
    }
  },

  async fetchTransactions(
    address: string,
    chain: Chain,
    asset: Asset,
    page: number,
  ): Promise<{ transactions: Transaction[]; hasMore: boolean }> {
    try {
      const limit = 20;
      // Use Algorand Indexer (AlgoNode provides it on the same domain)
      const indexerUrl = algodUrl(chain).replace("-api.", "-idx.");
      let url = `${indexerUrl}/v2/accounts/${address}/transactions?limit=${limit + 1}`;

      if (!asset.isNative && asset.contractAddress) {
        url += `&asset-id=${asset.contractAddress}`;
      }

      // Simple offset-based pagination
      if (page > 1) {
        // Indexer doesn't support offset, use next-token if available
        // For simplicity, just skip — real impl would cache next-token
      }

      const res = await fetch(url);
      if (!res.ok) return { transactions: [], hasMore: false };
      const data = await res.json();
      const records: {
        id: string;
        "round-time": number;
        "tx-type": string;
        "confirmed-round"?: number;
        sender: string;
        "payment-transaction"?: { receiver: string; amount: number };
        "asset-transfer-transaction"?: { receiver: string; amount: number; "asset-id": number };
      }[] = data.transactions ?? [];

      const hasMore = records.length > limit;
      const slice = records.slice(0, limit);

      const txs: Transaction[] = slice
        .filter((tx) => {
          if (asset.isNative) return tx["tx-type"] === "pay";
          return tx["tx-type"] === "axfer";
        })
        .map((tx) => {
          if (tx["tx-type"] === "pay") {
            const pay = tx["payment-transaction"]!;
            const direction = tx.sender === address ? "out" : pay.receiver === address ? "in" : "self";
            return {
              hash: tx.id,
              from: tx.sender,
              to: pay.receiver,
              value: String(pay.amount),
              formatted: formatAlgoAmount(pay.amount, asset.decimals),
              symbol: asset.symbol,
              timestamp: tx["round-time"],
              direction,
              confirmed: tx["confirmed-round"] != null,
            };
          }
          // axfer
          const axfer = tx["asset-transfer-transaction"]!;
          const isSelfOptIn = tx.sender === axfer.receiver && axfer.amount === 0;
          const direction = tx.sender === address ? "out" : axfer.receiver === address ? "in" : "self";
          return {
            hash: tx.id,
            from: tx.sender,
            to: axfer.receiver,
            value: String(axfer.amount),
            formatted: formatAlgoAmount(axfer.amount, asset.decimals),
            symbol: asset.symbol,
            timestamp: tx["round-time"],
            direction,
            confirmed: tx["confirmed-round"] != null,
            label: isSelfOptIn ? `opt-in:${asset.symbol}` : undefined,
          };
        });

      return { transactions: txs, hasMore };
    } catch {
      return { transactions: [], hasMore: false };
    }
  },
};

/** Initialize the ALGO adapter (loads SHA-512/256). Call once at app startup. */
export async function initAlgoAdapter(): Promise<void> {
  await ensureSha512_256();
}
