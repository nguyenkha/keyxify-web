import { useState, useEffect } from "react";
import type { Web3WalletTypes } from "@walletconnect/web3wallet";
import type { KeyShare, Chain } from "../shared/types";
import { authHeaders } from "../lib/auth";
import { apiUrl } from "../lib/apiBase";
import { fetchChains } from "../lib/api";
import { applyChainOverrides } from "../lib/userOverrides";
import { getChainAdapter } from "../lib/chains/adapter";

import { fetchPasskeys } from "../lib/passkey";
import { PasskeyGate } from "./PasskeyGate";
import { PasskeyChallenge } from "./PasskeyChallenge";
import { isRecoveryMode, getRecoveryKeys } from "../lib/recovery";

interface Props {
  proposal: Web3WalletTypes.SessionProposal;
  onApprove: (accounts: string[]) => void;
  onReject: () => void;
}

const KNOWN_EVM_CHAINS: Record<number, string> = {
  1: "Ethereum", 5: "Goerli", 10: "Optimism", 56: "BNB Chain", 100: "Gnosis",
  137: "Polygon", 250: "Fantom", 324: "zkSync Era", 8453: "Base",
  42161: "Arbitrum", 42220: "Celo", 43114: "Avalanche", 59144: "Linea",
  11155111: "Sepolia", 421614: "Arbitrum Sepolia", 84532: "Base Sepolia",
};

const KNOWN_SOLANA_CHAINS: Record<string, string> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z": "Solana Testnet",
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana Devnet",
};

interface WCAccount {
  keyId: string;
  name: string;
  address: string;
  selected: boolean;
  type: "evm" | "solana";
}

export function WCSessionProposal({ proposal, onApprove, onReject }: Props) {
  const [accounts, setAccounts] = useState<WCAccount[]>([]);
  const [chains, setChains] = useState<Chain[]>([]);
  const [loading, setLoading] = useState(true);

  // Passkey guard state
  const [passkeyGuard, setPasskeyGuard] = useState<"idle" | "gate" | "challenge">("idle");

  const { proposer } = proposal.params;

  // Get requested chains per namespace
  const requestedEvmChains = [
    ...(proposal.params.requiredNamespaces?.eip155?.chains || []),
    ...(proposal.params.optionalNamespaces?.eip155?.chains || []),
  ];
  const uniqueEvmChains = [...new Set(requestedEvmChains)];

  const requestedSolanaChains = [
    ...(proposal.params.requiredNamespaces?.solana?.chains || []),
    ...(proposal.params.optionalNamespaces?.solana?.chains || []),
  ];
  const uniqueSolanaChains = [...new Set(requestedSolanaChains)];

  const wantsSolana = uniqueSolanaChains.length > 0 ||
    !!proposal.params.requiredNamespaces?.solana ||
    !!proposal.params.optionalNamespaces?.solana;
  const wantsEvm = uniqueEvmChains.length > 0 ||
    !!proposal.params.requiredNamespaces?.eip155 ||
    !!proposal.params.optionalNamespaces?.eip155;

  useEffect(() => {
    const keysPromise = isRecoveryMode()
      ? Promise.resolve(getRecoveryKeys())
      : fetch(apiUrl("/api/keys"), { headers: authHeaders() })
          .then((r) => r.json())
          .then((d) => (d.keys || []) as KeyShare[]);
    Promise.all([keysPromise, fetchChains()]).then(([keys, rawChains]) => {
      const allChains = applyChainOverrides(rawChains);
      setChains(allChains);

      const allAccounts: WCAccount[] = [];

      // EVM accounts
      if (wantsEvm) {
        const evmAdapter = getChainAdapter("evm");
        for (const key of keys) {
          if (!key.publicKey || !key.enabled) continue;
          const address = evmAdapter.deriveAddress(key.publicKey);
          allAccounts.push({
            keyId: key.id,
            name: key.name || `Key ${key.id.slice(0, 8)}`,
            address,
            selected: true,
            type: "evm",
          });
        }
      }

      // Solana accounts
      if (wantsSolana) {
        const solanaAdapter = getChainAdapter("solana");
        for (const key of keys) {
          if (!key.eddsaPublicKey || !key.enabled) continue;
          const address = solanaAdapter.deriveAddress(key.eddsaPublicKey);
          allAccounts.push({
            keyId: key.id,
            name: key.name || `Key ${key.id.slice(0, 8)}`,
            address,
            selected: true,
            type: "solana",
          });
        }
      }

      setAccounts(allAccounts);
      setLoading(false);
    });
  }, []);

  function toggleAccount(idx: number) {
    setAccounts((prev) =>
      prev.map((a, i) => (i === idx ? { ...a, selected: !a.selected } : a)),
    );
  }

  function doApprove() {
    const selected = accounts.filter((a) => a.selected);
    if (selected.length === 0) return;

    const accountStrings: string[] = [];

    // EVM accounts
    const selectedEvm = selected.filter((a) => a.type === "evm");
    if (selectedEvm.length > 0) {
      const evmChainIds = chains
        .filter((c) => c.evmChainId != null)
        .map((c) => c.evmChainId!);
      const chainIds = uniqueEvmChains.length > 0
        ? uniqueEvmChains.map((c) => parseInt(c.split(":")[1]))
        : evmChainIds;
      for (const a of selectedEvm) {
        for (const id of chainIds) {
          accountStrings.push(`eip155:${id}:${a.address}`);
        }
      }
    }

    // Solana accounts
    const selectedSolana = selected.filter((a) => a.type === "solana");
    if (selectedSolana.length > 0) {
      const solanaChainIds = uniqueSolanaChains.length > 0
        ? uniqueSolanaChains.map((c) => c.split(":")[1])
        : chains.filter((c) => c.type === "solana").map((c) => c.name);
      // Default to mainnet if no chains specified
      const chainIds = solanaChainIds.length > 0 ? solanaChainIds : ["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"];
      for (const a of selectedSolana) {
        for (const id of chainIds) {
          accountStrings.push(`solana:${id}:${a.address}`);
        }
      }
    }

    onApprove(accountStrings);
  }

  async function handleApprove() {
    if (isRecoveryMode()) {
      doApprove();
      return;
    }
    try {
      const list = await fetchPasskeys();
      if (list.length === 0) {
        setPasskeyGuard("gate");
      } else {
        setPasskeyGuard("challenge");
      }
    } catch {
      doApprove();
    }
  }

  const shortAddr = (addr: string) =>
    `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const allRequestedChains = [...uniqueEvmChains, ...uniqueSolanaChains];
  const evmAccounts = accounts.filter((a) => a.type === "evm");
  const solanaAccounts = accounts.filter((a) => a.type === "solana");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onReject} />
      <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary shrink-0">
          <h3 className="text-sm font-semibold text-text-primary">Session Request</h3>
          <button
            onClick={onReject}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4 overflow-y-auto flex-1 min-h-0">
          {/* dApp info */}
          <div className="flex items-center gap-3">
            {proposer.metadata.icons?.[0] ? (
              <img
                src={proposer.metadata.icons[0]}
                alt={proposer.metadata.name}
                className="w-12 h-12 rounded-xl bg-surface-tertiary"
              />
            ) : (
              <div className="w-12 h-12 rounded-xl bg-surface-tertiary flex items-center justify-center">
                <span className="text-lg font-bold text-text-muted">
                  {proposer.metadata.name?.charAt(0)?.toUpperCase() || "?"}
                </span>
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">{proposer.metadata.name}</p>
              <p className="text-[11px] text-text-muted truncate">{proposer.metadata.url}</p>
            </div>
          </div>

          {/* Requested chains */}
          {allRequestedChains.length > 0 && (
            <div>
              <p className="text-[11px] text-text-muted mb-1.5">Requested chains</p>
              <div className="flex flex-wrap gap-1">
                {uniqueEvmChains.map((chain) => {
                  const chainId = parseInt(chain.split(":")[1]);
                  const matched = chains.find((c) => c.evmChainId === chainId);
                  return (
                    <span key={chain} className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400">
                      {matched?.displayName || KNOWN_EVM_CHAINS[chainId] || `Chain ${chainId}`}
                    </span>
                  );
                })}
                {uniqueSolanaChains.map((chain) => {
                  const genesisHash = chain.split(":")[1];
                  const matched = chains.find((c) => c.type === "solana" && c.name === genesisHash);
                  return (
                    <span key={chain} className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400">
                      {matched?.displayName || KNOWN_SOLANA_CHAINS[genesisHash] || `Solana (${genesisHash.slice(0, 8)})`}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Account selection */}
          <div>
            <p className="text-[11px] text-text-muted mb-1.5">Select accounts to connect</p>
            {loading ? (
              <div className="h-12 bg-surface-tertiary rounded-lg animate-pulse" />
            ) : accounts.length === 0 ? (
              <p className="text-xs text-text-muted">No accounts available.</p>
            ) : (
              <div className="space-y-1">
                {evmAccounts.length > 0 && solanaAccounts.length > 0 && (
                  <p className="text-[10px] text-text-muted uppercase tracking-wider pt-1">EVM</p>
                )}
                {evmAccounts.map((account) => {
                  const idx = accounts.indexOf(account);
                  return (
                    <button
                      key={`evm-${account.keyId}`}
                      onClick={() => toggleAccount(idx)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                        account.selected
                          ? "bg-blue-500/10 border border-blue-500/30"
                          : "bg-surface-tertiary border border-transparent hover:border-border-secondary"
                      }`}
                    >
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                        account.selected ? "bg-blue-500 border-blue-500" : "border-border-secondary"
                      }`}>
                        {account.selected && (
                          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-text-primary">{account.name}</p>
                        <p className="text-[10px] text-text-muted font-mono">{shortAddr(account.address)}</p>
                      </div>
                    </button>
                  );
                })}

                {evmAccounts.length > 0 && solanaAccounts.length > 0 && (
                  <p className="text-[10px] text-text-muted uppercase tracking-wider pt-2">Solana</p>
                )}
                {solanaAccounts.map((account) => {
                  const idx = accounts.indexOf(account);
                  return (
                    <button
                      key={`sol-${account.keyId}`}
                      onClick={() => toggleAccount(idx)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                        account.selected
                          ? "bg-purple-500/10 border border-purple-500/30"
                          : "bg-surface-tertiary border border-transparent hover:border-border-secondary"
                      }`}
                    >
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                        account.selected ? "bg-purple-500 border-purple-500" : "border-border-secondary"
                      }`}>
                        {account.selected && (
                          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-text-primary">{account.name}</p>
                        <p className="text-[10px] text-text-muted font-mono">{shortAddr(account.address)}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border-secondary flex gap-3 shrink-0">
          <button
            onClick={onReject}
            className="flex-1 px-4 py-2.5 rounded-lg text-xs font-medium bg-surface-tertiary text-text-secondary hover:bg-border-primary transition-colors"
          >
            Reject
          </button>
          <button
            onClick={handleApprove}
            disabled={loading || accounts.filter((a) => a.selected).length === 0}
            className="flex-1 px-4 py-2.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
          >
            Approve
          </button>
        </div>
      </div>

      {/* Passkey guard dialogs */}
      {passkeyGuard === "gate" && (
        <PasskeyGate
          onRegistered={() => {
            setPasskeyGuard("idle");
            doApprove();
          }}
          onCancel={() => setPasskeyGuard("idle")}
        />
      )}
      {passkeyGuard === "challenge" && (
        <PasskeyChallenge
          autoStart
          withPrf
          onAuthenticated={() => {
            setPasskeyGuard("idle");
            doApprove();
          }}
          onCancel={() => setPasskeyGuard("idle")}
        />
      )}
    </div>
  );
}
