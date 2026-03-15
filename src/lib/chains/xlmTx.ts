// Stellar (XLM) transaction building, signing, and broadcasting

export interface XlmPaymentParams {
  from: string;          // G... source address
  to: string;            // G... destination address
  amountStroops: bigint; // amount in stroops (1 XLM = 10,000,000 stroops)
  feeStroops: number;    // fee per operation in stroops (min 100)
  sequence: bigint;      // source account sequence + 1
  asset?: {              // undefined = native XLM
    code: string;        // e.g. "USDC"
    issuer: string;      // issuer G... address
  };
  memo?: string;         // optional memo text (MEMO_TEXT, max 28 bytes)
}

// ── Base32 ──────────────────────────────────────────────────────────
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(str: string): Uint8Array {
  let bits = 0, value = 0;
  const output: number[] = [];
  for (const char of str.toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

// Convert G... Strkey to 32-byte Ed25519 public key
export function strKeyToPublicKey(address: string): Uint8Array {
  const decoded = base32Decode(address);
  // decoded[0] = version (0x30), decoded[1..32] = pubkey, decoded[33..34] = CRC
  return decoded.slice(1, 33);
}

// Encode a 32-byte Ed25519 public key as a G... Stellar strkey address
function crc16xmodem(data: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function base32Encode(data: Uint8Array): string {
  const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, output = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { output += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

// Convert a 65-byte SEC1 uncompressed Ed25519 public key (04||x_BE||y_BE)
// to the 32-byte standard Ed25519 key (y_LE with x sign bit) and encode as G... address.
export function eddsaPubKeyToXlmAddress(eddsaPubKeyHex: string): string {
  const bytes = new Uint8Array(eddsaPubKeyHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
  let key32: Uint8Array;
  if (bytes.length === 32) {
    key32 = bytes;
  } else if (bytes.length === 65 && bytes[0] === 0x04) {
    const x_be = bytes.slice(1, 33);
    const y_le = bytes.slice(33).reverse();
    key32 = new Uint8Array(y_le);
    key32[31] = (key32[31] & 0x7f) | ((x_be[31] & 1) << 7);
  } else {
    throw new Error(`Unexpected EdDSA public key length: ${bytes.length}`);
  }
  const payload = new Uint8Array(35);
  payload[0] = 0x30; // G... account ID version byte
  payload.set(key32, 1);
  const crc = crc16xmodem(payload.subarray(0, 33));
  payload[33] = crc & 0xff;
  payload[34] = (crc >> 8) & 0xff;
  return base32Encode(payload);
}

// ── Helpers ─────────────────────────────────────────────────────────
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return new Uint8Array(buf);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
}

// ── XDR primitives ──────────────────────────────────────────────────
function xdrUint32(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function xdrInt64(v: bigint): Uint8Array {
  const big = BigInt.asIntN(64, v);
  const hi = Number((big >> 32n) & 0xffffffffn) >>> 0;
  const lo = Number(big & 0xffffffffn) >>> 0;
  return new Uint8Array([
    (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
  ]);
}

function xdrFixed(bytes: Uint8Array): Uint8Array {
  const pad = (4 - (bytes.length % 4)) % 4;
  const result = new Uint8Array(bytes.length + pad);
  result.set(bytes);
  return result;
}

function xdrVar(bytes: Uint8Array): Uint8Array {
  return concat(xdrUint32(bytes.length), xdrFixed(bytes));
}

function xdrMuxedAccount(pubKey: Uint8Array): Uint8Array {
  return concat(xdrUint32(0), pubKey); // KEY_TYPE_ED25519 = 0
}

// MEMO_NONE = 0, MEMO_TEXT = 1 (var-length string, max 28 bytes)
function xdrMemo(text?: string): Uint8Array {
  if (!text) return xdrUint32(0); // MEMO_NONE
  const bytes = new TextEncoder().encode(text.slice(0, 28));
  return concat(xdrUint32(1), xdrVar(bytes)); // MEMO_TEXT
}

function xdrAccountId(pubKey: Uint8Array): Uint8Array {
  return concat(xdrUint32(0), pubKey); // PUBLIC_KEY_TYPE_ED25519 = 0
}

function xdrAsset(asset?: { code: string; issuer: string }): Uint8Array {
  if (!asset) return xdrUint32(0); // ASSET_TYPE_NATIVE = 0
  const code = asset.code;
  const issuerPubKey = strKeyToPublicKey(asset.issuer);
  if (code.length <= 4) {
    const codeBytes = new Uint8Array(4);
    for (let i = 0; i < code.length; i++) codeBytes[i] = code.charCodeAt(i);
    return concat(xdrUint32(1), codeBytes, xdrAccountId(issuerPubKey)); // ALPHANUM4
  } else {
    const codeBytes = new Uint8Array(12);
    for (let i = 0; i < Math.min(code.length, 12); i++) codeBytes[i] = code.charCodeAt(i);
    return concat(xdrUint32(2), codeBytes, xdrAccountId(issuerPubKey)); // ALPHANUM12
  }
}

// ── CREATE_ACCOUNT XDR (for activating new accounts with native XLM) ─
export function buildXlmCreateAccountXdr(params: Omit<XlmPaymentParams, "asset">): Uint8Array {
  const fromPubKey = strKeyToPublicKey(params.from);
  const toPubKey = strKeyToPublicKey(params.to);

  const sourceAccount = xdrMuxedAccount(fromPubKey);
  const fee = xdrUint32(params.feeStroops);
  const seqNum = xdrInt64(params.sequence);
  const cond = xdrUint32(0); // PRECOND_NONE
  const memo = xdrMemo(params.memo);

  // CreateAccountOp: destination (AccountID) + startingBalance (Int64)
  const destination = xdrAccountId(toPubKey);
  const startingBalance = xdrInt64(params.amountStroops);
  const createAccountOp = concat(destination, startingBalance);

  // Operation: no source override, CREATE_ACCOUNT = 0
  const operation = concat(xdrUint32(0), xdrUint32(0), createAccountOp);
  const operations = concat(xdrUint32(1), operation);
  const ext = xdrUint32(0);

  return concat(sourceAccount, fee, seqNum, cond, memo, operations, ext);
}

// Check if a Stellar account exists on the network
export async function checkXlmAccountExists(horizonUrl: string, address: string): Promise<boolean> {
  try {
    const res = await fetch(`${horizonUrl}/accounts/${address}`);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Transaction XDR (v1, no envelope) ───────────────────────────────
export function buildXlmTransactionXdr(params: XlmPaymentParams): Uint8Array {
  const fromPubKey = strKeyToPublicKey(params.from);
  const toPubKey = strKeyToPublicKey(params.to);

  const sourceAccount = xdrMuxedAccount(fromPubKey); // KEY_TYPE_ED25519
  const fee = xdrUint32(params.feeStroops);           // total fee = feeStroops * numOps
  const seqNum = xdrInt64(params.sequence);
  const cond = xdrUint32(0);                          // PRECOND_NONE
  const memo = xdrMemo(params.memo);

  // PaymentOp
  const destination = xdrMuxedAccount(toPubKey);
  const asset = xdrAsset(params.asset);
  const amount = xdrInt64(params.amountStroops);
  const paymentOp = concat(destination, asset, amount);

  // Operation: no source override, body discriminant PAYMENT = 1
  const operation = concat(xdrUint32(0), xdrUint32(1), paymentOp);

  // operations array
  const operations = concat(xdrUint32(1), operation);
  const ext = xdrUint32(0); // union switch v=0: void

  return concat(sourceAccount, fee, seqNum, cond, memo, operations, ext);
}

// Hash to sign: SHA-256(networkId || ENVELOPE_TYPE_TX(2) || txXdr)
// Stellar signs SHA-256(signatureBase) as the 32-byte Ed25519 message.
// Horizon verifies with the same 32-byte hash.
export async function xlmHashForSigning(txXdr: Uint8Array, isTestnet: boolean): Promise<Uint8Array> {
  const passphrase = isTestnet
    ? "Test SDF Network ; September 2015"
    : "Public Global Stellar Network ; September 2015";
  const networkId = await sha256(new TextEncoder().encode(passphrase));
  const envelopeType = xdrUint32(2); // ENVELOPE_TYPE_TX
  return sha256(concat(networkId, envelopeType, txXdr));
}

// Assemble signed TransactionEnvelope (v1) as base64
export function assembleXlmSignedTx(
  txXdr: Uint8Array,
  fromPubKey: Uint8Array,
  signature: Uint8Array,
): string {
  const hint = fromPubKey.slice(-4);                      // last 4 bytes of pubkey
  const decoratedSig = concat(hint, xdrVar(signature));   // hint[4] || var<sig>
  const signatures = concat(xdrUint32(1), decoratedSig);  // array of 1
  const v1Envelope = concat(txXdr, signatures);
  const envelope = concat(xdrUint32(2), v1Envelope);      // ENVELOPE_TYPE_TX = 2
  // base64
  let binary = "";
  for (const b of envelope) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ── ChangeTrust (trustline) XDR ─────────────────────────────────────
export interface XlmChangeTrustParams {
  from: string;
  feeStroops: number;
  sequence: bigint;
  asset: { code: string; issuer: string };
  limit?: bigint; // INT64_MAX = enable, 0n = remove trustline
}

export function buildXlmChangeTrustXdr(params: XlmChangeTrustParams): Uint8Array {
  const fromPubKey = strKeyToPublicKey(params.from);
  const sourceAccount = xdrMuxedAccount(fromPubKey);
  const fee = xdrUint32(params.feeStroops);
  const seqNum = xdrInt64(params.sequence);
  const cond = xdrUint32(0); // PRECOND_NONE
  const memo = xdrUint32(0); // MEMO_NONE

  // ChangeTrustOp: line (ChangeTrustAsset, same encoding as Asset for ALPHANUM4/12) + limit (Int64)
  const assetXdr = xdrAsset(params.asset);
  const limit = xdrInt64(params.limit ?? 9223372036854775807n); // INT64_MAX
  const changeTrustOp = concat(assetXdr, limit);

  // Operation: no source override, CHANGE_TRUST = 6
  const operation = concat(xdrUint32(0), xdrUint32(6), changeTrustOp);
  const operations = concat(xdrUint32(1), operation);
  const ext = xdrUint32(0);

  return concat(sourceAccount, fee, seqNum, cond, memo, operations, ext);
}

export async function checkXlmTrustline(
  horizonUrl: string,
  address: string,
  assetCode: string,
  issuer: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${horizonUrl}/accounts/${address}`);
    if (!res.ok) return false;
    const data = await res.json();
    const balances: { asset_type: string; asset_code?: string; asset_issuer?: string }[] = data.balances ?? [];
    return balances.some((b) => b.asset_code === assetCode && b.asset_issuer === issuer);
  } catch {
    return false;
  }
}

// ── Horizon API helpers ──────────────────────────────────────────────
export async function getXlmAccountInfo(horizonUrl: string, address: string): Promise<{ sequence: bigint }> {
  const res = await fetch(`${horizonUrl}/accounts/${address}`);
  if (!res.ok) throw new Error(`Stellar account not found: ${address}`);
  const data = await res.json();
  return { sequence: BigInt(data.sequence) };
}

export async function broadcastXlmTransaction(horizonUrl: string, txBase64: string): Promise<string> {
  const res = await fetch(`${horizonUrl}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `tx=${encodeURIComponent(txBase64)}`,
  });
  const data = await res.json();
  if (!res.ok) {
    const codes = data.extras?.result_codes;
    const msg = codes ? JSON.stringify(codes) : (data.detail || data.title || "Broadcast failed");
    throw new Error(msg);
  }
  return data.hash as string;
}

export async function waitForXlmConfirmation(
  horizonUrl: string,
  txHash: string,
  _onPoll?: () => void,
  maxAttempts = 30,
  intervalMs = 3000,
): Promise<{ confirmed: boolean; ledger?: number }> {
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const res = await fetch(`${horizonUrl}/transactions/${txHash}`);
      if (res.ok) {
        const data = await res.json();
        return { confirmed: data.successful === true, ledger: data.ledger };
      }
    } catch { /* retry */ }
  }
  return { confirmed: false };
}
