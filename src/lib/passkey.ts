import { startRegistration, startAuthentication, base64URLStringToBuffer, bufferToBase64URLString } from "@simplewebauthn/browser";
import { authHeaders } from "./auth";
import { apiUrl } from "./apiBase";

const PASSKEY_TOKEN_KEY = "secretkey_passkey_token";
const PASSKEY_VERIFIED_AT_KEY = "secretkey_passkey_verified_at";

/** Grace period (ms) during which re-verification is skipped. Default: 5 minutes. */
export const PASSKEY_GRACE_PERIOD_MS = 5 * 60 * 1000;

// ── Token management (sessionStorage — per-tab, short-lived) ────

export function getPasskeyToken(): string | null {
  return sessionStorage.getItem(PASSKEY_TOKEN_KEY);
}

export function setPasskeyToken(token: string) {
  sessionStorage.setItem(PASSKEY_TOKEN_KEY, token);
}

/** Returns true if passkey was verified within the grace period */
export function isWithinPasskeyGrace(): boolean {
  const ts = sessionStorage.getItem(PASSKEY_VERIFIED_AT_KEY);
  if (!ts) return false;
  return Date.now() - parseInt(ts, 10) < PASSKEY_GRACE_PERIOD_MS;
}

export function markPasskeyVerified() {
  sessionStorage.setItem(PASSKEY_VERIFIED_AT_KEY, String(Date.now()));
}

export function clearPasskeyToken() {
  sessionStorage.removeItem(PASSKEY_TOKEN_KEY);
}

export function passkeyHeaders(): Record<string, string> {
  const token = getPasskeyToken();
  return token ? { "x-passkey-token": token } : {};
}

/** Headers for sensitive endpoints: auth + passkey */
export function sensitiveHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...authHeaders(), ...passkeyHeaders() };
}

// ── API types ───────────────────────────────────────────────────

export interface PasskeyInfo {
  id: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

// ── API calls ───────────────────────────────────────────────────

export async function fetchPasskeys(): Promise<PasskeyInfo[]> {
  const res = await fetch(apiUrl("/api/passkeys"), {
    headers: authHeaders(),
  });
  const data = await res.json();
  return data.passkeys ?? [];
}

export async function registerPasskey(name?: string): Promise<PasskeyInfo> {
  // 1. Get registration options
  const optRes = await fetch(apiUrl("/api/passkeys/register-options"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  const { options, challengeId } = await optRes.json();

  // 2. Trigger browser WebAuthn prompt
  const credential = await startRegistration({ optionsJSON: options });

  // 3. Send credential to server
  const regRes = await fetch(apiUrl("/api/passkeys/register"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ challengeId, credential, name }),
  });
  const data = await regRes.json();
  if (data.error) throw new Error(data.error);
  // Cache that user now has passkeys (for idle lock on next session)
  localStorage.setItem("idleLock.hasPasskeys", "true");
  return data as PasskeyInfo;
}

// Fixed salt for PRF-based key share encryption
const PRF_SALT = new TextEncoder().encode("secretkey-keyshare-encryption");

export interface PasskeyAuthResult {
  token: string;
  prfKey?: CryptoKey;
  credentialId?: string;
}

export async function authenticatePasskey(opts?: { withPrf?: boolean }): Promise<PasskeyAuthResult> {
  // 1. Get authentication options
  const optRes = await fetch(apiUrl("/api/passkeys/authenticate-options"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  const { options, challengeId } = await optRes.json();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let credential: any;

  if (opts?.withPrf) {
    // Bypass @simplewebauthn/browser's startAuthentication — it doesn't pass
    // extensions through to navigator.credentials.get(), so PRF never reaches
    // the authenticator. We call the WebAuthn API directly and convert the
    // result to the JSON format the server expects.
    const allowCredentials = options.allowCredentials?.map((c: { id: string; type: string; transports?: string[] }) => ({
      id: base64URLStringToBuffer(c.id),
      type: c.type,
      ...(c.transports ? { transports: c.transports } : {}),
    }));

    const publicKey: PublicKeyCredentialRequestOptions = {
      challenge: base64URLStringToBuffer(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification as UserVerificationRequirement,
      allowCredentials,
      extensions: {
        prf: { eval: { first: PRF_SALT } },
      } as AuthenticationExtensionsClientInputs,
    };

    let rawCredential: PublicKeyCredential;
    try {
      rawCredential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential;
    } catch (prfErr) {
      // Some passkey providers (e.g. 1Password) may fail with PRF extension.
      // Retry without PRF — auth still works, just no encryption key.
      console.warn("[passkey] PRF request failed, retrying without PRF:", prfErr);
      delete publicKey.extensions;
      rawCredential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential;
    }
    if (!rawCredential) throw new Error("Authentication was not completed");

    // Keep raw extension results for PRF extraction (contains ArrayBuffers)
    const extensionResults = rawCredential.getClientExtensionResults();

    const response = rawCredential.response as AuthenticatorAssertionResponse;
    credential = {
      id: rawCredential.id,
      rawId: bufferToBase64URLString(rawCredential.rawId),
      response: {
        authenticatorData: bufferToBase64URLString(response.authenticatorData),
        clientDataJSON: bufferToBase64URLString(response.clientDataJSON),
        signature: bufferToBase64URLString(response.signature),
        ...(response.userHandle ? { userHandle: bufferToBase64URLString(response.userHandle) } : {}),
      },
      type: rawCredential.type,
      // Send empty object to server (it doesn't need extension results);
      // keep raw results separately for PRF key derivation
      clientExtensionResults: {},
      authenticatorAttachment: rawCredential.authenticatorAttachment,
      _rawExtensionResults: extensionResults,
    };
  } else {
    credential = await startAuthentication({ optionsJSON: options });
  }

  // 3. Verify with server
  const authRes = await fetch(apiUrl("/api/passkeys/authenticate"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ challengeId, credential }),
  });
  const data = await authRes.json();
  if (data.error) throw new Error(data.error);

  // 4. Store token and mark verification time for grace period
  setPasskeyToken(data.passkeyToken);
  markPasskeyVerified();

  // 5. Derive AES-256-GCM key from PRF output if available
  let prfKey: CryptoKey | undefined;
  const extResults = credential._rawExtensionResults ?? credential.clientExtensionResults;
  const prfResult = extResults?.prf?.results?.first;
  if (prfResult) {
    const rawKey = await crypto.subtle.importKey("raw", prfResult, "HKDF", false, ["deriveKey"]);
    prfKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: PRF_SALT, info: new Uint8Array(0) },
      rawKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  return { token: data.passkeyToken, prfKey, credentialId: credential.id };
}

/**
 * Local-only PRF authentication — no server calls needed.
 * Used for standalone unlock on the login page (no JWT available).
 * Returns the PRF-derived CryptoKey for decrypting the stored share.
 */
export async function localPrfAuthenticate(credentialId: string): Promise<CryptoKey> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge,
    rpId: window.location.hostname,
    timeout: 60000,
    userVerification: "preferred",
    allowCredentials: [{
      id: base64URLStringToBuffer(credentialId),
      type: "public-key",
    }],
    extensions: {
      prf: { eval: { first: PRF_SALT } },
    } as AuthenticationExtensionsClientInputs,
  };

  const rawCredential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential;
  if (!rawCredential) throw new Error("Authentication was not completed");

  const extResults = rawCredential.getClientExtensionResults();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prfResult = (extResults as any)?.prf?.results?.first;
  if (!prfResult) throw new Error("PRF not supported by this passkey");

  const rawKey = await crypto.subtle.importKey("raw", prfResult, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: PRF_SALT, info: new Uint8Array(0) },
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Pre-fetched unlock challenge (fetched on lock screen mount, used on button click) */
export interface UnlockChallenge {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any;
  challengeId: string;
}

/** Pre-fetch passkey challenge options so the WebAuthn prompt fires immediately on click.
 * iOS dismisses the prompt if there's too much async delay after the user gesture. */
export async function fetchUnlockChallenge(ownerId: string): Promise<UnlockChallenge> {
  const optRes = await fetch(apiUrl("/api/auth/passkey-unlock-options"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerId }),
  });
  if (!optRes.ok) {
    const err = await optRes.json();
    throw new Error(err.error || "Failed to get unlock options");
  }
  return optRes.json();
}

/** Complete passkey unlock using a pre-fetched challenge.
 * Call this directly in the click handler so WebAuthn prompt fires immediately. */
export async function completePasskeyUnlock(challenge: UnlockChallenge): Promise<{ token: string; passkeyToken: string; ttl: number }> {
  // 1. Trigger browser WebAuthn prompt (must happen close to user gesture)
  const credential = await startAuthentication({ optionsJSON: challenge.options });

  // 2. Verify with server (credentials: include for httpOnly refresh token cookie)
  const verifyRes = await fetch(apiUrl("/api/auth/passkey-unlock-verify"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, credential }),
    credentials: "include",
  });
  if (!verifyRes.ok) {
    const err = await verifyRes.json();
    throw new Error(err.error || "Unlock verification failed");
  }
  const data = await verifyRes.json();

  // 3. Store passkey token and mark verification
  setPasskeyToken(data.passkeyToken);
  markPasskeyVerified();

  return { token: data.token, passkeyToken: data.passkeyToken, ttl: data.ttl };
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/passkeys/${id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
}

export async function deletePasskey(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/passkeys/${id}`), {
    method: "DELETE",
    headers: authHeaders(),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
}
