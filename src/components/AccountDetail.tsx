import { useState, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { authHeaders } from "../lib/auth";
import { fetchChains, fetchAssets, fetchSettings, type Chain, type Asset } from "../lib/api";
import { applyChainOverrides } from "../lib/userOverrides";
import { isRecoveryMode, getRecoveryKeys } from "../lib/recovery";
import { getChainAdapter } from "../lib/chains/adapter";
import { publicKeyToBtcLegacyAddress } from "../lib/chains/btcAdapter.js";
import { publicKeyToLtcLegacyAddress } from "../lib/chains/ltcAdapter.js";
import { TokenDetail, type PendingTxFromNavigation } from "./TokenDetail";

import { setCacheTtl } from "../lib/dataCache";
import { apiUrl } from "../lib/apiBase";

export function AccountDetail() {
  const { keyId, chainName, assetSymbol, btcAddrType } = useParams<{
    keyId: string;
    chainName: string;
    assetSymbol: string;
    btcAddrType: string;
  }>();
  const navigate = useNavigate();
  const location = useLocation();
  const pendingTx = (location.state as { pendingTx?: PendingTxFromNavigation } | null)?.pendingTx;

  const [chain, setChain] = useState<Chain | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainAssets, setChainAssets] = useState<Asset[]>([]);
  const [pollInterval, setPollInterval] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!keyId || !chainName || !assetSymbol) {
      setError(true);
      setLoading(false);
      return;
    }

    const keysPromise = isRecoveryMode()
      ? Promise.resolve(getRecoveryKeys())
      : fetch(apiUrl("/api/keys"), { headers: authHeaders() })
          .then((r) => r.json())
          .then((d) => d.keys || []);

    Promise.all([
      keysPromise,
      fetchChains(),
      fetchAssets(),
      fetchSettings(),
    ])
      .then(([keys, rawChains, assets, settings]) => {
        const chains = applyChainOverrides(rawChains);
        if (settings.refresh_interval && typeof settings.refresh_interval === "number" && settings.refresh_interval > 0) {
          const ms = settings.refresh_interval * 1000;
          setPollInterval(ms);
          setCacheTtl(ms);
        }
        const foundChain = chains.find(
          (c: Chain) => c.name.toLowerCase() === chainName.toLowerCase()
        );
        if (!foundChain) {
          setError(true);
          return;
        }

        const chainAssets = assets.filter((a: Asset) => a.chainId === foundChain.id);
        const foundAsset = chainAssets.find(
          (a: Asset) => a.symbol.toLowerCase() === assetSymbol.toLowerCase()
        );
        if (!foundAsset) {
          setError(true);
          return;
        }

        const key = keys.find((k: { id: string; publicKey: string | null; eddsaPublicKey: string; enabled: boolean }) => k.id === keyId);
        if (!key?.publicKey) {
          setError(true);
          return;
        }

        const pubKeyHex = key.publicKey;

        const adapter = getChainAdapter(foundChain.type);
        let addr: string;
        if (foundChain.type === "solana" || foundChain.type === "xlm") {
          if (!key.eddsaPublicKey) {
            setError(true);
            return;
          }
          addr = adapter.deriveAddress(key.eddsaPublicKey);
        } else if (foundChain.type === "btc" && btcAddrType === "legacy") {
          const testnet = foundChain.name.toLowerCase().includes("testnet");
          addr = publicKeyToBtcLegacyAddress(pubKeyHex, testnet);
        } else if (foundChain.type === "ltc" && btcAddrType === "legacy") {
          const testnet = foundChain.name.toLowerCase().includes("testnet");
          addr = publicKeyToLtcLegacyAddress(pubKeyHex, testnet);
        } else {
          const testnet = foundChain.name.toLowerCase().includes("testnet");
          addr = adapter.deriveAddress(pubKeyHex, { testnet });
        }

        setChain(foundChain);
        setAsset(foundAsset);
        setAddress(addr);
        setChainAssets(chainAssets);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [keyId, chainName, assetSymbol, btcAddrType]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="text-xs text-text-muted">Loading...</div>
      </div>
    );
  }

  if (error || !chain || !asset || !address || !keyId) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <p className="text-sm text-text-secondary mb-2">Account not found</p>
        <button
          onClick={() => navigate("/accounts")}
          className="text-xs text-blue-400 hover:text-blue-300"
        >
          Back to accounts
        </button>
      </div>
    );
  }

  return (
    <TokenDetail
      keyId={keyId}
      address={address}
      chain={chain}
      asset={asset}
      chainAssets={chainAssets}
      onBack={() => navigate("/accounts")}
      pollInterval={pollInterval}
      pendingTx={pendingTx}
    />
  );
}
