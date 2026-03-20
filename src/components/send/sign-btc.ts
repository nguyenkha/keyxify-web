import { hexToBytes, bytesToHex } from "../../shared/utils";
import { toBase64, performBatchMpcSign, clientKeys, restoreKeyHandles, clearClientKey } from "../../lib/mpc";
import { authHeaders } from "../../lib/auth";
import { apiUrl } from "../../lib/apiBase";
import { sensitiveHeaders } from "../../lib/passkey";
import {
  fetchUtxos,
  mempoolApiUrl,
  buildBtcTransaction,
  bip143Sighash,
  legacySighash,
  detectAddressType,
  getCompressedPublicKey,
  pubKeyHash,
  makeP2WPKHWitness,
  makeP2PKHScriptSig,
  serializeWitnessTx,
  serializeLegacyTx,
  computeTxid,
  computeLegacyTxid,
  broadcastBtcTx,
  waitForBtcConfirmation,
} from "../../lib/chains/btcTx";
import {
  fetchUtxos as fetchBchUtxos,
  bchApiUrl,
} from "../../lib/chains/bchTx";
import {
  fetchUtxos as fetchLtcUtxos,
  ltcApiUrl,
} from "../../lib/chains/ltcTx";
import { parseDerSignature, parseUnits } from "../../lib/chains/evmTx";
import { isRecoveryMode } from "../../lib/recovery";
import type { SigningContext, UtxoFetchContext } from "./signing-flows";
import { friendlyError, MAX_UTXO_INPUTS } from "./signing-flows";

export async function executeBtcSigningFlow(ctx: SigningContext): Promise<void> {
  const {
    keyFile, chain, asset, address, to, amount,
    btcFeeRate, rbfEnabled, manualUtxos, confirmBeforeBroadcast,
    onTxSubmitted, onTxConfirmed,
    setStep, setSigningPhase, setSignatureCount, setSigningError,
    setSignedRawTx, setTxResult, setPendingTxHash, setKeyFile, setPendingEncrypted,
    t,
  } = ctx;

  if (!btcFeeRate) return;

  setStep("signing");
  setSigningPhase("building-tx");
  setSignatureCount(1);
  setSigningError(null);

  const btcApi = mempoolApiUrl(chain.explorerUrl);
  try {
    // Restore key handles if not in memory
    if (!clientKeys.has(keyFile.id)) {
      await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
    }

    // 1. Fetch UTXOs and build transaction
    const utxos = manualUtxos ?? await fetchUtxos(address, btcApi);
    const amountSats = parseUnits(amount, asset.decimals);
    const addrType = detectAddressType(address);
    const btcTx = buildBtcTransaction(to, amountSats, utxos, btcFeeRate, address, addrType, rbfEnabled, manualUtxos != null);
    if (!isRecoveryMode() && btcTx.inputs.length > MAX_UTXO_INPUTS) {
      throw new Error(`Too many inputs (${btcTx.inputs.length}). Maximum ${MAX_UTXO_INPUTS} UTXOs per transaction.`);
    }

    // 2. Get compressed public key and hash
    setSigningPhase("mpc-signing");
    const pubKeyRaw = hexToBytes(keyFile.publicKey);
    const compressedPubKey = getCompressedPublicKey(
      Array.from(pubKeyRaw).map((b) => b.toString(16).padStart(2, "0")).join("")
    );
    const pkHash = pubKeyHash(compressedPubKey);
    const isLegacy = addrType === "p2pkh";

    // BTC tx payload for server-side verification
    const btcTxPayload = {
      version: btcTx.version,
      inputs: btcTx.inputs.map((inp) => ({
        txid: inp.txid, vout: inp.vout, value: inp.value.toString(), sequence: inp.sequence,
      })),
      outputs: btcTx.outputs.map((out) => ({
        value: out.value.toString(), scriptPubKey: bytesToHex(out.scriptPubKey),
      })),
      locktime: btcTx.locktime,
    };

    // 3. Compute all sighashes and batch-sign via single MPC session
    const witnesses: Uint8Array[][] = [];
    const scriptSigs: Uint8Array[] = [];

    const sighashes = btcTx.inputs.map((_, i) =>
      isLegacy ? legacySighash(btcTx, i, pkHash) : bip143Sighash(btcTx, i, pkHash)
    );
    setSignatureCount(sighashes.length);

    const { signatures: allSigs } = await performBatchMpcSign({
      keyId: keyFile.id,
      hashes: sighashes,
      initPayload: {
        id: keyFile.id, chainType: "btc", btcTx: btcTxPayload,
        pubKeyHash: toBase64(pkHash), from: address,
      },
      headers: sensitiveHeaders(),
    });

    for (let i = 0; i < allSigs.length; i++) {
      const { r: sigR, s: sigS } = parseDerSignature(allSigs[i]);
      if (isLegacy) {
        scriptSigs.push(makeP2PKHScriptSig(sigR, sigS, compressedPubKey));
      } else {
        witnesses.push(makeP2WPKHWitness(sigR, sigS, compressedPubKey));
      }
    }

    // 4. Assemble and serialize
    let rawHex: string;
    let txid: string;
    if (isLegacy) {
      rawHex = bytesToHex(serializeLegacyTx(btcTx, scriptSigs));
      txid = computeLegacyTxid(btcTx, scriptSigs);
    } else {
      rawHex = bytesToHex(serializeWitnessTx(btcTx, witnesses));
      txid = computeTxid(btcTx);
    }

    if (confirmBeforeBroadcast) {
      setSignedRawTx(rawHex);
      setTxResult({ status: "success", txHash: "sign-only" });
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");
      return;
    }

    // 5. Broadcast
    setSigningPhase("broadcasting");
    const broadcastTxid = await broadcastBtcTx(rawHex, btcApi);

    fetch(apiUrl("/api/sign/broadcast"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ keyShareId: keyFile.id, txHash: broadcastTxid || txid, chainId: chain.id }),
    }).catch(() => {});

    onTxSubmitted?.(broadcastTxid || txid, to, amount);

    // 6. Wait for confirmation
    setPendingTxHash(broadcastTxid || txid);
    setSigningPhase("polling");
    const result = await waitForBtcConfirmation(broadcastTxid || txid, () => {}, 60, 5000, btcApi);

    setTxResult({
      status: result.confirmed ? "success" : "pending",
      txHash: broadcastTxid || txid,
      blockNumber: result.blockHeight,
    });
    if (result.confirmed) onTxConfirmed?.(broadcastTxid || txid);
    setKeyFile(null); setPendingEncrypted(null);
    setStep("result");

  } catch (err: unknown) {
    console.error("[send] BTC Error:", err);
    setSigningError(friendlyError(err, t));
  } finally {
    clearClientKey(keyFile.id);
  }
}

export async function handleFetchUtxos(ctx: UtxoFetchContext): Promise<void> {
  const { chain, address, setAvailableUtxos, setUtxoLoading } = ctx;
  setUtxoLoading(true);
  try {
    let utxos;
    if (chain.type === "btc") utxos = await fetchUtxos(address, mempoolApiUrl(chain.explorerUrl));
    else if (chain.type === "bch") utxos = await fetchBchUtxos(address, bchApiUrl());
    else utxos = await fetchLtcUtxos(address, ltcApiUrl(chain.explorerUrl));
    setAvailableUtxos(utxos);
  } catch {
    setAvailableUtxos([]);
  } finally {
    setUtxoLoading(false);
  }
}
