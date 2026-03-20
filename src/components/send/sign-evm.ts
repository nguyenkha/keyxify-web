import { hexToBytes } from "../../shared/utils";
import { toBase64, performMpcSign, clientKeys, restoreKeyHandles, clearClientKey } from "../../lib/mpc";
import { authHeaders } from "../../lib/auth";
import { apiUrl } from "../../lib/apiBase";
import { sensitiveHeaders } from "../../lib/passkey";
import {
  buildTransaction,
  serializeForSigning,
  hashForSigning,
  parseDerSignature,
  recoverV,
  assembleSignedTx,
  broadcastTransaction,
  waitForReceipt,
  encodeErc20Transfer,
  parseUnits,
  type UnsignedTx,
} from "../../lib/chains/evmTx";
import { getChainId } from "../sendTypes";
import type { SigningContext } from "./signing-flows";
import { friendlyError } from "./signing-flows";

export async function executeSigningFlow(ctx: SigningContext): Promise<void> {
  const {
    keyFile, chain, asset, address, to, amount,
    gasPrice, gasLimit, confirmBeforeBroadcast,
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
    // Restore key handles if not in memory
    if (!clientKeys.has(keyFile.id)) {
      await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
    }

    // 1. Build unsigned transaction
    const chainId = await getChainId(chain.rpcUrl);
    const amountWei = parseUnits(amount, asset.decimals);

    let unsignedTx: UnsignedTx;
    if (asset.isNative) {
      unsignedTx = await buildTransaction({
        rpcUrl: chain.rpcUrl, from: address, to, value: amountWei,
        gasLimit, chainId, gasPrice: gasPrice ?? undefined,
      });
    } else {
      const calldata = encodeErc20Transfer(to, amountWei);
      unsignedTx = await buildTransaction({
        rpcUrl: chain.rpcUrl, from: address, to: asset.contractAddress!,
        value: 0n, data: calldata, gasLimit, chainId,
        gasPrice: gasPrice ?? undefined,
      });
    }

    // 2. MPC signing
    setSigningPhase("mpc-signing");
    const sighash = hashForSigning(unsignedTx);
    const serializedTx = serializeForSigning(unsignedTx);

    const { signature: sigRaw, sessionId } = await performMpcSign({
      algorithm: "ecdsa",
      keyId: keyFile.id,
      hash: sighash,
      initPayload: { id: keyFile.id, unsignedTx: toBase64(serializedTx), from: address },
      headers: sensitiveHeaders(),
    });

    // 3. Parse DER signature, determine recovery param, assemble signed tx
    const { r, s } = parseDerSignature(sigRaw);
    const pubKeyRaw = hexToBytes(keyFile.publicKey);
    const recoveryBit = recoverV(sighash, r, s, pubKeyRaw);
    const signedTx = assembleSignedTx(unsignedTx, r, s, recoveryBit);

    if (confirmBeforeBroadcast) {
      setSignedRawTx(signedTx.rawTransaction);
      setTxResult({ status: "success", txHash: "sign-only" });
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");
      return;
    }

    // 4. Broadcast
    setSigningPhase("broadcasting");
    const txHash = await broadcastTransaction(chain.rpcUrl, signedTx.rawTransaction);

    fetch(apiUrl("/api/sign/broadcast"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ keyShareId: keyFile.id, sessionId, txHash, chainId: chain.id }),
    }).catch(() => {});

    onTxSubmitted?.(txHash, to, amount);

    // 5. Poll for receipt
    setPendingTxHash(txHash);
    setSigningPhase("polling");
    const receipt = await waitForReceipt(chain.rpcUrl, txHash, () => {}, 60, 3000);

    setTxResult({ status: receipt.status, txHash, blockNumber: receipt.blockNumber });
    if (receipt.status === "success") onTxConfirmed?.(txHash);
    setKeyFile(null); setPendingEncrypted(null);
    setStep("result");

  } catch (err: unknown) {
    console.error("[send] Error:", err);
    setSigningError(friendlyError(err, t));
  } finally {
    clearClientKey(keyFile.id);
  }
}
