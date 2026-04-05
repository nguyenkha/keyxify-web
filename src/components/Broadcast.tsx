import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ErrorBox } from "./ui";
import { broadcastBtcTx, mempoolApiUrl } from "../lib/chains/btcTx";
import { broadcastTransaction } from "../lib/chains/evmTx";
import { broadcastBchTx, bchApiUrl } from "../lib/chains/bchTx";
import { broadcastLtcTx, ltcApiUrl } from "../lib/chains/ltcTx";
import { broadcastSolanaTransaction } from "../lib/chains/solanaTx";
import { broadcastTronTransaction } from "../lib/chains/tronTx";
import { fetchChains } from "../lib/api";
import type { Chain } from "../lib/api";
import { explorerLink } from "../shared/utils";
import { Radio } from "lucide-react";

type BroadcastResult = { txHash: string; explorerUrl: string } | null;

export function Broadcast() {
  const { t } = useTranslation();
  const [rawTx, setRawTx] = useState("");
  const [chains, setChains] = useState<Chain[]>([]);
  const [selectedChainId, setSelectedChainId] = useState("");
  const [broadcasting, setBroadcasting] = useState(false);
  const [result, setResult] = useState<BroadcastResult>(null);
  const [error, setError] = useState<string | null>(null);

  // Load chains on mount
  useEffect(() => {
    fetchChains().then(setChains);
  }, []);

  const selectedChain = chains.find((c) => c.id === selectedChainId);

  async function handleBroadcast() {
    if (!rawTx.trim() || !selectedChain) return;
    setBroadcasting(true);
    setError(null);
    setResult(null);
    try {
      let txHash: string;
      const hex = rawTx.trim();
      switch (selectedChain.type) {
        case "btc": {
          const api = mempoolApiUrl(selectedChain.explorerUrl);
          txHash = await broadcastBtcTx(hex, api);
          break;
        }
        case "ltc": {
          const api = ltcApiUrl(selectedChain.explorerUrl);
          txHash = await broadcastLtcTx(hex, api);
          break;
        }
        case "bch": {
          const api = bchApiUrl(selectedChain.explorerUrl);
          txHash = await broadcastBchTx(hex, api);
          break;
        }
        case "evm": {
          txHash = await broadcastTransaction(selectedChain.rpcUrl, hex);
          break;
        }
        case "solana": {
          txHash = await broadcastSolanaTransaction(hex, selectedChain.rpcUrl);
          break;
        }
        case "tron": {
          txHash = await broadcastTronTransaction(selectedChain.rpcUrl, hex);
          break;
        }
        default:
          throw new Error(`Broadcast not supported for ${selectedChain.type}`);
      }
      setResult({ txHash, explorerUrl: selectedChain.explorerUrl });
    } catch (err: unknown) {
      setError((err as { message?: string })?.message || String(err));
    } finally {
      setBroadcasting(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2"><Radio className="w-5 h-5" />{t("broadcast.title")}</h2>
        <p className="text-xs text-text-muted mt-1">{t("broadcast.desc")}</p>
      </div>

      {/* Chain selector */}
      <div>
        <label className="block text-xs text-text-muted mb-1.5">{t("broadcast.network")}</label>
        <select
          value={selectedChainId}
          onChange={(e) => { setSelectedChainId(e.target.value); setResult(null); setError(null); }}
          className="w-full bg-surface-secondary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary focus:outline-none focus:border-blue-500 transition-colors"
        >
          <option value="">{t("broadcast.selectNetwork")}</option>
          {chains.map((c) => (
            <option key={c.id} value={c.id}>{c.displayName}</option>
          ))}
        </select>
      </div>

      {/* Raw tx input */}
      <div>
        <label className="block text-xs text-text-muted mb-1.5">
          {t("broadcast.rawTx")} {selectedChain?.type === "tron" ? t("broadcast.rawTxJson") : t("broadcast.rawTxHex")}
        </label>
        <textarea
          value={rawTx}
          onChange={(e) => setRawTx(e.target.value)}
          placeholder={selectedChain?.type === "tron" ? t("broadcast.pasteTxJson") : t("broadcast.pasteTxHex")}
          rows={6}
          className="w-full bg-surface-secondary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors resize-none"
        />
      </div>

      {/* Broadcast button */}
      <button
        onClick={handleBroadcast}
        disabled={!rawTx.trim() || !selectedChain || broadcasting}
        className="w-full py-2.5 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {broadcasting ? t("broadcast.broadcasting") : <><Radio className="w-4 h-4 inline-block align-[-2px] mr-1" />{t("broadcast.broadcastButton")}</>}
      </button>

      {/* Error */}
      {error && (
        <ErrorBox>
          <span className="font-medium">{t("broadcast.broadcastFailed")}</span>
          <span className="block text-[11px] opacity-70 mt-0.5 break-all">{error}</span>
        </ErrorBox>
      )}

      {/* Result */}
      {result && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2.5">
          <p className="text-xs text-green-400 font-medium mb-1">{t("broadcast.txBroadcast")}</p>
          <a
            href={explorerLink(result.explorerUrl, `/tx/${result.txHash}`)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-blue-400 hover:text-blue-300 font-mono break-all transition-colors"
          >
            {result.txHash} ↗
          </a>
        </div>
      )}
    </div>
  );
}
