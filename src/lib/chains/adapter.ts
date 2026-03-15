import type { ChainType, ChainAdapter } from "../../shared/types";
import { evmAdapter } from "./evmAdapter";
import { btcAdapter } from "./btcAdapter";
import { solanaAdapter } from "./solanaAdapter";
import { xrpAdapter } from "./xrpAdapter";
import { bchAdapter } from "./bchAdapter";
import { xlmAdapter } from "./xlmAdapter";

const adapters: Record<ChainType, ChainAdapter> = {
  evm: evmAdapter,
  btc: btcAdapter,
  bch: bchAdapter,
  solana: solanaAdapter,
  xrp: xrpAdapter,
  xlm: xlmAdapter,
};

export function getChainAdapter(type: ChainType): ChainAdapter {
  return adapters[type];
}
