// Lightweight EVM transaction building, signing assembly, and broadcast
// Uses legacy (pre-EIP-1559) transactions for maximum compatibility

import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes, bytesToHex } from "../../shared/utils";

// ── RLP Encoding ────────────────────────────────────────────────

function rlpEncodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) return new Uint8Array([len + offset]);
  const hexLen = len.toString(16);
  const lenBytes = hexToBytes(hexLen.length % 2 ? "0" + hexLen : hexLen);
  return new Uint8Array([offset + 55 + lenBytes.length, ...lenBytes]);
}

function rlpEncodeItem(data: Uint8Array): Uint8Array {
  if (data.length === 1 && data[0] < 0x80) return data;
  const prefix = rlpEncodeLength(data.length, 0x80);
  const result = new Uint8Array(prefix.length + data.length);
  result.set(prefix, 0);
  result.set(data, prefix.length);
  return result;
}

export function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  const encoded = items.map(rlpEncodeItem);
  const totalLen = encoded.reduce((a, b) => a + b.length, 0);
  const prefix = rlpEncodeLength(totalLen, 0xc0);
  const result = new Uint8Array(prefix.length + totalLen);
  result.set(prefix, 0);
  let offset = prefix.length;
  for (const item of encoded) {
    result.set(item, offset);
    offset += item.length;
  }
  return result;
}

// ── Hex / Bytes Utilities ───────────────────────────────────────

/** bytesToHex with 0x prefix for EVM use */
function bytesToHex0x(bytes: Uint8Array): string {
  return "0x" + bytesToHex(bytes);
}

function bigintToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  const hex = n.toString(16);
  return hexToBytes(hex);
}

function bigintTo32Bytes(n: bigint): Uint8Array {
  const result = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    result[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return result;
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

// ── RPC Helper ──────────────────────────────────────────────────

async function ethRpc(rpcUrl: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result;
}

/** Estimate gas for a transaction. Returns gas units with 10% buffer. */
export async function estimateGas(rpcUrl: string, tx: { from: string; to: string; value?: string; data?: string }): Promise<bigint> {
  const result = await ethRpc(rpcUrl, "eth_estimateGas", [tx]);
  const estimate = BigInt(result);
  return estimate + estimate / 10n; // +10% buffer
}

/** Get the next nonce for an address. */
export async function getTransactionCount(rpcUrl: string, address: string): Promise<number> {
  const result = await ethRpc(rpcUrl, "eth_getTransactionCount", [address, "pending"]);
  return parseInt(result, 16);
}

// ── Transaction Types ───────────────────────────────────────────

export interface UnsignedTx {
  nonce: bigint;
  gasPrice: bigint;
  gasLimit: bigint;
  to: string;       // 0x-prefixed address
  value: bigint;
  data: Uint8Array;
  chainId: number;
}

export interface SignedTx {
  rawTransaction: string;  // 0x-prefixed hex
  hash: string;            // tx hash
}

// ── ERC-20 Transfer Data ────────────────────────────────────────

// transfer(address,uint256) selector = 0xa9059cbb
export function encodeErc20Transfer(to: string, amount: bigint): Uint8Array {
  const selector = hexToBytes("a9059cbb");
  const toParam = hexToBytes(to.slice(2).padStart(64, "0"));
  const amountParam = hexToBytes(amount.toString(16).padStart(64, "0"));
  const data = new Uint8Array(4 + 32 + 32);
  data.set(selector, 0);
  data.set(toParam, 4);
  data.set(amountParam, 36);
  return data;
}

// ── Build Unsigned Transaction ──────────────────────────────────

export async function buildTransaction(opts: {
  rpcUrl: string;
  from: string;
  to: string;
  value: bigint;
  data?: Uint8Array;
  gasLimit: bigint;
  chainId: number;
  gasPrice?: bigint;
}): Promise<UnsignedTx> {
  const nonceHex = await ethRpc(opts.rpcUrl, "eth_getTransactionCount", [opts.from, "latest"]);
  let finalGasPrice = opts.gasPrice;
  if (finalGasPrice == null) {
    const gasPriceHex = await ethRpc(opts.rpcUrl, "eth_gasPrice", []);
    finalGasPrice = BigInt(gasPriceHex);
  }

  return {
    nonce: BigInt(nonceHex),
    gasPrice: finalGasPrice,
    gasLimit: opts.gasLimit,
    to: opts.to,
    value: opts.value,
    data: opts.data ?? new Uint8Array(0),
    chainId: opts.chainId,
  };
}

// ── Serialize for Signing (EIP-155) ─────────────────────────────

export function serializeForSigning(tx: UnsignedTx): Uint8Array {
  // Legacy EIP-155: RLP([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0])
  return rlpEncodeList([
    bigintToBytes(tx.nonce),
    bigintToBytes(tx.gasPrice),
    bigintToBytes(tx.gasLimit),
    hexToBytes(tx.to),
    bigintToBytes(tx.value),
    tx.data,
    bigintToBytes(BigInt(tx.chainId)),
    new Uint8Array(0), // empty for EIP-155
    new Uint8Array(0), // empty for EIP-155
  ]);
}

export function hashForSigning(tx: UnsignedTx): Uint8Array {
  const serialized = serializeForSigning(tx);
  return keccak_256(serialized);
}

// ── Assemble Signed Transaction ─────────────────────────────────

const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const HALF_N = SECP256K1_N / 2n;

// Parse DER signature → { r, s } with low-S normalization
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let offset = 2; // skip 30 <len>
  offset++; // skip 02 tag
  const rLen = der[offset++];
  const rBytes = der.slice(offset, offset + rLen);
  offset += rLen;
  offset++; // skip 02 tag
  const sLen = der[offset++];
  const sBytes = der.slice(offset, offset + sLen);

  const r = bytesToBigint(rBytes);
  let s = bytesToBigint(sBytes);
  // Normalize to low-S (EIP-2 / BIP-62)
  if (s > HALF_N) s = SECP256K1_N - s;
  return { r, s };
}

/** Extract raw SEC1 public key from DER SubjectPublicKeyInfo */
export function extractPublicKeyFromDER(der: Uint8Array): Uint8Array {
  for (let i = 0; i < der.length - 2; i++) {
    if (der[i] === 0x03 && der[i + 2] === 0x00) {
      const len = der[i + 1];
      return der.slice(i + 3, i + 2 + len);
    }
  }
  return der;
}

// Determine recovery param v by trying both and checking which recovers to the expected pubkey
export function recoverV(
  hash: Uint8Array,
  r: bigint,
  s: bigint,
  publicKey: Uint8Array // raw SEC1 uncompressed (65 bytes) or DER
): number {
  const pubKeyRaw = publicKey.length > 65 ? extractPublicKeyFromDER(publicKey) : publicKey;
  const sig = new secp256k1.Signature(r, s);

  for (const recovery of [0, 1]) {
    try {
      const recovered = sig.addRecoveryBit(recovery).recoverPublicKey(hash);
      const recoveredBytes = (recovered as any).toRawBytes?.(false) ?? recovered.toBytes(false);
      if (recoveredBytes.length === pubKeyRaw.length &&
          recoveredBytes.every((b: number, i: number) => b === pubKeyRaw[i])) {
        return recovery;
      }
    } catch {
      continue;
    }
  }
  throw new Error("Could not determine recovery parameter");
}

export function assembleSignedTx(
  tx: UnsignedTx,
  r: bigint,
  s: bigint,
  recoveryBit: number
): SignedTx {
  // EIP-155 v = chainId * 2 + 35 + recovery_id
  const v = BigInt(tx.chainId) * 2n + 35n + BigInt(recoveryBit);

  const signed = rlpEncodeList([
    bigintToBytes(tx.nonce),
    bigintToBytes(tx.gasPrice),
    bigintToBytes(tx.gasLimit),
    hexToBytes(tx.to),
    bigintToBytes(tx.value),
    tx.data,
    bigintToBytes(v),
    bigintTo32Bytes(r),
    bigintTo32Bytes(s),
  ]);

  const rawTransaction = bytesToHex0x(signed);
  const hash = bytesToHex0x(keccak_256(signed));
  return { rawTransaction, hash };
}

// ── Broadcast + Poll ────────────────────────────────────────────

export async function broadcastTransaction(rpcUrl: string, rawTx: string): Promise<string> {
  const txHash = await ethRpc(rpcUrl, "eth_sendRawTransaction", [rawTx]);
  return txHash;
}

export async function waitForReceipt(
  rpcUrl: string,
  txHash: string,
  onPoll?: (attempt: number) => void,
  maxAttempts = 60,
  intervalMs = 3000
): Promise<{ status: "success" | "failed"; blockNumber: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    onPoll?.(i + 1);
    const receipt = await ethRpc(rpcUrl, "eth_getTransactionReceipt", [txHash]);
    if (receipt) {
      return {
        status: receipt.status === "0x1" ? "success" : "failed",
        blockNumber: receipt.blockNumber,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Transaction not confirmed after maximum polling attempts");
}

// ── Parse amount string to wei ──────────────────────────────────

export function parseUnits(amount: string, decimals: number): bigint {
  const [intPart, fracPart = ""] = amount.replace(/,/g, "").split(".");
  const paddedFrac = fracPart.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(intPart + paddedFrac);
}
