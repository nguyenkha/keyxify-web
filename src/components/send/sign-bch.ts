import { hexToBytes, bytesToHex } from "../../shared/utils";
import { toBase64, performBatchMpcSign, clientKeys, restoreKeyHandles, clearClientKey } from "../../lib/mpc";
import { authHeaders } from "../../lib/auth";
import { apiUrl } from "../../lib/apiBase";
import { sensitiveHeaders } from "../../lib/passkey";
import { parseDerSignature, parseUnits } from "../../lib/chains/evmTx";
import {
  fetchUtxos as fetchBchUtxos,
  bchApiUrl,
  buildBchTransaction,
  bchSighash,
  getCompressedPublicKey as getBchCompressedPublicKey,
  pubKeyHash as bchPubKeyHash,
  makeP2PKHScriptSig as makeBchP2PKHScriptSig,
  serializeBchTx,
  computeTxid as computeBchTxid,
  broadcastBchTx,
  waitForBchConfirmation,
} from "../../lib/chains/bchTx";
import { isRecoveryMode } from "../../lib/recovery";
import type { SigningContext } from "./signing-flows";
import { friendlyError, MAX_UTXO_INPUTS } from "./signing-flows";

export async function executeBchSigningFlow(ctx: SigningContext): Promise<void> {
  const {
    keyFile, chain, asset, address, to, amount,
    bchFeeRate, manualUtxos, confirmBeforeBroadcast,
    onTxSubmitted, onTxConfirmed,
    setStep, setSigningPhase, setSignatureCount, setSigningError,
    setSignedRawTx, setTxResult, setPendingTxHash, setKeyFile, setPendingEncrypted,
    t,
  } = ctx;

  if (!bchFeeRate) return;

  setStep("signing");
  setSigningPhase("building-tx");
  setSignatureCount(1);
  setSigningError(null);

  const api = bchApiUrl();
  try {
    if (!clientKeys.has(keyFile.id)) {
      await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
    }

    // 1. Fetch UTXOs and build transaction
    const utxos = manualUtxos ?? await fetchBchUtxos(address, api);
    const amountSats = parseUnits(amount, asset.decimals);
    const bchTx = buildBchTransaction(to, amountSats, utxos, bchFeeRate, address, manualUtxos != null);
    if (!isRecoveryMode() && bchTx.inputs.length > MAX_UTXO_INPUTS) {
      throw new Error(`Too many inputs (${bchTx.inputs.length}). Maximum ${MAX_UTXO_INPUTS} UTXOs per transaction.`);
    }

    // 2. Get compressed public key and hash
    setSigningPhase("mpc-signing");
    const pubKeyRaw = hexToBytes(keyFile.publicKey);
    const compressedPubKey = getBchCompressedPublicKey(
      Array.from(pubKeyRaw).map((b) => b.toString(16).padStart(2, "0")).join("")
    );
    const pkHash = bchPubKeyHash(compressedPubKey);

    // BCH tx payload for server-side verification
    const bchTxPayload = {
      version: bchTx.version,
      inputs: bchTx.inputs.map((inp) => ({
        txid: inp.txid, vout: inp.vout, value: inp.value.toString(), sequence: inp.sequence,
      })),
      outputs: bchTx.outputs.map((out) => ({
        value: out.value.toString(), scriptPubKey: bytesToHex(out.scriptPubKey),
      })),
      locktime: bchTx.locktime,
    };

    // 3. Compute all sighashes and batch-sign via single MPC session (BCH uses SIGHASH_FORKID)
    const scriptSigs: Uint8Array[] = [];

    const sighashes = bchTx.inputs.map((_, i) => bchSighash(bchTx, i, pkHash));
    setSignatureCount(sighashes.length);

    const { signatures: allSigs } = await performBatchMpcSign({
      keyId: keyFile.id,
      hashes: sighashes,
      initPayload: {
        id: keyFile.id, chainType: "bch", bchTx: bchTxPayload,
        pubKeyHash: toBase64(pkHash), from: address,
      },
      headers: sensitiveHeaders(),
    });

    for (let i = 0; i < allSigs.length; i++) {
      const { r: sigR, s: sigS } = parseDerSignature(allSigs[i]);
      scriptSigs.push(makeBchP2PKHScriptSig(sigR, sigS, compressedPubKey));
    }

    // 4. Assemble and serialize
    const rawHex = bytesToHex(serializeBchTx(bchTx, scriptSigs));
    const txid = computeBchTxid(bchTx, scriptSigs);

    if (confirmBeforeBroadcast) {
      setSignedRawTx(rawHex);
      setTxResult({ status: "success", txHash: "sign-only" });
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");
      return;
    }

    // 5. Broadcast
    setSigningPhase("broadcasting");
    const broadcastTxid = await broadcastBchTx(rawHex, api);

    fetch(apiUrl("/api/sign/broadcast"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ keyShareId: keyFile.id, txHash: broadcastTxid || txid, chainId: chain.id }),
    }).catch(() => {});

    onTxSubmitted?.(broadcastTxid || txid, to, amount);

    // 6. Wait for confirmation
    setPendingTxHash(broadcastTxid || txid);
    setSigningPhase("polling");
    const result = await waitForBchConfirmation(broadcastTxid || txid, () => {}, 60, 5000, api);

    setTxResult({
      status: result.confirmed ? "success" : "pending",
      txHash: broadcastTxid || txid,
      blockNumber: result.blockHeight,
    });
    if (result.confirmed) onTxConfirmed?.(broadcastTxid || txid);
    setKeyFile(null); setPendingEncrypted(null);
    setStep("result");

  } catch (err: unknown) {
    console.error("[send] BCH Error:", err);
    setSigningError(friendlyError(err, t));
  } finally {
    clearClientKey(keyFile.id);
  }
}
