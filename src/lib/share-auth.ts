// Share-derived Ed25519 authentication for standalone keyshares
// Derives an auth keypair from the ECDSA client share via HKDF,
// then performs challenge-response auth with the server.

import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519.js";
import { setTokens } from "./auth";
import { apiUrl } from "./apiBase";
import { toHex } from "./mpc";

/** Derive Ed25519 auth keypair from ECDSA share data (deterministic) */
export function deriveAuthKeyPair(ecdsaShareData: string) {
  const shareBytes = new TextEncoder().encode(ecdsaShareData);
  const seed = hkdf(sha256, shareBytes, "kexify-share-auth", "", 32);
  const publicKey = ed25519.getPublicKey(seed);
  return { privateKey: seed, publicKey };
}

/** Get the auth public key hex from ECDSA share data */
export function authPublicKeyHex(ecdsaShareData: string): string {
  const { publicKey } = deriveAuthKeyPair(ecdsaShareData);
  return toHex(publicKey);
}

/** Sign a challenge with the derived auth private key */
function signChallenge(challengeHex: string, privateKey: Uint8Array): string {
  const challengeBytes = new Uint8Array(
    challengeHex.match(/.{2}/g)!.map((b) => parseInt(b, 16))
  );
  const signature = ed25519.sign(challengeBytes, privateKey);
  return toHex(signature);
}

/** Perform share-derived auth: derive keypair → challenge → verify → JWT */
export async function performShareAuth(
  ecdsaShareData: string,
  captchaToken?: string
): Promise<{ token: string; keyShareId: string }> {
  const { privateKey, publicKey } = deriveAuthKeyPair(ecdsaShareData);
  const pubHex = toHex(publicKey);

  // Step 1: Request challenge
  const authRes = await fetch(apiUrl("/api/auth/share-auth"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authPublicKey: pubHex, captchaToken }),
  });
  if (!authRes.ok) {
    const data = await authRes.json().catch(() => null);
    throw new Error((data?.error as string) || "Share authentication failed");
  }
  const { challenge, challengeId } = await authRes.json();

  // Step 2: Sign challenge and verify
  const signature = signChallenge(challenge, privateKey);
  const verifyRes = await fetch(apiUrl("/api/auth/share-verify"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId, signature }),
  });
  if (!verifyRes.ok) {
    const data = await verifyRes.json().catch(() => null);
    throw new Error((data?.error as string) || "Signature verification failed");
  }
  const data = await verifyRes.json();

  // Store session JWT + refresh token
  setTokens(data.token, data.refreshToken);

  // Extract keyShareId from JWT payload
  const payload = JSON.parse(atob(data.token.split(".")[1]));
  return { token: data.token, keyShareId: payload.sub };
}
