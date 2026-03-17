import { hexToBytes } from "../../shared/utils";
import { tronAddressToHex } from "./tronAdapter";

// ── Types ───────────────────────────────────────────────────────

export interface TronTransaction {
  txID: string;
  raw_data: object;
  raw_data_hex: string;
  visible: boolean;
}

// ── Constants ───────────────────────────────────────────────────

/** Approximate SUN cost for bandwidth (varies by network conditions) */
export const TRON_BANDWIDTH_FEE = 1000n;

// ── Transaction building ────────────────────────────────────────

/**
 * Build a native TRX transfer via TronGrid API.
 */
export async function buildTrxTransfer(
  rpcUrl: string,
  from: string,
  to: string,
  amountSun: bigint,
): Promise<TronTransaction> {
  const res = await fetch(`${rpcUrl}/wallet/createtransaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner_address: from,
      to_address: to,
      amount: Number(amountSun),
      visible: true,
    }),
  });
  const data = await res.json();
  if (!data.txID) {
    throw new Error(data.Error || data.message || "Failed to build TRX transfer");
  }
  return data as TronTransaction;
}

/**
 * ABI-encode transfer(address,uint256) parameters for TRC-20.
 * `to` is a TRON base58 address; we strip the 0x41 prefix and pad to 32 bytes.
 * `amount` is a uint256 padded to 32 bytes.
 */
function encodeTransferParams(to: string, amount: bigint): string {
  // Convert to address to hex, strip 0x41 prefix -> 20-byte address
  const toHex = tronAddressToHex(to);
  const toAddr20 = toHex.slice(2); // strip "41" prefix -> 40 hex chars
  const paddedAddr = toAddr20.padStart(64, "0");
  const paddedAmount = amount.toString(16).padStart(64, "0");
  return paddedAddr + paddedAmount;
}

/**
 * Build a TRC-20 token transfer via TronGrid API.
 */
export async function buildTrc20Transfer(
  rpcUrl: string,
  from: string,
  to: string,
  contractAddress: string,
  amount: bigint,
): Promise<TronTransaction> {
  const parameter = encodeTransferParams(to, amount);

  const res = await fetch(`${rpcUrl}/wallet/triggersmartcontract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner_address: from,
      contract_address: contractAddress,
      function_selector: "transfer(address,uint256)",
      parameter,
      fee_limit: 100000000,
      visible: true,
    }),
  });
  const data = await res.json();
  if (!data.transaction?.txID) {
    throw new Error(data.Error || data.message || "Failed to build TRC-20 transfer");
  }
  return data.transaction as TronTransaction;
}

// ── Signing helpers ─────────────────────────────────────────────

/**
 * Get the hash to sign. For TRON, the txID IS the SHA-256 hash of raw_data protobuf.
 */
export function hashForSigning(tx: TronTransaction): Uint8Array {
  return hexToBytes(tx.txID);
}

/**
 * Assemble a signed transaction with a 65-byte signature (r || s || v).
 */
export function assembleSignedTx(
  tx: TronTransaction,
  r: bigint,
  s: bigint,
  recoveryBit: number,
): { signedTxJson: string; txId: string } {
  const rHex = r.toString(16).padStart(64, "0");
  const sHex = s.toString(16).padStart(64, "0");
  const vHex = recoveryBit.toString(16).padStart(2, "0");
  const signature = rHex + sHex + vHex;

  const signedTx = {
    ...tx,
    signature: [signature],
  };
  return { signedTxJson: JSON.stringify(signedTx), txId: tx.txID };
}

// ── Broadcasting ────────────────────────────────────────────────

/**
 * Broadcast a signed TRON transaction.
 */
export async function broadcastTronTransaction(
  rpcUrl: string,
  signedTxJson: string,
): Promise<string> {
  const res = await fetch(`${rpcUrl}/wallet/broadcasttransaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: signedTxJson,
  });
  const data = await res.json();
  if (!data.result) throw new Error(data.message || "Broadcast failed");
  return data.txid || JSON.parse(signedTxJson).txID;
}

// ── Confirmation ────────────────────────────────────────────────

/**
 * Wait for a TRON transaction to be confirmed on-chain.
 */
export async function waitForTronConfirmation(
  rpcUrl: string,
  txId: string,
  onAttempt?: (attempt: number) => void,
  maxAttempts = 30,
  intervalMs = 3000,
): Promise<{ confirmed: boolean; blockNumber?: number }> {
  for (let i = 1; i <= maxAttempts; i++) {
    onAttempt?.(i);
    await new Promise((r) => setTimeout(r, intervalMs));
    const res = await fetch(`${rpcUrl}/wallet/gettransactioninfobyid`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: txId }),
    });
    const data = await res.json();
    if (data.blockNumber) {
      if (data.receipt?.result && data.receipt.result !== "SUCCESS") {
        throw new Error(`Transaction failed: ${data.receipt.result}`);
      }
      return { confirmed: true, blockNumber: data.blockNumber };
    }
  }
  return { confirmed: false };
}

// ── Fee estimation ──────────────────────────────────────────────

/**
 * Estimate available bandwidth and energy for an account.
 */
export async function estimateTronFee(
  rpcUrl: string,
  from: string,
): Promise<{ bandwidthFree: number; energyFree: number }> {
  const res = await fetch(`${rpcUrl}/wallet/getaccountresource`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: from, visible: true }),
  });
  const data = await res.json();
  return {
    bandwidthFree: (data.freeNetLimit ?? 600) - (data.freeNetUsed ?? 0),
    energyFree: (data.EnergyLimit ?? 0) - (data.EnergyUsed ?? 0),
  };
}

// ── Formatting ──────────────────────────────────────────────────

/**
 * Format a SUN amount to TRX (6 decimals).
 */
export function formatSun(sun: bigint): string {
  if (sun === 0n) return "0";
  const str = sun.toString().padStart(7, "0");
  const intPart = str.slice(0, str.length - 6) || "0";
  const fracPart = str.slice(str.length - 6).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}
