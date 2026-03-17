#!/usr/bin/env node
/**
 * kexify CLI — Recovery & WalletConnect tool
 *
 * Commands:
 *   recover  — Reconstruct private keys and export
 *   connect  — Connect to dApps via WalletConnect with local MPC signing
 *
 * Usage:
 *   npx tsx cli.ts recover ./peer0.json ./peer2.json
 *   npx tsx cli.ts connect ./peer0.json ./peer2.json
 */

import { readFileSync } from "node:fs";
import { createInterface, type Interface as RLInterface } from "node:readline";
import { initCbMpc, NID_secp256k1, NID_ED25519 } from "cb-mpc";
import type { CbMpc, DataTransport, Ecdsa2pKeyHandle, EcKey2pHandle } from "cb-mpc";
import { ethers } from "ethers";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base58, bech32 } from "@scure/base";
import { Core } from "@walletconnect/core";
import { Web3Wallet } from "@walletconnect/web3wallet";
import type { Web3WalletTypes } from "@walletconnect/web3wallet";

// ── Constants ────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 600_000;
const IV_BYTES = 12;
const PARTY_NAMES: [string, string] = ["client", "server"];
const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const HALF_N = SECP256K1_N / 2n;

const EVM_METHODS = [
  "eth_sendTransaction",
  "personal_sign",
  "eth_sign",
  "eth_signTypedData_v4",
];
const EVM_EVENTS = ["chainChanged", "accountsChanged"];
const SOLANA_METHODS = [
  "solana_signTransaction",
  "solana_signAndSendTransaction",
  "solana_signMessage",
];

const EVM_RPCS: Record<number, string> = {
  1: "https://eth.llamarpc.com",
  137: "https://polygon-rpc.com",
  42161: "https://arb1.arbitrum.io/rpc",
  10: "https://mainnet.optimism.io",
  8453: "https://mainnet.base.org",
  11155111: "https://rpc.sepolia.org",
  84532: "https://sepolia.base.org",
};

const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// XRP base58 alphabet
const XRP_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

// ── Types ────────────────────────────────────────────────────────

interface KeyFileData {
  id: string;
  peer: number;
  share: string;
  publicKey: string;
  eddsaShare: string;
  eddsaPublicKey: string;
  encrypted?: boolean;
  salt?: string;
  encryption?: "server-hkdf";
}

// ── Utility Functions ────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length === 0) return new Uint8Array(0);
  const padded = h.length % 2 ? "0" + h : h;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

function fromBase64(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64"));
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

/** Extract raw SEC1 public key from DER SubjectPublicKeyInfo */
function extractPublicKeyFromDER(pubKeyHex: string): string {
  const der = hexToBytes(pubKeyHex);
  for (let i = 0; i < der.length - 2; i++) {
    if (der[i] === 0x03 && der[i + 2] === 0x00) {
      const len = der[i + 1];
      return bytesToHex(der.slice(i + 3, i + 2 + len));
    }
  }
  return pubKeyHex;
}

// ── Address Derivation ───────────────────────────────────────────

function deriveEvmAddress(pubKeyHex: string): string {
  const rawKey = extractPublicKeyFromDER(pubKeyHex);
  return ethers.computeAddress("0x" + rawKey);
}

function deriveBtcAddress(pubKeyHex: string): string {
  const rawKey = extractPublicKeyFromDER(pubKeyHex);
  const point = secp256k1.Point.fromHex(rawKey);
  const compressed = point.toBytes(true);
  const h = ripemd160(sha256(compressed));
  const words = bech32.toWords(h);
  return bech32.encode("bc", new Uint8Array([0, ...words]));
}

function deriveLtcAddress(pubKeyHex: string): string {
  const rawKey = extractPublicKeyFromDER(pubKeyHex);
  const point = secp256k1.Point.fromHex(rawKey);
  const compressed = point.toBytes(true);
  const h = ripemd160(sha256(compressed));
  const words = bech32.toWords(h);
  return bech32.encode("ltc", new Uint8Array([0, ...words]));
}

function deriveSolanaAddress(eddsaPubKeyHex: string): string {
  const pubKeyBytes = hexToBytes(eddsaPubKeyHex);
  let key32: Uint8Array;
  if (pubKeyBytes.length === 32) {
    key32 = pubKeyBytes;
  } else if (pubKeyBytes.length === 65 && pubKeyBytes[0] === 0x04) {
    const x_be = pubKeyBytes.slice(1, 33);
    const y_le = pubKeyBytes.slice(33).reverse();
    key32 = new Uint8Array(y_le);
    key32[31] = (key32[31] & 0x7f) | ((x_be[31] & 1) << 7);
  } else {
    throw new Error(`Expected 32 or 65-byte Ed25519 public key, got ${pubKeyBytes.length} bytes`);
  }
  return base58.encode(key32);
}

function deriveXrpAddress(pubKeyHex: string): string {
  const rawKey = extractPublicKeyFromDER(pubKeyHex);
  const point = secp256k1.Point.fromHex(rawKey);
  const compressed = point.toBytes(true);
  const h = ripemd160(sha256(compressed));
  const payload = new Uint8Array(21);
  payload[0] = 0x00;
  payload.set(h, 1);
  // XRP base58check
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(checksum, payload.length);
  return xrpBase58Encode(full);
}

function xrpBase58Encode(data: Uint8Array): string {
  let num = 0n;
  for (const b of data) num = (num << 8n) | BigInt(b);
  const chars: string[] = [];
  while (num > 0n) {
    chars.push(XRP_ALPHABET[Number(num % 58n)]);
    num /= 58n;
  }
  for (const b of data) {
    if (b !== 0) break;
    chars.push(XRP_ALPHABET[0]);
  }
  return chars.reverse().join("");
}

// ── Key File Decryption ──────────────────────────────────────────

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(passphrase);
  const baseKey = await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as Uint8Array<ArrayBuffer>, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

async function decryptField(encryptedBase64: string, key: CryptoKey): Promise<string> {
  const combined = fromBase64(encryptedBase64);
  const iv = new Uint8Array(combined.buffer, combined.byteOffset, IV_BYTES);
  const ciphertext = new Uint8Array(combined.buffer, combined.byteOffset + IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> }, key, ciphertext as Uint8Array<ArrayBuffer>,
  );
  return new TextDecoder().decode(plaintext);
}

async function decryptKeyFile(data: KeyFileData, passphrase: string): Promise<KeyFileData> {
  if (!data.salt) throw new Error("Missing salt in encrypted key file");
  const salt = fromBase64(data.salt);
  const key = await deriveKey(passphrase, salt);
  try {
    return {
      id: data.id,
      peer: data.peer,
      publicKey: data.publicKey,
      share: await decryptField(data.share, key),
      eddsaShare: await decryptField(data.eddsaShare, key),
      eddsaPublicKey: data.eddsaPublicKey,
    };
  } catch (err: any) {
    if (err?.name === "OperationError") throw new Error("Incorrect passphrase");
    throw err;
  }
}

async function decryptHkdfKeyFile(data: KeyFileData, hexKey: string): Promise<KeyFileData> {
  const keyBytes = hexToBytes(hexKey);
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  async function dec(encB64: string): Promise<string> {
    const combined = fromBase64(encB64);
    const iv = new Uint8Array(combined.buffer, combined.byteOffset, 12);
    const ciphertext = new Uint8Array(combined.buffer, combined.byteOffset + 12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> }, cryptoKey, ciphertext as Uint8Array<ArrayBuffer>);
    return new TextDecoder().decode(plain);
  }
  try {
    return {
      id: data.id, peer: data.peer, publicKey: data.publicKey, eddsaPublicKey: data.eddsaPublicKey,
      share: await dec(data.share),
      eddsaShare: data.eddsaShare ? await dec(data.eddsaShare) : "",
    };
  } catch (err: any) {
    if (err?.name === "OperationError") throw new Error("Invalid HKDF decryption key");
    throw err;
  }
}

// ── RLP Encoding (EVM transactions) ──────────────────────────────

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

function rlpEncodeList(items: Uint8Array[]): Uint8Array {
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

// ── EVM Transaction Helpers ──────────────────────────────────────

interface UnsignedTx {
  nonce: bigint;
  gasPrice: bigint;
  gasLimit: bigint;
  to: string;
  value: bigint;
  data: Uint8Array;
  chainId: number;
}

async function ethRpc(rpcUrl: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data: any = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result;
}

async function buildTransaction(opts: {
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

function hashForSigning(tx: UnsignedTx): Uint8Array {
  const serialized = rlpEncodeList([
    bigintToBytes(tx.nonce),
    bigintToBytes(tx.gasPrice),
    bigintToBytes(tx.gasLimit),
    hexToBytes(tx.to),
    bigintToBytes(tx.value),
    tx.data,
    bigintToBytes(BigInt(tx.chainId)),
    new Uint8Array(0),
    new Uint8Array(0),
  ]);
  return keccak_256(serialized);
}

function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let offset = 2;
  offset++;
  const rLen = der[offset++];
  const rBytes = der.slice(offset, offset + rLen);
  offset += rLen;
  offset++;
  const sLen = der[offset++];
  const sBytes = der.slice(offset, offset + sLen);
  const r = bytesToBigint(rBytes);
  let s = bytesToBigint(sBytes);
  if (s > HALF_N) s = SECP256K1_N - s;
  return { r, s };
}

function recoverV(hash: Uint8Array, r: bigint, s: bigint, publicKey: Uint8Array): number {
  const pubKeyRaw = publicKey.length > 65
    ? hexToBytes(extractPublicKeyFromDER(bytesToHex(publicKey)))
    : publicKey;
  const sig = new secp256k1.Signature(r, s);
  for (const recovery of [0, 1]) {
    try {
      const recovered = sig.addRecoveryBit(recovery).recoverPublicKey(hash);
      const recoveredBytes = recovered.toBytes(false);
      if (recoveredBytes.length === pubKeyRaw.length &&
          recoveredBytes.every((b: number, i: number) => b === pubKeyRaw[i])) {
        return recovery;
      }
    } catch { continue; }
  }
  throw new Error("Could not determine recovery parameter");
}

function assembleSignedTx(tx: UnsignedTx, r: bigint, s: bigint, recoveryBit: number) {
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
  return "0x" + bytesToHex(signed);
}

// ── Solana Helpers ───────────────────────────────────────────────

function readCompactU16(buf: Uint8Array, offset: number): { value: number; bytesRead: number } {
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
  return { value, bytesRead };
}

async function broadcastSolanaTransaction(rpcUrl: string, signedTxBase58: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "sendTransaction",
      params: [signedTxBase58, { encoding: "base58", preflightCommitment: "confirmed" }],
    }),
  });
  const data: any = await res.json();
  if (data.error) throw new Error(`Broadcast failed: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result;
}

// ── WIF Encoding ─────────────────────────────────────────────────

function privateKeyToWIF(privateKeyHex: string): string {
  const keyBytes = hexToBytes(privateKeyHex);
  // Mainnet compressed: 0x80 + key(32) + 0x01
  const payload = new Uint8Array(34);
  payload[0] = 0x80;
  payload.set(keyBytes, 1);
  payload[33] = 0x01;
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(38);
  full.set(payload);
  full.set(checksum, 34);
  return base58.encode(full);
}

// ── Local MPC Transport ──────────────────────────────────────────

class AsyncQueue {
  private items: Uint8Array[] = [];
  private waiters: ((msg: Uint8Array) => void)[] = [];

  push(item: Uint8Array) {
    if (this.waiters.length > 0) {
      this.waiters.shift()!(item);
    } else {
      this.items.push(item);
    }
  }

  async pop(): Promise<Uint8Array> {
    if (this.items.length > 0) return this.items.shift()!;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function createLocalTransport(): [DataTransport, DataTransport] {
  const q01 = new AsyncQueue(); // peer 0 → peer 1
  const q10 = new AsyncQueue(); // peer 1 → peer 0

  const t0: DataTransport = {
    send: async (_receiver, msg) => { q01.push(new Uint8Array(msg)); return 0; },
    receive: async (_sender) => q10.pop(),
    receiveAll: async (senders) => Promise.all(senders.map((s) => t0.receive(s))),
  };

  const t1: DataTransport = {
    send: async (_receiver, msg) => { q10.push(new Uint8Array(msg)); return 0; },
    receive: async (_sender) => q01.pop(),
    receiveAll: async (senders) => Promise.all(senders.map((s) => t1.receive(s))),
  };

  return [t0, t1];
}

async function localEcdsaSign(
  mpc1: CbMpc, key1: Ecdsa2pKeyHandle,
  mpc2: CbMpc, key2: Ecdsa2pKeyHandle,
  hash: Uint8Array,
): Promise<Uint8Array> {
  const [t0, t1] = createLocalTransport();
  const sessionId = new Uint8Array(32);
  crypto.getRandomValues(sessionId);
  const [sigs1] = await Promise.all([
    mpc1.ecdsa2pSign(t0, 0, PARTY_NAMES, key1, sessionId, [hash]),
    mpc2.ecdsa2pSign(t1, 1, PARTY_NAMES, key2, sessionId, [hash]),
  ]);
  return sigs1[0];
}

async function localEddsaSign(
  mpc1: CbMpc, key1: EcKey2pHandle,
  mpc2: CbMpc, key2: EcKey2pHandle,
  message: Uint8Array,
): Promise<Uint8Array> {
  const [t0, t1] = createLocalTransport();
  const [sig] = await Promise.all([
    mpc1.schnorr2pEddsaSign(t0, 0, PARTY_NAMES, key1, message),
    mpc2.schnorr2pEddsaSign(t1, 1, PARTY_NAMES, key2, message),
  ]);
  return sig;
}

// ── CLI Helpers ──────────────────────────────────────────────────

let rl: RLInterface;

function initReadline(): void {
  rl = createInterface({ input: process.stdin, output: process.stdout });
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function askPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let password = "";
    const onData = (ch: Buffer) => {
      const c = ch.toString("utf8");
      if (c === "\n" || c === "\r") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
        process.stdout.write("\n");
        resolve(password);
      } else if (c === "\x7f" || c === "\b") {
        password = password.slice(0, -1);
      } else if (c === "\x03") {
        process.exit(1);
      } else {
        password += c;
      }
    };
    stdin.on("data", onData);
  });
}

// ── Common: Load & Decrypt Shares ────────────────────────────────

interface DecryptedShares {
  share1: KeyFileData;
  share2: KeyFileData;
}

async function tryDecrypt(raw: KeyFileData, passphrase: string): Promise<KeyFileData | null> {
  try {
    return await decryptKeyFile(raw, passphrase);
  } catch {
    return null;
  }
}

async function loadAndDecryptShares(filePath1: string, filePath2: string): Promise<DecryptedShares> {
  // Read files
  const raws: { raw: KeyFileData; path: string }[] = [];
  for (const p of [filePath1, filePath2]) {
    try {
      raws.push({ raw: JSON.parse(readFileSync(p, "utf-8")), path: p });
    } catch { throw new Error(`Cannot read share file: ${p}`); }
  }

  const needsHkdf = raws.filter((r) => r.raw.encryption === "server-hkdf");
  const needsDecrypt = raws.filter((r) => r.raw.encrypted && r.raw.encryption !== "server-hkdf");
  const unencrypted = raws.filter((r) => !r.raw.encrypted && r.raw.encryption !== "server-hkdf");

  // Decrypt HKDF files first
  const decrypted: KeyFileData[] = [...unencrypted.map((r) => r.raw)];

  for (const { raw, path } of needsHkdf) {
    const hexKey = await askPassword(`HKDF key (hex) for ${path}: `);
    process.stdout.write(`Decrypting ${path} (HKDF)... `);
    try {
      const result = await decryptHkdfKeyFile(raw, hexKey.trim());
      console.log("✓");
      decrypted.push(result);
    } catch {
      console.log("✗");
      throw new Error(`HKDF decryption failed for ${path} — invalid key`);
    }
  }

  // Collect passphrases — ask up to 2
  const passphrases: string[] = [];
  if (needsDecrypt.length >= 1) {
    passphrases.push(await askPassword("Passphrase 1: "));
  }
  if (needsDecrypt.length >= 2) {
    passphrases.push(await askPassword("Passphrase 2: "));
  }

  // Decrypt each encrypted file by trying all passphrases
  for (const { raw, path } of needsDecrypt) {
    process.stdout.write(`Decrypting ${path}... `);
    let result: KeyFileData | null = null;
    for (const pass of passphrases) {
      result = await tryDecrypt(raw, pass);
      if (result) break;
    }
    if (!result) {
      console.log("✗");
      throw new Error(`Decryption failed for ${path} — no matching passphrase`);
    }
    console.log("✓");
    decrypted.push(result);
  }

  for (const r of unencrypted) {
    console.log(`${r.path}... ✓ (unencrypted)`);
  }

  // Auto-detect peer order from the `peer` field
  let share1: KeyFileData, share2: KeyFileData;
  const peers = decrypted.map((d) => d.peer);

  if (peers.includes(0) && peers.includes(2)) {
    share1 = decrypted.find((d) => d.peer === 0)!;
    share2 = decrypted.find((d) => d.peer === 2)!;
  } else if (peers[0] !== peers[1]) {
    const sorted = [...decrypted].sort((a, b) => a.peer - b.peer);
    share1 = sorted[0];
    share2 = sorted[1];
    console.log(`Peer order: peer ${share1.peer} (client), peer ${share2.peer} (server)`);
  } else {
    share1 = decrypted[0];
    share2 = decrypted[1];
    console.log("Warning: Both files have the same peer value, using file order");
  }

  // Integrity check
  process.stdout.write("Integrity check... ");
  if (share1.publicKey !== share2.publicKey) {
    console.log("✗");
    throw new Error("ECDSA public keys do not match between share files");
  }
  if (share1.eddsaPublicKey !== share2.eddsaPublicKey) {
    console.log("✗");
    throw new Error("EdDSA public keys do not match between share files");
  }
  console.log("✓");

  return { share1, share2 };
}

// ── Recover Command ──────────────────────────────────────────────

async function cmdRecover(share1Path: string, share2Path: string): Promise<void> {
  console.log("kexify recover\n");

  const { share1, share2 } = await loadAndDecryptShares(share1Path, share2Path);

  // Initialize MPC
  const mpc = await initCbMpc();

  // Deserialize ECDSA key handles and extract x-shares
  const ecdsaParts1 = share1.share.split(",").map((s) => fromBase64(s));
  const ecdsaParts2 = share2.share.split(",").map((s) => fromBase64(s));
  const ecdsaKey1 = mpc.deserializeEcdsa2p(ecdsaParts1);
  const ecdsaKey2 = mpc.deserializeEcdsa2p(ecdsaParts2);
  const ecdsaXShare1 = mpc.ecdsa2pKeyInfo(ecdsaKey1).xShare;
  const ecdsaXShare2 = mpc.ecdsa2pKeyInfo(ecdsaKey2).xShare;
  const ecdsaPrivKey = mpc.reconstructKey(NID_secp256k1, [ecdsaXShare1, ecdsaXShare2]);

  // Deserialize EdDSA key handles and extract x-shares
  const eddsaParts1 = share1.eddsaShare.split(",").map((s) => fromBase64(s));
  const eddsaParts2 = share2.eddsaShare.split(",").map((s) => fromBase64(s));
  const eddsaKey1 = mpc.deserializeEcKey2p(eddsaParts1);
  const eddsaKey2 = mpc.deserializeEcKey2p(eddsaParts2);
  const eddsaXShare1 = mpc.ecKey2pInfo(eddsaKey1).xShare;
  const eddsaXShare2 = mpc.ecKey2pInfo(eddsaKey2).xShare;
  const eddsaPrivKey = mpc.reconstructKey(NID_ED25519, [eddsaXShare1, eddsaXShare2]);

  // Free handles
  mpc.freeEcdsa2pKey(ecdsaKey1);
  mpc.freeEcdsa2pKey(ecdsaKey2);
  mpc.freeEcKey2p(eddsaKey1);
  mpc.freeEcKey2p(eddsaKey2);

  const ecdsaPrivKeyHex = bytesToHex(ecdsaPrivKey);
  const eddsaPrivKeyHex = bytesToHex(eddsaPrivKey);

  // Derive addresses
  const evmAddr = deriveEvmAddress(share1.publicKey);
  const btcAddr = deriveBtcAddress(share1.publicKey);
  const ltcAddr = deriveLtcAddress(share1.publicKey);
  const solAddr = deriveSolanaAddress(share1.eddsaPublicKey);
  const xrpAddr = deriveXrpAddress(share1.publicKey);

  console.log("\nRecovered addresses:");
  console.log(`  Ethereum: ${evmAddr}`);
  console.log(`  Bitcoin:  ${btcAddr}`);
  console.log(`  Litecoin: ${ltcAddr}`);
  console.log(`  Solana:   ${solAddr}`);
  console.log(`  XRP:      ${xrpAddr}`);

  // Interactive menu
  initReadline();
  while (true) {
    console.log("\nOptions:");
    console.log("  1. Export ECDSA private key (hex) — EVM/BTC/LTC/XRP");
    console.log("  2. Export EdDSA private key (hex) — Solana");
    console.log("  3. Export private key (WIF — Bitcoin)");
    console.log("  4. Exit");

    const choice = await ask("\n> ");

    switch (choice.trim()) {
      case "1":
        console.log(`Private key: 0x${ecdsaPrivKeyHex}`);
        console.log("⚠ Store this securely. Anyone with this key controls your EVM/BTC/XRP funds.");
        break;
      case "2":
        console.log(`Private key: ${eddsaPrivKeyHex}`);
        console.log("⚠ Store this securely. Anyone with this key controls your Solana funds.");
        break;
      case "3":
        console.log(`WIF: ${privateKeyToWIF(ecdsaPrivKeyHex)}`);
        console.log("⚠ Store this securely. Anyone with this key controls your Bitcoin funds.");
        break;
      case "4":
        rl.close();
        return;
      default:
        console.log("Invalid option.");
    }
  }
}

// ── Connect Command ──────────────────────────────────────────────

async function cmdConnect(share1Path: string, share2Path: string): Promise<void> {
  console.log("kexify connect\n");

  const projectId = process.env.WC_PROJECT_ID;
  if (!projectId) {
    console.error("Error: WC_PROJECT_ID environment variable is required.");
    console.error("Get one at https://cloud.walletconnect.com");
    process.exit(1);
  }

  const { share1, share2 } = await loadAndDecryptShares(share1Path, share2Path);

  // Initialize two MPC instances (one per peer, required for concurrent signing)
  process.stdout.write("Initializing MPC... ");
  const [mpc1, mpc2] = await Promise.all([initCbMpc(), initCbMpc()]);
  console.log("✓");

  // Deserialize key handles into their respective MPC instances
  const ecdsaParts1 = share1.share.split(",").map((s) => fromBase64(s));
  const ecdsaParts2 = share2.share.split(",").map((s) => fromBase64(s));
  const ecdsaKey1 = mpc1.deserializeEcdsa2p(ecdsaParts1);
  const ecdsaKey2 = mpc2.deserializeEcdsa2p(ecdsaParts2);

  const eddsaParts1 = share1.eddsaShare.split(",").map((s) => fromBase64(s));
  const eddsaParts2 = share2.eddsaShare.split(",").map((s) => fromBase64(s));
  const eddsaKey1 = mpc1.deserializeEcKey2p(eddsaParts1);
  const eddsaKey2 = mpc2.deserializeEcKey2p(eddsaParts2);

  // Derive addresses
  const evmAddr = deriveEvmAddress(share1.publicKey);
  const solAddr = deriveSolanaAddress(share1.eddsaPublicKey);
  const pubKeyRaw = hexToBytes(extractPublicKeyFromDER(share1.publicKey));

  console.log(`\nEVM address:    ${evmAddr}`);
  console.log(`Solana address: ${solAddr}`);

  // Initialize WalletConnect
  process.stdout.write("\nInitializing WalletConnect... ");
  const core = new Core({ projectId });
  const web3wallet = await Web3Wallet.init({
    core: core as any,
    metadata: {
      name: "Kexify CLI",
      description: "Self-custodial MPC wallet (recovery mode)",
      url: "https://kexify.com",
      icons: [],
    },
  });
  console.log("✓");

  initReadline();

  // ── Session Proposal Handler ──
  web3wallet.on("session_proposal", async (proposal: Web3WalletTypes.SessionProposal) => {
    const { proposer } = proposal.params;
    const allRequested = {
      ...proposal.params.requiredNamespaces,
      ...proposal.params.optionalNamespaces,
    };

    const requestedChains: string[] = [];
    if (allRequested.eip155) {
      const chains = [
        ...(allRequested.eip155.chains || []),
        ...(proposal.params.requiredNamespaces?.eip155?.chains || []),
        ...(proposal.params.optionalNamespaces?.eip155?.chains || []),
      ];
      requestedChains.push(...Array.from(new Set(chains)));
    }
    if (allRequested.solana) {
      const chains = [
        ...(allRequested.solana.chains || []),
        ...(proposal.params.requiredNamespaces?.solana?.chains || []),
        ...(proposal.params.optionalNamespaces?.solana?.chains || []),
      ];
      requestedChains.push(...Array.from(new Set(chains)));
    }

    console.log(`\nSession request from ${proposer.metadata.name} (${proposer.metadata.url})`);
    console.log(`Requested chains: ${requestedChains.join(", ") || "any"}`);
    if (requestedChains.some((c) => c.startsWith("eip155:"))) {
      console.log(`EVM Account: ${evmAddr}`);
    }
    if (requestedChains.some((c) => c.startsWith("solana:"))) {
      console.log(`Solana Account: ${solAddr}`);
    }

    const answer = await ask("Approve? (y/n): ");
    if (answer.trim().toLowerCase() !== "y") {
      await web3wallet.rejectSession({
        id: proposal.id,
        reason: { code: 4001, message: "User rejected" },
      });
      console.log("Session rejected.");
      return;
    }

    // Build namespaces
    const namespaces: Record<string, { accounts: string[]; methods: string[]; events: string[] }> = {};

    if (allRequested.eip155) {
      const chains = Array.from(new Set([
        ...(allRequested.eip155.chains || []),
        ...(proposal.params.requiredNamespaces?.eip155?.chains || []),
        ...(proposal.params.optionalNamespaces?.eip155?.chains || []),
      ]));
      namespaces.eip155 = {
        accounts: chains.map((chain) => `${chain}:${evmAddr}`),
        methods: EVM_METHODS,
        events: EVM_EVENTS,
      };
    }

    if (allRequested.solana) {
      const chains = Array.from(new Set([
        ...(allRequested.solana.chains || []),
        ...(proposal.params.requiredNamespaces?.solana?.chains || []),
        ...(proposal.params.optionalNamespaces?.solana?.chains || []),
      ]));
      namespaces.solana = {
        accounts: chains.map((chain) => `${chain}:${solAddr}`),
        methods: SOLANA_METHODS,
        events: [],
      };
    }

    try {
      await web3wallet.approveSession({ id: proposal.id, namespaces });
      console.log(`✓ Connected to ${proposer.metadata.name}`);
      console.log("Listening for requests... (Ctrl+C to disconnect)");
    } catch (err: any) {
      console.error(`Failed to approve session: ${err.message}`);
    }
  });

  // ── Session Request Handler ──
  web3wallet.on("session_request", async (event: Web3WalletTypes.SessionRequest) => {
    const { topic, id, params } = event;
    const { request, chainId } = params;
    const method = request.method;

    // Find session info
    const sessions = web3wallet.getActiveSessions();
    const session = Object.values(sessions).find((s) => s.topic === topic);
    const dappName = session?.peer?.metadata?.name || "Unknown dApp";

    try {
      if (method === "personal_sign") {
        const [messageHex, _address] = request.params;
        const msgBytes = hexToBytes(messageHex.startsWith("0x") ? messageHex.slice(2) : messageHex);
        const msgText = new TextDecoder().decode(msgBytes);
        const preview = msgText.length > 80 ? msgText.slice(0, 80) + "..." : msgText;

        console.log(`\n[Request] personal_sign from ${dappName}`);
        console.log(`  Message: ${preview}`);
        const answer = await ask("  Approve? (y/n): ");
        if (answer.trim().toLowerCase() !== "y") {
          await web3wallet.respondSessionRequest({
            topic,
            response: { id, jsonrpc: "2.0", error: { code: 4001, message: "User rejected" } },
          });
          console.log("  Rejected.");
          return;
        }

        process.stdout.write("  Signing (ECDSA MPC)... ");
        const prefix = new TextEncoder().encode("\x19Ethereum Signed Message:\n" + msgBytes.length);
        const prefixed = new Uint8Array(prefix.length + msgBytes.length);
        prefixed.set(prefix, 0);
        prefixed.set(msgBytes, prefix.length);
        const hash = keccak_256(prefixed);

        const sigDer = await localEcdsaSign(mpc1, ecdsaKey1, mpc2, ecdsaKey2, hash);
        const { r, s } = parseDerSignature(sigDer);
        const recoveryBit = recoverV(hash, r, s, pubKeyRaw);
        const sig65 = new Uint8Array(65);
        sig65.set(bigintTo32Bytes(r), 0);
        sig65.set(bigintTo32Bytes(s), 32);
        sig65[64] = 27 + recoveryBit;
        console.log("✓");

        await web3wallet.respondSessionRequest({
          topic,
          response: { id, jsonrpc: "2.0", result: "0x" + bytesToHex(sig65) },
        });

      } else if (method === "eth_signTypedData_v4") {
        const [_address, typedDataJson] = request.params;
        const parsed = typeof typedDataJson === "string" ? JSON.parse(typedDataJson) : typedDataJson;

        console.log(`\n[Request] eth_signTypedData_v4 from ${dappName}`);
        console.log(`  Primary type: ${parsed.primaryType || "unknown"}`);
        const answer = await ask("  Approve? (y/n): ");
        if (answer.trim().toLowerCase() !== "y") {
          await web3wallet.respondSessionRequest({
            topic,
            response: { id, jsonrpc: "2.0", error: { code: 4001, message: "User rejected" } },
          });
          console.log("  Rejected.");
          return;
        }

        process.stdout.write("  Signing (ECDSA MPC)... ");
        const { domain, types, message } = parsed;
        const filteredTypes = { ...types };
        delete filteredTypes.EIP712Domain;
        const hash = hexToBytes(ethers.TypedDataEncoder.hash(domain, filteredTypes, message).slice(2));

        const sigDer = await localEcdsaSign(mpc1, ecdsaKey1, mpc2, ecdsaKey2, hash);
        const { r, s } = parseDerSignature(sigDer);
        const recoveryBit = recoverV(hash, r, s, pubKeyRaw);
        const sig65 = new Uint8Array(65);
        sig65.set(bigintTo32Bytes(r), 0);
        sig65.set(bigintTo32Bytes(s), 32);
        sig65[64] = 27 + recoveryBit;
        console.log("✓");

        await web3wallet.respondSessionRequest({
          topic,
          response: { id, jsonrpc: "2.0", result: "0x" + bytesToHex(sig65) },
        });

      } else if (method === "eth_sendTransaction") {
        const txParams = request.params[0];
        const chainIdNum = parseInt(chainId.split(":")[1]);
        const rpcUrl = process.env.ETH_RPC_URL || EVM_RPCS[chainIdNum];
        if (!rpcUrl) {
          throw new Error(`No RPC URL for chain ${chainId}. Set ETH_RPC_URL env var.`);
        }

        const value = txParams.value ? BigInt(txParams.value) : 0n;
        const gasLimit = txParams.gasLimit ? BigInt(txParams.gasLimit)
          : txParams.gas ? BigInt(txParams.gas) : 21000n;

        console.log(`\n[Request] eth_sendTransaction from ${dappName}`);
        console.log(`  To: ${txParams.to}`);
        if (value > 0n) {
          console.log(`  Value: ${ethers.formatEther(value)} ETH`);
        }
        if (txParams.data && txParams.data !== "0x") {
          console.log(`  Data: ${txParams.data.slice(0, 20)}...`);
        }
        const answer = await ask("  Approve? (y/n): ");
        if (answer.trim().toLowerCase() !== "y") {
          await web3wallet.respondSessionRequest({
            topic,
            response: { id, jsonrpc: "2.0", error: { code: 4001, message: "User rejected" } },
          });
          console.log("  Rejected.");
          return;
        }

        process.stdout.write("  Building tx... ");
        const txData = txParams.data
          ? hexToBytes(txParams.data.startsWith("0x") ? txParams.data.slice(2) : txParams.data)
          : undefined;
        const gasPrice = txParams.gasPrice ? BigInt(txParams.gasPrice) : undefined;
        const unsignedTx = await buildTransaction({
          rpcUrl, from: evmAddr, to: txParams.to, value,
          data: txData, gasLimit, chainId: chainIdNum, gasPrice,
        });
        console.log("✓");

        process.stdout.write("  Signing (ECDSA MPC)... ");
        const sighash = hashForSigning(unsignedTx);
        const sigDer = await localEcdsaSign(mpc1, ecdsaKey1, mpc2, ecdsaKey2, sighash);
        const { r, s } = parseDerSignature(sigDer);
        const recoveryBit = recoverV(sighash, r, s, pubKeyRaw);
        const rawTx = assembleSignedTx(unsignedTx, r, s, recoveryBit);
        console.log("✓");

        process.stdout.write("  Broadcasting... ");
        const txHash = await ethRpc(rpcUrl, "eth_sendRawTransaction", [rawTx]);
        console.log(`✓ ${txHash}`);

        await web3wallet.respondSessionRequest({
          topic,
          response: { id, jsonrpc: "2.0", result: txHash },
        });

      } else if (method === "eth_sign") {
        const [_address, hashHex] = request.params;
        console.log(`\n[Request] eth_sign from ${dappName}`);
        console.log(`  Hash: ${hashHex}`);
        const answer = await ask("  Approve? (y/n): ");
        if (answer.trim().toLowerCase() !== "y") {
          await web3wallet.respondSessionRequest({
            topic,
            response: { id, jsonrpc: "2.0", error: { code: 4001, message: "User rejected" } },
          });
          console.log("  Rejected.");
          return;
        }

        process.stdout.write("  Signing (ECDSA MPC)... ");
        const hash = hexToBytes(hashHex.startsWith("0x") ? hashHex.slice(2) : hashHex);
        const sigDer = await localEcdsaSign(mpc1, ecdsaKey1, mpc2, ecdsaKey2, hash);
        const { r, s } = parseDerSignature(sigDer);
        const recoveryBit = recoverV(hash, r, s, pubKeyRaw);
        const sig65 = new Uint8Array(65);
        sig65.set(bigintTo32Bytes(r), 0);
        sig65.set(bigintTo32Bytes(s), 32);
        sig65[64] = 27 + recoveryBit;
        console.log("✓");

        await web3wallet.respondSessionRequest({
          topic,
          response: { id, jsonrpc: "2.0", result: "0x" + bytesToHex(sig65) },
        });

      } else if (method === "solana_signTransaction") {
        const txBase64 = request.params.transaction;

        console.log(`\n[Request] solana_signTransaction from ${dappName}`);
        const answer = await ask("  Approve? (y/n): ");
        if (answer.trim().toLowerCase() !== "y") {
          await web3wallet.respondSessionRequest({
            topic,
            response: { id, jsonrpc: "2.0", error: { code: 4001, message: "User rejected" } },
          });
          console.log("  Rejected.");
          return;
        }

        process.stdout.write("  Signing (EdDSA MPC)... ");
        const txBytes = fromBase64(txBase64);
        const { value: numSigs, bytesRead: sigLenBytes } = readCompactU16(txBytes, 0);
        const messageOffset = sigLenBytes + numSigs * 64;
        const message = txBytes.slice(messageOffset);

        const sigRaw = await localEddsaSign(mpc1, eddsaKey1, mpc2, eddsaKey2, message);

        // Splice signature into tx at first slot
        const signedTxBytes = new Uint8Array(txBytes);
        signedTxBytes.set(sigRaw, sigLenBytes);
        const signedTxBase64 = toBase64(signedTxBytes);
        const sigBase58 = base58.encode(sigRaw);
        console.log(`✓ ${sigBase58.slice(0, 20)}...`);

        await web3wallet.respondSessionRequest({
          topic,
          response: { id, jsonrpc: "2.0", result: { signature: sigBase58, transaction: signedTxBase64 } },
        });

      } else if (method === "solana_signAndSendTransaction") {
        const txBase64 = request.params.transaction;
        const rpcUrl = process.env.SOLANA_RPC_URL || SOLANA_RPC;

        console.log(`\n[Request] solana_signAndSendTransaction from ${dappName}`);
        const answer = await ask("  Approve? (y/n): ");
        if (answer.trim().toLowerCase() !== "y") {
          await web3wallet.respondSessionRequest({
            topic,
            response: { id, jsonrpc: "2.0", error: { code: 4001, message: "User rejected" } },
          });
          console.log("  Rejected.");
          return;
        }

        process.stdout.write("  Signing (EdDSA MPC)... ");
        const txBytes = fromBase64(txBase64);
        const { value: numSigs, bytesRead: sigLenBytes } = readCompactU16(txBytes, 0);
        const messageOffset = sigLenBytes + numSigs * 64;
        const message = txBytes.slice(messageOffset);
        const sigRaw = await localEddsaSign(mpc1, eddsaKey1, mpc2, eddsaKey2, message);

        const signedTxBytes = new Uint8Array(txBytes);
        signedTxBytes.set(sigRaw, sigLenBytes);
        const signedTxBase58 = base58.encode(signedTxBytes);
        console.log("✓");

        process.stdout.write("  Broadcasting... ");
        const txSig = await broadcastSolanaTransaction(rpcUrl, signedTxBase58);
        console.log(`✓ ${txSig}`);

        await web3wallet.respondSessionRequest({
          topic,
          response: { id, jsonrpc: "2.0", result: { signature: txSig } },
        });

      } else if (method === "solana_signMessage") {
        const msgParam = request.params.message;

        console.log(`\n[Request] solana_signMessage from ${dappName}`);
        const answer = await ask("  Approve? (y/n): ");
        if (answer.trim().toLowerCase() !== "y") {
          await web3wallet.respondSessionRequest({
            topic,
            response: { id, jsonrpc: "2.0", error: { code: 4001, message: "User rejected" } },
          });
          console.log("  Rejected.");
          return;
        }

        process.stdout.write("  Signing (EdDSA MPC)... ");
        // Message can be base58 or utf8 encoded
        let messageBytes: Uint8Array;
        try {
          messageBytes = base58.decode(msgParam);
        } catch {
          messageBytes = new TextEncoder().encode(msgParam);
        }

        const sigRaw = await localEddsaSign(mpc1, eddsaKey1, mpc2, eddsaKey2, messageBytes);
        const sigBase58 = base58.encode(sigRaw);
        console.log("✓");

        await web3wallet.respondSessionRequest({
          topic,
          response: { id, jsonrpc: "2.0", result: { signature: sigBase58 } },
        });

      } else {
        console.log(`\n[Request] Unsupported method: ${method} from ${dappName}`);
        await web3wallet.respondSessionRequest({
          topic,
          response: { id, jsonrpc: "2.0", error: { code: 4001, message: `Unsupported method: ${method}` } },
        });
      }
    } catch (err: any) {
      console.error(`\n  Error: ${err.message}`);
      try {
        await web3wallet.respondSessionRequest({
          topic,
          response: { id, jsonrpc: "2.0", error: { code: -32000, message: err.message } },
        });
      } catch { /* session may be gone */ }
    }
  });

  // ── Session Delete Handler ──
  web3wallet.on("session_delete", (_event: { id: number; topic: string }) => {
    console.log("\nSession disconnected by dApp.");
  });

  // Prompt for WC URI
  const uri = await ask("\nPaste WalletConnect URI: ");
  if (!uri.trim()) {
    console.error("No URI provided.");
    process.exit(1);
  }

  process.stdout.write("Pairing... ");
  await web3wallet.pair({ uri: uri.trim() });
  console.log("✓");

  // Keep alive — Ctrl+C to exit
  process.on("SIGINT", async () => {
    console.log("\nDisconnecting...");
    const sessions = web3wallet.getActiveSessions();
    for (const session of Object.values(sessions)) {
      try {
        await web3wallet.disconnectSession({
          topic: session.topic,
          reason: { code: 6000, message: "User disconnected" },
        });
      } catch { /* ignore */ }
    }
    mpc1.freeEcdsa2pKey(ecdsaKey1);
    mpc2.freeEcdsa2pKey(ecdsaKey2);
    mpc1.freeEcKey2p(eddsaKey1);
    mpc2.freeEcKey2p(eddsaKey2);
    rl.close();
    process.exit(0);
  });

  // Keep the process alive
  await new Promise(() => {});
}

// ── Arg Parsing & Main ───────────────────────────────────────────

function parseArgs(): { command: string; files: [string, string] } {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !["recover", "connect"].includes(command)) {
    console.log("Usage: npx tsx cli.ts <command> <file1> <file2>");
    console.log("");
    console.log("Commands:");
    console.log("  recover  Reconstruct private keys and export");
    console.log("  connect  Connect to dApps via WalletConnect");
    console.log("");
    console.log("Arguments:");
    console.log("  <file1> <file2>  Two key share files (peer order is auto-detected)");
    console.log("");
    console.log("Environment variables (connect command):");
    console.log("  WC_PROJECT_ID    WalletConnect project ID (required)");
    console.log("  ETH_RPC_URL      Override EVM RPC endpoint");
    console.log("  SOLANA_RPC_URL   Override Solana RPC endpoint");
    process.exit(1);
  }

  const files = args.slice(1).filter((a) => !a.startsWith("-"));

  if (files.length !== 2) {
    console.error("Error: Exactly two key share files are required.");
    process.exit(1);
  }

  return { command, files: files as [string, string] };
}

async function main(): Promise<void> {
  const { command, files } = parseArgs();

  try {
    if (command === "recover") {
      await cmdRecover(files[0], files[1]);
    } else if (command === "connect") {
      await cmdConnect(files[0], files[1]);
    }
  } catch (err: any) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

main();
