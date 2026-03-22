// BCH transaction building and signing.
// BCH uses P2PKH (legacy format) with SIGHASH_FORKID (BIP143-style sighash).
// No SegWit on BCH — all transactions are legacy format.

import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58check } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes, bytesToHex } from "../../shared/utils";
import { decodeCashAddr } from "./bchAdapter";

const b58check = base58check(sha256);

// BCH uses SIGHASH_ALL | SIGHASH_FORKID
const SIGHASH_ALL = 0x01;
const SIGHASH_FORKID = 0x40;
const BCH_SIGHASH = SIGHASH_ALL | SIGHASH_FORKID; // 0x41

// ── Hashing ─────────────────────────────────────────────────────

function hash256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

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

function writeU32LE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >> 8) & 0xff;
  b[2] = (n >> 16) & 0xff;
  b[3] = (n >> 24) & 0xff;
  return b;
}

function writeU64LE(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((n >> BigInt(i * 8)) & 0xffn);
  return b;
}

function writeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const b = new Uint8Array(3);
    b[0] = 0xfd;
    b[1] = n & 0xff;
    b[2] = (n >> 8) & 0xff;
    return b;
  }
  const b = new Uint8Array(5);
  b[0] = 0xfe;
  b[1] = n & 0xff;
  b[2] = (n >> 8) & 0xff;
  b[3] = (n >> 16) & 0xff;
  b[4] = (n >> 24) & 0xff;
  return b;
}

function reverseBytes(b: Uint8Array): Uint8Array {
  const r = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) r[i] = b[b.length - 1 - i];
  return r;
}

// ── Types ───────────────────────────────────────────────────────

export interface UTXO {
  txid: string;
  vout: number;
  value: number; // satoshis
  status: { confirmed: boolean; block_height?: number };
}

export interface BchInput {
  txid: string; // hex, big-endian
  vout: number;
  value: bigint; // satoshis
  sequence: number;
}

export interface BchOutput {
  value: bigint; // satoshis
  scriptPubKey: Uint8Array;
}

export interface BchUnsignedTx {
  version: number;
  inputs: BchInput[];
  outputs: BchOutput[];
  locktime: number;
}

export interface FeeRates {
  suggested: number; // sat/byte
}

// ── API helpers ─────────────────────────────────────────────────

const BCH_API_DEFAULT = "https://api.blockchair.com/bitcoin-cash";

export function bchApiUrl(_explorerUrl?: string): string {
  // For BCH, rpcUrl stores the Blockchair API base
  return BCH_API_DEFAULT;
}

export async function fetchUtxos(address: string, apiBase?: string): Promise<UTXO[]> {
  const api = apiBase ?? BCH_API_DEFAULT;
  const res = await fetch(`${api}/dashboards/address/${address}?limit=1`);
  if (!res.ok) throw new Error(`Failed to fetch UTXOs: ${res.status}`);
  const data = await res.json();
  const addrKey = Object.keys(data.data || {})[0];
  if (!addrKey) return [];

  const utxos = data.data[addrKey]?.utxo || [];
  return utxos.map((u: { transaction_hash: string; index: number; value: number; block_id: number }) => ({
    txid: u.transaction_hash,
    vout: u.index,
    value: u.value,
    status: { confirmed: u.block_id > 0, block_height: u.block_id > 0 ? u.block_id : undefined },
  }));
}

export async function fetchFeeRates(_apiBase?: string): Promise<FeeRates> {
  // BCH fees are typically 1 sat/byte — very cheap
  return { suggested: 1 };
}

// ── Address → scriptPubKey ──────────────────────────────────────

export function addressToScriptPubKey(address: string): Uint8Array {
  // CashAddr format
  if (address.includes(":") || address.startsWith("q") || address.startsWith("p")) {
    const decoded = decodeCashAddr(address);
    if (decoded.type === 0) {
      // P2PKH
      return concat(
        new Uint8Array([0x76, 0xa9, 0x14]),
        decoded.hash,
        new Uint8Array([0x88, 0xac]),
      );
    }
    if (decoded.type === 1) {
      // P2SH
      return concat(new Uint8Array([0xa9, 0x14]), decoded.hash, new Uint8Array([0x87]));
    }
    throw new Error(`Unsupported CashAddr type: ${decoded.type}`);
  }

  // Legacy P2PKH: starts with 1 (mainnet) or m/n (testnet)
  if (address.startsWith("1") || address.startsWith("m") || address.startsWith("n")) {
    const decoded = b58check.decode(address);
    const h = decoded.slice(1);
    return concat(
      new Uint8Array([0x76, 0xa9, 0x14]),
      h,
      new Uint8Array([0x88, 0xac]),
    );
  }

  // Legacy P2SH: starts with 3 (mainnet) or 2 (testnet)
  if (address.startsWith("3") || address.startsWith("2")) {
    const decoded = b58check.decode(address);
    const h = decoded.slice(1);
    return concat(new Uint8Array([0xa9, 0x14]), h, new Uint8Array([0x87]));
  }

  throw new Error(`Unsupported BCH address format: ${address}`);
}

// ── Public key helpers ──────────────────────────────────────────

export function getCompressedPublicKey(rawHex: string): Uint8Array {
  const point = secp256k1.Point.fromHex(rawHex);
  return hexToBytes(point.toHex(true));
}

export function pubKeyHash(compressedPubKey: Uint8Array): Uint8Array {
  return hash160(compressedPubKey);
}

// ── Transaction size estimation ──────────────────────────────────

/** Estimate bytes for P2PKH (legacy) transaction */
export function estimateLegacyBytes(numInputs: number, numOutputs: number): number {
  return 10 + 148 * numInputs + 34 * numOutputs;
}

export function estimateFee(numInputs: number, feeRateSatPerByte: number, hasChange: boolean): bigint {
  const size = estimateLegacyBytes(numInputs, hasChange ? 2 : 1);
  return BigInt(Math.ceil(size * feeRateSatPerByte));
}

// ── UTXO Selection ──────────────────────────────────────────────

const DUST_LIMIT = 546n;

export function selectUtxos(
  utxos: UTXO[],
  targetSats: bigint,
  feeRateSatPerByte: number,
  useAll: boolean = false,
): { selected: UTXO[]; fee: bigint; change: bigint } {
  if (useAll) {
    const confirmedAll = utxos.filter((u) => u.status.confirmed);
    const selected = confirmedAll.length > 0 ? confirmedAll : utxos;
    const totalIn = selected.reduce((sum, u) => sum + BigInt(u.value), 0n);
    const size2 = estimateLegacyBytes(selected.length, 2);
    const fee2 = BigInt(Math.ceil(size2 * feeRateSatPerByte));

    if (totalIn < targetSats + fee2) {
      const size1 = estimateLegacyBytes(selected.length, 1);
      const fee1 = BigInt(Math.ceil(size1 * feeRateSatPerByte));
      if (totalIn < targetSats + fee1) {
        throw new Error("Insufficient funds (selected UTXOs too small)");
      }
      return { selected, fee: totalIn - targetSats, change: 0n };
    }

    const change = totalIn - targetSats - fee2;
    if (change > 0n && change < DUST_LIMIT) {
      return { selected, fee: fee2 + change, change: 0n };
    }
    if (change === 0n) {
      const fee1 = BigInt(Math.ceil(estimateLegacyBytes(selected.length, 1) * feeRateSatPerByte));
      return { selected, fee: fee1, change: 0n };
    }
    return { selected, fee: fee2, change };
  }

  // BCH supports 0-conf: prefer confirmed UTXOs, fall back to unconfirmed
  const confirmed = utxos.filter((u) => u.status.confirmed);
  const sorted = [...(confirmed.length > 0 ? confirmed : utxos)]
    .sort((a, b) => b.value - a.value);

  const selected: UTXO[] = [];
  let totalIn = 0n;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalIn += BigInt(utxo.value);

    const size = estimateLegacyBytes(selected.length, 2);
    const fee = BigInt(Math.ceil(size * feeRateSatPerByte));

    if (totalIn >= targetSats + fee) {
      const change = totalIn - targetSats - fee;
      if (change > 0n && change < DUST_LIMIT) {
        return { selected, fee: fee + change, change: 0n };
      }
      if (change === 0n) {
        const fee1 = BigInt(Math.ceil(estimateLegacyBytes(selected.length, 1) * feeRateSatPerByte));
        return { selected, fee: fee1, change: 0n };
      }
      return { selected, fee, change };
    }
  }

  throw new Error(utxos.length === 0
    ? "No UTXOs found — balance may be stale. Try refreshing."
    : `Insufficient funds (${utxos.length} UTXOs, ${confirmed.length} confirmed)`);
}

// ── Build transaction ───────────────────────────────────────────

export function buildBchTransaction(
  toAddress: string,
  amountSats: bigint,
  utxos: UTXO[],
  feeRateSatPerByte: number,
  changeAddress: string,
  useAllUtxos: boolean = false,
): BchUnsignedTx {
  const { selected, change } = selectUtxos(utxos, amountSats, feeRateSatPerByte, useAllUtxos);

  const inputs: BchInput[] = selected.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: BigInt(u.value),
    sequence: 0xffffffff,
  }));

  const outputs: BchOutput[] = [
    { value: amountSats, scriptPubKey: addressToScriptPubKey(toAddress) },
  ];

  if (change > 0n) {
    outputs.push({ value: change, scriptPubKey: addressToScriptPubKey(changeAddress) });
  }

  return { version: 2, inputs, outputs, locktime: 0 };
}

// ── BCH Sighash (BIP143-style with SIGHASH_FORKID) ──────────────

/**
 * BCH uses BIP143-style sighash with SIGHASH_FORKID flag.
 * Hash type = SIGHASH_ALL | SIGHASH_FORKID = 0x41
 */
export function bchSighash(
  tx: BchUnsignedTx,
  inputIndex: number,
  pubKeyHash20: Uint8Array,
): Uint8Array {
  const input = tx.inputs[inputIndex];

  const prevouts = concat(
    ...tx.inputs.map((i) => concat(reverseBytes(hexToBytes(i.txid)), writeU32LE(i.vout))),
  );
  const hashPrevouts = hash256(prevouts);

  const sequences = concat(...tx.inputs.map((i) => writeU32LE(i.sequence)));
  const hashSequence = hash256(sequences);

  const outputsData = concat(
    ...tx.outputs.map((o) =>
      concat(writeU64LE(o.value), writeVarInt(o.scriptPubKey.length), o.scriptPubKey),
    ),
  );
  const hashOutputs = hash256(outputsData);

  // scriptCode for P2PKH: length + OP_DUP OP_HASH160 PUSH_20 <hash> OP_EQUALVERIFY OP_CHECKSIG
  const scriptCode = concat(
    new Uint8Array([0x19, 0x76, 0xa9, 0x14]),
    pubKeyHash20,
    new Uint8Array([0x88, 0xac]),
  );

  const preimage = concat(
    writeU32LE(tx.version),
    hashPrevouts,
    hashSequence,
    reverseBytes(hexToBytes(input.txid)),
    writeU32LE(input.vout),
    scriptCode,
    writeU64LE(input.value),
    writeU32LE(input.sequence),
    hashOutputs,
    writeU32LE(tx.locktime),
    writeU32LE(BCH_SIGHASH), // 0x41 — SIGHASH_ALL | SIGHASH_FORKID
  );

  return hash256(preimage);
}

// ── DER Signature encoding ──────────────────────────────────────

function bigintToMinBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array([0]);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = hexToBytes(hex);
  if (bytes[0] & 0x80) {
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes, 1);
    return padded;
  }
  return bytes;
}

export function encodeDerSignature(r: bigint, s: bigint): Uint8Array {
  const rBytes = bigintToMinBytes(r);
  const sBytes = bigintToMinBytes(s);
  const totalLen = 2 + rBytes.length + 2 + sBytes.length;
  return concat(
    new Uint8Array([0x30, totalLen, 0x02, rBytes.length]),
    rBytes,
    new Uint8Array([0x02, sBytes.length]),
    sBytes,
  );
}

/** Create P2PKH scriptSig: PUSH(DER_sig + BCH_SIGHASH) PUSH(compressed_pubkey) */
export function makeP2PKHScriptSig(
  r: bigint,
  s: bigint,
  compressedPubKey: Uint8Array,
): Uint8Array {
  const der = encodeDerSignature(r, s);
  const sigWithHashType = new Uint8Array(der.length + 1);
  sigWithHashType.set(der);
  sigWithHashType[der.length] = BCH_SIGHASH; // 0x41
  return concat(
    new Uint8Array([sigWithHashType.length]),
    sigWithHashType,
    new Uint8Array([compressedPubKey.length]),
    compressedPubKey,
  );
}

// ── Serialization ───────────────────────────────────────────────

/** Serialize legacy transaction with scriptSigs */
export function serializeBchTx(
  tx: BchUnsignedTx,
  scriptSigs: Uint8Array[],
): Uint8Array {
  const parts: Uint8Array[] = [
    writeU32LE(tx.version),
    writeVarInt(tx.inputs.length),
  ];

  for (let i = 0; i < tx.inputs.length; i++) {
    const inp = tx.inputs[i];
    const scriptSig = scriptSigs[i];
    parts.push(
      reverseBytes(hexToBytes(inp.txid)),
      writeU32LE(inp.vout),
      writeVarInt(scriptSig.length),
      scriptSig,
      writeU32LE(inp.sequence),
    );
  }

  parts.push(writeVarInt(tx.outputs.length));
  for (const out of tx.outputs) {
    parts.push(writeU64LE(out.value), writeVarInt(out.scriptPubKey.length), out.scriptPubKey);
  }

  parts.push(writeU32LE(tx.locktime));
  return concat(...parts);
}

/** Compute txid from legacy transaction */
export function computeTxid(tx: BchUnsignedTx, scriptSigs: Uint8Array[]): string {
  const raw = serializeBchTx(tx, scriptSigs);
  return bytesToHex(reverseBytes(hash256(raw)));
}

// ── Broadcast ───────────────────────────────────────────────────

export async function broadcastBchTx(rawHex: string, apiBase?: string): Promise<string> {
  const api = apiBase ?? BCH_API_DEFAULT;
  const res = await fetch(`${api}/push/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: rawHex }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Broadcast failed: ${text}`);
  }
  const data = await res.json();
  return data.data?.transaction_hash ?? rawHex;
}

// ── Wait for confirmation ───────────────────────────────────────

export async function waitForBchConfirmation(
  txid: string,
  onPoll?: (attempt: number) => void,
  maxAttempts = 60,
  intervalMs = 5000,
  apiBase?: string,
): Promise<{ confirmed: boolean; blockHeight?: number }> {
  const api = apiBase ?? BCH_API_DEFAULT;
  for (let i = 0; i < maxAttempts; i++) {
    onPoll?.(i + 1);
    try {
      const res = await fetch(`${api}/dashboards/transaction/${txid}`);
      if (res.ok) {
        const data = await res.json();
        const tx = data.data?.[txid]?.transaction;
        if (tx?.block_id > 0) {
          return { confirmed: true, blockHeight: tx.block_id };
        }
      }
    } catch { /* ignore, keep polling */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { confirmed: false };
}

// ── Address validation ──────────────────────────────────────────

export function isValidBchAddress(address: string): boolean {
  try {
    if (address.includes(":") || address.startsWith("q") || address.startsWith("p")) {
      decodeCashAddr(address);
      return true;
    }
    if (address.startsWith("1") || address.startsWith("3") || address.startsWith("m") || address.startsWith("n") || address.startsWith("2")) {
      b58check.decode(address);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Format helpers ──────────────────────────────────────────────

export function formatBchFee(sats: bigint): string {
  const bch = Number(sats) / 1e8;
  if (bch === 0) return "0";
  if (bch < 0.00000001) return "< 0.00000001";
  return bch.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatSats(sats: bigint): string {
  return sats.toLocaleString();
}
