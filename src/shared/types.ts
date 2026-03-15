// ── Chain types ──

export type ChainType = "evm" | "btc" | "bch" | "solana" | "xrp" | "xlm";
export type SigningAlgorithm = "ecdsa" | "eddsa";

export interface Chain {
  id: string;
  name: string; // unique identifier e.g. "ETHEREUM", "BITCOIN"
  displayName: string; // human-readable e.g. "Ethereum", "Bitcoin"
  type: ChainType;
  coinType: number; // BIP44 coin type (0=BTC, 60=ETH, 501=SOL)
  evmChainId: number | null; // EVM chain ID (1=ETH, 11155111=Sepolia), null for non-EVM
  rpcUrl: string;
  explorerUrl: string;
  iconUrl: string | null;
}

export interface Asset {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  contractAddress: string | null;
  isNative: boolean;
  iconUrl: string | null;
  chainId: string;
}

// ── Chain adapter interface ──
// Implement this per chain type. Frontend uses it to eliminate if/else branching.

export interface BalanceResult {
  asset: Asset;
  chain: Chain;
  balance: string;     // raw bigint as string
  formatted: string;   // human-readable with decimals
}

export interface Transaction {
  hash: string;
  from: string;
  to: string;
  value: string;       // raw value in smallest unit
  formatted: string;   // human-readable
  symbol: string;
  timestamp: number;   // unix seconds
  direction: "in" | "out" | "self";
  confirmed: boolean;
  failed?: boolean;
  isContractCall?: boolean;
  isApprove?: boolean;
  label?: string;  // override direction label (e.g. "Enabled USDC")
}

export interface ChainAdapter {
  /** Which chain type this adapter handles */
  type: ChainType;

  /** Which MPC signing algorithm this chain uses */
  signingAlgorithm: SigningAlgorithm;

  /** Derive on-chain address from public key hex (DER-encoded ECDSA or raw EdDSA) */
  deriveAddress(pubKeyHex: string, opts?: { testnet?: boolean }): string;

  /** Validate an address string */
  isValidAddress(address: string): boolean;

  /** Fetch native coin balance */
  fetchNativeBalance(address: string, chain: Chain, nativeAsset: Asset): Promise<BalanceResult | null>;

  /** Fetch token balances (ERC-20, SPL, etc.) */
  fetchTokenBalances(address: string, chain: Chain, tokenAssets: Asset[]): Promise<BalanceResult[]>;

  /** Fetch transaction history */
  fetchTransactions(
    address: string,
    chain: Chain,
    asset: Asset,
    page: number,
  ): Promise<{ transactions: Transaction[]; hasMore: boolean }>;
}

// ── Transaction verification (shared between frontend and backend) ──

export interface TransferInfo {
  to: string;
  amount: string;           // base units as string
  nativeSymbol?: string;     // "ETH", "BTC", "SOL", "XRP" for native transfers
  contractAddress?: string;  // token contract (ERC-20) or mint (SPL) for token transfers
  destinationTag?: number;   // XRP destination tag (uint32)
}

export interface TxVerifyResult {
  chainType: ChainType;
  description: Record<string, string | number>;
  transfer?: TransferInfo;
  extra?: Record<string, unknown>;
}

/** Per-chain transaction verifier: validates sighash and extracts transfer info */
export type ChainVerifier = (
  body: Record<string, unknown>,
  hash: Uint8Array,
  fromAddress: string,
) => TxVerifyResult;

// ── Key types ──

export interface KeyShare {
  id: string;
  name: string | null;
  publicKey: string | null;
  eddsaPublicKey: string;
  enabled: boolean;
  enableAt: string | null;
  createdAt: string;
  selfCustodyAt: string | null;
  hasClientBackup: boolean;
}

// ── Policy types ──

export interface PolicyRuleBody {
  priority: number;
  type: "raw_message" | "transfer" | "contract_call";
  effect: "allow" | "block";
  asset: string | null;
  amountMax: string | null;
  usdMax: string | null;
  toAddress: string | null;
}

export interface PolicyVersion {
  id: string;
  keyShareId: string;
  rules: PolicyRuleBody[];
  status: "pending" | "active" | "cancelled";
  createdAt: string;
  effectiveAt: string | null;
}

// ── Settings ──

export interface Settings {
  default_chains?: string[];
  refresh_interval?: number; // seconds, default 60
  [key: string]: unknown;
}
