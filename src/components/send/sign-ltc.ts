import { hexToBytes, bytesToHex } from "../../shared/utils";
import { toBase64, performBatchMpcSign, clientKeys, restoreKeyHandles, clearClientKey } from "../../lib/mpc";
import { authHeaders } from "../../lib/auth";
import { apiUrl } from "../../lib/apiBase";
import { sensitiveHeaders } from "../../lib/passkey";
import {
  parseDerSignature,
  parseUnits,
} from "../../lib/chains/evmTx";
import {
  bip143Sighash,
  legacySighash,
  getCompressedPublicKey,
  pubKeyHash,
  makeP2WPKHWitness,
  makeP2PKHScriptSig,
  serializeWitnessTx,
  serializeLegacyTx,
  computeTxid,
  computeLegacyTxid,
} from "../../lib/chains/btcTx";
import {
  fetchUtxos as fetchLtcUtxos,
  ltcApiUrl,
  buildLtcTransaction,
  detectAddressType as detectLtcAddressType,
  broadcastLtcTx,
  waitForLtcConfirmation,
} from "../../lib/chains/ltcTx";
import { isRecoveryMode } from "../../lib/recovery";
import type { SigningContext } from "./signing-flows";
import { friendlyError, MAX_UTXO_INPUTS } from "./signing-flows";

export async function executeLtcSigningFlow(ctx: SigningContext): Promise<void> {
  const {
    keyFile, chain, asset, address, to, amount,
    ltcFeeRate, rbfEnabled, manualUtxos, confirmBeforeBroadcast,
    onTxSubmitted, onTxConfirmed,
    setStep, setSigningPhase, setSignatureCount, setSigningError,
    setSignedRawTx, setTxResult, setPendingTxHash, setKeyFile, setPendingEncrypted,
    t,
  } = ctx;

  if (!ltcFeeRate) return;

  setStep("signing");
  setSigningPhase("building-tx");
  setSignatureCount(1);
  setSigningError(null);

  const ltcApi = ltcApiUrl(chain.explorerUrl);
  try {
    if (!clientKeys.has(keyFile.id)) {
      await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
    }

    // 1. Fetch UTXOs and build transaction
    const utxos = manualUtxos ?? await fetchLtcUtxos(address, ltcApi);
    const amountSats = parseUnits(amount, asset.decimals);
    const addrType = detectLtcAddressType(address);
    const ltcTx = buildLtcTransaction(to, amountSats, utxos, ltcFeeRate, address, addrType, rbfEnabled, manualUtxos != null);
    if (!isRecoveryMode() && ltcTx.inputs.length > MAX_UTXO_INPUTS) {
      throw new Error(`Too many inputs (${ltcTx.inputs.length}). Maximum ${MAX_UTXO_INPUTS} UTXOs per transaction.`);
    }

    // 2. Get compressed public key and hash
    setSigningPhase("mpc-signing");
    const pubKeyRaw = hexToBytes(keyFile.publicKey);
    const compressedPubKey = getCompressedPublicKey(
      Array.from(pubKeyRaw).map((b) => b.toString(16).padStart(2, "0")).join("")
    );
    const pkHash = pubKeyHash(compressedPubKey);
    const isLegacy = addrType === "p2pkh";

    // LTC tx payload for server-side verification
    const ltcTxPayload = {
      version: ltcTx.version,
      inputs: ltcTx.inputs.map((inp) => ({
        txid: inp.txid, vout: inp.vout, value: inp.value.toString(), sequence: inp.sequence,
      })),
      outputs: ltcTx.outputs.map((out) => ({
        value: out.value.toString(), scriptPubKey: bytesToHex(out.scriptPubKey),
      })),
      locktime: ltcTx.locktime,
    };

    // 3. Compute all sighashes and batch-sign via single MPC session
    const witnesses: Uint8Array[][] = [];
    const scriptSigs: Uint8Array[] = [];

    const sighashes = ltcTx.inputs.map((_, i) =>
      isLegacy ? legacySighash(ltcTx, i, pkHash) : bip143Sighash(ltcTx, i, pkHash)
    );
    setSignatureCount(sighashes.length);

    const { signatures: allSigs } = await performBatchMpcSign({
      keyId: keyFile.id,
      hashes: sighashes,
      initPayload: {
        id: keyFile.id, chainType: "ltc", ltcTx: ltcTxPayload,
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
      rawHex = bytesToHex(serializeLegacyTx(ltcTx, scriptSigs));
      txid = computeLegacyTxid(ltcTx, scriptSigs);
    } else {
      rawHex = bytesToHex(serializeWitnessTx(ltcTx, witnesses));
      txid = computeTxid(ltcTx);
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
    const broadcastTxid = await broadcastLtcTx(rawHex, ltcApi);

    fetch(apiUrl("/api/sign/broadcast"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ keyShareId: keyFile.id, txHash: broadcastTxid || txid, chainId: chain.id }),
    }).catch(() => {});

    onTxSubmitted?.(broadcastTxid || txid, to, amount);

    // 6. Wait for confirmation
    setPendingTxHash(broadcastTxid || txid);
    setSigningPhase("polling");
    const result = await waitForLtcConfirmation(broadcastTxid || txid, () => {}, 60, 5000, ltcApi);

    setTxResult({
      status: result.confirmed ? "success" : "pending",
      txHash: broadcastTxid || txid,
      blockNumber: result.blockHeight,
    });
    if (result.confirmed) onTxConfirmed?.(broadcastTxid || txid);
    setKeyFile(null); setPendingEncrypted(null);
    setStep("result");

  } catch (err: unknown) {
    console.error("[send] LTC Error:", err);
    setSigningError(friendlyError(err, t));
  } finally {
    clearClientKey(keyFile.id);
  }
}
