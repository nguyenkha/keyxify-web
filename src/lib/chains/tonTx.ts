/**
 * TON transaction building and broadcasting for MPC signing flow.
 * Uses @ton/core for BOC serialization (wallet v4r2 contract).
 */

import { beginCell, Cell, Address, SendMode, storeMessageRelaxed, internal, toNano } from "@ton/core";
import { hexToBytes } from "../../shared/utils";

// ── Wallet V4R2 constants (same as in tonAdapter.ts) ────────────

const WALLET_V4R2_CODE = Cell.fromBoc(
  Buffer.from(
    "te6cckECFAEAAtQAART/APSkE/S88sgLAQIBIAIPAgFIAwYC5tAB0NMDIXGwkl8E4CLXScEgkl8E4ALTHyGCEHBsdWe9IoIQZHN0cr2wkl8F4AP6QDAg+kQByMoHy//J0O1E0IEBQNch9AQwXIEBCPQKb6Exs5JfB+AF0z/IJYIQcGx1Z7qSODDjDQOCEGRzdHK6kl8G4w0EBQB4AfoA9AQw+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAGAIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6AhPLassfyz/JgED7AJJfA+ICASAHDgIBIAgNAgFYCQoAPbKd+1E0IEBQNch9AQwAsjKB8v/ydABgQEI9ApvoTGACASALDAAZrc52omhAIGuQ64X/wAAZrx32omhAEGuQ64WPwAARuMl+1E0NcLH4AFm9JCtvaiaECAoGuQ+gIYRw1AgIR6STfSmRDOaQPp/5g3gSgBt4EBSJhxWfMYQE+PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAkpMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMAAcADkTDjDQOkyMsfEssfy/8QERITAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQBfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVAj45Sg=",
    "base64",
  ),
)[0];

const WALLET_V4R2_SUBWALLET_ID = 698983191;

// ── Ed25519 key extraction ──────────────────────────────────────

function extractEd25519Key(pubKeyBytes: Uint8Array): Buffer {
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
  return Buffer.from(key32);
}

/** Build the state init for wallet V4R2 (needed for first tx from uninitialized wallet) */
function buildWalletStateInit(pubKey: Buffer): Cell {
  const data = beginCell()
    .storeUint(0, 32) // seqno
    .storeUint(WALLET_V4R2_SUBWALLET_ID, 32)
    .storeBuffer(pubKey, 32)
    .storeBit(false) // empty plugins dictionary
    .endCell();

  return beginCell()
    .storeBit(false) // split_depth
    .storeBit(false) // special
    .storeBit(true)  // code present
    .storeRef(WALLET_V4R2_CODE)
    .storeBit(true)  // data present
    .storeRef(data)
    .storeBit(false) // library
    .endCell();
}

// ── Account state check ─────────────────────────────────────────

/** Check if a TON wallet is initialized (contract deployed) */
export async function isTonWalletInitialized(rpcUrl: string, address: string): Promise<boolean> {
  const url = new URL(`${rpcUrl}/getAddressInformation`);
  url.searchParams.set("address", address);

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url.toString());
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) return false;
    const data = await res.json();
    if (!data.ok) return false;
    return data.result?.state === "active";
  }
  return false; // Assume uninitialized on persistent rate limit
}

// ── Seqno fetching ──────────────────────────────────────────────

export async function getTonSeqno(rpcUrl: string, address: string): Promise<number> {
  // toncenter v2 runGetMethod requires POST
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${rpcUrl}/runGetMethod`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, method: "seqno", stack: [] }),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) return 0; // Uninitialized wallet → seqno 0
    const data = await res.json();
    if (!data.ok) return 0;
    const stack = data.result?.stack;
    if (!stack || stack.length === 0) return 0;
    return parseInt(stack[0][1], 16) || 0;
  }
  throw new Error("TON API rate limited. Please try again in a few seconds.");
}

// ── Transaction building ────────────────────────────────────────

export interface TonTransferParams {
  eddsaPubKeyHex: string;
  to: string;
  amount: string; // in TON (e.g. "1.5")
  seqno: number;
  memo?: string;
}

/** Build wallet v4r2 signing body wrapping an internal message */
function buildWalletV4R2Body(internalMsg: ReturnType<typeof internal>, seqno: number): {
  hash: Uint8Array;
  unsignedBody: string;
} {
  const validUntil = Math.floor(Date.now() / 1000) + 300; // 5 min expiry
  const msgCell = beginCell().store(storeMessageRelaxed(internalMsg)).endCell();
  const body = beginCell()
    .storeUint(WALLET_V4R2_SUBWALLET_ID, 32)
    .storeUint(validUntil, 32)
    .storeUint(seqno, 32)
    .storeUint(0, 8) // simple send op
    .storeUint(SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS, 8)
    .storeRef(msgCell)
    .endCell();

  return { hash: new Uint8Array(body.hash()), unsignedBody: body.toBoc().toString("base64") };
}

/**
 * Build the unsigned message body for a native TON transfer.
 * Returns the cell hash (to be signed) and the serialized body.
 */
export function buildTonTransferMessage(params: TonTransferParams): {
  hash: Uint8Array;
  unsignedBody: string; // base64 BOC
} {
  const { to, amount, seqno, memo } = params;

  const internalMsg = internal({
    to: Address.parse(to),
    value: toNano(amount),
    bounce: false,
    body: memo ? beginCell().storeUint(0, 32).storeStringTail(memo).endCell() : undefined,
  });

  return buildWalletV4R2Body(internalMsg, seqno);
}

// ── Jetton (TEP-74) transfer ────────────────────────────────────

/** TEP-74 transfer op code */
const JETTON_TRANSFER_OP = 0xf8a7ea5;

/** TON attached to jetton transfer for gas + notification (0.05 TON) */
export const JETTON_FORWARD_TON = toNano("0.05");

export interface TonJettonTransferParams {
  eddsaPubKeyHex: string;
  senderAddress: string;       // sender's wallet address (for response_destination)
  jettonWalletAddress: string; // sender's jetton wallet contract
  to: string;                  // recipient's wallet address
  jettonAmount: bigint;        // amount in base units
  seqno: number;
  forwardTonAmount?: bigint;   // TON for notification to recipient (default: 1 nanoton)
}

/**
 * Build unsigned message body for a Jetton (TEP-74) transfer.
 * Sends an internal message to the sender's jetton wallet with the transfer payload.
 */
export function buildTonJettonTransferMessage(params: TonJettonTransferParams): {
  hash: Uint8Array;
  unsignedBody: string;
} {
  const { senderAddress, jettonWalletAddress, to, jettonAmount, seqno, forwardTonAmount } = params;

  // TEP-74 transfer body
  const transferBody = beginCell()
    .storeUint(JETTON_TRANSFER_OP, 32) // op: transfer
    .storeUint(0, 64)                  // query_id
    .storeCoins(jettonAmount)          // amount of jettons to transfer
    .storeAddress(Address.parse(to))   // destination (recipient)
    .storeAddress(Address.parse(senderAddress)) // response_destination (excess TON returns here)
    .storeBit(false)                   // custom_payload: null
    .storeCoins(forwardTonAmount ?? 1n) // forward_ton_amount (1 nanoton for notification)
    .storeBit(false)                   // forward_payload: empty
    .endCell();

  // Internal message to the sender's jetton wallet, carrying enough TON for gas
  const internalMsg = internal({
    to: Address.parse(jettonWalletAddress),
    value: JETTON_FORWARD_TON,
    bounce: true,
    body: transferBody,
  });

  return buildWalletV4R2Body(internalMsg, seqno);
}

/**
 * Resolve the sender's jetton wallet address via toncenter v3 API.
 */
export async function resolveJettonWalletAddress(
  rpcUrl: string,
  jettonMasterAddress: string,
  ownerAddress: string,
): Promise<string> {
  const baseUrl = rpcUrl.replace(/\/api\/v2\/?$/, "");
  const url = new URL(`${baseUrl}/api/v3/jetton/wallets`);
  url.searchParams.set("owner_address", ownerAddress);
  url.searchParams.set("jetton_address", jettonMasterAddress);
  url.searchParams.set("limit", "1");

  let res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url.toString());
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    const errText = await res?.text().catch(() => "") ?? "";
    throw new Error(`Failed to resolve jetton wallet address: ${res?.status} ${errText}`);
  }
  const data = await res.json();

  const wallet = data.jetton_wallets?.[0];
  if (!wallet) throw new Error("Jetton wallet not found. You may need to receive tokens first.");

  // Get user-friendly address from address_book, fallback to raw
  const rawAddr = wallet.address as string;
  const friendly = data.address_book?.[rawAddr]?.user_friendly as string | undefined;

  return friendly || rawAddr;
}

/**
 * Assemble the signed external message (ready for broadcast).
 * Combines the signature with the unsigned body and wraps in an external message.
 * If eddsaPubKeyHex is provided and includeStateInit is true, includes the wallet
 * state init for deploying uninitialized wallets on first transaction.
 */
export function assembleTonSignedMessage(
  walletAddress: string,
  unsignedBodyBase64: string,
  signature: Uint8Array,
  options?: { eddsaPubKeyHex?: string; includeStateInit?: boolean },
): string {
  const addr = Address.parse(walletAddress);
  const body = Cell.fromBoc(Buffer.from(unsignedBodyBase64, "base64"))[0];

  // Signed body = signature(512 bits) + original body
  const signedBody = beginCell()
    .storeBuffer(Buffer.from(signature), 64)
    .storeSlice(body.asSlice())
    .endCell();

  // Build state init if this is the first tx from an uninitialized wallet
  const needsStateInit = options?.includeStateInit && options?.eddsaPubKeyHex;
  let stateInit: Cell | null = null;
  if (needsStateInit) {
    const pubKey = extractEd25519Key(hexToBytes(options!.eddsaPubKeyHex!));
    stateInit = buildWalletStateInit(pubKey);
  }

  // External message to the wallet contract
  // TL-B: init:(Maybe (Either StateInit ^StateInit)) body:(Either X ^X)
  const ext = beginCell()
    .storeUint(0b10, 2) // ext_in_msg_info tag
    .storeUint(0, 2) // src: addr_none
    .storeAddress(addr)
    .storeCoins(0); // import_fee
  if (stateInit) {
    ext.storeBit(true)  // init: present
       .storeBit(true)  // init: as ref
       .storeRef(stateInit);
  } else {
    ext.storeBit(false); // init: absent
  }
  ext.storeBit(true)     // body: as ref
     .storeRef(signedBody);
  const extCell = ext.endCell();

  return extCell.toBoc().toString("base64");
}

// ── Broadcasting ────────────────────────────────────────────────

export async function broadcastTonTransaction(rpcUrl: string, bocBase64: string): Promise<string> {
  // Retry on rate limit
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${rpcUrl}/sendBoc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boc: bocBase64 }),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const data = await res.json();
    if (!data.ok) throw new Error(`TON broadcast failed: ${data.error || res.statusText}`);
    // Compute tx hash from the BOC
    const cell = Cell.fromBoc(Buffer.from(bocBase64, "base64"))[0];
    return cell.hash().toString("hex");
  }
  throw new Error("TON broadcast rate limited. Please try again.");
}

/** Poll for TON transaction confirmation via seqno increment */
export async function waitForTonConfirmation(
  rpcUrl: string,
  address: string,
  expectedSeqno: number,
  _onStatus: () => void,
  maxAttempts = 30,
  intervalMs = 3000,
): Promise<{ confirmed: boolean }> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const currentSeqno = await getTonSeqno(rpcUrl, address);
    if (currentSeqno > expectedSeqno) return { confirmed: true };
  }
  return { confirmed: false };
}
