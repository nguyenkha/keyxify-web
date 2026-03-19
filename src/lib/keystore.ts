// Browser key share storage using localStorage
// Encrypted with passkey PRF-derived key or passphrase fallback

import type { KeyFileData } from "./crypto";
import { toBase64, fromBase64 } from "./mpc";

const STORAGE_PREFIX = "keyshare:";

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

// ── Storage preference ───────────────────────────────────────────

const PREF_KEY = "keyshare_pref";

export function getStoragePreference(): "browser" | "file" {
  return localStorage.getItem(PREF_KEY) === "browser" ? "browser" : "file";
}

export function setStoragePreference(pref: "browser" | "file") {
  localStorage.setItem(PREF_KEY, pref);
}

// ── Stored shape ─────────────────────────────────────────────────

interface StoredShare {
  keyId: string;
  mode: "prf" | "passphrase";
  credentialId?: string;
  salt?: string; // base64, for passphrase mode
  iv: string; // base64
  ciphertext: string; // base64
  meta: {
    publicKey: string;
    storedAt: string;
    name?: string;
  };
}

function lsKey(keyId: string): string {
  return STORAGE_PREFIX + keyId;
}

function lsGet(keyId: string): StoredShare | null {
  const raw = localStorage.getItem(lsKey(keyId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function lsPut(value: StoredShare): void {
  localStorage.setItem(lsKey(value.keyId), JSON.stringify(value));
}

function lsDelete(keyId: string): void {
  localStorage.removeItem(lsKey(keyId));
}

function lsGetAll(): StoredShare[] {
  const results: StoredShare[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(STORAGE_PREFIX)) continue;
    try {
      const v = JSON.parse(localStorage.getItem(k)!);
      if (v?.keyId) results.push(v);
    } catch { /* skip */ }
  }
  return results;
}

// ── Encryption helpers ────────────────────────────────────────────

function serialize(data: KeyFileData): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(data));
}

function deserialize(buf: Uint8Array): KeyFileData {
  return JSON.parse(new TextDecoder().decode(buf));
}

// Helper to convert Uint8Array to ArrayBuffer (avoids TS BufferSource issues)
function toAB(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

async function aesEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toAB(iv) }, key, toAB(plaintext));
  return {
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted)),
  };
}

async function aesDecrypt(key: CryptoKey, iv: string, ciphertext: string): Promise<Uint8Array> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toAB(fromBase64(iv)) },
    key,
    toAB(fromBase64(ciphertext)),
  );
  return new Uint8Array(decrypted);
}

async function derivePassphraseKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(passphrase);
  const baseKey = await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: toAB(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ── Public API ────────────────────────────────────────────────────

export async function saveKeyShareWithPrf(
  keyId: string,
  data: KeyFileData,
  prfKey: CryptoKey,
  credentialId: string,
): Promise<void> {
  const { iv, ciphertext } = await aesEncrypt(prfKey, serialize(data));
  lsPut({
    keyId,
    mode: "prf",
    credentialId,
    iv,
    ciphertext,
    meta: {
      publicKey: data.publicKey,
      storedAt: new Date().toISOString(),
    },
  });
}

export async function saveKeyShareWithPassphrase(
  keyId: string,
  data: KeyFileData,
  passphrase: string,
): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await derivePassphraseKey(passphrase, salt);
  const { iv, ciphertext } = await aesEncrypt(key, serialize(data));
  lsPut({
    keyId,
    mode: "passphrase",
    salt: toBase64(salt),
    iv,
    ciphertext,
    meta: {
      publicKey: data.publicKey,
      storedAt: new Date().toISOString(),
    },
  });
}

export async function getKeyShareWithPrf(keyId: string, prfKey: CryptoKey): Promise<KeyFileData | null> {
  const entry = lsGet(keyId);
  if (!entry || entry.mode !== "prf") return null;
  try {
    return deserialize(await aesDecrypt(prfKey, entry.iv, entry.ciphertext));
  } catch {
    return null;
  }
}

export async function getKeyShareWithPassphrase(keyId: string, passphrase: string): Promise<KeyFileData | null> {
  const entry = lsGet(keyId);
  if (!entry || entry.mode !== "passphrase" || !entry.salt) return null;
  const key = await derivePassphraseKey(passphrase, fromBase64(entry.salt));
  try {
    return deserialize(await aesDecrypt(key, entry.iv, entry.ciphertext));
  } catch {
    throw new Error("Incorrect passphrase");
  }
}

export function hasKeyShare(keyId: string): boolean {
  return lsGet(keyId) !== null;
}

export function getKeyShareMode(keyId: string): "prf" | "passphrase" | null {
  return lsGet(keyId)?.mode ?? null;
}

export function deleteKeyShare(keyId: string): void {
  lsDelete(keyId);
}

export interface KeyShareInfo {
  keyId: string;
  publicKey: string;
  mode: "prf" | "passphrase";
  storedAt: string;
  name?: string;
  credentialId?: string;
}

/** Decrypt a StoredShare blob (from server escrow) using a PRF key */
export async function getKeyShareFromStoredShare(
  stored: { mode: string; iv: string; ciphertext: string },
  prfKey: CryptoKey,
): Promise<KeyFileData | null> {
  try {
    return deserialize(await aesDecrypt(prfKey, stored.iv, stored.ciphertext));
  } catch {
    return null;
  }
}

export function listKeyShares(): KeyShareInfo[] {
  return lsGetAll().map((e) => ({
    keyId: e.keyId,
    publicKey: e.meta.publicKey,
    mode: e.mode,
    storedAt: e.meta.storedAt,
    name: e.meta.name,
    credentialId: e.credentialId,
  }));
}
