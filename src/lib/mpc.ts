import { initCbMpc, NID_secp256k1, NID_ED25519 } from "cb-mpc";
import type { CbMpc, DataTransport, Ecdsa2pKeyHandle, EcKey2pHandle } from "cb-mpc";
import { isRecoveryMode, performLocalMpcSign } from "./recovery";
import { apiUrl } from "./apiBase";
import cbmpcWasmUrl from "cb-mpc/cbmpc.wasm?url";

export { NID_secp256k1, NID_ED25519 };
export type { CbMpc, Ecdsa2pKeyHandle, EcKey2pHandle };

// ── Singleton MPC instance ──

let mpcInstance: CbMpc | null = null;
let mpcPromise: Promise<CbMpc> | null = null;

export async function getMpcInstance(): Promise<CbMpc> {
  if (!mpcInstance) {
    if (!mpcPromise) {
      // Import Emscripten glue and wrap factory with locateFile override.
      // Vite's dev server can't resolve the relative paths that Emscripten
      // uses internally, so we point it to Vite-resolved URLs explicitly.
      // @ts-expect-error -- cb-mpc has no type declarations
      const mod = await import("cb-mpc/cbmpc.js");
      const rawFactory = mod.default || mod.createCbMpc || mod;
      const factory = (opts?: Record<string, unknown>) =>
        rawFactory({
          ...opts,
          locateFile: (path: string) =>
            path.endsWith(".wasm") ? cbmpcWasmUrl : path,
        });
      mpcPromise = initCbMpc(factory as unknown as Parameters<typeof initCbMpc>[0]);
    }
    mpcInstance = await mpcPromise;
  }
  return mpcInstance;
}

// ── In-memory key handle cache (lost on page reload) ──

export interface ClientKeyHandles {
  mpc: CbMpc;
  ecdsa?: Ecdsa2pKeyHandle;
  eddsa?: EcKey2pHandle;
}

export const clientKeys = new Map<string, ClientKeyHandles>();

/**
 * Restore key handles from serialized data (stored in key file or browser storage).
 * No-op if already in memory.
 */
export async function restoreKeyHandles(keyId: string, shareData: string, eddsaShareData?: string): Promise<void> {
  if (clientKeys.has(keyId)) return;

  const mpc = await getMpcInstance();
  const entry: ClientKeyHandles = { mpc };

  if (shareData) {
    const parts = shareData.split(",").map((s) => fromBase64(s));
    entry.ecdsa = mpc.deserializeEcdsa2p(parts);
  }

  if (eddsaShareData) {
    const parts = eddsaShareData.split(",").map((s) => fromBase64(s));
    entry.eddsa = mpc.deserializeEcKey2p(parts);
  }

  clientKeys.set(keyId, entry);
}

/** Remove a key handle from the in-memory cache (call after signing is done or on dialog close). */
export function clearClientKey(keyId: string): void {
  clientKeys.delete(keyId);
}

// ── Helpers ──

export function toBase64(buf: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

export function fromBase64(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function toHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256(message: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

// ── HTTP Transport ──

const PARTY_NAMES: [string, string] = ["client", "server"];

/**
 * Create a DataTransport that bridges cb-mpc's send/receive to HTTP.
 *
 * Each transport.send() POSTs a message to the server and buffers the response.
 * The subsequent transport.receive() returns the buffered response.
 *
 * First send goes to initUrl, subsequent sends go to stepUrl.
 */
export function createHttpTransport(opts: {
  initUrl: string;
  stepUrl: string;
  initExtra?: Record<string, unknown>;
  headers: Record<string, string>;
  onStep?: (step: number) => void;
}): { transport: DataTransport; getSessionId: () => string; getServerResult: () => Record<string, unknown> | null; getError: () => Error | null; transportFailed: Promise<never> } {
  let sessionId = "";
  let inbox: Uint8Array | null = null;
  let isFirst = true;
  let serverResult: Record<string, unknown> | null = null;
  let transportError: Error | null = null;
  let rejectTransport: ((err: Error) => void) | null = null;
  let stepCount = 0;
  const transportFailed = new Promise<never>((_resolve, reject) => {
    rejectTransport = reject;
  });
  // Prevent unhandled rejection when transportFailed rejects outside of Promise.race
  transportFailed.catch(() => {});

  const transport: DataTransport = {
    send: async (_receiver, message) => {
      // Copy — WASM memory views may be invalidated after return
      const msgCopy = new Uint8Array(message);
      const url = isFirst ? opts.initUrl : opts.stepUrl;
      const body = isFirst
        ? { ...opts.initExtra, message: toBase64(msgCopy) }
        : { sessionId, message: toBase64(msgCopy) };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...opts.headers },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) {
        transportError = new Error(data.error);
        rejectTransport?.(transportError);
        throw transportError;
      }

      if (isFirst) {
        sessionId = data.sessionId;
        isFirst = false;
      }
      stepCount++;
      opts.onStep?.(stepCount);

      if (data.done) {
        serverResult = data;
        // No more messages — protocol will complete on our side too (supports both single & batch)
        inbox = null;
      } else {
        inbox = data.message ? fromBase64(data.message) : null;
      }

      return 0;
    },

    receive: async (_sender) => {
      if (inbox) {
        const msg = inbox;
        inbox = null;
        return msg;
      }
      // If server is done, return empty (protocol should also be finishing)
      return new Uint8Array(0);
    },

    receiveAll: async (senders) =>
      Promise.all(senders.map((s) => transport.receive(s))),
  };

  return {
    transport,
    getSessionId: () => sessionId,
    getServerResult: () => serverResult,
    getError: () => transportError,
    transportFailed,
  };
}

// ── MPC Signing ──

export interface MpcSignResult {
  signature: Uint8Array;
  sessionId: string;
}

export interface BatchMpcSignResult {
  signatures: Uint8Array[];
  sessionId: string;
}

/**
 * Run the MPC signing protocol.
 * Requires the key handle to be in the clientKeys cache.
 */
export async function performMpcSign(opts: {
  algorithm: "ecdsa" | "eddsa";
  keyId: string;
  hash: Uint8Array;
  initPayload: Record<string, unknown>;
  headers: Record<string, string>;
  onStep?: (step: number) => void;
}): Promise<MpcSignResult> {
  const { algorithm, keyId, hash, initPayload, headers, onStep } = opts;

  // In recovery mode, sign locally with both peers in the browser
  if (isRecoveryMode()) {
    return performLocalMpcSign({ algorithm, keyId, hash, onStep });
  }

  const entry = clientKeys.get(keyId);
  if (!entry) {
    throw new Error("Key handle not found. Please re-create or re-import the key.");
  }

  const keyHandle = algorithm === "eddsa" ? entry.eddsa : entry.ecdsa;
  if (!keyHandle) {
    throw new Error(`No ${algorithm} key handle available`);
  }

  const mpc = entry.mpc;

  // For ECDSA, both parties must use the same session ID
  const sigSessionId = new Uint8Array(32);
  crypto.getRandomValues(sigSessionId);

  const { transport, getSessionId, getServerResult, getError, transportFailed } = createHttpTransport({
    initUrl: apiUrl("/api/sign/init"),
    stepUrl: apiUrl("/api/sign/step"),
    initExtra: {
      ...initPayload,
      data: toBase64(hash),
      ...(algorithm === "ecdsa" ? { sigSessionId: toBase64(sigSessionId) } : {}),
    },
    headers,
    onStep,
  });

  const startedAt = Date.now();

  let sigRaw: Uint8Array;

  // Race the MPC protocol against transport errors — WASM may hang if the
  // server rejects (e.g. policy block) because it swallows the send() throw.
  const mpcPromise = (async () => {
    if (algorithm === "eddsa") {
      return mpc.schnorr2pEddsaSign(
        transport, 0, PARTY_NAMES, keyHandle as EcKey2pHandle, hash,
      );
    } else {
      const sigs = await mpc.ecdsa2pSign(
        transport, 0, PARTY_NAMES, keyHandle as Ecdsa2pKeyHandle, sigSessionId, [hash],
      );
      return sigs[0].length > 0 ? sigs[0] : new Uint8Array(0);
    }
  })();

  try {
    sigRaw = await Promise.race([mpcPromise, transportFailed]);
  } catch (err) {
    const transportErr = getError();
    if (transportErr) throw transportErr;
    throw err;
  }

  // If client didn't get the signature, check server result
  if (sigRaw.length === 0) {
    const sr = getServerResult();
    if (sr?.signature) {
      sigRaw = fromBase64(sr.signature as string);
    }
  }

  if (!sigRaw || sigRaw.length === 0) {
    throw new Error("No signature available");
  }

  // Pad fast signing to at least 1s for smoother UX
  const elapsed = Date.now() - startedAt;
  if (elapsed < 1000) {
    await new Promise((r) =>
      setTimeout(r, 1000 - elapsed + Math.floor(Math.random() * 500)),
    );
  }

  return { signature: sigRaw, sessionId: getSessionId() };
}

/**
 * Batch MPC signing — sign multiple hashes in a single MPC session.
 * Used for UTXO chains (BTC/BCH/LTC) where each input needs a separate signature.
 * Only supports ECDSA (ecdsa2pSign natively accepts multiple hashes).
 */
export async function performBatchMpcSign(opts: {
  keyId: string;
  hashes: Uint8Array[];
  initPayload: Record<string, unknown>;
  headers: Record<string, string>;
  onStep?: (step: number) => void;
}): Promise<BatchMpcSignResult> {
  const { keyId, hashes, initPayload, headers, onStep } = opts;

  if (hashes.length === 0) throw new Error("No hashes to sign");

  // Single hash — delegate to regular sign
  if (hashes.length === 1) {
    const result = await performMpcSign({
      algorithm: "ecdsa",
      keyId,
      hash: hashes[0],
      initPayload,
      headers,
      onStep,
    });
    return { signatures: [result.signature], sessionId: result.sessionId };
  }

  // In recovery mode, sign each hash locally (recovery uses separate sessions)
  if (isRecoveryMode()) {
    const { performLocalBatchMpcSign } = await import("./recovery");
    return performLocalBatchMpcSign({ keyId, hashes, onStep });
  }

  const entry = clientKeys.get(keyId);
  if (!entry) {
    throw new Error("Key handle not found. Please re-create or re-import the key.");
  }

  const keyHandle = entry.ecdsa;
  if (!keyHandle) {
    throw new Error("No ECDSA key handle available");
  }

  const mpc = entry.mpc;

  // Both parties must use the same session ID
  const sigSessionId = new Uint8Array(32);
  crypto.getRandomValues(sigSessionId);

  // Build hashes array for init payload
  const hashesPayload = hashes.map((h, i) => ({
    data: toBase64(h),
    inputIndex: i,
  }));

  const { transport, getSessionId, getServerResult, getError, transportFailed } = createHttpTransport({
    initUrl: apiUrl("/api/sign/init"),
    stepUrl: apiUrl("/api/sign/step"),
    initExtra: {
      ...initPayload,
      data: toBase64(hashes[0]),
      hashes: hashesPayload,
      sigSessionId: toBase64(sigSessionId),
    },
    headers,
    onStep,
  });

  const startedAt = Date.now();

  const mpcPromise = (async () => {
    const sigs = await mpc.ecdsa2pSign(
      transport, 0, PARTY_NAMES, keyHandle as Ecdsa2pKeyHandle, sigSessionId, hashes,
    );
    return sigs;
  })();

  let rawSigs: Uint8Array[];
  try {
    rawSigs = await Promise.race([mpcPromise, transportFailed]);
  } catch (err) {
    const transportErr = getError();
    if (transportErr) throw transportErr;
    throw err;
  }

  // If client got empty signatures, check server result
  if (rawSigs.every((s) => s.length === 0)) {
    const sr = getServerResult();
    if (sr?.signatures) {
      rawSigs = (sr.signatures as string[]).map((s) => fromBase64(s));
    }
  }

  if (!rawSigs || rawSigs.length !== hashes.length) {
    throw new Error(`Expected ${hashes.length} signatures, got ${rawSigs?.length ?? 0}`);
  }

  for (let i = 0; i < rawSigs.length; i++) {
    if (!rawSigs[i] || rawSigs[i].length === 0) {
      throw new Error(`No signature produced for input ${i}`);
    }
  }

  // Pad fast signing to at least 1s for smoother UX
  const elapsed = Date.now() - startedAt;
  if (elapsed < 1000) {
    await new Promise((r) =>
      setTimeout(r, 1000 - elapsed + Math.floor(Math.random() * 500)),
    );
  }

  return { signatures: rawSigs, sessionId: getSessionId() };
}
