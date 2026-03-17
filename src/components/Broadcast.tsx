import { useState, useEffect } from "react";
import { broadcastBtcTx, mempoolApiUrl } from "../lib/chains/btcTx";
import { broadcastTransaction } from "../lib/chains/evmTx";
import { broadcastBchTx, bchApiUrl } from "../lib/chains/bchTx";
import { broadcastLtcTx, ltcApiUrl } from "../lib/chains/ltcTx";
import { broadcastSolanaTransaction } from "../lib/chains/solanaTx";
import { fetchChains } from "../lib/api";
import type { Chain } from "../lib/api";
import { explorerLink } from "../shared/utils";

type BroadcastResult = { txHash: string; explorerUrl: string } | null;

export function Broadcast() {
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
        default:
          throw new Error(`Broadcast not supported for ${selectedChain.type}`);
      }
      setResult({ txHash, explorerUrl: selectedChain.explorerUrl });
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setBroadcasting(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">📡 Broadcast Transaction</h2>
        <p className="text-xs text-text-muted mt-1">Broadcast a raw signed transaction to the network.</p>
      </div>

      {/* Chain selector */}
      <div>
        <label className="block text-xs text-text-muted mb-1.5">Network</label>
        <select
          value={selectedChainId}
          onChange={(e) => { setSelectedChainId(e.target.value); setResult(null); setError(null); }}
          className="w-full bg-surface-secondary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary focus:outline-none focus:border-blue-500 transition-colors"
        >
          <option value="">Select a network...</option>
          {chains.map((c) => (
            <option key={c.id} value={c.id}>{c.displayName}</option>
          ))}
        </select>
      </div>

      {/* Raw tx input */}
      <div>
        <label className="block text-xs text-text-muted mb-1.5">Raw Transaction (hex)</label>
        <textarea
          value={rawTx}
          onChange={(e) => setRawTx(e.target.value)}
          placeholder="Paste signed transaction hex..."
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
        {broadcasting ? "Broadcasting..." : "📡 Broadcast"}
      </button>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          <p className="text-xs text-red-400 font-medium">Broadcast failed</p>
          <p className="text-[11px] text-red-400/70 mt-0.5 break-all">{error}</p>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2.5">
          <p className="text-xs text-green-400 font-medium mb-1">Transaction broadcast</p>
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
