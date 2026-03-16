// Shared types and utilities for SendDialog and XlmTrustlineDialog

export interface KeyFile {
  id: string;
  peer: number;
  share: string;
  publicKey: string;
  eddsaShare: string;
  eddsaPublicKey: string;
}

export type FeeLevel = "low" | "medium" | "high";

export const FEE_LABELS: Record<FeeLevel, string> = { low: "Slow", medium: "Standard", high: "Fast" };

export const EVM_FEE_MULTIPLIER: Record<FeeLevel, number> = { low: 0.8, medium: 1.0, high: 1.3 };

export const GAS_LIMIT_NATIVE = 21_000n;
export const GAS_LIMIT_ERC20 = 65_000n;


export type SendStep = "input" | "preview" | "signing" | "result";

export type SigningPhase =
  | "loading-keyshare"
  | "building-tx"
  | "mpc-signing"
  | "broadcasting"
  | "polling";

export interface TxResult {
  status: "success" | "failed" | "pending";
  txHash: string;
  blockNumber?: string | number;
}

export function formatGwei(wei: bigint): string {
  const gwei = Number(wei) / 1e9;
  return gwei < 0.01 ? "< 0.01" : gwei.toFixed(2);
}

export function formatEthFee(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  if (eth === 0) return "0";
  if (eth < 0.000001) return "< 0.000001";
  return eth.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function isValidAmount(val: string, balance: string): { valid: boolean; error?: string } {
  if (!val) return { valid: false };
  const num = parseFloat(val);
  if (isNaN(num) || num <= 0) return { valid: false, error: "Enter a valid amount" };
  if (num > parseFloat(balance)) return { valid: false, error: "Insufficient balance" };
  return { valid: true };
}

export function shortAddrPreview(addr: string): string {
  if (addr.length <= 20) return addr;
  return `${addr.slice(0, 10)}...${addr.slice(-8)}`;
}

export async function getChainId(rpcUrl: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const data = await res.json();
  return parseInt(data.result, 16);
}

export function truncateBalance(val: string, maxDecimals = 8): string {
  if (!val.includes(".")) return val;
  const [int, frac] = val.split(".");
  const trimmed = frac.slice(0, maxDecimals).replace(/0+$/, "");
  return trimmed ? `${int}.${trimmed}` : int;
}
