import type { Chain, Asset, KeyShare, ChainType } from "../shared/types";
import { getChainAdapter } from "./chains/adapter";
import { publicKeyToBtcLegacyAddress } from "./chains/btcAdapter";

export interface AccountRow {
  keyId: string;
  address: string;
  addressType: ChainType;
  btcAddrType?: "segwit" | "legacy";
  label: string;
  chain: Chain;
  assets: Asset[];
}

export function buildAccountRows(
  keys: KeyShare[],
  chains: Chain[],
  assets: Asset[]
): AccountRow[] {
  const rows: AccountRow[] = [];
  const evmChains = chains.filter((c) => c.type === "evm");
  const btcChains = chains.filter((c) => c.type === "btc");
  const solanaChains = chains.filter((c) => c.type === "solana");
  const xrpChains = chains.filter((c) => c.type === "xrp");

  for (const key of keys) {
    if (!key.publicKey || !key.enabled) continue;
    // publicKey is stored as hex (SEC1 uncompressed)
    const pubKeyHex = key.publicKey;

    const evmAdapter = getChainAdapter("evm");
    if (evmChains.length > 0) {
      const evmAddr = evmAdapter.deriveAddress(pubKeyHex);
      for (const chain of evmChains) {
        const chainAssets = assets.filter((a) => a.chainId === chain.id);
        rows.push({
          keyId: key.id,
          address: evmAddr,
          addressType: "evm",
          label: chain.displayName,
          chain,
          assets: chainAssets,
        });
      }
    }

    const btcAdapter = getChainAdapter("btc");
    for (const chain of btcChains) {
      const testnet = chain.displayName.toLowerCase().includes("testnet");
      const chainAssets = assets.filter((a) => a.chainId === chain.id);
      rows.push({
        keyId: key.id,
        address: btcAdapter.deriveAddress(pubKeyHex, { testnet }),
        addressType: "btc",
        btcAddrType: "segwit",
        label: `${chain.displayName} (SegWit)`,
        chain,
        assets: chainAssets,
      });
      rows.push({
        keyId: key.id,
        address: publicKeyToBtcLegacyAddress(pubKeyHex, testnet),
        addressType: "btc",
        btcAddrType: "legacy",
        label: `${chain.displayName} (Legacy)`,
        chain,
        assets: chainAssets,
      });
    }

    if (solanaChains.length > 0) {
      const solanaAdapter = getChainAdapter("solana");
      let solanaAddr: string;
      try {
        solanaAddr = solanaAdapter.deriveAddress(key.eddsaPublicKey);
      } catch {
        continue;
      }
      for (const chain of solanaChains) {
        const chainAssets = assets.filter((a) => a.chainId === chain.id);
        rows.push({
          keyId: key.id,
          address: solanaAddr,
          addressType: "solana",
          label: chain.displayName,
          chain,
          assets: chainAssets,
        });
      }
    }

    const bchChains = chains.filter((c) => c.type === "bch");
    if (bchChains.length > 0) {
      const bchAdapt = getChainAdapter("bch");
      for (const chain of bchChains) {
        const testnet = chain.displayName.toLowerCase().includes("testnet");
        const chainAssets = assets.filter((a) => a.chainId === chain.id);
        rows.push({
          keyId: key.id,
          address: bchAdapt.deriveAddress(pubKeyHex, { testnet }),
          addressType: "bch",
          label: chain.displayName,
          chain,
          assets: chainAssets,
        });
      }
    }

    if (xrpChains.length > 0) {
      const xrpAdapt = getChainAdapter("xrp");
      const xrpAddr = xrpAdapt.deriveAddress(pubKeyHex);
      for (const chain of xrpChains) {
        const chainAssets = assets.filter((a) => a.chainId === chain.id);
        rows.push({
          keyId: key.id,
          address: xrpAddr,
          addressType: "xrp",
          label: chain.displayName,
          chain,
          assets: chainAssets,
        });
      }
    }

    const xlmChains = chains.filter((c) => c.type === "xlm");
    if (xlmChains.length > 0) {
      const xlmAdapt = getChainAdapter("xlm");
      const xlmAddr = xlmAdapt.deriveAddress(key.eddsaPublicKey);
      for (const chain of xlmChains) {
        const chainAssets = assets.filter((a) => a.chainId === chain.id);
        rows.push({
          keyId: key.id,
          address: xlmAddr,
          addressType: "xlm",
          label: chain.displayName,
          chain,
          assets: chainAssets,
        });
      }
    }
  }
  return rows;
}
