import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { wcService } from "../lib/walletconnect";
import { notify } from "../lib/notify";
import type { SessionTypes, ProposalTypes } from "@walletconnect/types";
import type { Web3WalletTypes } from "@walletconnect/web3wallet";

export interface PendingRequest {
  topic: string;
  id: number;
  method: string;
  params: any;
  chainId: string;
}

interface WCContextValue {
  initialized: boolean;
  sessions: SessionTypes.Struct[];
  pendingProposal: Web3WalletTypes.SessionProposal | null;
  requestQueue: PendingRequest[];
  pair: (uri: string) => Promise<void>;
  disconnect: (topic: string) => Promise<void>;
  approveSession: (proposal: ProposalTypes.Struct, accounts: string[]) => Promise<void>;
  rejectSession: (proposal: ProposalTypes.Struct) => Promise<void>;
  approveRequest: (topic: string, id: number, result: unknown) => Promise<void>;
  rejectRequest: (topic: string, id: number) => Promise<void>;
  dismissProposal: () => void;
  shiftRequest: () => void;
}

const WCContext = createContext<WCContextValue | null>(null);

export function useWalletConnect() {
  const ctx = useContext(WCContext);
  if (!ctx) throw new Error("useWalletConnect must be used within WalletConnectProvider");
  return ctx;
}

export function WalletConnectProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [initialized, setInitialized] = useState(false);
  const [sessions, setSessions] = useState<SessionTypes.Struct[]>([]);
  const [pendingProposal, setPendingProposal] = useState<Web3WalletTypes.SessionProposal | null>(null);
  const [requestQueue, setRequestQueue] = useState<PendingRequest[]>([]);

  // Initialize WalletConnect
  useEffect(() => {
    const projectId = import.meta.env.VITE_WC_PROJECT_ID;
    if (!projectId) return;

    wcService.init(projectId).then(() => {
      setInitialized(true);
      setSessions(wcService.getSessions());
    });
  }, []);

  // Subscribe to events
  useEffect(() => {
    if (!initialized) return;

    const onProposal = (proposal: Web3WalletTypes.SessionProposal) => {
      setPendingProposal(proposal);
      const dappName = proposal.params.proposer.metadata.name || "dApp";
      notify({ title: t("notify.wcProposal"), body: dappName });
    };

    const onRequest = (request: Web3WalletTypes.SessionRequest) => {
      const { topic, id, params } = request;
      const session = wcService.getSessions().find((s) => s.topic === topic);
      const dappName = session?.peer.metadata.name || "dApp";
      notify({ title: t("notify.wcRequest"), body: `${dappName}: ${params.request.method}` });
      // For Solana/TRON methods, inject the account address from the session
      // since their params don't always include the signer address
      let reqParams = params.request.params;
      if (params.request.method.startsWith("solana_") && params.chainId) {
        const session = wcService.getSessions().find((s) => s.topic === topic);
        if (session?.namespaces?.solana?.accounts) {
          const match = session.namespaces.solana.accounts.find((a) =>
            a.startsWith(params.chainId),
          );
          if (match) {
            const address = match.split(":").slice(2).join(":");
            reqParams = { ...reqParams, account: address };
          }
        }
      }
      if (params.request.method.startsWith("tron_") && params.chainId) {
        const session = wcService.getSessions().find((s) => s.topic === topic);
        if (session?.namespaces?.tron?.accounts) {
          const match = session.namespaces.tron.accounts.find((a) =>
            a.startsWith(params.chainId),
          );
          if (match) {
            const address = match.split(":").slice(2).join(":");
            reqParams = { ...reqParams, account: address };
          }
        }
      }
      setRequestQueue((q) => [
        ...q,
        {
          topic,
          id,
          method: params.request.method,
          params: reqParams,
          chainId: params.chainId,
        },
      ]);
    };

    const onSessionsChanged = () => {
      setSessions(wcService.getSessions());
    };

    const onDelete = () => {
      setSessions(wcService.getSessions());
    };

    wcService.on("session_proposal", onProposal);
    wcService.on("session_request", onRequest);
    wcService.on("sessions_changed", onSessionsChanged);
    wcService.on("session_delete", onDelete);

    return () => {
      wcService.off("session_proposal", onProposal);
      wcService.off("session_request", onRequest);
      wcService.off("sessions_changed", onSessionsChanged);
      wcService.off("session_delete", onDelete);
    };
  }, [initialized]);

  const pair = useCallback(async (uri: string) => {
    await wcService.pair(uri);
  }, []);

  const disconnect = useCallback(async (topic: string) => {
    await wcService.disconnect(topic);
    setSessions(wcService.getSessions());
  }, []);

  const approveSession = useCallback(async (proposal: ProposalTypes.Struct, accounts: string[]) => {
    await wcService.approveSession(proposal, accounts);
    setPendingProposal(null);
    setSessions(wcService.getSessions());
  }, []);

  const rejectSession = useCallback(async (proposal: ProposalTypes.Struct) => {
    await wcService.rejectSession(proposal);
    setPendingProposal(null);
  }, []);

  const approveRequest = useCallback(async (topic: string, id: number, result: unknown) => {
    await wcService.approveRequest(topic, id, result);
  }, []);

  const rejectRequest = useCallback(async (topic: string, id: number) => {
    await wcService.rejectRequest(topic, id);
  }, []);

  const dismissProposal = useCallback(() => setPendingProposal(null), []);

  const shiftRequest = useCallback(() => {
    setRequestQueue((q) => q.slice(1));
  }, []);

  return (
    <WCContext.Provider
      value={{
        initialized,
        sessions,
        pendingProposal,
        requestQueue,
        pair,
        disconnect,
        approveSession,
        rejectSession,
        approveRequest,
        rejectRequest,
        dismissProposal,
        shiftRequest,
      }}
    >
      {children}
    </WCContext.Provider>
  );
}
