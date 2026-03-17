import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { bech32, bech32m, base58check } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes, bytesToHex } from "../../shared/utils";

const b58check = base58check(sha256);

// ── Hashing ─────────────────────────────────────────────────────

/** Double SHA256 (Bitcoin standard) */
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

export interface BtcInput {
  txid: string; // hex, big-endian (display order)
  vout: number;
  value: bigint; // satoshis
  sequence: number;
}

export interface BtcOutput {
  value: bigint; // satoshis
  scriptPubKey: Uint8Array;
}

export interface BtcUnsignedTx {
  version: number;
  inputs: BtcInput[];
  outputs: BtcOutput[];
  locktime: number;
}

export interface FeeRates {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

// ── mempool.space API ───────────────────────────────────────────

const MEMPOOL_API_DEFAULT = "https://mempool.space/api";

/** Derive mempool.space API URL from chain explorerUrl (e.g. "https://mempool.space/testnet" → "https://mempool.space/testnet/api") */
export function mempoolApiUrl(explorerUrl?: string): string {
  if (!explorerUrl) return MEMPOOL_API_DEFAULT;
  const base = explorerUrl.replace(/\/+$/, "");
  return `${base}/api`;
}

export async function fetchUtxos(address: string, apiBase?: string): Promise<UTXO[]> {
  const api = apiBase ?? MEMPOOL_API_DEFAULT;
  const res = await fetch(`${api}/address/${address}/utxo`);
  if (!res.ok) throw new Error(`Failed to fetch UTXOs: ${res.status}`);
  return res.json();
}

export async function fetchFeeRates(apiBase?: string): Promise<FeeRates> {
  const api = apiBase ?? MEMPOOL_API_DEFAULT;
  const res = await fetch(`${api}/v1/fees/recommended`);
  if (!res.ok) throw new Error(`Failed to fetch fee rates: ${res.status}`);
  return res.json();
}

// ── Address ↔ scriptPubKey ──────────────────────────────────────

export function addressToScriptPubKey(address: string): Uint8Array {
  // P2WPKH: bc1q... / tb1q...
  if (address.startsWith("bc1q") || address.startsWith("tb1q")) {
    const { words } = bech32.decode(address as `${string}1${string}`);
    const hashBytes = new Uint8Array(bech32.fromWords(words.slice(1)));
    // OP_0 PUSH_20 <20-byte-hash>
    return concat(new Uint8Array([0x00, 0x14]), hashBytes);
  }

  // P2TR: bc1p... / tb1p... (Taproot)
  if (address.startsWith("bc1p") || address.startsWith("tb1p")) {
    const { words } = bech32m.decode(address as `${string}1${string}`);
    const pubkey = new Uint8Array(bech32m.fromWords(words.slice(1)));
    // OP_1 PUSH_32 <32-byte-pubkey>
    return concat(new Uint8Array([0x51, 0x20]), pubkey);
  }

  // P2PKH: starts with 1 (mainnet) or m/n (testnet)
  if (
    address.startsWith("1") ||
    address.startsWith("m") ||
    address.startsWith("n")
  ) {
    const decoded = b58check.decode(address);
    const h = decoded.slice(1); // skip version byte
    // OP_DUP OP_HASH160 PUSH_20 <hash> OP_EQUALVERIFY OP_CHECKSIG
    return concat(
      new Uint8Array([0x76, 0xa9, 0x14]),
      h,
      new Uint8Array([0x88, 0xac])
    );
  }

  // P2SH: starts with 3 (mainnet) or 2 (testnet)
  if (address.startsWith("3") || address.startsWith("2")) {
    const decoded = b58check.decode(address);
    const h = decoded.slice(1);
    // OP_HASH160 PUSH_20 <hash> OP_EQUAL
    return concat(new Uint8Array([0xa9, 0x14]), h, new Uint8Array([0x87]));
  }

  throw new Error(`Unsupported address format: ${address}`);
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

/** Output size in bytes based on scriptPubKey type:
 * P2WPKH: 8(value) + 1(varint) + 22(script) = 31
 * P2PKH:  8(value) + 1(varint) + 25(script) = 34
 * P2SH:   8(value) + 1(varint) + 23(script) = 32
 * P2TR:   8(value) + 1(varint) + 34(script) = 43
 */
function outputSize(address?: string): number {
  if (!address) return 34; // conservative default
  if (address.startsWith("bc1p") || address.startsWith("tb1p")) return 43; // P2TR
  if (address.startsWith("bc1q") || address.startsWith("tb1q") ||
      address.startsWith("ltc1q") || address.startsWith("tltc1q")) return 31; // P2WPKH
  if (address.startsWith("3") || address.startsWith("2") ||
      address.startsWith("M")) return 32; // P2SH
  return 34; // P2PKH (1, m, n, L)
}

/** Estimate vbytes for P2WPKH (segwit) transaction */
export function estimateVBytes(
  numInputs: number,
  numOutputs: number,
  destAddress?: string,
  changeAddress?: string,
): number {
  // Non-witness: version(4) + vinCount(1) + inputs(41*n) + voutCount(1) + outputs + locktime(4)
  const destOut = outputSize(destAddress);
  const changeOut = numOutputs > 1 ? outputSize(changeAddress) : 0;
  const totalOutputBytes = destOut + changeOut;
  const nonWitness = 10 + 41 * numInputs + totalOutputBytes;
  // Witness: marker+flag(2) + per-input witness(1+1+72+1+33 = 108)
  const witness = 2 + 108 * numInputs;
  return Math.ceil(nonWitness + witness / 4);
}

/** Estimate bytes for P2PKH (legacy) transaction */
export function estimateLegacyBytes(
  numInputs: number,
  numOutputs: number,
  destAddress?: string,
  changeAddress?: string,
): number {
  // 148 per input = prevhash(32) + vout(4) + scriptSigLen(1) + scriptSig(~107) + sequence(4)
  const destOut = outputSize(destAddress);
  const changeOut = numOutputs > 1 ? outputSize(changeAddress) : 0;
  const totalOutputBytes = destOut + changeOut;
  return 10 + 148 * numInputs + totalOutputBytes;
}

export function estimateFee(
  numInputs: number,
  feeRateSatPerVB: number,
  hasChange: boolean,
  addrType: BtcAddressType = "p2wpkh",
  destAddress?: string,
  changeAddress?: string,
): bigint {
  const numOutputs = hasChange ? 2 : 1;
  const size = addrType === "p2pkh"
    ? estimateLegacyBytes(numInputs, numOutputs, destAddress, changeAddress)
    : estimateVBytes(numInputs, numOutputs, destAddress, changeAddress);
  return BigInt(Math.ceil(size * feeRateSatPerVB));
}

// ── UTXO Selection ──────────────────────────────────────────────

const DUST_LIMIT = 546n;

export function selectUtxos(
  utxos: UTXO[],
  targetSats: bigint,
  feeRateSatPerVB: number,
  addrType: BtcAddressType = "p2wpkh",
  useAll: boolean = false,
  destAddress?: string,
  changeAddress?: string,
): { selected: UTXO[]; fee: bigint; change: bigint } {
  const estSize = (nIn: number, nOut: number) =>
    addrType === "p2pkh"
      ? estimateLegacyBytes(nIn, nOut, destAddress, changeAddress)
      : estimateVBytes(nIn, nOut, destAddress, changeAddress);

  if (useAll) {
    // Manual UTXO selection: use all provided UTXOs as-is
    const selected = utxos.filter((u) => u.status.confirmed);
    const totalIn = selected.reduce((sum, u) => sum + BigInt(u.value), 0n);
    const size2 = estSize(selected.length, 2);
    const fee2 = BigInt(Math.ceil(size2 * feeRateSatPerVB));

    if (totalIn < targetSats + fee2) {
      // Try with 1 output (no change)
      const size1 = estSize(selected.length, 1);
      const fee1 = BigInt(Math.ceil(size1 * feeRateSatPerVB));
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
      const fee1 = BigInt(Math.ceil(estSize(selected.length, 1) * feeRateSatPerVB));
      return { selected, fee: fee1, change: 0n };
    }
    return { selected, fee: fee2, change };
  }

  // Sort by value descending (prefer larger UTXOs to minimize inputs)
  const sorted = [...utxos]
    .filter((u) => u.status.confirmed)
    .sort((a, b) => b.value - a.value);

  const selected: UTXO[] = [];
  let totalIn = 0n;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalIn += BigInt(utxo.value);

    // Estimate fee with 2 outputs (recipient + change)
    const size = estSize(selected.length, 2);
    const fee = BigInt(Math.ceil(size * feeRateSatPerVB));

    if (totalIn >= targetSats + fee) {
      const change = totalIn - targetSats - fee;

      // If change is dust, add to fee instead
      if (change > 0n && change < DUST_LIMIT) {
        return { selected, fee: fee + change, change: 0n };
      }

      // If no change, recalculate fee with 1 output
      if (change === 0n) {
        const fee1 = BigInt(
          Math.ceil(estSize(selected.length, 1) * feeRateSatPerVB)
        );
        return { selected, fee: fee1, change: 0n };
      }

      return { selected, fee, change };
    }
  }

  throw new Error("Insufficient funds (not enough confirmed UTXOs)");
}

// ── Build transaction ───────────────────────────────────────────

export function buildBtcTransaction(
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

// ── Address type detection ───────────────────────────────────────

export type BtcAddressType = "p2wpkh" | "p2pkh";

export function detectAddressType(address: string): BtcAddressType {
  if (address.startsWith("bc1q") || address.startsWith("tb1q")) return "p2wpkh";
  return "p2pkh";
}

// ── Legacy sighash (for P2PKH) ─────────────────────────────────

/** Compute legacy sighash for P2PKH inputs (pre-BIP143) */
export function legacySighash(
  tx: BtcUnsignedTx,
  inputIndex: number,
  pubKeyHash20: Uint8Array
): Uint8Array {
  // scriptPubKey for P2PKH: OP_DUP OP_HASH160 PUSH_20 <hash> OP_EQUALVERIFY OP_CHECKSIG
  const scriptPubKey = concat(
    new Uint8Array([0x76, 0xa9, 0x14]),
    pubKeyHash20,
    new Uint8Array([0x88, 0xac])
  );

  const parts: Uint8Array[] = [writeU32LE(tx.version), writeVarInt(tx.inputs.length)];

  for (let i = 0; i < tx.inputs.length; i++) {
    const inp = tx.inputs[i];
    parts.push(reverseBytes(hexToBytes(inp.txid)), writeU32LE(inp.vout));
    if (i === inputIndex) {
      // Insert scriptPubKey for the input being signed
      parts.push(writeVarInt(scriptPubKey.length), scriptPubKey);
    } else {
      // Empty script for other inputs
      parts.push(writeVarInt(0));
    }
    parts.push(writeU32LE(inp.sequence));
  }

  parts.push(writeVarInt(tx.outputs.length));
  for (const out of tx.outputs) {
    parts.push(writeU64LE(out.value), writeVarInt(out.scriptPubKey.length), out.scriptPubKey);
  }

  parts.push(writeU32LE(tx.locktime));
  parts.push(writeU32LE(1)); // SIGHASH_ALL

  return hash256(concat(...parts));
}

// ── BIP143 Sighash (for P2WPKH) ────────────────────────────────

export function bip143Sighash(
  tx: BtcUnsignedTx,
  inputIndex: number,
  pubKeyHash20: Uint8Array
): Uint8Array {
  const input = tx.inputs[inputIndex];

  // hashPrevouts = hash256(all outpoints)
  const prevouts = concat(
    ...tx.inputs.map((i) =>
      concat(reverseBytes(hexToBytes(i.txid)), writeU32LE(i.vout))
    )
  );
  const hashPrevouts = hash256(prevouts);

  // hashSequence = hash256(all sequences)
  const sequences = concat(...tx.inputs.map((i) => writeU32LE(i.sequence)));
  const hashSequence = hash256(sequences);

  // hashOutputs = hash256(all outputs)
  const outputsData = concat(
    ...tx.outputs.map((o) =>
      concat(writeU64LE(o.value), writeVarInt(o.scriptPubKey.length), o.scriptPubKey)
    )
  );
  const hashOutputs = hash256(outputsData);

  // scriptCode for P2WPKH: length + OP_DUP OP_HASH160 PUSH_20 <hash> OP_EQUALVERIFY OP_CHECKSIG
  const scriptCode = concat(
    new Uint8Array([0x19, 0x76, 0xa9, 0x14]),
    pubKeyHash20,
    new Uint8Array([0x88, 0xac])
  );

  // BIP143 preimage
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
    writeU32LE(1) // SIGHASH_ALL
  );

  return hash256(preimage);
}

// ── DER Signature encoding ──────────────────────────────────────

function bigintToMinBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array([0]);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = hexToBytes(hex);
  // Add leading zero if high bit is set (DER positive integer)
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
    sBytes
  );
}

/** Create P2WPKH witness stack: [DER_sig + SIGHASH_ALL, compressed_pubkey] */
export function makeP2WPKHWitness(
  r: bigint,
  s: bigint,
  compressedPubKey: Uint8Array
): Uint8Array[] {
  const der = encodeDerSignature(r, s);
  // Append SIGHASH_ALL (0x01)
  const sigWithHashType = new Uint8Array(der.length + 1);
  sigWithHashType.set(der);
  sigWithHashType[der.length] = 0x01;
  return [sigWithHashType, compressedPubKey];
}

/** Create P2PKH scriptSig: PUSH(DER_sig + SIGHASH_ALL) PUSH(compressed_pubkey) */
export function makeP2PKHScriptSig(
  r: bigint,
  s: bigint,
  compressedPubKey: Uint8Array
): Uint8Array {
  const der = encodeDerSignature(r, s);
  const sigWithHashType = new Uint8Array(der.length + 1);
  sigWithHashType.set(der);
  sigWithHashType[der.length] = 0x01;
  return concat(
    new Uint8Array([sigWithHashType.length]),
    sigWithHashType,
    new Uint8Array([compressedPubKey.length]),
    compressedPubKey
  );
}

// ── Serialization ───────────────────────────────────────────────

/** Serialize without witness (for txid computation) */
function serializeNoWitness(tx: BtcUnsignedTx): Uint8Array {
  const parts: Uint8Array[] = [
    writeU32LE(tx.version),
    writeVarInt(tx.inputs.length),
  ];

  for (const inp of tx.inputs) {
    parts.push(
      reverseBytes(hexToBytes(inp.txid)),
      writeU32LE(inp.vout),
      writeVarInt(0), // empty scriptSig for segwit
      writeU32LE(inp.sequence)
    );
  }

  parts.push(writeVarInt(tx.outputs.length));
  for (const out of tx.outputs) {
    parts.push(
      writeU64LE(out.value),
      writeVarInt(out.scriptPubKey.length),
      out.scriptPubKey
    );
  }

  parts.push(writeU32LE(tx.locktime));
  return concat(...parts);
}

/** Serialize legacy transaction with scriptSigs (for P2PKH) */
export function serializeLegacyTx(
  tx: BtcUnsignedTx,
  scriptSigs: Uint8Array[] // per-input scriptSig
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
      writeU32LE(inp.sequence)
    );
  }

  parts.push(writeVarInt(tx.outputs.length));
  for (const out of tx.outputs) {
    parts.push(
      writeU64LE(out.value),
      writeVarInt(out.scriptPubKey.length),
      out.scriptPubKey
    );
  }

  parts.push(writeU32LE(tx.locktime));
  return concat(...parts);
}

/** Compute txid from legacy transaction with scriptSigs */
export function computeLegacyTxid(tx: BtcUnsignedTx, scriptSigs: Uint8Array[]): string {
  const raw = serializeLegacyTx(tx, scriptSigs);
  return bytesToHex(reverseBytes(hash256(raw)));
}

/** Serialize with witness data for broadcasting */
export function serializeWitnessTx(
  tx: BtcUnsignedTx,
  witnesses: Uint8Array[][] // per-input witness items
): Uint8Array {
  const parts: Uint8Array[] = [
    writeU32LE(tx.version),
    new Uint8Array([0x00, 0x01]), // segwit marker + flag
    writeVarInt(tx.inputs.length),
  ];

  for (const inp of tx.inputs) {
    parts.push(
      reverseBytes(hexToBytes(inp.txid)),
      writeU32LE(inp.vout),
      writeVarInt(0), // empty scriptSig
      writeU32LE(inp.sequence)
    );
  }

  parts.push(writeVarInt(tx.outputs.length));
  for (const out of tx.outputs) {
    parts.push(
      writeU64LE(out.value),
      writeVarInt(out.scriptPubKey.length),
      out.scriptPubKey
    );
  }

  // Witness data for each input
  for (const witness of witnesses) {
    parts.push(writeVarInt(witness.length)); // number of stack items
    for (const item of witness) {
      parts.push(writeVarInt(item.length), item);
    }
  }

  parts.push(writeU32LE(tx.locktime));
  return concat(...parts);
}

/** Compute txid from non-witness serialization */
export function computeTxid(tx: BtcUnsignedTx): string {
  const raw = serializeNoWitness(tx);
  return bytesToHex(reverseBytes(hash256(raw)));
}

// ── Broadcast ───────────────────────────────────────────────────

export async function broadcastBtcTx(rawHex: string, apiBase?: string): Promise<string> {
  const api = apiBase ?? MEMPOOL_API_DEFAULT;
  const res = await fetch(`${api}/tx`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: rawHex,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Broadcast failed: ${text}`);
  }
  return res.text(); // returns txid
}

// ── Wait for confirmation ───────────────────────────────────────

export async function waitForBtcConfirmation(
  txid: string,
  onPoll?: (attempt: number) => void,
  maxAttempts = 60,
  intervalMs = 5000,
  apiBase?: string
): Promise<{ confirmed: boolean; blockHeight?: number }> {
  const api = apiBase ?? MEMPOOL_API_DEFAULT;
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

export function isValidBtcAddress(address: string): boolean {
  try {
    if (address.startsWith("bc1") || address.startsWith("tb1")) {
      if (address.startsWith("bc1p") || address.startsWith("tb1p")) {
        bech32m.decode(address as `${string}1${string}`);
      } else {
        bech32.decode(address as `${string}1${string}`);
      }
      return true;
    }
    if (
      address.startsWith("1") ||
      address.startsWith("3") ||
      address.startsWith("m") ||
      address.startsWith("n") ||
      address.startsWith("2")
    ) {
      b58check.decode(address);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Format helpers ──────────────────────────────────────────────

export function formatBtcFee(sats: bigint): string {
  const btc = Number(sats) / 1e8;
  if (btc === 0) return "0";
  if (btc < 0.00000001) return "< 0.00000001";
  return btc.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatSats(sats: bigint): string {
  return sats.toLocaleString();
}
