import { apiUrl } from "./apiBase";

// Session JWT — short-lived, dies with browser tab/close
const TOKEN_KEY = "secretkey_token";
// Refresh token — long-lived (7d), persists across sessions
const REFRESH_TOKEN_KEY = "secretkey_refresh_token";

// ── Session token (sessionStorage) ──

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

function clearSessionToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

// ── Refresh token (localStorage) ──

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setRefreshToken(token: string) {
  localStorage.setItem(REFRESH_TOKEN_KEY, token);
}

function clearRefreshTokenStore() {
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

// ── Combined operations ──

/** Clear all auth tokens and sign out */
export function clearToken() {
  clearSessionToken();
  clearRefreshTokenStore();
}

/** Store both tokens from a login/unlock response */
export function setTokens(token: string, refreshToken: string) {
  setToken(token);
  setRefreshToken(refreshToken);
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Safely parse JSON from a response, returning null if not JSON */
async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function requestMagicLink(email: string, captchaToken?: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/auth/request"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, captchaToken }),
    });
  } catch {
    throw new Error("Server unreachable. Check your connection.");
  }
  if (!res.ok) {
    const data = await safeJson(res);
    throw new Error((data?.error as string) || "Failed to request magic link");
  }
}

export async function verifyToken(token: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(apiUrl(`/api/auth/verify?token=${token}`));
  } catch {
    throw new Error("Server unreachable. Check your connection.");
  }
  if (!res.ok) {
    const data = await safeJson(res);
    throw new Error((data?.error as string) || "Verification failed");
  }
  const data = await safeJson(res);
  if (!data?.token) throw new Error("Invalid server response");
  // Store both session + refresh tokens
  setToken(data.token as string);
  if (data.refreshToken) setRefreshToken(data.refreshToken as string);
  return data.token as string;
}

export async function verifyCode(email: string, code: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/auth/verify-code"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
  } catch {
    throw new Error("Server unreachable. Check your connection.");
  }
  if (!res.ok) {
    const data = await safeJson(res);
    throw new Error((data?.error as string) || "Code verification failed");
  }
  const data = await safeJson(res);
  if (!data?.token) throw new Error("Invalid server response");
  // Store both session + refresh tokens
  setToken(data.token as string);
  if (data.refreshToken) setRefreshToken(data.refreshToken as string);
  return data.token as string;
}

// ── JWT helpers ──

/** Decode JWT payload (works on expired tokens too — no signature check) */
function decodeJwtPayload(token: string): { sub: string; type?: string; email?: string; exp?: number } | null {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch { return null; }
}

export function getJwtPayload(): { sub: string; type?: string; email?: string; exp?: number } | null {
  const token = getToken();
  if (token) return decodeJwtPayload(token);
  // Fallback: decode refresh token for identity info
  const rt = getRefreshToken();
  if (rt) return decodeJwtPayload(rt);
  return null;
}

/** Seconds until the current session JWT expires (negative if expired, -1 if no token) */
export function getTokenTtl(): number {
  const token = getToken();
  if (!token) return -1;
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return -1;
  return payload.exp - Math.floor(Date.now() / 1000);
}

/** Refresh the session JWT using the current valid session JWT.
 * Returns { token, ttl } on success, null on auth failure. */
export async function refreshToken(): Promise<{ token: string; ttl: number } | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch(apiUrl("/api/auth/refresh"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) return null; // Session JWT expired
    if (!res.ok) return null;
    const data = await safeJson(res);
    if (!data?.token) return null;
    setToken(data.token as string);
    return { token: data.token as string, ttl: data.ttl as number };
  } catch {
    return null; // Network error — don't clear tokens
  }
}

export function isStandaloneJwt(): boolean {
  return getJwtPayload()?.type === "standalone";
}

/** Get the identity ID from the JWT (userId for email, keyShareId for standalone) */
export function getIdentityId(): string | null {
  return getJwtPayload()?.sub ?? null;
}

/** Check if user has any auth token (session or refresh) */
export function hasAnyToken(): boolean {
  return !!(getToken() || getRefreshToken());
}

export interface MeUser {
  id: string;
  email: string;
  frozenAt: string | null;
  unfreezeAt: string | null;
}

export interface MeStandalone {
  keyShareId: string;
  type: "standalone";
}

export async function getMe(): Promise<MeUser | null> {
  const token = getToken();
  if (!token) return null;

  // Standalone users don't have a user record — return null for MeUser
  if (isStandaloneJwt()) return null;

  try {
    const res = await fetch(apiUrl("/api/auth/me"), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await safeJson(res);
    return (data?.user as MeUser) ?? null;
  } catch {
    // Network error (server unreachable) — don't clear token
    return null;
  }
}
