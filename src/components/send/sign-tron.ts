import { hexToBytes } from "../../shared/utils";
import { performMpcSign, clientKeys, restoreKeyHandles, clearClientKey } from "../../lib/mpc";
import { authHeaders } from "../../lib/auth";
import { apiUrl } from "../../lib/apiBase";
import { sensitiveHeaders } from "../../lib/passkey";
import { parseDerSignature, recoverV } from "../../lib/chains/evmTx";
import {
  buildTrxTransfer,
  buildTrc20Transfer,
  hashForSigning as tronHashForSigning,
  assembleSignedTx as tronAssembleSignedTx,
  broadcastTronTransaction,
  waitForTronConfirmation,
} from "../../lib/chains/tronTx";
import type { SigningContext } from "./signing-flows";
import { friendlyError } from "./signing-flows";

export async function executeTronSigningFlow(ctx: SigningContext): Promise<void> {
  const {
    keyFile, chain, asset, address, to, amount,
    confirmBeforeBroadcast,
    onTxSubmitted, onTxConfirmed,
    setStep, setSigningPhase, setSignatureCount, setSigningError,
    setSignedRawTx, setTxResult, setPendingTxHash, setKeyFile, setPendingEncrypted,
    t,
  } = ctx;

  if (!chain.rpcUrl) return;

  setStep("signing");
  setSigningPhase("building-tx");
  setSignatureCount(1);
  setSigningError(null);

  try {
    if (!clientKeys.has(keyFile.id)) {
      await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
    }

    // 1. Build transaction via TronGrid API
    const amountSun = BigInt(Math.round(parseFloat(amount.replace(/,/g, "")) * 1e6));
    let tronTx;
    if (asset.isNative) {
      tronTx = await buildTrxTransfer(chain.rpcUrl, address, to, amountSun);
    } else {
      tronTx = await buildTrc20Transfer(chain.rpcUrl, address, to, asset.contractAddress!, amountSun);
    }

    // 2. MPC signing
    setSigningPhase("mpc-signing");

    const sighash = tronHashForSigning(tronTx);

    const { signature: sigRaw, sessionId } = await performMpcSign({
      algorithm: "ecdsa",
      keyId: keyFile.id,
      hash: sighash,
      initPayload: {
        id: keyFile.id,
        chainType: "tron",
        tronTx: {
          from: address,
          to,
          amountSun: amountSun.toString(),
          rawDataHex: tronTx.raw_data_hex,
          contractAddress: asset.contractAddress || undefined,
          nativeSymbol: asset.isNative ? "TRX" : undefined,
        },
        from: address,
      },
      headers: sensitiveHeaders(),
    });

    // 3. Parse DER signature and assemble 65-byte TRON signature (r || s || v)
    const { r, s } = parseDerSignature(sigRaw);
    const pubKeyRaw = hexToBytes(keyFile.publicKey);
    const recoveryBit = recoverV(sighash, r, s, pubKeyRaw);
    const { signedTxJson, txId } = tronAssembleSignedTx(tronTx, r, s, recoveryBit);

    if (confirmBeforeBroadcast) {
      setSignedRawTx(signedTxJson);
      setTxResult({ status: "success", txHash: "sign-only" });
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");
      return;
    }

    // 4. Broadcast
    setSigningPhase("broadcasting");
    const txHash = await broadcastTronTransaction(chain.rpcUrl, signedTxJson);

    fetch(apiUrl("/api/sign/broadcast"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ keyShareId: keyFile.id, sessionId, txHash: txHash || txId, chainId: chain.id }),
    }).catch(() => {});

    onTxSubmitted?.(txHash || txId, to, amount);

    // 5. Wait for confirmation
    setPendingTxHash(txHash || txId);
    setSigningPhase("polling");
    const result = await waitForTronConfirmation(chain.rpcUrl, txHash || txId, () => {}, 30, 3000);

    setTxResult({
      status: result.confirmed ? "success" : "pending",
      txHash: txHash || txId,
      blockNumber: result.blockNumber,
    });
    if (result.confirmed) onTxConfirmed?.(txHash || txId);
    setKeyFile(null); setPendingEncrypted(null);
    setStep("result");

  } catch (err: unknown) {
    console.error("[send] TRON Error:", err);
    setSigningError(friendlyError(err, t));
  } finally {
    clearClientKey(keyFile.id);
  }
}
