// Litecoin transaction support — reuses BTC UTXO/sighash logic with LTC-specific
// address formats and API endpoints (mempool-compatible Litecoin explorer).

import { sha256 } from "@noble/hashes/sha256";
import { bech32, base58check } from "@scure/base";

const b58check = base58check(sha256);

// Re-export shared BTC primitives that are identical for LTC
export {
  type UTXO,
  type BtcInput as LtcInput,
  type BtcOutput as LtcOutput,
  type BtcUnsignedTx as LtcUnsignedTx,
  type FeeRates,
  type BtcAddressType as LtcAddressType,
  estimateVBytes,
  estimateLegacyBytes,
  estimateFee,
  selectUtxos,
  bip143Sighash,
  legacySighash,
  getCompressedPublicKey,
  pubKeyHash,
  encodeDerSignature,
  makeP2WPKHWitness,
  makeP2PKHScriptSig,
  serializeWitnessTx,
  serializeLegacyTx,
  computeTxid,
  computeLegacyTxid,
  formatBtcFee as formatLtcFee,
  formatSats,
} from "./btcTx";

import {
  type UTXO,
  type BtcUnsignedTx,
  type BtcInput,
  type BtcOutput,
  type BtcAddressType,
  type FeeRates,
  selectUtxos,
} from "./btcTx";

// ── Binary helpers ──────────────────────────────────────────────

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

// ── LTC mempool-compatible API ──────────────────────────────────

const LTC_API_DEFAULT = "https://litecoinspace.org/api";

export function ltcApiUrl(explorerUrl?: string): string {
  if (!explorerUrl) return LTC_API_DEFAULT;
  const base = explorerUrl.replace(/\/+$/, "");
  return `${base}/api`;
}

export async function fetchUtxos(address: string, apiBase?: string): Promise<UTXO[]> {
  const api = apiBase ?? LTC_API_DEFAULT;
  const res = await fetch(`${api}/address/${address}/utxo`);
  if (!res.ok) throw new Error(`Failed to fetch LTC UTXOs: ${res.status}`);
  return res.json();
}

export async function fetchFeeRates(apiBase?: string): Promise<FeeRates> {
  const api = apiBase ?? LTC_API_DEFAULT;
  const res = await fetch(`${api}/v1/fees/recommended`);
  if (!res.ok) throw new Error(`Failed to fetch LTC fee rates: ${res.status}`);
  return res.json();
}

// ── Address ↔ scriptPubKey (LTC-specific) ────────────────────────

export function addressToScriptPubKey(address: string): Uint8Array {
  // P2WPKH: ltc1q... / tltc1q...
  if (address.startsWith("ltc1q") || address.startsWith("tltc1q")) {
    const { words } = bech32.decode(address as `${string}1${string}`);
    const hashBytes = new Uint8Array(bech32.fromWords(words.slice(1)));
    return concat(new Uint8Array([0x00, 0x14]), hashBytes);
  }

  // P2PKH: LTC mainnet version 0x30 (starts with "L" or "M"), testnet version 0x6f (starts with "m" or "n")
  if (
    address.startsWith("L") ||
    address.startsWith("M") ||
    address.startsWith("m") ||
    address.startsWith("n")
  ) {
    const decoded = b58check.decode(address);
    const ver = decoded[0];
    if (ver === 0x30 || ver === 0x6f) {
      const h = decoded.slice(1);
      return concat(
        new Uint8Array([0x76, 0xa9, 0x14]),
        h,
        new Uint8Array([0x88, 0xac])
      );
    }
    // P2SH: mainnet version 0x32 (starts with "M"), testnet 0xc4 (starts with "2")
    if (ver === 0x32 || ver === 0xc4) {
      const h = decoded.slice(1);
      return concat(new Uint8Array([0xa9, 0x14]), h, new Uint8Array([0x87]));
    }
  }

  // P2SH testnet: starts with "2"
  if (address.startsWith("2")) {
    const decoded = b58check.decode(address);
    const h = decoded.slice(1);
    return concat(new Uint8Array([0xa9, 0x14]), h, new Uint8Array([0x87]));
  }

  throw new Error(`Unsupported LTC address format: ${address}`);
}

// ── Address type detection ───────────────────────────────────────

export function detectAddressType(address: string): BtcAddressType {
  if (address.startsWith("ltc1q") || address.startsWith("tltc1q")) return "p2wpkh";
  return "p2pkh";
}

// ── Build transaction ───────────────────────────────────────────

export function buildLtcTransaction(
  toAddress: string,
  amountSats: bigint,
  utxos: UTXO[],
  feeRateSatPerVB: number,
  changeAddress: string,
  addrType: BtcAddressType = "p2wpkh",
  rbf: boolean = true,
  useAllUtxos: boolean = false,
): BtcUnsignedTx {
  const { selected, change } = selectUtxos(utxos, amountSats, feeRateSatPerVB, addrType, useAllUtxos, toAddress, changeAddress);

  const inputs: BtcInput[] = selected.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: BigInt(u.value),
    sequence: rbf ? 0xfffffffd : 0xffffffff,
  }));

  const outputs: BtcOutput[] = [
    { value: amountSats, scriptPubKey: addressToScriptPubKey(toAddress) },
  ];

  if (change > 0n) {
    outputs.push({
      value: change,
      scriptPubKey: addressToScriptPubKey(changeAddress),
    });
  }

  return { version: 2, inputs, outputs, locktime: 0 };
}

// ── Broadcast ───────────────────────────────────────────────────

export async function broadcastLtcTx(rawHex: string, apiBase?: string): Promise<string> {
  const api = apiBase ?? LTC_API_DEFAULT;
  const res = await fetch(`${api}/tx`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: rawHex,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LTC broadcast failed: ${text}`);
  }
  return res.text();
}

// ── Wait for confirmation ───────────────────────────────────────

export async function waitForLtcConfirmation(
  txid: string,
  onPoll?: (attempt: number) => void,
  maxAttempts = 60,
  intervalMs = 5000,
  apiBase?: string
): Promise<{ confirmed: boolean; blockHeight?: number }> {
  const api = apiBase ?? LTC_API_DEFAULT;
  for (let i = 0; i < maxAttempts; i++) {
    onPoll?.(i + 1);
    try {
      const res = await fetch(`${api}/tx/${txid}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status?.confirmed) {
          return { confirmed: true, blockHeight: data.status.block_height };
        }
      }
    } catch {
      // ignore fetch errors, keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { confirmed: false };
}

// ── Address validation ──────────────────────────────────────────

export function isValidLtcAddress(address: string): boolean {
  try {
    // Bech32 segwit: ltc1q... / tltc1q...
    if (address.startsWith("ltc1") || address.startsWith("tltc1")) {
      bech32.decode(address as `${string}1${string}`);
      return true;
    }
    // Base58: L, M (P2PKH/P2SH mainnet), m, n (P2PKH testnet), 2 (P2SH testnet)
    if (
      address.startsWith("L") ||
      address.startsWith("M") ||
      address.startsWith("m") ||
      address.startsWith("n") ||
      address.startsWith("2")
    ) {
      const decoded = b58check.decode(address);
      const ver = decoded[0];
      // P2PKH mainnet=0x30, testnet=0x6f; P2SH mainnet=0x32, testnet=0xc4
      return ver === 0x30 || ver === 0x6f || ver === 0x32 || ver === 0xc4;
    }
    return false;
  } catch {
    return false;
  }
}
