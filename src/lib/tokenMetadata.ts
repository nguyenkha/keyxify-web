/**
 * Fetch token metadata (symbol, name, decimals, icon) from chain RPCs.
 * Supports EVM (ERC-20), Solana (SPL), and Stellar (XLM) tokens.
 */

import type { ChainType } from "../shared/types";

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

  // Try TrustWallet icon
  let iconUrl: string | null = null;
  const chainMap: Record<number, string> = {
    1: "ethereum", 56: "smartchain", 137: "polygon", 43114: "avalanchec",
    42161: "arbitrum", 10: "optimism", 8453: "base", 59144: "linea",
    324: "zksync", 534352: "scroll",
  };
  const twChain = evmChainId != null ? chainMap[evmChainId] : null;
  if (twChain) {
    const twUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${twChain}/assets/${contractAddress}/logo.png`;
    try {
      const check = await fetch(twUrl, { method: "HEAD" });
      if (check.ok) iconUrl = twUrl;
    } catch { /* no icon */ }
  }

  return { symbol, name, decimals, contractAddress: addr, iconUrl };
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

  // Try fetching metadata from token list or metaplex
  let symbol = mintAddress.slice(0, 6).toUpperCase();
  let name = `SPL Token ${mintAddress.slice(0, 8)}`;
  let iconUrl: string | null = null;

  // Try Jupiter token list (popular Solana token registry)
  try {
    const jupRes = await fetch(`https://token.jup.ag/strict`);
    if (jupRes.ok) {
      const tokens: { address: string; symbol: string; name: string; logoURI?: string; decimals: number }[] = await jupRes.json();
      const match = tokens.find(t => t.address === mintAddress);
      if (match) {
        symbol = match.symbol;
        name = match.name;
        iconUrl = match.logoURI ?? null;
      }
    }
  } catch { /* fallback to address-based name */ }

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
    default:
      throw new Error(`Custom tokens not supported for ${chainType}`);
  }
}
