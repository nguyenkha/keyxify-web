// Keyshare file encryption/decryption using Web Crypto API
// PBKDF2 (600k iterations, SHA-256) + AES-GCM-256

import { toBase64, fromBase64 } from "./mpc";

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface KeyFileData {
  id: string;
  peer: number;
  share: string;
  publicKey: string;
  eddsaShare: string;
  eddsaPublicKey: string;
  type?: "email" | "standalone"; // standalone backup marker
  encrypted?: boolean;
  salt?: string;
  encryption?: "server-hkdf"; // present when encrypted by server HKDF
}

/** Check if a key file is HKDF-encrypted (server backup format) */
export function isHkdfEncrypted(data: KeyFileData): boolean {
  return data.encryption === "server-hkdf";
}

/** Decrypt HKDF-encrypted fields using a hex key from support */
export async function decryptHkdfKeyFile(data: KeyFileData, hexKey: string): Promise<KeyFileData> {
  const keyBytes = new Uint8Array(hexKey.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);

  async function dec(encB64: string): Promise<string> {
    const combined = fromBase64(encB64);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
    return new TextDecoder().decode(plain);
  }

  try {
    const share = await dec(data.share);
    const eddsaShare = data.eddsaShare ? await dec(data.eddsaShare) : "";
    return { ...data, share, eddsaShare, encrypted: false, encryption: undefined };
  } catch (err) {
    if (err instanceof DOMException && err.name === "OperationError") {
      throw new Error("Invalid decryption key");
    }
    throw err;
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(passphrase);
  const baseKey = await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptField(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const combined = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), IV_BYTES);
  return toBase64(combined);
}

async function decryptField(encryptedBase64: string, key: CryptoKey): Promise<string> {
  const combined = fromBase64(encryptedBase64);
  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

export function isEncryptedKeyFile(data: KeyFileData): boolean {
  return data.encrypted === true && typeof data.salt === "string";
}

export async function encryptKeyFile(data: KeyFileData, passphrase: string): Promise<KeyFileData> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(passphrase, salt);

  const result: KeyFileData = {
    id: data.id,
    peer: data.peer,
    publicKey: data.publicKey,
    encrypted: true,
    salt: toBase64(salt),
    share: await encryptField(data.share, key),
    eddsaShare: await encryptField(data.eddsaShare, key),
    eddsaPublicKey: data.eddsaPublicKey,
  };

  return result;
}

export async function decryptKeyFile(data: KeyFileData, passphrase: string): Promise<KeyFileData> {
  if (!data.salt) throw new Error("Missing salt in encrypted key file");

  const salt = fromBase64(data.salt);
  const key = await deriveKey(passphrase, salt);

  try {
    const result: KeyFileData = {
      id: data.id,
      peer: data.peer,
      publicKey: data.publicKey,
      share: await decryptField(data.share, key),
      eddsaShare: await decryptField(data.eddsaShare, key),
      eddsaPublicKey: data.eddsaPublicKey,
    };

    return result;
  } catch (err) {
    if (err instanceof DOMException && err.name === "OperationError") {
      throw new Error("Incorrect passphrase");
    }
    throw err;
  }
}
