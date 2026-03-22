/**
 * Fetch token metadata (symbol, name, decimals, icon) from chain RPCs.
 * Supports EVM (ERC-20), Solana (SPL), Stellar (XLM), and TRON (TRC-20) tokens.
 */

import type { ChainType } from "../shared/types";
import { keccak_256 } from "@noble/hashes/sha3";

export interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
  contractAddress: string;
  iconUrl: string | null;
}

// ── EVM (ERC-20) ───────────────────────────────────────────────

const ERC20_SYMBOL = "0x95d89b41";    // symbol()
const ERC20_NAME = "0x06fdde03";      // name()
const ERC20_DECIMALS = "0x313ce567";  // decimals()

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "eth_call failed");
  return json.result;
}

function decodeString(hex: string): string {
  if (!hex || hex === "0x") return "";
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Try ABI-encoded string (offset + length + data)
  if (h.length >= 128) {
    const len = parseInt(h.slice(64, 128), 16);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = parseInt(h.substr(128 + i * 2, 2), 16);
    return new TextDecoder().decode(bytes);
  }
  // Fallback: bytes32
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  return new TextDecoder().decode(bytes).replace(/\0+$/, "");
}

export async function fetchEvmTokenMetadata(contractAddress: string, rpcUrl: string, evmChainId: number | null): Promise<TokenMetadata> {
  const addr = contractAddress.toLowerCase();
  const [symbolHex, nameHex, decimalsHex] = await Promise.all([
    ethCall(rpcUrl, addr, ERC20_SYMBOL),
    ethCall(rpcUrl, addr, ERC20_NAME),
    ethCall(rpcUrl, addr, ERC20_DECIMALS),
  ]);

  const symbol = decodeString(symbolHex);
  const name = decodeString(nameHex);
  const decimals = parseInt(decimalsHex, 16);

  if (!symbol) throw new Error("Contract does not implement ERC-20 symbol()");

  const iconUrl = await findEvmTokenIcon(addr, symbol, evmChainId);

  return { symbol, name, decimals, contractAddress: addr, iconUrl };
}

// ── Icon resolution (multiple sources) ─────────────────────────

const TW_CHAIN_MAP: Record<number, string> = {
  1: "ethereum", 56: "smartchain", 137: "polygon", 43114: "avalanchec",
  42161: "arbitrum", 10: "optimism", 8453: "base", 59144: "linea",
  324: "zksync", 534352: "scroll",
};

/** Try to find a token icon from multiple sources */
async function findEvmTokenIcon(contractAddress: string, symbol: string, evmChainId: number | null): Promise<string | null> {
  // Checksummed address for TrustWallet (they use checksummed paths)
  const checksummed = toChecksumAddress(contractAddress);

  // 1. TrustWallet assets
  const twChain = evmChainId != null ? TW_CHAIN_MAP[evmChainId] : null;
  if (twChain) {
    const twUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${twChain}/assets/${checksummed}/logo.png`;
    try {
      const r = await fetch(twUrl, { method: "HEAD" });
      if (r.ok) return twUrl;
    } catch { /* next */ }
  }

  // 2. CoinGecko by contract address (no API key needed for this endpoint)
  if (evmChainId != null) {
    const cgPlatform: Record<number, string> = {
      1: "ethereum", 56: "binance-smart-chain", 137: "polygon-pos", 43114: "avalanche",
      42161: "arbitrum-one", 10: "optimistic-ethereum", 8453: "base", 59144: "linea",
      324: "zksync", 534352: "scroll",
    };
    const platform = cgPlatform[evmChainId];
    if (platform) {
      try {
        const r = await fetch(`https://api.coingecko.com/api/v3/coins/${platform}/contract/${contractAddress.toLowerCase()}`);
        if (r.ok) {
          const data = await r.json();
          const img = data.image?.small || data.image?.thumb;
          if (img) return img;
        }
      } catch { /* next */ }
    }
  }

  // 3. CoinGecko search by symbol
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`);
    if (r.ok) {
      const data = await r.json();
      const coin = data.coins?.find((c: { symbol?: string; thumb?: string }) => c.symbol?.toUpperCase() === symbol.toUpperCase());
      if (coin?.thumb && !coin.thumb.includes("missing")) return coin.thumb;
    }
  } catch { /* no icon */ }

  return null;
}

/** EIP-55 checksum address */
function toChecksumAddress(addr: string): string {
  const lower = addr.toLowerCase().replace("0x", "");
  const hash = keccak_256(new TextEncoder().encode(lower));
  const hashHex = Array.from(hash).map(b => b.toString(16).padStart(2, "0")).join("");
  let checksummed = "0x";
  for (let i = 0; i < lower.length; i++) {
    checksummed += parseInt(hashHex[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return checksummed;
}

// ── Solana (SPL) ───────────────────────────────────────────────

export async function fetchSolanaTokenMetadata(mintAddress: string, rpcUrl: string): Promise<TokenMetadata> {
  // Get mint account info for decimals
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getAccountInfo",
      params: [mintAddress, { encoding: "jsonParsed" }],
    }),
  });
  const data = await res.json();
  const parsed = data.result?.value?.data?.parsed;
  if (!parsed || parsed.type !== "mint") throw new Error("Not a valid SPL token mint");

  const decimals = parsed.info?.decimals ?? 0;

  let symbol = mintAddress.slice(0, 6).toUpperCase();
  let name = `SPL Token ${mintAddress.slice(0, 8)}`;
  let iconUrl: string | null = null;

  // 1. Jupiter single-token API
  try {
    const jupRes = await fetch(`https://token.jup.ag/strict`);
    if (jupRes.ok) {
      const tokens: { address: string; symbol: string; name: string; logoURI?: string }[] = await jupRes.json();
      const match = tokens.find(t => t.address === mintAddress);
      if (match) {
        symbol = match.symbol;
        name = match.name;
        iconUrl = match.logoURI ?? null;
      }
    }
  } catch { /* next */ }

  // 2. CoinGecko by contract (Solana platform)
  if (!iconUrl) {
    try {
      const r = await fetch(`https://api.coingecko.com/api/v3/coins/solana/contract/${mintAddress}`);
      if (r.ok) {
        const data = await r.json();
        if (data.symbol) symbol = data.symbol.toUpperCase();
        if (data.name) name = data.name;
        const img = data.image?.small || data.image?.thumb;
        if (img) iconUrl = img;
      }
    } catch { /* no icon */ }
  }

  return { symbol, name, decimals, contractAddress: mintAddress, iconUrl };
}

// ── Stellar (XLM) ──────────────────────────────────────────────

export async function fetchXlmTokenMetadata(assetCode: string, issuer: string, horizonUrl: string): Promise<TokenMetadata> {
  const res = await fetch(`${horizonUrl}/assets?asset_code=${assetCode}&asset_issuer=${issuer}&limit=1`);
  if (!res.ok) throw new Error("Failed to fetch XLM asset info");
  const data = await res.json();
  const records = data._embedded?.records;

  if (!records || records.length === 0) throw new Error(`Asset ${assetCode} not found on Stellar`);

  const record = records[0];
  return {
    symbol: assetCode,
    name: record.asset_code || assetCode,
    decimals: 7, // Stellar assets always use 7 decimal places (stroops)
    contractAddress: `${assetCode}:${issuer}`,
    iconUrl: record._links?.toml?.href ? null : null, // No standard icon field
  };
}

// ── TRON (TRC-20) ───────────────────────────────────────────────

async function tronConstantCall(rpcUrl: string, ownerAddress: string, contractAddress: string, functionSelector: string, parameter: string): Promise<string> {
  const res = await fetch(`${rpcUrl}/wallet/triggerconstantcontract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner_address: ownerAddress,
      contract_address: contractAddress,
      function_selector: functionSelector,
      parameter,
      visible: true,
    }),
  });
  const data = await res.json();
  const result = data.constant_result;
  if (!result || result.length === 0) throw new Error(`${functionSelector} call failed`);
  return result[0];
}

export async function fetchTronTokenMetadata(contractAddress: string, rpcUrl: string): Promise<TokenMetadata> {
  // Use a zero address as caller for constant calls
  const caller = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

  const [symbolHex, nameHex, decimalsHex] = await Promise.all([
    tronConstantCall(rpcUrl, caller, contractAddress, "symbol()", ""),
    tronConstantCall(rpcUrl, caller, contractAddress, "name()", ""),
    tronConstantCall(rpcUrl, caller, contractAddress, "decimals()", ""),
  ]);

  const symbol = decodeString("0x" + symbolHex);
  const name = decodeString("0x" + nameHex);
  const decimals = parseInt(decimalsHex, 16);

  if (!symbol) throw new Error("Contract does not implement TRC-20 symbol()");

  const iconUrl = await findTronTokenIcon(contractAddress, symbol);

  return { symbol, name, decimals, contractAddress, iconUrl };
}

async function findTronTokenIcon(contractAddress: string, symbol: string): Promise<string | null> {
  // 1. TrustWallet assets (TRON chain)
  try {
    const twUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/tron/assets/${contractAddress}/logo.png`;
    const r = await fetch(twUrl, { method: "HEAD" });
    if (r.ok) return twUrl;
  } catch { /* next */ }

  // 2. CoinGecko by contract address (tron platform)
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/tron/contract/${contractAddress}`);
    if (r.ok) {
      const data = await r.json();
      const img = data.image?.small || data.image?.thumb;
      if (img) return img;
    }
  } catch { /* next */ }

  // 3. CoinGecko search by symbol
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`);
    if (r.ok) {
      const data = await r.json();
      const coin = data.coins?.find((c: { symbol?: string; thumb?: string }) => c.symbol?.toUpperCase() === symbol.toUpperCase());
      if (coin?.thumb && !coin.thumb.includes("missing")) return coin.thumb;
    }
  } catch { /* no icon */ }

  return null;
}

// ── Algorand (ASA) ──────────────────────────────────────────────

export async function fetchAlgoTokenMetadata(assetId: string, rpcUrl: string): Promise<TokenMetadata> {
  const res = await fetch(`${rpcUrl}/v2/assets/${assetId}`);
  if (!res.ok) throw new Error(`Failed to fetch ASA #${assetId}`);
  const data = await res.json();
  const params = data.params;
  if (!params) throw new Error(`ASA #${assetId} not found`);

  const symbol = params["unit-name"] || `ASA${assetId.slice(0, 4)}`;
  const name = params.name || symbol;
  const decimals = params.decimals ?? 0;

  return { symbol, name, decimals, contractAddress: assetId, iconUrl: null };
}

// ── TON (Jetton) ──────────────────────────────────────────────

async function fetchTonJettonMetadata(
  contractAddress: string,
  rpcUrl: string,
): Promise<TokenMetadata> {
  // Use toncenter v3 API to get Jetton master info
  const baseUrl = rpcUrl.replace(/\/api\/v2\/?$/, "");
  const v3Url = new URL(`${baseUrl}/api/v3/jetton/masters`);
  v3Url.searchParams.set("address", contractAddress);
  v3Url.searchParams.set("limit", "1");

  const res = await fetch(v3Url.toString());
  if (!res.ok) throw new Error("Failed to query Jetton master contract");
  const data = await res.json();
  const jetton = data.jetton_masters?.[0];
  if (!jetton) throw new Error("Jetton not found. Verify the contract address.");

  const content = jetton.jetton_content || {};
  const decimals = parseInt(content.decimals || "9", 10);

  // Extract enriched metadata from toncenter's metadata.token_info
  const rawAddr = jetton.address as string | undefined;
  const tokenInfo = rawAddr
    ? (data.metadata?.[rawAddr]?.token_info?.[0] as
        { name?: string; symbol?: string; image?: string } | undefined)
    : undefined;

  // Resolve image URL (prefer token_info, then on-chain content)
  const resolveImage = (url?: string | null): string | null => {
    if (!url) return null;
    return url.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${url.slice(7)}` : url;
  };

  // If we have a URI, fetch full metadata from it
  if (content.uri) {
    try {
      const fetchUrl = content.uri.startsWith("ipfs://")
        ? `https://ipfs.io/ipfs/${content.uri.slice(7)}`
        : content.uri;
      const metaRes = await fetch(fetchUrl, { signal: AbortSignal.timeout(8000) });
      if (metaRes.ok) {
        const meta = await metaRes.json();
        return {
          symbol: meta.symbol || tokenInfo?.symbol || content.symbol || "???",
          name: meta.name || tokenInfo?.name || content.name || "Unknown Jetton",
          decimals: meta.decimals ?? decimals,
          contractAddress,
          iconUrl: resolveImage(meta.image) || resolveImage(tokenInfo?.image) || resolveImage(content.image),
        };
      }
    } catch { /* fall through to token_info / on-chain content */ }
  }

  // Use token_info (enriched metadata) or on-chain content fields
  return {
    symbol: tokenInfo?.symbol || content.symbol || "???",
    name: tokenInfo?.name || content.name || "Unknown Jetton",
    decimals,
    contractAddress,
    iconUrl: resolveImage(tokenInfo?.image) || resolveImage(content.image),
  };
}

// ── Unified fetcher ────────────────────────────────────────────

export async function fetchTokenMetadata(
  chainType: ChainType,
  contractAddress: string,
  rpcUrl: string,
  evmChainId?: number | null,
): Promise<TokenMetadata> {
  switch (chainType) {
    case "evm":
      return fetchEvmTokenMetadata(contractAddress, rpcUrl, evmChainId ?? null);
    case "solana":
      return fetchSolanaTokenMetadata(contractAddress, rpcUrl);
    case "xlm": {
      // XLM contract address format: "CODE:ISSUER"
      const [code, issuer] = contractAddress.split(":");
      if (!code || !issuer) throw new Error("XLM token format: CODE:ISSUER_ADDRESS");
      const horizonUrl = rpcUrl.replace(/\/+$/, "");
      return fetchXlmTokenMetadata(code, issuer, horizonUrl);
    }
    case "tron":
      return fetchTronTokenMetadata(contractAddress, rpcUrl);
    case "algo":
      return fetchAlgoTokenMetadata(contractAddress, rpcUrl);
    case "ton":
      return fetchTonJettonMetadata(contractAddress, rpcUrl);
    default:
      throw new Error(`Custom tokens not supported for ${chainType}`);
  }
}
