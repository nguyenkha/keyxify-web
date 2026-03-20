// Pure fee computation functions extracted from SendDialog.tsx
import { getUsdValue } from "../../lib/prices";
import {
  SOLANA_BASE_FEE,
  formatLamports,
} from "../../lib/chains/solanaTx";
import {
  XRP_BASE_FEE,
  formatDrops,
} from "../../lib/chains/xrpTx";
import {
  formatBtcFee,
} from "../../lib/chains/btcTx";
import {
  formatLtcFee,
} from "../../lib/chains/ltcTx";
import {
  formatBchFee,
} from "../../lib/chains/bchTx";
import { formatSun } from "../../lib/chains/tronTx";
import {
  formatGwei,
  formatEthFee,
} from "../sendTypes";
import type { FeeDisplay } from "./types";
import type { Chain, Asset } from "../../lib/api";
import type { FeeLevel } from "../sendTypes";

export type { FeeDisplay };

interface ComputeFeeDisplayParams {
  chain: Chain;
  asset: Asset;
  feeLevel: FeeLevel;
  prices: Record<string, number>;
  // EVM
  estimatedFeeWei: bigint | null;
  gasPrice: bigint | null;
  // BTC
  btcEstimatedFee: bigint | null;
  btcFeeRate: number | null;
  // LTC
  ltcEstimatedFee: bigint | null;
  ltcFeeRate: number | null;
  // BCH
  bchEstimatedFee: bigint | null;
  bchFeeRate: number | null;
  // XLM
  xlmFeeRates: { low: number; medium: number; high: number } | null;
}

export function computeFeeDisplay(p: ComputeFeeDisplayParams): FeeDisplay {
  const { chain, asset, feeLevel, prices } = p;

  if (chain.type === "solana") {
    return {
      formatted: formatLamports(SOLANA_BASE_FEE),
      symbol: "SOL",
      usd: getUsdValue(String(Number(SOLANA_BASE_FEE) / 1e9), "SOL", prices),
      rateLabel: null,
      hasLevelSelector: false,
      isFixed: true,
    };
  }
  if (chain.type === "xrp") {
    return {
      formatted: formatDrops(XRP_BASE_FEE),
      symbol: "XRP",
      usd: getUsdValue(String(Number(XRP_BASE_FEE) / 1e6), "XRP", prices),
      rateLabel: null,
      hasLevelSelector: false,
      isFixed: true,
    };
  }
  if (chain.type === "tron") {
    const estFee = asset.isNative ? 0n : 15_000_000n;
    return {
      formatted: formatSun(estFee),
      symbol: "TRX",
      usd: getUsdValue(String(Number(estFee) / 1e6), "TRX", prices),
      rateLabel: asset.isNative ? "Bandwidth (usually free)" : "~15 TRX energy fee",
      hasLevelSelector: false,
      isFixed: true,
    };
  }
  if (chain.type === "xlm") {
    const xlmFeeRate = p.xlmFeeRates?.[feeLevel] ?? null;
    const feeXlm = xlmFeeRate != null ? (xlmFeeRate / 1e7).toFixed(7).replace(/\.?0+$/, "") : null;
    return {
      formatted: feeXlm,
      symbol: "XLM",
      usd: feeXlm != null ? getUsdValue(feeXlm, "XLM", prices) : null,
      rateLabel: xlmFeeRate != null ? `${xlmFeeRate} stroops` : null,
      hasLevelSelector: false,
      isFixed: false,
    };
  }
  if (chain.type === "ltc") {
    return {
      formatted: p.ltcEstimatedFee != null ? formatLtcFee(p.ltcEstimatedFee) : null,
      symbol: "LTC",
      usd: p.ltcEstimatedFee != null ? getUsdValue(String(Number(p.ltcEstimatedFee) / 1e8), "LTC", prices) : null,
      rateLabel: p.ltcFeeRate != null ? `${p.ltcFeeRate} sat/vB` : null,
      hasLevelSelector: true,
      isFixed: false,
    };
  }
  if (chain.type === "bch") {
    return {
      formatted: p.bchEstimatedFee != null ? formatBchFee(p.bchEstimatedFee) : null,
      symbol: "BCH",
      usd: p.bchEstimatedFee != null ? getUsdValue(String(Number(p.bchEstimatedFee) / 1e8), "BCH", prices) : null,
      rateLabel: p.bchFeeRate != null ? `${p.bchFeeRate} sat/B` : null,
      hasLevelSelector: false,
      isFixed: true,
    };
  }
  if (chain.type === "btc") {
    return {
      formatted: p.btcEstimatedFee != null ? formatBtcFee(p.btcEstimatedFee) : null,
      symbol: "BTC",
      usd: p.btcEstimatedFee != null ? getUsdValue(String(Number(p.btcEstimatedFee) / 1e8), "BTC", prices) : null,
      rateLabel: p.btcFeeRate != null ? `${p.btcFeeRate} sat/vB` : null,
      hasLevelSelector: true,
      isFixed: false,
    };
  }
  // evm
  const feeEth = p.estimatedFeeWei != null ? formatEthFee(p.estimatedFeeWei) : null;
  return {
    formatted: feeEth,
    symbol: "ETH",
    usd: p.estimatedFeeWei != null ? getUsdValue(String(Number(p.estimatedFeeWei) / 1e18), "ETH", prices) : null,
    rateLabel: p.gasPrice != null ? `${formatGwei(p.gasPrice)} Gwei` : null,
    hasLevelSelector: true,
    isFixed: false,
  };
}

interface ComputeMaxSendableParams {
  chain: Chain;
  asset: Asset;
  balance: string;
  feeLevel: FeeLevel;
  estimatedFeeWei: bigint | null;
  btcEstimatedFee: bigint | null;
  ltcEstimatedFee: bigint | null;
  xlmFeeRates: { low: number; medium: number; high: number } | null;
}

export function computeMaxSendable(p: ComputeMaxSendableParams): string {
  const { chain, asset, balance, feeLevel } = p;
  if (!asset.isNative) return balance;

  let feeBaseUnits: bigint | null = null;
  if (chain.type === "evm" && p.estimatedFeeWei != null) {
    feeBaseUnits = p.estimatedFeeWei;
  } else if (chain.type === "solana") {
    feeBaseUnits = SOLANA_BASE_FEE;
  } else if (chain.type === "xrp") {
    feeBaseUnits = XRP_BASE_FEE;
  } else if (chain.type === "tron") {
    feeBaseUnits = 0n;
  } else if (chain.type === "btc" && p.btcEstimatedFee != null) {
    feeBaseUnits = BigInt(p.btcEstimatedFee);
  } else if (chain.type === "ltc" && p.ltcEstimatedFee != null) {
    feeBaseUnits = BigInt(p.ltcEstimatedFee);
  } else if (chain.type === "xlm" && p.xlmFeeRates != null) {
    feeBaseUnits = BigInt(p.xlmFeeRates[feeLevel]);
  }

  if (feeBaseUnits == null) return balance;

  const [intPart, fracPart = ""] = balance.replace(/,/g, "").split(".");
  const padded = fracPart.padEnd(asset.decimals, "0").slice(0, asset.decimals);
  const balanceBase = BigInt(intPart + padded);
  const net = balanceBase - feeBaseUnits;
  if (net <= 0n) return "0";

  const netStr = net.toString().padStart(asset.decimals + 1, "0");
  const netInt = netStr.slice(0, netStr.length - asset.decimals) || "0";
  const netFrac = netStr.slice(netStr.length - asset.decimals).replace(/0+$/, "");
  return netFrac ? `${netInt}.${netFrac}` : netInt;
}

