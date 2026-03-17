import { Core } from "@walletconnect/core";
import { Web3Wallet, type Web3WalletTypes } from "@walletconnect/web3wallet";
import type { SessionTypes, ProposalTypes, PendingRequestTypes } from "@walletconnect/types";

export type WCEvent = "session_proposal" | "session_request" | "session_delete" | "sessions_changed";

type Listener = (...args: any[]) => void;

const EVM_METHODS = [
  "eth_sendTransaction",
  "personal_sign",
  "eth_sign",
  "eth_signTypedData_v4",
];

const EVM_EVENTS = ["chainChanged", "accountsChanged"];

const SOLANA_METHODS = [
  "solana_signTransaction",
  "solana_signAndSendTransaction",
  "solana_signMessage",
];

const SOLANA_EVENTS: string[] = [];

const TRON_METHODS = [
  "tron_signTransaction",
  "tron_signMessage",
];

const TRON_EVENTS: string[] = [];

class WalletConnectService {
  private web3wallet: InstanceType<typeof Web3Wallet> | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private initPromise: Promise<void> | null = null;

  async init(projectId: string): Promise<void> {
    if (this.web3wallet) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init(projectId);
    return this.initPromise;
  }

  private async _init(projectId: string): Promise<void> {
    const core = new Core({ projectId });

    this.web3wallet = await Web3Wallet.init({
      core: core as any,
      metadata: {
        name: "Kexify",
        description: "Self-custodial MPC wallet",
        url: window.location.origin,
        icons: [`${window.location.origin}/vite.svg`],
      },
    });

    this.web3wallet.on("session_proposal", (proposal: Web3WalletTypes.SessionProposal) => {
      this.emit("session_proposal", proposal);
    });

    this.web3wallet.on("session_request", (request: Web3WalletTypes.SessionRequest) => {
      this.emit("session_request", request);
    });

    this.web3wallet.on("session_delete", (event: { id: number; topic: string }) => {
      this.emit("session_delete", event);
      this.emit("sessions_changed");
    });
  }

  async pair(uri: string): Promise<void> {
    if (!this.web3wallet) throw new Error("WalletConnect not initialized");
    await this.web3wallet.pair({ uri });
  }

  async approveSession(
    proposal: ProposalTypes.Struct,
    accounts: string[],
  ): Promise<SessionTypes.Struct> {
    if (!this.web3wallet) throw new Error("WalletConnect not initialized");

    // Build namespaces from the proposal's required + optional namespaces
    const namespaces: Record<string, { accounts: string[]; methods: string[]; events: string[] }> = {};

    const allRequested = {
      ...proposal.requiredNamespaces,
      ...proposal.optionalNamespaces,
    };

    // EVM (eip155)
    const evmAccounts = accounts.filter((a) => a.startsWith("eip155:"));
    if (allRequested.eip155 && evmAccounts.length > 0) {
      const chains = [
        ...(allRequested.eip155.chains || []),
        ...(proposal.requiredNamespaces?.eip155?.chains || []),
        ...(proposal.optionalNamespaces?.eip155?.chains || []),
      ];
      const uniqueChains = [...new Set(chains)];

      namespaces.eip155 = {
        accounts: evmAccounts.length > 0
          ? evmAccounts
          : uniqueChains.flatMap((chain) =>
              evmAccounts.map((a) => a.startsWith("eip155:") ? a : `${chain}:${a}`),
            ),
        methods: EVM_METHODS,
        events: EVM_EVENTS,
      };
    }

    // Solana
    const solanaAccounts = accounts.filter((a) => a.startsWith("solana:"));
    if (allRequested.solana && solanaAccounts.length > 0) {
      namespaces.solana = {
        accounts: solanaAccounts,
        methods: SOLANA_METHODS,
        events: SOLANA_EVENTS,
      };
    }

    // TRON
    const tronAccounts = accounts.filter((a) => a.startsWith("tron:"));
    if (allRequested.tron && tronAccounts.length > 0) {
      namespaces.tron = {
        accounts: tronAccounts,
        methods: TRON_METHODS,
        events: TRON_EVENTS,
      };
    }

    const session = await this.web3wallet.approveSession({
      id: proposal.id,
      namespaces,
    });

    this.emit("sessions_changed");
    return session;
  }

  async rejectSession(proposal: ProposalTypes.Struct): Promise<void> {
    if (!this.web3wallet) throw new Error("WalletConnect not initialized");
    await this.web3wallet.rejectSession({
      id: proposal.id,
      reason: { code: 4001, message: "User rejected" },
    });
  }

  async approveRequest(topic: string, id: number, result: unknown): Promise<void> {
    if (!this.web3wallet) throw new Error("WalletConnect not initialized");
    await this.web3wallet.respondSessionRequest({
      topic,
      response: { id, jsonrpc: "2.0", result },
    });
  }

  async rejectRequest(topic: string, id: number, message = "User rejected"): Promise<void> {
    if (!this.web3wallet) throw new Error("WalletConnect not initialized");
    await this.web3wallet.respondSessionRequest({
      topic,
      response: { id, jsonrpc: "2.0", error: { code: 4001, message } },
    });
  }

  async disconnect(topic: string): Promise<void> {
    if (!this.web3wallet) throw new Error("WalletConnect not initialized");
    await this.web3wallet.disconnectSession({
      topic,
      reason: { code: 6000, message: "User disconnected" },
    });
    this.emit("sessions_changed");
  }

  getSessions(): SessionTypes.Struct[] {
    if (!this.web3wallet) return [];
    return Object.values(this.web3wallet.getActiveSessions());
  }

  getPendingRequests(): PendingRequestTypes.Struct[] {
    if (!this.web3wallet) return [];
    return this.web3wallet.getPendingSessionRequests();
  }

  // Simple event emitter
  on(event: WCEvent, cb: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }

  off(event: WCEvent, cb: Listener) {
    this.listeners.get(event)?.delete(cb);
  }

  private emit(event: WCEvent, ...args: any[]) {
    this.listeners.get(event)?.forEach((cb) => cb(...args));
  }
}

export const wcService = new WalletConnectService();
