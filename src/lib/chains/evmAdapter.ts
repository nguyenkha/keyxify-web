import type { Asset, ChainAdapter, BalanceResult, Transaction } from "../../shared/types";
import { ethers } from "ethers";
import { hexToBytes, bytesToHex } from "../../shared/utils";

/**
 * Extract raw SEC1 public key hex from a DER SubjectPublicKeyInfo hex string.
 */
function extractPublicKeyFromDER(pubKeyHex: string): string {
  const der = hexToBytes(pubKeyHex);

  // Find BIT STRING tag (0x03) followed by unused-bits byte (0x00)
  for (let i = 0; i < der.length - 2; i++) {
    if (der[i] === 0x03 && der[i + 2] === 0x00) {
      const len = der[i + 1];
      // Skip tag + length + unused-bits byte
      const raw = der.slice(i + 3, i + 2 + len);
      return bytesToHex(raw);
    }
  }

  // Fallback: assume it's already raw SEC1
  return pubKeyHex;
}

const BALANCE_OF_SELECTOR = "0x70a08231";

function formatBalance(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";
  const str = raw.toString().padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const fracPart = str.slice(str.length - decimals).replace(/0+$/, "");
  const fmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart ? `${fmt}.${fracPart}` : fmt;
}

function formatTxValue(raw: string, decimals: number): string {
  if (!raw || raw === "0") return "0";
  const str = raw.padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const fracPart = str.slice(str.length - decimals).replace(/0+$/, "");
  const fmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart ? `${fmt}.${fracPart}` : fmt;
}

async function ethJsonRpc(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  return data.result;
}

// ── Blockscout API mapping ──

const BLOCKSCOUT_MAP: Record<string, string> = {
  "etherscan.io": "https://eth.blockscout.com",
  "sepolia.etherscan.io": "https://eth-sepolia.blockscout.com",
  "basescan.org": "https://base.blockscout.com",
  "sepolia.basescan.org": "https://base-sepolia.blockscout.com",
};

function blockscoutApiUrl(explorerUrl: string): string | null {
  try {
    const host = new URL(explorerUrl).hostname;
    return BLOCKSCOUT_MAP[host] || null;
  } catch {
    return null;
  }
}

const PAGE_SIZE = 10;

type CursorMap = Map<number, Record<string, string | number>>;
const cursorCache = new Map<string, CursorMap>();

function cacheKey(address: string, chainId: string, assetId: string): string {
  return `${address}:${chainId}:${assetId}`;
}

export const evmAdapter: ChainAdapter = {
  type: "evm",
  signingAlgorithm: "ecdsa",

  deriveAddress(pubKeyHex: string): string {
    const rawKey = extractPublicKeyFromDER(pubKeyHex);
    return ethers.computeAddress("0x" + rawKey);
  },

  isValidAddress(address: string): boolean {
    return ethers.isAddress(address);
  },

  async fetchNativeBalance(address, chain, nativeAsset): Promise<BalanceResult | null> {
    try {
      const hex = await ethJsonRpc(chain.rpcUrl, "eth_getBalance", [address, "latest"]);
      const balance = hex ? BigInt(hex) : 0n;
      return {
        asset: nativeAsset,
        chain,
        balance: balance.toString(),
        formatted: formatBalance(balance, nativeAsset.decimals),
      };
    } catch {
      return null;
    }
  },

  async fetchTokenBalances(address, chain, tokenAssets): Promise<BalanceResult[]> {
    if (!chain.rpcUrl) return [];
    const promises = tokenAssets.map(async (asset) => {
      try {
        const paddedAddr = address.slice(2).padStart(64, "0");
        const data = BALANCE_OF_SELECTOR + paddedAddr;
        const hex = await ethJsonRpc(chain.rpcUrl, "eth_call", [
          { to: asset.contractAddress, data },
          "latest",
        ]);
        const balance = hex && hex !== "0x" ? BigInt(hex) : 0n;
        if (balance === 0n) return null;
        return {
          asset,
          chain,
          balance: balance.toString(),
          formatted: formatBalance(balance, asset.decimals),
        };
      } catch {
        return null;
      }
    });
    const settled = await Promise.all(promises);
    return settled.filter((r): r is BalanceResult => r !== null);
  },

  async fetchTransactions(address, chain, asset, page) {
    const apiBase = blockscoutApiUrl(chain.explorerUrl);
    if (!apiBase) return { transactions: [], hasMore: false };

    const key = cacheKey(address, chain.id, asset.id);

    let url: string;
    if (asset.isNative) {
      url = `${apiBase}/api/v2/addresses/${address}/transactions`;
    } else {
      url = `${apiBase}/api/v2/addresses/${address}/token-transfers?type=ERC-20&token=${asset.contractAddress}`;
    }

    if (page > 1) {
      const cursors = cursorCache.get(key);
      const cursor = cursors?.get(page);
      if (!cursor) return { transactions: [], hasMore: false };
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(cursor)) {
        params.set(k, String(v));
      }
      url += (url.includes("?") ? "&" : "?") + params.toString();
    }

    const res = await fetch(url);
    if (!res.ok) return { transactions: [], hasMore: false };
    const data = await res.json();

    const items: Record<string, unknown>[] = data.items || [];
    const addrLower = address.toLowerCase();

    let txs: Transaction[];
    if (asset.isNative) {
      // Filter out ERC-20 transfer calls — they belong in the token transfers list
      const ERC20_TRANSFER_SELECTORS = ["0xa9059cbb", "0x23b872dd"]; // transfer, transferFrom
      txs = items
        .filter((tx) => {
          const rawInput = tx.raw_input as string | undefined;
          if (!rawInput) return true;
          const sel = rawInput.slice(0, 10).toLowerCase();
          return !ERC20_TRANSFER_SELECTORS.includes(sel);
        })
        .slice(0, PAGE_SIZE)
        .map((tx) => parseNativeTx(tx, addrLower, asset));
    } else {
      txs = items.slice(0, PAGE_SIZE).map((tx) => parseTokenTransfer(tx, addrLower, asset));
    }

    const hasMore = !!data.next_page_params && items.length > 0;
    if (hasMore) {
      if (!cursorCache.has(key)) cursorCache.set(key, new Map());
      cursorCache.get(key)!.set(page + 1, data.next_page_params);
    }

    return { transactions: txs, hasMore };
  },
};

function parseNativeTx(
  tx: Record<string, unknown>,
  addrLower: string,
  asset: Asset
): Transaction {
  const from = ((tx.from as Record<string, unknown>)?.hash as string) || "";
  const to = ((tx.to as Record<string, unknown>)?.hash as string) || "";
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const direction: "in" | "out" | "self" =
    fromLower === addrLower && toLower === addrLower
      ? "self"
      : fromLower === addrLower
        ? "out"
        : "in";

  const value = (tx.value as string) || "0";
  const tsStr = tx.timestamp as string | null;
  const timestamp = tsStr ? Math.floor(new Date(tsStr).getTime() / 1000) : Math.floor(Date.now() / 1000);
  const confirmations = (tx.confirmations as number) || 0;

  // Detect tx type from Blockscout tx_types array and raw input
  const txTypes = tx.tx_types as string[] | undefined;
  const rawInput = tx.raw_input as string | undefined;
  const isDeployment = txTypes?.includes("contract_creation") || (!to && rawInput && rawInput.length > 2);
  const createdContract = ((tx.created_contract as Record<string, unknown>)?.hash as string) || undefined;
  const isContractCall = !isDeployment && (
    (txTypes && txTypes.includes("contract_call")) ||
    (rawInput != null && rawInput !== "0x" && rawInput.length > 2)
  );
  const isApprove = rawInput != null && rawInput.toLowerCase().startsWith("0x095ea7b3");

  return {
    hash: tx.hash as string,
    from,
    to: createdContract || to,
    value,
    formatted: formatTxValue(value, asset.decimals),
    symbol: asset.symbol,
    timestamp,
    direction,
    confirmed: confirmations > 0,
    failed: (tx.status as string) === "error" || (tx.result as string) === "error",
    ...(isDeployment ? { isDeployment: true } : {}),
    ...(createdContract ? { createdContract } : {}),
    ...(isContractCall ? { isContractCall: true } : {}),
    ...(isApprove ? { isApprove: true } : {}),
  };
}

/** Fetch all ERC-20 token transfers for an address (for unified activity view) */
export async function fetchAllTokenTransfers(
  address: string,
  explorerUrl: string,
): Promise<Transaction[]> {
  const apiBase = blockscoutApiUrl(explorerUrl);
  if (!apiBase) return [];
  try {
    const res = await fetch(`${apiBase}/api/v2/addresses/${address}/token-transfers?type=ERC-20`);
    if (!res.ok) return [];
    const data = await res.json();
    const items: Record<string, unknown>[] = data.items || [];
    const addrLower = address.toLowerCase();
    return items.slice(0, PAGE_SIZE).map((tx) => parseAnyTokenTransfer(tx, addrLower));
  } catch {
    return [];
  }
}

/** Parse a token transfer using token info from the response itself */
function parseAnyTokenTransfer(
  tx: Record<string, unknown>,
  addrLower: string,
): Transaction {
  const from = ((tx.from as Record<string, unknown>)?.hash as string) || "";
  const to = ((tx.to as Record<string, unknown>)?.hash as string) || "";
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const direction: "in" | "out" | "self" =
    fromLower === addrLower && toLower === addrLower
      ? "self"
      : fromLower === addrLower
        ? "out"
        : "in";

  const total = tx.total as Record<string, string> | null;
  const value = total?.value || "0";
  const token = tx.token as Record<string, unknown> | null;
  const decimals = total?.decimals ? parseInt(total.decimals, 10) : (token?.decimals as number) ?? 18;
  const symbol = (token?.symbol as string) || "???";
  const tsStr = tx.timestamp as string | null;
  const timestamp = tsStr ? Math.floor(new Date(tsStr).getTime() / 1000) : Math.floor(Date.now() / 1000);

  return {
    hash: (tx.transaction_hash as string) || "",
    from,
    to,
    value,
    formatted: formatTxValue(value, decimals),
    symbol,
    timestamp,
    direction,
    confirmed: true,
  };
}

function parseTokenTransfer(
  tx: Record<string, unknown>,
  addrLower: string,
  asset: Asset
): Transaction {
  const from = ((tx.from as Record<string, unknown>)?.hash as string) || "";
  const to = ((tx.to as Record<string, unknown>)?.hash as string) || "";
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const direction: "in" | "out" | "self" =
    fromLower === addrLower && toLower === addrLower
      ? "self"
      : fromLower === addrLower
        ? "out"
        : "in";

  const total = tx.total as Record<string, string> | null;
  const value = total?.value || "0";
  const decimals = total?.decimals ? parseInt(total.decimals, 10) : asset.decimals;
  const tsStr = tx.timestamp as string | null;
  const timestamp = tsStr ? Math.floor(new Date(tsStr).getTime() / 1000) : Math.floor(Date.now() / 1000);

  return {
    hash: (tx.transaction_hash as string) || "",
    from,
    to,
    value,
    formatted: formatTxValue(value, decimals),
    symbol: asset.symbol,
    timestamp,
    direction,
    confirmed: true,
  };
}
