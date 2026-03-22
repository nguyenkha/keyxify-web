export type { Chain, Asset, ChainType, Settings } from "../shared/types";
import type { Chain, Asset, Settings } from "../shared/types";
import { apiUrl } from "./apiBase";
import { getCustomTokens } from "./userOverrides";
import staticConfig from "../config.json";

export async function fetchChains(): Promise<Chain[]> {
  try {
    const res = await fetch(apiUrl("/api/chains"));
    if (!res.ok) return staticConfig.chains as Chain[];
    const data = await res.json();
    return data.chains;
  } catch {
    return staticConfig.chains as Chain[];
  }
}

export async function fetchAssets(chainId?: string): Promise<Asset[]> {
  let serverAssets: Asset[];
  try {
    const url = chainId ? apiUrl(`/api/chains/${chainId}/assets`) : apiUrl("/api/chains/assets");
    const res = await fetch(url);
    if (!res.ok) serverAssets = chainId ? (staticConfig.assets as Asset[]).filter(a => a.chainId === chainId) : staticConfig.assets as Asset[];
    else serverAssets = (await res.json()).assets;
  } catch {
    serverAssets = chainId ? (staticConfig.assets as Asset[]).filter(a => a.chainId === chainId) : staticConfig.assets as Asset[];
  }

  // Merge custom tokens from user overrides
  const custom = getCustomTokens()
    .filter(t => !chainId || t.chain_id === chainId)
    .map(t => ({
      id: t.id,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      contractAddress: t.contract_address,
      isNative: false,
      iconUrl: t.icon_url,
      chainId: t.chain_id,
    } as Asset));

  // Dedupe: custom tokens with same contractAddress+chainId as server assets are skipped
  const serverContracts = new Set(
    serverAssets
      .filter(a => a.contractAddress)
      .map(a => `${a.chainId}:${a.contractAddress!.toLowerCase()}`)
  );
  const uniqueCustom = custom.filter(
    c => c.contractAddress && !serverContracts.has(`${c.chainId}:${c.contractAddress.toLowerCase()}`)
  );

  return [...serverAssets, ...uniqueCustom];
}

export async function fetchSettings(): Promise<Settings> {
  try {
    const res = await fetch(apiUrl("/api/settings"));
    if (!res.ok) return staticConfig.preferences as Settings;
    return res.json();
  } catch {
    return staticConfig.preferences as Settings;
  }
}
