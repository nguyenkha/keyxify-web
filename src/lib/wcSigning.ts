// WalletConnect signing handlers — reuses MPC signing from existing flows

import { keccak_256 } from "@noble/hashes/sha3";
import { hexToBytes } from "../shared/utils";
import { ethers } from "ethers";
import { performMpcSign, toBase64, toHex, clientKeys, restoreKeyHandles } from "./mpc";
import { sensitiveHeaders } from "./passkey";
import {
  buildTransaction,
  hashForSigning,
  serializeForSigning,
  parseDerSignature,
  recoverV,
  assembleSignedTx,
  broadcastTransaction,
} from "./chains/evmTx";
import { broadcastSolanaTransaction } from "./chains/solanaTx";
import { sha256 } from "@noble/hashes/sha256";
import { base58 } from "@scure/base";
import type { KeyFileData } from "./crypto";

// ── Helpers ──────────────────────────────────────────────────────

function bigintTo32Bytes(n: bigint): Uint8Array {
  const result = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    result[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return result;
}

/** Build 65-byte EVM signature: r (32) + s (32) + v (1) */
async function signHash(
  hash: Uint8Array,
  keyFile: KeyFileData,
  address: string,
  messageType?: string,
  messagePayload?: Record<string, unknown>,
): Promise<string> {
  if (!clientKeys.has(keyFile.id)) {
    await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
  }

  const { signature: sigRaw } = await performMpcSign({
    algorithm: "ecdsa",
    keyId: keyFile.id,
    hash,
    initPayload: { id: keyFile.id, data: toBase64(hash), from: address, ...(messageType ? { messageType } : {}), ...(messagePayload ?? {}) },
    headers: sensitiveHeaders(),
  });

  const { r, s } = parseDerSignature(sigRaw);
  const pubKeyRaw = hexToBytes(keyFile.publicKey);
  const recoveryBit = recoverV(hash, r, s, pubKeyRaw);

  // Return 0x-prefixed r + s + v (v = 27 + recoveryBit for personal_sign/signTypedData)
  const rBytes = bigintTo32Bytes(r);
  const sBytes = bigintTo32Bytes(s);
  const sig = new Uint8Array(65);
  sig.set(rBytes, 0);
  sig.set(sBytes, 32);
  sig[64] = 27 + recoveryBit;
  return "0x" + toHex(sig);
}

// ── personal_sign ────────────────────────────────────────────────

export async function wcPersonalSign(
  messageHex: string,
  keyFile: KeyFileData,
  address: string,
): Promise<string> {
  // Decode the hex message
  const messageBytes = hexToBytes(messageHex.startsWith("0x") ? messageHex.slice(2) : messageHex);
  // EIP-191 prefix
  const prefix = new TextEncoder().encode("\x19Ethereum Signed Message:\n" + messageBytes.length);
  const prefixed = new Uint8Array(prefix.length + messageBytes.length);
  prefixed.set(prefix, 0);
  prefixed.set(messageBytes, prefix.length);
  const hash = keccak_256(prefixed);

  return signHash(hash, keyFile, address, "personal_sign", {
    raw: messageHex.startsWith("0x") ? messageHex.slice(2) : messageHex,
  });
}

// ── eth_sign (raw hash signing) ──────────────────────────────────

export async function wcEthSign(
  hashHex: string,
  keyFile: KeyFileData,
  address: string,
): Promise<string> {
  const hash = hexToBytes(hashHex.startsWith("0x") ? hashHex.slice(2) : hashHex);
  return signHash(hash, keyFile, address, "eth_sign");
}

// ── eth_signTypedData_v4 ─────────────────────────────────────────

export async function wcSignTypedData(
  typedDataJson: string,
  keyFile: KeyFileData,
  address: string,
): Promise<string> {
  const parsed = typeof typedDataJson === "string" ? JSON.parse(typedDataJson) : typedDataJson;
  const { domain, types, message } = parsed;

  // Remove EIP712Domain from types if present (ethers handles it via domain)
  const filteredTypes = { ...types };
  delete filteredTypes.EIP712Domain;

  // Compute EIP-712 hash
  const hash = hexToBytes(
    ethers.TypedDataEncoder.hash(domain, filteredTypes, message).slice(2),
  );

  return signHash(hash, keyFile, address, "eth_signTypedData", {
    typedData: JSON.stringify(parsed),
  });
}

// ── eth_sendTransaction ──────────────────────────────────────────

export type WcSignPhase = "building-tx" | "mpc-signing" | "broadcasting";

export async function wcSendTransaction(
  txParams: {
    from: string;
    to: string;
    value?: string;
    data?: string;
    gas?: string;
    gasPrice?: string;
    gasLimit?: string;
  },
  rpcUrl: string,
  chainId: number,
  keyFile: KeyFileData,
  address: string,
  onProgress?: (phase: WcSignPhase) => void,
): Promise<string> {
  onProgress?.("building-tx");

  const value = txParams.value ? BigInt(txParams.value) : 0n;
  const gasLimit = txParams.gasLimit
    ? BigInt(txParams.gasLimit)
    : txParams.gas
      ? BigInt(txParams.gas)
      : 21000n;
  const gasPrice = txParams.gasPrice ? BigInt(txParams.gasPrice) : undefined;
  const txData = txParams.data
    ? hexToBytes(txParams.data.startsWith("0x") ? txParams.data.slice(2) : txParams.data)
    : undefined;

  const unsignedTx = await buildTransaction({
    rpcUrl,
    from: address,
    to: txParams.to,
    value,
    data: txData,
    gasLimit,
    chainId,
    gasPrice,
  });

  onProgress?.("mpc-signing");

  const sighash = hashForSigning(unsignedTx);

  if (!clientKeys.has(keyFile.id)) {
    await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
  }

  const { signature: sigRaw } = await performMpcSign({
    algorithm: "ecdsa",
    keyId: keyFile.id,
    hash: sighash,
    initPayload: {
      id: keyFile.id,
      unsignedTx: toBase64(serializeForSigning(unsignedTx)),
      from: address,
    },
    headers: sensitiveHeaders(),
  });

  onProgress?.("broadcasting");

  const { r, s } = parseDerSignature(sigRaw);
  const pubKeyRaw = hexToBytes(keyFile.publicKey);
  const recoveryBit = recoverV(sighash, r, s, pubKeyRaw);
  const signedTx = assembleSignedTx(unsignedTx, r, s, recoveryBit);

  const txHash = await broadcastTransaction(rpcUrl, signedTx.rawTransaction);
  return txHash;
}

// ── solana_signTransaction ──────────────────────────────────────

export async function wcSolanaSignTransaction(
  transaction: string, // base64-encoded serialized transaction
  keyFile: KeyFileData,
  address: string,
  _rpcUrl: string,
  onProgress?: (phase: WcSignPhase) => void,
): Promise<{ signature: string; transaction: string }> {
  onProgress?.("building-tx");

  // Decode transaction — extract message (skip signature placeholders)
  const txBytes = base64ToUint8(transaction);
  // Solana wire format: compact_array(signatures) + message
  const { numSigs, bytesRead } = readCompactU16(txBytes, 0);
  const messageOffset = bytesRead + numSigs * 64;
  const message = txBytes.slice(messageOffset);

  onProgress?.("mpc-signing");

  if (!clientKeys.has(keyFile.id)) {
    await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
  }

  // EdDSA signs the raw message (Ed25519 hashes internally)
  const { signature: sigRaw } = await performMpcSign({
    algorithm: "eddsa",
    keyId: keyFile.id,
    hash: message,
    initPayload: {
      id: keyFile.id,
      algorithm: "eddsa",
      from: address,
      chainType: "solana",
      unsignedTx: toBase64(message),
    },
    headers: sensitiveHeaders(),
  });

  // Fill our signature into the original transaction at slot 0 (fee payer)
  // Preserve the original structure (signature count + all slots + message)
  const signedTxBytes = new Uint8Array(txBytes);
  signedTxBytes.set(sigRaw, bytesRead); // first signature slot starts after compact-u16 length

  const sigBase58 = base58.encode(sigRaw);

  // WC expects base64-encoded signed transaction
  const signedTxBase64 = btoa(String.fromCharCode(...signedTxBytes));

  return { signature: sigBase58, transaction: signedTxBase64 };
}

// ── solana_signAndSendTransaction ────────────────────────────────

export async function wcSolanaSignAndSendTransaction(
  transaction: string, // base64-encoded serialized transaction
  keyFile: KeyFileData,
  address: string,
  rpcUrl: string,
  onProgress?: (phase: WcSignPhase) => void,
): Promise<string> {
  // Sign the transaction (returns base64)
  const { transaction: signedTxBase64 } = await wcSolanaSignTransaction(
    transaction, keyFile, address, rpcUrl, onProgress,
  );

  // Decode base64 → base58 for Solana RPC broadcast
  const raw = Uint8Array.from(atob(signedTxBase64), c => c.charCodeAt(0));
  const signedTxBase58 = base58.encode(raw);

  // Broadcast
  onProgress?.("broadcasting");
  const txSig = await broadcastSolanaTransaction(rpcUrl, signedTxBase58);
  return txSig;
}

// ── solana_signMessage ──────────────────────────────────────────

export async function wcSolanaSignMessage(
  messageBase64: string, // base64-encoded message bytes
  keyFile: KeyFileData,
  address: string,
): Promise<{ signature: string }> {
  const messageBytes = base64ToUint8(messageBase64);
  const hash = sha256(messageBytes);

  if (!clientKeys.has(keyFile.id)) {
    await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
  }

  const { signature: sigRaw } = await performMpcSign({
    algorithm: "eddsa",
    keyId: keyFile.id,
    hash,
    initPayload: {
      id: keyFile.id,
      algorithm: "eddsa",
      from: address,
      chainType: "solana",
      messageType: "solana_signMessage",
      raw: toBase64(messageBytes),
    },
    headers: sensitiveHeaders(),
  });

  return { signature: base58.encode(sigRaw) };
}

function readCompactU16(buf: Uint8Array, offset: number): { numSigs: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  for (;;) {
    const b = buf[offset + bytesRead];
    bytesRead++;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { numSigs: value, bytesRead };
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
