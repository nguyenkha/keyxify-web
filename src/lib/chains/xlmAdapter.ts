import type { ChainAdapter, Chain, Asset, BalanceResult, Transaction } from "../../shared/types";

// ── Strkey encoding (Stellar address format) ─────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STRKEY_VERSION_ACCOUNT_ID = 6 << 3; // 0x30 → G...

function crc16xmodem(data: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

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

function encodeStrkeyAccountId(pubKey: Uint8Array): string {
  const payload = new Uint8Array(pubKey.length + 3);
  payload[0] = STRKEY_VERSION_ACCOUNT_ID;
  payload.set(pubKey, 1);
  const checksum = crc16xmodem(payload.subarray(0, pubKey.length + 1));
  payload[pubKey.length + 1] = checksum & 0xff;        // little-endian
  payload[pubKey.length + 2] = (checksum >> 8) & 0xff;
  return base32Encode(payload);
}

export function isValidXlmAddress(address: string): boolean {
  if (!address.startsWith("G") || address.length !== 56) return false;
  try {
    const decoded = base32Decode(address);
    if (decoded.length !== 35) return false;
    if (decoded[0] !== STRKEY_VERSION_ACCOUNT_ID) return false;
    const expected = crc16xmodem(decoded.subarray(0, 33));
    const stored = decoded[33] | (decoded[34] << 8);
    return expected === stored;
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function publicKeyToXlmAddress(eddsaPubKeyHex: string): string {
  const pubKeyBytes = hexToBytes(eddsaPubKeyHex);
  let key32: Uint8Array;
  if (pubKeyBytes.length === 32) {
    key32 = pubKeyBytes;
  } else if (pubKeyBytes.length === 65 && pubKeyBytes[0] === 0x04) {
    // SEC1 uncompressed (04 || x_BE(32) || y_BE(32)) → Ed25519 compressed point.
    // SEC1 coordinates are big-endian; Ed25519 encoding is little-endian y
    // with the sign of x in the high bit of the last byte.
    const x_be = pubKeyBytes.slice(1, 33);
    const y_le = pubKeyBytes.slice(33).reverse();
    key32 = new Uint8Array(y_le);
    key32[31] = (key32[31] & 0x7f) | ((x_be[31] & 1) << 7);
  } else {
    throw new Error(`Expected 32 or 65-byte Ed25519 public key, got ${pubKeyBytes.length} bytes`);
  }
  return encodeStrkeyAccountId(key32);
}

// ── Horizon API helpers ──────────────────────────────────────────

function horizonUrl(chain: Chain): string {
  return chain.rpcUrl || "https://horizon.stellar.org";
}

// ── Adapter ──────────────────────────────────────────────────────

export const xlmAdapter: ChainAdapter = {
  type: "xlm",
  signingAlgorithm: "eddsa",

  deriveAddress(pubKeyHex: string, _opts?: { testnet?: boolean }): string {
    return publicKeyToXlmAddress(pubKeyHex);
  },

  isValidAddress(address: string): boolean {
    return isValidXlmAddress(address);
  },

  async fetchNativeBalance(address: string, chain: Chain, nativeAsset: Asset): Promise<BalanceResult | null> {
    try {
      const res = await fetch(`${horizonUrl(chain)}/accounts/${address}`);
      if (res.status === 404) {
        return { asset: nativeAsset, chain, balance: "0", formatted: "0" };
      }
      if (!res.ok) return null;
      const data = await res.json();
      const native = (data.balances as { asset_type: string; balance: string }[])
        ?.find((b) => b.asset_type === "native");
      if (!native) return { asset: nativeAsset, chain, balance: "0", formatted: "0" };
      // Balance is "123.4567890" in XLM (7 decimals = stroops)
      const stroops = Math.round(parseFloat(native.balance) * 1e7).toString();
      return { asset: nativeAsset, chain, balance: stroops, formatted: native.balance };
    } catch {
      return null;
    }
  },

  async fetchTokenBalances(address: string, chain: Chain, tokenAssets: Asset[]): Promise<BalanceResult[]> {
    if (tokenAssets.length === 0) return [];
    try {
      const res = await fetch(`${horizonUrl(chain)}/accounts/${address}`);
      if (!res.ok) return [];
      const data = await res.json();
      const balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }[] =
        data.balances ?? [];

      return tokenAssets.flatMap((asset) => {
        // contractAddress stores the issuer account ID
        const b = balances.find(
          (bl) => bl.asset_code === asset.symbol && bl.asset_issuer === asset.contractAddress,
        );
        if (!b) return [];
        const raw = Math.round(parseFloat(b.balance) * 1e7).toString();
        return [{ asset, chain, balance: raw, formatted: b.balance }];
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
      const cursor = page > 1 ? `&cursor=${(page - 1) * limit}` : "";
      const res = await fetch(
        `${horizonUrl(chain)}/accounts/${address}/operations?limit=${limit + 1}&order=desc${cursor}`,
      );
      if (!res.ok) return { transactions: [], hasMore: false };
      const data = await res.json();
      const records: {
        type: string;
        transaction_hash: string;
        from?: string;
        to?: string;
        amount?: string;
        asset_type?: string;
        asset_code?: string;
        asset_issuer?: string;
        trustor?: string;
        trustee?: string;
        created_at: string;
        transaction_successful: boolean;
      }[] = data._embedded?.records ?? [];

      const hasMore = records.length > limit;
      const slice = records.slice(0, limit);

      const txs: Transaction[] = slice
        .filter((op) => {
          if (asset.isNative) {
            // XLM native: native payments + change_trust ops (fee is paid in XLM)
            if (op.type === "payment") return op.asset_type === "native";
            if (op.type === "change_trust") return true;
            return false;
          } else {
            // Token: only payment ops matching asset
            return op.type === "payment" && op.asset_code === asset.symbol && op.asset_issuer === asset.contractAddress;
          }
        })
        .map((op) => {
          if (op.type === "change_trust") {
            const assetLabel = op.asset_code ?? "token";
            return {
              hash: op.transaction_hash,
              from: op.trustor ?? address,
              to: op.trustee ?? op.asset_issuer ?? "",
              value: "0",
              formatted: "",
              symbol: "",
              label: `Enabled ${assetLabel}`,
              timestamp: Math.floor(new Date(op.created_at).getTime() / 1000),
              direction: "out" as const,
              confirmed: op.transaction_successful,
              failed: !op.transaction_successful,
              isContractCall: true,
            };
          }
          const amount = parseFloat(op.amount ?? "0");
          // For XLM native, value is stroops; for tokens, use raw amount string
          const value = asset.isNative ? Math.round(amount * 1e7).toString() : (op.amount ?? "0");
          const direction = op.from === address ? "out" : op.to === address ? "in" : "self";
          return {
            hash: op.transaction_hash,
            from: op.from ?? "",
            to: op.to ?? "",
            value,
            formatted: amount.toFixed(7),
            symbol: asset.symbol,
            timestamp: Math.floor(new Date(op.created_at).getTime() / 1000),
            direction,
            confirmed: op.transaction_successful,
            failed: !op.transaction_successful,
          };
        });

      return { transactions: txs, hasMore };
    } catch {
      return { transactions: [], hasMore: false };
    }
  },
};
